use std::collections::{HashMap, HashSet};

use crate::building_catalog::building_definition;
use crate::commute::trip_deadline_seconds;
use crate::ids::next_entity_id;
use crate::intent::RoadPreset;
use crate::model::{
    ActiveTrip, BusStopKind, GameMap, GameSnapshot, Platform, Point, RouteLegKind, RouteLegPath,
    Tile, TransitMode, TransitNodeStatus, TransitPath, TripPosition, TripPurpose, TripStatus,
    Vehicle,
};
use crate::platforms::{bus_platforms, metro_platforms, on_platform_trip_ids, platform_waiter_ids};
use crate::rejection::{GameplayRejection, GameplayResult, RejectionCode, RejectionContext};
use crate::road::{apply_road_mutation, RoadMutation};
use crate::route_lifecycle::is_route_operational;
use crate::stop_access::derive_stop_access;
use crate::transit_nodes::{
    canonical_node_anchor, garbage_collect_missing_nodes, is_present_node,
    matching_present_node_id, remove_or_tombstone_node, restore_or_create_node, LogicalNodeKind,
};
use crate::trips::WAIT_PATIENCE_SECONDS;

pub const BUS_STOP_COST: i32 = 2_000;
pub const METRO_STATION_COST: i32 = 25_000;
pub const BUS_COST: i32 = 8_000;
pub const METRO_COST: i32 = 50_000;
pub const ROAD_COST: i32 = 100;
pub const TRACK_COST: i32 = 500;
pub const BUS_TILES_PER_SECOND: f64 = 0.8;
pub const METRO_TILES_PER_SECOND: f64 = 1.6;

fn route_rejection(code: RejectionCode, route_id: &str) -> GameplayRejection {
    GameplayRejection {
        code,
        context: RejectionContext {
            route_id: Some(route_id.to_string()),
            ..RejectionContext::default()
        },
    }
}

fn node_rejection(code: RejectionCode, node_id: &str, route_id: Option<&str>) -> GameplayRejection {
    GameplayRejection {
        code,
        context: RejectionContext {
            route_id: route_id.map(str::to_string),
            node_id: Some(node_id.to_string()),
            ..RejectionContext::default()
        },
    }
}

pub fn lay_road(state: &GameSnapshot, point: &Point) -> GameplayResult<GameSnapshot> {
    apply_road_mutation(state, &RoadMutation::LayRoad { point: *point })
        .map(|result| result.snapshot)
}

pub fn lay_track(state: &GameSnapshot, point: &Point) -> GameplayResult<GameSnapshot> {
    if state.budget < TRACK_COST {
        return Err(GameplayRejection::budget(TRACK_COST, state.budget));
    }
    if !is_valid_track_placement(state, point) {
        let code = if get_tile(&state.map, point).is_none() {
            RejectionCode::OutOfBounds
        } else {
            RejectionCode::BlockedTile
        };
        return Err(GameplayRejection::at(code, *point));
    }

    let mut next = state.clone();
    next.budget -= TRACK_COST;
    set_tile_track(&mut next.map, point, true);
    Ok(next)
}

pub fn lay_road_line(
    state: &GameSnapshot,
    points: &[Point],
    preset: RoadPreset,
) -> GameplayResult<GameSnapshot> {
    apply_road_mutation(
        state,
        &RoadMutation::LayRoadLine {
            points: points.to_vec(),
            preset,
        },
    )
    .map(|result| result.snapshot)
}

pub fn lay_track_line(state: &GameSnapshot, points: &[Point]) -> GameplayResult<GameSnapshot> {
    if points.is_empty() {
        return Err(GameplayRejection::new(RejectionCode::InvalidTrackStroke));
    }

    let mut next = state.clone();
    let mut changed = false;
    for point in points {
        if next.budget < TRACK_COST || !is_valid_track_placement(&next, point) {
            continue;
        }
        next.budget -= TRACK_COST;
        set_tile_track(&mut next.map, point, true);
        changed = true;
    }

    if !changed {
        return Err(GameplayRejection::at(
            RejectionCode::InvalidTrackStroke,
            points[0],
        ));
    }
    Ok(next)
}

pub fn remove_at_tiles(state: &GameSnapshot, points: &[Point]) -> GameplayResult<GameSnapshot> {
    if points.is_empty() {
        return Err(GameplayRejection::new(RejectionCode::BlockedTile));
    }

    let mut next = state.clone();
    let removed_roundabouts = crate::roundabouts::remove_owned_roundabouts(&mut next, points);
    if !removed_roundabouts.ids.is_empty() {
        crate::roundabouts::sync_roundabout_ports(&mut next.map);
        crate::road::refresh_all_automatic_junctions(&mut next.map)?;
    }
    let mut changed = !removed_roundabouts.ids.is_empty();
    for point in points {
        if removed_roundabouts.member_points.contains(point) {
            continue;
        }
        if let Ok(candidate) = remove_at_tile(&next, point) {
            if candidate != next {
                next = candidate;
                changed = true;
            }
        }
    }

    if !changed {
        return Err(GameplayRejection::at(RejectionCode::BlockedTile, points[0]));
    }
    Ok(next)
}

pub fn remove_at_tile(state: &GameSnapshot, point: &Point) -> GameplayResult<GameSnapshot> {
    let mut roundabout_candidate = state.clone();
    let removed = crate::roundabouts::remove_owned_roundabouts(
        &mut roundabout_candidate,
        std::slice::from_ref(point),
    );
    if !removed.ids.is_empty() {
        crate::roundabouts::sync_roundabout_ports(&mut roundabout_candidate.map);
        crate::road::refresh_all_automatic_junctions(&mut roundabout_candidate.map)?;
        return Ok(roundabout_candidate);
    }
    let anchor = canonical_node_anchor(state, *point);
    let removed_building = state
        .buildings
        .iter()
        .find(|building| building.occupied_tiles.iter().any(|tile| tile == point));
    let mut removed_stop_ids = HashSet::new();
    let mut removed_station_ids = HashSet::new();
    let removed_destination_tiles: HashSet<String> = removed_building
        .filter(|building| {
            building_definition(&building.building_type)
                .is_some_and(|definition| definition.effect == "destination")
        })
        .into_iter()
        .flat_map(|building| building.occupied_tiles.iter().map(point_key))
        .collect();

    if let Some(building) = removed_building {
        if let Some(transit_node_id) = &building.transit_node_id {
            if matches!(building.building_type.as_str(), "busStop" | "busTerminal") {
                removed_stop_ids.insert(transit_node_id.clone());
            }
            if building.building_type == "metroStation" {
                removed_station_ids.insert(transit_node_id.clone());
            }
        }
    } else {
        for stop in &state.transit.stops {
            if is_present_node(stop.status) && stop.position == anchor {
                removed_stop_ids.insert(stop.id.clone());
            }
        }
        for station in &state.transit.stations {
            if is_present_node(station.status) && station.position == anchor {
                removed_station_ids.insert(station.id.clone());
            }
        }
    }

    if removed_building.is_none() && removed_stop_ids.is_empty() && removed_station_ids.is_empty() {
        return remove_infrastructure_at_tile(state, point);
    }

    let mut next = state.clone();
    if let Some(building) = removed_building {
        next.buildings
            .retain(|candidate| candidate.id != building.id);
    }
    cleanup_removed_destination_references(&mut next, &removed_destination_tiles);
    for stop_id in removed_stop_ids {
        next = remove_or_tombstone_node(&next, &stop_id);
    }
    for station_id in removed_station_ids {
        next = remove_or_tombstone_node(&next, &station_id);
    }

    Ok(next)
}

pub fn add_bus_stop(state: &GameSnapshot, point: &Point) -> GameplayResult<GameSnapshot> {
    if state.budget < BUS_STOP_COST {
        return Err(GameplayRejection::budget(BUS_STOP_COST, state.budget));
    }
    if !is_valid_bus_stop_placement(state, point) {
        let rejection = match get_tile(&state.map, point) {
            None => GameplayRejection::at(RejectionCode::OutOfBounds, *point),
            Some(tile)
                if tile.kind != "empty"
                    || tile.has_track
                    || tile.road_structure_id.is_some()
                    || is_building_occupied(state, point)
                    || is_transit_node_at(state, point) =>
            {
                GameplayRejection::at(RejectionCode::BlockedTile, *point)
            }
            Some(_) => GameplayRejection::at(RejectionCode::NoRoadAccess, *point),
        };
        return Err(rejection);
    }

    let access = derive_stop_access(&state.map, *point)
        .ok_or_else(|| GameplayRejection::at(RejectionCode::NoRoadAccess, *point))?;

    let stop_id = next_entity_id(
        "stop",
        state.transit.stops.iter().map(|stop| stop.id.clone()),
    );
    let mut next = restore_or_create_node(state, LogicalNodeKind::BusStop, *point, |source| {
        let mut allocated = source.clone();
        allocated.transit.stops.push(crate::model::Stop {
            id: stop_id.clone(),
            kind: BusStopKind::BusStop,
            status: TransitNodeStatus::Present,
            position: *point,
            platforms: bus_platforms(&stop_id, BusStopKind::BusStop),
            road_access: Some(access),
        });
        Ok(allocated)
    })?;
    let stop_id = matching_present_node_id(&next, LogicalNodeKind::BusStop, *point);
    if let Some(stop) =
        stop_id.and_then(|id| next.transit.stops.iter_mut().find(|stop| stop.id == id))
    {
        stop.road_access = Some(access);
    }
    next.budget -= BUS_STOP_COST;

    Ok(next)
}

pub fn add_metro_station(state: &GameSnapshot, point: &Point) -> GameplayResult<GameSnapshot> {
    if state.budget < METRO_STATION_COST {
        return Err(GameplayRejection::budget(METRO_STATION_COST, state.budget));
    }
    if !is_valid_metro_station_placement(state, point) {
        let rejection = match get_tile(&state.map, point) {
            None => GameplayRejection::at(RejectionCode::OutOfBounds, *point),
            Some(tile) if !tile.has_track => {
                GameplayRejection::at(RejectionCode::TrackRequired, *point)
            }
            Some(_) => state
                .transit
                .stations
                .iter()
                .find(|station| is_present_node(station.status) && station.position == *point)
                .map_or_else(
                    || GameplayRejection::at(RejectionCode::BlockedTile, *point),
                    |station| {
                        let mut rejection =
                            node_rejection(RejectionCode::NodeAlreadyExists, &station.id, None);
                        rejection.context.point = Some(*point);
                        rejection
                    },
                ),
        };
        return Err(rejection);
    }

    let station_id = next_entity_id(
        "station",
        state
            .transit
            .stations
            .iter()
            .map(|station| station.id.clone()),
    );
    let mut next =
        restore_or_create_node(state, LogicalNodeKind::MetroStation, *point, |source| {
            let mut allocated = source.clone();
            allocated.transit.stations.push(crate::model::Station {
                id: station_id.clone(),
                status: TransitNodeStatus::Present,
                position: *point,
                platforms: metro_platforms(&station_id),
            });
            Ok(allocated)
        })?;
    next.budget -= METRO_STATION_COST;

    Ok(next)
}

pub fn assign_vehicle(
    state: &GameSnapshot,
    mode: &str,
    line_id: &str,
) -> GameplayResult<GameSnapshot> {
    // `mode` arrives as a string from `GameIntent::AssignVehicle`; validate and lift it to
    // the typed enum once at this boundary so everything downstream is compiler-checked.
    let transit_mode = match mode {
        "bus" => TransitMode::Bus,
        "metro" => TransitMode::Metro,
        _ => {
            return Err(route_rejection(
                RejectionCode::IncompatibleRouteNode,
                line_id,
            ));
        }
    };
    let cost = vehicle_cost(transit_mode);
    if state.budget < cost {
        return Err(GameplayRejection::budget(cost, state.budget));
    }

    let vehicle = initial_vehicle(state, transit_mode, line_id);
    let mut next = state.clone();

    if transit_mode == TransitMode::Bus {
        let Some(route) = next
            .transit
            .routes
            .iter_mut()
            .find(|route| route.id == line_id)
        else {
            return Err(route_rejection(RejectionCode::RouteNotFound, line_id));
        };
        if !route.active {
            return Err(route_rejection(RejectionCode::InactiveRoute, line_id));
        }
        if !is_route_operational(route.active, &route.legs) {
            return Err(route_rejection(RejectionCode::DisconnectedLeg, line_id));
        }
        route.vehicle_ids.push(vehicle.id.clone());
    } else {
        let Some(line) = next
            .transit
            .metro_lines
            .iter_mut()
            .find(|line| line.id == line_id)
        else {
            return Err(route_rejection(RejectionCode::RouteNotFound, line_id));
        };
        if !line.active {
            return Err(route_rejection(RejectionCode::InactiveRoute, line_id));
        }
        if !is_route_operational(line.active, &line.legs) {
            return Err(route_rejection(RejectionCode::DisconnectedLeg, line_id));
        }
        line.vehicle_ids.push(vehicle.id.clone());
    }

    next.budget -= cost;
    next.transit.vehicles.push(vehicle);
    Ok(next)
}

pub fn vehicle_cost(mode: TransitMode) -> i32 {
    match mode {
        TransitMode::Bus => BUS_COST,
        TransitMode::Metro => METRO_COST,
        TransitMode::Walk => 0,
    }
}

pub(crate) fn initial_vehicle(state: &GameSnapshot, mode: TransitMode, route_id: &str) -> Vehicle {
    Vehicle {
        id: next_entity_id(
            "vehicle",
            state
                .transit
                .vehicles
                .iter()
                .map(|vehicle| vehicle.id.clone()),
        ),
        mode,
        line_id: route_id.to_string(),
        capacity: if mode == TransitMode::Bus { 18 } else { 90 },
        passenger_ids: Vec::new(),
        itinerary_index: 0,
        path_step_index: 0,
        step_progress: 0.0,
        parked_position: None,
    }
}

/// Advance every vehicle along its assigned line, boarding/disembarking passengers.
///
/// Intentional divergence from the TS oracle: when no vehicle actually moved on a
/// substep (e.g. a zero-delta substep), this returns the unchanged snapshot via the
/// `changed` flag instead of always emitting a new state. This is the engine's
/// "commit only when changed" discipline and is a deliberate "more correct" choice;
/// a WASM/Tauri consumer must not assume `tick_vehicles` yields a fresh allocation
/// every call.
///
/// Vehicles travel along precomputed `leg.current_path` steps stored in the
/// snapshot's route/metro-line legs — no live topology compilation is needed.
pub fn tick_vehicles(state: &GameSnapshot, delta_seconds: f64) -> GameSnapshot {
    let mut active_trips = state.active_trips.clone();
    let mut occupied_passenger_ids: HashSet<String> = state
        .transit
        .vehicles
        .iter()
        .flat_map(|vehicle| unique_passenger_ids(&vehicle.passenger_ids))
        .collect();
    let on_platform = on_platform_trip_ids(state);
    let waiter_ids_by_platform = platform_waiter_ids(state);
    let waiter_order_lookup = waiter_order_lookup(state, &waiter_ids_by_platform);
    let mut changed = false;
    let mut vehicles = Vec::with_capacity(state.transit.vehicles.len());

    // Build route-independent stop/station position maps once for the whole
    // tick. Previously `assigned_line_data` rebuilt these (including the
    // O(stops × footprint) `resolve_stop_access` pass) per vehicle.
    let position_maps = TickPositionMaps::build(state);

    for vehicle in &state.transit.vehicles {
        let Some((vehicle_position_by_id, passenger_position_by_id, itinerary)) =
            assigned_line_data(state, vehicle, &position_maps)
        else {
            vehicles.push(vehicle.clone());
            continue;
        };
        if itinerary.is_empty() {
            vehicles.push(vehicle.clone());
            continue;
        }

        let itinerary_index = vehicle.itinerary_index % itinerary.len();
        let current_leg = &itinerary[itinerary_index];
        let Some(current_vehicle_position) =
            vehicle_position_by_id.get(&current_leg.from_waypoint_id)
        else {
            vehicles.push(vehicle.clone());
            continue;
        };
        let current_passenger_position = passenger_position_by_id
            .get(&current_leg.from_waypoint_id)
            .unwrap_or(current_vehicle_position);
        let waiter_order = waiter_order_lookup
            .get(&format!(
                "{}|{}",
                position_key(current_passenger_position.x, current_passenger_position.y),
                vehicle.line_id
            ))
            .cloned()
            .unwrap_or_default();
        let at_service_departure = current_leg.kind == RouteLegKind::Service
            && vehicle.path_step_index == 0
            && vehicle.step_progress == 0.0;
        let mut next_vehicle = if at_service_departure {
            board_vehicle(
                &mut active_trips,
                vehicle,
                current_passenger_position,
                &mut occupied_passenger_ids,
                &on_platform,
                &waiter_order,
                &mut changed,
            )
        } else {
            vehicle.clone()
        };
        let previous_cursor = (
            next_vehicle.itinerary_index,
            next_vehicle.path_step_index,
            next_vehicle.step_progress,
        );
        next_vehicle.parked_position = None;
        let completion_events_changed = advance_vehicle_by_seconds(
            &mut next_vehicle,
            &itinerary,
            delta_seconds,
            |candidate, completed_itinerary_index| {
                let mut event_changed = false;
                let completed_leg = &itinerary[completed_itinerary_index];
                if let Some(reached_passenger_position) =
                    passenger_position_by_id.get(&completed_leg.to_waypoint_id)
                {
                    let (disembarked, disembark_changed) = disembark_vehicle(
                        &mut active_trips,
                        candidate,
                        reached_passenger_position,
                        completed_itinerary_index,
                    );
                    *candidate = disembarked;
                    event_changed |= disembark_changed;
                }

                let next_itinerary_index = candidate.itinerary_index % itinerary.len();
                let next_leg = &itinerary[next_itinerary_index];
                if next_leg.kind != RouteLegKind::Service {
                    return event_changed;
                }
                let Some(departure_position) =
                    passenger_position_by_id.get(&next_leg.from_waypoint_id)
                else {
                    return event_changed;
                };
                let waiter_order = waiter_order_lookup
                    .get(&format!(
                        "{}|{}",
                        position_key(departure_position.x, departure_position.y),
                        candidate.line_id
                    ))
                    .cloned()
                    .unwrap_or_default();
                let mut boarding_changed = false;
                *candidate = board_vehicle(
                    &mut active_trips,
                    candidate,
                    departure_position,
                    &mut occupied_passenger_ids,
                    &on_platform,
                    &waiter_order,
                    &mut boarding_changed,
                );
                event_changed || boarding_changed
            },
        );
        changed |= completion_events_changed;
        if previous_cursor
            != (
                next_vehicle.itinerary_index,
                next_vehicle.path_step_index,
                next_vehicle.step_progress,
            )
        {
            changed = true;
        }
        vehicles.push(next_vehicle);
    }

    if !changed {
        return state.clone();
    }

    let mut next = state.clone();
    next.active_trips = active_trips;
    next.transit.vehicles = vehicles;
    next
}

pub fn seconds_until_next_vehicle_stop(state: &GameSnapshot, vehicle: &Vehicle) -> Option<f64> {
    let itinerary = vehicle_itinerary(state, vehicle)?;
    if itinerary.is_empty() {
        return None;
    }
    let itinerary_len = itinerary.len();

    // Walk forward from the vehicle's current position, accumulating remaining
    // travel time across legs. Zero-step terminal reversal legs (and zero-
    // duration steps within a leg) contribute 0 seconds but are skipped over so
    // the function returns the cumulative time to the first real service-leg
    // completion rather than `None`. Without this, `next_boundary_after` would
    // insert no substep boundary when a vehicle sits on a zero-step reversal,
    // letting a coarse tick run past the next vehicle arrival and breaking
    // granularity independence (the `just_disembarked_trip_ids` zero-delta
    // mechanism would then give alighted passengers zero walk time for the
    // oversized substep).
    let mut total = 0.0_f64;
    let mut itinerary_index = vehicle.itinerary_index % itinerary_len;
    let mut path_step_index = vehicle.path_step_index;
    let mut step_progress = vehicle.step_progress;
    for _ in 0..itinerary_len {
        let leg = &itinerary[itinerary_index];
        let Some(path) = leg.current_path.as_ref() else {
            // Missing path: skip this leg (treat as zero-duration).
            itinerary_index = (itinerary_index + 1) % itinerary_len;
            path_step_index = 0;
            step_progress = 0.0;
            continue;
        };
        if path.step_count() == 0 {
            // Zero-step terminal reversal: contributes 0 seconds, advance to
            // the next leg.
            itinerary_index = (itinerary_index + 1) % itinerary_len;
            path_step_index = 0;
            step_progress = 0.0;
            continue;
        }
        // Found a real (non-empty) leg. Sum remaining time in the current step
        // plus all later steps in this leg.
        let remaining_current = if let Some(current_step) = path.step(path_step_index) {
            (1.0 - step_progress).max(0.0) * current_step.travel_seconds()
        } else {
            0.0
        };
        let remaining_later: f64 = (path_step_index + 1..path.step_count())
            .filter_map(|index| path.step(index))
            .map(|step| step.travel_seconds())
            .sum();
        total += remaining_current + remaining_later;
        return Some(total);
    }
    // Every leg is zero-step or missing a path: no real stop arrival ahead.
    None
}

pub fn cycle_road_direction(state: &GameSnapshot, point: &Point) -> GameplayResult<GameSnapshot> {
    apply_road_mutation(state, &RoadMutation::CycleRoadDirection { point: *point })
        .map(|result| result.snapshot)
}

/// Toggle a route or metro line's `active` flag.
///
/// Platform assignment (which platform serves which route) is established only at
/// creation time in `add_bus_route`/`add_metro_line`, gated on `active`. This
/// function intentionally mirrors the TS oracle (`src/simulation/transit.ts`
/// `setRouteActive`): it flips only the flag and does **not** reassign platforms.
///
/// Consequence: a route created `active=false` (fewer than two valid stops) that is
/// later activated will still carry no platform mapping. In practice this is guarded
/// by `path_broken` (the router skips broken routes), but degenerate inputs such as
/// duplicate stop ids can produce an active, non-broken route with no platform. This
/// is parity-faithful behaviour, not a Rust-specific defect — routes intended for
/// service must be created with two or more valid stops so they are active at birth.
pub fn set_route_active(
    state: &GameSnapshot,
    route_id: &str,
    active: bool,
) -> GameplayResult<GameSnapshot> {
    let mut next = state.clone();
    if let Some(route) = next
        .transit
        .routes
        .iter_mut()
        .find(|route| route.id == route_id)
    {
        if route.active == active {
            return Ok(state.clone());
        }
        route.active = active;
        return Ok(next);
    }
    if let Some(line) = next
        .transit
        .metro_lines
        .iter_mut()
        .find(|line| line.id == route_id)
    {
        if line.active == active {
            return Ok(state.clone());
        }
        line.active = active;
        return Ok(next);
    }
    Err(route_rejection(RejectionCode::RouteNotFound, route_id))
}

pub fn rename_route(
    state: &GameSnapshot,
    route_id: &str,
    name: &str,
) -> GameplayResult<GameSnapshot> {
    let mut next = state.clone();
    if let Some(route) = next
        .transit
        .routes
        .iter_mut()
        .find(|route| route.id == route_id)
    {
        let final_name = final_route_name("bus", route_id, name);
        if route.name == final_name {
            return Ok(state.clone());
        }
        route.name = final_name;
        return Ok(next);
    }
    if let Some(line) = next
        .transit
        .metro_lines
        .iter_mut()
        .find(|line| line.id == route_id)
    {
        let final_name = final_route_name("metro", route_id, name);
        if line.name == final_name {
            return Ok(state.clone());
        }
        line.name = final_name;
        return Ok(next);
    }
    Err(route_rejection(RejectionCode::RouteNotFound, route_id))
}

pub fn recolor_route(
    state: &GameSnapshot,
    route_id: &str,
    color: &str,
) -> GameplayResult<GameSnapshot> {
    let mut next = state.clone();
    if let Some(route) = next
        .transit
        .routes
        .iter_mut()
        .find(|route| route.id == route_id)
    {
        if route.color == color {
            return Ok(state.clone());
        }
        route.color = color.to_string();
        return Ok(next);
    }
    if let Some(line) = next
        .transit
        .metro_lines
        .iter_mut()
        .find(|line| line.id == route_id)
    {
        if line.color == color {
            return Ok(state.clone());
        }
        line.color = color.to_string();
        return Ok(next);
    }
    Err(route_rejection(RejectionCode::RouteNotFound, route_id))
}

pub fn delete_route(state: &GameSnapshot, route_id: &str) -> GameplayResult<GameSnapshot> {
    let is_route = state
        .transit
        .routes
        .iter()
        .any(|route| route.id == route_id);
    let is_line = state
        .transit
        .metro_lines
        .iter()
        .any(|line| line.id == route_id);
    if !is_route && !is_line {
        return Err(route_rejection(RejectionCode::RouteNotFound, route_id));
    }

    let mut next = state.clone();
    if is_route {
        strip_route_from_platforms(&mut next.transit.stops, route_id);
        next.transit.routes.retain(|route| route.id != route_id);
    }
    if is_line {
        strip_route_from_platforms(&mut next.transit.stations, route_id);
        next.transit.metro_lines.retain(|line| line.id != route_id);
    }
    next.transit
        .vehicles
        .retain(|vehicle| vehicle.line_id != route_id);
    invalidate_trips_for_line(
        &mut next.active_trips,
        &mut next.transit.vehicles,
        route_id,
        &HashMap::new(),
    );
    Ok(garbage_collect_missing_nodes(&next))
}

pub fn assign_route_to_platform(
    state: &GameSnapshot,
    node_id: &str,
    route_id: &str,
    platform_id: &str,
) -> GameplayResult<GameSnapshot> {
    let mut next = state.clone();
    let node_is_missing = state
        .transit
        .stops
        .iter()
        .any(|stop| stop.id == node_id && !is_present_node(stop.status))
        || state
            .transit
            .stations
            .iter()
            .any(|station| station.id == node_id && !is_present_node(station.status));
    if node_is_missing {
        return Err(node_rejection(
            RejectionCode::MissingRouteNode,
            node_id,
            Some(route_id),
        ));
    }
    if reassign_within_node(&mut next.transit.stops, node_id, route_id, platform_id) {
        increment_route_revision(&mut next, route_id)?;
        return Ok(next);
    }
    if reassign_within_node(&mut next.transit.stations, node_id, route_id, platform_id) {
        increment_route_revision(&mut next, route_id)?;
        return Ok(next);
    }
    let node_exists = state.transit.stops.iter().any(|stop| stop.id == node_id)
        || state
            .transit
            .stations
            .iter()
            .any(|station| station.id == node_id);
    if !node_exists {
        return Err(node_rejection(
            RejectionCode::MissingRouteNode,
            node_id,
            Some(route_id),
        ));
    }
    Err(node_rejection(
        RejectionCode::InvalidPlatform,
        node_id,
        Some(route_id),
    ))
}

fn increment_route_revision(state: &mut GameSnapshot, route_id: &str) -> GameplayResult<()> {
    if let Some(route) = state
        .transit
        .routes
        .iter_mut()
        .find(|route| route.id == route_id)
    {
        route.revision = route
            .revision
            .checked_add(1)
            .ok_or_else(|| exhausted_route_revision(route_id, route.revision))?;
        return Ok(());
    }
    if let Some(line) = state
        .transit
        .metro_lines
        .iter_mut()
        .find(|line| line.id == route_id)
    {
        line.revision = line
            .revision
            .checked_add(1)
            .ok_or_else(|| exhausted_route_revision(route_id, line.revision))?;
    }
    Ok(())
}

fn exhausted_route_revision(route_id: &str, revision: u32) -> GameplayRejection {
    GameplayRejection::route_revision_exhausted(route_id, revision)
}

pub fn stop_coverage_radius(kind: BusStopKind) -> u8 {
    if kind == BusStopKind::BusTerminal {
        4
    } else {
        2
    }
}

fn remove_infrastructure_at_tile(
    state: &GameSnapshot,
    point: &Point,
) -> GameplayResult<GameSnapshot> {
    let Some(tile) = get_tile(&state.map, point) else {
        return Err(GameplayRejection::at(RejectionCode::OutOfBounds, *point));
    };

    let mut next = state.clone();
    if tile.has_track {
        set_tile_track(&mut next.map, point, false);
        return Ok(next);
    }
    if tile.kind == "road" {
        return apply_road_mutation(state, &RoadMutation::RemoveAtTile { point: *point })
            .map(|result| result.snapshot);
    }
    Err(GameplayRejection::at(RejectionCode::BlockedTile, *point))
}

fn cleanup_removed_destination_references(
    state: &mut GameSnapshot,
    removed_destination_tiles: &HashSet<String>,
) {
    if removed_destination_tiles.is_empty() {
        return;
    }

    let mut cleared_sim_ids = HashSet::new();
    for sim in &mut state.sims {
        if sim
            .workplace
            .as_ref()
            .is_some_and(|workplace| removed_destination_tiles.contains(&point_key(workplace)))
        {
            sim.workplace = None;
            cleared_sim_ids.insert(sim.id.clone());
        }
    }

    crate::buildings::assign_workplaces(state);

    // `assign_workplaces` may also promote a home-fallback worker (workplace ==
    // home) to a real non-home workplace when a non-home destination survives
    // the removal. Retarget any stale dormant trip left targeting home so the
    // worker is not stuck dormant despite now having a valid workplace. Run
    // before the bulldoze trip-retarget loop: it touches a disjoint trip set
    // (outbound trips targeting home with a promoted workplace) that the
    // bulldoze logic (removed-tile / cleared-workplace trips) does not cover.
    crate::trips::retarget_home_fallback_trips(state);

    let workplace_by_sim_id: HashMap<String, Point> = state
        .sims
        .iter()
        .filter_map(|sim| sim.workplace.map(|workplace| (sim.id.clone(), workplace)))
        .collect();
    let mut invalidated_trip_ids = HashSet::new();
    let mut removed_trip_ids = HashSet::new();
    for trip in &mut state.active_trips {
        let destination_removed = removed_destination_tiles.contains(&point_key(&trip.destination));
        // Only outbound trips target a workplace; a return trip's destination is the
        // sim's home (a residential tile, never present in `removed_destination_tiles`).
        // A cleared workplace must therefore never retarget an in-flight return trip:
        // `apply_arrival_to_sim` resolves `CommuteReturn` at home regardless of
        // `trip.destination`, so rewriting it toward a replacement workplace would
        // route the passenger away from home for nothing.
        let workplace_retarget_needed =
            trip.purpose == TripPurpose::CommuteOutbound && cleared_sim_ids.contains(&trip.sim_id);
        if !destination_removed && !workplace_retarget_needed {
            continue;
        }

        let replacement_workplace = workplace_by_sim_id
            .get(&trip.sim_id)
            .filter(|workplace| !removed_destination_tiles.contains(&point_key(workplace)))
            .cloned();

        // An outbound trip whose destination was bulldozed with no replacement
        // workplace cannot be retargeted. Drop it outright instead of rewriting its
        // destination to home: that produces a dormant home-fallback trip which
        // `is_home_fallback_trip` keeps alive forever, and whose id lets
        // `has_trip_for_sim_day` block any same-day retry once a new destination is
        // placed. Removing it leaves the sim unassigned and free to spawn a fresh
        // outbound trip when a workplace reappears.
        if trip.purpose == TripPurpose::CommuteOutbound
            && destination_removed
            && replacement_workplace.is_none()
        {
            removed_trip_ids.insert(trip.id.clone());
            invalidated_trip_ids.insert(trip.id.clone());
            continue;
        }

        // No replacement to retarget to (e.g. a stale trip whose own destination is
        // still standing): leave it on its current heading rather than rewriting it.
        let Some(replacement) = replacement_workplace else {
            continue;
        };

        invalidated_trip_ids.insert(trip.id.clone());
        trip.status = TripStatus::Idle;
        trip.route_plan = None;
        trip.current_leg_index = 0;
        trip.destination = replacement;
        // Refresh the trip timers: retargeting starts a fresh trip (plan nulled,
        // status reset to idle), so the patience/deadline window must reset too.
        // Otherwise a trip that already consumed most of its patience, or whose
        // deadline has elapsed, would be marked unserved on the next tick even
        // though it was validly retargeted. Mirrors the legacy `retargetCitizens`
        // flow (buildingSelectors.ts) and the values used at trip creation
        // (`build_trip`: `trip_deadline_seconds(scheduled) = t + 900`,
        // `WAIT_PATIENCE_SECONDS = 240`).
        trip.deadline = trip_deadline_seconds(state.time);
        trip.patience_remaining = WAIT_PATIENCE_SECONDS;
    }

    if !removed_trip_ids.is_empty() {
        state
            .active_trips
            .retain(|trip| !removed_trip_ids.contains(&trip.id));
    }

    if invalidated_trip_ids.is_empty() {
        return;
    }
    for vehicle in &mut state.transit.vehicles {
        vehicle
            .passenger_ids
            .retain(|passenger_id| !invalidated_trip_ids.contains(passenger_id));
    }
}

fn reassign_within_node<T>(
    nodes: &mut [T],
    node_id: &str,
    route_id: &str,
    platform_id: &str,
) -> bool
where
    T: PlatformNode,
{
    let Some(node) = nodes.iter_mut().find(|node| node.id() == node_id) else {
        return false;
    };
    let target_exists = node
        .platforms()
        .iter()
        .any(|platform| platform.id == platform_id);
    let holds_route = node
        .platforms()
        .iter()
        .any(|platform| platform.route_ids.iter().any(|id| id == route_id));
    let target_already_holds_route = node.platforms().iter().any(|platform| {
        platform.id == platform_id && platform.route_ids.iter().any(|id| id == route_id)
    });

    if !target_exists || !holds_route || target_already_holds_route {
        return false;
    }

    for platform in node.platforms_mut() {
        if platform.id == platform_id {
            platform.route_ids.push(route_id.to_string());
        } else {
            platform.route_ids.retain(|id| id != route_id);
        }
    }
    true
}

fn strip_route_from_platforms<T>(nodes: &mut [T], route_id: &str)
where
    T: PlatformNode,
{
    for node in nodes {
        for platform in node.platforms_mut() {
            platform.route_ids.retain(|id| id != route_id);
        }
    }
}

trait PlatformNode {
    fn id(&self) -> &str;
    fn platforms(&self) -> &[Platform];
    fn platforms_mut(&mut self) -> &mut [Platform];
}

impl PlatformNode for crate::model::Stop {
    fn id(&self) -> &str {
        &self.id
    }

    fn platforms(&self) -> &[Platform] {
        &self.platforms
    }

    fn platforms_mut(&mut self) -> &mut [Platform] {
        &mut self.platforms
    }
}

impl PlatformNode for crate::model::Station {
    fn id(&self) -> &str {
        &self.id
    }

    fn platforms(&self) -> &[Platform] {
        &self.platforms
    }

    fn platforms_mut(&mut self) -> &mut [Platform] {
        &mut self.platforms
    }
}

pub(crate) fn invalidate_trips_for_line(
    active_trips: &mut [ActiveTrip],
    vehicles: &mut [Vehicle],
    line_id: &str,
    parked_position_by_trip_id: &HashMap<String, TripPosition>,
) {
    let mut invalidated_trip_ids: Vec<String> = Vec::new();
    for trip in active_trips {
        // Only invalidate when the deleted line is part of the trip's current or
        // remaining legs. A trip that already transferred off this line is
        // physically aboard another vehicle and must be left alone; resetting it
        // would orphan a ghost passenger on that other vehicle.
        if !plan_references_line_from(&trip.route_plan, line_id, trip.current_leg_index) {
            continue;
        }
        trip.status = TripStatus::Idle;
        trip.route_plan = None;
        trip.current_leg_index = 0;
        if let Some(parked_at) = parked_position_by_trip_id.get(&trip.id) {
            trip.position = parked_at.clone();
        }
        invalidated_trip_ids.push(trip.id.clone());
    }

    // Drop ghost passengers: an invalidated trip must not keep occupying a seat
    // on any surviving vehicle. The deleted line's own vehicles are already
    // cleared by the caller (or removed entirely by `delete_route`), but a trip
    // can also be riding a different line when a *future* leg's line is deleted.
    // Without this scrub the reset trip can never re-board (its id lingers in
    // occupied_passenger_ids) while a phantom passenger consumes capacity.
    if !invalidated_trip_ids.is_empty() {
        let invalidated_set: HashSet<&str> =
            invalidated_trip_ids.iter().map(String::as_str).collect();
        for vehicle in vehicles {
            vehicle
                .passenger_ids
                .retain(|id| !invalidated_set.contains(id.as_str()));
        }
    }
}

fn plan_references_line_from(
    plan: &Option<crate::model::RoutePlan>,
    line_id: &str,
    start_leg_index: usize,
) -> bool {
    plan.as_ref().is_some_and(|plan| {
        plan.legs.iter().enumerate().any(|(index, leg)| {
            index >= start_leg_index
                && leg.mode != TransitMode::Walk
                && leg.line_id.as_deref() == Some(line_id)
        })
    })
}

type AssignedLineData<'a> = (
    &'a HashMap<String, Point>,
    &'a HashMap<String, Point>,
    Vec<RouteLegPath>,
);

/// Pre-computed route-independent stop/station position maps shared across all
/// vehicles in one tick. Building these once per tick (instead of per vehicle
/// inside `assigned_line_data`) avoids an O(vehicles × stops × footprint)
/// recomputation of `resolve_stop_access` every tick.
struct TickPositionMaps {
    bus_vehicle_positions: HashMap<String, Point>,
    bus_passenger_positions: HashMap<String, Point>,
    metro_positions: HashMap<String, Point>,
}

impl TickPositionMaps {
    fn build(state: &GameSnapshot) -> Self {
        let has_bus = state
            .transit
            .vehicles
            .iter()
            .any(|vehicle| vehicle.mode == TransitMode::Bus);
        let has_metro = state
            .transit
            .vehicles
            .iter()
            .any(|vehicle| vehicle.mode == TransitMode::Metro);

        let bus_vehicle_positions = if has_bus {
            state
                .transit
                .stops
                .iter()
                .filter_map(|stop| {
                    crate::stop_access::resolve_stop_access(state, &stop.id)
                        .map(|access| (stop.id.clone(), access.road_point))
                })
                .collect()
        } else {
            HashMap::new()
        };
        let bus_passenger_positions = if has_bus {
            state
                .transit
                .stops
                .iter()
                .filter(|stop| is_present_node(stop.status))
                .map(|stop| (stop.id.clone(), stop.position))
                .collect()
        } else {
            HashMap::new()
        };
        let metro_positions = if has_metro {
            state
                .transit
                .stations
                .iter()
                .filter(|station| is_present_node(station.status))
                .map(|station| (station.id.clone(), station.position))
                .collect()
        } else {
            HashMap::new()
        };
        Self {
            bus_vehicle_positions,
            bus_passenger_positions,
            metro_positions,
        }
    }
}

/// Look up the route/line assigned to `vehicle` and return its service legs if
/// the line is operational. This is the per-vehicle part of `assigned_line_data`
/// that cannot be hoisted out of the vehicle loop.
fn vehicle_itinerary(state: &GameSnapshot, vehicle: &Vehicle) -> Option<Vec<RouteLegPath>> {
    if vehicle.mode == TransitMode::Bus {
        let route = state
            .transit
            .routes
            .iter()
            .find(|candidate| candidate.id == vehicle.line_id)?;
        if !is_route_operational(route.active, &route.legs) {
            return None;
        }
        Some(route.legs.clone())
    } else {
        let line = state
            .transit
            .metro_lines
            .iter()
            .find(|candidate| candidate.id == vehicle.line_id)?;
        if !is_route_operational(line.active, &line.legs) {
            return None;
        }
        Some(line.legs.clone())
    }
}

fn assigned_line_data<'a>(
    state: &'a GameSnapshot,
    vehicle: &Vehicle,
    maps: &'a TickPositionMaps,
) -> Option<AssignedLineData<'a>> {
    let itinerary = vehicle_itinerary(state, vehicle)?;
    if vehicle.mode == TransitMode::Bus {
        Some((
            &maps.bus_vehicle_positions,
            &maps.bus_passenger_positions,
            itinerary,
        ))
    } else {
        Some((&maps.metro_positions, &maps.metro_positions, itinerary))
    }
}

/// Advance one vehicle along its itinerary by `remaining_seconds` of simulated
/// travel time, firing `on_itinerary_leg_completed` whenever the cursor crosses
/// a leg boundary. Returns whether any completion event changed state.
///
/// # Zero-step terminal reversals
///
/// A terminal reversal between two road access tiles that share the same
/// heading (same-direction bus terminal, or a metro stop whose entry and exit
/// headings match) produces an *empty* path — `step_count() == 0` — so the
/// vehicle "completes" the leg without moving. `road_topology::find_terminal_reversal`
/// deliberately returns these zero-step paths for same-heading reversals
/// (see `road_topology.rs` and the `terminal_reversal_on_one_way_lane_returns_zero_step_path`
/// test) and a multi-step U-turn/roundabout path otherwise.
///
/// Because an itinerary can contain several consecutive zero-step legs,
/// advancing would otherwise loop forever consuming no time. The
/// `consecutive_zero_steps` guard caps the run at `zero_step_limit` (the total
/// real step count of the itinerary, at least one): once a zero-step run exceeds
/// the number of genuine steps in the loop, the vehicle cannot make progress
/// this tick and we stop advancing it. A non-zero-step leg resets the counter.
/// The same guard also covers the degenerate `step_seconds <= EPSILON` case.
fn advance_vehicle_by_seconds<F>(
    vehicle: &mut Vehicle,
    itinerary: &[RouteLegPath],
    mut remaining_seconds: f64,
    mut on_itinerary_leg_completed: F,
) -> bool
where
    F: FnMut(&mut Vehicle, usize) -> bool,
{
    let zero_step_limit = itinerary
        .iter()
        .filter_map(|leg| leg.current_path.as_ref())
        .map(TransitPath::step_count)
        .sum::<usize>()
        .max(1);
    let mut consecutive_zero_steps = 0;
    let mut completion_events_changed = false;

    while remaining_seconds > 0.0 {
        let original_itinerary_index = vehicle.itinerary_index;
        let itinerary_index = vehicle.itinerary_index % itinerary.len();
        let leg = &itinerary[itinerary_index];
        // The operational-route invariant should guarantee a path, but a
        // panic here crashes both WASM and Tauri hosts irrecoverably. Reset
        // the cursor defensively and stop advancing this vehicle — mirroring
        // the break_service skip in route_lifecycle.rs.
        let Some(path) = leg.current_path.as_ref() else {
            if cfg!(debug_assertions) {
                eprintln!(
                    "warning: vehicle {} on route {} leg {} has no current_path; skipping advance",
                    vehicle.id, vehicle.line_id, itinerary_index
                );
            }
            vehicle.path_step_index = 0;
            vehicle.step_progress = 0.0;
            return completion_events_changed;
        };
        if path.step_count() == 0 {
            advance_vehicle_cursor(vehicle, itinerary);
            completion_events_changed |= on_itinerary_leg_completed(vehicle, itinerary_index);
            consecutive_zero_steps += 1;
            if consecutive_zero_steps > zero_step_limit {
                return completion_events_changed;
            }
            continue;
        }
        // Defensive: a corrupted step index should not crash both hosts.
        // Reset the cursor and stop advancing this vehicle.
        let Some(step) = path.step(vehicle.path_step_index) else {
            if cfg!(debug_assertions) {
                eprintln!(
                    "warning: vehicle {} on route {} leg {} has corrupted step index {}; skipping advance",
                    vehicle.id, vehicle.line_id, itinerary_index, vehicle.path_step_index
                );
            }
            vehicle.path_step_index = 0;
            vehicle.step_progress = 0.0;
            return completion_events_changed;
        };
        let step_seconds = step.travel_seconds();
        if step_seconds <= f64::EPSILON {
            advance_vehicle_cursor(vehicle, itinerary);
            if vehicle.itinerary_index != original_itinerary_index {
                completion_events_changed |= on_itinerary_leg_completed(vehicle, itinerary_index);
            }
            consecutive_zero_steps += 1;
            if consecutive_zero_steps > zero_step_limit {
                return completion_events_changed;
            }
            continue;
        }
        consecutive_zero_steps = 0;
        let remaining_step = step_seconds * (1.0 - vehicle.step_progress);

        if remaining_seconds < remaining_step {
            vehicle.step_progress += remaining_seconds / step_seconds;
            return completion_events_changed;
        }

        remaining_seconds -= remaining_step;
        advance_vehicle_cursor(vehicle, itinerary);
        if vehicle.itinerary_index != original_itinerary_index {
            completion_events_changed |= on_itinerary_leg_completed(vehicle, itinerary_index);
        }
    }
    completion_events_changed
}

fn advance_vehicle_cursor(vehicle: &mut Vehicle, itinerary: &[RouteLegPath]) {
    // Defensive: a missing path should not crash both hosts. Reset the
    // cursor and return without advancing — the caller's cursor-change
    // check will see no movement.
    let Some(path) = itinerary[vehicle.itinerary_index % itinerary.len()]
        .current_path
        .as_ref()
    else {
        if cfg!(debug_assertions) {
            eprintln!(
                "warning: vehicle {} on route {} has no current_path in advance_vehicle_cursor; cursor reset",
                vehicle.id, vehicle.line_id
            );
        }
        vehicle.path_step_index = 0;
        vehicle.step_progress = 0.0;
        return;
    };
    vehicle.step_progress = 0.0;
    vehicle.path_step_index += 1;
    if vehicle.path_step_index >= path.step_count() {
        vehicle.path_step_index = 0;
        vehicle.itinerary_index = (vehicle.itinerary_index + 1) % itinerary.len();
    }
}

fn board_vehicle(
    active_trips: &mut [ActiveTrip],
    vehicle: &Vehicle,
    current_position: &Point,
    occupied_passenger_ids: &mut HashSet<String>,
    on_platform: &HashSet<String>,
    waiter_order: &[String],
    changed: &mut bool,
) -> Vehicle {
    let mut passenger_ids = unique_passenger_ids(&vehicle.passenger_ids);
    let available_seats = usize::from(vehicle.capacity).saturating_sub(passenger_ids.len());
    if available_seats == 0 {
        let mut next = vehicle.clone();
        next.passenger_ids = passenger_ids;
        return next;
    }

    let mut boarding_trip_ids = Vec::new();
    for trip_id in waiter_order {
        if boarding_trip_ids.len() >= available_seats {
            break;
        }
        let Some(trip) = active_trips.iter().find(|trip| trip.id == *trip_id) else {
            continue;
        };
        if trip_can_board(
            trip,
            vehicle,
            current_position,
            occupied_passenger_ids,
            on_platform,
        ) {
            boarding_trip_ids.push(trip.id.clone());
            occupied_passenger_ids.insert(trip.id.clone());
        }
    }

    if boarding_trip_ids.is_empty() {
        let mut next = vehicle.clone();
        next.passenger_ids = passenger_ids;
        return next;
    }

    let boarding_set: HashSet<&str> = boarding_trip_ids.iter().map(String::as_str).collect();
    for trip in active_trips {
        if boarding_set.contains(trip.id.as_str()) {
            trip.status = TripStatus::Riding;
        }
    }
    passenger_ids.extend(boarding_trip_ids);
    *changed = true;

    let mut next = vehicle.clone();
    next.passenger_ids = passenger_ids;
    next
}

fn disembark_vehicle(
    active_trips: &mut [ActiveTrip],
    vehicle: &Vehicle,
    reached_passenger_position: &Point,
    completed_itinerary_index: usize,
) -> (Vehicle, bool) {
    let passenger_ids = unique_passenger_ids(&vehicle.passenger_ids);
    let disembarking_ids: HashSet<String> = active_trips
        .iter()
        .filter(|trip| {
            passenger_ids
                .iter()
                .any(|passenger_id| passenger_id == &trip.id)
                && trip
                    .route_plan
                    .as_ref()
                    .and_then(|plan| plan.legs.get(trip.current_leg_index))
                    .is_some_and(|leg| {
                        leg.mode == vehicle.mode
                            && leg.line_id.as_deref() == Some(vehicle.line_id.as_str())
                            && leg.alight_itinerary_index == Some(completed_itinerary_index)
                            && leg.to == *reached_passenger_position
                    })
        })
        .map(|trip| trip.id.clone())
        .collect();

    for trip in active_trips {
        if disembarking_ids.contains(&trip.id) {
            trip.position = (*reached_passenger_position).into();
            trip.status = TripStatus::Walking;
            trip.current_leg_index += 1;
        }
    }

    let mut next = vehicle.clone();
    next.passenger_ids = passenger_ids
        .into_iter()
        .filter(|passenger_id| !disembarking_ids.contains(passenger_id))
        .collect();
    (next, !disembarking_ids.is_empty())
}

fn trip_can_board(
    trip: &ActiveTrip,
    vehicle: &Vehicle,
    current_passenger_position: &Point,
    occupied_passenger_ids: &HashSet<String>,
    on_platform: &HashSet<String>,
) -> bool {
    if trip.status != TripStatus::Waiting
        || occupied_passenger_ids.contains(&trip.id)
        || !on_platform.contains(&trip.id)
    {
        return false;
    }

    trip.route_plan
        .as_ref()
        .and_then(|plan| plan.legs.get(trip.current_leg_index))
        .is_some_and(|leg| {
            leg.mode == vehicle.mode
                && leg.line_id.as_deref() == Some(vehicle.line_id.as_str())
                && leg.board_itinerary_index == Some(vehicle.itinerary_index)
                && trip_position_matches_point(&trip.position, current_passenger_position)
        })
}

fn trip_position_matches_point(position: &TripPosition, point: &Point) -> bool {
    (position.x - f64::from(point.x)).abs() < 0.000_001
        && (position.y - f64::from(point.y)).abs() < 0.000_001
}

fn waiter_order_lookup(
    state: &GameSnapshot,
    waiter_ids_by_platform: &HashMap<String, Vec<String>>,
) -> HashMap<String, Vec<String>> {
    let mut lookup: HashMap<String, Vec<String>> = HashMap::new();

    for stop in &state.transit.stops {
        if !is_present_node(stop.status) {
            continue;
        }
        let pos_key = position_key(stop.position.x, stop.position.y);
        for platform in &stop.platforms {
            for route_id in &platform.route_ids {
                let key = format!("{pos_key}|{route_id}");
                let ids = waiter_ids_by_platform
                    .get(&platform.id)
                    .cloned()
                    .unwrap_or_default();
                lookup.entry(key).or_default().extend(ids);
            }
        }
    }

    for station in &state.transit.stations {
        if !is_present_node(station.status) {
            continue;
        }
        let pos_key = position_key(station.position.x, station.position.y);
        for platform in &station.platforms {
            for route_id in &platform.route_ids {
                let key = format!("{pos_key}|{route_id}");
                let ids = waiter_ids_by_platform
                    .get(&platform.id)
                    .cloned()
                    .unwrap_or_default();
                lookup.entry(key).or_default().extend(ids);
            }
        }
    }

    lookup
}

fn unique_passenger_ids(passenger_ids: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut unique = Vec::new();
    for passenger_id in passenger_ids {
        if seen.insert(passenger_id) {
            unique.push(passenger_id.clone());
        }
    }
    unique
}

fn is_valid_bus_stop_placement(state: &GameSnapshot, point: &Point) -> bool {
    get_tile(&state.map, point).is_some_and(|tile| {
        tile.kind == "empty"
            && !tile.has_track
            && tile.road_structure_id.is_none()
            && !is_building_occupied(state, point)
            && !is_transit_node_at(state, point)
            && derive_stop_access(&state.map, *point).is_some()
    })
}

fn is_valid_metro_station_placement(state: &GameSnapshot, point: &Point) -> bool {
    get_tile(&state.map, point).is_some_and(|tile| {
        (tile.kind == "road" || tile.kind == "empty")
            && tile.has_track
            && tile.road_structure_id.is_none()
            && !is_building_occupied(state, point)
            && !state
                .transit
                .stations
                .iter()
                .any(|station| is_present_node(station.status) && station.position == *point)
    })
}

fn is_valid_track_placement(state: &GameSnapshot, point: &Point) -> bool {
    get_tile(&state.map, point).is_some_and(|tile| {
        (tile.kind == "empty" || tile.kind == "road")
            && !tile.has_track
            && tile.road_structure_id.is_none()
            && !is_building_occupied(state, point)
            && !is_transit_node_at(state, point)
    })
}

fn is_building_occupied(state: &GameSnapshot, point: &Point) -> bool {
    state
        .buildings
        .iter()
        .any(|building| building.occupied_tiles.iter().any(|tile| tile == point))
}

fn is_transit_node_at(state: &GameSnapshot, point: &Point) -> bool {
    state
        .transit
        .stops
        .iter()
        .any(|stop| is_present_node(stop.status) && stop.position == *point)
        || state
            .transit
            .stations
            .iter()
            .any(|station| is_present_node(station.status) && station.position == *point)
}

fn get_tile<'a>(map: &'a GameMap, point: &Point) -> Option<&'a Tile> {
    if point.x < 0
        || point.x >= i32::from(map.width)
        || point.y < 0
        || point.y >= i32::from(map.height)
    {
        return None;
    }
    map.tiles
        .iter()
        .find(|tile| tile.x == point.x && tile.y == point.y)
}

fn get_tile_mut<'a>(map: &'a mut GameMap, point: &Point) -> Option<&'a mut Tile> {
    map.tiles
        .iter_mut()
        .find(|tile| tile.x == point.x && tile.y == point.y)
}

fn set_tile_track(map: &mut GameMap, point: &Point, has_track: bool) {
    if let Some(tile) = get_tile_mut(map, point) {
        tile.has_track = has_track;
    }
}

fn entity_number_from_id(prefix: &str, id: &str) -> usize {
    id.strip_prefix(&format!("{prefix}-"))
        .and_then(|suffix| suffix.parse::<usize>().ok())
        .unwrap_or(1)
}

fn final_route_name(kind: &str, id: &str, name: &str) -> String {
    let trimmed = name.trim();
    if !trimmed.is_empty() {
        return trimmed.to_string();
    }
    if kind == "bus" {
        format!("Bus {}", entity_number_from_id("route", id))
    } else {
        format!("Metro {}", entity_number_from_id("metro", id))
    }
}

fn position_key(x: i32, y: i32) -> String {
    format!("{x},{y}")
}

fn point_key(point: &Point) -> String {
    position_key(point.x, point.y)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::intent::RoadPreset;
    use crate::model::{
        BusStopKind, Heading, MovementKind, PathGeometry, RoadPathStep, Route, RouteLegKind,
        RouteLegPath, RouteLegStatus, ServiceDirection, ServicePattern, Stop, StopRoadAccess,
        TransitMode, TransitNodeStatus, TripPosition, Vehicle,
    };
    use crate::road::{apply_road_mutation, RoadMutation};
    use crate::state::create_initial_snapshot;
    use crate::stop_access::resolve_stop_access;

    #[test]
    fn tick_vehicles_skips_vehicle_whose_from_waypoint_lacks_road_access() {
        // Lay a road adjacent to stop-002 only, so the resolved `stop_access`
        // is `None` for stop-001 (the from_waypoint) and `Some` for stop-002.
        // This guarantees the skip is caused by the from_waypoint lacking road
        // access, independent of `create_initial_snapshot()`'s scenario map.
        let mut snapshot = apply_road_mutation(
            &create_initial_snapshot(),
            &RoadMutation::LayRoadLine {
                points: (7..=9).map(|x| Point { x, y: 6 }).collect(),
                preset: RoadPreset::TwoWay,
            },
        )
        .expect("fixture road should apply")
        .snapshot;
        let stop_a = Stop {
            id: "stop-001".to_string(),
            kind: BusStopKind::BusStop,
            status: TransitNodeStatus::Present,
            position: Point { x: 4, y: 5 },
            platforms: Vec::new(),
            road_access: None,
        };
        let stop_b = Stop {
            id: "stop-002".to_string(),
            kind: BusStopKind::BusStop,
            status: TransitNodeStatus::Present,
            position: Point { x: 8, y: 5 },
            platforms: Vec::new(),
            road_access: Some(StopRoadAccess {
                road_point: Point { x: 8, y: 6 },
                preferred_heading: None,
            }),
        };
        snapshot.transit.stops = vec![stop_a, stop_b];

        // Assert the resolved access state before ticking, so the premise is
        // explicit and not silently dependent on the scenario map defaults.
        assert!(resolve_stop_access(&snapshot, "stop-001").is_none());
        assert!(resolve_stop_access(&snapshot, "stop-002").is_some());

        let leg = RouteLegPath {
            from_waypoint_id: "stop-001".to_string(),
            to_waypoint_id: "stop-002".to_string(),
            direction: ServiceDirection::Loop,
            kind: RouteLegKind::Service,
            status: RouteLegStatus::Connected,
            current_path: Some(TransitPath::Road {
                steps: vec![RoadPathStep {
                    position: Point { x: 4, y: 5 },
                    entering_heading: Heading::East,
                    leaving_heading: Heading::East,
                    movement: MovementKind::Straight,
                    geometry: PathGeometry::Line {
                        from: TripPosition { x: 4.0, y: 5.0 },
                        to: TripPosition { x: 8.0, y: 5.0 },
                    },
                    travel_seconds: 4.0,
                }],
                total_travel_seconds: 4.0,
            }),
            last_valid_path: None,
            estimated_seconds: Some(4.0),
            failure_reason: None,
        };
        let route = Route {
            id: "route-001".to_string(),
            name: "R1".to_string(),
            color: "#f00".to_string(),
            stop_ids: vec!["stop-001".to_string(), "stop-002".to_string()],
            vehicle_ids: vec!["vehicle-001".to_string()],
            active: true,
            pattern: ServicePattern::Loop,
            revision: 0,
            legs: vec![leg],
            path_broken: false,
        };
        snapshot.transit.routes = vec![route];

        let vehicle = Vehicle {
            id: "vehicle-001".to_string(),
            mode: TransitMode::Bus,
            line_id: "route-001".to_string(),
            capacity: 18,
            passenger_ids: Vec::new(),
            itinerary_index: 0,
            path_step_index: 0,
            step_progress: 0.0,
            parked_position: None,
        };
        snapshot.transit.vehicles = vec![vehicle.clone()];

        let result = tick_vehicles(&snapshot, 1.0);
        assert_eq!(result.transit.vehicles.len(), 1);
        assert_eq!(result.transit.vehicles[0], vehicle);
    }
}
