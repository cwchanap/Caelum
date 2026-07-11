use std::collections::HashMap;

use crate::engine::RoutingContext;
use crate::model::{GameMap, GameSnapshot, Point, TransitMode};
use crate::network::{compute_route_segments, has_broken_segment};
use crate::transit::park_vehicles_and_invalidate_trips;

pub fn recompute_affected_routes(
    _previous: &GameSnapshot,
    candidate: GameSnapshot,
    context: RoutingContext<'_>,
) -> GameSnapshot {
    let stop_position_by_id: HashMap<String, Point> = candidate
        .transit
        .stops
        .iter()
        .map(|stop| (stop.id.clone(), stop.position))
        .collect();
    let station_position_by_id: HashMap<String, Point> = candidate
        .transit
        .stations
        .iter()
        .map(|station| (station.id.clone(), station.position))
        .collect();
    let mut next = candidate.clone();

    for route_index in 0..next.transit.routes.len() {
        let route = next.transit.routes[route_index].clone();
        let (positions, segments, ids_missing) = resolve_line_segments(
            &candidate.map,
            context,
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
            &candidate.map,
            context,
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

pub fn structurally_changed_route_ids(
    previous: &GameSnapshot,
    candidate: &GameSnapshot,
) -> Vec<String> {
    let mut affected = Vec::new();

    for route in &previous.transit.routes {
        if candidate
            .transit
            .routes
            .iter()
            .find(|candidate| candidate.id == route.id)
            != Some(route)
        {
            affected.push(route.id.clone());
        }
    }
    for route in &candidate.transit.routes {
        if !previous
            .transit
            .routes
            .iter()
            .any(|previous| previous.id == route.id)
        {
            affected.push(route.id.clone());
        }
    }

    for line in &previous.transit.metro_lines {
        if candidate
            .transit
            .metro_lines
            .iter()
            .find(|candidate| candidate.id == line.id)
            != Some(line)
        {
            affected.push(line.id.clone());
        }
    }
    for line in &candidate.transit.metro_lines {
        if !previous
            .transit
            .metro_lines
            .iter()
            .any(|previous| previous.id == line.id)
        {
            affected.push(line.id.clone());
        }
    }

    affected.sort();
    affected.dedup();
    affected
}

fn resolve_line_segments(
    map: &GameMap,
    context: RoutingContext<'_>,
    ids: &[String],
    position_by_id: &HashMap<String, Point>,
    mode: TransitMode,
) -> (Vec<Point>, Vec<Vec<Point>>, bool) {
    let positions: Vec<Point> = ids
        .iter()
        .filter_map(|id| position_by_id.get(id).copied())
        .collect();
    let ids_missing = positions.len() != ids.len();
    let segments = if ids_missing {
        Vec::new()
    } else {
        compute_route_segments(map, context.road_topology, &positions, mode)
    };
    (positions, segments, ids_missing)
}
