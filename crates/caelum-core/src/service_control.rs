//! Service metrics: Rust-owned cycle time, required-fleet, and nominal
//! headway derivation for transit routes.
//!
//! These numbers are runtime-derived, non-authoritative output. They are
//! published only on output snapshots (see [`populate_snapshot_metrics`] and
//! `GameEngine::snapshot`); the authoritative internal snapshot keeps
//! `service_metrics = None`, and save normalization clears the field so
//! persisted saves never carry a derived cache.

use crate::cost_policy::{CostPolicy, CostedMutation};
use crate::model::{GameSnapshot, Route, ServiceMetrics, TransitMode};
use crate::rejection::{GameplayRejection, GameplayResult, RejectionCode, RejectionContext};
use crate::route_lifecycle::is_route_operational;
use crate::traffic::RoadFlow;
use crate::transit::{initial_vehicle, vehicle_step_seconds};

/// Authoritative floor for `target_headway_seconds` on a transit route.
pub const MIN_HEADWAY_SECONDS: u32 = 60;

#[derive(Clone, Copy, Debug, PartialEq)]
struct ServiceCursor {
    itinerary_index: usize,
    path_step_index: usize,
    step_progress: f64,
}

fn route_rejection(code: RejectionCode, route_id: &str) -> GameplayRejection {
    GameplayRejection {
        code,
        context: RejectionContext {
            route_id: Some(route_id.to_string()),
            ..RejectionContext::default()
        },
    }
}

/// Set the pre-deployment target for a bus route without changing its
/// structural revision or fleet.
pub(crate) fn set_target_headway(
    state: &GameSnapshot,
    route_id: &str,
    target_headway_seconds: u32,
) -> GameplayResult<GameSnapshot> {
    let mut next = state.clone();
    let Some(route) = next
        .transit
        .routes
        .iter_mut()
        .find(|route| route.id == route_id)
    else {
        return Err(route_rejection(RejectionCode::RouteNotFound, route_id));
    };
    if !route.vehicle_ids.is_empty() {
        return Err(route_rejection(
            RejectionCode::FleetAlreadyAssigned,
            route_id,
        ));
    }
    if target_headway_seconds < MIN_HEADWAY_SECONDS {
        return Err(route_rejection(RejectionCode::InvalidHeadway, route_id));
    }
    route.target_headway_seconds = Some(target_headway_seconds);
    Ok(next)
}

/// Buy and place the complete initial bus fleet for a configured route.
/// Authorization happens before any candidate entity is mutated, so a
/// standard-budget rejection cannot leave a partial fleet behind.
pub(crate) fn deploy_bus_fleet(
    state: &GameSnapshot,
    route_id: &str,
) -> GameplayResult<CostedMutation> {
    let route = state
        .transit
        .routes
        .iter()
        .find(|route| route.id == route_id)
        .ok_or_else(|| route_rejection(RejectionCode::RouteNotFound, route_id))?;
    if !route.vehicle_ids.is_empty() {
        return Err(route_rejection(
            RejectionCode::FleetAlreadyAssigned,
            route_id,
        ));
    }
    if !route.active {
        return Err(route_rejection(RejectionCode::InactiveRoute, route_id));
    }
    if !is_route_operational(route.active, &route.legs) {
        return Err(route_rejection(RejectionCode::DisconnectedLeg, route_id));
    }
    let target = route
        .target_headway_seconds
        .ok_or_else(|| route_rejection(RejectionCode::HeadwayNotSet, route_id))?;
    // A direct Rust snapshot can carry a forged small target. Keep the same
    // floor here so it cannot reach required_fleet's intentionally lean math.
    if target < MIN_HEADWAY_SECONDS {
        return Err(route_rejection(RejectionCode::InvalidHeadway, route_id));
    }
    let flow = crate::traffic::derive_road_flow(state);
    let round_trip_seconds = bus_round_trip_seconds(route, &flow)
        .ok_or_else(|| route_rejection(RejectionCode::DisconnectedLeg, route_id))?;
    let required = required_fleet(round_trip_seconds, target);
    let required_i32 =
        i32::try_from(required).map_err(|_| GameplayRejection::budget(i32::MAX, state.budget))?;
    let total_cost = required_i32
        .checked_mul(crate::transit::BUS_COST)
        .ok_or_else(|| GameplayRejection::budget(i32::MAX, state.budget))?;
    let authorized = CostPolicy::from_snapshot(state)
        .quote(total_cost, state.budget)
        .authorize()?;

    let mut candidate = state.clone();
    let mut vehicle_ids = Vec::with_capacity(required);
    for index in 0..required {
        let offset = round_trip_seconds * index as f64 / required as f64;
        let cursor = resolve_service_cursor(route, &flow, offset)
            .ok_or_else(|| route_rejection(RejectionCode::DisconnectedLeg, route_id))?;
        let mut vehicle = initial_vehicle(&candidate, TransitMode::Bus, route_id);
        vehicle.itinerary_index = cursor.itinerary_index;
        vehicle.path_step_index = cursor.path_step_index;
        vehicle.step_progress = cursor.step_progress;
        vehicle_ids.push(vehicle.id.clone());
        candidate.transit.vehicles.push(vehicle);
    }
    candidate
        .transit
        .routes
        .iter_mut()
        .find(|route| route.id == route_id)
        .expect("route was found before candidate construction")
        .vehicle_ids
        .extend(vehicle_ids);
    authorized.apply_to(&mut candidate.budget)?;
    Ok(CostedMutation::new(candidate))
}

/// Derive the service metrics for one bus route. Returns `None` when no
/// positive cycle time is derivable (any leg missing `current_path`, or a
/// walk that sums to zero).
pub(crate) fn metrics(route: &Route, flow: &RoadFlow) -> Option<ServiceMetrics> {
    let round_trip_seconds = bus_round_trip_seconds(route, flow)?;
    let assigned_fleet = route.vehicle_ids.len();
    Some(ServiceMetrics {
        round_trip_seconds,
        assigned_fleet,
        required_fleet: route
            .target_headway_seconds
            .map(|target| required_fleet(round_trip_seconds, target)),
        estimated_deployment_cost: None,
        // Zero fleet means no passenger service: nominal headway is unavailable.
        nominal_headway_seconds: (assigned_fleet > 0)
            .then(|| round_trip_seconds / assigned_fleet as f64),
    })
}

/// `max(1, ceil(round_trip_seconds / target_headway_seconds))`.
pub(crate) fn required_fleet(round_trip_seconds: f64, target_headway_seconds: u32) -> usize {
    ((round_trip_seconds / f64::from(target_headway_seconds)).ceil() as usize).max(1)
}

/// Fill every bus route's `service_metrics` on an output snapshot clone.
/// Derives the `RoadFlow` once and never touches metro lines.
pub(crate) fn populate_snapshot_metrics(snapshot: &mut GameSnapshot) {
    let flow = crate::traffic::derive_road_flow(snapshot);
    for route in &mut snapshot.transit.routes {
        route.service_metrics = metrics(route, &flow);
    }
}

fn resolve_service_cursor(
    route: &Route,
    flow: &RoadFlow,
    offset_seconds: f64,
) -> Option<ServiceCursor> {
    if !offset_seconds.is_finite() || offset_seconds < 0.0 {
        return None;
    }
    let mut remaining = offset_seconds;
    for (itinerary_index, leg) in route.legs.iter().enumerate() {
        let Some(path) = leg.current_path.as_ref() else {
            continue;
        };
        for path_step_index in 0..path.step_count() {
            let Some(step) = path.step(path_step_index) else {
                continue;
            };
            let duration = vehicle_step_seconds(flow, TransitMode::Bus, step);
            if !duration.is_finite() || duration <= 0.0 {
                continue;
            }
            if remaining < duration {
                return Some(ServiceCursor {
                    itinerary_index,
                    path_step_index,
                    step_progress: remaining / duration,
                });
            }
            remaining -= duration;
        }
    }
    None
}

/// One complete cycle over the cyclic `route.legs`, using `current_path` only
/// (never `last_valid_path` or cached `estimated_seconds`) and the same live
/// per-step timing rule vehicle movement uses. Empty terminal reversals
/// contribute zero seconds; non-positive step durations are skipped.
fn bus_round_trip_seconds(route: &Route, flow: &RoadFlow) -> Option<f64> {
    let mut total = 0.0;
    for leg in &route.legs {
        let path = leg.current_path.as_ref()?;
        for step in path.step_refs() {
            let seconds = crate::transit::vehicle_step_seconds(flow, TransitMode::Bus, step);
            if seconds > 0.0 {
                total += seconds;
            }
        }
    }
    (total.is_finite() && total > 0.0).then_some(total)
}

#[cfg(test)]
mod tests {
    use super::{metrics, required_fleet, resolve_service_cursor, ServiceCursor};
    use crate::model::{
        Heading, MovementKind, PathGeometry, Point, RoadPathStep, Route, RouteLegKind,
        RouteLegPath, RouteLegStatus, ServiceDirection, ServicePattern, TransitPath, TripPosition,
    };
    use crate::traffic::RoadFlow;
    use std::collections::BTreeMap;

    fn step(position: (i32, i32), movement: MovementKind, travel_seconds: f64) -> RoadPathStep {
        let position = Point::from(position);
        RoadPathStep {
            position,
            entering_heading: Heading::East,
            leaving_heading: Heading::East,
            movement,
            geometry: PathGeometry::Line {
                from: TripPosition::from(position),
                to: TripPosition::from((position.x + 1, position.y)),
            },
            travel_seconds,
        }
    }

    fn road_path(steps: Vec<RoadPathStep>, stored_total: f64) -> TransitPath {
        TransitPath::Road {
            steps,
            total_travel_seconds: stored_total,
        }
    }

    /// A leg whose `last_valid_path` and cached `estimated_seconds`
    /// deliberately disagree with `current_path`, so any test using it locks
    /// the current-path-only rule.
    fn leg(
        kind: RouteLegKind,
        direction: ServiceDirection,
        from: &str,
        to: &str,
        current: TransitPath,
    ) -> RouteLegPath {
        let disagreeing = road_path(vec![step((40, 40), MovementKind::Straight, 777.0)], 777.0);
        RouteLegPath {
            from_waypoint_id: from.to_string(),
            to_waypoint_id: to.to_string(),
            direction,
            kind,
            status: RouteLegStatus::Connected,
            current_path: Some(current),
            last_valid_path: Some(disagreeing),
            estimated_seconds: Some(999.0),
            failure_reason: None,
        }
    }

    fn route_with_legs(legs: Vec<RouteLegPath>) -> Route {
        Route {
            id: "route-001".to_string(),
            name: "Fixture".to_string(),
            color: "#111111".to_string(),
            stop_ids: vec!["stop-001".to_string(), "stop-002".to_string()],
            vehicle_ids: Vec::new(),
            active: true,
            pattern: ServicePattern::Shuttle,
            revision: 1,
            legs,
            path_broken: false,
            target_headway_seconds: None,
            service_metrics: None,
        }
    }

    #[test]
    fn required_fleet_rounds_up() {
        assert_eq!(required_fleet(600.0, 300), 2);
        assert_eq!(required_fleet(601.0, 300), 3);
        assert_eq!(required_fleet(1.0, 300), 1, "fleet never rounds to zero");
    }

    #[test]
    fn metrics_use_current_path_only() {
        // current_path: 600s. last_valid_path: 777s. estimated_seconds: 999s.
        let route = route_with_legs(vec![leg(
            RouteLegKind::Service,
            ServiceDirection::Outbound,
            "stop-001",
            "stop-002",
            road_path(vec![step((2, 5), MovementKind::Straight, 600.0)], 600.0),
        )]);

        let metrics = metrics(&route, &RoadFlow::new()).expect("connected route has metrics");
        assert_eq!(metrics.round_trip_seconds, 600.0);
        assert_eq!(
            metrics.required_fleet, None,
            "target unset -> required fleet unavailable"
        );
        assert_eq!(
            metrics.nominal_headway_seconds, None,
            "assigned 0 -> nominal headway unavailable"
        );
        assert_eq!(metrics.assigned_fleet, 0);
    }

    #[test]
    fn nominal_headway_divides_cycle_by_assigned_fleet() {
        let mut route = route_with_legs(vec![leg(
            RouteLegKind::Service,
            ServiceDirection::Outbound,
            "stop-001",
            "stop-002",
            road_path(vec![step((2, 5), MovementKind::Straight, 600.0)], 600.0),
        )]);
        route.vehicle_ids = vec!["vehicle-001".to_string(), "vehicle-002".to_string()];
        route.target_headway_seconds = Some(300);

        let metrics = metrics(&route, &RoadFlow::new()).expect("connected route has metrics");
        assert_eq!(metrics.nominal_headway_seconds, Some(300.0));
        assert_eq!(metrics.required_fleet, Some(2));
        assert_eq!(metrics.assigned_fleet, 2);
    }

    /// Shared shuttle vector: the same cyclic walk covers loop and shuttle
    /// routes, with reversal legs following live cursor semantics — empty
    /// terminal reversal `0s`, in-place U-turn at its actual timed step.
    #[test]
    fn shuttle_cycle_skips_empty_reversal_and_times_the_u_turn() {
        let outbound_point = Point::from((2, 5));
        let route = route_with_legs(vec![
            // outbound service: 100s
            leg(
                RouteLegKind::Service,
                ServiceDirection::Outbound,
                "stop-001",
                "stop-002",
                road_path(vec![step((2, 5), MovementKind::Straight, 100.0)], 100.0),
            ),
            // empty terminal reversal: 0s. The stored total (999s) must be
            // ignored — cycle math sums steps, unlike
            // `traffic::effective_road_path_seconds`.
            leg(
                RouteLegKind::TerminalReversal,
                ServiceDirection::Outbound,
                "stop-002",
                "stop-002",
                road_path(Vec::new(), 999.0),
            ),
            // return service: 200s
            leg(
                RouteLegKind::Service,
                ServiceDirection::Return,
                "stop-002",
                "stop-001",
                road_path(vec![step((12, 5), MovementKind::Straight, 200.0)], 200.0),
            ),
            // U-turn reversal: 2s
            leg(
                RouteLegKind::TerminalReversal,
                ServiceDirection::Return,
                "stop-001",
                "stop-001",
                road_path(vec![step((1, 5), MovementKind::UTurn, 2.0)], 2.0),
            ),
        ]);

        let free_flow = metrics(&route, &RoadFlow::new())
            .expect("shuttle route has metrics")
            .round_trip_seconds;
        assert_eq!(free_flow, 302.0, "100 + 0 + 200 + 2");

        let mut congested = BTreeMap::new();
        congested.insert(outbound_point, 8u16);
        let congested = metrics(&route, &congested)
            .expect("shuttle route has metrics")
            .round_trip_seconds;
        assert_eq!(congested, 402.0, "flow 8 over capacity 4 -> 2.0x outbound");
    }

    #[test]
    fn time_offset_lands_inside_an_unequal_loop_step() {
        let route = route_with_legs(vec![leg(
            RouteLegKind::Service,
            ServiceDirection::Outbound,
            "stop-001",
            "stop-002",
            road_path(
                vec![
                    step((2, 5), MovementKind::Straight, 100.0),
                    step((3, 5), MovementKind::Straight, 300.0),
                ],
                400.0,
            ),
        )]);

        let cursor = resolve_service_cursor(&route, &RoadFlow::new(), 200.0)
            .expect("positive cycle has a cursor");
        assert_eq!(
            cursor,
            ServiceCursor {
                itinerary_index: 0,
                path_step_index: 1,
                step_progress: 1.0 / 3.0,
            }
        );
    }

    #[test]
    fn shuttle_offset_skips_empty_reversal_and_enters_return_step() {
        let route = route_with_legs(vec![
            leg(
                RouteLegKind::Service,
                ServiceDirection::Outbound,
                "stop-001",
                "stop-002",
                road_path(vec![step((2, 5), MovementKind::Straight, 100.0)], 100.0),
            ),
            leg(
                RouteLegKind::TerminalReversal,
                ServiceDirection::Outbound,
                "stop-002",
                "stop-002",
                road_path(Vec::new(), 999.0),
            ),
            leg(
                RouteLegKind::Service,
                ServiceDirection::Return,
                "stop-002",
                "stop-001",
                road_path(vec![step((12, 5), MovementKind::Straight, 200.0)], 200.0),
            ),
            leg(
                RouteLegKind::TerminalReversal,
                ServiceDirection::Return,
                "stop-001",
                "stop-001",
                road_path(vec![step((1, 5), MovementKind::UTurn, 2.0)], 2.0),
            ),
        ]);

        let cursor = resolve_service_cursor(&route, &RoadFlow::new(), 151.0)
            .expect("positive cycle has a cursor");
        assert_eq!(cursor.itinerary_index, 2);
        assert_eq!(cursor.path_step_index, 0);
        assert!((cursor.step_progress - 0.255).abs() < 1e-12);
    }

    #[test]
    fn missing_current_path_means_no_metrics() {
        let mut legs = vec![leg(
            RouteLegKind::Service,
            ServiceDirection::Outbound,
            "stop-001",
            "stop-002",
            road_path(vec![step((2, 5), MovementKind::Straight, 100.0)], 100.0),
        )];
        legs.push(RouteLegPath {
            current_path: None,
            ..legs[0].clone()
        });
        let route = route_with_legs(legs);

        assert_eq!(metrics(&route, &RoadFlow::new()), None);
    }
}
