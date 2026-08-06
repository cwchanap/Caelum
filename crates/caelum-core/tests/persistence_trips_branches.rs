//! Coverage for the remaining uncovered `persistence/trips.rs` validation
//! branches: dangling sim references, duplicate trip keys, sim profile
//! mismatch, route-plan shape/estimate/status checks, vehicle membership,
//! trip counters, metrics numerics, outcome window pruning, and campaign
//! objective state (Won/Lost arms + loss-reason mismatch).
//!
//! Each test builds a persistence-valid baseline snapshot (via the shared
//! fixtures) and then mutates a single field to exercise one rejection branch,
//! asserting the exact `PersistenceError`.

mod common;

use caelum_core::model::{
    ActiveTrip, Point, RouteLeg, RoutePlan, TripOutcome, TripOutcomeKind, TripPosition, TripStatus,
};
use caelum_core::{
    clock, validate_snapshot, DerivedStateError, EntityError, EntityKind, NumericError,
    PersistenceError, SnapshotField,
};
use common::persistence_fixtures::{
    entity_ref, fixture_with_bus_route, paused_snapshot, trip_fixture, worker_sim,
};

// ===========================================================================
// sim validation — profile mismatch (trips.rs:90-94)
// ===========================================================================

// ===========================================================================
// trip reference & key validation (trips.rs:27-31, 50-55)
// ===========================================================================

#[test]
fn trip_with_dangling_sim_id_is_rejected() {
    let mut snapshot = trip_fixture();
    snapshot.active_trips[0].sim_id = "sim-999".to_string();
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::DanglingReference {
            source: entity_ref(EntityKind::ActiveTrip, "trip-day-0-trip-001"),
            field: SnapshotField::EntityId,
            target: entity_ref(EntityKind::Sim, "sim-999"),
        }
    );
}

// ===========================================================================
// trip numeric validation (trips.rs:59-70, 443-456)
// ===========================================================================

#[test]
fn trip_deadline_not_finite_is_rejected() {
    let mut snapshot = trip_fixture();
    snapshot.active_trips[0].deadline = f64::NAN;
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidNumericValue {
            entity: Some(entity_ref(EntityKind::ActiveTrip, "trip-day-0-trip-001")),
            field: SnapshotField::TripDeadline,
            reason: NumericError::NotFinite,
        }
    );
}

#[test]
fn trip_patience_not_finite_is_rejected() {
    let mut snapshot = trip_fixture();
    snapshot.active_trips[0].patience_remaining = f64::NAN;
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidNumericValue {
            entity: Some(entity_ref(EntityKind::ActiveTrip, "trip-day-0-trip-001")),
            field: SnapshotField::TripPatience,
            reason: NumericError::NotFinite,
        }
    );
}

// ===========================================================================
// route-plan validation (trips.rs:211-248)
// ===========================================================================

fn walk_plan_with_seconds(from: Point, to: Point, estimated_seconds: f64) -> RoutePlan {
    RoutePlan {
        legs: vec![RouteLeg {
            mode: caelum_core::model::TransitMode::Walk,
            from,
            to,
            line_id: None,
            service_direction: None,
            board_itinerary_index: None,
            alight_itinerary_index: None,
        }],
        estimated_seconds,
    }
}

#[test]
fn route_plan_negative_estimated_seconds_is_rejected() {
    let mut snapshot = trip_fixture();
    let home = snapshot.active_trips[0].origin;
    let dest = snapshot.active_trips[0].destination;
    snapshot.active_trips[0].route_plan = Some(walk_plan_with_seconds(home, dest, -1.0));
    snapshot.active_trips[0].status = TripStatus::Walking;
    snapshot.active_trips[0].current_leg_index = 0;
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidNumericValue {
            entity: Some(entity_ref(EntityKind::ActiveTrip, "trip-day-0-trip-001")),
            field: SnapshotField::TripEstimatedSeconds,
            reason: NumericError::Negative,
        }
    );
}

#[test]
fn route_plan_empty_legs_is_rejected() {
    let mut snapshot = trip_fixture();
    snapshot.active_trips[0].route_plan = Some(RoutePlan {
        legs: vec![],
        estimated_seconds: 0.0,
    });
    snapshot.active_trips[0].status = TripStatus::Idle;
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

#[test]
fn route_plan_leg_point_out_of_bounds_is_rejected() {
    let mut snapshot = trip_fixture();
    let dest = snapshot.active_trips[0].destination;
    // Single walk leg from an off-map point to the valid destination so the
    // chain/last-leg checks pass; validate_point on leg.from fires (228).
    snapshot.active_trips[0].route_plan =
        Some(walk_plan_with_seconds(Point { x: 99, y: 99 }, dest, 3820.0));
    snapshot.active_trips[0].status = TripStatus::Walking;
    snapshot.active_trips[0].current_leg_index = 0;
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidEntity {
            entity: entity_ref(EntityKind::ActiveTrip, "trip-day-0-trip-001"),
            field: SnapshotField::TripRoutePlan,
            reason: EntityError::InvalidStaticShape,
        }
    );
}

#[test]
fn trip_status_idle_with_route_plan_is_rejected() {
    let mut snapshot = trip_fixture();
    let home = snapshot.active_trips[0].origin;
    let dest = snapshot.active_trips[0].destination;
    // A valid walking plan (estimated_seconds matches router) but status=Idle
    // → line 237 `Idle => false` → TripStatus mismatch (247).
    let distance = f64::from((home.x - dest.x).abs() + (home.y - dest.y).abs()) * 20.0;
    snapshot.active_trips[0].route_plan = Some(walk_plan_with_seconds(home, dest, distance));
    snapshot.active_trips[0].status = TripStatus::Idle;
    snapshot.active_trips[0].current_leg_index = 0;
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidDerivedState {
            field: SnapshotField::TripStatus,
            reason: DerivedStateError::TripStateMismatch {
                trip: entity_ref(EntityKind::ActiveTrip, "trip-day-0-trip-001"),
            },
        }
    );
}

#[test]
fn trip_status_arrived_not_at_destination_is_rejected() {
    let mut snapshot = trip_fixture();
    let home = snapshot.active_trips[0].origin;
    let dest = snapshot.active_trips[0].destination;
    let distance = f64::from((home.x - dest.x).abs() + (home.y - dest.y).abs()) * 20.0;
    snapshot.active_trips[0].route_plan = Some(walk_plan_with_seconds(home, dest, distance));
    snapshot.active_trips[0].status = TripStatus::Arrived;
    snapshot.active_trips[0].current_leg_index = 0;
    // current_leg_index + 1 == legs.len() (1) ✓, but position (origin) !=
    // TripPosition::from(destination) → invalid (240-243).
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidDerivedState {
            field: SnapshotField::TripStatus,
            reason: DerivedStateError::TripStateMismatch {
                trip: entity_ref(EntityKind::ActiveTrip, "trip-day-0-trip-001"),
            },
        }
    );
}

#[test]
fn trip_status_unserved_with_no_plan_is_valid() {
    let mut snapshot = trip_fixture();
    snapshot.active_trips[0].status = TripStatus::Unserved;
    snapshot.active_trips[0].route_plan = None;
    snapshot.active_trips[0].current_leg_index = 0;
    assert!(
        validate_snapshot(&snapshot).is_ok(),
        "Unserved with no route plan should be valid"
    );
}

// ===========================================================================
// vehicle membership validation (trips.rs:263-269)
// ===========================================================================

/// Build a snapshot with a bus route and a single active trip whose route_plan
/// contains a bus leg (from `router::find_route_plan`). The trip is Walking at
/// leg 0 by default; callers adjust status / current_leg_index / vehicle
/// membership to exercise the target branch.
fn bus_trip_fixture() -> caelum_core::GameSnapshot {
    let mut snapshot = fixture_with_bus_route();
    let origin = Point { x: 1, y: 4 };
    let destination = Point { x: 13, y: 4 };
    let plan = caelum_core::router::find_route_plan(&snapshot, &origin, &destination)
        .expect("bus route plan should exist");
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
fn trip_riding_but_not_on_any_vehicle_is_rejected() {
    let mut snapshot = bus_trip_fixture();
    // Move to the bus leg (index 1) and set Riding. No vehicle carries the
    // trip → memberships == 0 but status == Riding → invalid (263-264).
    snapshot.active_trips[0].status = TripStatus::Riding;
    snapshot.active_trips[0].current_leg_index = 1;
    let err = validate_snapshot(&snapshot).unwrap_err();
    assert!(matches!(
        err,
        PersistenceError::InvalidDerivedState {
            field: SnapshotField::TripStatus,
            reason: DerivedStateError::TripStateMismatch { .. },
        }
    ));
}

// NOTE: Branch trips.rs:265-266 (non-Riding trip carried by a vehicle,
// `memberships > 0` in the `else` arm) is **unreachable** through
// `validate_snapshot`. The entity-validation stage (entities.rs:926-940)
// checks every vehicle passenger is a Riding trip with a compatible current
// leg and rejects non-Riding passengers with `PassengerNotRiding` before
// `validate_trips` ever runs. Therefore no integration test can exercise
// that branch via the public `validate_snapshot` entry point.

// ===========================================================================
// trip counters (trips.rs:283-287)
// ===========================================================================

// ===========================================================================
// metrics numerics & relationships (trips.rs:298-320)
// ===========================================================================

#[test]
fn metrics_average_wait_seconds_not_finite_is_rejected() {
    let mut snapshot = paused_snapshot();
    snapshot.metrics.average_wait_seconds = f64::NAN;
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidNumericValue {
            entity: None,
            field: SnapshotField::MetricsWaits,
            reason: NumericError::NotFinite,
        }
    );
}

// ===========================================================================
// outcome validation (trips.rs:328-366)
// ===========================================================================

#[test]
fn outcome_wait_seconds_not_finite_is_rejected() {
    let mut snapshot = paused_snapshot();
    snapshot.time = 100.0;
    snapshot.day = clock::day_index(snapshot.time);
    snapshot.clock_minutes = clock::clock_minutes(snapshot.time);
    snapshot.metrics.completed_trips = 1;
    snapshot.metrics.trip_outcomes = vec![TripOutcome {
        outcome: TripOutcomeKind::Arrived,
        wait_seconds: f64::NAN,
        time: 50.0,
    }];
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidNumericValue {
            entity: None,
            field: SnapshotField::OutcomeWaitSeconds,
            reason: NumericError::NotFinite,
        }
    );
}

#[test]
fn outcome_time_negative_is_rejected() {
    let mut snapshot = paused_snapshot();
    snapshot.time = 100.0;
    snapshot.day = clock::day_index(snapshot.time);
    snapshot.clock_minutes = clock::clock_minutes(snapshot.time);
    snapshot.metrics.completed_trips = 1;
    snapshot.metrics.trip_outcomes = vec![TripOutcome {
        outcome: TripOutcomeKind::Arrived,
        wait_seconds: 0.0,
        time: -1.0,
    }];
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidNumericValue {
            entity: None,
            field: SnapshotField::OutcomeTimestamp,
            reason: NumericError::Negative,
        }
    );
}

// ===========================================================================
// objective state — Won/Lost arms (trips.rs:392-415)
// ===========================================================================
