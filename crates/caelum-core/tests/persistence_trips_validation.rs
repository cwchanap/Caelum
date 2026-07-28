//! Coverage for the `persistence/trips.rs` validation branches: sims, trip
//! endpoints & position, route plan, metrics, and objective state.
//!
//! Each test builds a persistence-valid baseline snapshot (via the engine's
//! own intent pipeline + `snapshot_for_save`) and then mutates a single field
//! to exercise one rejection branch, asserting the exact `PersistenceError`.

mod common;

use caelum_core::model::{
    MetricsState, Point, TripOutcome, TripOutcomeKind, TripPosition, TripStatus, WorkerProfile,
};
use caelum_core::{
    clock, validate_snapshot, DerivedStateError, EntityError, EntityKind, NumericError,
    PersistenceError, SnapshotField,
};
use common::persistence_fixtures::{
    campaign_snapshot, entity_ref, paused_snapshot, trip_fixture, worker_sim,
};

// ===========================================================================
// sim validation
// ===========================================================================

#[test]
fn sim_home_out_of_bounds_is_rejected() {
    let mut snapshot = paused_snapshot();
    snapshot.sims = vec![worker_sim("sim-001", Point { x: 99, y: 99 }, None)];
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidEntity {
            entity: entity_ref(EntityKind::Sim, "sim-001"),
            field: SnapshotField::SimHome,
            reason: EntityError::InvalidStaticShape,
        }
    );
}

#[test]
fn sim_shift_template_mismatch_is_rejected() {
    let mut snapshot = paused_snapshot();
    let mut sim = worker_sim("sim-001", Point { x: 2, y: 3 }, None);
    sim.shift_template = Some("night".to_string());
    snapshot.sims = vec![sim];
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidEntity {
            entity: entity_ref(EntityKind::Sim, "sim-001"),
            field: SnapshotField::SimShiftTemplate,
            reason: EntityError::InvalidStaticShape,
        }
    );
}

#[test]
fn non_worker_with_workplace_is_rejected() {
    let mut snapshot = paused_snapshot();
    let mut sim = worker_sim("sim-001", Point { x: 2, y: 3 }, None);
    sim.worker_profile = WorkerProfile::NonWorker;
    sim.shift_template = None;
    sim.workplace = Some(Point { x: 4, y: 3 });
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

#[test]
fn sim_commute_day_after_current_day_is_rejected() {
    let mut snapshot = paused_snapshot();
    let mut sim = worker_sim("sim-001", Point { x: 2, y: 3 }, None);
    sim.commute_day = snapshot.day + 1;
    snapshot.sims = vec![sim];
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidEntity {
            entity: entity_ref(EntityKind::Sim, "sim-001"),
            field: SnapshotField::SimCommuteDay,
            reason: EntityError::InvalidStaticShape,
        }
    );
}

// ===========================================================================
// trip endpoint & position validation
// ===========================================================================

#[test]
fn trip_origin_out_of_bounds_is_rejected() {
    let mut snapshot = trip_fixture();
    snapshot.active_trips[0].origin = Point { x: 99, y: 99 };
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidEntity {
            entity: entity_ref(EntityKind::ActiveTrip, "trip-day-0-trip-001"),
            field: SnapshotField::TripOrigin,
            reason: EntityError::InvalidStaticShape,
        }
    );
}

#[test]
fn trip_position_not_finite_is_rejected() {
    let mut snapshot = trip_fixture();
    snapshot.active_trips[0].position = TripPosition {
        x: f64::NAN,
        y: 3.0,
    };
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidNumericValue {
            entity: Some(entity_ref(EntityKind::ActiveTrip, "trip-day-0-trip-001")),
            field: SnapshotField::TripPosition,
            reason: NumericError::NotFinite,
        }
    );
}

#[test]
fn trip_position_out_of_bounds_is_rejected() {
    let mut snapshot = trip_fixture();
    snapshot.active_trips[0].position = TripPosition { x: 999.0, y: 3.0 };
    let err = validate_snapshot(&snapshot).unwrap_err();
    assert!(matches!(
        err,
        PersistenceError::InvalidNumericValue {
            field: SnapshotField::TripPosition,
            reason: NumericError::OutOfRange { .. },
            ..
        }
    ));
}

#[test]
fn trip_position_mismatch_with_sim_is_rejected() {
    let mut snapshot = trip_fixture();
    // The validator checks sim.position != trip.origin. Change the trip's
    // origin (and position to match) so they diverge from the sim's position.
    snapshot.active_trips[0].origin = Point { x: 5, y: 5 };
    snapshot.active_trips[0].position = TripPosition::from(Point { x: 5, y: 5 });
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidDerivedState {
            field: SnapshotField::TripPosition,
            reason: DerivedStateError::TripPositionMismatch {
                trip: entity_ref(EntityKind::ActiveTrip, "trip-day-0-trip-001"),
            },
        }
    );
}

#[test]
fn trip_deadline_negative_is_rejected() {
    let mut snapshot = trip_fixture();
    snapshot.active_trips[0].deadline = -1.0;
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidNumericValue {
            entity: Some(entity_ref(EntityKind::ActiveTrip, "trip-day-0-trip-001")),
            field: SnapshotField::TripDeadline,
            reason: NumericError::Negative,
        }
    );
}

#[test]
fn trip_patience_out_of_range_is_rejected() {
    let mut snapshot = trip_fixture();
    snapshot.active_trips[0].patience_remaining = 999.0;
    let err = validate_snapshot(&snapshot).unwrap_err();
    assert!(matches!(
        err,
        PersistenceError::InvalidNumericValue {
            field: SnapshotField::TripPatience,
            reason: NumericError::OutOfRange { .. },
            ..
        }
    ));
}

#[test]
fn trip_return_purpose_not_ending_at_home_is_rejected() {
    let mut snapshot = trip_fixture();
    snapshot.active_trips[0].purpose = caelum_core::model::TripPurpose::CommuteReturn;
    snapshot.active_trips[0].destination = Point { x: 4, y: 3 };
    let err = validate_snapshot(&snapshot).unwrap_err();
    assert!(matches!(
        err,
        PersistenceError::InvalidDerivedState {
            field: SnapshotField::TripDestination,
            reason: DerivedStateError::TripStateMismatch { .. },
            ..
        }
    ));
}

#[test]
fn trip_with_no_plan_but_walking_status_is_rejected() {
    let mut snapshot = trip_fixture();
    snapshot.active_trips[0].status = TripStatus::Walking;
    let err = validate_snapshot(&snapshot).unwrap_err();
    assert!(matches!(
        err,
        PersistenceError::InvalidDerivedState {
            field: SnapshotField::TripCurrentLegIndex,
            reason: DerivedStateError::TripStateMismatch { .. },
            ..
        }
    ));
}

// ===========================================================================
// metrics validation
// ===========================================================================

#[test]
fn late_trips_exceeding_completed_trips_is_rejected() {
    let mut snapshot = paused_snapshot();
    snapshot.metrics.late_trips = 5;
    snapshot.metrics.completed_trips = 1;
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidDerivedState {
            field: SnapshotField::MetricsCounters,
            reason: DerivedStateError::MetricsRelationshipMismatch,
        }
    );
}

#[test]
fn waiting_count_zero_with_nonzero_average_wait_is_rejected() {
    let mut snapshot = paused_snapshot();
    snapshot.metrics.average_wait_seconds = 5.0;
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidDerivedState {
            field: SnapshotField::MetricsCounters,
            reason: DerivedStateError::MetricsRelationshipMismatch,
        }
    );
}

#[test]
fn outcome_timestamp_after_snapshot_time_is_rejected() {
    let mut snapshot = paused_snapshot();
    snapshot.time = 100.0;
    snapshot.day = clock::day_index(snapshot.time);
    snapshot.clock_minutes = clock::clock_minutes(snapshot.time);
    snapshot.metrics.completed_trips = 1;
    snapshot.metrics.trip_outcomes = vec![TripOutcome {
        outcome: TripOutcomeKind::Arrived,
        wait_seconds: 0.0,
        time: 200.0,
    }];
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidDerivedState {
            field: SnapshotField::MetricsTripOutcomes,
            reason: DerivedStateError::OutcomeWindowMismatch,
        }
    );
}

#[test]
fn outcome_timestamps_out_of_order_are_rejected() {
    let mut snapshot = paused_snapshot();
    snapshot.time = 1_000.0;
    snapshot.day = clock::day_index(snapshot.time);
    snapshot.clock_minutes = clock::clock_minutes(snapshot.time);
    snapshot.metrics.completed_trips = 2;
    snapshot.metrics.trip_outcomes = vec![
        TripOutcome {
            outcome: TripOutcomeKind::Arrived,
            wait_seconds: 0.0,
            time: 500.0,
        },
        TripOutcome {
            outcome: TripOutcomeKind::Arrived,
            wait_seconds: 0.0,
            time: 400.0,
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

#[test]
fn completed_trips_below_retained_outcomes_is_rejected() {
    let mut snapshot = paused_snapshot();
    snapshot.time = 100.0;
    snapshot.day = clock::day_index(snapshot.time);
    snapshot.clock_minutes = clock::clock_minutes(snapshot.time);
    snapshot.metrics.trip_outcomes = vec![TripOutcome {
        outcome: TripOutcomeKind::Arrived,
        wait_seconds: 0.0,
        time: 50.0,
    }];
    // completed_trips defaults to 0 but we retained one arrived outcome.
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidDerivedState {
            field: SnapshotField::MetricsCounters,
            reason: DerivedStateError::MetricsRelationshipMismatch,
        }
    );
}

#[test]
fn total_wait_seconds_not_finite_is_rejected() {
    let mut snapshot = paused_snapshot();
    snapshot.metrics.total_wait_seconds = f64::NAN;
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
// objective state validation (campaign)
// ===========================================================================

#[test]
fn campaign_running_state_with_met_win_objective_is_rejected() {
    let mut snapshot = campaign_snapshot();
    // Trigger the win gate: time >= survival_time (1200s) and completed_trips > 0,
    // but keep metrics.state = Running — the validator must detect the mismatch.
    snapshot.time = 1_200.0;
    snapshot.day = clock::day_index(snapshot.time);
    snapshot.clock_minutes = clock::clock_minutes(snapshot.time);
    snapshot.metrics.completed_trips = 1;
    snapshot.metrics.state = MetricsState::Running;
    snapshot.metrics.loss_reason = None;
    let err = validate_snapshot(&snapshot).unwrap_err();
    assert!(matches!(
        err,
        PersistenceError::InvalidDerivedState {
            field: SnapshotField::MetricsState,
            reason: DerivedStateError::ObjectiveStateMismatch,
            ..
        }
    ));
}
