use caelum_core::model::TransitMode;
use caelum_core::{router, GameEngine, GameIntent};

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

fn bus_route_state() -> GameEngine {
    let mut engine = GameEngine::new();
    road_line(&mut engine, 5, 2, 12);
    engine.dispatch(GameIntent::AddBusStop {
        point: (2, 5).into(),
        kind: "busStop".to_string(),
    });
    engine.dispatch(GameIntent::AddBusStop {
        point: (12, 5).into(),
        kind: "busStop".to_string(),
    });
    engine.dispatch(GameIntent::AddBusRoute {
        stop_ids: vec!["stop-001".to_string(), "stop-002".to_string()],
    });
    engine
}

#[test]
fn creates_walking_route_for_nearby_destinations() {
    let engine = GameEngine::new();

    let plan = router::find_route_plan(&engine.snapshot(), &(2, 3).into(), &(4, 3).into())
        .expect("inside-map route should exist");

    assert_eq!(plan.estimated_seconds, 40.0);
    assert_eq!(plan.legs.len(), 1);
    assert_eq!(plan.legs[0].mode, TransitMode::Walk);
}

#[test]
fn returns_none_for_out_of_bounds_points() {
    let engine = GameEngine::new();
    let snapshot = engine.snapshot();

    assert!(router::find_route_plan(&snapshot, &(-1, 3).into(), &(4, 3).into()).is_none());
    assert!(router::find_route_plan(&snapshot, &(2, 3).into(), &(28, 17).into()).is_none());
}

#[test]
fn creates_bus_route_plan_from_connected_stops() {
    let engine = bus_route_state();

    let plan = router::find_route_plan(&engine.snapshot(), &(1, 5).into(), &(13, 5).into())
        .expect("bus route should be planned");

    assert_eq!(plan.estimated_seconds, 142.5);
    assert_eq!(
        plan.legs.iter().map(|leg| leg.mode).collect::<Vec<_>>(),
        vec![TransitMode::Walk, TransitMode::Bus, TransitMode::Walk]
    );
    assert_eq!(plan.legs[1].line_id.as_deref(), Some("route-001"));
    assert_eq!(plan.legs[1].from, (2, 5).into());
    assert_eq!(plan.legs[1].to, (12, 5).into());
}

#[test]
fn creates_metro_route_plan_from_connected_stations() {
    let mut engine = GameEngine::new();
    track_line(&mut engine, 4, 2, 12);
    engine.dispatch(GameIntent::AddMetroStation {
        point: (2, 4).into(),
    });
    engine.dispatch(GameIntent::AddMetroStation {
        point: (12, 4).into(),
    });
    engine.dispatch(GameIntent::AddMetroLine {
        station_ids: vec!["station-001".to_string(), "station-002".to_string()],
    });

    let plan = router::find_route_plan(&engine.snapshot(), &(1, 4).into(), &(13, 4).into())
        .expect("metro line should be planned");

    assert_eq!(plan.estimated_seconds, 166.25);
    assert_eq!(
        plan.legs.iter().map(|leg| leg.mode).collect::<Vec<_>>(),
        vec![TransitMode::Walk, TransitMode::Metro, TransitMode::Walk]
    );
    assert_eq!(plan.legs[1].line_id.as_deref(), Some("metro-001"));
}

#[test]
fn ignores_inactive_and_path_broken_routes() {
    let mut inactive = bus_route_state();
    inactive.dispatch(GameIntent::SetRouteActive {
        route_id: "route-001".to_string(),
        active: false,
    });
    let inactive_plan =
        router::find_route_plan(&inactive.snapshot(), &(1, 5).into(), &(13, 5).into()).unwrap();
    assert_eq!(inactive_plan.legs.len(), 1);
    assert_eq!(inactive_plan.legs[0].mode, TransitMode::Walk);

    let mut broken = bus_route_state();
    broken.dispatch(GameIntent::RemoveAtTile {
        point: (7, 5).into(),
    });
    assert!(broken.snapshot().transit.routes[0].path_broken);
    let broken_plan =
        router::find_route_plan(&broken.snapshot(), &(1, 5).into(), &(13, 5).into()).unwrap();
    assert_eq!(broken_plan.legs.len(), 1);
    assert_eq!(broken_plan.legs[0].mode, TransitMode::Walk);
}
