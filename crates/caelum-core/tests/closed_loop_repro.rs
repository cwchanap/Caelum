use caelum_core::model::{Heading, Point};
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
    // Every loop tile should connect to its two actual loop neighbors.
    let expected = [
        ((5, 5), [Heading::East, Heading::South]),
        ((6, 5), [Heading::West, Heading::South]),
        ((6, 6), [Heading::North, Heading::West]),
        ((5, 6), [Heading::North, Heading::East]),
    ];
    for (p, headings) in expected {
        let tile = map
            .tile(point(p.0, p.1))
            .unwrap_or_else(|| panic!("loop tile {p:?} missing"));
        assert_eq!(
            tile.road_connections.len(),
            headings.len(),
            "loop tile {p:?} should retain connections {headings:?}, got {:?}",
            tile.road_connections
        );
        for heading in headings {
            assert!(
                tile.road_connections.contains(&heading),
                "loop tile {p:?} should connect {heading:?}, got {:?}",
                tile.road_connections
            );
        }
    }
}
