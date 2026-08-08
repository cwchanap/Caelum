//! Coverage for the `validate_route_plan` branches (persistence/trips.rs)
//! exercised indirectly through `GameEngine::from_snapshot` →
//! `validate_and_compile` → `validate_route_plan`.
//!
//! `validate_route_plan` is private to the persistence module and cannot be
//! called directly from integration tests. Each test constructs a snapshot
//! with a trip whose `route_plan` exercises the target branch, then constructs
//! an engine via `from_snapshot` and asserts the result (a load error for the
//! rejection case, Ok for the positive bus-leg case).

mod common;

use caelum_core::model::{ActiveTrip, Point, TransitMode, TripPosition, TripStatus};
use common::persistence_fixtures::{fixture_with_bus_route, worker_sim};

// ===========================================================================
// Positive bus-leg route plan (validate_route_plan)
// ===========================================================================

/// Build a snapshot with a bus route and an active trip whose `route_plan`
/// contains a bus leg produced by `router::find_route_plan`. The trip is
/// Walking at leg 0; `from_snapshot` should pass, exercising the positive
/// path through `validate_route_plan` (leg topology, non-Walk mode with a
/// `line_id`, and Walking status matching a Walk leg).
fn bus_leg_trip_fixture() -> caelum_core::GameSnapshot {
    let mut snapshot = fixture_with_bus_route();
    let origin = Point { x: 1, y: 4 };
    let destination = Point { x: 13, y: 4 };
    let plan = caelum_core::router::find_route_plan(&snapshot, &origin, &destination)
        .expect("bus route plan should exist");
    // Confirm the plan actually contains a bus leg so the bus arm is exercised.
    assert!(
        plan.legs.iter().any(|leg| leg.mode == TransitMode::Bus),
        "plan must contain a bus leg"
    );
    snapshot.sims = vec![worker_sim("sim-001", origin, Some(destination))];
    snapshot.active_trips = vec![ActiveTrip {
        id: "trip-day-0-trip-001".to_string(),
        sim_id: "sim-001".to_string(),
        purpose: caelum_core::model::TripPurpose::CommuteOutbound,
        origin,
        destination,
        position: TripPosition::from(origin),
        status: TripStatus::Walking,
        deadline: 900.0,
        route_plan: Some(plan),
        current_leg_index: 0,
        patience_remaining: 240.0,
    }];
    snapshot.trip_sequence_day = 0;
    snapshot.next_trip_sequence = 2;
    snapshot
}

#[test]
fn bus_leg_route_plan_is_loadable() {
    let snapshot = bus_leg_trip_fixture();
    // The plan was produced by `find_route_plan`, so it must satisfy
    // `validate_route_plan`'s topology and status checks. This exercises the
    // positive path on a bus leg — from_snapshot passes.
    assert!(
        caelum_core::GameEngine::from_snapshot(snapshot).is_ok(),
        "valid bus-leg route plan should pass validation"
    );
}

// ===========================================================================
// Route-plan estimated_seconds rejection (validate_route_plan → finite_non_negative)
// ===========================================================================

#[test]
fn tampered_plan_estimated_seconds_is_rejected() {
    let mut snapshot = bus_leg_trip_fixture();
    let plan = snapshot.active_trips[0]
        .route_plan
        .as_mut()
        .expect("fixture trip has a route plan");
    plan.estimated_seconds = -1.0;

    assert!(
        caelum_core::GameEngine::from_snapshot(snapshot).is_err(),
        "a negative route-plan estimated_seconds must be rejected"
    );
}
