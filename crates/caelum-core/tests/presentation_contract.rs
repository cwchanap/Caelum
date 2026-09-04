use caelum_core::model::Point;
use caelum_core::{GameEngine, GameIntent, RejectionCode};

fn point(x: i32, y: i32) -> Point {
    Point { x, y }
}

#[test]
fn current_presentation_contains_scene() {
    assert!(GameEngine::new().presentation().scene.is_some());
}

#[test]
fn tick_is_frame_only() {
    let mut engine = GameEngine::new();
    let _ = engine.dispatch(GameIntent::SetPaused { paused: false });
    assert!(engine.tick(0.1).update.scene.is_none());
}

#[test]
fn applied_dispatch_includes_scene() {
    let mut engine = GameEngine::new();
    let result = engine.dispatch(GameIntent::SetPaused { paused: false });
    assert!(result.applied);
    assert!(result.update.scene.is_some());
}

#[test]
fn rejected_dispatch_is_frame_only() {
    let mut engine = GameEngine::new();
    assert!(
        engine
            .dispatch(GameIntent::LayRoad { point: point(4, 5) })
            .applied
    );
    assert!(
        engine
            .dispatch(GameIntent::LayRoad { point: point(5, 5) })
            .applied
    );

    let result = engine.dispatch(GameIntent::AddBusStop { point: point(4, 5) });

    assert!(!result.applied);
    assert_eq!(
        result.rejection.as_ref().map(|rejection| &rejection.code),
        Some(&RejectionCode::BlockedTile),
    );
    assert!(result.update.scene.is_none());
}
