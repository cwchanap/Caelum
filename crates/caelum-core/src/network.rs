use std::collections::{HashMap, VecDeque};

use crate::engine::RoutingContext;
use crate::heading::heading_between;
use crate::model::{
    GameMap, GameSnapshot, Heading, PathGeometry, Point, RouteLegKind, RouteLegPath,
    RouteLegStatus, ServicePattern, Tile, TrackPathStep, TransitMode, TransitPath,
};
use crate::service_itinerary::{build_service_itinerary, ServiceLegSpec};
use crate::transit::METRO_TILES_PER_SECOND;
use crate::transit_nodes::is_present_node;

pub fn find_track_path(map: &GameMap, from: &Point, to: &Point) -> Option<TransitPath> {
    let points = deterministic_track_bfs(map, from, to)?;
    Some(track_path_from_points(points, METRO_TILES_PER_SECOND))
}

pub fn resolve_route_legs(
    snapshot: &GameSnapshot,
    context: RoutingContext<'_>,
    mode: TransitMode,
    waypoint_ids: &[String],
    pattern: ServicePattern,
) -> Vec<RouteLegPath> {
    let Some(first_waypoint_id) = waypoint_ids.first() else {
        return Vec::new();
    };
    if !waypoint_ids
        .iter()
        .skip(1)
        .any(|waypoint_id| waypoint_id != first_waypoint_id)
    {
        return Vec::new();
    }
    let specs = build_service_itinerary(mode, pattern, waypoint_ids);
    specs
        .iter()
        .enumerate()
        .map(|(index, spec)| resolve_leg(snapshot, context, mode, &specs, index, spec))
        .collect()
}

fn resolve_leg(
    snapshot: &GameSnapshot,
    context: RoutingContext<'_>,
    mode: TransitMode,
    specs: &[ServiceLegSpec],
    index: usize,
    spec: &ServiceLegSpec,
) -> RouteLegPath {
    let from = waypoint_position(snapshot, mode, &spec.from_waypoint_id);
    let to = waypoint_position(snapshot, mode, &spec.to_waypoint_id);
    let path = match (from, to) {
        (Some(from), Some(to)) => match spec.kind {
            RouteLegKind::Service => resolve_service_path(snapshot, context, mode, from, to),
            RouteLegKind::TerminalReversal => {
                resolve_terminal_reversal(snapshot, context, mode, specs, index, from)
            }
        },
        _ => None,
    };
    let status = if from.is_none() || to.is_none() {
        RouteLegStatus::MissingNode
    } else if path.is_some() {
        RouteLegStatus::Connected
    } else {
        RouteLegStatus::NetworkDisconnected
    };
    RouteLegPath {
        from_waypoint_id: spec.from_waypoint_id.clone(),
        to_waypoint_id: spec.to_waypoint_id.clone(),
        direction: spec.direction,
        kind: spec.kind,
        status,
        estimated_seconds: path.as_ref().map(TransitPath::total_travel_seconds),
        current_path: path.clone(),
        last_valid_path: path,
    }
}

fn resolve_terminal_reversal(
    snapshot: &GameSnapshot,
    context: RoutingContext<'_>,
    mode: TransitMode,
    specs: &[ServiceLegSpec],
    index: usize,
    terminal: Point,
) -> Option<TransitPath> {
    if mode == TransitMode::Metro {
        return Some(TransitPath::Track {
            steps: Vec::new(),
            total_travel_seconds: 0.0,
        });
    }
    if mode != TransitMode::Bus || specs.is_empty() {
        return None;
    }
    let previous = &specs[(index + specs.len() - 1) % specs.len()];
    let next = &specs[(index + 1) % specs.len()];
    let previous_path = resolve_spec_service_path(snapshot, context, mode, previous)?;
    let next_path = resolve_spec_service_path(snapshot, context, mode, next)?;
    context.road_topology.find_terminal_reversal(
        terminal,
        road_exit_heading(&previous_path)?,
        road_entry_heading(&next_path)?,
    )
}

fn resolve_spec_service_path(
    snapshot: &GameSnapshot,
    context: RoutingContext<'_>,
    mode: TransitMode,
    spec: &ServiceLegSpec,
) -> Option<TransitPath> {
    if spec.kind != RouteLegKind::Service {
        return None;
    }
    let from = waypoint_position(snapshot, mode, &spec.from_waypoint_id)?;
    let to = waypoint_position(snapshot, mode, &spec.to_waypoint_id)?;
    resolve_service_path(snapshot, context, mode, from, to)
}

fn resolve_service_path(
    snapshot: &GameSnapshot,
    context: RoutingContext<'_>,
    mode: TransitMode,
    from: Point,
    to: Point,
) -> Option<TransitPath> {
    match mode {
        TransitMode::Bus => context.road_topology.find_path(&snapshot.map, &from, &to),
        TransitMode::Metro => find_track_path(&snapshot.map, &from, &to),
        TransitMode::Walk => None,
    }
}

fn waypoint_position(snapshot: &GameSnapshot, mode: TransitMode, id: &str) -> Option<Point> {
    match mode {
        TransitMode::Bus => snapshot
            .transit
            .stops
            .iter()
            .find(|stop| stop.id == id)
            .and_then(|stop| is_present_node(stop.status).then_some(stop.position)),
        TransitMode::Metro => snapshot
            .transit
            .stations
            .iter()
            .find(|station| station.id == id)
            .and_then(|station| is_present_node(station.status).then_some(station.position)),
        TransitMode::Walk => None,
    }
}

fn road_exit_heading(path: &TransitPath) -> Option<Heading> {
    path.road_steps().last().map(|step| step.leaving_heading)
}

fn road_entry_heading(path: &TransitPath) -> Option<Heading> {
    path.road_steps().first().map(|step| step.entering_heading)
}

fn deterministic_track_bfs(map: &GameMap, from: &Point, to: &Point) -> Option<Vec<Point>> {
    let tile_by_key: HashMap<(i32, i32), &Tile> = map
        .tiles
        .iter()
        .map(|tile| ((tile.x, tile.y), tile))
        .collect();
    let from_key = (from.x, from.y);
    let to_key = (to.x, to.y);
    if !tile_by_key.contains_key(&from_key) || !tile_by_key.contains_key(&to_key) {
        return None;
    }
    if from_key == to_key {
        return Some(vec![*from]);
    }
    let mut parents: HashMap<(i32, i32), Option<(i32, i32)>> = HashMap::from([(from_key, None)]);
    let mut queue = VecDeque::from([from_key]);
    while let Some(current_key) = queue.pop_front() {
        for (dx, dy) in [(0, -1), (1, 0), (0, 1), (-1, 0)] {
            let next_key = (current_key.0 + dx, current_key.1 + dy);
            if parents.contains_key(&next_key) {
                continue;
            }
            let Some(next_tile) = tile_by_key.get(&next_key).copied() else {
                continue;
            };
            if next_key != to_key && !next_tile.has_track {
                continue;
            }
            parents.insert(next_key, Some(current_key));
            if next_key == to_key {
                let path = build_track_points(&parents, next_key);
                if path.len() == 2 {
                    let from_tile = tile_by_key.get(&from_key).copied()?;
                    if !from_tile.has_track && !next_tile.has_track {
                        parents.remove(&next_key);
                        continue;
                    }
                }
                return Some(path);
            }
            queue.push_back(next_key);
        }
    }
    None
}

fn build_track_points(
    parents: &HashMap<(i32, i32), Option<(i32, i32)>>,
    to_key: (i32, i32),
) -> Vec<Point> {
    let mut path = Vec::new();
    let mut cursor = Some(to_key);
    while let Some(key) = cursor {
        path.push(Point { x: key.0, y: key.1 });
        cursor = parents.get(&key).copied().flatten();
    }
    path.reverse();
    path
}

fn track_path_from_points(points: Vec<Point>, tiles_per_second: f64) -> TransitPath {
    let travel_seconds = 1.0 / tiles_per_second;
    let steps: Vec<_> = points
        .windows(2)
        .filter_map(|pair| {
            let heading = heading_between(pair[0], pair[1])?;
            Some(TrackPathStep {
                position: pair[0],
                heading,
                geometry: PathGeometry::Line {
                    from: pair[0].into(),
                    to: pair[1].into(),
                },
                travel_seconds,
            })
        })
        .collect();
    TransitPath::Track {
        total_travel_seconds: steps.len() as f64 * travel_seconds,
        steps,
    }
}
