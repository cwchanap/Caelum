use crate::model::{GameSnapshot, Point, RouteLeg, RoutePlan, TransitMode};
use crate::transit::{BUS_TILES_PER_SECOND, METRO_TILES_PER_SECOND};

#[derive(Clone)]
struct TransitService {
    mode: TransitMode,
    line_id: String,
    anchors: Vec<Point>,
    segments: Vec<Vec<Point>>,
}

pub fn find_route_plan(
    state: &GameSnapshot,
    origin: &Point,
    destination: &Point,
) -> Option<RoutePlan> {
    if !is_inside_map(state, origin) || !is_inside_map(state, destination) {
        return None;
    }

    let mut candidates = vec![RoutePlan {
        legs: vec![walk_leg(origin, destination)],
        estimated_seconds: walk_seconds(origin, destination),
    }];
    let services = active_services(state);

    for service in &services {
        for board_index in 0..service.anchors.len() {
            for alight_index in 0..service.anchors.len() {
                if board_index == alight_index {
                    continue;
                }

                let board_at = &service.anchors[board_index];
                let alight_at = &service.anchors[alight_index];
                let steps = ride_steps(&service.segments, board_index, alight_index);

                candidates.push(RoutePlan {
                    legs: vec![
                        walk_leg(origin, board_at),
                        transit_leg(service.mode, board_at, alight_at, &service.line_id),
                        walk_leg(alight_at, destination),
                    ],
                    estimated_seconds: walk_seconds(origin, board_at)
                        + ride_seconds(service.mode, steps)
                        + walk_seconds(alight_at, destination),
                });
            }
        }
    }

    for first in &services {
        for second in &services {
            if first.line_id == second.line_id {
                continue;
            }

            let first_start_index = nearest_anchor_index(&first.anchors, origin);
            let second_end_index = nearest_anchor_index(&second.anchors, destination);
            let Some((transfer_first_index, transfer_second_index)) =
                best_transfer_indexes(first, second)
            else {
                continue;
            };
            let Some(first_start_index) = first_start_index else {
                continue;
            };
            let Some(second_end_index) = second_end_index else {
                continue;
            };

            let first_start = &first.anchors[first_start_index];
            let second_end = &second.anchors[second_end_index];
            let transfer_first = &first.anchors[transfer_first_index];
            let transfer_second = &second.anchors[transfer_second_index];
            let first_steps = ride_steps(&first.segments, first_start_index, transfer_first_index);
            let second_steps =
                ride_steps(&second.segments, transfer_second_index, second_end_index);

            candidates.push(RoutePlan {
                legs: vec![
                    walk_leg(origin, first_start),
                    transit_leg(first.mode, first_start, transfer_first, &first.line_id),
                    walk_leg(transfer_first, transfer_second),
                    transit_leg(second.mode, transfer_second, second_end, &second.line_id),
                    walk_leg(second_end, destination),
                ],
                estimated_seconds: walk_seconds(origin, first_start)
                    + ride_seconds(first.mode, first_steps)
                    + walk_seconds(transfer_first, transfer_second)
                    + ride_seconds(second.mode, second_steps)
                    + walk_seconds(second_end, destination),
            });
        }
    }

    best_candidate(candidates)
}

fn active_services(state: &GameSnapshot) -> Vec<TransitService> {
    let mut services = Vec::new();

    for route in &state.transit.routes {
        if !route.active || route.path_broken {
            continue;
        }

        let anchors: Vec<Point> = route
            .stop_ids
            .iter()
            .filter_map(|stop_id| {
                state
                    .transit
                    .stops
                    .iter()
                    .find(|stop| stop.id == *stop_id)
                    .map(|stop| stop.position.clone())
            })
            .collect();

        if anchors.len() >= 2 && anchors.len() == route.stop_ids.len() {
            services.push(TransitService {
                mode: TransitMode::Bus,
                line_id: route.id.clone(),
                anchors,
                segments: route.segments.clone(),
            });
        }
    }

    for line in &state.transit.metro_lines {
        if !line.active || line.path_broken {
            continue;
        }

        let anchors: Vec<Point> = line
            .station_ids
            .iter()
            .filter_map(|station_id| {
                state
                    .transit
                    .stations
                    .iter()
                    .find(|station| station.id == *station_id)
                    .map(|station| station.position.clone())
            })
            .collect();

        if anchors.len() >= 2 && anchors.len() == line.station_ids.len() {
            services.push(TransitService {
                mode: TransitMode::Metro,
                line_id: line.id.clone(),
                anchors,
                segments: line.segments.clone(),
            });
        }
    }

    services
}

fn best_candidate(candidates: Vec<RoutePlan>) -> Option<RoutePlan> {
    let mut best: Option<RoutePlan> = None;

    for candidate in candidates {
        if best.as_ref().map_or(true, |current| {
            candidate.estimated_seconds < current.estimated_seconds
        }) {
            best = Some(candidate);
        }
    }

    best
}

fn nearest_anchor_index(anchors: &[Point], target: &Point) -> Option<usize> {
    let mut nearest_index = None;
    let mut nearest_distance = i32::MAX;

    for (index, anchor) in anchors.iter().enumerate() {
        let distance = manhattan_distance(anchor, target);
        if distance < nearest_distance {
            nearest_distance = distance;
            nearest_index = Some(index);
        }
    }

    nearest_index
}

fn best_transfer_indexes(
    first: &TransitService,
    second: &TransitService,
) -> Option<(usize, usize)> {
    let mut best: Option<(usize, usize, i32)> = None;

    for (first_index, first_anchor) in first.anchors.iter().enumerate() {
        for (second_index, second_anchor) in second.anchors.iter().enumerate() {
            let distance = manhattan_distance(first_anchor, second_anchor);
            if best
                .as_ref()
                .map_or(true, |(_, _, best_distance)| distance < *best_distance)
            {
                best = Some((first_index, second_index, distance));
            }
        }
    }

    best.map(|(first_index, second_index, _)| (first_index, second_index))
}

fn ride_steps(segments: &[Vec<Point>], from_index: usize, to_index: usize) -> usize {
    let count = segments.len();
    if count == 0 || from_index == to_index {
        return 0;
    }

    let mut steps = 0;
    let mut index = from_index;
    while index != to_index {
        steps += (segments[index].len()).saturating_sub(1).max(1);
        index = (index + 1) % count;
    }

    steps
}

fn ride_seconds(mode: TransitMode, steps: usize) -> f64 {
    let speed = if mode == TransitMode::Bus {
        BUS_TILES_PER_SECOND
    } else {
        METRO_TILES_PER_SECOND
    };
    let boarding = if mode == TransitMode::Bus {
        90.0
    } else {
        120.0
    };
    boarding + steps as f64 / speed
}

fn walk_seconds(from: &Point, to: &Point) -> f64 {
    f64::from(manhattan_distance(from, to)) * 20.0
}

fn manhattan_distance(from: &Point, to: &Point) -> i32 {
    (from.x - to.x).abs() + (from.y - to.y).abs()
}

fn walk_leg(from: &Point, to: &Point) -> RouteLeg {
    RouteLeg {
        mode: TransitMode::Walk,
        from: from.clone(),
        to: to.clone(),
        line_id: None,
    }
}

fn transit_leg(mode: TransitMode, from: &Point, to: &Point, line_id: &str) -> RouteLeg {
    RouteLeg {
        mode,
        from: from.clone(),
        to: to.clone(),
        line_id: Some(line_id.to_string()),
    }
}

fn is_inside_map(state: &GameSnapshot, point: &Point) -> bool {
    point.x >= 0
        && point.x < i32::from(state.map.width)
        && point.y >= 0
        && point.y < i32::from(state.map.height)
}
