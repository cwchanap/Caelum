use caelum_core::model::{
    ActiveTrip, Heading, LegFailureReason, MovementKind, PathGeometry, Point, PrivateCarTrip,
    RoadPathStep, RouteLeg, RouteLegKind, RouteLegStatus, RoutePlan, ServiceDirection,
    ServicePattern, TransitMode, TransitPath, TripPosition, TripPurpose, TripStatus,
};
use caelum_core::preview::RoutePreviewRequest;
use caelum_core::traffic::{derive_road_flow, RoadFlow};
use caelum_core::{router, transit, GameEngine, GameIntent, RoadPreset};

fn road_line(engine: &mut GameEngine, y: i32, from_x: i32, to_x: i32) {
    for x in from_x..=to_x {
        engine.dispatch(GameIntent::LayRoad {
            point: (x, y).into(),
        });
    }
}

fn one_step_road_path(position: Point, travel_seconds: f64) -> TransitPath {
    TransitPath::Road {
        steps: vec![RoadPathStep {
            position,
            entering_heading: Heading::East,
            leaving_heading: Heading::East,
            movement: MovementKind::Straight,
            geometry: PathGeometry::Line {
                from: TripPosition::from(position),
                to: TripPosition::from((position.x + 1, position.y)),
            },
            travel_seconds,
        }],
        total_travel_seconds: travel_seconds,
    }
}

fn driving_car(id: usize, path: TransitPath) -> ActiveTrip {
    ActiveTrip {
        id: format!("car-trip-{id:03}"),
        sim_id: format!("car-sim-{id:03}"),
        purpose: TripPurpose::CommuteOutbound,
        origin: (1, 1).into(),
        destination: (8, 1).into(),
        position: (1, 1).into(),
        status: TripStatus::Driving,
        deadline: 300.0,
        route_plan: None,
        current_leg_index: 0,
        patience_remaining: 240.0,
        private_car_trip: Some(PrivateCarTrip {
            path,
            arrival_time: 100.0,
        }),
    }
}

fn bus_single_step_state() -> caelum_core::GameSnapshot {
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
    assert!(route.applied, "bus fixture route should apply: {route:?}");
    let mut state = route.snapshot;
    let path = one_step_road_path((2, 1).into(), 1.25);
    state.transit.routes[0].legs[0].current_path = Some(path.clone());
    state.transit.routes[0].legs[0].last_valid_path = Some(path);
    state
}

fn metro_single_step_state() -> caelum_core::GameSnapshot {
    let mut engine = GameEngine::new();
    for x in 2..=12 {
        engine.dispatch(GameIntent::LayTrack {
            point: (x, 4).into(),
        });
    }
    engine.dispatch(GameIntent::AddMetroStation {
        point: (2, 4).into(),
    });
    engine.dispatch(GameIntent::AddMetroStation {
        point: (12, 4).into(),
    });
    let route = engine.dispatch(GameIntent::CreateRoute {
        mode: TransitMode::Metro,
        pattern: ServicePattern::Loop,
        waypoint_ids: vec!["station-001".to_string(), "station-002".to_string()],
    });
    assert!(route.applied, "metro fixture route should apply: {route:?}");
    let mut state = route.snapshot;
    let path = TransitPath::Track {
        steps: vec![caelum_core::model::TrackPathStep {
            position: (2, 1).into(),
            heading: Heading::East,
            geometry: PathGeometry::Line {
                from: (2, 1).into(),
                to: (3, 1).into(),
            },
            travel_seconds: 1.25,
        }],
        total_travel_seconds: 1.25,
    };
    state.transit.metro_lines[0].legs[0].current_path = Some(path.clone());
    state.transit.metro_lines[0].legs[0].last_valid_path = Some(path);
    state
}

#[test]
fn bus_vehicle_uses_congested_road_time_for_boundary_and_motion() {
    let point = Point { x: 2, y: 1 };
    let mut state = bus_single_step_state();
    state.active_trips = (0..6)
        .map(|id| driving_car(id, one_step_road_path(point, 1.0)))
        .collect();
    let flow = derive_road_flow(&state);

    let seconds =
        transit::seconds_until_next_vehicle_stop(&state, &flow, &state.transit.vehicles[0])
            .expect("bus has a next stop");
    assert!((seconds - 1.875).abs() < 1e-9, "seconds={seconds}");

    let after_free_flow_delta = transit::tick_vehicles(&state, &flow, 1.25);
    assert!(after_free_flow_delta.transit.vehicles[0].step_progress > 0.0);
    assert!(after_free_flow_delta.transit.vehicles[0].step_progress < 1.0);

    let after_congested_remainder = transit::tick_vehicles(&after_free_flow_delta, &flow, 0.625);
    let vehicle = &after_congested_remainder.transit.vehicles[0];
    assert_eq!(vehicle.path_step_index, 0);
    assert_eq!(vehicle.step_progress, 0.0);
    assert_eq!(vehicle.itinerary_index, 1);
}

#[test]
fn metro_vehicle_keeps_stored_track_time_when_road_is_congested() {
    let point = Point { x: 2, y: 1 };
    let mut state = metro_single_step_state();
    state.active_trips = (0..6)
        .map(|id| driving_car(id, one_step_road_path(point, 1.0)))
        .collect();
    let flow = derive_road_flow(&state);

    let seconds =
        transit::seconds_until_next_vehicle_stop(&state, &flow, &state.transit.vehicles[0])
            .expect("metro has a next stop");
    assert!((seconds - 1.25).abs() < 1e-9);

    let next = transit::tick_vehicles(&state, &flow, seconds);
    let vehicle = &next.transit.vehicles[0];
    assert_eq!(vehicle.path_step_index, 0);
    assert_eq!(vehicle.step_progress, 0.0);
    assert_eq!(vehicle.itinerary_index, 1);
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
        private_car_trip: None,
    });

    let flow = RoadFlow::new();
    let boarded = transit::tick_vehicles(&snapshot, &flow, 0.0);
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
        transit::seconds_until_next_vehicle_stop(&boarded, &flow, &boarded.transit.vehicles[0])
            .expect("vehicle has a next stop");
    let arrived = transit::tick_vehicles(&boarded, &flow, ride_seconds);
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

    let plan = router::find_route_plan(&state, &RoadFlow::new(), &(2, 4).into(), &(12, 4).into())
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

fn point(x: i32, y: i32) -> Point {
    Point { x, y }
}

fn dispatch(engine: &mut GameEngine, intent: GameIntent) {
    let result = engine.dispatch(intent);
    assert!(result.applied, "fixture dispatch should apply: {result:?}");
}

fn add_bus_stop(engine: &mut GameEngine, position: Point) -> String {
    dispatch(engine, GameIntent::AddBusStop { point: position });
    engine
        .snapshot()
        .transit
        .stops
        .iter()
        .find(|stop| stop.position == position)
        .map(|stop| stop.id.clone())
        .expect("fixture stop")
}

#[test]
fn terminal_turnaround_recovers_after_a_roundabout_is_placed() {
    let mut engine = GameEngine::new();
    dispatch(
        &mut engine,
        GameIntent::LayRoadLine {
            points: vec![
                point(3, 3),
                point(4, 3),
                point(4, 4),
                point(3, 4),
                point(3, 3),
            ],
            preset: RoadPreset::TwoWay,
        },
    );
    dispatch(
        &mut engine,
        GameIntent::LayRoadLine {
            points: (1..=3).map(|x| point(x, 3)).collect(),
            preset: RoadPreset::OneWay,
        },
    );
    dispatch(
        &mut engine,
        GameIntent::LayRoadLine {
            points: (4..=6).rev().map(|x| point(x, 3)).collect(),
            preset: RoadPreset::OneWay,
        },
    );

    let first = add_bus_stop(&mut engine, point(3, 2));
    let second = add_bus_stop(&mut engine, point(4, 5));
    let waypoint_ids = vec![first.clone(), second.clone()];
    let request = RoutePreviewRequest {
        mode: TransitMode::Bus,
        pattern: ServicePattern::Shuttle,
        waypoint_ids: waypoint_ids.clone(),
        route_id: None,
        expected_revision: None,
        generation: 1,
    };

    let broken = engine.preview_route(request.clone());
    let turnaround = broken
        .legs
        .iter()
        .find(|leg| {
            leg.kind == RouteLegKind::TerminalReversal
                && leg.from_waypoint_id.as_str() == first
                && leg.to_waypoint_id.as_str() == first
        })
        .expect("preview should include the first terminal reversal");
    assert_eq!(turnaround.status, RouteLegStatus::NetworkDisconnected);
    assert_eq!(
        turnaround.failure_reason,
        Some(LegFailureReason::NoLegalTurnaround)
    );
    assert!(broken.rejection.is_some());

    let rejected = engine.dispatch(GameIntent::CreateRoute {
        mode: TransitMode::Bus,
        pattern: ServicePattern::Shuttle,
        waypoint_ids: waypoint_ids.clone(),
    });
    assert!(
        !rejected.applied,
        "broken route must not save: {rejected:?}"
    );

    dispatch(
        &mut engine,
        GameIntent::PlaceRoundabout {
            origin: point(3, 3),
            size: caelum_core::model::RoundaboutSize::Compact2x2,
        },
    );
    dispatch(
        &mut engine,
        GameIntent::LayRoadLine {
            points: vec![point(4, 2), point(5, 2)],
            preset: RoadPreset::TwoWay,
        },
    );
    dispatch(
        &mut engine,
        GameIntent::LayRoadLine {
            points: vec![point(3, 5), point(2, 5)],
            preset: RoadPreset::TwoWay,
        },
    );

    let recovered = engine.preview_route(RoutePreviewRequest {
        generation: 2,
        ..request
    });
    assert!(
        recovered.rejection.is_none(),
        "roundabout should recover the route: {recovered:?}"
    );
    assert!(recovered
        .legs
        .iter()
        .all(|leg| leg.status == RouteLegStatus::Connected));

    let outbound = recovered
        .legs
        .iter()
        .find(|leg| {
            leg.kind == RouteLegKind::Service
                && leg.from_waypoint_id.as_str() == first
                && leg.to_waypoint_id.as_str() == second
        })
        .expect("recovered preview should include outbound service");
    let steps = outbound
        .current_path
        .as_ref()
        .expect("recovered outbound path")
        .road_steps();
    assert_eq!(
        steps
            .iter()
            .map(|step| (
                step.position,
                step.entering_heading,
                step.leaving_heading,
                step.movement,
            ))
            .collect::<Vec<_>>(),
        vec![
            (
                point(4, 2),
                Heading::South,
                Heading::South,
                MovementKind::Straight,
            ),
            (
                point(4, 3),
                Heading::South,
                Heading::West,
                MovementKind::RoundaboutEntry,
            ),
            (
                point(3, 3),
                Heading::West,
                Heading::South,
                MovementKind::RoundaboutCirculation,
            ),
            (
                point(3, 4),
                Heading::South,
                Heading::South,
                MovementKind::RoundaboutExit,
            ),
        ]
    );

    let saved = engine.dispatch(GameIntent::CreateRoute {
        mode: TransitMode::Bus,
        pattern: ServicePattern::Shuttle,
        waypoint_ids,
    });
    assert!(saved.applied, "recovered route should save: {saved:?}");
    assert!(saved.snapshot.transit.routes[0]
        .legs
        .iter()
        .all(|leg| leg.status == RouteLegStatus::Connected && leg.current_path.is_some()));
}
