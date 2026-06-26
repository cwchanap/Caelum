use caelum_core::model::TransitMode;
use caelum_core::{network, GameEngine, GameIntent};

fn road_line(engine: &mut GameEngine, y: i32, from_x: i32, to_x: i32) {
    for x in from_x..=to_x {
        engine.dispatch(GameIntent::LayRoad {
            point: (x, y).into(),
        });
    }
}

fn track_line(engine: &mut GameEngine, y: i32, from_x: i32, to_x: i32) {
    for x in from_x..=to_x {
        engine.dispatch(GameIntent::LayTrack {
            point: (x, y).into(),
        });
    }
}

#[test]
fn finds_straight_shortest_bus_path() {
    let mut engine = GameEngine::new();
    road_line(&mut engine, 5, 2, 6);

    let path = network::find_tile_path(
        &engine.snapshot().map,
        &(2, 5).into(),
        &(6, 5).into(),
        TransitMode::Bus,
    )
    .expect("road line should be pathable");

    let points: Vec<(i32, i32)> = path.into_iter().map(|point| (point.x, point.y)).collect();
    assert_eq!(points, vec![(2, 5), (3, 5), (4, 5), (5, 5), (6, 5)]);
}

#[test]
fn deterministic_equal_shortest_paths_use_north_east_south_west_order() {
    let mut engine = GameEngine::new();
    track_line(&mut engine, 2, 5, 7);
    track_line(&mut engine, 4, 5, 7);
    engine.dispatch(GameIntent::LayTrack {
        point: (5, 3).into(),
    });
    engine.dispatch(GameIntent::LayTrack {
        point: (7, 3).into(),
    });

    let path = network::find_tile_path(
        &engine.snapshot().map,
        &(5, 2).into(),
        &(7, 4).into(),
        TransitMode::Metro,
    )
    .expect("track ring should be pathable");

    let points: Vec<(i32, i32)> = path.into_iter().map(|point| (point.x, point.y)).collect();
    assert_eq!(points, vec![(5, 2), (6, 2), (7, 2), (7, 3), (7, 4)]);
}

#[test]
fn rejects_adjacent_off_network_endpoints_then_finds_network_path() {
    let mut engine = GameEngine::new();
    road_line(&mut engine, 5, 8, 9);

    let path = network::find_tile_path(
        &engine.snapshot().map,
        &(8, 4).into(),
        &(9, 4).into(),
        TransitMode::Bus,
    )
    .expect("adjacent off-road stops should connect through road");

    let points: Vec<(i32, i32)> = path.into_iter().map(|point| (point.x, point.y)).collect();
    assert_eq!(points, vec![(8, 4), (8, 5), (9, 5), (9, 4)]);
}

#[test]
fn one_way_roads_constrain_buses_but_not_metro() {
    let mut engine = GameEngine::new();
    road_line(&mut engine, 5, 7, 9);
    engine.dispatch(GameIntent::LayTrack {
        point: (7, 5).into(),
    });
    engine.dispatch(GameIntent::LayTrack {
        point: (8, 5).into(),
    });
    engine.dispatch(GameIntent::LayTrack {
        point: (9, 5).into(),
    });
    engine.dispatch(GameIntent::CycleRoadDirection {
        point: (8, 5).into(),
    });
    engine.dispatch(GameIntent::CycleRoadDirection {
        point: (8, 5).into(),
    });
    let snapshot = engine.snapshot();

    assert!(network::find_tile_path(
        &snapshot.map,
        &(7, 5).into(),
        &(9, 5).into(),
        TransitMode::Bus
    )
    .is_some());
    assert!(network::find_tile_path(
        &snapshot.map,
        &(9, 5).into(),
        &(7, 5).into(),
        TransitMode::Bus
    )
    .is_none());
    assert!(network::find_tile_path(
        &snapshot.map,
        &(9, 5).into(),
        &(7, 5).into(),
        TransitMode::Metro
    )
    .is_some());
}
