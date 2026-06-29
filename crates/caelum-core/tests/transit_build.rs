use caelum_core::model::{
    ActiveTrip, PlacedBuilding, Point, Route, RouteLeg, RoutePlan, Sim, TransitMode, TripPurpose,
    TripStatus, Vehicle, WorkerProfile,
};
use caelum_core::{state::create_initial_snapshot, transit, GameEngine, GameIntent, RoadPreset};

fn simple_route(id: &str, stop_ids: &[&str]) -> Route {
    Route {
        id: id.to_string(),
        name: id.to_string(),
        color: "#000000".to_string(),
        stop_ids: stop_ids.iter().map(|s| s.to_string()).collect(),
        vehicle_ids: Vec::new(),
        active: true,
        segments: Vec::new(),
        path_broken: false,
    }
}

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
        worker_profile: WorkerProfile::Worker,
        shift_template: None,
        workplace: Some(workplace),
        commute_day: 0,
        outbound_resolved_today: false,
        outbound_arrived_today: false,
        return_resolved_today: false,
        returned_home_today: false,
    }
}

fn two_stop_bus_engine() -> GameEngine {
    let mut engine = GameEngine::new();
    road_line(&mut engine, 5, 2, 10);
    engine.dispatch(GameIntent::AddBusStop {
        point: (2, 5).into(),
    });
    engine.dispatch(GameIntent::AddBusStop {
        point: (10, 5).into(),
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
    // Bus terminals are placed as buildings (3x2 footprint, 12,000 cost) via
    // PlaceBuilding, not via AddBusStop. The terminal sits on empty tiles at
    // y=4..5, just south of the road at y=3; its stop anchor is the building
    // origin (2,4) and is reachable as an off-network final hop.
    engine.dispatch(GameIntent::PlaceBuilding {
        building_type: "busTerminal".to_string(),
        origin: (2, 4).into(),
        rotation: 0,
    });
    engine.dispatch(GameIntent::AddBusStop {
        point: (12, 3).into(),
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
    });
    engine.dispatch(GameIntent::AddBusStop {
        point: (10, 5).into(),
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
fn lay_road_line_one_way_sets_axis_direction_and_charges_new_tiles() {
    let mut engine = GameEngine::new();

    let result = engine.dispatch(GameIntent::LayRoadLine {
        points: vec![(1, 1).into(), (2, 1).into(), (3, 1).into()],
        preset: RoadPreset::OneWay,
    });

    assert!(result.applied);
    assert_eq!(result.rejection, None);
    assert_eq!(result.snapshot.budget, 120_000 - 3 * 100);
    let directions: Vec<Option<&str>> = result
        .snapshot
        .map
        .tiles
        .iter()
        .filter(|tile| tile.y == 1 && (1..=3).contains(&tile.x))
        .map(|tile| tile.one_way.as_deref())
        .collect();
    assert_eq!(directions, vec![Some("east"), Some("east"), Some("east")]);
}

#[test]
fn lay_road_line_dual_bidirectional_adds_left_reverse_lane_without_hijacking_existing_roads() {
    let mut engine = GameEngine::new();
    engine.dispatch(GameIntent::LayRoad {
        point: (1, 0).into(),
    });

    let result = engine.dispatch(GameIntent::LayRoadLine {
        points: vec![(1, 1).into(), (2, 1).into(), (3, 1).into()],
        preset: RoadPreset::DualBidirectional,
    });

    assert!(result.applied);
    let tile = |x: i32, y: i32| {
        result
            .snapshot
            .map
            .tiles
            .iter()
            .find(|tile| tile.x == x && tile.y == y)
            .expect("tile exists")
    };
    assert_eq!(tile(1, 1).one_way.as_deref(), Some("east"));
    assert_eq!(tile(2, 1).one_way.as_deref(), Some("east"));
    assert_eq!(tile(3, 1).one_way.as_deref(), Some("east"));
    assert_eq!(tile(1, 0).one_way.as_deref(), None);
    assert_eq!(tile(2, 0).one_way.as_deref(), Some("west"));
    assert_eq!(tile(3, 0).one_way.as_deref(), Some("west"));
}

#[test]
fn lay_road_line_dual_bidirectional_reverse_lane_is_drag_order_invariant() {
    // The same physical corridor must place the reverse carriageway on the same
    // side whether the drag runs low→high (east) or high→low (west). Before the
    // canonical-direction fix, a westward drag offset the reverse lane to the
    // opposite side (south) of an eastward drag (north), so extending a
    // corridor with an opposite-direction drag flipped the carriageway mid-line.
    let east = {
        let mut engine = GameEngine::new();
        engine.dispatch(GameIntent::LayRoadLine {
            points: vec![(1, 5).into(), (2, 5).into(), (3, 5).into()],
            preset: RoadPreset::DualBidirectional,
        })
    };
    let west = {
        let mut engine = GameEngine::new();
        engine.dispatch(GameIntent::LayRoadLine {
            points: vec![(3, 5).into(), (2, 5).into(), (1, 5).into()],
            preset: RoadPreset::DualBidirectional,
        })
    };

    let one_way_at = |snap: &caelum_core::GameSnapshot, x: i32, y: i32| {
        snap.map
            .tiles
            .iter()
            .find(|tile| tile.x == x && tile.y == y)
            .and_then(|tile| tile.one_way.clone())
    };

    // Forward carriageway (y=5) and reverse carriageway (y=4, north/left of
    // east) carry the same directions in both drag orders.
    for x in 1..=3 {
        assert_eq!(
            one_way_at(&east.snapshot, x, 5).as_deref(),
            Some("east"),
            "eastward forward lane at ({x},5)"
        );
        assert_eq!(
            one_way_at(&west.snapshot, x, 5).as_deref(),
            Some("east"),
            "westward drag must still place east forward lane at ({x},5)"
        );
        assert_eq!(
            one_way_at(&east.snapshot, x, 4).as_deref(),
            Some("west"),
            "eastward reverse lane at ({x},4)"
        );
        assert_eq!(
            one_way_at(&west.snapshot, x, 4).as_deref(),
            Some("west"),
            "westward drag must place the reverse lane on the SAME side (north) at ({x},4)"
        );
        // The opposite side (y=6, south) must stay empty in both cases.
        assert!(
            one_way_at(&east.snapshot, x, 6).is_none()
                && one_way_at(&west.snapshot, x, 6).is_none(),
            "no reverse lane should leak to the south side at ({x},6)"
        );
    }
}

#[test]
fn lay_track_line_and_remove_at_tiles_skip_invalid_tiles_but_apply_valid_tiles() {
    let mut engine = GameEngine::new();
    let track = engine.dispatch(GameIntent::LayTrackLine {
        points: vec![(4, 4).into(), (5, 4).into(), (100, 100).into()],
    });

    assert!(track.applied);
    assert_eq!(track.snapshot.budget, 120_000 - 2 * 500);
    assert!(
        track
            .snapshot
            .map
            .tiles
            .iter()
            .find(|tile| tile.x == 4 && tile.y == 4)
            .expect("tile exists")
            .has_track
    );

    let removed = engine.dispatch(GameIntent::RemoveAtTiles {
        points: vec![(4, 4).into(), (5, 4).into(), (100, 100).into()],
    });

    assert!(removed.applied);
    assert!(
        !removed
            .snapshot
            .map
            .tiles
            .iter()
            .find(|tile| tile.x == 4 && tile.y == 4)
            .expect("tile exists")
            .has_track
    );
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
        purpose: TripPurpose::CommuteOutbound,
        origin: Point { x: 2, y: 5 },
        destination: removed_tiles[0].clone(),
        position: Point { x: 3, y: 5 }.into(),
        status: TripStatus::Riding,
        deadline: 3_600.0,
        route_plan: Some(RoutePlan {
            legs: vec![RouteLeg {
                mode: TransitMode::Bus,
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
        mode: TransitMode::Bus,
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

    assert_eq!(trip.status, TripStatus::Idle);
    assert!(trip.route_plan.is_none());
    assert_eq!(trip.current_leg_index, 0);
    assert_eq!(Some(&trip.destination), sim.workplace.as_ref());
    assert!(!removed_tiles.contains(&trip.destination));
    assert!(remaining_tiles.contains(&trip.destination));
    // Retargeting starts a fresh trip, so the patience/deadline window must
    // refresh (legacy `retargetCitizens` parity). The pre-retarget trip had
    // patience_remaining 30.0 and deadline 3_600.0; with state.time == 0.0 the
    // fresh window is deadline 900.0 / patience 240.0.
    assert_eq!(trip.patience_remaining, 240.0);
    assert_eq!(trip.deadline, 900.0);
    assert!(!next.transit.vehicles[0]
        .passenger_ids
        .contains(&"trip-001".to_string()));
    assert!(next.transit.vehicles[0]
        .passenger_ids
        .contains(&"trip-other".to_string()));
}

#[test]
fn retargeting_outbound_trip_refreshes_elapsed_deadline_and_drained_patience() {
    // Regression: a trip whose destination is bulldozed late in its commute has
    // already consumed most of its patience and its deadline may have elapsed.
    // Retargeting to a replacement workplace must start a fresh trip with
    // refreshed timers; otherwise `tick_trips` would mark the validly retargeted
    // trip unserved on the next tick (deadline grace elapsed, patience <= 0).
    // Mirrors legacy `retargetCitizens` (buildingSelectors.ts deadline = t + 900,
    // patienceRemaining = 240).
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
    // Mid-commute: deadline long elapsed (well past the 300s grace), patience
    // almost gone. Without the timer refresh this trip is doomed on the next
    // tick regardless of the retarget.
    state.time = 5_000.0;
    state.active_trips = vec![ActiveTrip {
        id: "trip-001".to_string(),
        sim_id: "sim-001".to_string(),
        purpose: TripPurpose::CommuteOutbound,
        origin: Point { x: 2, y: 5 },
        destination: removed_tiles[0].clone(),
        position: Point { x: 3, y: 5 }.into(),
        status: TripStatus::Riding,
        deadline: 1_000.0,
        route_plan: Some(RoutePlan {
            legs: vec![RouteLeg {
                mode: TransitMode::Bus,
                from: Point { x: 2, y: 5 },
                to: removed_tiles[0].clone(),
                line_id: Some("route-001".to_string()),
            }],
            estimated_seconds: 120.0,
        }),
        current_leg_index: 0,
        patience_remaining: 2.0,
    }];

    let next = transit::remove_at_tile(&state, &removed_tiles[0]).expect("destination removes");
    let trip = next
        .active_trips
        .iter()
        .find(|trip| trip.id == "trip-001")
        .expect("trip remains retargeted");

    // Fresh trip window: deadline = state.time + 900, patience fully restored.
    assert_eq!(trip.deadline, 5_000.0 + 900.0);
    assert_eq!(trip.patience_remaining, 240.0);
    assert_eq!(trip.status, TripStatus::Idle);
    assert!(trip.route_plan.is_none());
}

#[test]
fn removing_destination_keeps_return_trip_targeting_home() {
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
    ];
    let home = Point { x: 2, y: 5 };
    let mut state = create_initial_snapshot();
    state.buildings = vec![
        destination_building("building-001", "supermarket", removed_tiles.clone()),
        destination_building("building-002", "factory", remaining_tiles.clone()),
    ];
    // Worker is mid-return: origin is the (about to be removed) workplace, but the
    // trip's destination is home. Clearing the workplace must not retarget this
    // return trip toward a replacement workplace.
    let mut sim = worker_sim("sim-001", home.clone(), removed_tiles[0].clone());
    sim.outbound_resolved_today = true;
    sim.outbound_arrived_today = true;
    state.sims = vec![sim];
    state.active_trips = vec![ActiveTrip {
        id: "trip-day-0-trip-001".to_string(),
        sim_id: "sim-001".to_string(),
        purpose: TripPurpose::CommuteReturn,
        origin: removed_tiles[0].clone(),
        destination: home.clone(),
        position: Point { x: 4, y: 5 }.into(),
        status: TripStatus::Walking,
        deadline: 3_600.0,
        route_plan: Some(RoutePlan {
            legs: vec![RouteLeg {
                mode: TransitMode::Walk,
                from: Point { x: 4, y: 5 },
                to: home.clone(),
                line_id: None,
            }],
            estimated_seconds: 60.0,
        }),
        current_leg_index: 0,
        patience_remaining: 240.0,
    }];

    let next = transit::remove_at_tile(&state, &removed_tiles[0]).expect("destination removes");

    let sim = next
        .sims
        .iter()
        .find(|sim| sim.id == "sim-001")
        .expect("sim remains");
    // Workplace was cleared and reassigned to a still-standing destination...
    let reassigned = sim
        .workplace
        .clone()
        .expect("worker reassigned to a replacement workplace");
    assert!(remaining_tiles.contains(&reassigned));

    // ...but the in-flight return trip must still head home, not to the new
    // workplace. apply_arrival_to_sim resolves CommuteReturn at home, so routing
    // it elsewhere would be wasted movement and wrong visuals.
    let trip = next
        .active_trips
        .iter()
        .find(|trip| trip.id == "trip-day-0-trip-001")
        .expect("return trip remains");
    assert_eq!(trip.destination, home);
    assert!(!remaining_tiles.contains(&trip.destination));
    assert_eq!(trip.status, TripStatus::Walking);
    assert!(trip.route_plan.is_some());
}

#[test]
fn removing_last_destination_drops_orphaned_outbound_trip() {
    let removed_tiles = vec![
        Point { x: 5, y: 5 },
        Point { x: 6, y: 5 },
        Point { x: 5, y: 6 },
        Point { x: 6, y: 6 },
    ];
    let home = Point { x: 2, y: 5 };
    let mut state = create_initial_snapshot();
    // Only one destination building exists, so bulldozing it leaves no replacement.
    state.buildings = vec![destination_building(
        "building-001",
        "supermarket",
        removed_tiles.clone(),
    )];
    state.sims = vec![worker_sim(
        "sim-001",
        home.clone(),
        removed_tiles[0].clone(),
    )];
    state.active_trips = vec![ActiveTrip {
        id: "trip-day-0-trip-001".to_string(),
        sim_id: "sim-001".to_string(),
        purpose: TripPurpose::CommuteOutbound,
        origin: home.clone(),
        destination: removed_tiles[0].clone(),
        position: Point { x: 3, y: 5 }.into(),
        status: TripStatus::Walking,
        deadline: 3_600.0,
        route_plan: Some(RoutePlan {
            legs: vec![RouteLeg {
                mode: TransitMode::Walk,
                from: Point { x: 3, y: 5 },
                to: removed_tiles[0].clone(),
                line_id: None,
            }],
            estimated_seconds: 60.0,
        }),
        current_leg_index: 0,
        patience_remaining: 240.0,
    }];
    state.transit.vehicles = vec![Vehicle {
        id: "vehicle-001".to_string(),
        mode: TransitMode::Bus,
        line_id: "route-001".to_string(),
        capacity: 18,
        passenger_ids: vec!["trip-day-0-trip-001".to_string()],
        segment_index: 0,
        progress: 0.25,
    }];

    let next = transit::remove_at_tile(&state, &removed_tiles[0]).expect("destination removes");

    // The sim is left without a workplace...
    let sim = next
        .sims
        .iter()
        .find(|sim| sim.id == "sim-001")
        .expect("sim remains");
    assert!(sim.workplace.is_none());

    // ...and the orphaned outbound trip is gone entirely — not converted into a
    // dormant home-fallback trip (destination == home, purpose CommuteOutbound)
    // that would live forever and block same-day retries via has_trip_for_sim_day.
    assert!(next
        .active_trips
        .iter()
        .all(|trip| trip.id != "trip-day-0-trip-001"));
    assert!(!next
        .active_trips
        .iter()
        .any(|trip| trip.sim_id == "sim-001" && trip.purpose == TripPurpose::CommuteOutbound));
    assert!(next.transit.vehicles[0]
        .passenger_ids
        .iter()
        .all(|id| id != "trip-day-0-trip-001"));
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

#[test]
fn deleting_earlier_leg_line_leaves_transferred_trip_riding_other_line() {
    // Regression: a trip that already transferred off route-A (leg 0) onto
    // route-B (leg 1) must not be invalidated when route-A is deleted. The old
    // logic matched route-A anywhere in the plan, reset the trip to Idle, and
    // left its id aboard route-B's vehicle — a ghost passenger that consumed a
    // seat forever and blocked re-boarding via occupied_passenger_ids.
    let mut state = create_initial_snapshot();
    state.transit.routes = vec![
        simple_route("route-A", &["a1", "a2"]),
        simple_route("route-B", &["b1", "b2"]),
    ];
    state.transit.vehicles = vec![
        Vehicle {
            id: "veh-A".to_string(),
            mode: TransitMode::Bus,
            line_id: "route-A".to_string(),
            capacity: 18,
            passenger_ids: Vec::new(),
            segment_index: 0,
            progress: 0.0,
        },
        Vehicle {
            id: "veh-B".to_string(),
            mode: TransitMode::Bus,
            line_id: "route-B".to_string(),
            capacity: 18,
            passenger_ids: vec!["trip-001".to_string()],
            segment_index: 0,
            progress: 0.4,
        },
    ];
    state.active_trips = vec![ActiveTrip {
        id: "trip-001".to_string(),
        sim_id: "sim-001".to_string(),
        purpose: TripPurpose::CommuteOutbound,
        origin: Point { x: 2, y: 5 },
        destination: Point { x: 20, y: 5 },
        position: Point { x: 12, y: 5 }.into(),
        status: TripStatus::Riding,
        deadline: 3_600.0,
        route_plan: Some(RoutePlan {
            legs: vec![
                RouteLeg {
                    mode: TransitMode::Bus,
                    from: Point { x: 2, y: 5 },
                    to: Point { x: 12, y: 5 },
                    line_id: Some("route-A".to_string()),
                },
                RouteLeg {
                    mode: TransitMode::Bus,
                    from: Point { x: 12, y: 5 },
                    to: Point { x: 20, y: 5 },
                    line_id: Some("route-B".to_string()),
                },
            ],
            estimated_seconds: 240.0,
        }),
        current_leg_index: 1,
        patience_remaining: 240.0,
    }];

    let next = transit::delete_route(&state, "route-A").expect("route-A deletes");

    let trip = next
        .active_trips
        .iter()
        .find(|t| t.id == "trip-001")
        .expect("trip remains");
    // The trip already left route-A, so it must keep riding route-B unchanged.
    assert_eq!(trip.status, TripStatus::Riding);
    assert!(trip.route_plan.is_some());
    assert_eq!(trip.current_leg_index, 1);

    let vehicle_b = next
        .transit
        .vehicles
        .iter()
        .find(|v| v.line_id == "route-B")
        .expect("route-B vehicle survives");
    // The legit passenger stays aboard — this is a real rider, not a ghost.
    assert!(vehicle_b.passenger_ids.contains(&"trip-001".to_string()));
}

#[test]
fn deleting_future_leg_line_clears_ghost_passenger_from_current_vehicle() {
    // A trip riding route-A (leg 0) whose plan still depends on route-B as a
    // future transfer (leg 1) must be invalidated when route-B is deleted, AND
    // its id must be removed from route-A's vehicle. Otherwise the reset trip
    // cannot re-board (its id lingers in occupied_passenger_ids) while route-A's
    // vehicle carries a phantom passenger that never disembarks.
    let mut state = create_initial_snapshot();
    state.transit.routes = vec![
        simple_route("route-A", &["a1", "a2"]),
        simple_route("route-B", &["b1", "b2"]),
    ];
    state.transit.vehicles = vec![Vehicle {
        id: "veh-A".to_string(),
        mode: TransitMode::Bus,
        line_id: "route-A".to_string(),
        capacity: 18,
        passenger_ids: vec!["trip-001".to_string()],
        segment_index: 0,
        progress: 0.4,
    }];
    state.active_trips = vec![ActiveTrip {
        id: "trip-001".to_string(),
        sim_id: "sim-001".to_string(),
        purpose: TripPurpose::CommuteOutbound,
        origin: Point { x: 2, y: 5 },
        destination: Point { x: 20, y: 5 },
        position: Point { x: 6, y: 5 }.into(),
        status: TripStatus::Riding,
        deadline: 3_600.0,
        route_plan: Some(RoutePlan {
            legs: vec![
                RouteLeg {
                    mode: TransitMode::Bus,
                    from: Point { x: 2, y: 5 },
                    to: Point { x: 12, y: 5 },
                    line_id: Some("route-A".to_string()),
                },
                RouteLeg {
                    mode: TransitMode::Bus,
                    from: Point { x: 12, y: 5 },
                    to: Point { x: 20, y: 5 },
                    line_id: Some("route-B".to_string()),
                },
            ],
            estimated_seconds: 240.0,
        }),
        current_leg_index: 0,
        patience_remaining: 240.0,
    }];

    let next = transit::delete_route(&state, "route-B").expect("route-B deletes");

    let trip = next
        .active_trips
        .iter()
        .find(|t| t.id == "trip-001")
        .expect("trip remains");
    // Future leg is gone, so the trip is eagerly reset to replan.
    assert_eq!(trip.status, TripStatus::Idle);
    assert!(trip.route_plan.is_none());
    assert_eq!(trip.current_leg_index, 0);

    // No ghost: the id is scrubbed from route-A's surviving vehicle, so the
    // reset trip is free to re-board once it has a fresh plan.
    let vehicle_a = next
        .transit
        .vehicles
        .iter()
        .find(|v| v.line_id == "route-A")
        .expect("route-A vehicle survives");
    assert!(!vehicle_a.passenger_ids.iter().any(|id| id == "trip-001"));
}
