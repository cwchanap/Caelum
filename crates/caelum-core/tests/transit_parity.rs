use caelum_core::model::{ActiveTrip, PlacedBuilding, Point, RouteLeg, RoutePlan, Sim, Vehicle};
use caelum_core::{state::create_initial_snapshot, transit, GameEngine, GameIntent};

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

fn destination_building(
    id: &str,
    building_type: &str,
    occupied_tiles: Vec<Point>,
) -> PlacedBuilding {
    PlacedBuilding {
        id: id.to_string(),
        building_type: building_type.to_string(),
        origin: occupied_tiles[0].clone(),
        rotation: 0,
        occupied_tiles,
        transit_node_id: None,
    }
}

fn worker_sim(id: &str, position: Point, workplace: Point) -> Sim {
    Sim {
        id: id.to_string(),
        home: position.clone(),
        position,
        worker_profile: "worker".to_string(),
        shift_template: None,
        workplace: Some(workplace),
        commute_day: 0,
        outbound_arrived_today: false,
        returned_home_today: false,
    }
}

fn two_stop_bus_engine() -> GameEngine {
    let mut engine = GameEngine::new();
    road_line(&mut engine, 5, 2, 10);
    engine.dispatch(GameIntent::AddBusStop {
        point: (2, 5).into(),
        kind: "busStop".to_string(),
    });
    engine.dispatch(GameIntent::AddBusStop {
        point: (10, 5).into(),
        kind: "busStop".to_string(),
    });
    engine.dispatch(GameIntent::AddBusRoute {
        stop_ids: vec!["stop-001".to_string(), "stop-002".to_string()],
    });
    engine.dispatch(GameIntent::AssignVehicle {
        mode: "bus".to_string(),
        line_id: "route-001".to_string(),
    });
    engine
}

#[test]
fn adds_bus_stop_on_road_and_charges_budget() {
    let mut engine = GameEngine::new();
    engine.dispatch(GameIntent::LayRoad {
        point: (4, 4).into(),
    });

    let result = engine.dispatch(GameIntent::AddBusStop {
        point: (4, 4).into(),
        kind: "busStop".to_string(),
    });

    assert!(result.applied);
    assert_eq!(result.snapshot.transit.stops.len(), 1);
    let stop = &result.snapshot.transit.stops[0];
    assert_eq!(stop.id, "stop-001");
    assert_eq!(stop.kind, "busStop");
    assert_eq!(stop.platforms[0].capacity, 50);
    assert_eq!(result.snapshot.budget, 117_900);
}

#[test]
fn creates_active_bus_route_and_assigns_vehicle() {
    let engine = two_stop_bus_engine();
    let snapshot = engine.snapshot();
    let route = &snapshot.transit.routes[0];

    assert_eq!(route.id, "route-001");
    assert_eq!(route.name, "Bus 1");
    assert_eq!(route.color, "#e04f39");
    assert_eq!(route.stop_ids, vec!["stop-001", "stop-002"]);
    assert_eq!(route.vehicle_ids, vec!["vehicle-001"]);
    assert!(route.active);
    assert!(!route.path_broken);
    assert_eq!(route.segments.len(), 2);
    assert_eq!(snapshot.transit.vehicles[0].capacity, 18);
}

#[test]
fn duplicate_stop_route_stays_inactive_and_unassigned() {
    let mut engine = GameEngine::new();
    engine.dispatch(GameIntent::LayRoad {
        point: (3, 4).into(),
    });
    engine.dispatch(GameIntent::AddBusStop {
        point: (3, 4).into(),
        kind: "busStop".to_string(),
    });

    let result = engine.dispatch(GameIntent::AddBusRoute {
        stop_ids: vec!["stop-001".to_string(), "stop-001".to_string()],
    });

    assert!(result.applied);
    assert!(!result.snapshot.transit.routes[0].active);
    assert!(!result.snapshot.transit.stops[0].platforms[0]
        .route_ids
        .contains(&"route-001".to_string()));
}

#[test]
fn metro_line_serializes_station_ids_and_rejects_vehicle_when_broken() {
    let mut engine = GameEngine::new();
    engine.dispatch(GameIntent::LayTrack {
        point: (2, 4).into(),
    });
    engine.dispatch(GameIntent::LayTrack {
        point: (12, 4).into(),
    });
    engine.dispatch(GameIntent::AddMetroStation {
        point: (2, 4).into(),
    });
    engine.dispatch(GameIntent::AddMetroStation {
        point: (12, 4).into(),
    });

    let line = engine.dispatch(GameIntent::AddMetroLine {
        station_ids: vec!["station-001".to_string(), "station-002".to_string()],
    });
    assert!(line.applied);
    let serialized = serde_json::to_value(&line.snapshot.transit.metro_lines[0])
        .expect("metro line should serialize");
    assert_eq!(
        serialized.get("stationIds"),
        Some(&serde_json::json!(["station-001", "station-002"]))
    );
    assert!(serialized.get("stopIds").is_none());
    assert!(line.snapshot.transit.metro_lines[0].path_broken);

    let rejected = engine.dispatch(GameIntent::AssignVehicle {
        mode: "metro".to_string(),
        line_id: "metro-001".to_string(),
    });
    assert!(!rejected.applied);
    assert!(rejected.snapshot.transit.vehicles.is_empty());
}

#[test]
fn route_mutators_apply_to_bus_and_delete_route_scrubs_vehicle_and_platforms() {
    let mut engine = two_stop_bus_engine();

    let renamed = engine.dispatch(GameIntent::RenameRoute {
        route_id: "route-001".to_string(),
        name: "Airport Express".to_string(),
    });
    assert_eq!(renamed.snapshot.transit.routes[0].name, "Airport Express");

    let recolored = engine.dispatch(GameIntent::RecolorRoute {
        route_id: "route-001".to_string(),
        color: "#123456".to_string(),
    });
    assert_eq!(recolored.snapshot.transit.routes[0].color, "#123456");

    let inactive = engine.dispatch(GameIntent::SetRouteActive {
        route_id: "route-001".to_string(),
        active: false,
    });
    assert!(!inactive.snapshot.transit.routes[0].active);

    let deleted = engine.dispatch(GameIntent::DeleteRoute {
        route_id: "route-001".to_string(),
    });
    assert!(deleted.snapshot.transit.routes.is_empty());
    assert!(deleted.snapshot.transit.vehicles.is_empty());
    assert!(!deleted
        .snapshot
        .transit
        .stops
        .iter()
        .flat_map(|stop| stop.platforms.iter())
        .any(|platform| platform.route_ids.contains(&"route-001".to_string())));
}

#[test]
fn terminal_routes_spread_to_least_loaded_platforms_and_can_be_reassigned() {
    let mut engine = GameEngine::new();
    road_line(&mut engine, 3, 2, 12);
    engine.dispatch(GameIntent::AddBusStop {
        point: (2, 3).into(),
        kind: "busTerminal".to_string(),
    });
    engine.dispatch(GameIntent::AddBusStop {
        point: (12, 3).into(),
        kind: "busStop".to_string(),
    });
    engine.dispatch(GameIntent::AddBusRoute {
        stop_ids: vec!["stop-001".to_string(), "stop-002".to_string()],
    });
    engine.dispatch(GameIntent::AddBusRoute {
        stop_ids: vec!["stop-001".to_string(), "stop-002".to_string()],
    });

    let snapshot = engine.snapshot();
    let terminal = &snapshot.transit.stops[0];
    assert_eq!(terminal.platforms[0].route_ids, vec!["route-001"]);
    assert_eq!(terminal.platforms[1].route_ids, vec!["route-002"]);

    let moved = engine.dispatch(GameIntent::AssignRouteToPlatform {
        node_id: "stop-001".to_string(),
        route_id: "route-001".to_string(),
        platform_id: "stop-001-p2".to_string(),
    });
    let terminal = &moved.snapshot.transit.stops[0];
    assert!(terminal.platforms[0].route_ids.is_empty());
    assert_eq!(terminal.platforms[2].route_ids, vec!["route-001"]);
}

#[test]
fn cycling_road_direction_breaks_and_restores_route() {
    let mut engine = GameEngine::new();
    road_line(&mut engine, 5, 2, 10);
    engine.dispatch(GameIntent::AddBusStop {
        point: (2, 5).into(),
        kind: "busStop".to_string(),
    });
    engine.dispatch(GameIntent::AddBusStop {
        point: (10, 5).into(),
        kind: "busStop".to_string(),
    });
    engine.dispatch(GameIntent::AddBusRoute {
        stop_ids: vec!["stop-001".to_string(), "stop-002".to_string()],
    });
    assert!(!engine.snapshot().transit.routes[0].path_broken);

    let broken = engine.dispatch(GameIntent::CycleRoadDirection {
        point: (4, 5).into(),
    });
    assert_eq!(
        broken
            .snapshot
            .map
            .tiles
            .iter()
            .find(|tile| tile.x == 4 && tile.y == 5)
            .unwrap()
            .one_way
            .as_deref(),
        Some("north")
    );
    assert!(broken.snapshot.transit.routes[0].path_broken);

    for _ in 0..4 {
        engine.dispatch(GameIntent::CycleRoadDirection {
            point: (4, 5).into(),
        });
    }
    assert!(engine
        .snapshot()
        .map
        .tiles
        .iter()
        .find(|tile| tile.x == 4 && tile.y == 5)
        .unwrap()
        .one_way
        .is_none());
    assert!(!engine.snapshot().transit.routes[0].path_broken);
}

#[test]
fn bulldozes_track_before_road_on_crossing_tile() {
    let mut engine = GameEngine::new();
    engine.dispatch(GameIntent::LayRoad {
        point: (4, 4).into(),
    });
    engine.dispatch(GameIntent::LayTrack {
        point: (4, 4).into(),
    });

    let first = engine.dispatch(GameIntent::RemoveAtTile {
        point: (4, 4).into(),
    });
    let tile = first
        .snapshot
        .map
        .tiles
        .iter()
        .find(|tile| tile.x == 4 && tile.y == 4)
        .unwrap();
    assert_eq!(tile.kind, "road");
    assert!(!tile.has_track);

    let second = engine.dispatch(GameIntent::RemoveAtTile {
        point: (4, 4).into(),
    });
    let tile = second
        .snapshot
        .map
        .tiles
        .iter()
        .find(|tile| tile.x == 4 && tile.y == 4)
        .unwrap();
    assert_eq!(tile.kind, "empty");
}

#[test]
fn vehicles_advance_by_speed_over_segment_steps() {
    let mut engine = two_stop_bus_engine();
    engine.dispatch(GameIntent::SetPaused { paused: false });

    let ticked = engine.tick(1.0);

    assert!(ticked.applied);
    let progress = ticked.snapshot.transit.vehicles[0].progress;
    assert!((progress - 0.1).abs() < 0.000_001);
}

#[test]
fn removing_road_marks_route_broken_and_relaying_restores_it() {
    let mut engine = two_stop_bus_engine();

    let removed = engine.dispatch(GameIntent::RemoveAtTile {
        point: (6, 5).into(),
    });
    assert!(removed.snapshot.transit.routes[0].path_broken);

    let restored = engine.dispatch(GameIntent::LayRoad {
        point: (6, 5).into(),
    });
    assert!(!restored.snapshot.transit.routes[0].path_broken);
}

#[test]
fn removing_destination_reassigns_workplaces_away_from_removed_tiles() {
    let removed_tiles = vec![
        Point { x: 5, y: 5 },
        Point { x: 6, y: 5 },
        Point { x: 5, y: 6 },
        Point { x: 6, y: 6 },
    ];
    let remaining_tiles = vec![
        Point { x: 12, y: 5 },
        Point { x: 13, y: 5 },
        Point { x: 12, y: 6 },
        Point { x: 13, y: 6 },
        Point { x: 14, y: 5 },
        Point { x: 14, y: 6 },
    ];
    let mut state = create_initial_snapshot();
    state.buildings = vec![
        destination_building("building-001", "supermarket", removed_tiles.clone()),
        destination_building("building-002", "factory", remaining_tiles.clone()),
    ];
    state.sims = vec![
        worker_sim("sim-001", (1, 1).into(), removed_tiles[0].clone()),
        worker_sim("sim-002", (1, 2).into(), remaining_tiles[0].clone()),
    ];

    let next = transit::remove_at_tile(&state, &removed_tiles[0]).expect("destination removes");

    assert!(!next
        .buildings
        .iter()
        .any(|building| building.id == "building-001"));
    for sim in &next.sims {
        if let Some(workplace) = &sim.workplace {
            assert!(!removed_tiles.contains(workplace));
        }
    }
    let reassigned = next
        .sims
        .iter()
        .find(|sim| sim.id == "sim-001")
        .and_then(|sim| sim.workplace.clone())
        .expect("worker should be reassigned");
    assert!(remaining_tiles.contains(&reassigned));
}

#[test]
fn removing_destination_invalidates_targeting_trip_and_clears_vehicle_passenger() {
    let removed_tiles = vec![
        Point { x: 5, y: 5 },
        Point { x: 6, y: 5 },
        Point { x: 5, y: 6 },
        Point { x: 6, y: 6 },
    ];
    let remaining_tiles = vec![
        Point { x: 12, y: 5 },
        Point { x: 13, y: 5 },
        Point { x: 12, y: 6 },
        Point { x: 13, y: 6 },
        Point { x: 14, y: 5 },
        Point { x: 14, y: 6 },
    ];
    let mut state = create_initial_snapshot();
    state.buildings = vec![
        destination_building("building-001", "supermarket", removed_tiles.clone()),
        destination_building("building-002", "factory", remaining_tiles.clone()),
    ];
    state.sims = vec![worker_sim(
        "sim-001",
        Point { x: 2, y: 5 },
        removed_tiles[0].clone(),
    )];
    state.active_trips = vec![ActiveTrip {
        id: "trip-001".to_string(),
        sim_id: "sim-001".to_string(),
        purpose: "commute".to_string(),
        origin: Point { x: 2, y: 5 },
        destination: removed_tiles[0].clone(),
        position: Point { x: 3, y: 5 }.into(),
        status: "riding".to_string(),
        deadline: 3_600.0,
        route_plan: Some(RoutePlan {
            legs: vec![RouteLeg {
                mode: "bus".to_string(),
                from: Point { x: 2, y: 5 },
                to: removed_tiles[0].clone(),
                line_id: Some("route-001".to_string()),
            }],
            estimated_seconds: 120.0,
        }),
        current_leg_index: 0,
        patience_remaining: 30.0,
    }];
    state.transit.vehicles = vec![Vehicle {
        id: "vehicle-001".to_string(),
        mode: "bus".to_string(),
        line_id: "route-001".to_string(),
        capacity: 18,
        passenger_ids: vec!["trip-001".to_string(), "trip-other".to_string()],
        segment_index: 0,
        progress: 0.25,
    }];

    let next = transit::remove_at_tile(&state, &removed_tiles[0]).expect("destination removes");
    let sim = next
        .sims
        .iter()
        .find(|sim| sim.id == "sim-001")
        .expect("sim remains");
    let trip = next
        .active_trips
        .iter()
        .find(|trip| trip.id == "trip-001")
        .expect("trip remains");

    assert_eq!(trip.status, "idle");
    assert!(trip.route_plan.is_none());
    assert_eq!(trip.current_leg_index, 0);
    assert_eq!(Some(&trip.destination), sim.workplace.as_ref());
    assert!(!removed_tiles.contains(&trip.destination));
    assert!(remaining_tiles.contains(&trip.destination));
    assert!(!next.transit.vehicles[0]
        .passenger_ids
        .contains(&"trip-001".to_string()));
    assert!(next.transit.vehicles[0]
        .passenger_ids
        .contains(&"trip-other".to_string()));
}

#[test]
fn connected_metro_line_creates_vehicle() {
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

    let vehicle = engine.dispatch(GameIntent::AssignVehicle {
        mode: "metro".to_string(),
        line_id: "metro-001".to_string(),
    });

    assert!(vehicle.applied);
    assert_eq!(
        vehicle.snapshot.transit.metro_lines[0].vehicle_ids,
        vec!["vehicle-001"]
    );
    assert_eq!(vehicle.snapshot.transit.vehicles[0].capacity, 90);
}
