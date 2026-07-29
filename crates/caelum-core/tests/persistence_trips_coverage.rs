//! Coverage for the remaining uncovered `persistence/trips.rs` validation
//! branches: NonWorker-with-workplace guard, sim daily-flag invariant,
//! trip destination out of bounds, CommuteOutbound origin mismatch,
//! Unserved status with a route plan, Unserved outcome counting, campaign
//! terminal-without-objectives (Running + stale loss_reason), Won state with
//! no objective fire, and loss-reason mismatch.
//!
//! Each test builds a persistence-valid baseline snapshot (via the shared
//! fixtures) and then mutates a single field to exercise one rejection branch,
//! asserting the exact `PersistenceError`.

mod common;

use caelum_core::model::{
    MetricsState, Point, TripOutcome, TripOutcomeKind, TripPosition, TripStatus, WorkerProfile,
};
use caelum_core::{
    clock, validate_snapshot, DerivedStateError, EntityError, EntityKind, ModeError,
    PersistenceError, SnapshotField,
};
use common::persistence_fixtures::{
    campaign_snapshot, entity_ref, paused_snapshot, trip_fixture, walking_plan, worker_sim,
};

// ===========================================================================
// sim validation — NonWorker with workplace (trips.rs:108-114)
// ===========================================================================

#[test]
fn sim_non_worker_with_workplace_is_rejected() {
    let mut snapshot = paused_snapshot();
    // "sim-010" maps to NonWorker (suffix 10 % 10 == 0). Set the correct
    // NonWorker profile and no shift_template (matching expectations) but keep
    // a workplace → the NonWorker + workplace guard (108-114) fires.
    let mut sim = worker_sim("sim-010", Point { x: 2, y: 3 }, Some(Point { x: 4, y: 3 }));
    sim.worker_profile = WorkerProfile::NonWorker;
    sim.shift_template = None;
    snapshot.sims = vec![sim];
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidEntity {
            entity: entity_ref(EntityKind::Sim, "sim-010"),
            field: SnapshotField::SimWorkerProfile,
            reason: EntityError::InvalidStaticShape,
        }
    );
}

// ===========================================================================
// sim validation — daily flag invariant (trips.rs:119-129)
// ===========================================================================

#[test]
fn sim_return_resolved_without_outbound_resolved_is_rejected() {
    let mut snapshot = paused_snapshot();
    // return_resolved_today=true but outbound_resolved_today=false → the
    // third flag condition (122-123) is true → SimDailyFlags error (128).
    let mut sim = worker_sim("sim-001", Point { x: 2, y: 3 }, Some(Point { x: 4, y: 3 }));
    sim.return_resolved_today = true;
    snapshot.sims = vec![sim];
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidEntity {
            entity: entity_ref(EntityKind::Sim, "sim-001"),
            field: SnapshotField::SimDailyFlags,
            reason: EntityError::InvalidStaticShape,
        }
    );
}

// ===========================================================================
// trip endpoint validation — destination out of bounds (trips.rs:141-146)
// ===========================================================================

#[test]
fn trip_destination_out_of_bounds_is_rejected() {
    let mut snapshot = trip_fixture();
    snapshot.active_trips[0].destination = Point { x: 99, y: 99 };
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidEntity {
            entity: entity_ref(EntityKind::ActiveTrip, "trip-day-0-trip-001"),
            field: SnapshotField::TripDestination,
            reason: EntityError::InvalidStaticShape,
        }
    );
}

// ===========================================================================
// trip endpoint validation — CommuteOutbound origin != home (trips.rs:160-167)
// ===========================================================================

#[test]
fn trip_commute_outbound_origin_not_home_is_rejected() {
    let mut snapshot = trip_fixture();
    // Move sim position away from home and set trip origin to match sim
    // position so the position-mismatch check (147) passes. The CommuteOutbound
    // validity check requires origin == sim.home; since origin (3,3) != home
    // (2,3) the trip is invalid → field = TripOrigin (163).
    let away = Point { x: 3, y: 3 };
    snapshot.sims[0].position = away;
    snapshot.active_trips[0].origin = away;
    snapshot.active_trips[0].position = TripPosition::from(away);
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidDerivedState {
            field: SnapshotField::TripOrigin,
            reason: DerivedStateError::TripStateMismatch {
                trip: entity_ref(EntityKind::ActiveTrip, "trip-day-0-trip-001"),
            },
        }
    );
}

// ===========================================================================
// route-plan status — Unserved with route plan (trips.rs:250)
// ===========================================================================

#[test]
fn trip_unserved_with_route_plan_is_valid() {
    let mut snapshot = trip_fixture();
    let home = snapshot.active_trips[0].origin;
    let dest = snapshot.active_trips[0].destination;
    // Unserved with a valid route plan → valid_status = true (250). The trip
    // should pass all validation.
    snapshot.active_trips[0].route_plan = Some(walking_plan(home, dest));
    snapshot.active_trips[0].status = TripStatus::Unserved;
    snapshot.active_trips[0].current_leg_index = 0;
    assert!(
        validate_snapshot(&snapshot).is_ok(),
        "Unserved with a valid route plan should be valid"
    );
}

// ===========================================================================
// metrics outcome — Unserved kind counting (trips.rs:350-352)
// ===========================================================================

#[test]
fn outcome_unserved_kind_is_counted() {
    let mut snapshot = paused_snapshot();
    snapshot.time = 100.0;
    snapshot.day = clock::day_index(snapshot.time);
    snapshot.clock_minutes = clock::clock_minutes(snapshot.time);
    snapshot.metrics.unserved_trips = 1;
    snapshot.metrics.trip_outcomes = vec![TripOutcome {
        outcome: TripOutcomeKind::Unserved,
        wait_seconds: 0.0,
        time: 50.0,
    }];
    // The Unserved outcome increments retained_unserved (350-352); with
    // unserved_trips == 1 the retained-count check passes and the snapshot
    // is valid.
    assert!(
        validate_snapshot(&snapshot).is_ok(),
        "Unserved outcome with matching unserved_trips counter should be valid"
    );
}

// ===========================================================================
// objective state — campaign no objectives, Running + loss_reason (trips.rs:382-386)
// ===========================================================================

#[test]
fn campaign_no_objectives_running_with_loss_reason_is_rejected() {
    let mut snapshot = campaign_snapshot();
    snapshot.scenario.objectives = None;
    // map.rs only rejects non-Running state when objectives is None; Running
    // with a stale loss_reason passes map.rs but trips.rs:379 requires
    // loss_reason.is_none() → InvalidModeSettings (383-386).
    snapshot.metrics.loss_reason = Some("stale reason".to_string());
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidModeSettings {
            field: SnapshotField::MetricsState,
            reason: ModeError::CampaignTerminalWithoutObjectives,
        }
    );
}

// ===========================================================================
// objective state — Won but no objective fires (trips.rs:400-401)
// ===========================================================================

#[test]
fn campaign_won_state_but_no_objective_fires_is_rejected() {
    let mut snapshot = campaign_snapshot();
    // Set state=Won but leave all counters at zero and time < survival_time.
    // When the validator re-evaluates with state=Running, no objective fires
    // → evaluate_objectives_opt returns None → ObjectiveStateMismatch (401).
    snapshot.metrics.state = MetricsState::Won;
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidDerivedState {
            field: SnapshotField::MetricsState,
            reason: DerivedStateError::ObjectiveStateMismatch,
        }
    );
}

// ===========================================================================
// objective state — Lost with wrong loss reason (trips.rs:415-419)
// ===========================================================================

#[test]
fn campaign_lost_state_with_wrong_loss_reason_is_rejected() {
    let mut snapshot = campaign_snapshot();
    // Trigger the late-arrivals loss gate: completed_trips >= 10 and
    // late_trips / completed_trips > 0.25. With state=Running,
    // evaluate_objectives_opt returns Lost with reason "Too many late
    // arrivals". Set a different loss_reason → LossReasonMismatch (416-419).
    snapshot.metrics.completed_trips = 10;
    snapshot.metrics.late_trips = 3; // 3/10 = 0.3 > 0.25
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

// ===========================================================================
// objective state — valid Won state (trips.rs:420 fall-through)
// ===========================================================================

#[test]
fn campaign_won_state_with_matching_loss_reason_is_valid() {
    let mut snapshot = campaign_snapshot();
    // Trigger the win gate: time >= survival_time (1200s) and completed_trips
    // > 0. With state=Running, evaluate_objectives_opt returns Won with
    // loss_reason=None. Set state=Won and loss_reason=None to match → the
    // loss_reason check (415) is false, execution falls through the if-block
    // closing brace (420) and the snapshot is valid.
    snapshot.time = 1_200.0;
    snapshot.day = clock::day_index(snapshot.time);
    snapshot.clock_minutes = clock::clock_minutes(snapshot.time);
    snapshot.metrics.completed_trips = 1;
    snapshot.metrics.state = MetricsState::Won;
    snapshot.metrics.loss_reason = None;
    assert!(
        validate_snapshot(&snapshot).is_ok(),
        "Won state with matching objective evaluation should be valid"
    );
}
