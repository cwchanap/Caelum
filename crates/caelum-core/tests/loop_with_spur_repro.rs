use caelum_core::model::{Heading, Point};
use caelum_core::{GameEngine, GameIntent, RoadPreset};

fn point(x: i32, y: i32) -> Point {
    Point { x, y }
}

fn road_line(engine: &mut GameEngine, points: Vec<Point>) {
    engine.dispatch(GameIntent::LayRoadLine {
        points,
        preset: RoadPreset::TwoWay,
    });
}

#[test]
fn loop_with_single_axis_spur_stays_connected() {
    let mut engine = GameEngine::new();
    // (4,5) spur -> 2x2 loop (5,5)-(6,5)-(6,6)-(5,6)
    road_line(
        &mut engine,
        vec![
            point(4, 5),
            point(5, 5),
            point(6, 5),
            point(6, 6),
            point(5, 6),
        ],
    );
    let snapshot = engine.snapshot();
    let topology = caelum_core::road_topology::RoadTopology::compile(&snapshot.map)
        .expect("topology must compile");
    assert!(
        topology
            .find_path(&snapshot.map, &point(5, 5), &point(5, 6))
            .is_some(),
        "loop with single-axis spur must stay connected"
    );
    // The vertical internal edges of the 2x2 ring must survive.
    let t_55 = snapshot.map.tile(point(5, 5)).expect("tile (5,5)");
    let t_56 = snapshot.map.tile(point(5, 6)).expect("tile (5,6)");
    assert!(
        t_55.road_connections.contains(&Heading::South),
        "(5,5) south edge pruned: {:?}",
        t_55.road_connections
    );
    assert!(
        t_56.road_connections.contains(&Heading::North),
        "(5,6) north edge pruned: {:?}",
        t_56.road_connections
    );
}
