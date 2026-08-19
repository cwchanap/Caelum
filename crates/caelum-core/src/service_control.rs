//! Service metrics: Rust-owned cycle time, required-fleet, and nominal
//! headway derivation for transit routes.
//!
//! These numbers are runtime-derived, non-authoritative output. They are
//! published only on output snapshots (see [`populate_snapshot_metrics`] and
//! `GameEngine::snapshot`); the authoritative internal snapshot keeps
//! `service_metrics = None`, and save normalization clears the field so
//! persisted saves never carry a derived cache.

use std::cmp::Ordering;
use std::collections::HashMap;

use crate::cost_policy::{CostPolicy, CostedMutation};
use crate::model::{GameSnapshot, RouteLegPath, ServiceMetrics, TransitMode, Vehicle};
use crate::platforms::platform_waiters_by_line;
use crate::rejection::{GameplayRejection, GameplayResult, RejectionCode, RejectionContext};
use crate::route_lifecycle::is_route_operational;
use crate::traffic::RoadFlow;
use crate::transit::{append_vehicle_costed, initial_vehicle, vehicle_cost, vehicle_step_seconds};
use crate::trips::current_leg_wait_seconds;

/// Authoritative floor for `target_headway_seconds` on a transit route.
pub const MIN_HEADWAY_SECONDS: u32 = 60;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct WaitingHealth {
    waiting_at_risk_count: usize,
    longest_wait_seconds: Option<f64>,
}

fn waiting_health_by_line(state: &GameSnapshot) -> HashMap<String, WaitingHealth> {
    let targets: HashMap<&str, u32> = state
        .transit
        .routes
        .iter()
        .filter_map(|route| {
            route
                .target_headway_seconds
                .map(|target| (route.id.as_str(), target))
        })
        .chain(state.transit.metro_lines.iter().filter_map(|line| {
            line.target_headway_seconds
                .map(|target| (line.id.as_str(), target))
        }))
        .collect();

    let mut health = HashMap::new();
    for (line_id, waiters) in platform_waiters_by_line(state) {
        let Some(target) = targets.get(line_id.as_str()).copied() else {
            continue;
        };
        let mut line_health = WaitingHealth::default();
        for trip in waiters {
            let wait_seconds = current_leg_wait_seconds(trip);
            line_health.longest_wait_seconds = Some(
                line_health
                    .longest_wait_seconds
                    .map_or(wait_seconds, |longest| longest.max(wait_seconds)),
            );
            if wait_seconds > f64::from(target)
                || trip.patience_remaining <= f64::from(MIN_HEADWAY_SECONDS)
            {
                line_health.waiting_at_risk_count += 1;
            }
        }
        health.insert(line_id, line_health);
    }
    health
}

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

fn service_mode(state: &GameSnapshot, line_id: &str) -> Option<TransitMode> {
    if state.transit.routes.iter().any(|route| route.id == line_id) {
        Some(TransitMode::Bus)
    } else if state
        .transit
        .metro_lines
        .iter()
        .any(|line| line.id == line_id)
    {
        Some(TransitMode::Metro)
    } else {
        None
    }
}

/// Return the nominal price for one additional vehicle only when a currently
/// usable service has a live fleet shortfall.
fn top_up_offer(
    active: bool,
    legs: &[RouteLegPath],
    mode: TransitMode,
    assigned_fleet: usize,
    required_fleet: Option<usize>,
) -> Option<i32> {
    if !active || !is_route_operational(active, legs) || assigned_fleet == 0 {
        return None;
    }
    required_fleet
        .filter(|required| assigned_fleet < *required)
        .map(|_| vehicle_cost(mode))
}

/// Set the pre-deployment target for a transit line without changing its
/// structural revision or fleet.
pub(crate) fn set_service_target_headway(
    state: &GameSnapshot,
    line_id: &str,
    target_headway_seconds: u32,
) -> GameplayResult<GameSnapshot> {
    let mode = service_mode(state, line_id)
        .ok_or_else(|| route_rejection(RejectionCode::RouteNotFound, line_id))?;
    let mut next = state.clone();
    let vehicle_count = if mode == TransitMode::Bus {
        next.transit
            .routes
            .iter()
            .find(|route| route.id == line_id)
            .expect("route was found before candidate construction")
            .vehicle_ids
            .len()
    } else {
        next.transit
            .metro_lines
            .iter()
            .find(|line| line.id == line_id)
            .expect("metro line was found before candidate construction")
            .vehicle_ids
            .len()
    };
    if vehicle_count > 0 {
        return Err(route_rejection(
            RejectionCode::FleetAlreadyAssigned,
            line_id,
        ));
    }
    if target_headway_seconds < MIN_HEADWAY_SECONDS {
        return Err(route_rejection(RejectionCode::InvalidHeadway, line_id));
    }
    if mode == TransitMode::Bus {
        next.transit
            .routes
            .iter_mut()
            .find(|route| route.id == line_id)
            .expect("route was found before candidate construction")
            .target_headway_seconds = Some(target_headway_seconds);
    } else {
        next.transit
            .metro_lines
            .iter_mut()
            .find(|line| line.id == line_id)
            .expect("metro line was found before candidate construction")
            .target_headway_seconds = Some(target_headway_seconds);
    }
    Ok(next)
}

/// Buy and place the complete initial fleet for a configured transit line.
/// Authorization happens before any candidate entity is mutated, so a
/// standard-budget rejection cannot leave a partial fleet behind.
pub(crate) fn deploy_initial_fleet(
    state: &GameSnapshot,
    line_id: &str,
) -> GameplayResult<CostedMutation> {
    let mode = service_mode(state, line_id)
        .ok_or_else(|| route_rejection(RejectionCode::RouteNotFound, line_id))?;
    let (legs, vehicle_count, active, target) = if mode == TransitMode::Bus {
        let route = state
            .transit
            .routes
            .iter()
            .find(|route| route.id == line_id)
            .expect("route was found before service-mode lookup");
        (
            &route.legs,
            route.vehicle_ids.len(),
            route.active,
            route.target_headway_seconds,
        )
    } else {
        let line = state
            .transit
            .metro_lines
            .iter()
            .find(|line| line.id == line_id)
            .expect("metro line was found before service-mode lookup");
        (
            &line.legs,
            line.vehicle_ids.len(),
            line.active,
            line.target_headway_seconds,
        )
    };
    if vehicle_count > 0 {
        return Err(route_rejection(
            RejectionCode::FleetAlreadyAssigned,
            line_id,
        ));
    }
    if !active {
        return Err(route_rejection(RejectionCode::InactiveRoute, line_id));
    }
    if !is_route_operational(active, legs) {
        return Err(route_rejection(RejectionCode::DisconnectedLeg, line_id));
    }
    let target = target.ok_or_else(|| route_rejection(RejectionCode::HeadwayNotSet, line_id))?;
    // A direct Rust snapshot can carry a forged small target. Keep the same
    // floor here so it cannot reach required_fleet's intentionally lean math.
    if target < MIN_HEADWAY_SECONDS {
        return Err(route_rejection(RejectionCode::InvalidHeadway, line_id));
    }
    let flow = crate::traffic::derive_road_flow(state);
    let round_trip_seconds = round_trip_seconds(legs, mode, &flow)
        .ok_or_else(|| route_rejection(RejectionCode::DisconnectedLeg, line_id))?;
    let required = required_fleet(round_trip_seconds, target);
    let required_i32 =
        i32::try_from(required).map_err(|_| GameplayRejection::budget(i32::MAX, state.budget))?;
    let total_cost = required_i32
        .checked_mul(vehicle_cost(mode))
        .ok_or_else(|| GameplayRejection::budget(i32::MAX, state.budget))?;
    let authorized = CostPolicy::from_snapshot(state)
        .quote(total_cost, state.budget)
        .authorize()?;

    let mut candidate = state.clone();
    let mut vehicle_ids = Vec::with_capacity(required);
    for index in 0..required {
        let offset = round_trip_seconds * index as f64 / required as f64;
        let cursor = resolve_service_cursor(legs, mode, &flow, offset)
            .ok_or_else(|| route_rejection(RejectionCode::DisconnectedLeg, line_id))?;
        let mut vehicle = initial_vehicle(&candidate, mode, line_id);
        vehicle.itinerary_index = cursor.itinerary_index;
        vehicle.path_step_index = cursor.path_step_index;
        vehicle.step_progress = cursor.step_progress;
        vehicle_ids.push(vehicle.id.clone());
        candidate.transit.vehicles.push(vehicle);
    }
    if mode == TransitMode::Bus {
        candidate
            .transit
            .routes
            .iter_mut()
            .find(|route| route.id == line_id)
            .expect("route was found before candidate construction")
            .vehicle_ids
            .extend(vehicle_ids);
    } else {
        candidate
            .transit
            .metro_lines
            .iter_mut()
            .find(|line| line.id == line_id)
            .expect("metro line was found before candidate construction")
            .vehicle_ids
            .extend(vehicle_ids);
    }
    authorized.apply_to(&mut candidate.budget)?;
    Ok(CostedMutation::new(candidate))
}

/// Buy one vehicle for an already deployed service when its live timing now
/// requires a larger fleet. Existing vehicles retain their exact cursors and
/// passenger state; only the appended vehicle is placed in the largest cycle
/// gap.
pub(crate) fn add_service_vehicle(
    state: &GameSnapshot,
    line_id: &str,
) -> GameplayResult<CostedMutation> {
    let mode = service_mode(state, line_id)
        .ok_or_else(|| route_rejection(RejectionCode::RouteNotFound, line_id))?;
    let (active, legs, assigned_fleet, target_headway_seconds) = if mode == TransitMode::Bus {
        let route = state
            .transit
            .routes
            .iter()
            .find(|route| route.id == line_id)
            .expect("route was found before service-mode lookup");
        (
            route.active,
            route.legs.as_slice(),
            route.vehicle_ids.len(),
            route.target_headway_seconds,
        )
    } else {
        let line = state
            .transit
            .metro_lines
            .iter()
            .find(|line| line.id == line_id)
            .expect("metro line was found before service-mode lookup");
        (
            line.active,
            line.legs.as_slice(),
            line.vehicle_ids.len(),
            line.target_headway_seconds,
        )
    };

    // A top-up is only meaningful after an initial fleet and target exist.
    // These no-op cases intentionally precede service-state validation so an
    // unconfigured line remains inert rather than becoming a paid action.
    if assigned_fleet == 0 || target_headway_seconds.is_none() {
        return Ok(CostedMutation::free(state.clone()));
    }
    // Product top-up validates service state before entering the shared paid
    // append helper, whose legacy AssignVehicle ordering authorizes first.
    if !active {
        return Err(route_rejection(RejectionCode::InactiveRoute, line_id));
    }
    if !is_route_operational(active, legs) {
        return Err(route_rejection(RejectionCode::DisconnectedLeg, line_id));
    }
    let target_headway_seconds = target_headway_seconds
        .expect("target presence was checked before service-state validation");
    if target_headway_seconds < MIN_HEADWAY_SECONDS {
        return Err(route_rejection(RejectionCode::InvalidHeadway, line_id));
    }

    let flow = crate::traffic::derive_road_flow(state);
    let round_trip_seconds = round_trip_seconds(legs, mode, &flow)
        .ok_or_else(|| route_rejection(RejectionCode::DisconnectedLeg, line_id))?;
    let required_fleet = required_fleet(round_trip_seconds, target_headway_seconds);
    // Match populate_snapshot_metrics: a paused service publishes no top-up
    // offer, so a paused dispatch must be a free no-op rather than charging
    // the player for a vehicle the UI never offered.
    if top_up_offer(
        active && !state.paused,
        legs,
        mode,
        assigned_fleet,
        Some(required_fleet),
    )
    .is_none()
    {
        return Ok(CostedMutation::free(state.clone()));
    }

    let existing_offsets: Vec<f64> = state
        .transit
        .vehicles
        .iter()
        .filter(|vehicle| vehicle.line_id == line_id && vehicle.mode == mode)
        .map(|vehicle| vehicle_cycle_offset(vehicle, legs, mode, &flow))
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| route_rejection(RejectionCode::DisconnectedLeg, line_id))?;
    let offset = largest_gap_midpoint(&existing_offsets, round_trip_seconds)
        .ok_or_else(|| route_rejection(RejectionCode::DisconnectedLeg, line_id))?;
    let cursor = resolve_service_cursor(legs, mode, &flow, offset)
        .ok_or_else(|| route_rejection(RejectionCode::DisconnectedLeg, line_id))?;
    let mut vehicle = initial_vehicle(state, mode, line_id);
    vehicle.itinerary_index = cursor.itinerary_index;
    vehicle.path_step_index = cursor.path_step_index;
    vehicle.step_progress = cursor.step_progress;

    append_vehicle_costed(state, vehicle)
}

/// Derive service metrics for either transit mode. Returns `None` when no
/// positive cycle time is derivable (any leg missing `current_path`, or a
/// walk that sums to zero).
fn metrics(
    active: bool,
    legs: &[RouteLegPath],
    mode: TransitMode,
    flow: &RoadFlow,
    assigned_fleet: usize,
    target_headway_seconds: Option<u32>,
    waiting_health: WaitingHealth,
) -> Option<ServiceMetrics> {
    let round_trip_seconds = round_trip_seconds(legs, mode, flow)?;
    let required_fleet =
        target_headway_seconds.map(|target| required_fleet(round_trip_seconds, target));
    let estimated_deployment_cost = if assigned_fleet == 0 {
        required_fleet
            .and_then(|required| i32::try_from(required).ok())
            .and_then(|required| required.checked_mul(vehicle_cost(mode)))
    } else {
        None
    };
    let next_vehicle_cost = top_up_offer(active, legs, mode, assigned_fleet, required_fleet);
    Some(ServiceMetrics {
        round_trip_seconds,
        assigned_fleet,
        required_fleet,
        estimated_deployment_cost,
        next_vehicle_cost,
        // Zero fleet means no passenger service: nominal headway is unavailable.
        nominal_headway_seconds: (assigned_fleet > 0)
            .then(|| round_trip_seconds / assigned_fleet as f64),
        waiting_at_risk_count: waiting_health.waiting_at_risk_count,
        longest_wait_seconds: waiting_health.longest_wait_seconds,
    })
}

/// `max(1, ceil(round_trip_seconds / target_headway_seconds))`.
pub(crate) fn required_fleet(round_trip_seconds: f64, target_headway_seconds: u32) -> usize {
    ((round_trip_seconds / f64::from(target_headway_seconds)).ceil() as usize).max(1)
}

/// Fill every route and metro line's `service_metrics` on an output snapshot
/// clone. Derives the `RoadFlow` once for both modes.
pub(crate) fn populate_snapshot_metrics(snapshot: &mut GameSnapshot) {
    let flow = crate::traffic::derive_road_flow(snapshot);
    let waiting_health = waiting_health_by_line(snapshot);
    for route in &mut snapshot.transit.routes {
        let health = waiting_health.get(&route.id).copied().unwrap_or_default();
        route.service_metrics = metrics(
            route.active && !snapshot.paused,
            &route.legs,
            TransitMode::Bus,
            &flow,
            route.vehicle_ids.len(),
            route.target_headway_seconds,
            health,
        );
    }
    for line in &mut snapshot.transit.metro_lines {
        let health = waiting_health.get(&line.id).copied().unwrap_or_default();
        line.service_metrics = metrics(
            line.active && !snapshot.paused,
            &line.legs,
            TransitMode::Metro,
            &flow,
            line.vehicle_ids.len(),
            line.target_headway_seconds,
            health,
        );
    }
}

/// Map a vehicle's current cursor to elapsed seconds from the start of its
/// cyclic itinerary using the same live per-step timing as vehicle movement.
/// Empty terminal reversals occupy their accumulated leg-start offset.
fn vehicle_cycle_offset(
    vehicle: &Vehicle,
    legs: &[RouteLegPath],
    mode: TransitMode,
    flow: &RoadFlow,
) -> Option<f64> {
    if legs.is_empty()
        || !vehicle.step_progress.is_finite()
        || !(0.0..=1.0).contains(&vehicle.step_progress)
    {
        return None;
    }
    let itinerary_index = vehicle.itinerary_index % legs.len();
    let mut offset = 0.0;
    for (index, leg) in legs.iter().enumerate() {
        let path = leg.current_path.as_ref()?;
        if index < itinerary_index {
            for step in path.step_refs() {
                let seconds = vehicle_step_seconds(flow, mode, step);
                if seconds.is_finite() && seconds > 0.0 {
                    offset += seconds;
                }
            }
            continue;
        }
        if index != itinerary_index {
            break;
        }
        if path.step_count() == 0 {
            if vehicle.path_step_index != 0 {
                return None;
            }
            return offset.is_finite().then_some(offset);
        }
        if vehicle.path_step_index >= path.step_count() || vehicle.step_progress < 0.0 {
            return None;
        }
        for step_index in 0..vehicle.path_step_index {
            let step = path.step(step_index)?;
            let seconds = vehicle_step_seconds(flow, mode, step);
            if seconds.is_finite() && seconds > 0.0 {
                offset += seconds;
            }
        }
        let current_step = path.step(vehicle.path_step_index)?;
        let current_seconds = vehicle_step_seconds(flow, mode, current_step);
        if current_seconds.is_finite() && current_seconds > 0.0 {
            offset += current_seconds * vehicle.step_progress;
        }
        return offset.is_finite().then_some(offset);
    }
    None
}

/// Choose the midpoint of the largest cyclic gap between existing vehicle
/// offsets. The sorted earliest gap start wins exact ties.
fn largest_gap_midpoint(offsets: &[f64], round_trip_seconds: f64) -> Option<f64> {
    if !round_trip_seconds.is_finite() || round_trip_seconds <= 0.0 {
        return None;
    }
    let mut sorted: Vec<f64> = offsets
        .iter()
        .copied()
        .filter(|offset| offset.is_finite())
        .map(|offset| offset.rem_euclid(round_trip_seconds))
        .collect();
    if sorted.is_empty() {
        return None;
    }
    sorted.sort_by(|left, right| left.partial_cmp(right).unwrap_or(Ordering::Equal));

    let mut best_start = sorted[0];
    let mut best_gap = 0.0;
    for index in 0..sorted.len() {
        let start = sorted[index];
        let end = if index + 1 < sorted.len() {
            sorted[index + 1]
        } else {
            sorted[0] + round_trip_seconds
        };
        let gap = end - start;
        if gap > best_gap || (gap == best_gap && start < best_start) {
            best_start = start;
            best_gap = gap;
        }
    }
    Some((best_start + best_gap / 2.0).rem_euclid(round_trip_seconds))
}

fn resolve_service_cursor(
    legs: &[RouteLegPath],
    mode: TransitMode,
    flow: &RoadFlow,
    offset_seconds: f64,
) -> Option<ServiceCursor> {
    if !offset_seconds.is_finite() || offset_seconds < 0.0 {
        return None;
    }
    let mut remaining = offset_seconds;
    for (itinerary_index, leg) in legs.iter().enumerate() {
        let path = leg.current_path.as_ref()?;
        if path.step_count() == 0 {
            if remaining <= 1e-9 {
                return Some(ServiceCursor {
                    itinerary_index,
                    path_step_index: 0,
                    step_progress: 0.0,
                });
            }
            continue;
        }
        for path_step_index in 0..path.step_count() {
            let Some(step) = path.step(path_step_index) else {
                continue;
            };
            let duration = vehicle_step_seconds(flow, mode, step);
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

/// One complete cycle over the cyclic `legs`, using `current_path` only
/// (never `last_valid_path` or cached `estimated_seconds`) and the same live
/// per-step timing rule vehicle movement uses. Empty terminal reversals
/// contribute zero seconds; non-positive step durations are skipped.
fn round_trip_seconds(legs: &[RouteLegPath], mode: TransitMode, flow: &RoadFlow) -> Option<f64> {
    let mut total = 0.0;
    for leg in legs {
        let path = leg.current_path.as_ref()?;
        for step in path.step_refs() {
            let seconds = vehicle_step_seconds(flow, mode, step);
            if seconds > 0.0 {
                total += seconds;
            }
        }
    }
    (total.is_finite() && total > 0.0).then_some(total)
}

#[cfg(test)]
mod tests {
    use super::{
        largest_gap_midpoint, metrics, required_fleet, resolve_service_cursor,
        vehicle_cycle_offset, waiting_health_by_line, ServiceCursor, WaitingHealth,
    };
    use crate::model::{
        ActiveTrip, BusStopKind, Heading, MovementKind, PathGeometry, Platform, Point,
        RoadPathStep, Route, RouteLeg, RouteLegKind, RouteLegPath, RouteLegStatus, RoutePlan,
        ServiceDirection, ServicePattern, Stop, TrackPathStep, TransitMode, TransitNodeStatus,
        TransitPath, TripPosition, TripPurpose, TripStatus, Vehicle,
    };
    use crate::traffic::RoadFlow;
    use crate::transit::{BUS_COST, METRO_COST};
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

    fn track_step(position: (i32, i32), travel_seconds: f64) -> TrackPathStep {
        let position = Point::from(position);
        TrackPathStep {
            position,
            heading: Heading::East,
            geometry: PathGeometry::Line {
                from: TripPosition::from(position),
                to: TripPosition::from((position.x + 1, position.y)),
            },
            travel_seconds,
        }
    }

    fn track_path(steps: Vec<TrackPathStep>, stored_total: f64) -> TransitPath {
        TransitPath::Track {
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

    fn platform_stop(id: &str, position: Point, route_id: &str) -> Stop {
        Stop {
            id: id.to_string(),
            kind: BusStopKind::BusStop,
            status: TransitNodeStatus::Present,
            position,
            platforms: vec![Platform {
                id: format!("{id}-p0"),
                label: "A".to_string(),
                capacity: 50,
                route_ids: vec![route_id.to_string()],
            }],
            road_access: None,
        }
    }

    fn waiting_trip(id: &str, line_id: &str, position: Point, wait_seconds: f64) -> ActiveTrip {
        ActiveTrip {
            id: id.to_string(),
            sim_id: format!("sim-{id}"),
            purpose: TripPurpose::CommuteOutbound,
            origin: position,
            destination: Point::from((0, 0)),
            position: position.into(),
            status: TripStatus::Waiting,
            deadline: 9_999.0,
            route_plan: Some(RoutePlan {
                estimated_seconds: 100.0,
                legs: vec![RouteLeg {
                    mode: TransitMode::Bus,
                    from: position,
                    to: Point::from((0, 0)),
                    line_id: Some(line_id.to_string()),
                    service_direction: Some(ServiceDirection::Loop),
                    board_itinerary_index: Some(0),
                    alight_itinerary_index: Some(0),
                }],
            }),
            current_leg_index: 0,
            patience_remaining: 240.0 - wait_seconds,
            current_leg_wait_seconds: wait_seconds,
            private_car_trip: None,
        }
    }

    #[test]
    fn waiting_health_counts_past_target_or_low_patience_platform_waiters() {
        let mut short_target = route_with_legs(Vec::new());
        short_target.id = "route-short".into();
        short_target.target_headway_seconds = Some(60);

        let mut long_target = route_with_legs(Vec::new());
        long_target.id = "route-long".into();
        long_target.target_headway_seconds = Some(300);

        let mut no_target = route_with_legs(Vec::new());
        no_target.id = "route-none".into();
        no_target.target_headway_seconds = None;

        let mut snapshot = crate::state::create_initial_snapshot();
        snapshot.transit.routes = vec![short_target, long_target, no_target];
        snapshot.transit.stations.clear();
        snapshot.transit.stops = vec![
            platform_stop("stop-short", Point::from((5, 5)), "route-short"),
            platform_stop("stop-long", Point::from((6, 5)), "route-long"),
            platform_stop("stop-none", Point::from((7, 5)), "route-none"),
        ];
        snapshot.active_trips = vec![
            waiting_trip("short-at-target", "route-short", Point::from((5, 5)), 60.0),
            waiting_trip(
                "short-past-target",
                "route-short",
                Point::from((5, 5)),
                61.0,
            ),
            waiting_trip("short-longest", "route-short", Point::from((5, 5)), 90.0),
            waiting_trip(
                "long-low-patience",
                "route-long",
                Point::from((6, 5)),
                181.0,
            ),
            waiting_trip("none-ignored", "route-none", Point::from((7, 5)), 200.0),
            waiting_trip(
                "short-without-platform",
                "route-short",
                Point::from((8, 5)),
                200.0,
            ),
        ];

        let health = waiting_health_by_line(&snapshot);

        assert_eq!(
            health.get("route-short"),
            Some(&WaitingHealth {
                waiting_at_risk_count: 2,
                longest_wait_seconds: Some(90.0),
            })
        );
        assert_eq!(
            health.get("route-long"),
            Some(&WaitingHealth {
                waiting_at_risk_count: 1,
                longest_wait_seconds: Some(181.0),
            })
        );
        assert_eq!(health.get("route-none"), None);
    }

    #[test]
    fn waiting_health_does_not_inherit_previous_line_wait_across_transfer() {
        // A rider waited 130 s on route-A, transferred to route-B (target 120 s),
        // and has waited 1 s on route-B so far. The trip-wide patience budget
        // has consumed 131 s (patience_remaining = 109), but the current-leg
        // wait is only 1 s. Route-B's health must reflect only the 1 s waited
        // on B, not the cumulative 131 s — otherwise B would inherit A's delay
        // and report a past-target rider / 131 s longest wait.
        let mut route_a = route_with_legs(Vec::new());
        route_a.id = "route-A".into();
        route_a.target_headway_seconds = Some(60);

        let mut route_b = route_with_legs(Vec::new());
        route_b.id = "route-B".into();
        route_b.target_headway_seconds = Some(120);

        let mut snapshot = crate::state::create_initial_snapshot();
        snapshot.transit.routes = vec![route_a, route_b];
        snapshot.transit.stations.clear();
        snapshot.transit.stops = vec![platform_stop("stop-b", Point::from((6, 6)), "route-B")];

        let transfer_position = Point::from((6, 6));
        let transfer_trip = ActiveTrip {
            id: "transfer-rider".to_string(),
            sim_id: "sim-transfer".to_string(),
            purpose: TripPurpose::CommuteOutbound,
            origin: Point::from((5, 5)),
            destination: Point::from((0, 0)),
            position: transfer_position.into(),
            status: TripStatus::Waiting,
            deadline: 9_999.0,
            route_plan: Some(RoutePlan {
                estimated_seconds: 300.0,
                legs: vec![
                    RouteLeg {
                        mode: TransitMode::Bus,
                        from: Point::from((5, 5)),
                        to: transfer_position,
                        line_id: Some("route-A".to_string()),
                        service_direction: Some(ServiceDirection::Loop),
                        board_itinerary_index: Some(0),
                        alight_itinerary_index: Some(0),
                    },
                    RouteLeg {
                        mode: TransitMode::Walk,
                        from: transfer_position,
                        to: transfer_position,
                        line_id: None,
                        service_direction: None,
                        board_itinerary_index: None,
                        alight_itinerary_index: None,
                    },
                    RouteLeg {
                        mode: TransitMode::Bus,
                        from: transfer_position,
                        to: Point::from((0, 0)),
                        line_id: Some("route-B".to_string()),
                        service_direction: Some(ServiceDirection::Loop),
                        board_itinerary_index: Some(0),
                        alight_itinerary_index: Some(0),
                    },
                ],
            }),
            current_leg_index: 2,
            // 130 s on A + 1 s on B = 131 s total wait → patience = 109.
            patience_remaining: 109.0,
            // Only 1 s waited on the current leg (route-B).
            current_leg_wait_seconds: 1.0,
            private_car_trip: None,
        };
        snapshot.active_trips = vec![transfer_trip];

        let health = waiting_health_by_line(&snapshot);

        // Route-B must not inherit route-A's 130 s wait.
        assert_eq!(
            health.get("route-B"),
            Some(&WaitingHealth {
                waiting_at_risk_count: 0,
                longest_wait_seconds: Some(1.0),
            })
        );
        // Route-A has no current waiters (the trip is past it).
        assert_eq!(health.get("route-A"), None);
    }

    #[test]
    fn required_fleet_rounds_up() {
        assert_eq!(required_fleet(600.0, 300), 2);
        assert_eq!(required_fleet(601.0, 300), 3);
        assert_eq!(required_fleet(1.0, 300), 1, "fleet never rounds to zero");
    }

    fn test_vehicle(itinerary_index: usize, path_step_index: usize) -> Vehicle {
        Vehicle {
            id: "vehicle-test".to_string(),
            mode: TransitMode::Bus,
            line_id: "route-001".to_string(),
            capacity: 18,
            passenger_ids: Vec::new(),
            itinerary_index,
            path_step_index,
            step_progress: 0.0,
            parked_position: None,
        }
    }

    #[test]
    fn evenly_spaced_vehicle_offsets_choose_the_first_equal_gap_midpoint() {
        assert_eq!(largest_gap_midpoint(&[25.0, 75.0], 100.0), Some(50.0));
    }

    #[test]
    fn one_vehicle_chooses_half_cycle() {
        assert_eq!(largest_gap_midpoint(&[0.0], 100.0), Some(50.0));
    }

    #[test]
    fn wrap_around_gap_participates_in_largest_gap() {
        assert_eq!(largest_gap_midpoint(&[10.0, 20.0, 30.0], 100.0), Some(70.0));
    }

    #[test]
    fn equal_gap_tie_breaking_keeps_the_earliest_gap_start() {
        assert_eq!(
            largest_gap_midpoint(&[0.0, 20.0, 40.0, 60.0, 80.0], 100.0),
            Some(10.0)
        );
    }

    #[test]
    fn vehicle_offset_handles_a_zero_step_terminal_reversal_at_leg_start() {
        let legs = vec![
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
                road_path(vec![step((12, 5), MovementKind::Straight, 50.0)], 50.0),
            ),
        ];
        let vehicle = test_vehicle(1, 0);
        assert_eq!(
            vehicle_cycle_offset(&vehicle, &legs, TransitMode::Bus, &RoadFlow::new()),
            Some(100.0)
        );
    }

    #[test]
    fn metro_round_trip_uses_current_track_steps_and_ignores_road_flow() {
        let route = route_with_legs(vec![leg(
            RouteLegKind::Service,
            ServiceDirection::Outbound,
            "station-001",
            "station-002",
            track_path(
                vec![track_step((2, 4), 100.0), track_step((3, 4), 500.0)],
                600.0,
            ),
        )]);
        let mut heavy = BTreeMap::new();
        heavy.insert(Point::from((2, 4)), 8u16);
        heavy.insert(Point::from((3, 4)), 8u16);

        let metrics = metrics(
            true,
            &route.legs,
            TransitMode::Metro,
            &heavy,
            route.vehicle_ids.len(),
            route.target_headway_seconds,
            WaitingHealth::default(),
        )
        .expect("connected metro line has metrics");
        assert_eq!(metrics.round_trip_seconds, 600.0);
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

        let metrics = metrics(
            true,
            &route.legs,
            TransitMode::Bus,
            &RoadFlow::new(),
            route.vehicle_ids.len(),
            route.target_headway_seconds,
            WaitingHealth::default(),
        )
        .expect("connected route has metrics");
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
    fn metro_zero_fleet_metrics_include_deployment_cost() {
        let mut route = route_with_legs(vec![leg(
            RouteLegKind::Service,
            ServiceDirection::Outbound,
            "station-001",
            "station-002",
            track_path(vec![track_step((2, 4), 601.0)], 601.0),
        )]);
        route.target_headway_seconds = Some(300);

        let metrics = metrics(
            true,
            &route.legs,
            TransitMode::Metro,
            &RoadFlow::new(),
            route.vehicle_ids.len(),
            route.target_headway_seconds,
            WaitingHealth::default(),
        )
        .expect("connected metro line has metrics");
        assert_eq!(metrics.round_trip_seconds, 601.0);
        assert_eq!(metrics.required_fleet, Some(3));
        assert_eq!(metrics.assigned_fleet, 0);
        assert_eq!(metrics.nominal_headway_seconds, None);
        assert_eq!(metrics.estimated_deployment_cost, Some(3 * METRO_COST));
        assert_eq!(metrics.next_vehicle_cost, None);
    }

    #[test]
    fn metro_shortfall_metric_publishes_metro_price() {
        let mut route = route_with_legs(vec![leg(
            RouteLegKind::Service,
            ServiceDirection::Outbound,
            "station-001",
            "station-002",
            track_path(vec![track_step((2, 4), 601.0)], 601.0),
        )]);
        route.vehicle_ids = vec!["vehicle-001".to_string()];
        route.target_headway_seconds = Some(300);
        let metrics = metrics(
            true,
            &route.legs,
            TransitMode::Metro,
            &RoadFlow::new(),
            route.vehicle_ids.len(),
            route.target_headway_seconds,
            WaitingHealth::default(),
        )
        .expect("connected metro line has metrics");
        assert_eq!(metrics.required_fleet, Some(3));
        assert_eq!(metrics.next_vehicle_cost, Some(METRO_COST));
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

        let metrics = metrics(
            true,
            &route.legs,
            TransitMode::Bus,
            &RoadFlow::new(),
            route.vehicle_ids.len(),
            route.target_headway_seconds,
            WaitingHealth::default(),
        )
        .expect("connected route has metrics");
        assert_eq!(metrics.nominal_headway_seconds, Some(300.0));
        assert_eq!(metrics.required_fleet, Some(2));
        assert_eq!(metrics.assigned_fleet, 2);
        assert_eq!(metrics.next_vehicle_cost, None);
    }

    #[test]
    fn active_shortfall_metric_publishes_one_vehicle_price_but_pause_hides_it() {
        let mut route = route_with_legs(vec![leg(
            RouteLegKind::Service,
            ServiceDirection::Outbound,
            "stop-001",
            "stop-002",
            road_path(vec![step((2, 5), MovementKind::Straight, 600.0)], 600.0),
        )]);
        route.vehicle_ids = vec!["vehicle-001".to_string()];
        route.target_headway_seconds = Some(300);

        let active = metrics(
            true,
            &route.legs,
            TransitMode::Bus,
            &RoadFlow::new(),
            route.vehicle_ids.len(),
            route.target_headway_seconds,
            WaitingHealth::default(),
        )
        .expect("active route has metrics");
        assert_eq!(active.required_fleet, Some(2));
        assert_eq!(active.next_vehicle_cost, Some(BUS_COST));

        let mut broken_legs = route.legs.clone();
        broken_legs[0].status = RouteLegStatus::NetworkDisconnected;
        let broken = metrics(
            true,
            &broken_legs,
            TransitMode::Bus,
            &RoadFlow::new(),
            route.vehicle_ids.len(),
            route.target_headway_seconds,
            WaitingHealth::default(),
        )
        .expect("broken route still has timing metrics");
        assert_eq!(broken.next_vehicle_cost, None);

        let paused = metrics(
            false,
            &route.legs,
            TransitMode::Bus,
            &RoadFlow::new(),
            route.vehicle_ids.len(),
            route.target_headway_seconds,
            WaitingHealth::default(),
        )
        .expect("paused route still has timing metrics");
        assert_eq!(paused.required_fleet, Some(2));
        assert_eq!(paused.next_vehicle_cost, None);
    }

    #[test]
    fn top_up_offer_requires_an_operational_deployed_shortfall() {
        let route = route_with_legs(vec![leg(
            RouteLegKind::Service,
            ServiceDirection::Outbound,
            "stop-001",
            "stop-002",
            road_path(vec![step((2, 5), MovementKind::Straight, 100.0)], 100.0),
        )]);
        assert_eq!(
            super::top_up_offer(true, &route.legs, TransitMode::Bus, 1, Some(2)),
            Some(BUS_COST)
        );
        assert_eq!(
            super::top_up_offer(true, &route.legs, TransitMode::Bus, 2, Some(2)),
            None
        );
        assert_eq!(
            super::top_up_offer(true, &route.legs, TransitMode::Bus, 0, Some(2)),
            None
        );
        assert_eq!(
            super::top_up_offer(false, &route.legs, TransitMode::Bus, 1, Some(2)),
            None
        );

        let mut broken = route.legs.clone();
        broken[0].status = RouteLegStatus::NetworkDisconnected;
        assert_eq!(
            super::top_up_offer(true, &broken, TransitMode::Bus, 1, Some(2)),
            None
        );
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

        let free_flow = metrics(
            true,
            &route.legs,
            TransitMode::Bus,
            &RoadFlow::new(),
            route.vehicle_ids.len(),
            route.target_headway_seconds,
            WaitingHealth::default(),
        )
        .expect("shuttle route has metrics")
        .round_trip_seconds;
        assert_eq!(free_flow, 302.0, "100 + 0 + 200 + 2");

        let mut congested = BTreeMap::new();
        congested.insert(outbound_point, 8u16);
        let congested = metrics(
            true,
            &route.legs,
            TransitMode::Bus,
            &congested,
            route.vehicle_ids.len(),
            route.target_headway_seconds,
            WaitingHealth::default(),
        )
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

        let cursor = resolve_service_cursor(&route.legs, TransitMode::Bus, &RoadFlow::new(), 200.0)
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
    fn metro_offset_lands_inside_second_unequal_step() {
        let route = route_with_legs(vec![leg(
            RouteLegKind::Service,
            ServiceDirection::Outbound,
            "station-001",
            "station-002",
            track_path(
                vec![track_step((2, 4), 100.0), track_step((3, 4), 300.0)],
                400.0,
            ),
        )]);

        let required = required_fleet(400.0, 200);
        assert_eq!(required, 2);
        let second_offset = 400.0 * 1.0 / required as f64;
        assert_eq!(second_offset, 200.0);
        let cursor = resolve_service_cursor(
            &route.legs,
            TransitMode::Metro,
            &RoadFlow::new(),
            second_offset,
        )
        .expect("positive cycle has a cursor");
        assert_eq!(
            cursor,
            ServiceCursor {
                itinerary_index: 0,
                path_step_index: 1,
                step_progress: 100.0 / 300.0,
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

        let cursor = resolve_service_cursor(&route.legs, TransitMode::Bus, &RoadFlow::new(), 151.0)
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

        assert_eq!(
            metrics(
                true,
                &route.legs,
                TransitMode::Bus,
                &RoadFlow::new(),
                route.vehicle_ids.len(),
                route.target_headway_seconds,
                WaitingHealth::default(),
            ),
            None
        );
    }
}
