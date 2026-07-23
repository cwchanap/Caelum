use caelum_core::model::{
    ActiveTrip, GameMap, Heading, LegFailureReason, Point, RoadPort, RoadStructure, RouteLeg,
    RouteLegStatus, RoutePlan, ServiceDirection, ServicePattern, TransitMode, TripPurpose,
    TripStatus,
};
use caelum_core::{router, transit, GameEngine, GameIntent, RoadPreset};

fn road_line(engine: &mut GameEngine, y: i32, from_x: i32, to_x: i32) {
    for x in from_x..=to_x {
        engine.dispatch(GameIntent::LayRoad {
            point: (x, y).into(),
        });
    }
}

#[test]
fn bus_route_vehicle_carries_commute_trip() {
    let mut engine = GameEngine::new();
    road_line(&mut engine, 5, 2, 12);

    engine.dispatch(GameIntent::AddBusStop {
        point: (2, 4).into(),
    });
    engine.dispatch(GameIntent::AddBusStop {
        point: (12, 4).into(),
    });
    let route = engine.dispatch(GameIntent::CreateRoute {
        mode: TransitMode::Bus,
        pattern: ServicePattern::Loop,
        waypoint_ids: vec!["stop-001".to_string(), "stop-002".to_string()],
    });
    assert!(route.applied, "{route:?}");
    assert!(!route.snapshot.transit.routes[0].path_broken);
    assert_eq!(route.snapshot.transit.vehicles.len(), 1);

    let mut snapshot = route.snapshot;
    snapshot.active_trips.push(ActiveTrip {
        id: "trip-001".to_string(),
        sim_id: "sim-001".to_string(),
        purpose: TripPurpose::CommuteOutbound,
        origin: (2, 4).into(),
        destination: (12, 4).into(),
        position: (2, 4).into(),
        status: TripStatus::Waiting,
        deadline: 3_600.0,
        route_plan: Some(RoutePlan {
            legs: vec![RouteLeg {
                mode: TransitMode::Bus,
                from: (2, 4).into(),
                to: (12, 4).into(),
                line_id: Some("route-001".to_string()),
                service_direction: Some(ServiceDirection::Loop),
                board_itinerary_index: Some(0),
                alight_itinerary_index: Some(0),
            }],
            estimated_seconds: 60.0,
        }),
        current_leg_index: 0,
        patience_remaining: 30.0,
    });

    let boarded = transit::tick_vehicles(&snapshot, 0.0);
    assert!(boarded.transit.vehicles[0]
        .passenger_ids
        .contains(&"trip-001".to_string()));
    let boarded_trip = boarded
        .active_trips
        .iter()
        .find(|trip| trip.id == "trip-001")
        .expect("trip should remain after boarding");
    assert_eq!(boarded_trip.status, TripStatus::Riding);

    let ride_seconds =
        transit::seconds_until_next_vehicle_stop(&boarded, &boarded.transit.vehicles[0])
            .expect("vehicle has a next stop");
    let arrived = transit::tick_vehicles(&boarded, ride_seconds);
    assert!(!arrived.transit.vehicles[0]
        .passenger_ids
        .contains(&"trip-001".to_string()));
    let arrived_trip = arrived
        .active_trips
        .iter()
        .find(|trip| trip.id == "trip-001")
        .expect("trip should remain after disembark");
    assert_eq!(arrived_trip.status, TripStatus::Walking);
    assert_eq!(arrived_trip.position, (12, 4).into());
    assert_eq!(arrived_trip.current_leg_index, 1);
}

#[test]
fn removing_road_marks_route_broken() {
    let mut engine = GameEngine::new();
    road_line(&mut engine, 5, 2, 12);
    engine.dispatch(GameIntent::AddBusStop {
        point: (2, 4).into(),
    });
    engine.dispatch(GameIntent::AddBusStop {
        point: (12, 4).into(),
    });
    let route = engine.dispatch(GameIntent::CreateRoute {
        mode: TransitMode::Bus,
        pattern: ServicePattern::Loop,
        waypoint_ids: vec!["stop-001".to_string(), "stop-002".to_string()],
    });
    assert!(route.applied, "{route:?}");

    let removed = engine.dispatch(GameIntent::RemoveAtTile {
        point: (7, 5).into(),
    });

    assert!(removed.applied);
    assert!(removed.snapshot.transit.routes[0].path_broken);
}

#[test]
fn routing_ignores_a_route_with_any_disconnected_leg() {
    let mut engine = GameEngine::new();
    road_line(&mut engine, 5, 2, 12);
    engine.dispatch(GameIntent::AddBusStop {
        point: (2, 4).into(),
    });
    engine.dispatch(GameIntent::AddBusStop {
        point: (12, 4).into(),
    });
    let route = engine.dispatch(GameIntent::CreateRoute {
        mode: TransitMode::Bus,
        pattern: ServicePattern::Loop,
        waypoint_ids: vec!["stop-001".to_string(), "stop-002".to_string()],
    });
    assert!(route.applied, "{route:?}");
    let mut state = route.snapshot;
    state.transit.routes[0].path_broken = false;
    state.transit.routes[0].legs[0].status = RouteLegStatus::NetworkDisconnected;
    state.transit.routes[0].legs[0].current_path = None;

    let plan = router::find_route_plan(&state, &(2, 4).into(), &(12, 4).into())
        .expect("walking fallback remains available");

    assert!(plan.legs.iter().all(|leg| leg.mode == TransitMode::Walk));
}

#[test]
fn shuttle_route_resolves_outbound_and_return_service_legs_on_two_way_road() {
    let mut engine = GameEngine::new();
    let road = engine.dispatch(GameIntent::LayRoadLine {
        points: (2..=12).map(|x| (x, 5).into()).collect(),
        preset: RoadPreset::TwoWay,
    });
    assert!(road.applied, "fixture road should apply: {road:?}");
    for x in [2, 6, 10] {
        let stop = engine.dispatch(GameIntent::AddBusStop {
            point: (x, 4).into(),
        });
        assert!(stop.applied, "fixture stop should apply: {stop:?}");
    }

    let created = engine.dispatch(GameIntent::CreateRoute {
        mode: TransitMode::Bus,
        pattern: ServicePattern::Shuttle,
        waypoint_ids: vec!["stop-001".into(), "stop-002".into(), "stop-003".into()],
    });

    assert!(created.applied, "shuttle route should apply: {created:?}");
    let route = &created.snapshot.transit.routes[0];
    let service_legs: Vec<_> = route
        .legs
        .iter()
        .filter(|leg| leg.kind == caelum_core::model::RouteLegKind::Service)
        .collect();
    assert_eq!(service_legs.len(), 4);
    assert!(service_legs
        .iter()
        .all(|leg| { leg.status == RouteLegStatus::Connected && leg.current_path.is_some() }));
    assert_eq!(
        service_legs
            .iter()
            .map(|leg| (
                leg.from_waypoint_id.as_str(),
                leg.to_waypoint_id.as_str(),
                leg.direction,
            ))
            .collect::<Vec<_>>(),
        vec![
            (
                "stop-001",
                "stop-002",
                caelum_core::model::ServiceDirection::Outbound,
            ),
            (
                "stop-002",
                "stop-003",
                caelum_core::model::ServiceDirection::Outbound,
            ),
            (
                "stop-003",
                "stop-002",
                caelum_core::model::ServiceDirection::Return,
            ),
            (
                "stop-002",
                "stop-001",
                caelum_core::model::ServiceDirection::Return,
            ),
        ]
    );
}

fn connect_fixture_roads(map: &mut GameMap, first: Point, second: Point) {
    let heading = match (second.x - first.x, second.y - first.y) {
        (0, -1) => Heading::North,
        (1, 0) => Heading::East,
        (0, 1) => Heading::South,
        (-1, 0) => Heading::West,
        delta => panic!("fixture points are not adjacent: {delta:?}"),
    };
    let opposite = match heading {
        Heading::North => Heading::South,
        Heading::East => Heading::West,
        Heading::South => Heading::North,
        Heading::West => Heading::East,
    };
    map.tile_mut(first)
        .expect("fixture first road")
        .road_connections
        .push(heading);
    map.tile_mut(second)
        .expect("fixture second road")
        .road_connections
        .push(opposite);
}

#[test]
fn terminal_turnaround_recovers_after_a_junction_connects_the_headings() {
    let terminal = Point { x: 3, y: 3 };
    let east = Point { x: 4, y: 3 };
    let west = Point { x: 2, y: 3 };
    let north = Point { x: 3, y: 2 };
    let mut snapshot = GameEngine::new().snapshot();
    for (point, one_way) in [
        (terminal, None),
        (east, Some(Heading::West)),
        (west, Some(Heading::East)),
        (north, Some(Heading::North)),
    ] {
        let tile = snapshot.map.tile_mut(point).expect("fixture tile");
        tile.kind = "road".to_string();
        tile.one_way = one_way;
        tile.road_connections.clear();
        tile.road_structure_id = None;
    }
    connect_fixture_roads(&mut snapshot.map, terminal, east);
    connect_fixture_roads(&mut snapshot.map, terminal, west);
    connect_fixture_roads(&mut snapshot.map, terminal, north);

    let broken = GameEngine::from_snapshot(snapshot.clone()).expect("fixture snapshot");
    assert_eq!(
        broken.road_topology_for_test().find_terminal_reversal(
            terminal,
            Heading::East,
            Heading::West
        ),
        Err(LegFailureReason::NoLegalTurnaround)
    );

    let junction_id = "fixture-junction".to_string();
    let mut recovered_snapshot = snapshot;
    recovered_snapshot
        .map
        .tile_mut(east)
        .expect("fixture junction")
        .road_structure_id = Some(junction_id.clone());
    recovered_snapshot
        .map
        .tile_mut(east)
        .expect("fixture junction")
        .one_way = None;
    recovered_snapshot
        .map
        .road_structures
        .push(RoadStructure::AutomaticJunction {
            id: junction_id.clone(),
            footprint: vec![east],
            ports: [Heading::West]
                .into_iter()
                .enumerate()
                .map(|(index, edge)| RoadPort {
                    id: format!("{junction_id}-port-{index}"),
                    point: east,
                    edge,
                    direction: None,
                })
                .collect(),
        });
    let recovered = GameEngine::from_snapshot(recovered_snapshot).expect("recovered snapshot");
    let path = recovered
        .road_topology_for_test()
        .find_terminal_reversal(terminal, Heading::East, Heading::West)
        .expect("junction should connect the terminal headings");
    assert!(path.step_count() > 1);
}
