use caelum_core::clock::{GAME_DAY_SECONDS, MINUTES_PER_DAY};
use caelum_core::commute::departure_minute_for_sim;
use caelum_core::model::{
    CitizenRoutine, Point, ScheduledActivity, ScheduledActivityKind, ServicePattern, Sim,
    TransitMode, TripStatus, SNAPSHOT_SCHEMA_VERSION,
};
use caelum_core::{check_schema_version, GameEngine, GameIntent, RoadPreset, SnapshotLoadError};

mod common;

use common::persistence_fixtures::paused_snapshot;

#[test]
fn canonical_schema_snapshot_is_persistence_valid() {
    GameEngine::from_snapshot(paused_snapshot()).unwrap();
}

fn worker_routine(workplace: Option<Point>) -> CitizenRoutine {
    CitizenRoutine::Worker {
        shift_template: "standard".to_string(),
        workplace,
    }
}

/// The canonical day-0 outbound departure, as a `DailyRoutine` wake.
fn day0_outbound_wake(sim_id: &str) -> ScheduledActivity {
    ScheduledActivity {
        kind: ScheduledActivityKind::DailyRoutine,
        due_time: f64::from(departure_minute_for_sim(sim_id, "standard", "outbound"))
            / f64::from(MINUTES_PER_DAY)
            * GAME_DAY_SECONDS,
    }
}

fn worker_idle_sim(id: &str, home: Point, workplace: Option<Point>) -> Sim {
    Sim {
        id: id.to_string(),
        home,
        position: home,
        routine: worker_routine(workplace),
        next_activity: Some(day0_outbound_wake(id)),
    }
}

#[test]
fn worker_idle_schedule_round_trips_through_save_and_restore() {
    let mut snapshot = paused_snapshot();
    snapshot.sims = vec![worker_idle_sim(
        "sim-001",
        Point::from((2, 3)),
        Some(Point::from((8, 3))),
    )];

    let engine = GameEngine::from_snapshot(snapshot.clone()).unwrap();
    let restored = GameEngine::from_snapshot(engine.snapshot_for_save()).unwrap();

    assert_eq!(restored.snapshot().sims, snapshot.sims);
}

#[test]
fn student_idle_schedule_round_trips_through_save_and_restore() {
    let mut snapshot = paused_snapshot();
    snapshot.sims = vec![Sim {
        id: "sim-010".to_string(),
        home: Point::from((2, 3)),
        position: Point::from((2, 3)),
        routine: CitizenRoutine::Student,
        // Dormant Stage-A wake: next midnight.
        next_activity: Some(ScheduledActivity {
            kind: ScheduledActivityKind::DailyRoutine,
            due_time: GAME_DAY_SECONDS,
        }),
    }];

    let engine = GameEngine::from_snapshot(snapshot.clone()).unwrap();
    let restored = GameEngine::from_snapshot(engine.snapshot_for_save()).unwrap();

    assert_eq!(restored.snapshot().sims, snapshot.sims);
}

#[test]
fn travelling_sim_without_next_activity_round_trips_through_save_and_restore() {
    let home = Point::from((2, 3));
    let workplace = Point::from((8, 3));
    let mut snapshot = paused_snapshot();
    snapshot.sims = vec![Sim {
        id: "sim-001".to_string(),
        home,
        position: Point::from((4, 3)),
        routine: worker_routine(Some(workplace)),
        next_activity: None,
    }];
    snapshot.active_trips = vec![caelum_core::model::ActiveTrip {
        id: "trip-day-0-trip-001".to_string(),
        sim_id: "sim-001".to_string(),
        purpose: caelum_core::model::TripPurpose::CommuteOutbound,
        origin: home,
        destination: workplace,
        position: caelum_core::model::TripPosition { x: 4.0, y: 3.0 },
        status: TripStatus::Walking,
        deadline: 900.0,
        route_plan: Some(caelum_core::model::RoutePlan {
            legs: vec![caelum_core::model::RouteLeg {
                mode: TransitMode::Walk,
                from: home,
                to: workplace,
                line_id: None,
                service_direction: None,
                board_itinerary_index: None,
                alight_itinerary_index: None,
            }],
            estimated_seconds: 120.0,
        }),
        current_leg_index: 0,
        patience_remaining: 240.0,
        current_leg_wait_seconds: 0.0,
        private_car_trip: None,
    }];

    let engine = GameEngine::from_snapshot(snapshot.clone()).unwrap();
    let restored = GameEngine::from_snapshot(engine.snapshot_for_save()).unwrap();

    assert_eq!(restored.snapshot().sims, snapshot.sims);
    assert_eq!(restored.snapshot().sims[0].next_activity, None);
}

#[test]
fn schema_9_rejects_with_expected_10_actual_9() {
    assert_eq!(
        check_schema_version(9),
        Err(SnapshotLoadError::UnsupportedSchema {
            expected: SNAPSHOT_SCHEMA_VERSION,
            actual: 9,
        })
    );

    let mut snapshot = paused_snapshot();
    snapshot.schema_version = 9;
    match GameEngine::from_snapshot(snapshot) {
        Err(SnapshotLoadError::UnsupportedSchema { expected, actual }) => {
            assert_eq!(expected, SNAPSHOT_SCHEMA_VERSION);
            assert_eq!(expected, 10);
            assert_eq!(actual, 9);
        }
        Err(error) => panic!("schema 9 must be rejected as unsupported, got {error:?}"),
        Ok(_) => panic!("schema 9 must be rejected"),
    }
}

#[test]
fn snapshot_for_save_matches_the_engine_minted_capture() {
    let mut engine = GameEngine::new();
    apply(&mut engine, GameIntent::SetPaused { paused: false });

    assert!(engine.snapshot_for_save().paused);
}

fn apply(engine: &mut GameEngine, intent: GameIntent) {
    let result = engine.dispatch(intent);
    assert!(
        result.applied,
        "fixture intent was rejected or unchanged: {:?}",
        result.rejection
    );
}

#[test]
fn save_accepts_last_tick_waiting_metrics_after_route_deletion() {
    let mut engine = GameEngine::new();
    apply(
        &mut engine,
        GameIntent::LayRoadLine {
            points: (2..=12).map(|x| Point { x, y: 5 }).collect(),
            preset: RoadPreset::TwoWay,
        },
    );
    for point in [Point { x: 2, y: 4 }, Point { x: 10, y: 4 }] {
        apply(&mut engine, GameIntent::AddBusStop { point });
    }
    apply(
        &mut engine,
        GameIntent::CreateRoute {
            mode: TransitMode::Bus,
            pattern: ServicePattern::Loop,
            waypoint_ids: vec!["stop-001".to_string(), "stop-002".to_string()],
        },
    );
    apply(
        &mut engine,
        GameIntent::AssignVehicle {
            mode: "bus".to_string(),
            line_id: "route-001".to_string(),
        },
    );
    apply(
        &mut engine,
        GameIntent::PaintAreaRectangle {
            area: "residential".to_string(),
            start: Point { x: 2, y: 2 },
            end: Point { x: 3, y: 2 },
        },
    );
    apply(
        &mut engine,
        GameIntent::PlaceBuilding {
            building_type: "smallHouse".to_string(),
            origin: Point { x: 2, y: 2 },
            rotation: 0,
        },
    );
    apply(
        &mut engine,
        GameIntent::PaintAreaRectangle {
            area: "commercial".to_string(),
            start: Point { x: 10, y: 2 },
            end: Point { x: 11, y: 3 },
        },
    );
    apply(
        &mut engine,
        GameIntent::PlaceBuilding {
            building_type: "supermarket".to_string(),
            origin: Point { x: 10, y: 2 },
            rotation: 0,
        },
    );
    apply(&mut engine, GameIntent::SetPaused { paused: false });
    assert!(engine.tick(350.9).applied);

    for _ in 0..120 {
        if engine.snapshot().metrics.waiting_trip_count > 0 {
            break;
        }
        assert!(engine.tick(1.0).applied);
    }
    let waiting = engine.snapshot();
    assert!(waiting.metrics.waiting_trip_count > 0);
    assert!(waiting
        .active_trips
        .iter()
        .any(|trip| trip.status == TripStatus::Waiting));

    apply(
        &mut engine,
        GameIntent::DeleteRoute {
            route_id: "route-001".to_string(),
        },
    );
    let invalidated = engine.snapshot();
    assert!(invalidated
        .active_trips
        .iter()
        .all(|trip| trip.status != TripStatus::Waiting));
    assert_eq!(
        invalidated.metrics.waiting_trip_count,
        waiting.metrics.waiting_trip_count
    );

    apply(&mut engine, GameIntent::SetPaused { paused: true });
    let saved = engine.snapshot_for_save();
    assert_eq!(
        saved.metrics.waiting_trip_count,
        waiting.metrics.waiting_trip_count
    );

    apply(&mut engine, GameIntent::SetPaused { paused: false });
    assert!(engine.tick(1.0).applied);
    apply(&mut engine, GameIntent::SetPaused { paused: true });
    let _ = engine.snapshot_for_save();
}
