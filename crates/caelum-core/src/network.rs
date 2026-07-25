use std::collections::{HashMap, VecDeque};

use crate::engine::RoutingContext;
use crate::heading::{canonical_headings, heading_between};
use crate::model::{
    GameMap, GameSnapshot, Heading, LegFailureReason, PathGeometry, Point, RouteLegKind,
    RouteLegPath, RouteLegStatus, ServicePattern, StopRoadAccess, Tile, TrackPathStep, TransitMode,
    TransitPath,
};
use crate::road_topology::RoadState;
use crate::service_itinerary::{build_service_itinerary, ServiceLegSpec};
use crate::stop_access::stop_access;
use crate::transit::METRO_TILES_PER_SECOND;
use crate::transit_nodes::is_present_node;

type TransitPathResult = Result<TransitPath, LegFailureReason>;

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
    let specs = build_service_itinerary(pattern, waypoint_ids);
    // Pre-compute service leg paths so terminal reversals can reuse them
    // instead of re-resolving the adjacent service legs.
    let service_paths: Vec<TransitPathResult> = specs
        .iter()
        .map(|spec| {
            if spec.kind == RouteLegKind::Service {
                resolve_spec_service_path(snapshot, context, mode, spec)
            } else {
                Err(LegFailureReason::NetworkDisconnected)
            }
        })
        .collect();
    specs
        .iter()
        .enumerate()
        .map(|(index, spec)| resolve_leg(snapshot, context, mode, &service_paths, index, spec))
        .collect()
}

fn resolve_leg(
    snapshot: &GameSnapshot,
    context: RoutingContext<'_>,
    mode: TransitMode,
    service_paths: &[TransitPathResult],
    index: usize,
    spec: &ServiceLegSpec,
) -> RouteLegPath {
    let from_present = waypoint_present(snapshot, mode, &spec.from_waypoint_id);
    let to_present = waypoint_present(snapshot, mode, &spec.to_waypoint_id);
    let resolution = if from_present && to_present {
        Some(match spec.kind {
            RouteLegKind::Service => service_paths[index].clone(),
            RouteLegKind::TerminalReversal => resolve_terminal_reversal(
                snapshot,
                context,
                mode,
                service_paths,
                index,
                service_paths.len(),
                &spec.from_waypoint_id,
            ),
        })
    } else {
        None
    };
    let (path, failure_reason) = match resolution {
        None => (None, None),
        Some(Ok(path)) => (Some(path), None),
        Some(Err(reason)) => (None, Some(reason)),
    };
    let status = if !from_present || !to_present {
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
        failure_reason,
    }
}

fn resolve_terminal_reversal(
    snapshot: &GameSnapshot,
    context: RoutingContext<'_>,
    mode: TransitMode,
    service_paths: &[TransitPathResult],
    index: usize,
    spec_count: usize,
    terminal_waypoint_id: &str,
) -> TransitPathResult {
    if mode == TransitMode::Metro {
        return Ok(TransitPath::Track {
            steps: Vec::new(),
            total_travel_seconds: 0.0,
        });
    }
    if mode != TransitMode::Bus || spec_count == 0 {
        return Err(LegFailureReason::NetworkDisconnected);
    }
    let terminal_access =
        stop_access(snapshot, terminal_waypoint_id).ok_or(LegFailureReason::NoRoadAccess)?;
    let previous_index = (index + spec_count - 1) % spec_count;
    let next_index = (index + 1) % spec_count;

    let previous_path = service_paths[previous_index].as_ref().ok();
    let next_path = service_paths[next_index].as_ref().ok();
    let exit_heading = previous_path
        .and_then(road_exit_heading)
        .or_else(|| terminal_heading(context, terminal_access))
        .ok_or(LegFailureReason::NoLegalExitHeading)?;
    let entry_heading = next_path
        .and_then(road_entry_heading)
        .or_else(|| terminal_heading(context, terminal_access))
        .ok_or(LegFailureReason::NoLegalEntryHeading)?;
    context.road_topology.find_terminal_reversal(
        terminal_access.road_point,
        exit_heading,
        entry_heading,
    )
}

fn resolve_spec_service_path(
    snapshot: &GameSnapshot,
    context: RoutingContext<'_>,
    mode: TransitMode,
    spec: &ServiceLegSpec,
) -> TransitPathResult {
    if spec.kind != RouteLegKind::Service {
        return Err(LegFailureReason::NetworkDisconnected);
    }
    resolve_service_path(
        snapshot,
        context,
        mode,
        &spec.from_waypoint_id,
        &spec.to_waypoint_id,
    )
}

fn resolve_service_path(
    snapshot: &GameSnapshot,
    context: RoutingContext<'_>,
    mode: TransitMode,
    from_waypoint_id: &str,
    to_waypoint_id: &str,
) -> TransitPathResult {
    match mode {
        TransitMode::Bus => {
            let from =
                stop_access(snapshot, from_waypoint_id).ok_or(LegFailureReason::NoRoadAccess)?;
            let to = stop_access(snapshot, to_waypoint_id).ok_or(LegFailureReason::NoRoadAccess)?;
            context.road_topology.find_path_between_access_tiles(
                &snapshot.map,
                from.road_point,
                to.road_point,
                from.preferred_heading,
                to.preferred_heading,
            )
        }
        TransitMode::Metro => {
            let from = station_position(snapshot, from_waypoint_id)
                .ok_or(LegFailureReason::NetworkDisconnected)?;
            let to = station_position(snapshot, to_waypoint_id)
                .ok_or(LegFailureReason::NetworkDisconnected)?;
            find_track_path(&snapshot.map, &from, &to).ok_or(LegFailureReason::NetworkDisconnected)
        }
        TransitMode::Walk => Err(LegFailureReason::NetworkDisconnected),
    }
}

fn waypoint_present(snapshot: &GameSnapshot, mode: TransitMode, id: &str) -> bool {
    match mode {
        TransitMode::Bus => snapshot
            .transit
            .stops
            .iter()
            .find(|stop| stop.id == id)
            .is_some_and(|stop| is_present_node(stop.status)),
        TransitMode::Metro => snapshot
            .transit
            .stations
            .iter()
            .find(|station| station.id == id)
            .is_some_and(|station| is_present_node(station.status)),
        TransitMode::Walk => false,
    }
}

fn station_position(snapshot: &GameSnapshot, id: &str) -> Option<Point> {
    snapshot
        .transit
        .stations
        .iter()
        .find(|station| station.id == id && is_present_node(station.status))
        .map(|station| station.position)
}

fn terminal_heading(context: RoutingContext<'_>, access: StopRoadAccess) -> Option<Heading> {
    access.preferred_heading.or_else(|| {
        canonical_headings().into_iter().find(|incoming_heading| {
            canonical_headings().into_iter().any(|outgoing_heading| {
                context
                    .road_topology
                    .transition_for(
                        RoadState {
                            position: access.road_point,
                            incoming_heading: *incoming_heading,
                        },
                        outgoing_heading,
                    )
                    .is_some()
            })
        })
    })
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{RouteLegKind, ServiceDirection};
    use crate::road_topology::RoadTopology;
    use crate::service_itinerary::ServiceLegSpec;
    use crate::state::create_initial_snapshot;

    fn routing_context() -> (GameSnapshot, RoadTopology) {
        let snapshot = create_initial_snapshot();
        let topology = RoadTopology::compile(&snapshot.map).expect("topology compiles");
        (snapshot, topology)
    }

    #[test]
    fn terminal_reversal_with_no_service_specs_reports_network_disconnected() {
        let (snapshot, topology) = routing_context();
        let context = RoutingContext {
            road_topology: &topology,
        };
        let result =
            resolve_terminal_reversal(&snapshot, context, TransitMode::Bus, &[], 0, 0, "stop-001");
        assert_eq!(result.unwrap_err(), LegFailureReason::NetworkDisconnected);
    }

    #[test]
    fn spec_service_path_rejects_a_non_service_leg() {
        let (snapshot, topology) = routing_context();
        let context = RoutingContext {
            road_topology: &topology,
        };
        let spec = ServiceLegSpec {
            from_waypoint_id: "stop-001".to_string(),
            to_waypoint_id: "stop-002".to_string(),
            direction: ServiceDirection::Loop,
            kind: RouteLegKind::TerminalReversal,
        };
        let result = resolve_spec_service_path(&snapshot, context, TransitMode::Bus, &spec);
        assert_eq!(result.unwrap_err(), LegFailureReason::NetworkDisconnected);
    }

    #[test]
    fn service_path_for_walk_mode_reports_network_disconnected() {
        let (snapshot, topology) = routing_context();
        let context = RoutingContext {
            road_topology: &topology,
        };
        let result = resolve_service_path(
            &snapshot,
            context,
            TransitMode::Walk,
            "stop-001",
            "stop-002",
        );
        assert_eq!(result.unwrap_err(), LegFailureReason::NetworkDisconnected);
    }

    #[test]
    fn waypoint_present_is_false_for_walk_mode() {
        let (snapshot, _topology) = routing_context();
        assert!(!waypoint_present(&snapshot, TransitMode::Walk, "stop-001"));
    }
}
