use caelum_core::model::{Point, RoadStructure, RoundaboutSize, Station, TransitNodeStatus};
use caelum_core::{GameEngine, GameIntent, RoadPreset, SnapshotLoadError};

fn invalid_snapshot(error: SnapshotLoadError) {
    assert!(
        matches!(error, SnapshotLoadError::InvalidSnapshot(_)),
        "expected an invalid snapshot error, got {error:?}"
    );
}

fn from_snapshot_error(snapshot: caelum_core::GameSnapshot) -> SnapshotLoadError {
    match GameEngine::from_snapshot(snapshot) {
        Ok(_) => panic!("expected snapshot construction to fail"),
        Err(error) => error,
    }
}

fn engine_with_bus_route() -> GameEngine {
    let mut engine = GameEngine::new();
    assert!(
        engine
            .dispatch(GameIntent::LayRoadLine {
                points: (2..=12).map(|x| Point { x, y: 5 }).collect(),
                preset: RoadPreset::TwoWay,
            })
            .applied
    );
    for point in [Point { x: 2, y: 4 }, Point { x: 10, y: 4 }] {
        assert!(engine.dispatch(GameIntent::AddBusStop { point }).applied);
    }
    assert!(
        engine
            .dispatch(GameIntent::CreateRoute {
                mode: caelum_core::model::TransitMode::Bus,
                pattern: caelum_core::model::ServicePattern::Loop,
                waypoint_ids: vec!["stop-001".to_string(), "stop-002".to_string()],
            })
            .applied
    );
    engine
}

#[test]
fn unsupported_schema_rejects_before_replacing_the_target() {
    let mut target = GameEngine::new();
    let before = target.snapshot();
    let mut candidate = before.clone();
    candidate.schema_version -= 1;

    let error = target.restore_snapshot(candidate).unwrap_err();

    assert_eq!(
        error,
        SnapshotLoadError::UnsupportedSchema {
            expected: caelum_core::SNAPSHOT_SCHEMA_VERSION,
            actual: caelum_core::SNAPSHOT_SCHEMA_VERSION - 1,
        }
    );
    assert_eq!(target.snapshot(), before);
}

#[test]
fn wrong_tile_count_is_rejected() {
    let mut candidate = GameEngine::new().snapshot();
    candidate.map.tiles.pop();

    invalid_snapshot(from_snapshot_error(candidate));
}

#[test]
fn duplicate_entity_id_is_rejected() {
    let mut candidate = engine_with_bus_route().snapshot();
    candidate.transit.stations.push(Station {
        id: "stop-001".to_string(),
        status: TransitNodeStatus::Missing,
        position: Point { x: 4, y: 4 },
        platforms: Vec::new(),
    });

    invalid_snapshot(from_snapshot_error(candidate));
}

#[test]
fn missing_route_reference_is_rejected() {
    let mut candidate = engine_with_bus_route().snapshot();
    candidate.transit.routes[0].stop_ids[0] = "missing-node".to_string();

    invalid_snapshot(from_snapshot_error(candidate));
}

#[test]
fn non_reciprocal_ordinary_road_is_rejected_before_topology_compile() {
    let mut candidate = GameEngine::new();
    assert!(
        candidate
            .dispatch(GameIntent::LayRoadLine {
                points: (2..=4).map(|x| Point { x, y: 5 }).collect(),
                preset: RoadPreset::TwoWay,
            })
            .applied
    );
    let mut snapshot = candidate.snapshot();
    snapshot
        .map
        .tile_mut(Point { x: 3, y: 5 })
        .expect("fixture road tile")
        .road_connections
        .clear();

    invalid_snapshot(from_snapshot_error(snapshot));
}

#[test]
fn genuine_structure_compile_failure_is_rejected_by_from_snapshot() {
    let mut snapshot = GameEngine::new().snapshot();
    let structure_id = "roundabout-unsafe".to_string();
    let footprint = vec![Point { x: 4, y: 2 }, Point { x: 5, y: 2 }];
    for point in &footprint {
        let tile = snapshot.map.tile_mut(*point).expect("fixture tile");
        tile.kind = "road".to_string();
        tile.road_structure_id = Some(structure_id.clone());
    }
    snapshot
        .map
        .road_structures
        .push(RoadStructure::Roundabout {
            id: structure_id,
            origin: Point {
                x: i32::MAX,
                y: i32::MAX,
            },
            size: RoundaboutSize::Compact2x2,
            footprint,
            ports: Vec::new(),
        });

    invalid_snapshot(from_snapshot_error(snapshot));
}

#[test]
fn failed_restore_preserves_the_active_engine() {
    let mut target = GameEngine::new();
    let before = target.snapshot();
    let mut candidate = before.clone();
    candidate.map.tiles.pop();

    invalid_snapshot(target.restore_snapshot(candidate).unwrap_err());
    assert_eq!(target.snapshot(), before);
}

#[test]
fn save_returns_a_paused_clone_without_mutating_live_state() {
    let mut engine = GameEngine::new();
    assert!(
        engine
            .dispatch(GameIntent::SetPaused { paused: false })
            .applied
    );
    let before = engine.snapshot();

    let saved = engine.snapshot_for_save();

    assert!(saved.paused);
    assert_eq!(engine.snapshot(), before);
}

#[test]
fn deterministic_round_trip_preserves_the_save_snapshot() {
    let engine = engine_with_bus_route();
    let saved = engine.snapshot_for_save();
    let restored = GameEngine::from_snapshot(saved.clone()).expect("save must load");

    assert_eq!(restored.snapshot_for_save(), saved);
}
