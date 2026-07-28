use caelum_core::model::{Point, ServicePattern, TransitMode, TripStatus};
use caelum_core::{
    validate_snapshot, GameEngine, GameIntent, ModeError, NumericError, PersistenceError,
    RoadPreset, SnapshotField, TileError,
};

mod common;

use common::persistence_fixtures::paused_snapshot;

#[test]
fn canonical_schema_v4_snapshot_is_persistence_valid() {
    validate_snapshot(&paused_snapshot()).unwrap();
}

#[test]
fn persistence_requires_paused_state_before_any_dependent_validation() {
    let mut snapshot = GameEngine::new().snapshot();
    snapshot.paused = false;
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidModeSettings {
            field: SnapshotField::Paused,
            reason: ModeError::PersistenceRequiresPaused,
        }
    );
}

#[test]
fn nonfinite_time_is_rejected_without_copying_it_into_context() {
    let mut snapshot = paused_snapshot();
    snapshot.time = f64::NAN;
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidNumericValue {
            entity: None,
            field: SnapshotField::Time,
            reason: NumericError::NotFinite,
        }
    );
}

#[test]
fn row_major_tile_drift_has_a_deterministic_first_error() {
    let mut snapshot = paused_snapshot();
    snapshot.map.tiles[0].x = 1;
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidTile {
            tile_id: "tile-0-0".to_string(),
            reason: TileError::WrongRowMajorCoordinate {
                expected: caelum_core::model::Point { x: 0, y: 0 },
                actual: caelum_core::model::Point { x: 1, y: 0 },
            },
        }
    );
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
    let saved = engine.snapshot_for_save().unwrap();
    assert_eq!(
        saved.metrics.waiting_trip_count,
        waiting.metrics.waiting_trip_count
    );

    apply(&mut engine, GameIntent::SetPaused { paused: false });
    assert!(engine.tick(1.0).applied);
    apply(&mut engine, GameIntent::SetPaused { paused: true });
    engine
        .snapshot_for_save()
        .expect("a post-invalidation gameplay replan must remain saveable");
}
