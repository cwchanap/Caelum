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
    ActiveTrip, MetricsState, Point, RouteLeg, RoutePlan, TripOutcome, TripOutcomeKind,
    TripPosition, TripStatus, WorkerProfile,
};
use caelum_core::{
    clock, validate_snapshot, DerivedStateError, EntityError, EntityKind, NumericError,
    PersistenceError, SnapshotField,
};
use common::persistence_fixtures::{
    campaign_snapshot, entity_ref, fixture_with_bus_route, paused_snapshot, trip_fixture,
    worker_sim,
};

// ===========================================================================
// sim validation — profile mismatch (trips.rs:90-94)
// ===========================================================================

#[test]
fn sim_worker_profile_mismatch_is_rejected() {
    let mut snapshot = paused_snapshot();
    // "sim-001" maps to Worker (suffix 1 % 10 != 0). Set NonWorker with no
    // shift/workplace so the NonWorker+workplace guard (103-109) does not fire;
    // the profile-mismatch branch (90-94) fires first.
    let mut sim = worker_sim("sim-001", Point { x: 2, y: 3 }, None);
    sim.worker_profile = WorkerProfile::NonWorker;
    sim.shift_template = None;
    sim.workplace = None;
    snapshot.sims = vec![sim];
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidEntity {
            entity: entity_ref(EntityKind::Sim, "sim-001"),
            field: SnapshotField::SimWorkerProfile,
            reason: EntityError::InvalidStaticShape,
        }
    );
}

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

#[test]
fn duplicate_trip_key_is_rejected() {
    let mut snapshot = trip_fixture();
    let first = snapshot.active_trips[0].clone();
    let mut second = first.clone();
    second.id = "trip-day-0-trip-002".to_string();
    snapshot.active_trips.push(second);
    // Bump the counter so the duplicate check (inside the loop) is the branch
    // that fires, not the post-loop counter check.
    snapshot.next_trip_sequence = 3;
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidDerivedState {
            field: SnapshotField::TripPurpose,
            reason: DerivedStateError::TripStateMismatch {
                trip: entity_ref(EntityKind::ActiveTrip, "trip-day-0-trip-002"),
            },
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
fn route_plan_estimated_seconds_mismatch_is_rejected() {
    let mut snapshot = trip_fixture();
    let home = snapshot.active_trips[0].origin;
    let dest = snapshot.active_trips[0].destination;
    // Build a walking plan whose estimated_seconds matches the router's
    // formula (manhattan distance * 20.0), then bump it by +1.0 so it no
    // longer equals router::route_plan_estimated_seconds (232).
    let correct_seconds = f64::from((home.x - dest.x).abs() + (home.y - dest.y).abs()) * 20.0;
    let plan = walk_plan_with_seconds(home, dest, correct_seconds + 1.0);
    snapshot.active_trips[0].route_plan = Some(plan);
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

#[test]
fn trip_counters_next_sequence_not_greater_than_max_is_rejected() {
    let mut snapshot = trip_fixture();
    // trip-day-0-trip-001 → max_current_day_sequence = 1.
    // next_trip_sequence = 1 is not > 1 → TripCounterMismatch.
    snapshot.next_trip_sequence = 1;
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidDerivedState {
            field: SnapshotField::NextTripSequence,
            reason: DerivedStateError::TripCounterMismatch,
        }
    );
}

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

#[test]
fn metrics_waiting_count_exceeds_nonterminal_count_is_rejected() {
    let mut snapshot = paused_snapshot();
    // No active trips → nonterminal_count = 0. waiting_trip_count = 5 > 0.
    snapshot.metrics.waiting_trip_count = 5;
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidDerivedState {
            field: SnapshotField::MetricsCounters,
            reason: DerivedStateError::MetricsRelationshipMismatch,
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

#[test]
fn outcome_window_not_pruned_is_rejected() {
    let mut snapshot = campaign_snapshot();
    snapshot.time = 1_000.0;
    snapshot.day = clock::day_index(snapshot.time);
    snapshot.clock_minutes = clock::clock_minutes(snapshot.time);
    snapshot.metrics.completed_trips = 2;
    // Rolling window is 300s → window_start = 700. The first outcome (t=100)
    // is outside the window and should have been pruned, but we retain it.
    snapshot.metrics.trip_outcomes = vec![
        TripOutcome {
            outcome: TripOutcomeKind::Arrived,
            wait_seconds: 0.0,
            time: 100.0,
        },
        TripOutcome {
            outcome: TripOutcomeKind::Arrived,
            wait_seconds: 0.0,
            time: 800.0,
        },
    ];
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidDerivedState {
            field: SnapshotField::MetricsTripOutcomes,
            reason: DerivedStateError::OutcomeWindowMismatch,
        }
    );
}

// ===========================================================================
// objective state — Won/Lost arms (trips.rs:392-415)
// ===========================================================================

#[test]
fn campaign_won_state_with_lost_metrics_is_rejected() {
    let mut snapshot = campaign_snapshot();
    // Trigger the win gate: time >= survival_time (1200s) and completed_trips
    // > 0. With state=Running, evaluate_objectives_opt returns Won. Set
    // metrics.state = Lost (wrong) → expected_state != snapshot state (408).
    snapshot.time = 1_200.0;
    snapshot.day = clock::day_index(snapshot.time);
    snapshot.clock_minutes = clock::clock_minutes(snapshot.time);
    snapshot.metrics.completed_trips = 1;
    snapshot.metrics.state = MetricsState::Lost;
    snapshot.metrics.loss_reason = Some("Too many unserved citizens".to_string());
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidDerivedState {
            field: SnapshotField::MetricsState,
            reason: DerivedStateError::ObjectiveStateMismatch,
        }
    );
}

#[test]
fn campaign_lost_state_with_wrong_loss_reason_is_rejected() {
    let mut snapshot = campaign_snapshot();
    // Trigger the unserved loss gate: total_trips >= 10 and unserved ratio >
    // 0.20. With state=Running, evaluate_objectives_opt returns Lost with
    // reason "Too many unserved citizens". Set a different loss_reason →
    // LossReasonMismatch (411-415).
    snapshot.metrics.completed_trips = 8;
    snapshot.metrics.unserved_trips = 3; // total = 11, 3/11 ≈ 0.27 > 0.20
    snapshot.metrics.state = MetricsState::Lost;
    snapshot.metrics.loss_reason = Some("wrong reason".to_string());
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidDerivedState {
            field: SnapshotField::MetricsLossReason,
            reason: DerivedStateError::LossReasonMismatch,
        }
    );
}
