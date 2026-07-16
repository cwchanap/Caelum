use std::collections::HashMap;

use crate::model::{GameSnapshot, Point, RouteLeg, RouteLegPath, RoutePlan, TransitMode};
use crate::route_lifecycle::is_route_operational;
use crate::service_itinerary::{enumerate_ride_edges, service_visits, RideEdge};
use crate::transit::{BUS_TILES_PER_SECOND, METRO_TILES_PER_SECOND};
use crate::transit_nodes::is_present_node;

#[derive(Clone)]
struct TransitService {
    mode: TransitMode,
    line_id: String,
    waypoint_positions: HashMap<String, Point>,
    legs: Vec<RouteLegPath>,
    ride_edges: Vec<RideEdge>,
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
        for edge in &service.ride_edges {
            let board_at = &service.waypoint_positions[&edge.board_waypoint_id];
            let alight_at = &service.waypoint_positions[&edge.alight_waypoint_id];
            candidates.push(RoutePlan {
                legs: vec![
                    walk_leg(origin, board_at),
                    transit_leg(service, edge, board_at, alight_at),
                    walk_leg(alight_at, destination),
                ],
                estimated_seconds: walk_seconds(origin, board_at)
                    + ride_seconds(service.mode, &service.legs, edge)
                    + walk_seconds(alight_at, destination),
            });
        }
    }

    // Two-transfer plans: O(S^2 x E1 x E2) candidates, each allocating one
    // RoutePlan. S is the number of active services (player-authored routes,
    // bounded by map size) and E is the ride-edge count per service (bounded
    // by ordered stop pairs). No explicit cap is enforced; the ceiling is
    // naturally bounded by the number of routes/stops the player can place on
    // a 28x18 map. Revisit if route counts grow.
    for first in &services {
        for second in &services {
            if first.line_id == second.line_id {
                continue;
            }

            for first_edge in &first.ride_edges {
                for second_edge in &second.ride_edges {
                    let first_start = &first.waypoint_positions[&first_edge.board_waypoint_id];
                    let transfer_first = &first.waypoint_positions[&first_edge.alight_waypoint_id];
                    let transfer_second =
                        &second.waypoint_positions[&second_edge.board_waypoint_id];
                    let second_end = &second.waypoint_positions[&second_edge.alight_waypoint_id];
                    candidates.push(RoutePlan {
                        legs: vec![
                            walk_leg(origin, first_start),
                            transit_leg(first, first_edge, first_start, transfer_first),
                            walk_leg(transfer_first, transfer_second),
                            transit_leg(second, second_edge, transfer_second, second_end),
                            walk_leg(second_end, destination),
                        ],
                        estimated_seconds: walk_seconds(origin, first_start)
                            + ride_seconds(first.mode, &first.legs, first_edge)
                            + walk_seconds(transfer_first, transfer_second)
                            + ride_seconds(second.mode, &second.legs, second_edge)
                            + walk_seconds(second_end, destination),
                    });
                }
            }
        }
    }

    best_candidate(candidates)
}

/// Plan a multi-modal commute route from `origin` to `destination`.
///
/// Uses precomputed `leg.current_path` steps from the snapshot's route/metro-line
/// legs — no live topology compilation is needed.
pub fn plan_route(state: &GameSnapshot, origin: &Point, destination: &Point) -> Option<RoutePlan> {
    find_route_plan(state, origin, destination)
}

fn active_services(state: &GameSnapshot) -> Vec<TransitService> {
    let mut services = Vec::new();

    for route in &state.transit.routes {
        if !is_route_operational(route.active, &route.legs) {
            continue;
        }

        let waypoint_positions: HashMap<String, Point> = route
            .stop_ids
            .iter()
            .filter_map(|stop_id| {
                state
                    .transit
                    .stops
                    .iter()
                    .find(|stop| stop.id == *stop_id && is_present_node(stop.status))
                    .map(|stop| (stop_id.clone(), stop.position))
            })
            .collect();

        if waypoint_positions.len() >= 2 && waypoint_positions.len() == route.stop_ids.len() {
            let visits = service_visits(&route.stop_ids, &route.legs);
            services.push(TransitService {
                mode: TransitMode::Bus,
                line_id: route.id.clone(),
                waypoint_positions,
                ride_edges: enumerate_ride_edges(&visits, &route.legs),
                legs: route.legs.clone(),
            });
        }
    }

    for line in &state.transit.metro_lines {
        if !is_route_operational(line.active, &line.legs) {
            continue;
        }

        let waypoint_positions: HashMap<String, Point> = line
            .station_ids
            .iter()
            .filter_map(|station_id| {
                state
                    .transit
                    .stations
                    .iter()
                    .find(|station| station.id == *station_id && is_present_node(station.status))
                    .map(|station| (station_id.clone(), station.position))
            })
            .collect();

        if waypoint_positions.len() >= 2 && waypoint_positions.len() == line.station_ids.len() {
            let visits = service_visits(&line.station_ids, &line.legs);
            services.push(TransitService {
                mode: TransitMode::Metro,
                line_id: line.id.clone(),
                waypoint_positions,
                ride_edges: enumerate_ride_edges(&visits, &line.legs),
                legs: line.legs.clone(),
            });
        }
    }

    services
}

fn best_candidate(candidates: Vec<RoutePlan>) -> Option<RoutePlan> {
    let mut best: Option<RoutePlan> = None;

    for candidate in candidates {
        // Strict `<` is a deterministic first-found tie-break (snapshot/enumeration order); intentionally simpler than the road pathfinder's canonical tie-break.
        if best.as_ref().map_or(true, |current| {
            candidate.estimated_seconds < current.estimated_seconds
        }) {
            best = Some(candidate);
        }
    }

    best
}

fn ride_seconds(mode: TransitMode, legs: &[RouteLegPath], edge: &RideEdge) -> f64 {
    if legs.is_empty() {
        return boarding_seconds(mode);
    }
    boarding_seconds(mode)
        + edge
            .itinerary_leg_indexes
            .iter()
            .map(|index| leg_travel_seconds(mode, &legs[*index]))
            .sum::<f64>()
}

fn leg_travel_seconds(mode: TransitMode, leg: &RouteLegPath) -> f64 {
    leg.current_path
        .as_ref()
        .map(|path| path.total_travel_seconds())
        .or(leg.estimated_seconds)
        .unwrap_or_else(|| {
            1.0 / if mode == TransitMode::Bus {
                BUS_TILES_PER_SECOND
            } else {
                METRO_TILES_PER_SECOND
            }
        })
}

fn boarding_seconds(mode: TransitMode) -> f64 {
    if mode == TransitMode::Bus {
        90.0
    } else {
        120.0
    }
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
        from: *from,
        to: *to,
        line_id: None,
        service_direction: None,
        board_itinerary_index: None,
        alight_itinerary_index: None,
    }
}

fn transit_leg(service: &TransitService, edge: &RideEdge, from: &Point, to: &Point) -> RouteLeg {
    RouteLeg {
        mode: service.mode,
        from: *from,
        to: *to,
        line_id: Some(service.line_id.clone()),
        service_direction: Some(edge.service_direction),
        board_itinerary_index: Some(edge.board_itinerary_index),
        alight_itinerary_index: Some(edge.alight_itinerary_index),
    }
}

fn is_inside_map(state: &GameSnapshot, point: &Point) -> bool {
    point.x >= 0
        && point.x < i32::from(state.map.width)
        && point.y >= 0
        && point.y < i32::from(state.map.height)
}
