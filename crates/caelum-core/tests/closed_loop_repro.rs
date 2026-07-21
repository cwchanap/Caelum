use caelum_core::model::Point;
use caelum_core::{GameEngine, GameIntent};

fn point(x: i32, y: i32) -> Point {
    Point { x, y }
}

#[test]
fn closed_2x2_loop_preserves_internal_connections() {
    let mut engine = GameEngine::new();
    // Lay four individual roads forming a 2x2 closed loop. Each LayRoad
    // auto-connects to existing road neighbors via connect_neighbor_endpoints.
    for p in [(5, 5), (6, 5), (6, 6), (5, 6)] {
        let result = engine.dispatch(GameIntent::LayRoad {
            point: point(p.0, p.1),
        });
        assert!(result.applied, "LayRoad at {p:?} should apply: {result:?}");
    }

    let map = &engine.snapshot().map;
    // Every loop tile should have exactly two connections (its loop neighbors).
    for p in [(5, 5), (6, 5), (6, 6), (5, 6)] {
        let tile = map
            .tile(point(p.0, p.1))
            .unwrap_or_else(|| panic!("loop tile {p:?} missing"));
        assert_eq!(
            tile.road_connections.len(),
            2,
            "loop tile {p:?} should retain 2 connections, got {:?}",
            tile.road_connections
        );
    }
}
