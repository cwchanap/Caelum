use caelum_core::model::{
    ActiveTrip, GameSnapshot, PlacedBuilding, Point, PrivateCarTrip, ServicePattern, TransitMode,
    TransitNodeStatus, TransitPath, TripPurpose, TripStatus,
};
use caelum_core::road_topology::RoadTopology;
use caelum_core::traffic::{derive_road_flow, RoadFlow};
use caelum_core::{router, GameEngine, GameIntent, SandboxCreationRequest};

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

fn commute_building(id: &str, point: Point) -> PlacedBuilding {
    PlacedBuilding {
        id: id.to_string(),
        building_type: "smallHouse".to_string(),
        origin: point,
        rotation: 0,
        occupied_tiles: vec![point],
        placed_at: 0.0,
        transit_node_id: None,
    }
}

fn walk_seconds(from: Point, to: Point) -> f64 {
    f64::from((from.x - to.x).abs() + (from.y - to.y).abs())
        * caelum_core::commute::WALK_SECONDS_PER_TILE
}

fn road_path_seconds(path: &TransitPath) -> f64 {
    path.road_steps()
        .iter()
        .map(|step| step.travel_seconds)
        .sum()
}

fn no_transit_commute_fixture(distance: i32) -> (GameSnapshot, RoadTopology, Point, Point) {
    let home = Point { x: 1, y: 4 };
    let workplace = Point {
        x: home.x + distance,
        y: home.y,
    };
    let mut engine = blank_engine();
    road_line(&mut engine, 5, home.x, workplace.x);
    let mut state = engine.snapshot();
    state.buildings = vec![
        commute_building("home", home),
        commute_building("work", workplace),
    ];
    let topology = RoadTopology::compile(&state.map).expect("fixture topology compiles");
    (state, topology, home, workplace)
}

fn blank_engine() -> GameEngine {
    GameEngine::from_sandbox_request(SandboxCreationRequest {
        template_id: "blankGrid".to_string(),
        economy_preset: "standard".to_string(),
        starting_capital: Some(120_000.0),
        demand_multiplier: Some(1.0),
    })
    .expect("blank-grid fixture should construct")
}

fn bus_commute_fixture(detour: bool) -> (GameSnapshot, RoadTopology, Point, Point) {
    let home = if detour {
        Point { x: 1, y: 15 }
    } else {
        Point { x: 1, y: 4 }
    };
    let workplace = if detour {
        Point { x: 13, y: 15 }
    } else {
        Point { x: 13, y: 4 }
    };
    let mut engine = blank_engine();

    if detour {
        road_line(&mut engine, 16, 1, 13);
        road_line(&mut engine, 2, 2, 26);
        road_line(&mut engine, 13, 12, 26);
        for y in 2..=14 {
            engine.dispatch(GameIntent::LayRoad {
                point: (2, y).into(),
            });
        }
        for y in 2..=13 {
            engine.dispatch(GameIntent::LayRoad {
                point: (26, y).into(),
            });
        }
        for y in 13..=14 {
            engine.dispatch(GameIntent::LayRoad {
                point: (12, y).into(),
            });
        }
    } else {
        road_line(&mut engine, 5, 1, 13);
    }

    let stop_points = if detour {
        vec![(2, 15).into(), (12, 15).into()]
    } else {
        vec![(2, 4).into(), (12, 4).into()]
    };
    for point in &stop_points {
        let result = engine.dispatch(GameIntent::AddBusStop { point: *point });
        assert!(result.applied, "fixture stop should apply: {result:?}");
    }
    let route = engine.dispatch(GameIntent::CreateRoute {
        mode: TransitMode::Bus,
        pattern: ServicePattern::Loop,
        waypoint_ids: vec!["stop-001".to_string(), "stop-002".to_string()],
    });
    assert!(route.applied, "fixture route should apply: {route:?}");
    let assigned = engine.dispatch(GameIntent::AssignVehicle {
        mode: "bus".to_string(),
        line_id: "route-001".to_string(),
    });
    assert!(
        assigned.applied,
        "fixture vehicle should apply: {assigned:?}"
    );

    let mut state = assigned.snapshot;
    state.buildings = vec![
        commute_building("home", home),
        commute_building("work", workplace),
    ];
    let topology = RoadTopology::compile(&state.map).expect("fixture topology compiles");
    (state, topology, home, workplace)
}

fn bus_route_state() -> GameEngine {
    let mut engine = GameEngine::new();
    road_line(&mut engine, 5, 2, 12);
    engine.dispatch(GameIntent::AddBusStop {
        point: (2, 4).into(),
    });
    engine.dispatch(GameIntent::AddBusStop {
        point: (12, 4).into(),
    });
    engine.dispatch(GameIntent::CreateRoute {
        mode: TransitMode::Bus,
        pattern: ServicePattern::Loop,
        waypoint_ids: vec!["stop-001".to_string(), "stop-002".to_string()],
    });
    let assigned = engine.dispatch(GameIntent::AssignVehicle {
        mode: "bus".to_string(),
        line_id: "route-001".to_string(),
    });
    assert!(
        assigned.applied,
        "fixture vehicle should apply: {assigned:?}"
    );
    engine
}

fn left_turn_trip_fixture() -> GameSnapshot {
    let mut state = bus_route_state().snapshot();
    let leg = &mut state.transit.routes[0].legs[0];
    let TransitPath::Road {
        steps,
        total_travel_seconds,
    } = leg.current_path.as_mut().unwrap()
    else {
        panic!("bus fixture has a road path");
    };
    let left_turn_delay = 1.0;
    steps.last_mut().unwrap().travel_seconds += left_turn_delay;
    *total_travel_seconds += left_turn_delay;
    leg.estimated_seconds = Some(*total_travel_seconds);
    leg.last_valid_path = leg.current_path.clone();
    state
}

#[test]
fn creates_walking_route_for_nearby_destinations() {
    let engine = GameEngine::new();

    let plan = router::find_route_plan(
        &engine.snapshot(),
        &RoadFlow::new(),
        &(2, 3).into(),
        &(4, 3).into(),
    )
    .expect("inside-map route should exist");

    assert_eq!(plan.estimated_seconds, 40.0);
    assert_eq!(plan.legs.len(), 1);
    assert_eq!(plan.legs[0].mode, TransitMode::Walk);
    assert_eq!(plan.legs[0].service_direction, None);
    assert_eq!(plan.legs[0].board_itinerary_index, None);
    assert_eq!(plan.legs[0].alight_itinerary_index, None);
}

#[test]
fn natural_no_transit_costs_keep_short_walk_and_make_long_car_faster() {
    let (short_state, short_topology, short_home, short_workplace) = no_transit_commute_fixture(6);
    let short_walk = router::find_route_plan(
        &short_state,
        &RoadFlow::new(),
        &short_home,
        &short_workplace,
    )
    .expect("short commute should have a walking plan");
    let short_car = caelum_core::traffic::private_car_candidate(
        &short_state,
        &short_topology,
        &RoadFlow::new(),
        short_home,
        short_workplace,
    )
    .expect("short commute should have a car candidate");

    assert_eq!(short_walk.legs[0].mode, TransitMode::Walk);
    assert!(short_walk.estimated_seconds < short_car.estimated_seconds);

    let (long_state, long_topology, long_home, long_workplace) = no_transit_commute_fixture(12);
    let long_walk =
        router::find_route_plan(&long_state, &RoadFlow::new(), &long_home, &long_workplace)
            .expect("long commute should have a walking plan");
    let long_car = caelum_core::traffic::private_car_candidate(
        &long_state,
        &long_topology,
        &RoadFlow::new(),
        long_home,
        long_workplace,
    );
    let long_car = long_car.expect("long commute should have a car candidate");

    assert_eq!(long_walk.legs[0].mode, TransitMode::Walk);
    assert!(long_car.estimated_seconds < long_walk.estimated_seconds);
}

#[test]
fn natural_bus_costs_keep_direct_service_ahead_of_car_and_walk() {
    let (state, topology, home, workplace) = bus_commute_fixture(false);
    let flow = RoadFlow::new();
    let mut no_transit = state.clone();
    no_transit.transit.routes.clear();
    no_transit.transit.vehicles.clear();
    let walk = router::find_route_plan(&no_transit, &flow, &home, &workplace)
        .expect("direct bus fixture should have a route");
    let car =
        caelum_core::traffic::private_car_candidate(&state, &topology, &flow, home, workplace)
            .expect("direct bus fixture should have a car candidate");

    assert_eq!(walk.legs[0].mode, TransitMode::Walk);

    let plan = router::find_route_plan(&state, &flow, &home, &workplace)
        .expect("direct bus fixture should be routable");
    assert_eq!(
        plan.legs.iter().map(|leg| leg.mode).collect::<Vec<_>>(),
        vec![TransitMode::Walk, TransitMode::Bus, TransitMode::Walk]
    );
    let service_path = state.transit.routes[0].legs[0]
        .current_path
        .as_ref()
        .expect("direct bus route has a captured path");
    let service_seconds = road_path_seconds(service_path);
    assert!(service_seconds > 0.0);
    assert_eq!(service_path.total_travel_seconds(), service_seconds);
    assert_eq!(
        plan.estimated_seconds,
        walk_seconds(plan.legs[0].from, plan.legs[0].to)
            + 90.0
            + service_seconds
            + walk_seconds(plan.legs[2].from, plan.legs[2].to)
    );
    assert!(plan.estimated_seconds < car.estimated_seconds);
    assert!(car.estimated_seconds < walk.estimated_seconds);
}

#[test]
fn natural_detouring_bus_cost_keeps_car_ahead_of_service() {
    let (state, topology, home, workplace) = bus_commute_fixture(true);
    let flow = RoadFlow::new();
    let plan = router::find_route_plan(&state, &flow, &home, &workplace)
        .expect("detour fixture should be routable");
    let car =
        caelum_core::traffic::private_car_candidate(&state, &topology, &flow, home, workplace)
            .expect("detour fixture should have a car candidate");

    assert_eq!(
        plan.legs.iter().map(|leg| leg.mode).collect::<Vec<_>>(),
        vec![TransitMode::Walk, TransitMode::Bus, TransitMode::Walk]
    );
    assert!(car.estimated_seconds < plan.estimated_seconds);
}

#[test]
fn returns_none_for_out_of_bounds_points() {
    let engine = GameEngine::new();
    let snapshot = engine.snapshot();

    assert!(
        router::find_route_plan(&snapshot, &RoadFlow::new(), &(-1, 3).into(), &(4, 3).into())
            .is_none()
    );
    assert!(router::find_route_plan(
        &snapshot,
        &RoadFlow::new(),
        &(2, 3).into(),
        &(28, 17).into()
    )
    .is_none());
}

#[test]
fn creates_bus_route_plan_from_connected_stops() {
    let engine = bus_route_state();

    let plan = router::find_route_plan(
        &engine.snapshot(),
        &RoadFlow::new(),
        &(1, 4).into(),
        &(13, 4).into(),
    )
    .expect("bus route should be planned");

    assert_eq!(plan.estimated_seconds, 142.5);
    assert_eq!(
        plan.legs.iter().map(|leg| leg.mode).collect::<Vec<_>>(),
        vec![TransitMode::Walk, TransitMode::Bus, TransitMode::Walk]
    );
    assert_eq!(plan.legs[1].line_id.as_deref(), Some("route-001"));
    assert_eq!(
        plan.legs[1].service_direction,
        Some(caelum_core::model::ServiceDirection::Loop)
    );
    assert_eq!(plan.legs[1].board_itinerary_index, Some(0));
    assert_eq!(plan.legs[1].alight_itinerary_index, Some(0));
    assert_eq!(plan.legs[1].from, (2, 4).into());
    assert_eq!(plan.legs[1].to, (12, 4).into());
}

#[test]
fn missing_node_is_not_enumerated_as_a_router_anchor() {
    let mut snapshot = bus_route_state().snapshot();
    snapshot.transit.stops[0].status = TransitNodeStatus::Missing;
    snapshot.transit.routes[0].path_broken = false;

    let plan =
        router::find_route_plan(&snapshot, &RoadFlow::new(), &(1, 4).into(), &(13, 4).into())
            .expect("walking fallback remains available");

    assert_eq!(plan.legs.len(), 1);
    assert_eq!(plan.legs[0].mode, TransitMode::Walk);
}

#[test]
fn transit_plan_estimate_equals_the_authoritative_leg_duration() {
    let snapshot = left_turn_trip_fixture();
    let authoritative_leg_duration = snapshot.transit.routes[0].legs[0]
        .estimated_seconds
        .unwrap();
    let plan =
        router::find_route_plan(&snapshot, &RoadFlow::new(), &(2, 4).into(), &(12, 4).into())
            .expect("bus route should be planned");

    assert_eq!(plan.legs[1].mode, TransitMode::Bus);
    let transit_seconds = plan.estimated_seconds - 90.0;
    assert!((transit_seconds - authoritative_leg_duration).abs() < 1e-9);
}

#[test]
fn bus_route_plan_eta_reflects_current_car_flow_without_rebuilding_path() {
    let engine = bus_route_state();
    let mut snapshot = engine.snapshot();
    let path = snapshot.transit.routes[0].legs[0]
        .current_path
        .clone()
        .expect("bus route has a captured path");
    let stored_path_seconds = path.total_travel_seconds();
    snapshot.active_trips = (0..6)
        .map(|id| ActiveTrip {
            id: format!("car-trip-{id:03}"),
            sim_id: format!("car-sim-{id:03}"),
            purpose: TripPurpose::CommuteOutbound,
            origin: (1, 1).into(),
            destination: (13, 1).into(),
            position: (1, 1).into(),
            status: TripStatus::Driving,
            deadline: 900.0,
            route_plan: None,
            current_leg_index: 0,
            patience_remaining: 240.0,
            current_leg_wait_seconds: 0.0,
            private_car_trip: Some(PrivateCarTrip {
                path: path.clone(),
                arrival_time: 900.0,
            }),
        })
        .collect();

    let flow = derive_road_flow(&snapshot);
    let plan = router::find_route_plan(&snapshot, &flow, &(1, 4).into(), &(13, 4).into())
        .expect("bus route remains available under flow");

    assert_eq!(plan.legs[1].mode, TransitMode::Bus);
    assert!((plan.estimated_seconds - (40.0 + 90.0 + stored_path_seconds * 1.5)).abs() < 1e-9);
    assert_eq!(
        snapshot.transit.routes[0].legs[0]
            .current_path
            .as_ref()
            .expect("captured route path remains")
            .total_travel_seconds(),
        stored_path_seconds
    );
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
    let created = engine.dispatch(GameIntent::CreateRoute {
        mode: TransitMode::Metro,
        pattern: ServicePattern::Loop,
        waypoint_ids: vec!["station-001".to_string(), "station-002".to_string()],
    });
    assert!(
        created.applied,
        "metro fixture line should apply: {created:?}"
    );
    let assigned = engine.dispatch(GameIntent::AssignVehicle {
        mode: "metro".to_string(),
        line_id: "metro-001".to_string(),
    });
    assert!(
        assigned.applied,
        "metro fixture vehicle should apply: {assigned:?}"
    );

    let plan = router::find_route_plan(
        &engine.snapshot(),
        &RoadFlow::new(),
        &(1, 4).into(),
        &(13, 4).into(),
    )
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
    let inactive_plan = router::find_route_plan(
        &inactive.snapshot(),
        &RoadFlow::new(),
        &(1, 4).into(),
        &(13, 4).into(),
    )
    .unwrap();
    assert_eq!(inactive_plan.legs.len(), 1);
    assert_eq!(inactive_plan.legs[0].mode, TransitMode::Walk);

    let mut broken = bus_route_state();
    broken.dispatch(GameIntent::RemoveAtTile {
        point: (7, 5).into(),
    });
    assert!(broken.snapshot().transit.routes[0].path_broken);
    let broken_plan = router::find_route_plan(
        &broken.snapshot(),
        &RoadFlow::new(),
        &(1, 4).into(),
        &(13, 4).into(),
    )
    .unwrap();
    assert_eq!(broken_plan.legs.len(), 1);
    assert_eq!(broken_plan.legs[0].mode, TransitMode::Walk);
}
