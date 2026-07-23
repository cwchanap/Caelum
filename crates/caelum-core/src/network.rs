use std::collections::{HashMap, VecDeque};

use crate::engine::RoutingContext;
use crate::heading::{canonical_headings, heading_between, offset};
use crate::model::{
    GameMap, GameSnapshot, Heading, MovementKind, PathGeometry, Point, RouteLegKind, RouteLegPath,
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
    let specs = build_service_itinerary(pattern, waypoint_ids);
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
        failure_reason: None,
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
    let exit_heading = road_exit_heading(&previous_path)?;
    let entry_heading = road_entry_heading(&next_path)?;
    // On-road stops reverse at the stop tile. Off-road anchors (roadside stops,
    // bus-terminal buildings) are not RoadStates — reverse on an adjacent road
    // access tile that supports the arrival/departure headings instead.
    //
    // Route between the actual arrival and departure road tiles derived from
    // the bounding service legs. When both legs share the same access tile,
    // this reduces to an in-place reversal (U-turn, roundabout loop, or
    // zero-step on same-heading one-way roads). When they differ, the bus
    // must physically travel from the arrival tile to the departure tile —
    // no zero-step shortcut, and no jumping through an unrelated adjacent
    // road that happens to support a U-turn.
    let arrival = road_path_arrival_tile(&previous_path);
    let departure = next_path.road_steps().first().map(|step| step.position);
    match (arrival, departure) {
        (Some(access), Some(departure_tile)) if access == departure_tile => context
            .road_topology
            .find_terminal_reversal(access, exit_heading, entry_heading)
            .ok(),
        (Some(arrival_tile), Some(departure_tile)) => context.road_topology.find_reversal_between(
            arrival_tile,
            exit_heading,
            departure_tile,
            entry_heading,
        ),
        _ => {
            // Degenerate: a service leg has no road steps (e.g., co-located
            // waypoints). Fall back to adjacent road access tiles, preferring
            // the shared access tile when one can be derived.
            for access in
                terminal_reversal_access_points(snapshot, terminal, &previous_path, &next_path)
            {
                if let Ok(path) = context.road_topology.find_terminal_reversal(
                    access,
                    exit_heading,
                    entry_heading,
                ) {
                    return Some(path);
                }
            }
            None
        }
    }
}

/// Candidate tiles for a terminal reversal, preferring the road access derived
/// from the bounding service legs and falling back to orthogonally adjacent
/// road tiles when the terminal anchor itself is off-network. Preference
/// order is preserved (shared access first, then the terminal tile itself,
/// then remaining adjacent roads in canonical heading order) — the list is
/// not re-sorted by position, so the first candidate that yields a reversal
/// is the most preferred, not an arbitrary one.
fn terminal_reversal_access_points(
    snapshot: &GameSnapshot,
    terminal: Point,
    previous_path: &TransitPath,
    next_path: &TransitPath,
) -> Vec<Point> {
    let mut points = Vec::new();
    if let Some(access) = shared_service_access_tile(previous_path, next_path) {
        if !points.contains(&access) {
            points.push(access);
        }
    }
    if snapshot
        .map
        .tile(terminal)
        .is_some_and(|tile| tile.kind == "road")
        && !points.contains(&terminal)
    {
        points.push(terminal);
    }
    for heading in canonical_headings() {
        let adjacent = offset(terminal, heading);
        if snapshot
            .map
            .tile(adjacent)
            .is_some_and(|tile| tile.kind == "road")
            && !points.contains(&adjacent)
        {
            points.push(adjacent);
        }
    }
    points
}

/// When both bounding service legs touch the same road tile (typical single-
/// access off-road stop), reverse there — that tile is the real RoadState.
fn shared_service_access_tile(
    previous_path: &TransitPath,
    next_path: &TransitPath,
) -> Option<Point> {
    let arrival = road_path_arrival_tile(previous_path)?;
    let departure = next_path.road_steps().first().map(|step| step.position)?;
    (arrival == departure).then_some(arrival)
}

fn road_path_arrival_tile(path: &TransitPath) -> Option<Point> {
    let last = path.road_steps().last()?;
    // Roundabout entry/circulation geometry ends at a half-tile paint point.
    // Derive the actual next RoadState from the heading instead of rounding a
    // midpoint back to the source tile.
    if matches!(
        last.movement,
        MovementKind::RoundaboutEntry | MovementKind::RoundaboutCirculation
    ) {
        return Some(offset(last.position, last.leaving_heading));
    }

    // All other compiled transitions encode their actual destination RoadState
    // in the geometry endpoint. This matters for automatic-junction transitions,
    // which can span multiple footprint tiles rather than ending one tile from
    // `position` (and also covers in-place/junction U-turns and roundabout exits).
    let to = match &last.geometry {
        PathGeometry::Line { to, .. } | PathGeometry::QuadraticBezier { to, .. } => to,
    };
    Some(Point {
        x: to.x.round() as i32,
        y: to.y.round() as i32,
    })
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{MovementKind, RoadPathStep, TripPosition};

    fn step(
        position: (i32, i32),
        entering: Heading,
        leaving: Heading,
        movement: MovementKind,
        to: (f64, f64),
    ) -> RoadPathStep {
        RoadPathStep {
            position: Point {
                x: position.0,
                y: position.1,
            },
            entering_heading: entering,
            leaving_heading: leaving,
            movement,
            geometry: PathGeometry::Line {
                from: TripPosition {
                    x: f64::from(position.0),
                    y: f64::from(position.1),
                },
                to: TripPosition { x: to.0, y: to.1 },
            },
            travel_seconds: 1.0,
        }
    }

    fn road_path(steps: Vec<RoadPathStep>) -> TransitPath {
        TransitPath::Road {
            total_travel_seconds: steps.len() as f64,
            steps,
        }
    }

    #[test]
    fn arrival_tile_derives_from_leaving_heading_not_geometry_midpoint() {
        // Roundabout entry ending at the midpoint between port (6,5) and the
        // ring neighbor (5,5). The midpoint (5.5, 5) rounds to (6, 5) — the
        // source port — but the destination is (5, 5). The arrival must be
        // derived from `leaving_heading` (West), not the paint geometry.
        let path = road_path(vec![step(
            (6, 5),
            Heading::East,
            Heading::West,
            MovementKind::RoundaboutEntry,
            (5.5, 5.0),
        )]);
        assert_eq!(
            road_path_arrival_tile(&path),
            Some(Point { x: 5, y: 5 }),
            "arrival must be the heading-adjacent destination, not the rounded midpoint"
        );
    }

    #[test]
    fn arrival_tile_falls_back_to_position_for_in_place_uturn() {
        // In-place terminal U-turn: position is the terminal and geometry.to
        // equals it. The arrival is the terminal, not the heading-adjacent
        // neighbor the U-turn faces.
        let path = road_path(vec![step(
            (2, 3),
            Heading::East,
            Heading::West,
            MovementKind::UTurn,
            (2.0, 3.0),
        )]);
        assert_eq!(
            road_path_arrival_tile(&path),
            Some(Point { x: 2, y: 3 }),
            "in-place U-turn arrival is the terminal tile itself"
        );
    }

    #[test]
    fn arrival_tile_uses_geometry_for_ordinary_step() {
        let path = road_path(vec![step(
            (4, 5),
            Heading::East,
            Heading::East,
            MovementKind::Straight,
            (5.0, 5.0),
        )]);
        assert_eq!(road_path_arrival_tile(&path), Some(Point { x: 5, y: 5 }));
    }

    #[test]
    fn arrival_tile_uses_structure_geometry_destination_for_multi_tile_turn() {
        // An automatic-junction transition can enter at one footprint port and
        // leave beyond another, so the destination can be multiple tiles from
        // the step's source. This is the Standard Roundabout e2e return leg.
        let path = road_path(vec![step(
            (16, 14),
            Heading::South,
            Heading::East,
            MovementKind::LeftTurn,
            (18.0, 14.0),
        )]);
        assert_eq!(
            road_path_arrival_tile(&path),
            Some(Point { x: 18, y: 14 }),
            "arrival must use the compiled transition destination"
        );
    }
}
