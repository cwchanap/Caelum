//! Coverage for the `persistence/trips.rs` validation branches: sims, trip
//! endpoints & position, route plan, metrics, and objective state.
//!
//! Each test builds a persistence-valid baseline snapshot (via the engine's
//! own intent pipeline + `snapshot_for_save`) and then mutates a single field
//! to exercise one rejection branch, asserting the exact `PersistenceError`.

mod common;

use caelum_core::model::{Point, TripPosition, TripStatus};
use caelum_core::{
    validate_snapshot, DerivedStateError, EntityError, EntityKind, NumericError, PersistenceError,
    SnapshotField,
};
use common::persistence_fixtures::{entity_ref, paused_snapshot, trip_fixture, worker_sim};

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
