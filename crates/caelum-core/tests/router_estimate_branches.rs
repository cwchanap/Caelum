//! Coverage for the `router::route_plan_estimated_seconds` branches (router.rs
//! 91-126) that are exercised indirectly through `validate_snapshot` →
//! `validate_route_plan` (trips.rs:231).
//!
//! `route_plan_estimated_seconds` is `pub(crate)` and cannot be called directly
//! from integration tests. Instead, each test constructs a snapshot with a trip
//! whose `route_plan` exercises the target branch, then calls
//! `validate_snapshot` and asserts the resulting `PersistenceError` (or Ok for
//! the positive bus-arm case).

mod common;

use caelum_core::model::{
    ActiveTrip, Point, RouteLeg, RoutePlan, TransitMode, TripPosition, TripStatus,
};
use caelum_core::{
    validate_snapshot, DerivedStateError, EntityKind, PersistenceError, SnapshotField,
};
use common::persistence_fixtures::{entity_ref, fixture_with_bus_route, trip_fixture, worker_sim};

// ===========================================================================
// Walk leg with transit fields set → route_plan_estimated_seconds returns None
// (router.rs:96-102, line 101 `return None`)
// ===========================================================================

#[test]
fn walk_leg_with_line_id_returns_none_and_is_rejected() {
    let mut snapshot = trip_fixture();
    let home = snapshot.active_trips[0].origin;
    let dest = snapshot.active_trips[0].destination;
    // A walk leg that erroneously carries line_id. The router's
    // route_plan_estimated_seconds sees a Walk leg with line_id=Some and
    // returns None (line 101), so trips.rs:232 fires TripStateMismatch.
    let distance = f64::from((home.x - dest.x).abs() + (home.y - dest.y).abs()) * 20.0;
    snapshot.active_trips[0].route_plan = Some(RoutePlan {
        legs: vec![RouteLeg {
            mode: TransitMode::Walk,
            from: home,
            to: dest,
            line_id: Some("route-001".to_string()),
            service_direction: None,
            board_itinerary_index: None,
            alight_itinerary_index: None,
        }],
        estimated_seconds: distance,
    });
    snapshot.active_trips[0].status = TripStatus::Walking;
    snapshot.active_trips[0].current_leg_index = 0;
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidDerivedState {
            field: SnapshotField::TripRoutePlan,
            reason: DerivedStateError::TripStateMismatch {
                trip: entity_ref(EntityKind::ActiveTrip, "trip-day-0-trip-001"),
            },
        }
    );
}

// ===========================================================================
// Bus/Metro leg arm (router.rs:106-121) — positive case
// ===========================================================================

/// Build a snapshot with a bus route and an active trip whose route_plan
/// contains a bus leg produced by `router::find_route_plan`. The trip is
/// Walking at leg 0; `validate_snapshot` should pass, exercising the bus arm
/// of `route_plan_estimated_seconds` (line 231 iterates all legs including the
/// bus leg).
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
fn bus_leg_plan_estimated_seconds_matches_router_and_is_valid() {
    let snapshot = bus_leg_trip_fixture();
    // The plan's estimated_seconds was produced by find_route_plan, so
    // route_plan_estimated_seconds must agree. This exercises the Bus arm
    // (router.rs:106-121) on the positive path — validate_snapshot passes.
    assert!(
        validate_snapshot(&snapshot).is_ok(),
        "valid bus-leg route plan should pass validation"
    );
}

#[test]
fn bus_leg_with_wrong_estimated_seconds_is_rejected() {
    let mut snapshot = bus_leg_trip_fixture();
    // Tamper with estimated_seconds so route_plan_estimated_seconds disagrees
    // (still exercises the bus arm, but the mismatch fires trips.rs:232).
    if let Some(plan) = snapshot.active_trips[0].route_plan.as_mut() {
        plan.estimated_seconds += 1.0;
    }
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidDerivedState {
            field: SnapshotField::TripRoutePlan,
            reason: DerivedStateError::TripStateMismatch {
                trip: entity_ref(EntityKind::ActiveTrip, "trip-day-0-trip-001"),
            },
        }
    );
}

#[test]
fn bus_leg_with_unknown_line_id_is_rejected() {
    let mut snapshot = bus_leg_trip_fixture();
    // Replace the bus leg's line_id with a non-existent one so the router
    // cannot find a matching service → route_plan_estimated_seconds returns
    // None (line 112 `?`) → trips.rs:232 fires.
    if let Some(plan) = snapshot.active_trips[0].route_plan.as_mut() {
        for leg in &mut plan.legs {
            if leg.mode == TransitMode::Bus {
                leg.line_id = Some("route-999".to_string());
            }
        }
    }
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidDerivedState {
            field: SnapshotField::TripRoutePlan,
            reason: DerivedStateError::TripStateMismatch {
                trip: entity_ref(EntityKind::ActiveTrip, "trip-day-0-trip-001"),
            },
        }
    );
}
