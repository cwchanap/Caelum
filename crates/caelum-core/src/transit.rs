use std::collections::{HashMap, HashSet};

use crate::building_catalog::building_definition;
use crate::commute::trip_deadline_seconds;
use crate::ids::next_entity_id;
use crate::intent::RoadPreset;
use crate::model::{
    ActiveTrip, GameMap, GameSnapshot, MetroLine, Platform, Point, Route, Tile, TransitMode,
    TripPosition, TripPurpose, TripStatus, Vehicle,
};
use crate::network::{compute_route_segments, has_broken_segment};
use crate::platforms::{bus_platforms, metro_platforms, on_platform_trip_ids, platform_waiter_ids};
use crate::trips::WAIT_PATIENCE_SECONDS;

pub const BUS_STOP_COST: i32 = 2_000;
pub const METRO_STATION_COST: i32 = 25_000;
pub const BUS_COST: i32 = 8_000;
pub const METRO_COST: i32 = 50_000;
pub const ROAD_COST: i32 = 100;
pub const TRACK_COST: i32 = 500;
pub const BUS_TILES_PER_SECOND: f64 = 0.8;
pub const METRO_TILES_PER_SECOND: f64 = 1.6;

/// Tolerance for stop-boundary comparisons. A substep scheduled via
/// [`seconds_until_next_vehicle_stop`] to land exactly on the next stop can, via
/// floating-point round-off, compute a progress of `0.9999999999999999` or
/// `1.0000000000000002` instead of `1.0`. Comparisons against `1.0` use this
/// epsilon so proximity is treated as a stop arrival and the carried progress
/// on the next segment is clamped to zero (see [`tick_vehicles`] and
/// [`disembark_vehicle`]); legitimate overshoot (≥ `EPSILON` of a segment) is
/// preserved.
const EPSILON: f64 = 0.000_001;

pub fn lay_road(state: &GameSnapshot, point: &Point) -> Result<GameSnapshot, String> {
    if state.budget < ROAD_COST {
        return Err("insufficient budget".to_string());
    }
    if !is_valid_road_placement(state, point) {
        return Err("invalid road placement".to_string());
    }

    let mut next = state.clone();
    next.budget -= ROAD_COST;
    set_tile_kind(&mut next.map, point, "road");
    Ok(recompute_route_paths(&next))
}

pub fn lay_track(state: &GameSnapshot, point: &Point) -> Result<GameSnapshot, String> {
    if state.budget < TRACK_COST {
        return Err("insufficient budget".to_string());
    }
    if !is_valid_track_placement(state, point) {
        return Err("invalid track placement".to_string());
    }

    let mut next = state.clone();
    next.budget -= TRACK_COST;
    set_tile_track(&mut next.map, point, true);
    Ok(recompute_route_paths(&next))
}

pub fn lay_road_line(
    state: &GameSnapshot,
    points: &[Point],
    preset: RoadPreset,
) -> Result<GameSnapshot, String> {
    if points.is_empty() {
        return Err("empty road line".to_string());
    }

    // OneWay follows the drag direction (start→current) so the arrow points the
    // way the player dragged. DualBidirectional instead uses a canonical axis
    // direction (east for horizontal, south for vertical) so the reverse
    // carriageway always lands on the same physical side of the corridor
    // regardless of drag order — otherwise dragging start→current vs
    // current→start would flip the second carriageway to opposite sides.
    let forward = line_direction(points);
    let dual_direction = canonical_line_direction(points);
    let mut next = state.clone();
    let mut changed = false;

    for point in points {
        let direction = match preset {
            RoadPreset::TwoWay => None,
            RoadPreset::OneWay => forward,
            RoadPreset::DualBidirectional => dual_direction,
        };
        changed |= lay_lane(&mut next, state, point, direction);
    }

    if preset == RoadPreset::DualBidirectional {
        if let Some(canonical) = dual_direction {
            let reverse_direction = opposite_direction(canonical);
            for point in reverse_lane_points(points, canonical) {
                changed |= lay_reverse_lane(&mut next, state, &point, reverse_direction);
            }
        }
    }

    if !changed {
        return Err("road line unchanged".to_string());
    }
    Ok(recompute_route_paths(&next))
}

pub fn lay_track_line(state: &GameSnapshot, points: &[Point]) -> Result<GameSnapshot, String> {
    if points.is_empty() {
        return Err("empty track line".to_string());
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
        return Err("track line unchanged".to_string());
    }
    Ok(recompute_route_paths(&next))
}

pub fn remove_at_tiles(state: &GameSnapshot, points: &[Point]) -> Result<GameSnapshot, String> {
    if points.is_empty() {
        return Err("empty remove line".to_string());
    }

    let mut next = state.clone();
    let mut changed = false;
    for point in points {
        if let Ok(candidate) = remove_at_tile(&next, point) {
            if candidate != next {
                next = candidate;
                changed = true;
            }
        }
    }

    if !changed {
        return Err("remove line unchanged".to_string());
    }
    Ok(next)
}

pub fn remove_at_tile(state: &GameSnapshot, point: &Point) -> Result<GameSnapshot, String> {
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
            if stop.position == *point {
                removed_stop_ids.insert(stop.id.clone());
            }
        }
        for station in &state.transit.stations {
            if station.position == *point {
                removed_station_ids.insert(station.id.clone());
            }
        }
    }

    let removed_route_ids: Vec<String> = state
        .transit
        .routes
        .iter()
        .filter(|route| {
            route
                .stop_ids
                .iter()
                .any(|stop_id| removed_stop_ids.contains(stop_id))
        })
        .map(|route| route.id.clone())
        .collect();
    let removed_line_ids: Vec<String> = state
        .transit
        .metro_lines
        .iter()
        .filter(|line| {
            line.station_ids
                .iter()
                .any(|station_id| removed_station_ids.contains(station_id))
        })
        .map(|line| line.id.clone())
        .collect();

    if removed_building.is_none() && removed_stop_ids.is_empty() && removed_station_ids.is_empty() {
        return remove_infrastructure_at_tile(state, point);
    }

    let mut next = state.clone();
    if let Some(building) = removed_building {
        next.buildings
            .retain(|candidate| candidate.id != building.id);
    }
    cleanup_removed_destination_references(&mut next, &removed_destination_tiles);
    next.transit
        .stops
        .retain(|stop| !removed_stop_ids.contains(&stop.id));
    next.transit
        .stations
        .retain(|station| !removed_station_ids.contains(&station.id));

    for route_id in removed_route_ids {
        next = delete_route(&next, &route_id)?;
    }
    for line_id in removed_line_ids {
        next = delete_route(&next, &line_id)?;
    }

    Ok(next)
}

pub fn add_bus_stop(state: &GameSnapshot, point: &Point) -> Result<GameSnapshot, String> {
    // `AddBusStop` is the lightweight road-tile bus stop path. Bus terminals
    // are multi-platform buildings with their own cost (12,000) and 3x2
    // footprint validation, placed via `PlaceBuilding` -> `place_building`.
    if state.budget < BUS_STOP_COST {
        return Err("insufficient budget".to_string());
    }
    if !is_valid_bus_stop_placement(state, point) {
        return Err("invalid bus stop placement".to_string());
    }

    let mut next = state.clone();
    let stop_id = next_entity_id(
        "stop",
        next.transit.stops.iter().map(|stop| stop.id.clone()),
    );
    next.budget -= BUS_STOP_COST;
    next.transit.stops.push(crate::model::Stop {
        id: stop_id.clone(),
        kind: "busStop".to_string(),
        position: point.clone(),
        platforms: bus_platforms(&stop_id, "busStop"),
    });

    Ok(next)
}

pub fn add_metro_station(state: &GameSnapshot, point: &Point) -> Result<GameSnapshot, String> {
    if state.budget < METRO_STATION_COST {
        return Err("insufficient budget".to_string());
    }
    if !is_valid_metro_station_placement(state, point) {
        return Err("invalid metro station placement".to_string());
    }

    let mut next = state.clone();
    let station_id = next_entity_id(
        "station",
        next.transit
            .stations
            .iter()
            .map(|station| station.id.clone()),
    );
    next.budget -= METRO_STATION_COST;
    next.transit.stations.push(crate::model::Station {
        id: station_id.clone(),
        position: point.clone(),
        platforms: metro_platforms(&station_id),
    });

    Ok(next)
}

pub fn add_bus_route(state: &GameSnapshot, stop_ids: Vec<String>) -> Result<GameSnapshot, String> {
    let mut next = state.clone();
    let route_id = next_entity_id(
        "route",
        next.transit.routes.iter().map(|route| route.id.clone()),
    );
    let route_number = entity_number_from_id("route", &route_id);
    let distinct_stop_ids = distinct_ids(&stop_ids);
    let active = distinct_valid_stop_count(state, &stop_ids) >= 2;
    let stop_position_by_id: HashMap<String, Point> = state
        .transit
        .stops
        .iter()
        .map(|stop| (stop.id.clone(), stop.position.clone()))
        .collect();
    let (_, segments, ids_missing) = resolve_line_segments(
        &state.map,
        &stop_ids,
        &stop_position_by_id,
        TransitMode::Bus,
    );

    if active {
        next.transit.stops =
            assign_route_to_least_loaded(&next.transit.stops, &distinct_stop_ids, &route_id);
    }

    next.transit.routes.push(Route {
        id: route_id,
        name: format!("Bus {route_number}"),
        color: "#e04f39".to_string(),
        stop_ids,
        vehicle_ids: Vec::new(),
        active,
        path_broken: ids_missing || has_broken_segment(&segments),
        segments,
    });

    Ok(next)
}

pub fn add_metro_line(
    state: &GameSnapshot,
    station_ids: Vec<String>,
) -> Result<GameSnapshot, String> {
    let mut next = state.clone();
    let line_id = next_entity_id(
        "metro",
        next.transit.metro_lines.iter().map(|line| line.id.clone()),
    );
    let line_number = entity_number_from_id("metro", &line_id);
    let distinct_station_ids = distinct_ids(&station_ids);
    let active = distinct_valid_station_count(state, &station_ids) >= 2;
    let station_position_by_id: HashMap<String, Point> = state
        .transit
        .stations
        .iter()
        .map(|station| (station.id.clone(), station.position.clone()))
        .collect();
    let (_, segments, ids_missing) = resolve_line_segments(
        &state.map,
        &station_ids,
        &station_position_by_id,
        TransitMode::Metro,
    );

    if active {
        next.transit.stations =
            assign_route_to_least_loaded(&next.transit.stations, &distinct_station_ids, &line_id);
    }

    next.transit.metro_lines.push(MetroLine {
        id: line_id,
        name: format!("Metro {line_number}"),
        color: "#2867b2".to_string(),
        station_ids,
        vehicle_ids: Vec::new(),
        active,
        path_broken: ids_missing || has_broken_segment(&segments),
        segments,
    });

    Ok(next)
}

pub fn assign_vehicle(
    state: &GameSnapshot,
    mode: &str,
    line_id: &str,
) -> Result<GameSnapshot, String> {
    // `mode` arrives as a string from `GameIntent::AssignVehicle`; validate and lift it to
    // the typed enum once at this boundary so everything downstream is compiler-checked.
    let transit_mode = match mode {
        "bus" => TransitMode::Bus,
        "metro" => TransitMode::Metro,
        _ => return Err(format!("unknown mode: {mode}")),
    };
    let cost = if transit_mode == TransitMode::Bus {
        BUS_COST
    } else {
        METRO_COST
    };
    if state.budget < cost {
        return Err("insufficient budget".to_string());
    }

    let vehicle = Vehicle {
        id: next_entity_id(
            "vehicle",
            state
                .transit
                .vehicles
                .iter()
                .map(|vehicle| vehicle.id.clone()),
        ),
        mode: transit_mode,
        line_id: line_id.to_string(),
        capacity: if transit_mode == TransitMode::Bus {
            18
        } else {
            90
        },
        passenger_ids: Vec::new(),
        segment_index: 0,
        progress: 0.0,
    };
    let mut next = state.clone();

    if transit_mode == TransitMode::Bus {
        let Some(route) = next
            .transit
            .routes
            .iter_mut()
            .find(|route| route.id == line_id)
        else {
            return Err(format!("line not found: {line_id}"));
        };
        if !route.active {
            return Err(format!("line inactive: {line_id}"));
        }
        if route.path_broken {
            return Err(format!("line path broken: {line_id}"));
        }
        route.vehicle_ids.push(vehicle.id.clone());
    } else {
        let Some(line) = next
            .transit
            .metro_lines
            .iter_mut()
            .find(|line| line.id == line_id)
        else {
            return Err(format!("line not found: {line_id}"));
        };
        if !line.active {
            return Err(format!("line inactive: {line_id}"));
        }
        if line.path_broken {
            return Err(format!("line path broken: {line_id}"));
        }
        line.vehicle_ids.push(vehicle.id.clone());
    }

    next.budget -= cost;
    next.transit.vehicles.push(vehicle);
    Ok(next)
}

/// Advance every vehicle along its assigned line, boarding/disembarking passengers.
///
/// Intentional divergence from the TS oracle: when no vehicle actually moved on a
/// substep (e.g. a zero-delta substep), this returns the unchanged snapshot via the
/// `changed` flag instead of always emitting a new state. This is the engine's
/// "commit only when changed" discipline and is a deliberate "more correct" choice;
/// a WASM/Tauri consumer must not assume `tick_vehicles` yields a fresh allocation
/// every call.
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

    for vehicle in &state.transit.vehicles {
        let Some((line_positions, segments)) = assigned_line_data(state, vehicle) else {
            vehicles.push(vehicle.clone());
            continue;
        };
        if line_positions.len() < 2 {
            vehicles.push(vehicle.clone());
            continue;
        }

        let current_position = &line_positions[vehicle.segment_index % line_positions.len()];
        let waiter_order = waiter_order_lookup
            .get(&format!(
                "{}|{}",
                position_key(current_position.x, current_position.y),
                vehicle.line_id
            ))
            .cloned()
            .unwrap_or_default();
        let mut next_vehicle = if vehicle.progress == 0.0 {
            board_vehicle(
                &mut active_trips,
                vehicle,
                current_position,
                &mut occupied_passenger_ids,
                &on_platform,
                &waiter_order,
                &mut changed,
            )
        } else {
            vehicle.clone()
        };

        let segment = segments.get(vehicle.segment_index % segments.len().max(1));
        let steps = segment.map_or(1, |segment| segment.len().saturating_sub(1).max(1));
        let progress = next_vehicle.progress
            + (tiles_per_second(next_vehicle.mode) * delta_seconds) / steps as f64;

        // FP guard: a substep scheduled to land on the next stop (via
        // `seconds_until_next_vehicle_stop`) should reach it exactly, but
        // rounded arithmetic can leave `progress` a hair under 1.0. A strict
        // `< 1.0` check would keep the vehicle on the old segment, and the
        // next-stop boundary (a hair after `state.time`) would be skipped by
        // `track_next_boundary` (it filters candidates `<= state.time +
        // EPSILON`), delaying the arrival until some later substep. Treat
        // proximity within `EPSILON` as a stop arrival. Legitimate partial
        // progress (`< 1.0 - EPSILON`) still stays on the segment.
        if progress < 1.0 - EPSILON {
            if progress != next_vehicle.progress {
                changed = true;
            }
            next_vehicle.progress = progress;
            vehicles.push(next_vehicle);
            continue;
        }

        let reached_position = &line_positions[(vehicle.segment_index + 1) % line_positions.len()];
        let next_segment = segments.get((vehicle.segment_index + 1) % segments.len().max(1));
        let next_steps = next_segment.map_or(1, |segment| segment.len().saturating_sub(1).max(1));
        next_vehicle.progress = progress;
        next_vehicle = disembark_vehicle(
            &mut active_trips,
            &next_vehicle,
            reached_position,
            line_positions.len(),
            steps,
            next_steps,
        );
        changed = true;
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
    let (line_positions, segments) = assigned_line_data(state, vehicle)?;
    if line_positions.len() < 2 {
        return None;
    }

    let segment = segments.get(vehicle.segment_index % segments.len().max(1));
    let steps = segment.map_or(1, |segment| segment.len().saturating_sub(1).max(1));
    let remaining_progress = (1.0 - vehicle.progress).max(0.0);
    Some((remaining_progress * steps as f64) / tiles_per_second(vehicle.mode))
}

pub fn cycle_road_direction(state: &GameSnapshot, point: &Point) -> Result<GameSnapshot, String> {
    let Some(tile) = get_tile(&state.map, point) else {
        return Err("tile not found".to_string());
    };
    if tile.kind != "road" {
        return Err("tile is not road".to_string());
    }

    let mut next = state.clone();
    let next_direction = match tile.one_way.as_deref() {
        None => Some("north"),
        Some("north") => Some("east"),
        Some("east") => Some("south"),
        Some("south") => Some("west"),
        Some("west") => None,
        Some(_) => Some("north"),
    };
    set_tile_one_way(&mut next.map, point, next_direction);
    Ok(recompute_route_paths(&next))
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
) -> Result<GameSnapshot, String> {
    let mut next = state.clone();
    if let Some(route) = next
        .transit
        .routes
        .iter_mut()
        .find(|route| route.id == route_id)
    {
        if route.active == active {
            return Err("unchanged".to_string());
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
            return Err("unchanged".to_string());
        }
        line.active = active;
        return Ok(next);
    }
    Err(format!("line not found: {route_id}"))
}

pub fn rename_route(
    state: &GameSnapshot,
    route_id: &str,
    name: &str,
) -> Result<GameSnapshot, String> {
    let mut next = state.clone();
    if let Some(route) = next
        .transit
        .routes
        .iter_mut()
        .find(|route| route.id == route_id)
    {
        let final_name = final_route_name("bus", route_id, name);
        if route.name == final_name {
            return Err("unchanged".to_string());
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
            return Err("unchanged".to_string());
        }
        line.name = final_name;
        return Ok(next);
    }
    Err(format!("line not found: {route_id}"))
}

pub fn recolor_route(
    state: &GameSnapshot,
    route_id: &str,
    color: &str,
) -> Result<GameSnapshot, String> {
    let mut next = state.clone();
    if let Some(route) = next
        .transit
        .routes
        .iter_mut()
        .find(|route| route.id == route_id)
    {
        if route.color == color {
            return Err("unchanged".to_string());
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
            return Err("unchanged".to_string());
        }
        line.color = color.to_string();
        return Ok(next);
    }
    Err(format!("line not found: {route_id}"))
}

pub fn delete_route(state: &GameSnapshot, route_id: &str) -> Result<GameSnapshot, String> {
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
        return Err(format!("line not found: {route_id}"));
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
    Ok(next)
}

pub fn assign_route_to_platform(
    state: &GameSnapshot,
    node_id: &str,
    route_id: &str,
    platform_id: &str,
) -> Result<GameSnapshot, String> {
    let mut next = state.clone();
    if reassign_within_node(&mut next.transit.stops, node_id, route_id, platform_id) {
        return Ok(next);
    }
    if reassign_within_node(&mut next.transit.stations, node_id, route_id, platform_id) {
        return Ok(next);
    }
    Err("platform assignment unchanged".to_string())
}

pub fn recompute_route_paths(state: &GameSnapshot) -> GameSnapshot {
    let stop_position_by_id: HashMap<String, Point> = state
        .transit
        .stops
        .iter()
        .map(|stop| (stop.id.clone(), stop.position.clone()))
        .collect();
    let station_position_by_id: HashMap<String, Point> = state
        .transit
        .stations
        .iter()
        .map(|station| (station.id.clone(), station.position.clone()))
        .collect();
    let mut next = state.clone();

    for route_index in 0..next.transit.routes.len() {
        let route = next.transit.routes[route_index].clone();
        let (positions, segments, ids_missing) = resolve_line_segments(
            &state.map,
            &route.stop_ids,
            &stop_position_by_id,
            TransitMode::Bus,
        );
        let path_broken = ids_missing || has_broken_segment(&segments);
        if path_broken && !route.path_broken {
            park_vehicles_and_invalidate_trips(&mut next, &route.id, &positions);
        }
        next.transit.routes[route_index].segments = segments;
        next.transit.routes[route_index].path_broken = path_broken;
    }

    for line_index in 0..next.transit.metro_lines.len() {
        let line = next.transit.metro_lines[line_index].clone();
        let (positions, segments, ids_missing) = resolve_line_segments(
            &state.map,
            &line.station_ids,
            &station_position_by_id,
            TransitMode::Metro,
        );
        let path_broken = ids_missing || has_broken_segment(&segments);
        if path_broken && !line.path_broken {
            park_vehicles_and_invalidate_trips(&mut next, &line.id, &positions);
        }
        next.transit.metro_lines[line_index].segments = segments;
        next.transit.metro_lines[line_index].path_broken = path_broken;
    }

    next
}

pub fn stop_coverage_radius(kind: &str) -> u8 {
    if kind == "busTerminal" {
        4
    } else {
        2
    }
}

fn remove_infrastructure_at_tile(
    state: &GameSnapshot,
    point: &Point,
) -> Result<GameSnapshot, String> {
    let Some(tile) = get_tile(&state.map, point) else {
        return Err("tile not found".to_string());
    };

    let mut next = state.clone();
    if tile.has_track {
        set_tile_track(&mut next.map, point, false);
        return Ok(recompute_route_paths(&next));
    }
    if tile.kind == "road" {
        set_tile_kind(&mut next.map, point, "empty");
        return Ok(recompute_route_paths(&next));
    }
    Err("nothing to remove".to_string())
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
        .filter_map(|sim| {
            sim.workplace
                .clone()
                .map(|workplace| (sim.id.clone(), workplace))
        })
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

fn resolve_line_segments(
    map: &GameMap,
    ids: &[String],
    position_by_id: &HashMap<String, Point>,
    mode: TransitMode,
) -> (Vec<Point>, Vec<Vec<Point>>, bool) {
    let positions: Vec<Point> = ids
        .iter()
        .filter_map(|id| position_by_id.get(id).cloned())
        .collect();
    let ids_missing = positions.len() != ids.len();
    let segments = if ids_missing {
        Vec::new()
    } else {
        compute_route_segments(map, &positions, mode)
    };
    (positions, segments, ids_missing)
}

fn distinct_valid_stop_count(state: &GameSnapshot, stop_ids: &[String]) -> usize {
    let existing_stop_ids: HashSet<&str> = state
        .transit
        .stops
        .iter()
        .map(|stop| stop.id.as_str())
        .collect();
    stop_ids
        .iter()
        .filter(|stop_id| existing_stop_ids.contains(stop_id.as_str()))
        .collect::<HashSet<_>>()
        .len()
}

fn distinct_valid_station_count(state: &GameSnapshot, station_ids: &[String]) -> usize {
    let existing_station_ids: HashSet<&str> = state
        .transit
        .stations
        .iter()
        .map(|station| station.id.as_str())
        .collect();
    station_ids
        .iter()
        .filter(|station_id| existing_station_ids.contains(station_id.as_str()))
        .collect::<HashSet<_>>()
        .len()
}

fn distinct_ids(ids: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut distinct = Vec::new();
    for id in ids {
        if seen.insert(id.clone()) {
            distinct.push(id.clone());
        }
    }
    distinct
}

fn assign_route_to_least_loaded<T>(nodes: &[T], node_ids: &[String], route_id: &str) -> Vec<T>
where
    T: Clone + PlatformNode,
{
    let target_ids: HashSet<&str> = node_ids.iter().map(String::as_str).collect();
    nodes
        .iter()
        .cloned()
        .map(|mut node| {
            if !target_ids.contains(node.id()) || node.platforms().is_empty() {
                return node;
            }
            let best_index = node
                .platforms()
                .iter()
                .enumerate()
                .min_by_key(|(_, platform)| platform.route_ids.len())
                .map(|(index, _)| index)
                .unwrap_or(0);
            node.platforms_mut()[best_index]
                .route_ids
                .push(route_id.to_string());
            node
        })
        .collect()
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

fn park_vehicles_and_invalidate_trips(
    state: &mut GameSnapshot,
    line_id: &str,
    positions: &[Point],
) {
    let mut parked_position_by_trip_id = HashMap::new();

    for vehicle in &mut state.transit.vehicles {
        if vehicle.line_id != line_id {
            continue;
        }
        if !positions.is_empty() {
            let parked_at = &positions[vehicle.segment_index % positions.len()];
            for passenger_id in &vehicle.passenger_ids {
                parked_position_by_trip_id.insert(passenger_id.clone(), parked_at.clone());
            }
        }
        vehicle.passenger_ids.clear();
        vehicle.progress = 0.0;
    }

    invalidate_trips_for_line(
        &mut state.active_trips,
        &mut state.transit.vehicles,
        line_id,
        &parked_position_by_trip_id,
    );
}

fn invalidate_trips_for_line(
    active_trips: &mut [ActiveTrip],
    vehicles: &mut [Vehicle],
    line_id: &str,
    parked_position_by_trip_id: &HashMap<String, Point>,
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
            trip.position = parked_at.clone().into();
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

fn assigned_line_data(
    state: &GameSnapshot,
    vehicle: &Vehicle,
) -> Option<(Vec<Point>, Vec<Vec<Point>>)> {
    if vehicle.mode == TransitMode::Bus {
        let route = state
            .transit
            .routes
            .iter()
            .find(|candidate| candidate.id == vehicle.line_id)?;
        if !route.active || route.path_broken {
            return None;
        }
        let stop_by_id: HashMap<&str, &Point> = state
            .transit
            .stops
            .iter()
            .map(|stop| (stop.id.as_str(), &stop.position))
            .collect();
        let positions: Option<Vec<Point>> = route
            .stop_ids
            .iter()
            .map(|stop_id| {
                stop_by_id
                    .get(stop_id.as_str())
                    .map(|point| (*point).clone())
            })
            .collect();
        return positions.map(|positions| (positions, route.segments.clone()));
    }

    let line = state
        .transit
        .metro_lines
        .iter()
        .find(|candidate| candidate.id == vehicle.line_id)?;
    if !line.active || line.path_broken {
        return None;
    }
    let station_by_id: HashMap<&str, &Point> = state
        .transit
        .stations
        .iter()
        .map(|station| (station.id.as_str(), &station.position))
        .collect();
    let positions: Option<Vec<Point>> = line
        .station_ids
        .iter()
        .map(|station_id| {
            station_by_id
                .get(station_id.as_str())
                .map(|point| (*point).clone())
        })
        .collect();
    positions.map(|positions| (positions, line.segments.clone()))
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
    reached_position: &Point,
    stop_count: usize,
    current_steps: usize,
    next_steps: usize,
) -> Vehicle {
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
                            && leg.to == *reached_position
                    })
        })
        .map(|trip| trip.id.clone())
        .collect();

    for trip in active_trips {
        if disembarking_ids.contains(&trip.id) {
            trip.position = reached_position.clone().into();
            trip.status = TripStatus::Walking;
            trip.current_leg_index += 1;
        }
    }

    let mut next = vehicle.clone();
    next.passenger_ids = passenger_ids
        .into_iter()
        .filter(|passenger_id| !disembarking_ids.contains(passenger_id))
        .collect();
    next.segment_index = (vehicle.segment_index + 1) % stop_count;
    next.progress = if next_steps > 0 {
        // Convert overshoot from the current segment's units to the next
        // segment's units so the carried distance (in tiles) is preserved
        // across segments of different lengths. FP round-off at the stop
        // boundary can leave `vehicle.progress` a hair above or below 1.0;
        // clamp a sub-`EPSILON` carryover to 0.0 so the vehicle is ready to
        // board at the stop (boarding fires only when `progress == 0.0`).
        // Legitimate overshoot (≥ `EPSILON` of a segment) is preserved.
        let carried = ((vehicle.progress - 1.0) * current_steps as f64) / next_steps as f64;
        let carried = if carried.abs() < EPSILON {
            0.0
        } else {
            carried
        };
        // A vehicle that just reached a stop cannot be "behind" it; drop any
        // negative residual so the next boarding (which fires only when
        // `progress == 0.0`) is not blocked. Legitimate overshoot is positive
        // and preserved.
        carried.max(0.0)
    } else {
        0.0
    };
    next
}

fn trip_can_board(
    trip: &ActiveTrip,
    vehicle: &Vehicle,
    current_position: &Point,
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
                && trip_position_matches_point(&trip.position, current_position)
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
        tile.kind == "road"
            && !tile.has_track
            && !is_building_occupied(state, point)
            && !state
                .transit
                .stops
                .iter()
                .any(|stop| stop.position == *point)
    })
}

fn is_valid_metro_station_placement(state: &GameSnapshot, point: &Point) -> bool {
    get_tile(&state.map, point).is_some_and(|tile| {
        (tile.kind == "road" || tile.kind == "empty")
            && tile.has_track
            && !is_building_occupied(state, point)
            && !state
                .transit
                .stations
                .iter()
                .any(|station| station.position == *point)
    })
}

fn line_direction(points: &[Point]) -> Option<&'static str> {
    if points.len() < 2 {
        return None;
    }
    let dx = points[1].x - points[0].x;
    let dy = points[1].y - points[0].y;
    if dx > 0 {
        Some("east")
    } else if dx < 0 {
        Some("west")
    } else if dy > 0 {
        Some("south")
    } else if dy < 0 {
        Some("north")
    } else {
        None
    }
}

/// Drag-order-independent axis direction: horizontal lines are "east", vertical
/// lines are "south". Used by `DualBidirectional` so the reverse carriageway is
/// offset to a consistent physical side for the same corridor whether the drag
/// runs start→current or current→start.
fn canonical_line_direction(points: &[Point]) -> Option<&'static str> {
    if points.len() < 2 {
        return None;
    }
    let dx = points[1].x - points[0].x;
    let dy = points[1].y - points[0].y;
    if dx != 0 {
        Some("east")
    } else if dy != 0 {
        Some("south")
    } else {
        None
    }
}

fn opposite_direction(direction: &str) -> &'static str {
    match direction {
        "north" => "south",
        "east" => "west",
        "south" => "north",
        "west" => "east",
        _ => "north",
    }
}

fn left_of_direction(direction: &str) -> (i32, i32) {
    match direction {
        "north" => (-1, 0),
        "east" => (0, -1),
        "south" => (1, 0),
        "west" => (0, 1),
        _ => (0, 0),
    }
}

fn reverse_lane_points(points: &[Point], direction: &str) -> Vec<Point> {
    let (offset_x, offset_y) = left_of_direction(direction);
    points
        .iter()
        .map(|point| Point {
            x: point.x + offset_x,
            y: point.y + offset_y,
        })
        .collect()
}

fn is_valid_road_placement(state: &GameSnapshot, point: &Point) -> bool {
    get_tile(&state.map, point).is_some_and(|tile| {
        tile.kind == "empty"
            && !is_building_occupied(state, point)
            && !is_transit_node_at(state, point)
    })
}

fn is_valid_track_placement(state: &GameSnapshot, point: &Point) -> bool {
    get_tile(&state.map, point).is_some_and(|tile| {
        (tile.kind == "empty" || tile.kind == "road")
            && !tile.has_track
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
        .any(|stop| stop.position == *point)
        || state
            .transit
            .stations
            .iter()
            .any(|station| station.position == *point)
}

fn lay_lane(
    next: &mut GameSnapshot,
    original: &GameSnapshot,
    point: &Point,
    direction: Option<&str>,
) -> bool {
    let existing = get_tile(&next.map, point).cloned();
    if existing.as_ref().is_some_and(|tile| tile.kind == "road") {
        if existing.and_then(|tile| tile.one_way) != direction.map(str::to_string) {
            set_tile_one_way(&mut next.map, point, direction);
            return true;
        }
        return false;
    }

    if next.budget < ROAD_COST || !is_valid_road_placement(original, point) {
        return false;
    }
    next.budget -= ROAD_COST;
    set_tile_kind(&mut next.map, point, "road");
    set_tile_one_way(&mut next.map, point, direction);
    true
}

fn lay_reverse_lane(
    next: &mut GameSnapshot,
    original: &GameSnapshot,
    point: &Point,
    direction: &str,
) -> bool {
    if get_tile(&next.map, point).is_some_and(|tile| tile.kind != "empty") {
        return false;
    }
    if next.budget < ROAD_COST || !is_valid_road_placement(original, point) {
        return false;
    }
    next.budget -= ROAD_COST;
    set_tile_kind(&mut next.map, point, "road");
    set_tile_one_way(&mut next.map, point, Some(direction));
    true
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

fn set_tile_kind(map: &mut GameMap, point: &Point, kind: &str) {
    if let Some(tile) = get_tile_mut(map, point) {
        tile.kind = kind.to_string();
        if kind != "road" {
            tile.one_way = None;
        }
    }
}

fn set_tile_track(map: &mut GameMap, point: &Point, has_track: bool) {
    if let Some(tile) = get_tile_mut(map, point) {
        tile.has_track = has_track;
    }
}

fn set_tile_one_way(map: &mut GameMap, point: &Point, one_way: Option<&str>) {
    if let Some(tile) = get_tile_mut(map, point) {
        if tile.kind == "road" {
            tile.one_way = one_way.map(str::to_string);
        }
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

fn tiles_per_second(mode: TransitMode) -> f64 {
    if mode == TransitMode::Bus {
        BUS_TILES_PER_SECOND
    } else {
        METRO_TILES_PER_SECOND
    }
}

fn position_key(x: i32, y: i32) -> String {
    format!("{x},{y}")
}

fn point_key(point: &Point) -> String {
    position_key(point.x, point.y)
}
