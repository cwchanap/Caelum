use caelum_core::model::{
    ActiveTrip, BusStopKind, EconomyPreset, GameSnapshot, Heading, MovementKind, PathGeometry,
    PlacedBuilding, Point, RoadPathStep, RoundaboutSize, Route, RouteLeg, RouteLegKind,
    RouteLegStatus, RoutePlan, ServiceDirection, ServicePattern, Sim, TransitMode,
    TransitNodeStatus, TransitPath, TripPurpose, TripStatus, Vehicle, WorkerProfile,
};
use caelum_core::network::resolve_route_legs;
use caelum_core::road_topology::RoadTopology;
use caelum_core::service_itinerary::{build_service_itinerary, ServiceLegSpec};
use caelum_core::{
    route_lifecycle, state::create_initial_snapshot, transit, GameEngine, GameIntent,
    RejectionCode, RoadPreset, RoutingContext,
};

fn ids(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_string()).collect()
}

#[test]
fn shuttle_builds_outbound_reversal_return_reversal_in_order() {
    let specs = build_service_itinerary(ServicePattern::Shuttle, &ids(&["A", "B", "C"]));

    assert_eq!(
        specs.iter().map(ServiceLegSpec::key).collect::<Vec<_>>(),
        vec![
            ("A", "B", ServiceDirection::Outbound, RouteLegKind::Service,),
            ("B", "C", ServiceDirection::Outbound, RouteLegKind::Service,),
            (
                "C",
                "C",
                ServiceDirection::Return,
                RouteLegKind::TerminalReversal,
            ),
            ("C", "B", ServiceDirection::Return, RouteLegKind::Service,),
            ("B", "A", ServiceDirection::Return, RouteLegKind::Service,),
            (
                "A",
                "A",
                ServiceDirection::Outbound,
                RouteLegKind::TerminalReversal,
            ),
        ]
    );
}

fn resolve_fixture(
    pattern: ServicePattern,
    mode: TransitMode,
) -> Vec<caelum_core::model::RouteLegPath> {
    let mut engine = GameEngine::new();
    match mode {
        TransitMode::Bus => {
            road_line(&mut engine, 5, 2, 10);
            for x in [2, 6, 10] {
                engine.dispatch(GameIntent::AddBusStop {
                    point: (x, 4).into(),
                });
            }
        }
        TransitMode::Metro => {
            track_line(&mut engine, 5, 2, 10);
            for x in [2, 6, 10] {
                engine.dispatch(GameIntent::AddMetroStation {
                    point: (x, 5).into(),
                });
            }
        }
        TransitMode::Walk => unreachable!("fixture only resolves vehicle modes"),
    }
    let snapshot = engine.snapshot();
    let topology = RoadTopology::compile(&snapshot.map).unwrap();
    let waypoint_ids = if mode == TransitMode::Bus {
        ids(&["stop-001", "stop-002", "stop-003"])
    } else {
        ids(&["station-001", "station-002", "station-003"])
    };
    resolve_route_legs(
        &snapshot,
        RoutingContext {
            road_topology: &topology,
        },
        mode,
        &waypoint_ids,
        pattern,
    )
}

#[test]
fn mode_specific_terminal_reversals_are_explicit() {
    let metro = resolve_fixture(ServicePattern::Shuttle, TransitMode::Metro);
    let metro_reversals: Vec<_> = metro
        .iter()
        .filter(|leg| leg.kind == RouteLegKind::TerminalReversal)
        .collect();
    assert_eq!(metro_reversals.len(), 2);
    assert!(metro_reversals.iter().all(|leg| {
        leg.status == RouteLegStatus::Connected
            && matches!(
                leg.current_path.as_ref(),
                Some(TransitPath::Track {
                    total_travel_seconds: 0.0,
                    ..
                })
            )
    }));

    let bus = resolve_fixture(ServicePattern::Shuttle, TransitMode::Bus);
    let bus_reversal = bus
        .iter()
        .find(|leg| leg.kind == RouteLegKind::TerminalReversal)
        .unwrap();
    assert!(bus_reversal
        .current_path
        .as_ref()
        .unwrap()
        .road_steps()
        .iter()
        .any(|step| step.movement == caelum_core::model::MovementKind::UTurn));
}

#[test]
fn breaking_shuttle_return_leg_parks_vehicle_at_legs_from_waypoint() {
    let mut engine = GameEngine::new();
    road_line(&mut engine, 5, 2, 10);
    for x in [2, 6, 10] {
        engine.dispatch(GameIntent::AddBusStop {
            point: (x, 4).into(),
        });
    }
    engine.dispatch(GameIntent::CreateRoute {
        mode: TransitMode::Bus,
        pattern: ServicePattern::Loop,
        waypoint_ids: ids(&["stop-001", "stop-002", "stop-003"]),
    });
    let mut state = engine.snapshot();
    let topology = RoadTopology::compile(&state.map).unwrap();
    let waypoint_ids = state.transit.routes[0].stop_ids.clone();
    state.transit.routes[0].pattern = ServicePattern::Shuttle;
    state.transit.routes[0].legs = resolve_route_legs(
        &state,
        RoutingContext {
            road_topology: &topology,
        },
        TransitMode::Bus,
        &waypoint_ids,
        ServicePattern::Shuttle,
    );
    state.transit.vehicles[0].itinerary_index = 3;
    state.transit.vehicles[0].passenger_ids = vec!["trip-001".to_string()];
    state.active_trips = vec![ActiveTrip {
        id: "trip-001".to_string(),
        sim_id: "sim-001".to_string(),
        purpose: TripPurpose::CommuteReturn,
        origin: (10, 5).into(),
        destination: (6, 5).into(),
        position: (9, 5).into(),
        status: TripStatus::Riding,
        deadline: 100.0,
        route_plan: Some(RoutePlan {
            legs: vec![RouteLeg {
                mode: TransitMode::Bus,
                from: (10, 5).into(),
                to: (6, 5).into(),
                line_id: Some("route-001".to_string()),
                service_direction: Some(ServiceDirection::Return),
                board_itinerary_index: Some(3),
                alight_itinerary_index: Some(3),
            }],
            estimated_seconds: 10.0,
        }),
        current_leg_index: 0,
        patience_remaining: 240.0,
    }];

    let candidate = transit::remove_at_tile(&state, &(8, 5).into()).unwrap();
    let candidate_topology = RoadTopology::compile(&candidate.map).unwrap();
    let next = route_lifecycle::recompute_all_routes(
        &state,
        candidate,
        RoutingContext {
            road_topology: &candidate_topology,
        },
    );

    assert!(next.transit.routes[0].path_broken);
    assert_eq!(
        next.transit.vehicles[0].parked_position,
        Some((10, 5).into())
    );
    assert_eq!(next.transit.vehicles[0].itinerary_index, 3);
    assert_eq!(next.active_trips[0].position, (10, 5).into());
    assert_eq!(next.active_trips[0].status, TripStatus::Idle);
}

#[test]
fn shuttle_break_then_restore_preserves_return_itinerary_index() {
    let mut engine = GameEngine::new();
    road_line(&mut engine, 5, 2, 10);
    for x in [2, 6, 10] {
        engine.dispatch(GameIntent::AddBusStop {
            point: (x, 4).into(),
        });
    }
    engine.dispatch(GameIntent::CreateRoute {
        mode: TransitMode::Bus,
        pattern: ServicePattern::Loop,
        waypoint_ids: ids(&["stop-001", "stop-002", "stop-003"]),
    });
    let mut state = engine.snapshot();
    let topology = RoadTopology::compile(&state.map).unwrap();
    let waypoint_ids = state.transit.routes[0].stop_ids.clone();
    state.transit.routes[0].pattern = ServicePattern::Shuttle;
    state.transit.routes[0].legs = resolve_route_legs(
        &state,
        RoutingContext {
            road_topology: &topology,
        },
        TransitMode::Bus,
        &waypoint_ids,
        ServicePattern::Shuttle,
    );
    state.transit.vehicles[0].itinerary_index = 3;

    // Break: remove road at (8,5) to disconnect stop-002 from stop-003.
    let broken = transit::remove_at_tile(&state, &(8, 5).into()).unwrap();
    let broken_topology = RoadTopology::compile(&broken.map).unwrap();
    let broken = route_lifecycle::recompute_all_routes(
        &state,
        broken,
        RoutingContext {
            road_topology: &broken_topology,
        },
    );
    assert!(broken.transit.routes[0].path_broken);
    assert_eq!(
        broken.transit.vehicles[0].parked_position,
        Some((10, 5).into())
    );
    assert_eq!(broken.transit.vehicles[0].itinerary_index, 3);

    // Restore: re-add road at (8,5) to reconnect the route.
    let restored = transit::lay_road(&broken, &(8, 5).into()).unwrap();
    let restored_topology = RoadTopology::compile(&restored.map).unwrap();
    let restored = route_lifecycle::recompute_all_routes(
        &broken,
        restored,
        RoutingContext {
            road_topology: &restored_topology,
        },
    );
    assert!(!restored.transit.routes[0].path_broken);
    assert_eq!(restored.transit.vehicles[0].parked_position, None);
    assert_eq!(restored.transit.vehicles[0].itinerary_index, 3);
}

fn simple_route(id: &str, stop_ids: &[&str]) -> Route {
    Route {
        id: id.to_string(),
        name: id.to_string(),
        color: "#000000".to_string(),
        stop_ids: stop_ids.iter().map(|s| s.to_string()).collect(),
        vehicle_ids: Vec::new(),
        active: true,
        pattern: ServicePattern::Loop,
        revision: 0,
        legs: Vec::new(),
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

fn point(x: i32, y: i32) -> Point {
    Point { x, y }
}

fn fixture_engine_with_two_way_road(points: &[Point]) -> GameEngine {
    let mut engine = GameEngine::new();
    for point in points {
        engine.dispatch(GameIntent::LayRoad { point: *point });
    }
    engine
}

fn fixture_engine_with_isolated_road(point: Point) -> GameEngine {
    fixture_engine_with_two_way_road(&[point])
}

#[test]
fn add_bus_stop_uses_empty_anchor_and_adjacent_road_access() {
    let mut engine = fixture_engine_with_two_way_road(&[point(4, 5), point(5, 5)]);

    let result = engine.dispatch(GameIntent::AddBusStop { point: point(4, 4) });

    assert!(result.applied, "{result:?}");
    let stop = &result.snapshot.transit.stops[0];
    assert_eq!(stop.position, point(4, 4));
    assert_eq!(stop.road_access.unwrap().road_point, point(4, 5));
    assert_eq!(
        result.snapshot.map.tile(stop.position).unwrap().kind,
        "empty"
    );
}

#[test]
fn add_bus_stop_rejects_an_on_road_click() {
    let mut engine = fixture_engine_with_two_way_road(&[point(4, 5), point(5, 5)]);

    let result = engine.dispatch(GameIntent::AddBusStop { point: point(4, 5) });

    assert_eq!(result.rejection.unwrap().code, RejectionCode::BlockedTile);
}

#[test]
fn add_bus_stop_rejects_an_isolated_adjacent_road() {
    let mut engine = fixture_engine_with_isolated_road(point(4, 5));

    let result = engine.dispatch(GameIntent::AddBusStop { point: point(4, 4) });

    assert_eq!(result.rejection.unwrap().code, RejectionCode::NoRoadAccess);
}

#[test]
fn bus_terminal_derives_access_from_a_far_edge_of_its_footprint() {
    let mut engine = GameEngine::new();
    road_line(&mut engine, 6, 3, 4);

    let result = engine.dispatch(GameIntent::PlaceBuilding {
        building_type: "busTerminal".to_string(),
        origin: point(2, 4),
        rotation: 0,
    });

    assert!(result.applied, "{result:?}");
    let terminal = &result.snapshot.transit.stops[0];
    assert_eq!(terminal.position, point(2, 4));
    assert_eq!(terminal.road_access.unwrap().road_point, point(3, 6));
}

#[test]
fn bus_terminal_restore_with_new_rotation_derives_fresh_access() {
    let mut engine = GameEngine::new();
    road_line(&mut engine, 3, 2, 10);
    road_line(&mut engine, 7, 2, 3);

    let placed = engine.dispatch(GameIntent::PlaceBuilding {
        building_type: "busTerminal".to_string(),
        origin: point(2, 4),
        rotation: 0,
    });
    assert!(placed.applied, "{placed:?}");
    assert_eq!(
        placed.snapshot.transit.stops[0]
            .road_access
            .unwrap()
            .road_point,
        point(2, 3)
    );
    let other_stop = engine.dispatch(GameIntent::AddBusStop {
        point: point(10, 2),
    });
    assert!(other_stop.applied, "{other_stop:?}");
    let route = engine.dispatch(GameIntent::CreateRoute {
        mode: TransitMode::Bus,
        pattern: ServicePattern::Loop,
        waypoint_ids: ids(&["stop-001", "stop-002"]),
    });
    assert!(route.applied, "{route:?}");

    let removed = engine.dispatch(GameIntent::RemoveAtTile { point: point(2, 4) });
    assert_eq!(
        removed.snapshot.transit.stops[0].status,
        TransitNodeStatus::Missing
    );
    for x in 2..=10 {
        engine.dispatch(GameIntent::RemoveAtTile { point: point(x, 3) });
    }

    let restored = engine.dispatch(GameIntent::PlaceBuilding {
        building_type: "busTerminal".to_string(),
        origin: point(2, 4),
        rotation: 90,
    });

    assert!(restored.applied, "{restored:?}");
    let terminal = restored
        .snapshot
        .transit
        .stops
        .iter()
        .find(|stop| stop.id == "stop-001")
        .expect("original terminal identity is restored");
    assert_eq!(terminal.status, TransitNodeStatus::Present);
    assert_eq!(terminal.road_access.unwrap().road_point, point(2, 7));
}

#[test]
fn bus_terminal_access_re_derived_when_replacement_road_touches_non_origin_footprint_edge() {
    // Regression for the stops_access_affected shortcut: a bus terminal's
    // road access is derived from any road tile adjacent to *any* footprint
    // cell, not only the terminal origin. After the access road is
    // demolished (road_access -> None), a replacement road laid beside a
    // non-origin footprint cell must still trigger normalisation so the
    // authoritative road_access field is persisted to the new tile.
    let mut engine = GameEngine::new();
    // Initial access road south of the terminal footprint, adjacent to the
    // non-origin cells (3,5) and (4,5).
    road_line(&mut engine, 6, 3, 4);

    let placed = engine.dispatch(GameIntent::PlaceBuilding {
        building_type: "busTerminal".to_string(),
        origin: point(2, 4),
        rotation: 0,
    });
    assert!(placed.applied, "{placed:?}");
    let terminal = &placed.snapshot.transit.stops[0];
    assert_eq!(terminal.position, point(2, 4));
    let original_road_point = terminal.road_access.unwrap().road_point;
    assert_eq!(original_road_point, point(3, 6));

    // Demolish the access road. Normalisation must clear road_access.
    engine.dispatch(GameIntent::RemoveAtTile { point: point(3, 6) });
    engine.dispatch(GameIntent::RemoveAtTile { point: point(4, 6) });
    let after_demolish = engine.snapshot();
    let terminal = after_demolish
        .transit
        .stops
        .iter()
        .find(|stop| stop.position == point(2, 4))
        .expect("terminal still present");
    assert!(
        terminal.road_access.is_none(),
        "road_access should be cleared after demolishing the access road, got {:?}",
        terminal.road_access
    );

    // Lay a replacement road east of the footprint, adjacent to (4,4) — a
    // non-origin cell whose neighbourhood the old origin-only shortcut did
    // not inspect. The segment (5,4)-(6,4) gives (5,4) a reciprocal
    // connection so it qualifies as a usable road.
    road_line(&mut engine, 4, 5, 6);

    let after_repair = engine.snapshot();
    let terminal = after_repair
        .transit
        .stops
        .iter()
        .find(|stop| stop.position == point(2, 4))
        .expect("terminal still present");
    let access = terminal
        .road_access
        .expect("road_access should be re-derived to the replacement road tile");
    assert_eq!(access.road_point, point(5, 4));
}

#[test]
fn placement_and_removal_use_normal_reroute_break_and_repair_lifecycle() {
    let mut engine = GameEngine::new();
    road_line(&mut engine, 5, 2, 10);
    for y in 1..=9 {
        engine.dispatch(GameIntent::LayRoad {
            point: (6, y).into(),
        });
    }
    for x in [2, 10] {
        engine.dispatch(GameIntent::AddBusStop {
            point: (x, 4).into(),
        });
    }
    engine.dispatch(GameIntent::CreateRoute {
        mode: TransitMode::Bus,
        pattern: ServicePattern::Loop,
        waypoint_ids: ids(&["stop-001", "stop-002"]),
    });

    let placed = engine.dispatch(GameIntent::PlaceRoundabout {
        origin: (5, 4).into(),
        size: RoundaboutSize::Standard3x3,
    });
    assert!(placed.applied, "{placed:?}");
    assert_eq!(
        placed.snapshot.transit.routes[0].legs[0].status,
        RouteLegStatus::Connected
    );

    let removed = engine.dispatch(GameIntent::RemoveAtTile {
        point: (6, 5).into(),
    });
    assert!(removed.applied, "{removed:?}");
    let broken = &removed.snapshot.transit.routes[0];
    assert_eq!(broken.legs[0].status, RouteLegStatus::NetworkDisconnected);
    assert!(broken.legs[0].last_valid_path.is_some());

    for x in 5..=7 {
        let repaired = engine.dispatch(GameIntent::LayRoad {
            point: (x, 5).into(),
        });
        assert!(repaired.applied, "{repaired:?}");
    }
    assert_eq!(
        engine.snapshot().transit.routes[0].legs[0].status,
        RouteLegStatus::Connected
    );
}

fn destination_building(
    id: &str,
    building_type: &str,
    occupied_tiles: Vec<Point>,
) -> PlacedBuilding {
    PlacedBuilding {
        id: id.to_string(),
        building_type: building_type.to_string(),
        origin: occupied_tiles[0],
        rotation: 0,
        occupied_tiles,
        placed_at: 0.0,
        transit_node_id: None,
    }
}

fn worker_sim(id: &str, position: Point, workplace: Point) -> Sim {
    Sim {
        id: id.to_string(),
        home: position,
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
        point: (2, 4).into(),
    });
    engine.dispatch(GameIntent::AddBusStop {
        point: (10, 4).into(),
    });
    engine.dispatch(GameIntent::CreateRoute {
        mode: TransitMode::Bus,
        pattern: ServicePattern::Loop,
        waypoint_ids: vec!["stop-001".to_string(), "stop-002".to_string()],
    });
    engine
}

struct RouteTimingFixture {
    state: GameSnapshot,
    route_id: String,
    vehicle_id: String,
}

fn route<'a>(state: &'a GameSnapshot, route_id: &str) -> &'a Route {
    state
        .transit
        .routes
        .iter()
        .find(|route| route.id == route_id)
        .expect("fixture route exists")
}

fn vehicle<'a>(state: &'a GameSnapshot, vehicle_id: &str) -> &'a Vehicle {
    state
        .transit
        .vehicles
        .iter()
        .find(|vehicle| vehicle.id == vehicle_id)
        .expect("fixture vehicle exists")
}

fn tick_vehicles(state: &GameSnapshot, delta_seconds: f64) -> GameSnapshot {
    transit::tick_vehicles(state, delta_seconds)
}

fn movement_route_fixture(movement: MovementKind, movement_seconds: f64) -> RouteTimingFixture {
    let mut state = two_stop_bus_engine().snapshot();
    let steps = [(MovementKind::Straight, 1.25), (movement, movement_seconds)]
        .into_iter()
        .enumerate()
        .map(|(index, (movement, travel_seconds))| RoadPathStep {
            position: Point {
                x: 2 + index as i32,
                y: 5,
            },
            entering_heading: Heading::East,
            leaving_heading: Heading::East,
            movement,
            geometry: PathGeometry::Line {
                from: (2 + index as i32, 5).into(),
                to: (3 + index as i32, 5).into(),
            },
            travel_seconds,
        })
        .collect();
    let total_travel_seconds = 1.25 + movement_seconds;
    let path = TransitPath::Road {
        steps,
        total_travel_seconds,
    };
    let leg = &mut state.transit.routes[0].legs[0];
    leg.current_path = Some(path.clone());
    leg.last_valid_path = Some(path);
    leg.estimated_seconds = Some(total_travel_seconds);
    let route_id = state.transit.routes[0].id.clone();
    let vehicle_id = state.transit.vehicles[0].id.clone();
    state.transit.vehicles[0].itinerary_index = 0;
    state.transit.vehicles[0].path_step_index = 0;
    state.transit.vehicles[0].step_progress = 0.0;
    RouteTimingFixture {
        state,
        route_id,
        vehicle_id,
    }
}

fn straight_route_fixture() -> RouteTimingFixture {
    movement_route_fixture(MovementKind::Straight, 1.25)
}

fn right_turn_route_fixture() -> RouteTimingFixture {
    movement_route_fixture(MovementKind::RightTurn, 1.75)
}

fn left_turn_route_fixture() -> RouteTimingFixture {
    movement_route_fixture(MovementKind::LeftTurn, 2.25)
}

fn uturn_route_fixture() -> RouteTimingFixture {
    movement_route_fixture(MovementKind::UTurn, 2.0)
}

fn advance_until_itinerary_changes(
    state: GameSnapshot,
    vehicle_id: &str,
    delta_seconds: f64,
) -> GameSnapshot {
    assert_eq!(vehicle(&state, vehicle_id).itinerary_index, 0);
    tick_vehicles(&state, delta_seconds)
}

fn three_step_vehicle_fixture(durations: [f64; 3]) -> (GameSnapshot, String) {
    let mut state = two_stop_bus_engine().snapshot();
    let steps = durations
        .iter()
        .enumerate()
        .map(|(index, travel_seconds)| RoadPathStep {
            position: Point {
                x: 2 + index as i32,
                y: 5,
            },
            entering_heading: Heading::East,
            leaving_heading: Heading::East,
            movement: MovementKind::Straight,
            geometry: PathGeometry::Line {
                from: (2 + index as i32, 5).into(),
                to: (3 + index as i32, 5).into(),
            },
            travel_seconds: *travel_seconds,
        })
        .collect();
    let total_travel_seconds = durations.iter().sum();
    let path = TransitPath::Road {
        steps,
        total_travel_seconds,
    };
    let leg = &mut state.transit.routes[0].legs[0];
    leg.current_path = Some(path.clone());
    leg.last_valid_path = Some(path);
    leg.estimated_seconds = Some(total_travel_seconds);
    let vehicle_id = state.transit.vehicles[0].id.clone();
    (state, vehicle_id)
}

#[test]
fn adds_bus_stop_on_empty_roadside_anchor_and_charges_budget() {
    let mut engine = GameEngine::new();
    engine.dispatch(GameIntent::LayRoad {
        point: (4, 4).into(),
    });
    engine.dispatch(GameIntent::LayRoad {
        point: (5, 4).into(),
    });

    let result = engine.dispatch(GameIntent::AddBusStop {
        point: (4, 3).into(),
    });

    assert!(result.applied);
    assert_eq!(result.snapshot.transit.stops.len(), 1);
    let stop = &result.snapshot.transit.stops[0];
    assert_eq!(stop.id, "stop-001");
    assert_eq!(stop.kind, BusStopKind::BusStop);
    assert_eq!(stop.position, point(4, 3));
    assert_eq!(stop.platforms[0].capacity, 50);
    assert_eq!(result.snapshot.budget, 117_800);
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
    assert_eq!(route.legs.len(), 2);
    assert_eq!(snapshot.transit.vehicles[0].capacity, 18);
}

#[test]
fn duplicate_stop_route_is_rejected_atomically() {
    let mut engine = GameEngine::new();
    engine.dispatch(GameIntent::LayRoad {
        point: (3, 4).into(),
    });
    engine.dispatch(GameIntent::LayRoad {
        point: (4, 4).into(),
    });
    engine.dispatch(GameIntent::AddBusStop {
        point: (3, 3).into(),
    });

    let result = engine.dispatch(GameIntent::CreateRoute {
        mode: TransitMode::Bus,
        pattern: ServicePattern::Loop,
        waypoint_ids: vec!["stop-001".to_string(), "stop-001".to_string()],
    });

    assert!(!result.applied);
    assert_eq!(
        result.rejection.expect("duplicate rejection").code,
        RejectionCode::DuplicateRouteNodes
    );
    assert!(result.snapshot.transit.routes.is_empty());
    assert!(!result.snapshot.transit.stops[0].platforms[0]
        .route_ids
        .contains(&"route-001".to_string()));
}

#[test]
fn disconnected_metro_creation_is_rejected_atomically() {
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

    let line = engine.dispatch(GameIntent::CreateRoute {
        mode: TransitMode::Metro,
        pattern: ServicePattern::Loop,
        waypoint_ids: vec!["station-001".to_string(), "station-002".to_string()],
    });
    assert!(!line.applied);
    assert_eq!(
        line.rejection.expect("disconnected rejection").code,
        RejectionCode::DisconnectedLeg
    );
    assert!(line.snapshot.transit.metro_lines.is_empty());
    assert!(line.snapshot.transit.vehicles.is_empty());
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
        point: (12, 2).into(),
    });
    engine.dispatch(GameIntent::CreateRoute {
        mode: TransitMode::Bus,
        pattern: ServicePattern::Loop,
        waypoint_ids: vec!["stop-001".to_string(), "stop-002".to_string()],
    });
    engine.dispatch(GameIntent::CreateRoute {
        mode: TransitMode::Bus,
        pattern: ServicePattern::Loop,
        waypoint_ids: vec!["stop-001".to_string(), "stop-002".to_string()],
    });

    let snapshot = engine.snapshot();
    let terminal = &snapshot.transit.stops[0];
    assert_eq!(terminal.platforms[0].route_ids, vec!["route-001"]);
    assert_eq!(terminal.platforms[1].route_ids, vec!["route-002"]);
    let route_1_revision = snapshot.transit.routes[0].revision;
    let route_2_revision = snapshot.transit.routes[1].revision;

    let moved = engine.dispatch(GameIntent::AssignRouteToPlatform {
        node_id: "stop-001".to_string(),
        route_id: "route-001".to_string(),
        platform_id: "stop-001-p2".to_string(),
    });
    let terminal = &moved.snapshot.transit.stops[0];
    assert!(terminal.platforms[0].route_ids.is_empty());
    assert_eq!(terminal.platforms[2].route_ids, vec!["route-001"]);
    assert_eq!(
        moved.snapshot.transit.routes[0].revision,
        route_1_revision + 1
    );
    assert_eq!(moved.snapshot.transit.routes[1].revision, route_2_revision);
}

#[test]
fn bus_stop_building_rebuild_restores_stable_node_and_route() {
    let mut engine = GameEngine::new();
    road_line(&mut engine, 3, 2, 10);
    engine.dispatch(GameIntent::PlaceBuilding {
        building_type: "busStop".to_string(),
        origin: (2, 4).into(),
        rotation: 0,
    });
    engine.dispatch(GameIntent::AddBusStop {
        point: (10, 2).into(),
    });
    engine.dispatch(GameIntent::CreateRoute {
        mode: TransitMode::Bus,
        pattern: ServicePattern::Loop,
        waypoint_ids: ids(&["stop-001", "stop-002"]),
    });
    let original_platforms = engine.snapshot().transit.stops[0].platforms.clone();

    let removed = engine.dispatch(GameIntent::RemoveAtTile {
        point: (2, 4).into(),
    });
    assert_eq!(
        removed.snapshot.transit.stops[0].status,
        TransitNodeStatus::Missing
    );

    let restored = engine.dispatch(GameIntent::PlaceBuilding {
        building_type: "busStop".to_string(),
        origin: (2, 4).into(),
        rotation: 0,
    });

    assert!(restored.applied, "restore should apply: {restored:?}");
    assert_eq!(restored.snapshot.transit.stops.len(), 2);
    assert_eq!(restored.snapshot.transit.stops[0].id, "stop-001");
    assert_eq!(
        restored.snapshot.transit.stops[0].status,
        TransitNodeStatus::Present
    );
    assert_eq!(
        restored.snapshot.transit.stops[0].platforms,
        original_platforms
    );
    assert_eq!(
        restored.snapshot.buildings[0].transit_node_id.as_deref(),
        Some("stop-001")
    );
    assert!(!restored.snapshot.transit.routes[0].path_broken);
}

#[test]
fn terminal_demolition_uses_canonical_origin_and_obstruction_blocks_restore() {
    let mut engine = GameEngine::new();
    road_line(&mut engine, 3, 2, 12);
    engine.dispatch(GameIntent::PlaceBuilding {
        building_type: "busTerminal".to_string(),
        origin: (2, 4).into(),
        rotation: 0,
    });
    engine.dispatch(GameIntent::AddBusStop {
        point: (12, 2).into(),
    });
    engine.dispatch(GameIntent::CreateRoute {
        mode: TransitMode::Bus,
        pattern: ServicePattern::Loop,
        waypoint_ids: ids(&["stop-001", "stop-002"]),
    });

    let removed = engine.dispatch(GameIntent::RemoveAtTile {
        point: (4, 5).into(),
    });

    let terminal = removed
        .snapshot
        .transit
        .stops
        .iter()
        .find(|stop| stop.id == "stop-001")
        .expect("referenced terminal tombstone remains");
    assert_eq!(terminal.position, (2, 4).into());
    assert_eq!(terminal.status, TransitNodeStatus::Missing);
    assert!(removed.snapshot.buildings.is_empty());

    let obstruction = engine.dispatch(GameIntent::LayTrack {
        point: (2, 4).into(),
    });
    assert!(obstruction.applied);
    let rejected = engine.dispatch(GameIntent::PlaceBuilding {
        building_type: "busTerminal".to_string(),
        origin: (2, 4).into(),
        rotation: 0,
    });
    assert_eq!(
        rejected.rejection.as_ref().map(|rejection| &rejection.code),
        Some(&RejectionCode::BlockedFootprint)
    );
    assert_eq!(
        rejected.snapshot.transit.stops[0].status,
        TransitNodeStatus::Missing
    );
}

#[test]
fn bus_terminal_rebuild_restores_stable_node_and_route() {
    let mut engine = GameEngine::new();
    road_line(&mut engine, 3, 2, 12);
    engine.dispatch(GameIntent::PlaceBuilding {
        building_type: "busTerminal".to_string(),
        origin: (2, 4).into(),
        rotation: 0,
    });
    engine.dispatch(GameIntent::AddBusStop {
        point: (12, 2).into(),
    });
    engine.dispatch(GameIntent::CreateRoute {
        mode: TransitMode::Bus,
        pattern: ServicePattern::Loop,
        waypoint_ids: ids(&["stop-001", "stop-002"]),
    });
    let original_platforms = engine.snapshot().transit.stops[0].platforms.clone();
    engine.dispatch(GameIntent::RemoveAtTile {
        point: (4, 5).into(),
    });

    let restored = engine.dispatch(GameIntent::PlaceBuilding {
        building_type: "busTerminal".to_string(),
        origin: (2, 4).into(),
        rotation: 0,
    });

    assert!(restored.applied, "restore should apply: {restored:?}");
    let terminal = restored
        .snapshot
        .transit
        .stops
        .iter()
        .find(|stop| stop.id == "stop-001")
        .expect("original terminal identity is restored");
    assert_eq!(terminal.kind, BusStopKind::BusTerminal);
    assert_eq!(terminal.status, TransitNodeStatus::Present);
    assert_eq!(terminal.platforms, original_platforms);
    assert!(!restored.snapshot.transit.routes[0].path_broken);
}

#[test]
fn metro_station_building_rebuild_restores_stable_node_and_line() {
    let mut engine = GameEngine::new();
    track_line(&mut engine, 4, 2, 10);
    for x in [2, 10] {
        engine.dispatch(GameIntent::PlaceBuilding {
            building_type: "metroStation".to_string(),
            origin: (x, 4).into(),
            rotation: 0,
        });
    }
    engine.dispatch(GameIntent::CreateRoute {
        mode: TransitMode::Metro,
        pattern: ServicePattern::Loop,
        waypoint_ids: ids(&["station-001", "station-002"]),
    });
    let original_platforms = engine.snapshot().transit.stations[0].platforms.clone();

    let removed = engine.dispatch(GameIntent::RemoveAtTile {
        point: (2, 4).into(),
    });
    assert_eq!(
        removed.snapshot.transit.stations[0].status,
        TransitNodeStatus::Missing
    );
    engine.set_budget_for_test(25_000);

    let restored = engine.dispatch(GameIntent::PlaceBuilding {
        building_type: "metroStation".to_string(),
        origin: (2, 4).into(),
        rotation: 0,
    });

    assert!(restored.applied, "restore should apply: {restored:?}");
    assert_eq!(restored.snapshot.transit.stations[0].id, "station-001");
    assert_eq!(
        restored.snapshot.transit.stations[0].status,
        TransitNodeStatus::Present
    );
    assert_eq!(
        restored.snapshot.transit.stations[0].platforms,
        original_platforms
    );
    assert!(!restored.snapshot.transit.metro_lines[0].path_broken);
}

#[test]
fn cycling_road_direction_breaks_and_restores_route() {
    let mut engine = GameEngine::new();
    road_line(&mut engine, 5, 2, 10);
    engine.dispatch(GameIntent::AddBusStop {
        point: (2, 4).into(),
    });
    engine.dispatch(GameIntent::AddBusStop {
        point: (10, 4).into(),
    });
    engine.dispatch(GameIntent::CreateRoute {
        mode: TransitMode::Bus,
        pattern: ServicePattern::Loop,
        waypoint_ids: vec!["stop-001".to_string(), "stop-002".to_string()],
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
            .map(|h| h.as_str()),
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
        .map(|tile| tile.one_way.map(|h| h.as_str()))
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
    assert_eq!(tile(1, 1).one_way.map(|h| h.as_str()), Some("east"));
    assert_eq!(tile(2, 1).one_way.map(|h| h.as_str()), Some("east"));
    assert_eq!(tile(3, 1).one_way.map(|h| h.as_str()), Some("east"));
    assert_eq!(tile(1, 0).one_way.map(|h| h.as_str()), None);
    assert_eq!(tile(2, 0).one_way.map(|h| h.as_str()), Some("west"));
    assert_eq!(tile(3, 0).one_way.map(|h| h.as_str()), Some("west"));
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
            .and_then(|tile| tile.one_way)
    };

    // Forward carriageway (y=5) and reverse carriageway (y=4, north/left of
    // east) carry the same directions in both drag orders.
    for x in 1..=3 {
        assert_eq!(
            one_way_at(&east.snapshot, x, 5).map(|h| h.as_str()),
            Some("east"),
            "eastward forward lane at ({x},5)"
        );
        assert_eq!(
            one_way_at(&west.snapshot, x, 5).map(|h| h.as_str()),
            Some("east"),
            "westward drag must still place east forward lane at ({x},5)"
        );
        assert_eq!(
            one_way_at(&east.snapshot, x, 4).map(|h| h.as_str()),
            Some("west"),
            "eastward reverse lane at ({x},4)"
        );
        assert_eq!(
            one_way_at(&west.snapshot, x, 4).map(|h| h.as_str()),
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
fn vehicles_advance_by_duration_over_path_steps() {
    let mut engine = two_stop_bus_engine();
    engine.dispatch(GameIntent::SetPaused { paused: false });

    let ticked = engine.tick(1.0);

    assert!(ticked.applied);
    let progress = ticked.snapshot.transit.vehicles[0].step_progress;
    assert!((progress - 0.8).abs() < 0.000_001);
}

#[test]
fn actual_bus_time_includes_the_same_turn_delay_as_its_path() {
    for fixture in [
        straight_route_fixture(),
        right_turn_route_fixture(),
        left_turn_route_fixture(),
        uturn_route_fixture(),
    ] {
        let leg = route(&fixture.state, &fixture.route_id).legs[0].clone();
        let expected = leg.current_path.as_ref().unwrap().total_travel_seconds();
        let almost =
            advance_until_itinerary_changes(fixture.state, &fixture.vehicle_id, expected - 0.001);
        assert_eq!(vehicle(&almost, &fixture.vehicle_id).itinerary_index, 0);
        let arrived = tick_vehicles(&almost, 0.001);
        assert_eq!(vehicle(&arrived, &fixture.vehicle_id).itinerary_index, 1);
    }
}

#[test]
fn vehicle_time_through_roundabout_matches_authoritative_path_duration() {
    let mut engine = GameEngine::new();
    road_line(&mut engine, 5, 2, 10);
    for y in 1..=9 {
        engine.dispatch(GameIntent::LayRoad {
            point: (6, y).into(),
        });
    }
    for x in [2, 10] {
        engine.dispatch(GameIntent::AddBusStop {
            point: (x, 4).into(),
        });
    }
    engine.dispatch(GameIntent::CreateRoute {
        mode: TransitMode::Bus,
        pattern: ServicePattern::Loop,
        waypoint_ids: ids(&["stop-001", "stop-002"]),
    });
    let placed = engine.dispatch(GameIntent::PlaceRoundabout {
        origin: (5, 4).into(),
        size: RoundaboutSize::Standard3x3,
    });
    assert!(placed.applied, "{placed:?}");

    let state = placed.snapshot;
    let route = &state.transit.routes[0];
    let expected = route.legs[0]
        .current_path
        .as_ref()
        .expect("roundabout route path")
        .total_travel_seconds();
    assert!(route.legs[0]
        .current_path
        .as_ref()
        .unwrap()
        .road_steps()
        .iter()
        .any(|step| step.movement == MovementKind::RoundaboutEntry));
    let vehicle_id = state.transit.vehicles[0].id.clone();
    let start_leg_index = vehicle(&state, &vehicle_id).itinerary_index;
    let almost = tick_vehicles(&state, expected - 0.001);
    assert_eq!(
        vehicle(&almost, &vehicle_id).itinerary_index,
        start_leg_index
    );
    let arrived = tick_vehicles(&almost, 0.001);
    assert_eq!(
        vehicle(&arrived, &vehicle_id).itinerary_index,
        start_leg_index + 1
    );
}

#[test]
fn one_tick_consumes_multiple_short_steps_without_losing_remainder() {
    let (state, vehicle_id) = three_step_vehicle_fixture([0.25, 0.50, 1.00]);
    let next = tick_vehicles(&state, 1.10);
    let vehicle = vehicle(&next, &vehicle_id);

    assert_eq!(vehicle.path_step_index, 2);
    assert!((vehicle.step_progress - 0.35).abs() < 1e-9);
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
        worker_sim("sim-001", (1, 1).into(), removed_tiles[0]),
        worker_sim("sim-002", (1, 2).into(), remaining_tiles[0]),
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
        .and_then(|sim| sim.workplace)
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
        removed_tiles[0],
    )];
    state.active_trips = vec![ActiveTrip {
        id: "trip-001".to_string(),
        sim_id: "sim-001".to_string(),
        purpose: TripPurpose::CommuteOutbound,
        origin: Point { x: 2, y: 5 },
        destination: removed_tiles[0],
        position: Point { x: 3, y: 5 }.into(),
        status: TripStatus::Riding,
        deadline: 3_600.0,
        route_plan: Some(RoutePlan {
            legs: vec![RouteLeg {
                mode: TransitMode::Bus,
                from: Point { x: 2, y: 5 },
                to: removed_tiles[0],
                line_id: Some("route-001".to_string()),
                service_direction: Some(ServiceDirection::Loop),
                board_itinerary_index: Some(0),
                alight_itinerary_index: Some(0),
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
        itinerary_index: 0,
        path_step_index: 0,
        step_progress: 0.25,
        parked_position: None,
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
        removed_tiles[0],
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
        destination: removed_tiles[0],
        position: Point { x: 3, y: 5 }.into(),
        status: TripStatus::Riding,
        deadline: 1_000.0,
        route_plan: Some(RoutePlan {
            legs: vec![RouteLeg {
                mode: TransitMode::Bus,
                from: Point { x: 2, y: 5 },
                to: removed_tiles[0],
                line_id: Some("route-001".to_string()),
                service_direction: Some(ServiceDirection::Loop),
                board_itinerary_index: Some(0),
                alight_itinerary_index: Some(0),
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
    let mut sim = worker_sim("sim-001", home, removed_tiles[0]);
    sim.outbound_resolved_today = true;
    sim.outbound_arrived_today = true;
    state.sims = vec![sim];
    state.active_trips = vec![ActiveTrip {
        id: "trip-day-0-trip-001".to_string(),
        sim_id: "sim-001".to_string(),
        purpose: TripPurpose::CommuteReturn,
        origin: removed_tiles[0],
        destination: home,
        position: Point { x: 4, y: 5 }.into(),
        status: TripStatus::Walking,
        deadline: 3_600.0,
        route_plan: Some(RoutePlan {
            legs: vec![RouteLeg {
                mode: TransitMode::Walk,
                from: Point { x: 4, y: 5 },
                to: home,
                line_id: None,
                service_direction: None,
                board_itinerary_index: None,
                alight_itinerary_index: None,
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
    state.sims = vec![worker_sim("sim-001", home, removed_tiles[0])];
    state.active_trips = vec![ActiveTrip {
        id: "trip-day-0-trip-001".to_string(),
        sim_id: "sim-001".to_string(),
        purpose: TripPurpose::CommuteOutbound,
        origin: home,
        destination: removed_tiles[0],
        position: Point { x: 3, y: 5 }.into(),
        status: TripStatus::Walking,
        deadline: 3_600.0,
        route_plan: Some(RoutePlan {
            legs: vec![RouteLeg {
                mode: TransitMode::Walk,
                from: Point { x: 3, y: 5 },
                to: removed_tiles[0],
                line_id: None,
                service_direction: None,
                board_itinerary_index: None,
                alight_itinerary_index: None,
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
        itinerary_index: 0,
        path_step_index: 0,
        step_progress: 0.25,
        parked_position: None,
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
    let created = engine.dispatch(GameIntent::CreateRoute {
        mode: TransitMode::Metro,
        pattern: ServicePattern::Loop,
        waypoint_ids: vec!["station-001".to_string(), "station-002".to_string()],
    });

    assert!(created.applied);
    assert_eq!(
        created.snapshot.transit.metro_lines[0].vehicle_ids,
        vec!["vehicle-001"]
    );
    assert_eq!(created.snapshot.transit.vehicles[0].capacity, 90);
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
            itinerary_index: 0,
            path_step_index: 0,
            step_progress: 0.0,
            parked_position: None,
        },
        Vehicle {
            id: "veh-B".to_string(),
            mode: TransitMode::Bus,
            line_id: "route-B".to_string(),
            capacity: 18,
            passenger_ids: vec!["trip-001".to_string()],
            itinerary_index: 0,
            path_step_index: 0,
            step_progress: 0.4,
            parked_position: None,
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
                    service_direction: Some(ServiceDirection::Loop),
                    board_itinerary_index: Some(0),
                    alight_itinerary_index: Some(0),
                },
                RouteLeg {
                    mode: TransitMode::Bus,
                    from: Point { x: 12, y: 5 },
                    to: Point { x: 20, y: 5 },
                    line_id: Some("route-B".to_string()),
                    service_direction: Some(ServiceDirection::Loop),
                    board_itinerary_index: Some(0),
                    alight_itinerary_index: Some(0),
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
        itinerary_index: 0,
        path_step_index: 0,
        step_progress: 0.4,
        parked_position: None,
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
                    service_direction: Some(ServiceDirection::Loop),
                    board_itinerary_index: Some(0),
                    alight_itinerary_index: Some(0),
                },
                RouteLeg {
                    mode: TransitMode::Bus,
                    from: Point { x: 12, y: 5 },
                    to: Point { x: 20, y: 5 },
                    line_id: Some("route-B".to_string()),
                    service_direction: Some(ServiceDirection::Loop),
                    board_itinerary_index: Some(0),
                    alight_itinerary_index: Some(0),
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

#[test]
fn lay_road_line_one_way_is_idempotent_when_direction_already_matches() {
    // lay_lane returns false (no charge, no change) when the existing road's
    // one_way already equals the requested direction. Re-laying the same
    // one-way line over itself must not double-charge or change the snapshot.
    let mut engine = GameEngine::new();
    let first = engine.dispatch(GameIntent::LayRoadLine {
        points: vec![(1, 1).into(), (2, 1).into(), (3, 1).into()],
        preset: RoadPreset::OneWay,
    });
    assert!(first.applied);
    let budget_after_first = first.snapshot.budget;

    let second = engine.dispatch(GameIntent::LayRoadLine {
        points: vec![(1, 1).into(), (2, 1).into(), (3, 1).into()],
        preset: RoadPreset::OneWay,
    });
    // No tile changed (all already one-way east), so the line is "unchanged".
    assert!(!second.applied);
    assert_eq!(second.snapshot.budget, budget_after_first);
}

#[test]
fn lay_road_line_dual_bidirectional_skips_reverse_lane_when_tile_is_occupied() {
    // lay_reverse_lane returns false when the reverse-lane tile is not empty.
    // Pre-place a road on the reverse-lane tile (north of the forward lane);
    // the forward lane still lands, but the reverse lane is skipped rather
    // than hijacking the existing road.
    let mut engine = GameEngine::new();
    // Pre-place a two-way road at (2, 0) — the reverse-lane tile for a
    // dual-bidirectional line at y=1 (reverse lane is at y=0, north/left of
    // the canonical east forward lane).
    engine.dispatch(GameIntent::LayRoad {
        point: (2, 0).into(),
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
    // Forward lane (y=1) is one-way east.
    assert_eq!(tile(1, 1).one_way.map(|h| h.as_str()), Some("east"));
    assert_eq!(tile(2, 1).one_way.map(|h| h.as_str()), Some("east"));
    assert_eq!(tile(3, 1).one_way.map(|h| h.as_str()), Some("east"));
    // The pre-existing road at (2,0) keeps its two-way (None) direction — the
    // reverse lane did not overwrite it. (1,0) and (3,0) get the reverse lane.
    assert_eq!(tile(2, 0).one_way.map(|h| h.as_str()), None);
    assert_eq!(tile(1, 0).one_way.map(|h| h.as_str()), Some("west"));
    assert_eq!(tile(3, 0).one_way.map(|h| h.as_str()), Some("west"));
}

#[test]
fn lay_road_line_dual_bidirectional_vertical_uses_canonical_south() {
    // A vertical dual-bidirectional line must canonicalize the forward lane
    // to "south" (and the reverse to "north") regardless of drag order,
    // mirroring the horizontal canonical-east behavior.
    let south = {
        let mut engine = GameEngine::new();
        engine.dispatch(GameIntent::LayRoadLine {
            points: vec![(5, 1).into(), (5, 2).into(), (5, 3).into()],
            preset: RoadPreset::DualBidirectional,
        })
    };
    let north = {
        let mut engine = GameEngine::new();
        engine.dispatch(GameIntent::LayRoadLine {
            points: vec![(5, 3).into(), (5, 2).into(), (5, 1).into()],
            preset: RoadPreset::DualBidirectional,
        })
    };

    let one_way_at = |snap: &caelum_core::GameSnapshot, x: i32, y: i32| {
        snap.map
            .tiles
            .iter()
            .find(|tile| tile.x == x && tile.y == y)
            .and_then(|tile| tile.one_way)
    };

    for y in 1..=3 {
        // Forward lane (x=5) is south in both drag orders.
        assert_eq!(
            one_way_at(&south.snapshot, 5, y).map(|h| h.as_str()),
            Some("south"),
            "southward forward lane at (5,{y})"
        );
        assert_eq!(
            one_way_at(&north.snapshot, 5, y).map(|h| h.as_str()),
            Some("south"),
            "northward drag must still place south forward lane at (5,{y})"
        );
        // Reverse lane (x=6, east/right of south) is north in both drag orders.
        assert_eq!(
            one_way_at(&south.snapshot, 6, y).map(|h| h.as_str()),
            Some("north"),
            "southward reverse lane at (6,{y})"
        );
        assert_eq!(
            one_way_at(&north.snapshot, 6, y).map(|h| h.as_str()),
            Some("north"),
            "northward drag must place the reverse lane on the SAME side at (6,{y})"
        );
        // The opposite side (x=4, west) must stay empty.
        assert!(
            one_way_at(&south.snapshot, 4, y).is_none()
                && one_way_at(&north.snapshot, 4, y).is_none(),
            "no reverse lane should leak to the west side at (4,{y})"
        );
    }
}

#[test]
fn lay_road_line_one_way_vertical_uses_drag_direction() {
    // OneWay follows the drag direction (not canonical), so a southward drag
    // sets "south" and a northward drag sets "north".
    let south = {
        let mut engine = GameEngine::new();
        engine.dispatch(GameIntent::LayRoadLine {
            points: vec![(5, 1).into(), (5, 2).into(), (5, 3).into()],
            preset: RoadPreset::OneWay,
        })
    };
    assert!(south.applied);
    for y in 1..=3 {
        assert_eq!(
            south
                .snapshot
                .map
                .tiles
                .iter()
                .find(|tile| tile.x == 5 && tile.y == y)
                .and_then(|tile| tile.one_way)
                .map(|h| h.as_str()),
            Some("south")
        );
    }

    let north = {
        let mut engine = GameEngine::new();
        engine.dispatch(GameIntent::LayRoadLine {
            points: vec![(5, 3).into(), (5, 2).into(), (5, 1).into()],
            preset: RoadPreset::OneWay,
        })
    };
    assert!(north.applied);
    for y in 1..=3 {
        assert_eq!(
            north
                .snapshot
                .map
                .tiles
                .iter()
                .find(|tile| tile.x == 5 && tile.y == y)
                .and_then(|tile| tile.one_way)
                .map(|h| h.as_str()),
            Some("north")
        );
    }
}

#[test]
fn lay_road_line_empty_points_is_rejected() {
    let mut engine = GameEngine::new();
    let result = engine.dispatch(GameIntent::LayRoadLine {
        points: vec![],
        preset: RoadPreset::TwoWay,
    });
    assert!(!result.applied);
    assert!(result.rejection.is_some());
}

// Regression: direction computation subtracts consecutive stroke points before
// per-tile map validation. Coordinates that overflow i32 subtraction must
// reject as InvalidRoadStroke rather than panic (debug) or wrap (release).
#[test]
fn lay_road_line_rejects_direction_overflow_coordinates() {
    let mut engine = GameEngine::new();
    let result = engine.dispatch(GameIntent::LayRoadLine {
        points: vec![(i32::MIN, 0).into(), (i32::MAX, 0).into()],
        preset: RoadPreset::TwoWay,
    });
    assert!(!result.applied);
    assert_eq!(
        result.rejection.map(|rejection| rejection.code),
        Some(RejectionCode::InvalidRoadStroke)
    );
}

// Later pairs must be validated too — the first-pair-only guard lets a payload
// whose second consecutive subtraction overflows through unchecked arithmetic.
#[test]
fn lay_road_line_rejects_overflow_on_later_stroke_pairs() {
    let mut engine = GameEngine::new();
    // First pair (0,0)->(1,0) is fine; second pair (1,0)->(i32::MIN,0) overflows.
    let result = engine.dispatch(GameIntent::LayRoadLine {
        points: vec![(0, 0).into(), (1, 0).into(), (i32::MIN, 0).into()],
        preset: RoadPreset::TwoWay,
    });
    assert!(!result.applied);
    assert_eq!(
        result.rejection.map(|rejection| rejection.code),
        Some(RejectionCode::InvalidRoadStroke)
    );
}

// DualBidirectional reverse-lane offsets can overflow even when consecutive
// pair subtraction is fine — e.g. South reverse offset (+1,0) on x=i32::MAX.
#[test]
fn lay_road_line_rejects_reverse_lane_offset_overflow() {
    let mut engine = GameEngine::new();
    let result = engine.dispatch(GameIntent::LayRoadLine {
        points: vec![(0, 0).into(), (0, 1).into(), (i32::MAX, 1).into()],
        preset: RoadPreset::DualBidirectional,
    });
    assert!(!result.applied);
    assert_eq!(
        result.rejection.map(|rejection| rejection.code),
        Some(RejectionCode::InvalidRoadStroke)
    );
}

#[test]
fn lay_road_line_single_point_is_a_no_op_unchanged() {
    // A single-point line has no direction (line_direction returns None) and
    // lay_lane on an empty tile would place one road, but a one-point drag is
    // treated as a tap by the runtime. At the transit layer a single-point
    // line that places one road is still a valid change.
    let mut engine = GameEngine::new();
    let result = engine.dispatch(GameIntent::LayRoadLine {
        points: vec![(1, 1).into()],
        preset: RoadPreset::TwoWay,
    });
    assert!(result.applied);
    assert_eq!(result.snapshot.budget, 120_000 - 100);
}

#[test]
fn lay_track_line_empty_points_is_rejected() {
    let mut engine = GameEngine::new();
    let result = engine.dispatch(GameIntent::LayTrackLine { points: vec![] });
    assert!(!result.applied);
    assert_eq!(
        result.rejection.map(|rejection| rejection.code),
        Some(RejectionCode::InvalidTrackStroke)
    );
}

#[test]
fn lay_track_line_all_invalid_tiles_is_unchanged() {
    // Every tile is out of bounds / invalid, so no track is laid and the line
    // is rejected as "track line unchanged" rather than silently succeeding.
    let base = GameEngine::new().snapshot();
    let mut standard = policy_engine(base.clone(), EconomyPreset::Standard, 120_000);
    let mut creative = policy_engine(base, EconomyPreset::Creative, 120_000);
    let standard_before = standard.snapshot();
    let creative_before = creative.snapshot();
    let standard_topology = standard.road_topology_for_test().clone();
    let creative_topology = creative.road_topology_for_test().clone();
    let intent = GameIntent::LayTrackLine {
        points: vec![(100, 100).into()],
    };

    let standard_result = standard.dispatch(intent.clone());
    let creative_result = creative.dispatch(intent);

    assert!(!standard_result.applied);
    assert!(!creative_result.applied);
    assert_eq!(
        standard_result
            .rejection
            .as_ref()
            .map(|rejection| &rejection.code),
        Some(&RejectionCode::InvalidTrackStroke)
    );
    assert_eq!(standard_result.rejection, creative_result.rejection);
    assert_eq!(standard_result.snapshot, standard_before);
    assert_eq!(creative_result.snapshot, creative_before);
    assert_eq!(standard.road_topology_for_test(), &standard_topology);
    assert_eq!(creative.road_topology_for_test(), &creative_topology);
}

#[test]
fn remove_at_tiles_empty_points_is_rejected() {
    let mut engine = GameEngine::new();
    let result = engine.dispatch(GameIntent::RemoveAtTiles { points: vec![] });
    assert!(!result.applied);
    assert_eq!(
        result.rejection.map(|rejection| rejection.code),
        Some(RejectionCode::BlockedTile)
    );
}

#[test]
fn remove_at_tiles_all_unchanged_is_rejected() {
    // Removing an out-of-bounds tile yields no change (remove_at_tile errors),
    // so the whole batch is rejected as "remove line unchanged".
    let mut engine = GameEngine::new();
    let result = engine.dispatch(GameIntent::RemoveAtTiles {
        points: vec![(100, 100).into()],
    });
    assert!(!result.applied);
    assert_eq!(
        result.rejection.map(|rejection| rejection.code),
        Some(RejectionCode::BlockedTile)
    );
}

#[test]
fn lay_road_line_one_way_over_two_way_road_updates_direction() {
    // lay_lane on an existing road whose one_way differs from the requested
    // direction must flip the direction and report a change (return true),
    // rather than skipping the tile as already-matching.
    let mut engine = GameEngine::new();
    engine.dispatch(GameIntent::LayRoad {
        point: (1, 1).into(),
    });
    // Pre-existing road is two-way (one_way == None).
    assert_eq!(
        engine
            .snapshot()
            .map
            .tiles
            .iter()
            .find(|tile| tile.x == 1 && tile.y == 1)
            .unwrap()
            .one_way,
        None
    );

    let result = engine.dispatch(GameIntent::LayRoadLine {
        points: vec![(1, 1).into(), (2, 1).into(), (3, 1).into()],
        preset: RoadPreset::OneWay,
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
    // The pre-existing two-way road is flipped to one-way east.
    assert_eq!(tile(1, 1).one_way.map(|h| h.as_str()), Some("east"));
    assert_eq!(tile(2, 1).one_way.map(|h| h.as_str()), Some("east"));
    assert_eq!(tile(3, 1).one_way.map(|h| h.as_str()), Some("east"));
    // The initial LayRoad charged one tile; the line charges the two newly
    // placed tiles (the flipped (1,1) tile is an update, not a new placement).
    assert_eq!(result.snapshot.budget, 120_000 - 3 * 100);
}

#[test]
fn lay_road_line_over_building_occupied_tiles_is_unchanged() {
    // lay_lane on an empty-kind tile that is building-occupied fails
    // is_valid_road_placement and returns false. When every requested tile is
    // blocked this way, the line is rejected as "road line unchanged".
    let mut state = create_initial_snapshot();
    state.buildings = vec![destination_building(
        "building-001",
        "supermarket",
        vec![(1, 1).into(), (2, 1).into(), (3, 1).into()],
    )];

    let result = transit::lay_road_line(
        &state,
        &[(1, 1).into(), (2, 1).into(), (3, 1).into()],
        RoadPreset::OneWay,
    );
    assert!(result.is_err());
    assert_eq!(result.unwrap_err().code, RejectionCode::InvalidRoadStroke);
    // No budget was consumed (the input state is untouched on the Err path).
    assert_eq!(state.budget, 120_000);
}

#[test]
fn road_stroke_applies_valid_tiles_and_deducts_budget() {
    let mut engine = GameEngine::new();
    let before = engine.snapshot();
    let changed = Point { x: 2, y: 2 };
    let skipped = Point { x: 14, y: 8 };

    let result = engine.dispatch(GameIntent::LayRoadLine {
        points: vec![changed, skipped],
        preset: RoadPreset::TwoWay,
    });

    assert!(result.applied);
    assert_eq!(result.snapshot.map.tile(changed).unwrap().kind, "road");
    assert_eq!(result.snapshot.map.tile(skipped), before.map.tile(skipped));
    assert_eq!(result.snapshot.budget, before.budget - 100);
}

#[test]
fn track_stroke_applies_valid_tiles_and_deducts_budget() {
    let mut engine = GameEngine::new();
    let before = engine.snapshot();
    let changed = Point { x: 2, y: 2 };
    let skipped = Point { x: 1_000, y: 1_000 };

    let result = engine.dispatch(GameIntent::LayTrackLine {
        points: vec![changed, skipped],
    });

    assert!(result.applied);
    assert!(result.snapshot.map.tile(changed).unwrap().has_track);
    assert_eq!(result.snapshot.map.tile(skipped), before.map.tile(skipped));
    assert_eq!(result.snapshot.budget, before.budget - 500);
}

fn policy_engine(snapshot: GameSnapshot, preset: EconomyPreset, budget: i32) -> GameEngine {
    let mut snapshot = snapshot;
    snapshot.rules.economy_preset = preset;
    snapshot.budget = budget;
    GameEngine::from_snapshot(snapshot).expect("policy fixture is valid")
}

#[test]
fn track_stroke_charges_each_unique_new_tile_and_creative_ignores_budget() {
    let base = GameEngine::new().snapshot();
    let mut standard = policy_engine(base.clone(), EconomyPreset::Standard, transit::TRACK_COST);
    let mut creative = policy_engine(base, EconomyPreset::Creative, 0);
    let standard_before = standard.snapshot();
    let creative_before = creative.snapshot();
    let points = vec![point(2, 2), point(2, 2), point(3, 2)];

    let standard_result = standard.dispatch(GameIntent::LayTrackLine {
        points: points.clone(),
    });
    let creative_result = creative.dispatch(GameIntent::LayTrackLine { points });

    assert!(standard_result.applied, "{standard_result:?}");
    assert_eq!(
        standard_result.snapshot.budget,
        standard_before.budget - transit::TRACK_COST
    );
    assert!(
        standard_result
            .snapshot
            .map
            .tile(point(2, 2))
            .unwrap()
            .has_track
    );
    assert_eq!(
        standard_result
            .snapshot
            .map
            .tile(point(3, 2))
            .unwrap()
            .has_track,
        standard_before.map.tile(point(3, 2)).unwrap().has_track
    );
    assert!(creative_result.applied, "{creative_result:?}");
    assert_eq!(creative_result.snapshot.budget, creative_before.budget);
    assert!(
        creative_result
            .snapshot
            .map
            .tile(point(2, 2))
            .unwrap()
            .has_track
    );
    assert!(
        creative_result
            .snapshot
            .map
            .tile(point(3, 2))
            .unwrap()
            .has_track
    );
}

#[test]
fn construction_cost_checks_precede_track_and_node_geometry_in_standard_only() {
    let base = GameEngine::new().snapshot();
    let mut standard_track = policy_engine(base.clone(), EconomyPreset::Standard, 0);
    let mut creative_track = policy_engine(base.clone(), EconomyPreset::Creative, 0);
    let standard_track_before = standard_track.snapshot();
    let creative_track_before = creative_track.snapshot();
    let standard_track_topology = standard_track.road_topology_for_test().clone();
    let creative_track_topology = creative_track.road_topology_for_test().clone();
    let standard_track_result = standard_track.dispatch(GameIntent::LayTrack {
        point: point(999, 999),
    });
    let creative_track_result = creative_track.dispatch(GameIntent::LayTrack {
        point: point(999, 999),
    });
    assert_eq!(
        standard_track_result.rejection.unwrap().code,
        RejectionCode::InsufficientBudget
    );
    assert_eq!(
        creative_track_result.rejection.unwrap().code,
        RejectionCode::OutOfBounds
    );
    assert_eq!(standard_track_result.snapshot, standard_track_before);
    assert_eq!(creative_track_result.snapshot, creative_track_before);
    assert_eq!(
        standard_track.road_topology_for_test(),
        &standard_track_topology
    );
    assert_eq!(
        creative_track.road_topology_for_test(),
        &creative_track_topology
    );

    let mut standard_stop = policy_engine(base.clone(), EconomyPreset::Standard, 0);
    let mut creative_stop = policy_engine(base.clone(), EconomyPreset::Creative, 0);
    let standard_stop_before = standard_stop.snapshot();
    let creative_stop_before = creative_stop.snapshot();
    let standard_stop_topology = standard_stop.road_topology_for_test().clone();
    let creative_stop_topology = creative_stop.road_topology_for_test().clone();
    let standard_stop_result =
        standard_stop.dispatch(GameIntent::AddBusStop { point: point(2, 2) });
    let creative_stop_result =
        creative_stop.dispatch(GameIntent::AddBusStop { point: point(2, 2) });
    assert_eq!(
        standard_stop_result.rejection.unwrap().code,
        RejectionCode::InsufficientBudget
    );
    assert_eq!(
        creative_stop_result.rejection.unwrap().code,
        RejectionCode::NoRoadAccess
    );
    assert_eq!(standard_stop_result.snapshot, standard_stop_before);
    assert_eq!(creative_stop_result.snapshot, creative_stop_before);
    assert_eq!(
        standard_stop.road_topology_for_test(),
        &standard_stop_topology
    );
    assert_eq!(
        creative_stop.road_topology_for_test(),
        &creative_stop_topology
    );

    let mut standard_station = policy_engine(base.clone(), EconomyPreset::Standard, 0);
    let mut creative_station = policy_engine(base, EconomyPreset::Creative, 0);
    let standard_station_before = standard_station.snapshot();
    let creative_station_before = creative_station.snapshot();
    let standard_station_topology = standard_station.road_topology_for_test().clone();
    let creative_station_topology = creative_station.road_topology_for_test().clone();
    let standard_station_result =
        standard_station.dispatch(GameIntent::AddMetroStation { point: point(2, 2) });
    let creative_station_result =
        creative_station.dispatch(GameIntent::AddMetroStation { point: point(2, 2) });
    assert_eq!(
        standard_station_result.rejection.unwrap().code,
        RejectionCode::InsufficientBudget
    );
    assert_eq!(
        creative_station_result.rejection.unwrap().code,
        RejectionCode::TrackRequired
    );
    assert_eq!(standard_station_result.snapshot, standard_station_before);
    assert_eq!(creative_station_result.snapshot, creative_station_before);
    assert_eq!(
        standard_station.road_topology_for_test(),
        &standard_station_topology
    );
    assert_eq!(
        creative_station.road_topology_for_test(),
        &creative_station_topology
    );
}

#[test]
fn track_stroke_continues_after_invalid_points_against_the_running_candidate() {
    let base = GameEngine::new().snapshot();
    let mut standard = policy_engine(base, EconomyPreset::Standard, 2 * transit::TRACK_COST);
    let before = standard.snapshot();
    let result = standard.dispatch(GameIntent::LayTrackLine {
        points: vec![point(999, 999), point(2, 2), point(3, 2)],
    });

    assert!(result.applied, "{result:?}");
    assert_eq!(
        result.snapshot.budget,
        before.budget - 2 * transit::TRACK_COST
    );
    assert!(result.snapshot.map.tile(point(2, 2)).unwrap().has_track);
    assert!(result.snapshot.map.tile(point(3, 2)).unwrap().has_track);
    assert_eq!(
        result.snapshot.map.tile(point(999, 999)),
        before.map.tile(point(999, 999))
    );
}

#[test]
fn area_stroke_applies_only_empty_tiles() {
    let mut engine = GameEngine::new();
    let before = engine.snapshot();
    let changed = Point { x: 13, y: 10 };
    let skipped = vec![
        Point { x: 13, y: 9 },
        Point { x: 14, y: 9 },
        Point { x: 14, y: 10 },
    ];

    let result = engine.dispatch(GameIntent::PaintAreaRectangle {
        area: "residential".to_string(),
        start: Point { x: 13, y: 9 },
        end: Point { x: 14, y: 10 },
    });

    assert!(result.applied);
    assert_eq!(
        result.snapshot.map.tile(changed).unwrap().area.as_deref(),
        Some("residential")
    );
    for point in skipped {
        assert_eq!(result.snapshot.map.tile(point), before.map.tile(point));
    }
}

#[test]
fn removal_stroke_applies_partial_result_and_breaks_affected_route() {
    let mut engine = GameEngine::new();
    for x in 2..=4 {
        assert!(
            engine
                .dispatch(GameIntent::LayRoad {
                    point: Point { x, y: 3 },
                })
                .applied
        );
    }
    assert!(
        engine
            .dispatch(GameIntent::AddBusStop {
                point: Point { x: 2, y: 2 },
            })
            .applied
    );
    assert!(
        engine
            .dispatch(GameIntent::AddBusStop {
                point: Point { x: 4, y: 2 },
            })
            .applied
    );
    assert!(
        engine
            .dispatch(GameIntent::CreateRoute {
                mode: TransitMode::Bus,
                pattern: ServicePattern::Loop,
                waypoint_ids: vec!["stop-001".to_string(), "stop-002".to_string()],
            })
            .applied
    );

    let changed = Point { x: 3, y: 3 };
    let skipped = Point { x: 10, y: 10 };
    let before = engine.snapshot();
    let result = engine.dispatch(GameIntent::RemoveAtTiles {
        points: vec![changed, skipped],
    });

    assert!(result.applied);
    assert_ne!(result.snapshot.map.tile(changed).unwrap().kind, "road");
    assert_eq!(result.snapshot.map.tile(skipped), before.map.tile(skipped));
    assert!(result.snapshot.transit.routes[0].path_broken);
}

#[test]
fn lay_road_line_dual_bidirectional_skips_building_occupied_reverse_tile() {
    // lay_reverse_lane on an empty-kind tile that is building-occupied passes
    // the "not empty kind" guard but fails is_valid_road_placement, returning
    // false. The forward lane and other reverse-lane tiles still land.
    let mut state = create_initial_snapshot();
    // Building occupies only the reverse-lane tile (1,0) — empty kind, but
    // building-occupied so is_valid_road_placement is false.
    state.buildings = vec![destination_building(
        "building-001",
        "supermarket",
        vec![(1, 0).into()],
    )];

    let result = transit::lay_road_line(
        &state,
        &[(1, 1).into(), (2, 1).into(), (3, 1).into()],
        RoadPreset::DualBidirectional,
    )
    .expect("forward lane lands");
    let tile = |x: i32, y: i32| {
        result
            .map
            .tiles
            .iter()
            .find(|tile| tile.x == x && tile.y == y)
            .expect("tile exists")
    };
    // Forward lane (y=1) is one-way east.
    assert_eq!(tile(1, 1).one_way.map(|h| h.as_str()), Some("east"));
    assert_eq!(tile(2, 1).one_way.map(|h| h.as_str()), Some("east"));
    assert_eq!(tile(3, 1).one_way.map(|h| h.as_str()), Some("east"));
    // Reverse lane (y=0): (1,0) is skipped (building-occupied), (2,0)/(3,0)
    // get the westbound reverse carriageway.
    assert_ne!(tile(1, 0).kind.as_str(), "road");
    assert_eq!(tile(2, 0).one_way.map(|h| h.as_str()), Some("west"));
    assert_eq!(tile(3, 0).one_way.map(|h| h.as_str()), Some("west"));
    // Three forward tiles + two reverse tiles charged.
    assert_eq!(result.budget, 120_000 - 5 * 100);
}

#[test]
fn lay_road_line_one_way_duplicate_points_yield_no_direction() {
    // Two identical points: dx == 0 and dy == 0, so line_direction hits its
    // final `else` arm and returns None. The line places a two-way road (no
    // direction) rather than a one-way lane.
    let mut engine = GameEngine::new();
    let result = engine.dispatch(GameIntent::LayRoadLine {
        points: vec![(1, 1).into(), (1, 1).into()],
        preset: RoadPreset::OneWay,
    });
    assert!(result.applied);
    let tile = result
        .snapshot
        .map
        .tiles
        .iter()
        .find(|tile| tile.x == 1 && tile.y == 1)
        .expect("tile exists");
    assert_eq!(tile.kind, "road");
    assert_eq!(tile.one_way, None);
    // Only one tile placed (the second point is a no-op match).
    assert_eq!(result.snapshot.budget, 120_000 - 100);
}

#[test]
fn lay_road_line_dual_bidirectional_duplicate_points_yield_no_reverse_lane() {
    // Two identical points: canonical_line_direction hits its final `else` arm
    // and returns None, so DualBidirectional places no reverse carriageway —
    // only a single two-way forward tile.
    let mut engine = GameEngine::new();
    let result = engine.dispatch(GameIntent::LayRoadLine {
        points: vec![(1, 1).into(), (1, 1).into()],
        preset: RoadPreset::DualBidirectional,
    });
    assert!(result.applied);
    let forward = result
        .snapshot
        .map
        .tiles
        .iter()
        .find(|tile| tile.x == 1 && tile.y == 1)
        .expect("forward tile exists");
    assert_eq!(forward.kind, "road");
    assert_eq!(forward.one_way, None);
    // canonical_line_direction returned None, so no reverse carriageway was
    // computed: the reverse-lane offset tile (1,0) is not a road.
    let reverse_offset = result
        .snapshot
        .map
        .tiles
        .iter()
        .find(|tile| tile.x == 1 && tile.y == 0);
    assert!(reverse_offset.is_none_or(|tile| tile.kind != "road"));
    assert_eq!(result.snapshot.budget, 120_000 - 100);
}

/// `AddMetroStation` must reject placement on a structure-owned tile (e.g.,
/// an automatic junction). The `is_valid_metro_station_placement` check
/// requires `road_structure_id.is_none()`, but this rejection path was
/// previously untested. The fixture lays track on an empty tile before roads
/// form a cross-junction over it — `refresh_automatic_junctions` does not
/// clear `has_track`, so the tile ends up with both track and a
/// `road_structure_id`, which is the only state where the structure-owned
/// guard can fire. Using `LayRoadLine` (not individual `LayRoad`) is required
/// because `connect_neighbor_endpoints` skips neighbors with ≥2 existing
/// connections — only `connect_authored_sequence` in a road line can add
/// the third and fourth connections to the crossing tile.
#[test]
fn add_metro_station_rejects_structure_owned_tile() {
    let mut engine = GameEngine::new();
    let center = Point { x: 5, y: 5 };

    // Lay track on an empty tile first (track is valid on empty tiles).
    engine.dispatch(GameIntent::LayTrack { point: center });

    // Lay a horizontal road line through the center, then a vertical road
    // line. The horizontal line makes (5,5) a road with E/W connections;
    // the vertical line's `connect_authored_sequence` adds N/S connections
    // (individual LayRoad would be blocked by the ≥2-connection guard).
    // The cross triggers `refresh_automatic_junctions` which stamps
    // `road_structure_id` on the center tile without clearing `has_track`.
    road_line(&mut engine, 5, 4, 6);
    engine.dispatch(GameIntent::LayRoadLine {
        points: vec![
            Point { x: 5, y: 4 },
            Point { x: 5, y: 5 },
            Point { x: 5, y: 6 },
        ],
        preset: RoadPreset::TwoWay,
    });

    // Verify the fixture: center tile has track AND is structure-owned.
    let snapshot = engine.snapshot();
    let tile = snapshot.map.tile(center).expect("center tile exists");
    assert!(tile.has_track, "fixture: center tile must have track");
    assert!(
        tile.road_structure_id.is_some(),
        "fixture: center tile must be structure-owned (junction), got {:?}",
        tile.road_structure_id
    );

    // AddMetroStation must be rejected — the tile is structure-owned.
    let result = engine.dispatch(GameIntent::AddMetroStation { point: center });
    assert!(
        !result.applied,
        "metro station on structure-owned tile should be rejected"
    );
    assert_eq!(
        result.rejection.unwrap().code,
        RejectionCode::BlockedTile,
        "structure-owned rejection should use BlockedTile"
    );
}
