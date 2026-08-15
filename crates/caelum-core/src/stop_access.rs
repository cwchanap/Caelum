use crate::heading::{canonical_headings, offset_components};
use crate::model::{
    BusStopKind, GameMap, GameSnapshot, Heading, Point, RouteLeg, RouteLegPath, Stop,
    StopRoadAccess, Tile, TransitMode, TripPosition,
};
use crate::road::reciprocal_connection;
use crate::road_topology::{is_road, lane_accepts};
use crate::service_itinerary::service_visits;
use crate::transit_nodes::is_present_node;
use std::collections::{HashMap, HashSet};

fn checked_offset(point: Point, heading: Heading) -> Option<Point> {
    let (dx, dy) = offset_components(heading);
    Some(Point {
        x: point.x.checked_add(dx)?,
        y: point.y.checked_add(dy)?,
    })
}

fn usable_road(map: &GameMap, point: Point) -> bool {
    map.tile(point).is_some_and(|tile| {
        is_road(map, point)
            && tile.road_structure_id.is_none()
            && canonical_headings().into_iter().any(|heading| {
                lane_accepts(tile.one_way, heading) && reciprocal_connection(map, point, heading)
            })
    })
}

pub(crate) fn derive_stop_access(map: &GameMap, anchor: Point) -> Option<StopRoadAccess> {
    derive_stop_access_for_footprint(map, &[anchor])
}

fn preferred_heading_for_tile(tile: &Tile) -> Option<Heading> {
    canonical_headings()
        .into_iter()
        .find(|heading| {
            lane_accepts(tile.one_way, *heading) && tile.road_connections.contains(heading)
        })
        .or_else(|| {
            canonical_headings()
                .into_iter()
                .find(|heading| lane_accepts(tile.one_way, *heading))
        })
}

pub(crate) fn derive_stop_access_for_footprint(
    map: &GameMap,
    footprint: &[Point],
) -> Option<StopRoadAccess> {
    let road_point = footprint
        .iter()
        .flat_map(|point| {
            canonical_headings()
                .into_iter()
                .filter_map(|heading| checked_offset(*point, heading))
        })
        .find(|point| usable_road(map, *point))?;
    let tile = map.tile(road_point)?;
    Some(StopRoadAccess {
        road_point,
        preferred_heading: preferred_heading_for_tile(tile),
    })
}

pub(crate) fn stop_footprint(snapshot: &GameSnapshot, stop: &Stop) -> Vec<Point> {
    snapshot
        .buildings
        .iter()
        .find(|building| building.transit_node_id.as_deref() == Some(stop.id.as_str()))
        .map_or_else(
            || vec![stop.position],
            |building| building.occupied_tiles.clone(),
        )
}

pub(crate) fn is_valid_access(map: &GameMap, footprint: &[Point], access: StopRoadAccess) -> bool {
    let adjacent_to_footprint = footprint.iter().any(|point| {
        canonical_headings()
            .into_iter()
            .any(|heading| checked_offset(*point, heading) == Some(access.road_point))
    });
    let legacy_on_road_fallback = footprint.len() == 1
        && footprint[0] == access.road_point
        && map.tile(access.road_point).is_some_and(|tile| {
            is_road(map, access.road_point) && tile.road_structure_id.is_none()
        });

    usable_road(map, access.road_point) && (adjacent_to_footprint || legacy_on_road_fallback)
}

pub(crate) fn resolve_stop_access(
    snapshot: &GameSnapshot,
    stop_id: &str,
) -> Option<StopRoadAccess> {
    let stop = snapshot
        .transit
        .stops
        .iter()
        .find(|stop| stop.id == stop_id && is_present_node(stop.status))?;
    let footprint = stop_footprint(snapshot, stop);
    match stop.road_access {
        Some(access) if is_valid_access(&snapshot.map, &footprint, access) => Some(access),
        _ => derive_stop_access_for_footprint(&snapshot.map, &footprint),
    }
}

#[derive(Clone, Debug)]
struct StopMove {
    stop_id: String,
    old_position: Point,
    new_position: Point,
    road_point: Point,
}

/// Check whether any present stop's road-access situation could have changed
/// between `previous_map` and the candidate snapshot. Returns `false` when
/// `normalize_snapshot_stops` would be a no-op, allowing the engine to skip
/// the O(stops × footprint) normalization + rebase pass on map edits that
/// don't touch any stop's neighbourhood.
///
/// This checks two things per present stop:
/// 1. The tile at the stop's `road_access.road_point` (if any) — if it changed,
///    the existing access may be invalid and need re-derivation.
/// 2. The tile at every footprint cell and its four neighbours — if any
///    changed, the legacy on-road detection (`tile.kind == "road"` at the
///    stop origin), the legacy migration's free-anchor search, or the
///    footprint-wide `derive_stop_access_for_footprint` scan may produce a
///    different result.
///
/// The footprint scan is required for bus terminals: their road access is
/// derived from any road tile adjacent to *any* occupied footprint cell, not
/// only the terminal origin. When a terminal's `road_access` is already
/// `None` (e.g. after its access road was demolished), check #1 is vacuous,
/// and a replacement road laid beside a non-origin footprint cell would be
/// missed by an origin-only neighbourhood scan — leaving the authoritative
/// `road_access` field stale until a later full normalisation or reload.
pub(crate) fn stops_access_affected(previous_map: &GameMap, candidate: &GameSnapshot) -> bool {
    for stop in &candidate.transit.stops {
        if !is_present_node(stop.status) {
            continue;
        }
        if let Some(access) = &stop.road_access {
            if previous_map.tile(access.road_point) != candidate.map.tile(access.road_point) {
                return true;
            }
        }
        let footprint = stop_footprint(candidate, stop);
        for footprint_tile in &footprint {
            if previous_map.tile(*footprint_tile) != candidate.map.tile(*footprint_tile) {
                return true;
            }
            for heading in canonical_headings() {
                if let Some(adjacent) = checked_offset(*footprint_tile, heading) {
                    if previous_map.tile(adjacent) != candidate.map.tile(adjacent) {
                        return true;
                    }
                }
            }
        }
    }
    false
}

pub(crate) fn normalize_snapshot_stops(mut snapshot: GameSnapshot) -> GameSnapshot {
    let mut stop_indexes: Vec<usize> = snapshot
        .transit
        .stops
        .iter()
        .enumerate()
        .filter_map(|(index, stop)| is_present_node(stop.status).then_some(index))
        .collect();
    stop_indexes.sort_by(|left, right| {
        snapshot.transit.stops[*left]
            .id
            .cmp(&snapshot.transit.stops[*right].id)
            .then_with(|| left.cmp(right))
    });

    let old_road_points: HashMap<String, Point> = snapshot
        .transit
        .stops
        .iter()
        .filter(|stop| is_present_node(stop.status))
        .filter_map(|stop| {
            if let Some(access) = stop.road_access.as_ref() {
                return Some((stop.id.clone(), access.road_point));
            }
            // Legacy on-road stops have no `road_access`, but their position
            // IS the road point. Record it so `rebase_parked_bus_positions`
            // can identify buses parked at the original on-road coordinate
            // after the stop migrates to a roadside anchor.
            if stop.kind == BusStopKind::BusStop
                && snapshot
                    .map
                    .tile(stop.position)
                    .is_some_and(|tile| tile.kind == "road")
            {
                return Some((stop.id.clone(), stop.position));
            }
            None
        })
        .collect();

    // Capture every present stop's ORIGINAL position before the migration loop
    // below mutates `Stop.position`. `rebase_active_trips` runs after every
    // legacy stop has moved, so its ambiguity check must consult these
    // original positions (not the already-mutated snapshot) to correctly count
    // co-located stops at a moved coordinate.
    let original_stop_positions: HashMap<String, Point> = snapshot
        .transit
        .stops
        .iter()
        .filter(|stop| is_present_node(stop.status))
        .map(|stop| (stop.id.clone(), stop.position))
        .collect();

    let mut moves = Vec::new();
    for stop_index in stop_indexes {
        let stop = snapshot.transit.stops[stop_index].clone();
        let is_legacy_on_road = stop.kind == BusStopKind::BusStop
            && snapshot
                .map
                .tile(stop.position)
                .is_some_and(|tile| tile.kind == "road");

        if is_legacy_on_road {
            let road_point = stop.position;
            let new_position = canonical_headings()
                .into_iter()
                .filter_map(|heading| checked_offset(stop.position, heading))
                .find(|candidate| is_free_anchor(&snapshot, *candidate));
            let access = access_for_road_point(&snapshot.map, road_point).or_else(|| {
                new_position.and_then(|position| {
                    derive_stop_access_for_footprint(&snapshot.map, &[position])
                })
            });

            if let Some(new_position) = new_position {
                snapshot.transit.stops[stop_index].position = new_position;
                snapshot.transit.stops[stop_index].road_access = access;
                moves.push(StopMove {
                    stop_id: stop.id,
                    old_position: stop.position,
                    new_position,
                    road_point,
                });
            } else {
                snapshot.transit.stops[stop_index].road_access = access;
            }
            continue;
        }

        let current_stop = snapshot.transit.stops[stop_index].clone();
        let footprint = stop_footprint(&snapshot, &current_stop);
        snapshot.transit.stops[stop_index].road_access = match current_stop.road_access {
            Some(access) if is_valid_access(&snapshot.map, &footprint, access) => Some(access),
            _ => derive_stop_access_for_footprint(&snapshot.map, &footprint),
        };
    }

    rebase_parked_bus_positions(&mut snapshot, &old_road_points);
    rebase_active_trips(&mut snapshot, &moves, &original_stop_positions);
    snapshot
}

fn rebase_parked_bus_positions(
    snapshot: &mut GameSnapshot,
    old_road_points: &HashMap<String, Point>,
) {
    let repairs: Vec<(usize, Point)> = snapshot
        .transit
        .vehicles
        .iter()
        .enumerate()
        .filter_map(|(vehicle_index, vehicle)| {
            if vehicle.mode != TransitMode::Bus {
                return None;
            }
            let parked_position = vehicle.parked_position.as_ref()?;
            // Rebase parked vehicles regardless of the route's active flag: a
            // paused route's buses are still parked at a stop whose road access
            // can change via a later road mutation. The active flag controls
            // whether they resume service, not whether their parked position
            // tracks the current access tile.
            let route = snapshot
                .transit
                .routes
                .iter()
                .find(|route| route.id == vehicle.line_id)?;
            // Identify the vehicle's associated stop via its itinerary first,
            // falling back to coordinate matching. Two stops can legally share
            // a road-access tile (e.g. opposite sides of a road); a pure
            // coordinate scan would let the first matching stop capture a bus
            // actually parked for the other. The itinerary index reliably
            // points to the service visit the vehicle was parked at (set by
            // break_service / restore_service / rebase_parked_vehicles).
            let visits = service_visits(&route.stop_ids, &route.legs);
            let itinerary_stop_id = visits
                .iter()
                .find(|visit| visit.departing_itinerary_index == vehicle.itinerary_index)
                .map(|visit| visit.waypoint_id.clone());
            let road_point = itinerary_stop_id
                .as_deref()
                .and_then(|stop_id| {
                    match_stop_access(snapshot, stop_id, parked_position, old_road_points)
                })
                .or_else(|| {
                    // Itinerary resolution failed — most commonly because a
                    // loaded route has empty `legs` (`#[serde(default)]` on
                    // `Route.legs`), so `service_visits` returned an empty
                    // vec and `itinerary_stop_id` is `None`. A `find_map`
                    // would let the first stop whose old or current access
                    // matches the parked coordinate capture a bus actually
                    // parked for another co-located stop — the parked-vehicle
                    // analogue of the null-itinerary passenger ambiguity
                    // handled in `rebase_active_trips`. Collect every match
                    // and only rebase when exactly one stop qualifies;
                    // multiple matches preserve the parked coordinate rather
                    // than guessing, and no matches leave it unchanged.
                    let matches: Vec<Point> = route
                        .stop_ids
                        .iter()
                        .filter_map(|stop_id| {
                            match_stop_access(snapshot, stop_id, parked_position, old_road_points)
                        })
                        .collect();
                    if matches.len() == 1 {
                        matches.into_iter().next()
                    } else {
                        None
                    }
                })?;
            Some((vehicle_index, road_point))
        })
        .collect();

    for (vehicle_index, road_point) in repairs {
        snapshot.transit.vehicles[vehicle_index].parked_position = Some(road_point.into());
    }
}

/// Check whether a stop's current or previous road access matches the vehicle's
/// `parked_position`; if so, return the current access road point so the
/// vehicle can be rebased to it.
fn match_stop_access(
    snapshot: &GameSnapshot,
    stop_id: &str,
    parked_position: &TripPosition,
    old_road_points: &HashMap<String, Point>,
) -> Option<Point> {
    let stop = snapshot
        .transit
        .stops
        .iter()
        .find(|stop| stop.id == stop_id && is_present_node(stop.status))?;
    let access = resolve_stop_access(snapshot, &stop.id)?;
    let passenger_position: TripPosition = stop.position.into();
    let road_position: TripPosition = access.road_point.into();
    let old_road_position = old_road_points
        .get(&stop.id)
        .map(|point| TripPosition::from(*point));
    let matches_current =
        parked_position == &passenger_position || parked_position == &road_position;
    let matches_old = old_road_position
        .as_ref()
        .is_some_and(|old| parked_position == old);
    (matches_current || matches_old).then_some(access.road_point)
}

fn access_for_road_point(map: &GameMap, road_point: Point) -> Option<StopRoadAccess> {
    let tile = map.tile(road_point)?;
    if !usable_road(map, road_point) {
        return None;
    }
    Some(StopRoadAccess {
        road_point,
        preferred_heading: preferred_heading_for_tile(tile),
    })
}

fn is_free_anchor(snapshot: &GameSnapshot, point: Point) -> bool {
    snapshot.map.tile(point).is_some_and(|tile| {
        tile.kind == "empty"
            && !tile.has_track
            && tile.road_structure_id.is_none()
            && !snapshot
                .buildings
                .iter()
                .any(|building| building.occupied_tiles.contains(&point))
            && !snapshot
                .transit
                .stops
                .iter()
                .any(|stop| is_present_node(stop.status) && stop.position == point)
            && !snapshot
                .transit
                .stations
                .iter()
                .any(|station| is_present_node(station.status) && station.position == point)
    })
}

fn rebase_active_trips(
    snapshot: &mut GameSnapshot,
    moves: &[StopMove],
    original_stop_positions: &HashMap<String, Point>,
) {
    for movement in moves {
        debug_assert!(!movement.stop_id.is_empty());
        // Correctness-critical: rebase_active_trips matches waiting passengers
        // by old_position. If road_point != old_position the matching logic
        // silently targets the wrong coordinate, so check in release too.
        assert_eq!(movement.road_point, movement.old_position);
        // Collect route IDs that serve the moved stop so the position update
        // can be gated on the trip actually waiting for a bus at this stop.
        // A co-located metro station (or a second bus stop at the same
        // coordinate) must not capture a passenger waiting for a different
        // service — merely sharing a coordinate is insufficient.
        let routes_serving_stop: Vec<String> = snapshot
            .transit
            .routes
            .iter()
            .filter(|route| route.stop_ids.contains(&movement.stop_id))
            .map(|route| route.id.clone())
            .collect();
        // Build a lookup from route ID → route legs so board/alight itinerary
        // indexes can be resolved to specific waypoint IDs. This distinguishes
        // two co-located stops on the same route: the itinerary index
        // identifies exactly which stop a leg boards/alights at, so only
        // endpoints associated with `movement.stop_id` are rewritten.
        let route_legs_by_id: HashMap<&str, &[RouteLegPath]> = snapshot
            .transit
            .routes
            .iter()
            .map(|route| (route.id.as_str(), route.legs.as_slice()))
            .collect();
        // Routes with more than one stop at the moved coordinate. When
        // itinerary indexes are absent (legacy snapshots), the fallback in
        // `leg_boards_at_stop` / `leg_alights_at_stop` cannot distinguish
        // which co-located stop a leg boards/alights at — guessing would
        // let the first migration move capture a passenger waiting for the
        // other stop. For these ambiguous routes the fallback must refuse to
        // match, leaving the trip untouched rather than risking a misroute.
        //
        // The count MUST use the ORIGINAL stop positions
        // (`original_stop_positions`), captured before
        // `normalize_snapshot_stops` migrated any legacy stops. By the time
        // this runs, every legacy stop has already moved to its roadside
        // anchor, so reading `snapshot.transit.stops` would yield a count of
        // zero at the shared coordinate and wrongly treat the route as
        // unambiguous — letting the first move capture a passenger waiting
        // for the other co-located stop.
        let ambiguous_routes_at_coordinate: HashSet<&str> = snapshot
            .transit
            .routes
            .iter()
            .filter(|route| {
                route
                    .stop_ids
                    .iter()
                    .filter(|stop_id| {
                        original_stop_positions.get(*stop_id) == Some(&movement.old_position)
                    })
                    .count()
                    > 1
            })
            .map(|route| route.id.as_str())
            .collect();
        for trip in &mut snapshot.active_trips {
            if trip.status == crate::model::TripStatus::Waiting
                && trip.position == movement.old_position.into()
                && trip_boards_at_stop(
                    trip,
                    movement.old_position,
                    &movement.stop_id,
                    &route_legs_by_id,
                    &routes_serving_stop,
                    &ambiguous_routes_at_coordinate,
                )
            {
                trip.position = movement.new_position.into();
            }

            let Some(route_plan) = trip.route_plan.as_mut() else {
                continue;
            };
            for leg_index in 0..route_plan.legs.len() {
                if route_plan.legs[leg_index].mode != crate::model::TransitMode::Bus {
                    continue;
                }

                let from_moved = route_plan.legs[leg_index].from == movement.old_position;
                let to_moved = route_plan.legs[leg_index].to == movement.old_position;
                // Gate each endpoint on the leg being associated with
                // `movement.stop_id` — not merely sharing the old coordinate.
                // Without this, a second co-located stop on the same route
                // would capture every bus leg at that coordinate, even legs
                // whose itinerary index references the other stop.
                if from_moved
                    && leg_boards_at_stop(
                        &route_plan.legs[leg_index],
                        &movement.stop_id,
                        &route_legs_by_id,
                        &routes_serving_stop,
                        &ambiguous_routes_at_coordinate,
                    )
                {
                    route_plan.legs[leg_index].from = movement.new_position;
                    if leg_index > 0
                        && route_plan.legs[leg_index - 1].mode == crate::model::TransitMode::Walk
                        && route_plan.legs[leg_index - 1].to == movement.old_position
                    {
                        route_plan.legs[leg_index - 1].to = movement.new_position;
                    }
                }
                if to_moved
                    && leg_alights_at_stop(
                        &route_plan.legs[leg_index],
                        &movement.stop_id,
                        &route_legs_by_id,
                        &routes_serving_stop,
                        &ambiguous_routes_at_coordinate,
                    )
                {
                    route_plan.legs[leg_index].to = movement.new_position;
                    if leg_index + 1 < route_plan.legs.len()
                        && route_plan.legs[leg_index + 1].mode == crate::model::TransitMode::Walk
                        && route_plan.legs[leg_index + 1].from == movement.old_position
                    {
                        route_plan.legs[leg_index + 1].from = movement.new_position;
                    }
                }
            }
        }
    }
}

/// Resolves the waypoint ID a bus leg boards at, using the route's service
/// itinerary. Returns `None` when `board_itinerary_index` is absent (legacy
/// snapshots) or the index is out of bounds.
fn resolve_board_waypoint<'a>(
    leg: &RouteLeg,
    route_legs_by_id: &HashMap<&str, &'a [RouteLegPath]>,
) -> Option<&'a str> {
    let line_id = leg.line_id.as_deref()?;
    let board_idx = leg.board_itinerary_index?;
    let route_legs = route_legs_by_id.get(line_id)?;
    let service_leg = route_legs.get(board_idx)?;
    Some(service_leg.from_waypoint_id.as_str())
}

/// Resolves the waypoint ID a bus leg alights at, using the route's service
/// itinerary. Returns `None` when `alight_itinerary_index` is absent (legacy
/// snapshots) or the index is out of bounds.
fn resolve_alight_waypoint<'a>(
    leg: &RouteLeg,
    route_legs_by_id: &HashMap<&str, &'a [RouteLegPath]>,
) -> Option<&'a str> {
    let line_id = leg.line_id.as_deref()?;
    let alight_idx = leg.alight_itinerary_index?;
    let route_legs = route_legs_by_id.get(line_id)?;
    let service_leg = route_legs.get(alight_idx)?;
    Some(service_leg.to_waypoint_id.as_str())
}

/// Whether a bus leg's `from` endpoint is associated with `stop_id`. Uses
/// `board_itinerary_index` to resolve the exact boarding waypoint when
/// available; falls back to checking the route serves the stop (legacy
/// behavior for snapshots without itinerary indexes). The fallback is only
/// safe when the route has exactly one stop at the moved coordinate — for
/// ambiguous co-located stops on the same route it refuses to match so the
/// trip is left untouched rather than misrouted.
fn leg_boards_at_stop(
    leg: &RouteLeg,
    stop_id: &str,
    route_legs_by_id: &HashMap<&str, &[RouteLegPath]>,
    routes_serving_stop: &[String],
    ambiguous_routes_at_coordinate: &HashSet<&str>,
) -> bool {
    match resolve_board_waypoint(leg, route_legs_by_id) {
        Some(waypoint_id) => waypoint_id == stop_id,
        None => leg.line_id.as_deref().is_some_and(|id| {
            !ambiguous_routes_at_coordinate.contains(id)
                && routes_serving_stop.iter().any(|r| r == id)
        }),
    }
}

/// Whether a bus leg's `to` endpoint is associated with `stop_id`. Uses
/// `alight_itinerary_index` to resolve the exact alighting waypoint when
/// available; falls back to checking the route serves the stop (legacy
/// behavior for snapshots without itinerary indexes). The fallback is only
/// safe when the route has exactly one stop at the moved coordinate — for
/// ambiguous co-located stops on the same route it refuses to match so the
/// trip is left untouched rather than misrouted.
fn leg_alights_at_stop(
    leg: &RouteLeg,
    stop_id: &str,
    route_legs_by_id: &HashMap<&str, &[RouteLegPath]>,
    routes_serving_stop: &[String],
    ambiguous_routes_at_coordinate: &HashSet<&str>,
) -> bool {
    match resolve_alight_waypoint(leg, route_legs_by_id) {
        Some(waypoint_id) => waypoint_id == stop_id,
        None => leg.line_id.as_deref().is_some_and(|id| {
            !ambiguous_routes_at_coordinate.contains(id)
                && routes_serving_stop.iter().any(|r| r == id)
        }),
    }
}

/// Whether a waiting trip's current leg is a bus leg boarding at
/// `stop_position` for the moved stop. Uses `board_itinerary_index` to
/// resolve the exact boarding waypoint when available; falls back to
/// checking the route serves the stop. This prevents co-located nodes
/// (e.g. a metro station or a second bus stop sharing a coordinate) from
/// capturing passengers waiting for a different service.
fn trip_boards_at_stop(
    trip: &crate::model::ActiveTrip,
    stop_position: Point,
    stop_id: &str,
    route_legs_by_id: &HashMap<&str, &[RouteLegPath]>,
    routes_serving_stop: &[String],
    ambiguous_routes_at_coordinate: &HashSet<&str>,
) -> bool {
    let Some(plan) = trip.route_plan.as_ref() else {
        return false;
    };
    let Some(leg) = plan.legs.get(trip.current_leg_index) else {
        return false;
    };
    if leg.mode != TransitMode::Bus {
        return false;
    }
    if leg.from != stop_position {
        return false;
    }
    leg_boards_at_stop(
        leg,
        stop_id,
        route_legs_by_id,
        routes_serving_stop,
        ambiguous_routes_at_coordinate,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::intent::RoadPreset;
    use crate::model::{
        ActiveTrip, MovementKind, PathGeometry, RoadPathStep, Route, RouteLeg, RouteLegKind,
        RouteLegPath, RouteLegStatus, RoutePlan, ServiceDirection, ServicePattern, TransitMode,
        TransitPath, TripPurpose, TripStatus, Vehicle,
    };
    use crate::road::{apply_road_mutation, RoadMutation};
    use crate::state::create_initial_snapshot;

    /// Build a stop_id → position map for every present stop, mirroring what
    /// `normalize_snapshot_stops` captures before migrating legacy stops.
    /// Direct `rebase_active_trips` callers feed the snapshot's current
    /// (unmutated) positions so the ambiguity check sees co-located stops.
    fn original_stop_positions(snapshot: &GameSnapshot) -> HashMap<String, Point> {
        snapshot
            .transit
            .stops
            .iter()
            .filter(|stop| is_present_node(stop.status))
            .map(|stop| (stop.id.clone(), stop.position))
            .collect()
    }

    fn service_leg(from: &str, to: &str) -> RouteLegPath {
        RouteLegPath {
            from_waypoint_id: from.to_string(),
            to_waypoint_id: to.to_string(),
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
                        from: TripPosition::from(Point { x: 4, y: 5 }),
                        to: TripPosition::from(Point { x: 8, y: 5 }),
                    },
                    travel_seconds: 4.0,
                }],
                total_travel_seconds: 4.0,
            }),
            last_valid_path: None,
            estimated_seconds: Some(4.0),
            failure_reason: None,
        }
    }

    fn road_at_y5() -> GameSnapshot {
        let snapshot = create_initial_snapshot();
        apply_road_mutation(
            &snapshot,
            &RoadMutation::LayRoadLine {
                points: (2..=10).map(|x| Point { x, y: 5 }).collect(),
                preset: RoadPreset::TwoWay,
            },
        )
        .expect("fixture road should apply")
        .snapshot
    }

    #[test]
    fn accepts_the_supported_on_road_fallback_access() {
        let candidate = road_at_y5();

        assert!(is_valid_access(
            &candidate.map,
            &[Point { x: 4, y: 5 }],
            StopRoadAccess {
                road_point: Point { x: 4, y: 5 },
                preferred_heading: None,
            },
        ));
    }

    #[test]
    fn derive_access_falls_back_to_a_lane_accepted_heading_without_a_connection() {
        let mut candidate = road_at_y5();
        let tile = candidate
            .map
            .tile_mut(Point { x: 4, y: 5 })
            .expect("road tile exists");
        tile.one_way = Some(Heading::East);
        tile.road_connections.clear();

        let access = derive_stop_access_for_footprint(&candidate.map, &[Point { x: 4, y: 4 }])
            .expect("roadside access is derived");
        assert_eq!(access.road_point, Point { x: 4, y: 5 });
        assert_eq!(access.preferred_heading, Some(Heading::East));
    }

    #[test]
    fn access_for_road_point_returns_none_for_a_structure_owned_road() {
        let mut candidate = road_at_y5();
        let tile = candidate
            .map
            .tile_mut(Point { x: 6, y: 5 })
            .expect("road tile exists");
        tile.road_structure_id = Some("fixture-roundabout".to_string());

        assert!(access_for_road_point(&candidate.map, Point { x: 6, y: 5 }).is_none());
    }

    #[test]
    fn access_for_road_point_falls_back_to_a_lane_accepted_heading_without_a_connection() {
        let mut candidate = road_at_y5();
        let tile = candidate
            .map
            .tile_mut(Point { x: 4, y: 5 })
            .expect("road tile exists");
        tile.one_way = Some(Heading::East);
        tile.road_connections.clear();

        let access = access_for_road_point(&candidate.map, Point { x: 4, y: 5 })
            .expect("usable road returns access");
        assert_eq!(access.road_point, Point { x: 4, y: 5 });
        assert_eq!(access.preferred_heading, Some(Heading::East));
    }

    #[test]
    fn normalize_legacy_stop_on_unusable_road_derives_access_from_free_neighbor() {
        let mut snapshot = create_initial_snapshot();
        let usable_road = apply_road_mutation(
            &snapshot,
            &RoadMutation::LayRoadLine {
                points: (2..=10).map(|x| Point { x, y: 3 }).collect(),
                preset: RoadPreset::TwoWay,
            },
        )
        .expect("fixture road should apply")
        .snapshot;
        snapshot = usable_road;

        let isolated = snapshot
            .map
            .tile_mut(Point { x: 4, y: 5 })
            .expect("tile exists");
        isolated.kind = "road".to_string();
        isolated.road_connections.clear();

        snapshot.transit.stops.push(Stop {
            id: "stop-001".to_string(),
            kind: BusStopKind::BusStop,
            status: crate::model::TransitNodeStatus::Present,
            position: Point { x: 4, y: 5 },
            platforms: Vec::new(),
            road_access: None,
        });

        let normalized = normalize_snapshot_stops(snapshot);
        let stop = &normalized.transit.stops[0];

        assert_eq!(stop.position, Point { x: 4, y: 4 });
        assert_eq!(
            stop.road_access
                .expect("access derived from free neighbor")
                .road_point,
            Point { x: 4, y: 3 },
        );
    }

    #[test]
    fn rebase_parked_bus_positions_leaves_a_parked_metro_vehicle_untouched() {
        let mut snapshot = create_initial_snapshot();
        let parked_metro = Vehicle {
            id: "metro-001".to_string(),
            mode: TransitMode::Metro,
            line_id: "metro-line-001".to_string(),
            capacity: 90,
            passenger_ids: Vec::new(),
            itinerary_index: 0,
            path_step_index: 0,
            step_progress: 0.0,
            parked_position: Some(Point { x: 4, y: 4 }.into()),
        };
        snapshot.transit.vehicles.push(parked_metro.clone());

        rebase_parked_bus_positions(&mut snapshot, &HashMap::new());

        assert_eq!(
            snapshot.transit.vehicles[0].parked_position,
            Some(Point { x: 4, y: 4 }.into())
        );
    }

    #[test]
    fn rebase_active_trips_repoints_walk_legs_around_moved_legacy_stops() {
        let mut snapshot = create_initial_snapshot();
        let old_a = Point { x: 4, y: 5 };
        let new_a = Point { x: 4, y: 4 };
        let old_b = Point { x: 8, y: 5 };
        let new_b = Point { x: 8, y: 4 };

        // A route serving both stops must exist so the position update can
        // verify the trip is waiting for a bus at the moved stop.
        snapshot.transit.routes = vec![Route {
            id: "route-001".to_string(),
            name: "R1".to_string(),
            color: "#f00".to_string(),
            stop_ids: vec!["stop-001".to_string(), "stop-002".to_string()],
            vehicle_ids: Vec::new(),
            active: true,
            pattern: ServicePattern::Loop,
            revision: 0,
            legs: Vec::new(),
            path_broken: false,
        }];

        let riding_trip = ActiveTrip {
            id: "trip-001".to_string(),
            sim_id: "sim-001".to_string(),
            purpose: TripPurpose::CommuteOutbound,
            origin: old_a,
            destination: Point { x: 8, y: 8 },
            position: old_a.into(),
            status: TripStatus::Waiting,
            deadline: 1_000.0,
            route_plan: Some(RoutePlan {
                legs: vec![
                    RouteLeg {
                        mode: TransitMode::Bus,
                        from: old_a,
                        to: old_b,
                        line_id: Some("route-001".to_string()),
                        service_direction: None,
                        board_itinerary_index: None,
                        alight_itinerary_index: None,
                    },
                    RouteLeg {
                        mode: TransitMode::Walk,
                        from: old_b,
                        to: Point { x: 8, y: 8 },
                        line_id: None,
                        service_direction: None,
                        board_itinerary_index: None,
                        alight_itinerary_index: None,
                    },
                ],
                estimated_seconds: 100.0,
            }),
            current_leg_index: 0,
            patience_remaining: 240.0,
            private_car_trip: None,
        };
        let planless_trip = ActiveTrip {
            id: "trip-002".to_string(),
            sim_id: "sim-002".to_string(),
            purpose: TripPurpose::CommuteOutbound,
            origin: old_a,
            destination: old_a,
            position: old_a.into(),
            status: TripStatus::Waiting,
            deadline: 1_000.0,
            route_plan: None,
            current_leg_index: 0,
            patience_remaining: 240.0,
            private_car_trip: None,
        };
        snapshot.active_trips = vec![riding_trip, planless_trip];

        let moves = vec![
            StopMove {
                stop_id: "stop-001".to_string(),
                old_position: old_a,
                new_position: new_a,
                road_point: old_a,
            },
            StopMove {
                stop_id: "stop-002".to_string(),
                old_position: old_b,
                new_position: new_b,
                road_point: old_b,
            },
        ];
        let original_positions = original_stop_positions(&snapshot);
        rebase_active_trips(&mut snapshot, &moves, &original_positions);

        let riding = &snapshot.active_trips[0];
        assert_eq!(riding.position, new_a.into());
        let plan = riding
            .route_plan
            .as_ref()
            .expect("riding trip keeps its plan");
        assert_eq!(plan.legs[0].from, new_a);
        assert_eq!(plan.legs[0].to, new_b);
        assert_eq!(plan.legs[1].from, new_b);

        // The planless trip shares a coordinate with the moved stop but is
        // not waiting for a bus service, so it must NOT be moved.
        assert_eq!(snapshot.active_trips[1].position, old_a.into());
        assert!(snapshot.active_trips[1].route_plan.is_none());
    }

    /// Item 3 regression: a metro passenger waiting at a co-located metro
    /// station must not be moved when a legacy bus stop at the same
    /// coordinate migrates to a roadside anchor. The position update is
    /// gated on the trip's current leg being a bus leg serving the moved
    /// stop, not merely sharing a coordinate.
    #[test]
    fn rebase_active_trips_does_not_move_colocated_metro_passenger() {
        let mut snapshot = create_initial_snapshot();
        let shared = Point { x: 4, y: 5 };
        let new_bus_stop = Point { x: 4, y: 4 };

        // Bus route serving the legacy bus stop at the shared coordinate.
        snapshot.transit.routes = vec![Route {
            id: "route-001".to_string(),
            name: "R1".to_string(),
            color: "#f00".to_string(),
            stop_ids: vec!["stop-001".to_string()],
            vehicle_ids: Vec::new(),
            active: true,
            pattern: ServicePattern::Loop,
            revision: 0,
            legs: Vec::new(),
            path_broken: false,
        }];

        // A metro passenger waiting at the shared coordinate. Their current
        // leg is a Metro leg, not a Bus leg.
        let metro_passenger = ActiveTrip {
            id: "trip-metro".to_string(),
            sim_id: "sim-metro".to_string(),
            purpose: TripPurpose::CommuteOutbound,
            origin: shared,
            destination: Point { x: 8, y: 8 },
            position: shared.into(),
            status: TripStatus::Waiting,
            deadline: 1_000.0,
            route_plan: Some(RoutePlan {
                legs: vec![RouteLeg {
                    mode: TransitMode::Metro,
                    from: shared,
                    to: Point { x: 8, y: 5 },
                    line_id: Some("metro-line-001".to_string()),
                    service_direction: None,
                    board_itinerary_index: None,
                    alight_itinerary_index: None,
                }],
                estimated_seconds: 100.0,
            }),
            current_leg_index: 0,
            patience_remaining: 240.0,
            private_car_trip: None,
        };
        // A bus passenger waiting at the same coordinate for the bus route.
        let bus_passenger = ActiveTrip {
            id: "trip-bus".to_string(),
            sim_id: "sim-bus".to_string(),
            purpose: TripPurpose::CommuteOutbound,
            origin: shared,
            destination: Point { x: 8, y: 8 },
            position: shared.into(),
            status: TripStatus::Waiting,
            deadline: 1_000.0,
            route_plan: Some(RoutePlan {
                legs: vec![RouteLeg {
                    mode: TransitMode::Bus,
                    from: shared,
                    to: Point { x: 8, y: 5 },
                    line_id: Some("route-001".to_string()),
                    service_direction: None,
                    board_itinerary_index: None,
                    alight_itinerary_index: None,
                }],
                estimated_seconds: 100.0,
            }),
            current_leg_index: 0,
            patience_remaining: 240.0,
            private_car_trip: None,
        };
        snapshot.active_trips = vec![metro_passenger, bus_passenger];

        let moves = vec![StopMove {
            stop_id: "stop-001".to_string(),
            old_position: shared,
            new_position: new_bus_stop,
            road_point: shared,
        }];
        let original_positions = original_stop_positions(&snapshot);
        rebase_active_trips(&mut snapshot, &moves, &original_positions);

        // The metro passenger stays at the shared coordinate — their metro
        // route plan and platform location are unchanged.
        assert_eq!(snapshot.active_trips[0].position, shared.into());

        // The bus passenger is moved to the new bus stop anchor.
        assert_eq!(snapshot.active_trips[1].position, new_bus_stop.into());
    }

    /// P2 regression: two distinct bus stops at the same legacy coordinate,
    /// both served by the same route, must be distinguished via
    /// `board_itinerary_index` / `alight_itinerary_index`. A passenger
    /// waiting for stop-B must not be captured when stop-A is processed,
    /// and only endpoints associated with the moved stop are rewritten.
    #[test]
    fn rebase_active_trips_distinguishes_colocated_bus_stops_on_same_route() {
        let mut snapshot = create_initial_snapshot();
        let shared = Point { x: 4, y: 5 };
        let new_a = Point { x: 4, y: 4 };
        let new_b = Point { x: 4, y: 6 };

        // A single route serving two co-located stops. The route's legs
        // map itinerary indexes to specific waypoints:
        //   legs[0] = stop-A → stop-B  (boards at stop-A, alights at stop-B)
        //   legs[1] = stop-B → stop-A  (boards at stop-B, alights at stop-A)
        snapshot.transit.routes = vec![Route {
            id: "route-001".to_string(),
            name: "R1".to_string(),
            color: "#f00".to_string(),
            stop_ids: vec!["stop-A".to_string(), "stop-B".to_string()],
            vehicle_ids: Vec::new(),
            active: true,
            pattern: ServicePattern::Loop,
            revision: 0,
            legs: vec![
                service_leg("stop-A", "stop-B"),
                service_leg("stop-B", "stop-A"),
            ],
            path_broken: false,
        }];

        // A passenger waiting at the shared coordinate for stop-B
        // (board_itinerary_index = 1 → legs[1].from_waypoint_id = "stop-B")
        // and alighting at stop-A
        // (alight_itinerary_index = 1 → legs[1].to_waypoint_id = "stop-A").
        let trip = ActiveTrip {
            id: "trip-001".to_string(),
            sim_id: "sim-001".to_string(),
            purpose: TripPurpose::CommuteOutbound,
            origin: shared,
            destination: shared,
            position: shared.into(),
            status: TripStatus::Waiting,
            deadline: 1_000.0,
            route_plan: Some(RoutePlan {
                legs: vec![RouteLeg {
                    mode: TransitMode::Bus,
                    from: shared,
                    to: shared,
                    line_id: Some("route-001".to_string()),
                    service_direction: None,
                    board_itinerary_index: Some(1),
                    alight_itinerary_index: Some(1),
                }],
                estimated_seconds: 100.0,
            }),
            current_leg_index: 0,
            patience_remaining: 240.0,
            private_car_trip: None,
        };
        snapshot.active_trips = vec![trip];

        // Move stop-A first. The passenger waiting for stop-B must NOT be
        // moved, and the leg's `from` (boarding at stop-B) must NOT be
        // rewritten. Only the `to` (alighting at stop-A) is rewritten.
        let moves = vec![
            StopMove {
                stop_id: "stop-A".to_string(),
                old_position: shared,
                new_position: new_a,
                road_point: shared,
            },
            StopMove {
                stop_id: "stop-B".to_string(),
                old_position: shared,
                new_position: new_b,
                road_point: shared,
            },
        ];
        let original_positions = original_stop_positions(&snapshot);
        rebase_active_trips(&mut snapshot, &moves, &original_positions);

        let result = &snapshot.active_trips[0];
        // The passenger was waiting for stop-B, so after both moves it is
        // rebased to stop-B's new position — not stop-A's.
        assert_eq!(result.position, new_b.into());

        let plan = result
            .route_plan
            .as_ref()
            .expect("trip keeps its route plan");
        // `from` (boarding at stop-B) → new_b; `to` (alighting at stop-A)
        // → new_a. The itinerary indexes correctly routed each endpoint to
        // its own stop's new position.
        assert_eq!(plan.legs[0].from, new_b);
        assert_eq!(plan.legs[0].to, new_a);
    }

    /// P2 regression: two co-located bus stops on the same route with
    /// `board_itinerary_index` / `alight_itinerary_index` both `None` (legacy
    /// snapshots). The fallback cannot distinguish which stop a leg boards or
    /// alights at, so it must refuse to match — leaving the trip untouched
    /// rather than letting the first migration move capture a passenger
    /// waiting for the other stop.
    #[test]
    fn rebase_active_trips_leaves_trip_untouched_for_colocated_same_route_null_itinerary() {
        let mut snapshot = create_initial_snapshot();
        let shared = Point { x: 4, y: 5 };
        let new_a = Point { x: 4, y: 4 };
        let new_b = Point { x: 4, y: 6 };

        // Two co-located stops at the shared coordinate, both on the same
        // route. The stops must exist in the snapshot so the ambiguous-route
        // detection can count them.
        snapshot.transit.stops = vec![
            Stop {
                id: "stop-A".to_string(),
                kind: BusStopKind::BusStop,
                status: crate::model::TransitNodeStatus::Present,
                position: shared,
                platforms: Vec::new(),
                road_access: Some(StopRoadAccess {
                    road_point: shared,
                    preferred_heading: None,
                }),
            },
            Stop {
                id: "stop-B".to_string(),
                kind: BusStopKind::BusStop,
                status: crate::model::TransitNodeStatus::Present,
                position: shared,
                platforms: Vec::new(),
                road_access: Some(StopRoadAccess {
                    road_point: shared,
                    preferred_heading: None,
                }),
            },
        ];
        snapshot.transit.routes = vec![Route {
            id: "route-001".to_string(),
            name: "R1".to_string(),
            color: "#f00".to_string(),
            stop_ids: vec!["stop-A".to_string(), "stop-B".to_string()],
            vehicle_ids: Vec::new(),
            active: true,
            pattern: ServicePattern::Loop,
            revision: 0,
            legs: vec![
                service_leg("stop-A", "stop-B"),
                service_leg("stop-B", "stop-A"),
            ],
            path_broken: false,
        }];

        // A passenger waiting at the shared coordinate with null itinerary
        // indexes — the legacy fallback path.
        let trip = ActiveTrip {
            id: "trip-001".to_string(),
            sim_id: "sim-001".to_string(),
            purpose: TripPurpose::CommuteOutbound,
            origin: shared,
            destination: shared,
            position: shared.into(),
            status: TripStatus::Waiting,
            deadline: 1_000.0,
            route_plan: Some(RoutePlan {
                legs: vec![RouteLeg {
                    mode: TransitMode::Bus,
                    from: shared,
                    to: shared,
                    line_id: Some("route-001".to_string()),
                    service_direction: None,
                    board_itinerary_index: None,
                    alight_itinerary_index: None,
                }],
                estimated_seconds: 100.0,
            }),
            current_leg_index: 0,
            patience_remaining: 240.0,
            private_car_trip: None,
        };
        snapshot.active_trips = vec![trip];

        // Move stop-A first, then stop-B. Because the route is ambiguous at
        // the shared coordinate and the itinerary indexes are absent, the
        // fallback must refuse to match — the passenger is NOT captured by
        // either move.
        let moves = vec![
            StopMove {
                stop_id: "stop-A".to_string(),
                old_position: shared,
                new_position: new_a,
                road_point: shared,
            },
            StopMove {
                stop_id: "stop-B".to_string(),
                old_position: shared,
                new_position: new_b,
                road_point: shared,
            },
        ];
        let original_positions = original_stop_positions(&snapshot);
        rebase_active_trips(&mut snapshot, &moves, &original_positions);

        let result = &snapshot.active_trips[0];
        // The passenger stays at the shared coordinate — untouched.
        assert_eq!(result.position, shared.into());

        let plan = result
            .route_plan
            .as_ref()
            .expect("trip keeps its route plan");
        // Leg endpoints are NOT rewritten — both remain at the shared
        // coordinate.
        assert_eq!(plan.legs[0].from, shared);
        assert_eq!(plan.legs[0].to, shared);
    }

    /// P2 end-to-end regression: `normalize_snapshot_stops` migrates every
    /// legacy on-road stop (mutating `Stop.position`) BEFORE calling
    /// `rebase_active_trips`. The ambiguity check inside `rebase_active_trips`
    /// must therefore use the ORIGINAL stop positions, not the already-moved
    /// snapshot — otherwise two co-located legacy stops on the same route both
    /// move to their roadside anchors before the check runs, the count at the
    /// shared coordinate is zero, the route is considered unambiguous, and the
    /// first move captures a passenger waiting for the other stop. The direct
    /// `rebase_active_trips` test above cannot catch this because it leaves
    /// both stops at the shared coordinate.
    #[test]
    fn normalize_snapshot_stops_leaves_ambiguous_null_itinerary_trip_untouched_end_to_end() {
        let mut snapshot = road_at_y5();
        // Clear buildings so the only obstacles to free roadside anchors are
        // the road itself and the other co-located stop.
        snapshot.buildings = Vec::new();
        let shared = Point { x: 4, y: 5 };
        let new_a = Point { x: 4, y: 4 };
        let new_b = Point { x: 4, y: 6 };

        // Two LEGACY on-road bus stops at the same road tile (no `road_access`,
        // position on a road tile). Both are served by the same route.
        snapshot.transit.stops = vec![
            Stop {
                id: "stop-A".to_string(),
                kind: BusStopKind::BusStop,
                status: crate::model::TransitNodeStatus::Present,
                position: shared,
                platforms: Vec::new(),
                road_access: None,
            },
            Stop {
                id: "stop-B".to_string(),
                kind: BusStopKind::BusStop,
                status: crate::model::TransitNodeStatus::Present,
                position: shared,
                platforms: Vec::new(),
                road_access: None,
            },
        ];
        snapshot.transit.routes = vec![Route {
            id: "route-001".to_string(),
            name: "R1".to_string(),
            color: "#f00".to_string(),
            stop_ids: vec!["stop-A".to_string(), "stop-B".to_string()],
            vehicle_ids: Vec::new(),
            active: true,
            pattern: ServicePattern::Loop,
            revision: 0,
            legs: vec![
                service_leg("stop-A", "stop-B"),
                service_leg("stop-B", "stop-A"),
            ],
            path_broken: false,
        }];

        // A passenger waiting at the shared coordinate with null itinerary
        // indexes — the legacy fallback path. The route is ambiguous at the
        // shared coordinate, so the fallback must refuse to match and the
        // trip must remain untouched by either stop's migration.
        let trip = ActiveTrip {
            id: "trip-001".to_string(),
            sim_id: "sim-001".to_string(),
            purpose: TripPurpose::CommuteOutbound,
            origin: shared,
            destination: shared,
            position: shared.into(),
            status: TripStatus::Waiting,
            deadline: 1_000.0,
            route_plan: Some(RoutePlan {
                legs: vec![RouteLeg {
                    mode: TransitMode::Bus,
                    from: shared,
                    to: shared,
                    line_id: Some("route-001".to_string()),
                    service_direction: None,
                    board_itinerary_index: None,
                    alight_itinerary_index: None,
                }],
                estimated_seconds: 100.0,
            }),
            current_leg_index: 0,
            patience_remaining: 240.0,
            private_car_trip: None,
        };
        snapshot.active_trips = vec![trip];

        let normalized = normalize_snapshot_stops(snapshot);

        // Both legacy stops migrated to distinct roadside anchors — confirming
        // moves were actually generated, so the ambiguity path is exercised.
        let stop_a = normalized
            .transit
            .stops
            .iter()
            .find(|stop| stop.id == "stop-A")
            .expect("stop-A present");
        let stop_b = normalized
            .transit
            .stops
            .iter()
            .find(|stop| stop.id == "stop-B")
            .expect("stop-B present");
        assert_eq!(stop_a.position, new_a, "stop-A migrates north");
        assert_eq!(stop_b.position, new_b, "stop-B migrates south");

        // The passenger stays at the shared coordinate — untouched, not
        // captured by either move despite the route serving both stops.
        let result = &normalized.active_trips[0];
        assert_eq!(result.position, shared.into(), "trip not captured");
        let plan = result
            .route_plan
            .as_ref()
            .expect("trip keeps its route plan");
        assert_eq!(plan.legs[0].from, shared, "leg from not rewritten");
        assert_eq!(plan.legs[0].to, shared, "leg to not rewritten");
    }

    /// P2 end-to-end regression: the parked-vehicle analogue of the
    /// null-itinerary passenger ambiguity. `Route.legs` has `#[serde(default)]`,
    /// so a loaded route can have no saved legs when stop normalisation runs.
    /// `service_visits` then returns an empty vec, `itinerary_stop_id` is
    /// `None`, and `rebase_parked_bus_positions` falls back to scanning
    /// `route.stop_ids`. When two co-located legacy stops share the same old
    /// road coordinate and that road is unusable (so each stop re-derives to a
    /// DIFFERENT replacement access tile), both stops match the parked
    /// coordinate via `old_road_points`. A `find_map` fallback would move the
    /// bus to whichever stop appears first in `route.stop_ids` — guessing. The
    /// fallback must instead collect every match and only rebase when exactly
    /// one stop qualifies; multiple matches preserve the parked coordinate.
    #[test]
    fn normalize_snapshot_stops_preserves_parked_bus_when_itinerary_empty_and_stops_colocated() {
        let mut snapshot = create_initial_snapshot();
        // Roads at y=3 and y=7 (full span) provide divergent access tiles for
        // the two co-located stops. The y=5 road is laid with a GAP at x=4 so
        // the neighbours (3,5) and (5,5) have no reciprocal connection toward
        // (4,5); we then stamp (4,5) as an isolated road tile below. This
        // makes `usable_road((4,5))` false (no neighbour points back), so
        // `access_for_road_point` returns None and the stops re-derive access
        // from their migrated anchors. The road tiles at (3,5) and (5,5) also
        // block the East/West neighbours, forcing the two co-located legacy
        // stops to migrate to distinct anchors: stop-A → (4,4) → access
        // (4,3); stop-B → (4,6) → access (4,7).
        for y in [3, 7] {
            snapshot = apply_road_mutation(
                &snapshot,
                &RoadMutation::LayRoadLine {
                    points: (2..=10).map(|x| Point { x, y }).collect(),
                    preset: RoadPreset::TwoWay,
                },
            )
            .expect("fixture road should apply")
            .snapshot;
        }
        snapshot = apply_road_mutation(
            &snapshot,
            &RoadMutation::LayRoadLine {
                points: vec![Point { x: 2, y: 5 }, Point { x: 3, y: 5 }],
                preset: RoadPreset::TwoWay,
            },
        )
        .expect("fixture road should apply")
        .snapshot;
        snapshot = apply_road_mutation(
            &snapshot,
            &RoadMutation::LayRoadLine {
                points: (5..=10).map(|x| Point { x, y: 5 }).collect(),
                preset: RoadPreset::TwoWay,
            },
        )
        .expect("fixture road should apply")
        .snapshot;
        // Clear buildings so the only obstacles to free roadside anchors are
        // the road itself and the other co-located stop.
        snapshot.buildings = Vec::new();
        let shared = Point { x: 4, y: 5 };

        // Stamp (4,5) as an isolated road tile (no connections, no neighbours
        // pointing back) so both stops are legacy on-road but the tile is
        // unusable for access — forcing divergence.
        let isolated = snapshot.map.tile_mut(shared).expect("tile exists");
        isolated.kind = "road".to_string();
        isolated.road_connections.clear();
        isolated.one_way = None;
        snapshot.transit.stops = vec![
            Stop {
                id: "stop-A".to_string(),
                kind: BusStopKind::BusStop,
                status: crate::model::TransitNodeStatus::Present,
                position: shared,
                platforms: Vec::new(),
                road_access: None,
            },
            Stop {
                id: "stop-B".to_string(),
                kind: BusStopKind::BusStop,
                status: crate::model::TransitNodeStatus::Present,
                position: shared,
                platforms: Vec::new(),
                road_access: None,
            },
        ];
        // Empty `legs` — the loaded-snapshot shape that defeats itinerary
        // resolution in `rebase_parked_bus_positions`.
        snapshot.transit.routes = vec![Route {
            id: "route-001".to_string(),
            name: "R1".to_string(),
            color: "#f00".to_string(),
            stop_ids: vec!["stop-A".to_string(), "stop-B".to_string()],
            vehicle_ids: vec!["vehicle-001".to_string()],
            active: true,
            pattern: ServicePattern::Loop,
            revision: 0,
            legs: Vec::new(),
            path_broken: false,
        }];
        // Bus parked at the shared old road coordinate.
        snapshot.transit.vehicles = vec![Vehicle {
            id: "vehicle-001".to_string(),
            mode: TransitMode::Bus,
            line_id: "route-001".to_string(),
            capacity: 18,
            passenger_ids: Vec::new(),
            itinerary_index: 0,
            path_step_index: 0,
            step_progress: 0.0,
            parked_position: Some(shared.into()),
        }];

        let normalized = normalize_snapshot_stops(snapshot);

        // Both legacy stops migrated to distinct roadside anchors with
        // divergent access tiles — confirming both stops match the parked
        // coordinate via `old_road_points`, so the ambiguity path is
        // exercised.
        let stop_a = normalized
            .transit
            .stops
            .iter()
            .find(|stop| stop.id == "stop-A")
            .expect("stop-A present");
        let stop_b = normalized
            .transit
            .stops
            .iter()
            .find(|stop| stop.id == "stop-B")
            .expect("stop-B present");
        assert_eq!(
            stop_a.position,
            Point { x: 4, y: 4 },
            "stop-A migrates north"
        );
        assert_eq!(
            stop_b.position,
            Point { x: 4, y: 6 },
            "stop-B migrates south"
        );
        assert_eq!(
            stop_a
                .road_access
                .expect("stop-A access derived")
                .road_point,
            Point { x: 4, y: 3 },
            "stop-A access diverges to y=3 road",
        );
        assert_eq!(
            stop_b
                .road_access
                .expect("stop-B access derived")
                .road_point,
            Point { x: 4, y: 7 },
            "stop-B access diverges to y=7 road",
        );

        // The parked bus stays at the shared coordinate — not captured by
        // either stop's migration despite both matching via `old_road_points`.
        assert_eq!(
            normalized.transit.vehicles[0].parked_position,
            Some(shared.into()),
            "parked bus preserved when itinerary is empty and stops are co-located",
        );
    }

    /// Item 2 regression: a paused (inactive) route's parked bus must still be
    /// rebased when a road mutation changes its stop's road access. The active
    /// flag controls whether the vehicle resumes service, not whether its parked
    /// position tracks the current access tile.
    #[test]
    fn rebase_parked_bus_positions_rebases_inactive_route_vehicle() {
        let mut snapshot = create_initial_snapshot();
        snapshot = apply_road_mutation(
            &snapshot,
            &RoadMutation::LayRoadLine {
                points: (2..=10).map(|x| Point { x, y: 5 }).collect(),
                preset: RoadPreset::TwoWay,
            },
        )
        .expect("fixture road should apply")
        .snapshot;
        // Lay an alternate road at y=3 so the stop's access can migrate north.
        snapshot = apply_road_mutation(
            &snapshot,
            &RoadMutation::LayRoadLine {
                points: (2..=10).map(|x| Point { x, y: 3 }).collect(),
                preset: RoadPreset::TwoWay,
            },
        )
        .expect("fixture road should apply")
        .snapshot;

        let stop_a = Stop {
            id: "stop-001".to_string(),
            kind: BusStopKind::BusStop,
            status: crate::model::TransitNodeStatus::Present,
            position: Point { x: 4, y: 4 },
            platforms: Vec::new(),
            road_access: Some(StopRoadAccess {
                road_point: Point { x: 4, y: 5 },
                preferred_heading: None,
            }),
        };
        let stop_b = Stop {
            id: "stop-002".to_string(),
            kind: BusStopKind::BusStop,
            status: crate::model::TransitNodeStatus::Present,
            position: Point { x: 8, y: 4 },
            platforms: Vec::new(),
            road_access: Some(StopRoadAccess {
                road_point: Point { x: 8, y: 5 },
                preferred_heading: None,
            }),
        };
        snapshot.transit.stops = vec![stop_a, stop_b];

        let route = Route {
            id: "route-001".to_string(),
            name: "R1".to_string(),
            color: "#f00".to_string(),
            stop_ids: vec!["stop-001".to_string(), "stop-002".to_string()],
            vehicle_ids: vec!["vehicle-001".to_string()],
            active: false, // paused
            pattern: ServicePattern::Loop,
            revision: 0,
            legs: vec![
                service_leg("stop-001", "stop-002"),
                service_leg("stop-002", "stop-001"),
            ],
            path_broken: false,
        };
        snapshot.transit.routes = vec![route];
        snapshot.transit.vehicles = vec![Vehicle {
            id: "vehicle-001".to_string(),
            mode: TransitMode::Bus,
            line_id: "route-001".to_string(),
            capacity: 18,
            passenger_ids: Vec::new(),
            itinerary_index: 0,
            path_step_index: 0,
            step_progress: 0.0,
            parked_position: Some(Point { x: 4, y: 5 }.into()),
        }];

        // Remove the road at (4,5) so stop-001's stored access becomes invalid
        // and `stop_access` re-derives to (4,3).
        let tile = snapshot
            .map
            .tile_mut(Point { x: 4, y: 5 })
            .expect("road tile exists");
        tile.kind = "empty".to_string();
        tile.road_connections.clear();
        tile.one_way = None;

        let mut old_road_points = HashMap::new();
        old_road_points.insert("stop-001".to_string(), Point { x: 4, y: 5 });
        rebase_parked_bus_positions(&mut snapshot, &old_road_points);

        assert_eq!(
            snapshot.transit.vehicles[0].parked_position,
            Some(Point { x: 4, y: 3 }.into()),
        );
    }

    /// Item 3 regression: when two stops share a road-access tile, the vehicle's
    /// itinerary index must identify its associated stop so the first coordinate
    /// match doesn't capture a bus parked for the other stop.
    #[test]
    fn rebase_parked_bus_positions_disambiguates_shared_access_via_itinerary() {
        let mut snapshot = create_initial_snapshot();
        for y in [3, 5, 7] {
            snapshot = apply_road_mutation(
                &snapshot,
                &RoadMutation::LayRoadLine {
                    points: (2..=10).map(|x| Point { x, y }).collect(),
                    preset: RoadPreset::TwoWay,
                },
            )
            .expect("fixture road should apply")
            .snapshot;
        }

        // Two stops on opposite sides of the road at y=5, both accessing (4,5).
        let stop_a = Stop {
            id: "stop-A".to_string(),
            kind: BusStopKind::BusStop,
            status: crate::model::TransitNodeStatus::Present,
            position: Point { x: 4, y: 4 },
            platforms: Vec::new(),
            road_access: Some(StopRoadAccess {
                road_point: Point { x: 4, y: 5 },
                preferred_heading: None,
            }),
        };
        let stop_b = Stop {
            id: "stop-B".to_string(),
            kind: BusStopKind::BusStop,
            status: crate::model::TransitNodeStatus::Present,
            position: Point { x: 4, y: 6 },
            platforms: Vec::new(),
            road_access: Some(StopRoadAccess {
                road_point: Point { x: 4, y: 5 },
                preferred_heading: None,
            }),
        };
        snapshot.transit.stops = vec![stop_a, stop_b];

        let route = Route {
            id: "route-001".to_string(),
            name: "R1".to_string(),
            color: "#f00".to_string(),
            stop_ids: vec!["stop-A".to_string(), "stop-B".to_string()],
            vehicle_ids: vec!["vehicle-001".to_string()],
            active: true,
            pattern: ServicePattern::Loop,
            revision: 0,
            legs: vec![
                service_leg("stop-A", "stop-B"),
                service_leg("stop-B", "stop-A"),
            ],
            path_broken: false,
        };
        snapshot.transit.routes = vec![route];
        // Vehicle parked at the shared tile (4,5) for stop-B (itinerary_index=1).
        snapshot.transit.vehicles = vec![Vehicle {
            id: "vehicle-001".to_string(),
            mode: TransitMode::Bus,
            line_id: "route-001".to_string(),
            capacity: 18,
            passenger_ids: Vec::new(),
            itinerary_index: 1,
            path_step_index: 0,
            step_progress: 0.0,
            parked_position: Some(Point { x: 4, y: 5 }.into()),
        }];

        // Remove the shared road at (4,5) so each stop re-derives to a
        // different tile: stop-A → (4,3) [north], stop-B → (4,7) [south].
        let tile = snapshot
            .map
            .tile_mut(Point { x: 4, y: 5 })
            .expect("road tile exists");
        tile.kind = "empty".to_string();
        tile.road_connections.clear();
        tile.one_way = None;

        let mut old_road_points = HashMap::new();
        old_road_points.insert("stop-A".to_string(), Point { x: 4, y: 5 });
        old_road_points.insert("stop-B".to_string(), Point { x: 4, y: 5 });
        rebase_parked_bus_positions(&mut snapshot, &old_road_points);

        // The bus was parked for stop-B, so it must be rebased to stop-B's new
        // access (4,7), not stop-A's (4,3).
        assert_eq!(
            snapshot.transit.vehicles[0].parked_position,
            Some(Point { x: 4, y: 7 }.into()),
        );
    }

    /// Item 2 regression: a legacy on-road stop with no `road_access` whose
    /// original road tile is unusable must still record its position as the
    /// previous road point so a bus parked at that coordinate is rebased to
    /// the stop's newly derived road access.
    #[test]
    fn normalize_rebases_parked_bus_from_legacy_on_road_position_without_access() {
        let mut snapshot = create_initial_snapshot();
        // Alternate road at y=3 so the stop's access can migrate north.
        snapshot = apply_road_mutation(
            &snapshot,
            &RoadMutation::LayRoadLine {
                points: (2..=10).map(|x| Point { x, y: 3 }).collect(),
                preset: RoadPreset::TwoWay,
            },
        )
        .expect("fixture road should apply")
        .snapshot;

        // Legacy on-road stop at (4,5) with no road_access. The tile at
        // (4,5) is marked as "road" but has no connections (and no
        // neighbouring road tiles), making it unusable for access.
        let isolated = snapshot
            .map
            .tile_mut(Point { x: 4, y: 5 })
            .expect("tile exists");
        isolated.kind = "road".to_string();
        isolated.road_connections.clear();

        snapshot.transit.stops.push(Stop {
            id: "stop-001".to_string(),
            kind: BusStopKind::BusStop,
            status: crate::model::TransitNodeStatus::Present,
            position: Point { x: 4, y: 5 },
            platforms: Vec::new(),
            road_access: None,
        });

        let route = Route {
            id: "route-001".to_string(),
            name: "R1".to_string(),
            color: "#f00".to_string(),
            stop_ids: vec!["stop-001".to_string()],
            vehicle_ids: vec!["vehicle-001".to_string()],
            active: true,
            pattern: ServicePattern::Loop,
            revision: 0,
            legs: vec![],
            path_broken: false,
        };
        snapshot.transit.routes = vec![route];
        // Bus parked at the legacy on-road stop position (4,5).
        snapshot.transit.vehicles = vec![Vehicle {
            id: "vehicle-001".to_string(),
            mode: TransitMode::Bus,
            line_id: "route-001".to_string(),
            capacity: 18,
            passenger_ids: Vec::new(),
            itinerary_index: 0,
            path_step_index: 0,
            step_progress: 0.0,
            parked_position: Some(Point { x: 4, y: 5 }.into()),
        }];

        let normalized = normalize_snapshot_stops(snapshot);

        // The stop moved to the roadside anchor (4,4).
        let stop = &normalized.transit.stops[0];
        assert_eq!(stop.position, Point { x: 4, y: 4 });
        assert_eq!(
            stop.road_access
                .expect("access derived from alternate road")
                .road_point,
            Point { x: 4, y: 3 },
        );

        // The parked bus was rebased from the obsolete (4,5) to the new
        // access road point (4,3).
        assert_eq!(
            normalized.transit.vehicles[0].parked_position,
            Some(Point { x: 4, y: 3 }.into()),
        );
    }
}
