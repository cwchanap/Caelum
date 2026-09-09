use std::cmp::Ordering;
use std::collections::HashMap;

use crate::model::{
    GameSnapshot, Point, RouteLeg, RouteLegPath, RoutePlan, TransitMode, TransitPath,
};
use crate::route_lifecycle::is_route_operational;
use crate::service_itinerary::{enumerate_ride_edges, service_visits, RideEdge};
use crate::traffic::RoadFlow;
use crate::transit::{BUS_TILES_PER_SECOND, METRO_TILES_PER_SECOND};
use crate::transit_nodes::is_present_node;

#[derive(Clone)]
pub(crate) struct TransitService {
    mode: TransitMode,
    line_id: String,
    waypoint_positions: HashMap<String, Point>,
    legs: Vec<RouteLegPath>,
    ride_edges: Vec<RideEdge>,
}

/// OD-independent identity key of one candidate route: transit legs by line
/// id, then board / alight itinerary indexes. Precomputed per route shape so
/// equal-time tie-breaking never allocates during scoring. The empty key (the
/// walking-only candidate) sorts before every transit key.
type IdentityKey = Vec<(String, Option<usize>, Option<usize>)>;

/// One candidate transit itinerary, OD-independent: boarding points, cached
/// ride lookups, and the identity key are known at batch construction. Route
/// shapes carry indexes into `RoutePlanner::services` instead of prepared
/// `RoutePlan`s so scoring a citizen is pure scalar arithmetic.
#[derive(Clone)]
enum RouteShape {
    Direct {
        service_index: usize,
        edge_index: usize,
        board_at: Point,
        alight_at: Point,
        identity_key: IdentityKey,
    },
    Transfer {
        first_service_index: usize,
        first_edge_index: usize,
        second_service_index: usize,
        second_edge_index: usize,
        first_start: Point,
        transfer_first: Point,
        transfer_second: Point,
        second_end: Point,
        transfer_walk_seconds: f64,
        identity_key: IdentityKey,
    },
}

/// Batch-owned transit planner: hoists per-batch work (active services, route
/// shapes, ride-duration cache) out of the per-citizen path and materializes
/// only the winning `RoutePlan`.
pub(crate) struct RoutePlanner {
    map_width: u16,
    map_height: u16,
    services: Vec<TransitService>,
    shapes: Vec<RouteShape>,
    ride_seconds: Vec<Vec<f64>>,
    scored_flow_generation: Option<u64>,
    flow_refreshes: usize,
}

impl RoutePlanner {
    pub(crate) fn new(state: &GameSnapshot) -> Self {
        let services = active_services(state);
        let mut shapes = Vec::new();

        for (service_index, service) in services.iter().enumerate() {
            for edge_index in 0..service.ride_edges.len() {
                let edge = &service.ride_edges[edge_index];
                shapes.push(RouteShape::Direct {
                    service_index,
                    edge_index,
                    board_at: service.waypoint_positions[&edge.board_waypoint_id],
                    alight_at: service.waypoint_positions[&edge.alight_waypoint_id],
                    identity_key: vec![(
                        service.line_id.clone(),
                        Some(edge.board_itinerary_index),
                        Some(edge.alight_itinerary_index),
                    )],
                });
            }
        }

        // Ordered pairs of different services and their ride edges: the same
        // enumeration order the previous per-candidate loop used, so equal-
        // comparator ties still resolve to the first shape.
        for (first_service_index, first) in services.iter().enumerate() {
            for (second_service_index, second) in services.iter().enumerate() {
                if first.line_id == second.line_id {
                    continue;
                }

                for (first_edge_index, first_edge) in first.ride_edges.iter().enumerate() {
                    for (second_edge_index, second_edge) in second.ride_edges.iter().enumerate() {
                        let first_start = first.waypoint_positions[&first_edge.board_waypoint_id];
                        let transfer_first =
                            first.waypoint_positions[&first_edge.alight_waypoint_id];
                        let transfer_second =
                            second.waypoint_positions[&second_edge.board_waypoint_id];
                        let second_end = second.waypoint_positions[&second_edge.alight_waypoint_id];
                        shapes.push(RouteShape::Transfer {
                            first_service_index,
                            first_edge_index,
                            second_service_index,
                            second_edge_index,
                            first_start,
                            transfer_first,
                            transfer_second,
                            second_end,
                            transfer_walk_seconds: walk_seconds(&transfer_first, &transfer_second),
                            identity_key: vec![
                                (
                                    first.line_id.clone(),
                                    Some(first_edge.board_itinerary_index),
                                    Some(first_edge.alight_itinerary_index),
                                ),
                                (
                                    second.line_id.clone(),
                                    Some(second_edge.board_itinerary_index),
                                    Some(second_edge.alight_itinerary_index),
                                ),
                            ],
                        });
                    }
                }
            }
        }

        Self {
            map_width: u16::from(state.map.width),
            map_height: u16::from(state.map.height),
            ride_seconds: services.iter().map(|_| Vec::new()).collect(),
            services,
            shapes,
            scored_flow_generation: None,
            flow_refreshes: 0,
        }
    }

    pub(crate) fn find_route_plan(
        &mut self,
        flow: &RoadFlow,
        flow_generation: u64,
        origin: Point,
        destination: Point,
    ) -> Option<RoutePlan> {
        if !self.is_inside_map(&origin) || !self.is_inside_map(&destination) {
            return None;
        }
        self.refresh_ride_seconds(flow, flow_generation);

        // Walking-only seed with the empty identity key: it keeps today's tie
        // behavior because an empty key sorts before every transit key.
        let mut best_seconds = walk_seconds(&origin, &destination);
        let mut best_shape: Option<usize> = None;
        let mut best_key: &[(String, Option<usize>, Option<usize>)] = &[];

        // Enumeration order matches the previous candidate push order (walk,
        // direct, transfers), and only a strictly better comparator replaces
        // the incumbent — the same first-wins rule `min_by` applied.
        for (shape_index, shape) in self.shapes.iter().enumerate() {
            let seconds = self.shape_seconds(shape, &origin, &destination);
            let key = Self::shape_key(shape);
            if seconds
                .total_cmp(&best_seconds)
                .then_with(|| key.cmp(best_key))
                == Ordering::Less
            {
                best_seconds = seconds;
                best_key = key;
                best_shape = Some(shape_index);
            }
        }

        Some(self.materialize_winner(best_shape, best_seconds, &origin, &destination))
    }

    /// Re-score cached ride durations against `flow`. The first refresh
    /// populates every service/edge; later refreshes recompute only the
    /// flow-sensitive Bus edges and retain stable Metro values. Same-generation
    /// scoring reuses the cache untouched.
    fn refresh_ride_seconds(&mut self, flow: &RoadFlow, flow_generation: u64) {
        if self.scored_flow_generation == Some(flow_generation) {
            return;
        }
        let first_refresh = self.scored_flow_generation.is_none();
        for (service_index, service) in self.services.iter().enumerate() {
            if !first_refresh && service.mode != TransitMode::Bus {
                continue;
            }
            let cache = &mut self.ride_seconds[service_index];
            for (edge_index, edge) in service.ride_edges.iter().enumerate() {
                let seconds = ride_seconds(flow, service.mode, &service.legs, edge);
                if first_refresh {
                    cache.push(seconds);
                } else {
                    cache[edge_index] = seconds;
                }
            }
        }
        self.scored_flow_generation = Some(flow_generation);
        self.flow_refreshes += 1;
    }

    /// Scalar estimate for one shape: cached rides plus per-citizen walk
    /// terms, in the same addition order as the previous per-candidate
    /// estimates so equal-time comparisons stay bit-exact.
    fn shape_seconds(&self, shape: &RouteShape, origin: &Point, destination: &Point) -> f64 {
        match shape {
            RouteShape::Direct {
                service_index,
                edge_index,
                board_at,
                alight_at,
                ..
            } => {
                walk_seconds(origin, board_at)
                    + self.ride_seconds[*service_index][*edge_index]
                    + walk_seconds(alight_at, destination)
            }
            RouteShape::Transfer {
                first_service_index,
                first_edge_index,
                second_service_index,
                second_edge_index,
                first_start,
                transfer_walk_seconds,
                second_end,
                ..
            } => {
                walk_seconds(origin, first_start)
                    + self.ride_seconds[*first_service_index][*first_edge_index]
                    + *transfer_walk_seconds
                    + self.ride_seconds[*second_service_index][*second_edge_index]
                    + walk_seconds(second_end, destination)
            }
        }
    }

    fn shape_key(shape: &RouteShape) -> &[(String, Option<usize>, Option<usize>)] {
        match shape {
            RouteShape::Direct { identity_key, .. } | RouteShape::Transfer { identity_key, .. } => {
                identity_key
            }
        }
    }

    /// The only `RoutePlan` allocated per citizen: the scored winner.
    fn materialize_winner(
        &self,
        best_shape: Option<usize>,
        best_seconds: f64,
        origin: &Point,
        destination: &Point,
    ) -> RoutePlan {
        let Some(shape_index) = best_shape else {
            return RoutePlan {
                legs: vec![walk_leg(origin, destination)],
                estimated_seconds: best_seconds,
            };
        };
        match &self.shapes[shape_index] {
            RouteShape::Direct {
                service_index,
                edge_index,
                board_at,
                alight_at,
                ..
            } => {
                let service = &self.services[*service_index];
                let edge = &service.ride_edges[*edge_index];
                RoutePlan {
                    legs: vec![
                        walk_leg(origin, board_at),
                        transit_leg(service, edge, board_at, alight_at),
                        walk_leg(alight_at, destination),
                    ],
                    estimated_seconds: best_seconds,
                }
            }
            RouteShape::Transfer {
                first_service_index,
                first_edge_index,
                second_service_index,
                second_edge_index,
                first_start,
                transfer_first,
                transfer_second,
                second_end,
                ..
            } => {
                let first = &self.services[*first_service_index];
                let first_edge = &first.ride_edges[*first_edge_index];
                let second = &self.services[*second_service_index];
                let second_edge = &second.ride_edges[*second_edge_index];
                RoutePlan {
                    legs: vec![
                        walk_leg(origin, first_start),
                        transit_leg(first, first_edge, first_start, transfer_first),
                        walk_leg(transfer_first, transfer_second),
                        transit_leg(second, second_edge, transfer_second, second_end),
                        walk_leg(second_end, destination),
                    ],
                    estimated_seconds: best_seconds,
                }
            }
        }
    }

    fn is_inside_map(&self, point: &Point) -> bool {
        point.x >= 0
            && point.x < i32::from(self.map_width)
            && point.y >= 0
            && point.y < i32::from(self.map_height)
    }

    pub(crate) fn service_count(&self) -> usize {
        self.services.len()
    }

    pub(crate) fn shape_count(&self) -> usize {
        self.shapes.len()
    }

    pub(crate) fn flow_refresh_count(&self) -> usize {
        self.flow_refreshes
    }
}

pub fn find_route_plan(
    state: &GameSnapshot,
    flow: &RoadFlow,
    origin: &Point,
    destination: &Point,
) -> Option<RoutePlan> {
    let mut planner = RoutePlanner::new(state);
    planner.find_route_plan(flow, 0, *origin, *destination)
}

/// Plan a multi-modal commute route from `origin` to `destination`.
///
/// Uses precomputed `leg.current_path` steps from the snapshot's route/metro-line
/// legs — no live topology compilation is needed.
pub fn plan_route(
    state: &GameSnapshot,
    flow: &RoadFlow,
    origin: &Point,
    destination: &Point,
) -> Option<RoutePlan> {
    find_route_plan(state, flow, origin, destination)
}

pub(crate) fn active_services(state: &GameSnapshot) -> Vec<TransitService> {
    let mut services = Vec::new();

    for route in &state.transit.routes {
        if !is_route_operational(route.active, &route.legs) {
            continue;
        }
        // Zero fleet means no passenger service: the route stays structurally
        // operational and editable, but passengers cannot plan on a service
        // that cannot arrive.
        if route.vehicle_ids.is_empty() {
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
        if !is_route_operational(line.active, &line.legs) || line.vehicle_ids.is_empty() {
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

fn ride_seconds(flow: &RoadFlow, mode: TransitMode, legs: &[RouteLegPath], edge: &RideEdge) -> f64 {
    if legs.is_empty() {
        return boarding_seconds(mode);
    }
    boarding_seconds(mode)
        + edge
            .itinerary_leg_indexes
            .iter()
            .map(|index| leg_travel_seconds(flow, mode, &legs[*index]))
            .sum::<f64>()
}

fn leg_travel_seconds(flow: &RoadFlow, mode: TransitMode, leg: &RouteLegPath) -> f64 {
    leg.current_path
        .as_ref()
        .map(|path| match (mode, path) {
            (TransitMode::Bus, TransitPath::Road { .. }) => {
                crate::traffic::effective_road_path_seconds(flow, path)
            }
            (_, path) => path.total_travel_seconds(),
        })
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
    f64::from(manhattan_distance(from, to)) * crate::commute::WALK_SECONDS_PER_TILE
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::GameEngine;
    use crate::intent::GameIntent;
    use crate::model::ServicePattern;

    fn point(x: i32, y: i32) -> Point {
        Point { x, y }
    }

    fn road_line(engine: &mut GameEngine, y: i32, from_x: i32, to_x: i32) {
        for x in from_x..=to_x {
            engine.dispatch(GameIntent::LayRoad {
                point: (x, y).into(),
            });
        }
    }

    fn track_line(engine: &mut GameEngine, y: i32, from_x: i32, to_x: i32) {
        for x in from_x..=to_x {
            engine.dispatch(GameIntent::LayTrack {
                point: (x, y).into(),
            });
        }
    }

    fn create_loop_route(engine: &mut GameEngine, mode: TransitMode, waypoint_ids: Vec<String>) {
        let created = engine.dispatch(GameIntent::CreateRoute {
            mode,
            pattern: ServicePattern::Loop,
            waypoint_ids,
        });
        assert!(created.applied, "fixture route should apply: {created:?}");
    }

    fn assign_vehicle(engine: &mut GameEngine, mode: &str, line_id: &str) {
        let assigned = engine.dispatch(GameIntent::AssignVehicle {
            mode: mode.to_string(),
            line_id: line_id.to_string(),
        });
        assert!(
            assigned.applied,
            "fixture vehicle should apply: {assigned:?}"
        );
    }

    fn bus_route_engine() -> GameEngine {
        let mut engine = GameEngine::new();
        road_line(&mut engine, 5, 2, 12);
        engine.dispatch(GameIntent::AddBusStop { point: point(2, 4) });
        engine.dispatch(GameIntent::AddBusStop {
            point: point(12, 4),
        });
        create_loop_route(
            &mut engine,
            TransitMode::Bus,
            vec!["stop-001".into(), "stop-002".into()],
        );
        assign_vehicle(&mut engine, "bus", "route-001");
        engine
    }

    fn bus_and_metro_engine() -> GameEngine {
        let mut engine = bus_route_engine();
        track_line(&mut engine, 8, 2, 12);
        engine.dispatch(GameIntent::AddMetroStation { point: point(2, 8) });
        engine.dispatch(GameIntent::AddMetroStation {
            point: point(12, 8),
        });
        create_loop_route(
            &mut engine,
            TransitMode::Metro,
            vec!["station-001".into(), "station-002".into()],
        );
        assign_vehicle(&mut engine, "metro", "metro-001");
        engine
    }

    /// Flow that congests every road tile of the fixture bus path to 3x the
    /// per-tile car capacity (12 cars vs a capacity of 4 -> max multiplier).
    fn congested_bus_flow(state: &GameSnapshot) -> RoadFlow {
        let path = state.transit.routes[0].legs[0]
            .current_path
            .clone()
            .expect("bus fixture has a captured road path");
        let TransitPath::Road { steps, .. } = &path else {
            panic!("bus fixture path is a road path");
        };
        let mut flow = RoadFlow::new();
        for step in steps {
            flow.insert(step.position, 12);
        }
        flow
    }

    #[test]
    fn planner_matches_one_shot_bus_and_metro_plans() {
        let state = bus_and_metro_engine().snapshot();
        let mut planner = RoutePlanner::new(&state);
        let empty_flow = RoadFlow::new();
        let ods = [
            (point(1, 4), point(13, 4)),
            (point(1, 8), point(13, 8)),
            (point(2, 4), point(12, 8)),
            (point(5, 6), point(9, 7)),
        ];
        for (origin, destination) in ods {
            assert_eq!(
                planner.find_route_plan(&empty_flow, 0, origin, destination),
                find_route_plan(&state, &empty_flow, &origin, &destination),
                "planner must match the one-shot wrapper for {origin:?} -> {destination:?}"
            );
        }

        let congested = congested_bus_flow(&state);
        let mut congested_planner = RoutePlanner::new(&state);
        assert_eq!(
            congested_planner.find_route_plan(&congested, 0, point(1, 4), point(13, 4)),
            find_route_plan(&state, &congested, &point(1, 4), &point(13, 4)),
            "planner must match the one-shot wrapper under live road flow"
        );
    }

    #[test]
    fn planner_counts_stay_stable_across_od_scores() {
        let state = bus_and_metro_engine().snapshot();
        let mut planner = RoutePlanner::new(&state);
        // Each 2-stop Loop route enumerates 2 ride edges: 4 direct shapes plus
        // 2 ordered service pairs x 2 x 2 edge pairs = 8 transfer shapes.
        assert_eq!(planner.service_count(), 2);
        assert_eq!(planner.shape_count(), 12);

        let flow = RoadFlow::new();
        let ods = [
            (point(1, 4), point(13, 4)),
            (point(1, 8), point(13, 8)),
            (point(2, 4), point(12, 8)),
            (point(12, 8), point(2, 4)),
            (point(5, 6), point(9, 7)),
            (point(0, 0), point(27, 17)),
            (point(7, 5), point(8, 5)),
            (point(26, 16), point(1, 1)),
        ];
        for (origin, destination) in ods {
            planner.find_route_plan(&flow, 0, origin, destination);
            assert_eq!(planner.service_count(), 2);
            assert_eq!(planner.shape_count(), 12);
        }
    }

    #[test]
    fn repeated_scores_at_same_flow_generation_do_not_refresh() {
        let state = bus_route_engine().snapshot();
        let mut planner = RoutePlanner::new(&state);
        let flow = RoadFlow::new();

        planner.find_route_plan(&flow, 7, point(1, 4), point(13, 4));
        assert_eq!(planner.flow_refresh_count(), 1);

        planner.find_route_plan(&flow, 7, point(5, 5), point(9, 5));
        assert_eq!(
            planner.flow_refresh_count(),
            1,
            "same flow generation must reuse cached ride durations"
        );
    }

    #[test]
    fn flow_generation_bump_with_changed_flow_refreshes_once_and_moves_bus_eta() {
        let state = bus_route_engine().snapshot();
        let mut planner = RoutePlanner::new(&state);
        let light = RoadFlow::new();
        let light_plan = planner
            .find_route_plan(&light, 0, point(1, 4), point(13, 4))
            .expect("bus route should be planned");
        assert_eq!(light_plan.legs[1].line_id.as_deref(), Some("route-001"));

        let congested = congested_bus_flow(&state);
        let congested_plan = planner
            .find_route_plan(&congested, 1, point(1, 4), point(13, 4))
            .expect("bus route should be planned under congestion");
        assert_eq!(
            planner.flow_refresh_count(),
            2,
            "exactly one refresh for the new flow generation"
        );
        assert!(
            congested_plan.estimated_seconds > light_plan.estimated_seconds,
            "congestion must move the bus ETA"
        );
        assert_eq!(
            congested_plan,
            find_route_plan(&state, &congested, &point(1, 4), &point(13, 4))
                .expect("bus route should be planned by the one-shot wrapper"),
            "refreshed cache must match live scoring"
        );
    }

    #[test]
    fn equal_time_ties_follow_identity_key_order_not_enumeration_order() {
        let mut engine = bus_route_engine();
        create_loop_route(
            &mut engine,
            TransitMode::Bus,
            vec!["stop-001".into(), "stop-002".into()],
        );
        assign_vehicle(&mut engine, "bus", "route-002");
        let mut state = engine.snapshot();
        // Identical geometry => identical estimates, so the winner is decided
        // by the identity key. Enumerate route-002 first to prove key ordering,
        // not snapshot order, picks route-001.
        state.transit.routes.reverse();

        let mut planner = RoutePlanner::new(&state);
        let flow = RoadFlow::new();
        let plan = planner
            .find_route_plan(&flow, 0, point(1, 4), point(13, 4))
            .expect("twin routes should be planned");
        assert_eq!(
            plan.legs[1].line_id.as_deref(),
            Some("route-001"),
            "smaller identity key wins the equal-time tie despite being enumerated second"
        );
        assert_eq!(
            plan,
            find_route_plan(&state, &flow, &point(1, 4), &point(13, 4))
                .expect("twin routes should be planned by the one-shot wrapper"),
            "tie behavior must match the public one-shot wrapper"
        );
    }
}
