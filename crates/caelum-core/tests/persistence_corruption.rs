use caelum_core::model::{
    GrowthAction, GrowthWave, Point, Sim, TripOutcome, TripOutcomeKind, WorkerProfile,
};
use caelum_core::{
    clock, objectives, scenario, validate_snapshot, EntityKind, PersistenceError, ScenarioError,
    SnapshotField,
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
