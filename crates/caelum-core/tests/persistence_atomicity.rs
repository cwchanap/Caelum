use caelum_core::model::Point;
use caelum_core::{GameEngine, GameIntent};

#[test]
fn save_capture_prepares_only_an_engine_minted_snapshot() {
    let mut engine = GameEngine::new();
    assert!(
        engine
            .dispatch(GameIntent::SetPaused { paused: false })
            .applied
    );
    let before = engine.snapshot();

    let saved = engine.capture_snapshot_for_save().prepare().unwrap();

    let mut expected = before.clone();
    expected.paused = true;
    assert_eq!(saved, expected);
    assert_eq!(engine.snapshot(), before);
}

#[test]
fn dropping_a_prepared_restore_does_not_mutate_an_existing_engine() {
    let source = GameEngine::new();
    let candidate = source.snapshot_for_save().unwrap();
    let target = GameEngine::new();
    let before = target.snapshot();

    let prepared = GameEngine::prepare_restore(candidate).unwrap();
    drop(prepared);

    assert_eq!(target.snapshot(), before);
}

#[test]
fn prepared_restore_retains_the_supplied_snapshot_and_compiled_topology() {
    let mut source = GameEngine::new();
    let laid = source.dispatch(GameIntent::LayRoad {
        point: Point { x: 3, y: 3 },
    });
    assert!(laid.applied, "fixture road should apply: {laid:?}");
    let candidate = source.snapshot_for_save().unwrap();
    let expected_topology = source.road_topology_for_test().clone();

    let prepared = GameEngine::prepare_restore(candidate.clone()).unwrap();

    assert_eq!(prepared.snapshot(), &candidate);
    let restored = prepared.into_engine();
    assert_eq!(restored.snapshot(), candidate);
    assert_eq!(restored.road_topology_for_test(), &expected_topology);
}

#[test]
fn save_changes_only_paused_on_a_validated_clone() {
    let mut engine = GameEngine::new();
    let resumed = engine.dispatch(GameIntent::SetPaused { paused: false });
    assert!(resumed.applied);
    let before = engine.snapshot();

    let saved = engine.snapshot_for_save().unwrap();

    assert!(saved.paused);
    assert_eq!(engine.snapshot(), before);
    let mut expected = before;
    expected.paused = true;
    assert_eq!(saved, expected);
}

#[test]
fn invalid_live_state_cannot_be_handed_out_for_save() {
    let mut engine = GameEngine::new();
    engine.set_budget_for_test(-1);

    assert!(engine.snapshot_for_save().is_err());
}

#[test]
fn strict_construction_preserves_the_snapshot_and_rebuilds_equal_topology() {
    let source = GameEngine::new();
    let expected_snapshot = source.snapshot_for_save().unwrap();
    let expected_topology = source.road_topology_for_test().clone();

    let restored = GameEngine::from_snapshot(expected_snapshot.clone()).unwrap();

    assert_eq!(restored.snapshot(), expected_snapshot);
    assert_eq!(restored.road_topology_for_test(), &expected_topology);
}

#[test]
fn late_restore_failure_preserves_snapshot_and_topology() {
    let mut engine = GameEngine::new();
    let before_snapshot = engine.snapshot();
    let before_topology = engine.road_topology_for_test().clone();
    let mut corrupt = before_snapshot.clone();
    corrupt.metrics.total_wait_seconds = f64::NAN;

    assert!(engine.restore_snapshot(corrupt).is_err());

    assert_eq!(engine.snapshot(), before_snapshot);
    assert_eq!(engine.road_topology_for_test(), &before_topology);
}

#[test]
fn valid_restore_swaps_snapshot_and_topology_together() {
    let mut source = GameEngine::new();
    // Mutate the road network so the source topology differs from the default
    // engine's topology. This ensures the topology comparison below actually
    // verifies that restore_snapshot replaces the target's cached topology,
    // rather than trivially matching two identical default topologies.
    let laid = source.dispatch(GameIntent::LayRoad {
        point: Point { x: 3, y: 3 },
    });
    assert!(laid.applied, "fixture road should apply: {laid:?}");
    let changed = source.dispatch(GameIntent::SetSpeed { speed: 2 });
    assert!(changed.applied);
    let expected_snapshot = source.snapshot_for_save().unwrap();
    let expected_topology = source.road_topology_for_test().clone();

    let mut target = GameEngine::new();
    let restored = target.restore_snapshot(expected_snapshot.clone()).unwrap();

    assert_eq!(restored, expected_snapshot);
    assert_eq!(target.snapshot(), expected_snapshot);
    assert_eq!(target.road_topology_for_test(), &expected_topology);
}
