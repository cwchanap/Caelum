use caelum_core::model::{Heading, Point};
use caelum_core::road::{apply_road_mutation, RoadMutation};
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
fn transient_off_axis_arrows_on_loop_cells_preserve_ring_edge() {
    let mut engine = GameEngine::new();
    // 2x2 loop (5,5)-(6,5)-(6,6)-(5,6)
    road_line(
        &mut engine,
        vec![point(5, 5), point(6, 5), point(6, 6), point(5, 6)],
    );

    // None -> North on both top cells: each has a real vertical South edge as
    // part of the ring, so the transient arrows must not read as parallel lanes
    // and strip the East/West edge between (5,5) and (6,5).
    let mut state = engine.snapshot();
    for point in [point(5, 5), point(6, 5)] {
        state.map.tile_mut(point).unwrap().one_way = Some(Heading::North);
    }
    let result = apply_road_mutation(&state, &RoadMutation::LayRoad { point: point(1, 1) })
        .expect("canonicalizing mutation applies");

    let map = &result.snapshot.map;
    assert!(
        map.tile(point(5, 5))
            .expect("tile (5,5)")
            .road_connections
            .contains(&Heading::East),
        "ring edge (5,5)->East pruned during North transient: {:?}",
        map.tile(point(5, 5)).unwrap().road_connections
    );
    assert!(
        map.tile(point(6, 5))
            .expect("tile (6,5)")
            .road_connections
            .contains(&Heading::West),
        "ring edge (6,5)->West pruned during North transient",
    );

    // Continue None -> North -> East; the removed ring edge would never return.
    let mut state = result.snapshot;
    for point in [point(5, 5), point(6, 5)] {
        state.map.tile_mut(point).unwrap().one_way = Some(Heading::East);
    }
    let result = apply_road_mutation(&state, &RoadMutation::LayRoad { point: point(2, 1) })
        .expect("canonicalizing mutation applies");

    let map = &result.snapshot.map;
    assert_eq!(map.tile(point(5, 5)).unwrap().one_way, Some(Heading::East));
    assert_eq!(map.tile(point(6, 5)).unwrap().one_way, Some(Heading::East));
    assert!(
        map.tile(point(5, 5))
            .expect("tile (5,5)")
            .road_connections
            .contains(&Heading::East),
        "ring edge permanently lost after full direction cycle"
    );
    assert!(
        caelum_core::road_topology::RoadTopology::compile(&result.snapshot.map)
            .expect("topology must compile")
            .find_path_between_access_tiles(
                &result.snapshot.map,
                point(5, 5),
                point(6, 5),
                None,
                None
            )
            .is_ok(),
        "adjacent loop cells must stay connected"
    );
}

#[test]
fn opposite_transient_arrows_on_loop_cells_preserve_ring_edge() {
    let mut engine = GameEngine::new();
    // 2x2 loop (5,5)-(6,5)-(6,6)-(5,6)
    road_line(
        &mut engine,
        vec![point(5, 5), point(6, 5), point(6, 6), point(5, 6)],
    );

    // Opposite transient arrows on the top cells: only one side carries an
    // arrow-aligned edge, which is still not proof of parallel lanes.
    let mut state = engine.snapshot();
    state.map.tile_mut(point(5, 5)).unwrap().one_way = Some(Heading::North);
    state.map.tile_mut(point(6, 5)).unwrap().one_way = Some(Heading::South);
    let result = apply_road_mutation(&state, &RoadMutation::LayRoad { point: point(1, 1) })
        .expect("canonicalizing mutation applies");

    assert_eq!(
        result.snapshot.map.tile(point(5, 5)).unwrap().one_way,
        Some(Heading::North)
    );
    assert_eq!(
        result.snapshot.map.tile(point(6, 5)).unwrap().one_way,
        Some(Heading::South)
    );
    let map = &result.snapshot.map;
    assert!(
        map.tile(point(5, 5))
            .expect("tile (5,5)")
            .road_connections
            .contains(&Heading::East),
        "ring edge (5,5)->East pruned under opposite transient arrows"
    );
    assert!(
        map.tile(point(6, 5))
            .expect("tile (6,5)")
            .road_connections
            .contains(&Heading::West),
        "ring edge (6,5)->West pruned under opposite transient arrows"
    );
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
            .find_path_between_access_tiles(&snapshot.map, point(5, 5), point(5, 6), None, None)
            .is_ok(),
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
