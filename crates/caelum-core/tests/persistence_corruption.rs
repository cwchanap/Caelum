use caelum_core::model::{
    ActiveTrip, GrowthAction, GrowthWave, Point, RouteLeg, RoutePlan, Sim, TransitMode,
    TripOutcome, TripOutcomeKind, TripPosition, TripPurpose, TripStatus, WorkerProfile,
};
use caelum_core::{
    clock, objectives, scenario, validate_snapshot, DerivedStateError, EntityError, EntityKind,
    EntityRef, PersistenceError, ScenarioError, SnapshotField,
};

mod common;

use common::persistence_fixtures::paused_snapshot;

fn worker(id: &str, home: Point, workplace: Option<Point>) -> Sim {
    Sim {
        id: id.to_string(),
        home,
        position: home,
        worker_profile: WorkerProfile::Worker,
        shift_template: Some("standard".to_string()),
        workplace,
        commute_day: 0,
        outbound_resolved_today: false,
        outbound_arrived_today: false,
        return_resolved_today: false,
        returned_home_today: false,
    }
}

fn outbound_trip(id: &str, home: Point, destination: Point) -> ActiveTrip {
    ActiveTrip {
        id: id.to_string(),
        sim_id: "sim-001".to_string(),
        purpose: TripPurpose::CommuteOutbound,
        origin: home,
        destination,
        position: TripPosition::from(home),
        status: TripStatus::Idle,
        deadline: 900.0,
        route_plan: None,
        current_leg_index: 0,
        patience_remaining: 240.0,
    }
}

fn snapshot_with_trip(destination: Point) -> caelum_core::GameSnapshot {
    let home = Point { x: 2, y: 3 };
    let mut snapshot = paused_snapshot();
    snapshot.sims = vec![worker("sim-001", home, Some(destination))];
    snapshot.active_trips = vec![outbound_trip("trip-day-0-trip-001", home, destination)];
    snapshot.trip_sequence_day = 0;
    snapshot.next_trip_sequence = 2;
    snapshot
}

#[test]
fn canonical_worker_profile_and_shift_are_rederived_from_the_sim_id() {
    let home = Point { x: 2, y: 3 };
    let mut snapshot = paused_snapshot();
    snapshot.sims = vec![worker("sim-010", home, None)];

    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidEntity {
            entity: EntityRef {
                kind: EntityKind::Sim,
                id: "sim-010".to_string(),
            },
            field: SnapshotField::SimWorkerProfile,
            reason: EntityError::InvalidStaticShape,
        }
    );
}

#[test]
fn daily_commute_flags_must_be_monotonic() {
    let home = Point { x: 2, y: 3 };
    let mut snapshot = paused_snapshot();
    let mut sim = worker("sim-001", home, Some(Point { x: 4, y: 3 }));
    sim.outbound_arrived_today = true;
    snapshot.sims = vec![sim];

    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidEntity {
            entity: EntityRef {
                kind: EntityKind::Sim,
                id: "sim-001".to_string(),
            },
            field: SnapshotField::SimDailyFlags,
            reason: EntityError::InvalidStaticShape,
        }
    );
}

#[test]
fn next_trip_sequence_must_exceed_serialized_current_day_ids() {
    let mut snapshot = snapshot_with_trip(Point { x: 4, y: 3 });
    snapshot.next_trip_sequence = 1;

    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidDerivedState {
            field: SnapshotField::NextTripSequence,
            reason: DerivedStateError::TripCounterMismatch,
        }
    );
}

#[test]
fn route_plan_estimate_must_equal_the_authoritative_leg_sum() {
    let home = Point { x: 2, y: 3 };
    let destination = Point { x: 4, y: 3 };
    let mut snapshot = snapshot_with_trip(destination);
    snapshot.active_trips[0].status = TripStatus::Walking;
    snapshot.active_trips[0].route_plan = Some(RoutePlan {
        legs: vec![RouteLeg {
            mode: TransitMode::Walk,
            from: home,
            to: destination,
            line_id: None,
            service_direction: None,
            board_itinerary_index: None,
            alight_itinerary_index: None,
        }],
        estimated_seconds: 1.0,
    });

    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidDerivedState {
            field: SnapshotField::TripRoutePlan,
            reason: DerivedStateError::TripStateMismatch {
                trip: EntityRef {
                    kind: EntityKind::ActiveTrip,
                    id: "trip-day-0-trip-001".to_string(),
                },
            },
        }
    );
}

#[test]
fn duplicate_ids_fail_in_stored_entity_order() {
    let home = Point { x: 2, y: 3 };
    let mut snapshot = paused_snapshot();
    snapshot.sims = vec![
        worker("sim-001", home, None),
        worker("sim-001", Point { x: 3, y: 3 }, None),
    ];

    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::DuplicateEntityId {
            id: "sim-001".to_string(),
            first_kind: EntityKind::Sim,
            second_kind: EntityKind::Sim,
        }
    );
}

#[test]
fn future_trip_service_day_is_rejected_before_counter_checks() {
    let mut snapshot = snapshot_with_trip(Point { x: 4, y: 3 });
    snapshot.active_trips[0].id = "trip-day-1-trip-001".to_string();
    snapshot.next_trip_sequence = 0;

    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidEntity {
            entity: EntityRef {
                kind: EntityKind::ActiveTrip,
                id: "trip-day-1-trip-001".to_string(),
            },
            field: SnapshotField::TripServiceDay,
            reason: EntityError::InvalidStaticShape,
        }
    );
}

#[test]
fn trip_sequence_increment_must_not_overflow() {
    let mut snapshot = paused_snapshot();
    snapshot.next_trip_sequence = u32::MAX;

    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidDerivedState {
            field: SnapshotField::NextTripSequence,
            reason: DerivedStateError::TripCounterMismatch,
        }
    );
}

#[test]
fn growth_building_footprint_must_fit_the_map() {
    let mut snapshot = paused_snapshot();
    let wave = GrowthWave {
        id: "wave-edge".to_string(),
        trigger_time: 100.0,
        message: "edge".to_string(),
        applied: false,
        actions: vec![GrowthAction::PlaceBuilding {
            building_type: "smallHouse".to_string(),
            origin: Point { x: 27, y: 17 },
            rotation: 0,
        }],
    };
    let (rules, scenario) =
        scenario::growing_suburb_campaign(scenario::growing_suburb_objectives(), vec![wave]);
    snapshot.rules = rules;
    snapshot.scenario = scenario;

    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidScenario {
            field: SnapshotField::GrowthWaveActions,
            reason: ScenarioError::ActionOutOfBounds {
                wave_id: "wave-edge".to_string(),
                action_index: 0,
                point: Point { x: 28, y: 17 },
            },
        }
    );
}

fn snapshot_with_old_outcomes(count: usize) -> caelum_core::GameSnapshot {
    let mut snapshot = paused_snapshot();
    snapshot.time = 1_000.0;
    snapshot.day = clock::day_index(snapshot.time);
    snapshot.clock_minutes = clock::clock_minutes(snapshot.time);
    snapshot.metrics.completed_trips = u32::try_from(count).unwrap();
    snapshot.metrics.trip_outcomes = (0..count)
        .map(|index| TripOutcome {
            outcome: TripOutcomeKind::Arrived,
            wait_seconds: 0.0,
            time: index as f64,
        })
        .collect();
    snapshot
}

#[test]
fn one_latest_outcome_older_than_the_window_is_the_valid_fallback() {
    let snapshot = snapshot_with_old_outcomes(1);
    assert!(
        snapshot.metrics.trip_outcomes[0].time < snapshot.time - objectives::ROLLING_WINDOW_SECONDS
    );
    validate_snapshot(&snapshot).unwrap();
}

#[test]
fn multiple_outcomes_older_than_the_window_are_rejected() {
    let snapshot = snapshot_with_old_outcomes(2);

    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidDerivedState {
            field: SnapshotField::MetricsTripOutcomes,
            reason: DerivedStateError::OutcomeWindowMismatch,
        }
    );
}

#[test]
fn retained_outcomes_cannot_exceed_lifetime_counters() {
    let mut snapshot = paused_snapshot();
    snapshot.metrics.trip_outcomes = vec![TripOutcome {
        outcome: TripOutcomeKind::Late,
        wait_seconds: 5.0,
        time: 0.0,
    }];

    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidDerivedState {
            field: SnapshotField::MetricsCounters,
            reason: DerivedStateError::MetricsRelationshipMismatch,
        }
    );
}
