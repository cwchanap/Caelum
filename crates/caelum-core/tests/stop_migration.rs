use caelum_core::model::{Point, SNAPSHOT_SCHEMA_VERSION};
use caelum_core::{check_snapshot_schema, GameEngine, GameIntent, RoadPreset, SnapshotLoadError};

fn point(x: i32, y: i32) -> Point {
    Point { x, y }
}

fn engine_with_stop() -> GameEngine {
    let mut engine = GameEngine::new();
    let added = engine.dispatch(GameIntent::AddBusStop { point: point(4, 7) });
    assert!(added.applied, "fixture stop should apply: {added:?}");
    engine
}

#[test]
fn missing_stop_access_is_normalized_during_construction() {
    let engine = engine_with_stop();
    let mut snapshot = engine.snapshot();
    let expected_access = snapshot.transit.stops[0]
        .road_access
        .expect("fixture stop should have road access");
    snapshot.transit.stops[0].road_access = None;

    let restored =
        GameEngine::from_snapshot(snapshot).expect("construction normalizes stop access");
    assert_eq!(
        restored.snapshot().transit.stops[0].road_access,
        Some(expected_access)
    );
}

#[test]
fn from_snapshot_rejects_unsupported_schema_before_semantic_validation() {
    let mut snapshot = engine_with_stop().snapshot();
    snapshot.schema_version = SNAPSHOT_SCHEMA_VERSION - 1;
    snapshot.transit.stops[0].road_access = None;

    assert!(matches!(
        GameEngine::from_snapshot(snapshot),
        Err(SnapshotLoadError::UnsupportedSchema {
            expected: SNAPSHOT_SCHEMA_VERSION,
            actual,
        }) if actual == SNAPSHOT_SCHEMA_VERSION - 1
    ));
}

#[test]
fn old_schema_json_missing_starting_capital_is_rejected_before_full_deserialization() {
    let mut value =
        serde_json::to_value(engine_with_stop().snapshot()).expect("snapshot serializes");
    value["schemaVersion"] = serde_json::json!(3);
    value["rules"]["sandbox"]
        .as_object_mut()
        .expect("sandbox rules are an object")
        .remove("startingCapital");

    let error = check_snapshot_schema(&value)
        .expect_err("schema-v3 JSON must be rejected before full deserialization");
    let wire = serde_json::to_value(error).expect("persistence error serializes");

    assert_eq!(wire["code"], serde_json::json!("unsupportedSchema"));
    assert_eq!(wire["context"]["expected"], serde_json::json!(5));
    assert_eq!(wire["context"]["actual"], serde_json::json!(3));
}

#[test]
fn map_mutation_rederives_stale_stop_access_before_route_recompute() {
    let mut engine = GameEngine::new();
    for y in [2, 4] {
        let result = engine.dispatch(GameIntent::LayRoadLine {
            points: (2..=10).map(|x| point(x, y)).collect(),
            preset: RoadPreset::TwoWay,
        });
        assert!(result.applied, "fixture road should apply: {result:?}");
    }
    let added = engine.dispatch(GameIntent::AddBusStop { point: point(4, 3) });
    assert!(added.applied, "fixture stop should apply: {added:?}");
    assert_eq!(
        engine.snapshot().transit.stops[0]
            .road_access
            .expect("fixture access")
            .road_point,
        point(4, 2)
    );

    let removed = engine.dispatch(GameIntent::RemoveAtTile { point: point(4, 2) });
    assert!(
        removed.applied,
        "fixture road removal should apply: {removed:?}"
    );
    assert_eq!(
        engine.snapshot().transit.stops[0]
            .road_access
            .expect("access should be rederived")
            .road_point,
        point(4, 4)
    );
}
