use caelum_core::model::{
    ActiveTrip, GameSnapshot, Heading, LegFailureReason, MovementKind, RouteLeg, RouteLegKind,
    RouteLegStatus, RoutePlan, ServiceDirection, ServicePattern, TransitMode, TransitPath,
    TripPurpose, TripStatus, Vehicle,
};
use caelum_core::network::resolve_route_legs;
use caelum_core::road_topology::RoadTopology;
use caelum_core::service_itinerary::{enumerate_ride_edges, service_visits, ServiceVisit};
use caelum_core::{router, transit, GameEngine, GameIntent, RoadPreset, RoutingContext};

fn tick_trips(state: &GameSnapshot, topology: &RoadTopology, delta_seconds: f64) -> GameSnapshot {
    caelum_core::trips::tick_trips(state, topology, delta_seconds)
}

fn ids(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_string()).collect()
}

fn road_line(engine: &mut GameEngine, y: i32, from_x: i32, to_x: i32) {
    for x in from_x..=to_x {
        engine.dispatch(GameIntent::LayRoad {
            point: (x, y).into(),
        });
    }
}

fn shuttle_state() -> caelum_core::model::GameSnapshot {
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
    let stop_ids = state.transit.routes[0].stop_ids.clone();
    state.transit.routes[0].pattern = ServicePattern::Shuttle;
    state.transit.routes[0].legs = resolve_route_legs(
        &state,
        RoutingContext {
            road_topology: &topology,
        },
        TransitMode::Bus,
        &stop_ids,
        ServicePattern::Shuttle,
    );
    state.transit.routes[0].path_broken = false;
    state.transit.routes[0].vehicle_ids = vec!["vehicle-001".to_string()];
    state.transit.vehicles = vec![Vehicle {
        id: "vehicle-001".to_string(),
        mode: TransitMode::Bus,
        line_id: "route-001".to_string(),
        capacity: 18,
        passenger_ids: Vec::new(),
        itinerary_index: 0,
        path_step_index: 0,
        step_progress: 0.0,
        parked_position: None,
    }];
    state
}

fn metro_shuttle_state() -> caelum_core::model::GameSnapshot {
    let mut engine = GameEngine::new();
    for x in 2..=10 {
        engine.dispatch(GameIntent::LayTrack {
            point: (x, 4).into(),
        });
    }
    for x in [2, 6, 10] {
        engine.dispatch(GameIntent::AddMetroStation {
            point: (x, 4).into(),
        });
    }
    engine.set_budget_for_test(transit::METRO_COST);
    engine.dispatch(GameIntent::CreateRoute {
        mode: TransitMode::Metro,
        pattern: ServicePattern::Loop,
        waypoint_ids: ids(&["station-001", "station-002", "station-003"]),
    });
    let mut state = engine.snapshot();
    let topology = RoadTopology::compile(&state.map).unwrap();
    let station_ids = state.transit.metro_lines[0].station_ids.clone();
    state.transit.metro_lines[0].pattern = ServicePattern::Shuttle;
    state.transit.metro_lines[0].legs = resolve_route_legs(
        &state,
        RoutingContext {
            road_topology: &topology,
        },
        TransitMode::Metro,
        &station_ids,
        ServicePattern::Shuttle,
    );
    state.transit.metro_lines[0].path_broken = false;
    state.transit.metro_lines[0].vehicle_ids = vec!["vehicle-001".to_string()];
    state.transit.vehicles = vec![Vehicle {
        id: "vehicle-001".to_string(),
        mode: TransitMode::Metro,
        line_id: "metro-001".to_string(),
        capacity: 90,
        passenger_ids: Vec::new(),
        itinerary_index: 0,
        path_step_index: 0,
        step_progress: 0.0,
        parked_position: None,
    }];
    state
}

fn transit_plan(
    from: (i32, i32),
    to: (i32, i32),
    direction: ServiceDirection,
    board_itinerary_index: usize,
    alight_itinerary_index: usize,
) -> RoutePlan {
    RoutePlan {
        legs: vec![RouteLeg {
            mode: TransitMode::Bus,
            from: from.into(),
            to: to.into(),
            line_id: Some("route-001".to_string()),
            service_direction: Some(direction),
            board_itinerary_index: Some(board_itinerary_index),
            alight_itinerary_index: Some(alight_itinerary_index),
        }],
        estimated_seconds: 100.0,
    }
}

fn metro_transit_plan(
    from: (i32, i32),
    to: (i32, i32),
    direction: ServiceDirection,
    board_itinerary_index: usize,
    alight_itinerary_index: usize,
) -> RoutePlan {
    RoutePlan {
        legs: vec![RouteLeg {
            mode: TransitMode::Metro,
            from: from.into(),
            to: to.into(),
            line_id: Some("metro-001".to_string()),
            service_direction: Some(direction),
            board_itinerary_index: Some(board_itinerary_index),
            alight_itinerary_index: Some(alight_itinerary_index),
        }],
        estimated_seconds: 120.0,
    }
}

fn trip(plan: RoutePlan, status: TripStatus, position: (i32, i32)) -> ActiveTrip {
    ActiveTrip {
        id: "trip-001".to_string(),
        sim_id: "sim-001".to_string(),
        purpose: TripPurpose::CommuteReturn,
        origin: position.into(),
        destination: plan.legs[0].to,
        position: position.into(),
        status,
        deadline: 3_600.0,
        route_plan: Some(plan),
        current_leg_index: 0,
        patience_remaining: 240.0,
        private_car_trip: None,
    }
}

fn tick_vehicles(
    state: &caelum_core::model::GameSnapshot,
    delta_seconds: f64,
) -> caelum_core::model::GameSnapshot {
    transit::tick_vehicles(state, delta_seconds)
}

#[test]
fn outbound_and_return_are_independently_routed_on_paired_one_way_roads() {
    let mut engine = GameEngine::new();
    engine.dispatch(GameIntent::LayRoadLine {
        points: (2..=25).map(|x| (x, 5).into()).collect(),
        preset: RoadPreset::DualBidirectional,
    });
    for point in [(2, 6), (25, 3)] {
        engine.dispatch(GameIntent::AddBusStop {
            point: point.into(),
        });
    }
    let mut state = engine.snapshot();
    for x in [2, 25] {
        let north = state.map.tile_mut((x, 4).into()).unwrap();
        north.one_way = None;
        if !north.road_connections.contains(&Heading::South) {
            north.road_connections.push(Heading::South);
        }
        let south = state.map.tile_mut((x, 5).into()).unwrap();
        south.one_way = None;
        if !south.road_connections.contains(&Heading::North) {
            south.road_connections.push(Heading::North);
        }
    }
    let topology = RoadTopology::compile(&state.map).unwrap();
    let legs = resolve_route_legs(
        &state,
        RoutingContext {
            road_topology: &topology,
        },
        TransitMode::Bus,
        &ids(&["stop-001", "stop-002"]),
        ServicePattern::Shuttle,
    );
    let outbound = legs
        .iter()
        .find(|leg| {
            leg.kind == RouteLegKind::Service && leg.direction == ServiceDirection::Outbound
        })
        .unwrap();
    let returning = legs
        .iter()
        .find(|leg| leg.kind == RouteLegKind::Service && leg.direction == ServiceDirection::Return)
        .unwrap();
    let outbound_reversed: Vec<_> = outbound
        .current_path
        .as_ref()
        .unwrap()
        .road_steps()
        .iter()
        .rev()
        .map(|step| step.position)
        .collect();
    let return_points: Vec<_> = returning
        .current_path
        .as_ref()
        .unwrap()
        .road_steps()
        .iter()
        .map(|step| step.position)
        .collect();

    assert_ne!(return_points, outbound_reversed);
    assert!(returning
        .current_path
        .as_ref()
        .unwrap()
        .road_steps()
        .iter()
        .all(|step| state
            .map
            .tile(step.position)
            .and_then(|tile| tile.one_way)
            .is_none_or(|heading| heading == step.leaving_heading)));
}

#[test]
fn interior_stop_has_distinct_outbound_and_return_visits() {
    let state = shuttle_state();
    let route = &state.transit.routes[0];
    let visits = service_visits(&route.stop_ids, &route.legs);
    let interior: Vec<&ServiceVisit> = visits
        .iter()
        .filter(|visit| visit.waypoint_id == "stop-002")
        .collect();

    assert_eq!(interior.len(), 2);
    assert_eq!(interior[0].direction, ServiceDirection::Outbound);
    assert_eq!(interior[1].direction, ServiceDirection::Return);
    assert_ne!(
        interior[0].departing_itinerary_index,
        interior[1].departing_itinerary_index
    );
}

#[test]
fn rider_boards_only_the_vehicle_visit_matching_the_plan() {
    let mut state = shuttle_state();
    state.active_trips = vec![trip(
        transit_plan((6, 4), (2, 4), ServiceDirection::Return, 4, 4),
        TripStatus::Waiting,
        (6, 4),
    )];
    state.transit.vehicles[0].itinerary_index = 1;

    let wrong_direction = tick_vehicles(&state, 0.0);
    assert!(wrong_direction.transit.vehicles[0].passenger_ids.is_empty());
    assert_eq!(wrong_direction.active_trips[0].status, TripStatus::Waiting);

    let mut right_visit = wrong_direction;
    right_visit.transit.vehicles[0].itinerary_index = 4;
    let boarded = tick_vehicles(&right_visit, 0.0);
    assert_eq!(boarded.transit.vehicles[0].passenger_ids, ["trip-001"]);
    assert_eq!(boarded.active_trips[0].status, TripStatus::Riding);
}

fn assert_terminal_waiter_boards_following_service_leg(
    reversal_itinerary_index: usize,
    service_itinerary_index: usize,
    from: (i32, i32),
    to: (i32, i32),
    direction: ServiceDirection,
) {
    let mut state = metro_shuttle_state();
    state.transit.vehicles[0].itinerary_index = reversal_itinerary_index;
    state.active_trips = vec![trip(
        metro_transit_plan(
            from,
            to,
            direction,
            service_itinerary_index,
            service_itinerary_index,
        ),
        TripStatus::Waiting,
        from,
    )];

    let on_reversal = tick_vehicles(&state, 0.0);
    assert_eq!(
        on_reversal.transit.vehicles[0].itinerary_index,
        reversal_itinerary_index
    );
    assert!(on_reversal.transit.vehicles[0].passenger_ids.is_empty());
    assert_eq!(on_reversal.active_trips[0].status, TripStatus::Waiting);

    let first_service_step_seconds = on_reversal.transit.metro_lines[0].legs
        [service_itinerary_index]
        .current_path
        .as_ref()
        .unwrap()
        .step(0)
        .unwrap()
        .travel_seconds();
    let departed = tick_vehicles(&on_reversal, first_service_step_seconds / 2.0);

    assert_eq!(
        departed.transit.vehicles[0].itinerary_index,
        service_itinerary_index
    );
    assert_eq!(departed.transit.vehicles[0].path_step_index, 0);
    assert_eq!(departed.transit.vehicles[0].step_progress, 0.5);
    assert_eq!(departed.transit.vehicles[0].passenger_ids, ["trip-001"]);
    assert_eq!(departed.active_trips[0].status, TripStatus::Riding);
}

#[test]
fn outbound_terminal_waiter_boards_after_zero_second_reversal() {
    assert_terminal_waiter_boards_following_service_leg(
        5,
        0,
        (2, 4),
        (6, 4),
        ServiceDirection::Outbound,
    );
}

#[test]
fn return_terminal_waiter_boards_after_zero_second_reversal() {
    assert_terminal_waiter_boards_following_service_leg(
        2,
        3,
        (10, 4),
        (6, 4),
        ServiceDirection::Return,
    );
}

#[test]
fn alighting_matches_the_completed_itinerary_leg_not_only_the_stop_id() {
    let mut state = shuttle_state();
    state.active_trips = vec![trip(
        transit_plan((10, 4), (6, 4), ServiceDirection::Return, 3, 3),
        TripStatus::Riding,
        (10, 4),
    )];
    state.transit.vehicles[0].passenger_ids = vec!["trip-001".to_string()];
    state.transit.vehicles[0].itinerary_index = 0;

    let outbound_seconds =
        transit::seconds_until_next_vehicle_stop(&state, &state.transit.vehicles[0]).unwrap();
    let wrong_completion = tick_vehicles(&state, outbound_seconds);
    assert_eq!(
        wrong_completion.transit.vehicles[0].passenger_ids,
        ["trip-001"]
    );
    assert_eq!(wrong_completion.active_trips[0].status, TripStatus::Riding);

    let mut returning = wrong_completion;
    returning.transit.vehicles[0].itinerary_index = 3;
    returning.transit.vehicles[0].path_step_index = 0;
    returning.transit.vehicles[0].step_progress = 0.0;
    let return_seconds =
        transit::seconds_until_next_vehicle_stop(&returning, &returning.transit.vehicles[0])
            .unwrap();
    let correct_completion = tick_vehicles(&returning, return_seconds);
    assert!(correct_completion.transit.vehicles[0]
        .passenger_ids
        .is_empty());
    assert_eq!(
        correct_completion.active_trips[0].status,
        TripStatus::Walking
    );
    assert_eq!(correct_completion.active_trips[0].position, (6, 4).into());
}

#[test]
fn alighting_after_zero_second_reversal_uses_the_completed_service_index() {
    let mut state = metro_shuttle_state();
    state.transit.vehicles[0].passenger_ids = vec!["trip-001".to_string()];
    state.transit.vehicles[0].itinerary_index = 2;
    state.active_trips = vec![trip(
        metro_transit_plan((10, 4), (6, 4), ServiceDirection::Return, 3, 3),
        TripStatus::Riding,
        (10, 4),
    )];
    let return_leg_seconds = state.transit.metro_lines[0].legs[3]
        .estimated_seconds
        .unwrap();

    let arrived = tick_vehicles(&state, return_leg_seconds);

    assert!(arrived.transit.vehicles[0].passenger_ids.is_empty());
    assert_eq!(arrived.active_trips[0].status, TripStatus::Walking);
    assert_eq!(arrived.active_trips[0].position, (6, 4).into());
}

#[test]
fn full_cycle_alighting_is_committed_when_vehicle_cursor_wraps_to_start() {
    let mut state = metro_shuttle_state();
    state.transit.vehicles[0].passenger_ids = vec!["trip-001".to_string()];
    state.transit.vehicles[0].itinerary_index = 2;
    state.active_trips = vec![trip(
        metro_transit_plan((10, 4), (6, 4), ServiceDirection::Return, 3, 3),
        TripStatus::Riding,
        (10, 4),
    )];
    let initial_cursor = (
        state.transit.vehicles[0].itinerary_index,
        state.transit.vehicles[0].path_step_index,
        state.transit.vehicles[0].step_progress,
    );
    let full_cycle_seconds: f64 = state.transit.metro_lines[0]
        .legs
        .iter()
        .map(|leg| leg.estimated_seconds.unwrap())
        .sum();

    let completed = tick_vehicles(&state, full_cycle_seconds);

    assert_eq!(
        (
            completed.transit.vehicles[0].itinerary_index,
            completed.transit.vehicles[0].path_step_index,
            completed.transit.vehicles[0].step_progress,
        ),
        initial_cursor
    );
    assert!(completed.transit.vehicles[0].passenger_ids.is_empty());
    assert_eq!(completed.active_trips[0].status, TripStatus::Walking);
    assert_eq!(completed.active_trips[0].current_leg_index, 1);
    assert_eq!(completed.active_trips[0].position, (6, 4).into());
}

#[test]
fn full_cycle_without_passenger_events_remains_a_no_op() {
    let mut state = metro_shuttle_state();
    state.transit.vehicles[0].itinerary_index = 2;
    let full_cycle_seconds: f64 = state.transit.metro_lines[0]
        .legs
        .iter()
        .map(|leg| leg.estimated_seconds.unwrap())
        .sum();

    let completed = tick_vehicles(&state, full_cycle_seconds);

    assert_eq!(completed, state);
}

#[test]
fn terminal_and_loop_rules_are_mode_correct() {
    let bus = shuttle_state();
    assert!(bus.transit.routes[0]
        .legs
        .iter()
        .filter(|leg| leg.kind == RouteLegKind::TerminalReversal)
        .all(|leg| leg
            .current_path
            .as_ref()
            .unwrap()
            .road_steps()
            .iter()
            .any(|step| step.movement == MovementKind::UTurn)));

    let mut one_way = GameEngine::new();
    one_way.dispatch(GameIntent::LayRoadLine {
        points: (2..=11).map(|x| (x, 5).into()).collect(),
        preset: RoadPreset::OneWay,
    });
    for x in [2, 10] {
        one_way.dispatch(GameIntent::AddBusStop {
            point: (x, 4).into(),
        });
    }
    let one_way_state = one_way.snapshot();
    let one_way_topology = RoadTopology::compile(&one_way_state.map).unwrap();
    let one_way_legs = resolve_route_legs(
        &one_way_state,
        RoutingContext {
            road_topology: &one_way_topology,
        },
        TransitMode::Bus,
        &ids(&["stop-001", "stop-002"]),
        ServicePattern::Shuttle,
    );
    assert!(one_way_legs
        .iter()
        .filter(|leg| leg.kind == RouteLegKind::TerminalReversal)
        .all(|leg| {
            leg.failure_reason != Some(LegFailureReason::NetworkDisconnected)
                && leg.failure_reason != Some(LegFailureReason::NoRoadAccess)
        }));
    let return_service = one_way_legs
        .iter()
        .find(|leg| {
            leg.kind == RouteLegKind::Service
                && leg.from_waypoint_id == "stop-002"
                && leg.to_waypoint_id == "stop-001"
        })
        .expect("return service leg on one-way road");
    assert_eq!(
        return_service.status,
        RouteLegStatus::NetworkDisconnected,
        "return service leg must fail on a one-way east road: {return_service:?}",
    );

    let mut metro = GameEngine::new();
    for x in 2..=10 {
        metro.dispatch(GameIntent::LayTrack {
            point: (x, 4).into(),
        });
    }
    for x in [2, 10] {
        metro.dispatch(GameIntent::AddMetroStation {
            point: (x, 4).into(),
        });
    }
    let metro_state = metro.snapshot();
    let metro_topology = RoadTopology::compile(&metro_state.map).unwrap();
    let metro_legs = resolve_route_legs(
        &metro_state,
        RoutingContext {
            road_topology: &metro_topology,
        },
        TransitMode::Metro,
        &ids(&["station-001", "station-002"]),
        ServicePattern::Shuttle,
    );
    assert!(metro_legs
        .iter()
        .filter(|leg| leg.kind == RouteLegKind::TerminalReversal)
        .all(|leg| leg.estimated_seconds == Some(0.0)));

    let loop_legs = caelum_core::service_itinerary::build_service_itinerary(
        ServicePattern::Loop,
        &ids(&["A", "B", "C"]),
    );
    assert_eq!(
        loop_legs.last().map(|leg| leg.key()),
        Some(("C", "A", ServiceDirection::Loop, RouteLegKind::Service))
    );
}

#[test]
fn shuttle_with_off_road_terminal_resolves_reversal_on_adjacent_road_access() {
    let mut engine = GameEngine::new();
    // Corridor on y=5 with empty roadside stop anchors at y=4, so the terminal
    // tile itself is not a RoadState (bus-terminal / roadside).
    road_line(&mut engine, 5, 2, 10);
    for x in [2, 10] {
        engine.dispatch(GameIntent::AddBusStop {
            point: (x, 4).into(),
        });
    }
    let state = engine.snapshot();
    let topology = RoadTopology::compile(&state.map).unwrap();
    let legs = resolve_route_legs(
        &state,
        RoutingContext {
            road_topology: &topology,
        },
        TransitMode::Bus,
        &ids(&["stop-001", "stop-002"]),
        ServicePattern::Shuttle,
    );

    assert!(
        legs.iter()
            .all(|leg| leg.status == RouteLegStatus::Connected),
        "off-road shuttle terminals must reverse via adjacent road access: {legs:?}"
    );
    let reversals: Vec<_> = legs
        .iter()
        .filter(|leg| leg.kind == RouteLegKind::TerminalReversal)
        .collect();
    assert_eq!(reversals.len(), 2);
    for leg in reversals {
        assert!(leg.current_path.is_some());
    }
}

#[test]
fn shuttle_plan_estimate_includes_return_and_terminal_reversal_legs() {
    let mut state = shuttle_state();
    for (stop, x) in state.transit.stops.iter_mut().zip([2, 12, 22]) {
        stop.position = (x, 4).into();
    }
    for (index, seconds) in [5.0, 7.0, 3.0, 11.0, 13.0, 2.0].into_iter().enumerate() {
        let path = TransitPath::Road {
            steps: Vec::new(),
            total_travel_seconds: seconds,
        };
        state.transit.routes[0].legs[index].current_path = Some(path.clone());
        state.transit.routes[0].legs[index].last_valid_path = Some(path);
        state.transit.routes[0].legs[index].estimated_seconds = Some(seconds);
    }
    let route = &state.transit.routes[0];
    let visits = service_visits(&route.stop_ids, &route.legs);
    let cross_terminal = enumerate_ride_edges(&visits, &route.legs)
        .into_iter()
        .find(|edge| edge.board_itinerary_index == 1 && edge.alight_itinerary_index == 4)
        .expect("outbound interior visit can ride through the terminal and return");
    assert_eq!(cross_terminal.itinerary_leg_indexes, [1, 2, 3, 4]);
    let cross_terminal_seconds: f64 = cross_terminal
        .itinerary_leg_indexes
        .iter()
        .map(|index| route.legs[*index].estimated_seconds.unwrap())
        .sum();
    assert_eq!(cross_terminal_seconds, 7.0 + 3.0 + 11.0 + 13.0);

    let plan = router::plan_route(&state, &(12, 4).into(), &(2, 4).into()).unwrap();
    let transit_leg = plan
        .legs
        .iter()
        .find(|leg| leg.mode == TransitMode::Bus)
        .expect("cross-terminal Shuttle ride should beat walking");

    assert_eq!(
        transit_leg.service_direction,
        Some(ServiceDirection::Return)
    );
    assert_eq!(transit_leg.board_itinerary_index, Some(4));
    assert_eq!(transit_leg.alight_itinerary_index, Some(4));
    assert_eq!(plan.estimated_seconds, 90.0 + 13.0);
}

#[test]
fn shuttle_off_road_terminal_with_separate_access_lanes_does_not_jump() {
    let mut engine = GameEngine::new();
    // North corridor on y=3 (will be one-way eastbound) and south corridor on
    // y=5 (will be one-way westbound). Stops are placed on empty y=4 anchors
    // between the two corridors.
    road_line(&mut engine, 3, 1, 3);
    road_line(&mut engine, 5, 1, 3);
    for x in [1, 3] {
        engine.dispatch(GameIntent::AddBusStop {
            point: (x, 4).into(),
        });
    }
    // Isolated bidirectional pair at (4,4)-(5,4), adjacent to the terminal at
    // (3,4) but not connected to either corridor. A U-turn is possible here
    // (drive to (5,4) and back to (4,4) heading West), so the old fallback
    // that iterated adjacent roads would falsely mark the reversal Connected.
    engine.dispatch(GameIntent::LayRoad {
        point: (4, 4).into(),
    });
    engine.dispatch(GameIntent::LayRoad {
        point: (5, 4).into(),
    });

    let mut state = engine.snapshot();
    // Make y=3 one-way eastbound and y=5 one-way westbound so the forward leg
    // (stop-001 → stop-002) arrives via (3,3) heading East and the return leg
    // departs via (3,5) heading West — different access tiles for the same
    // terminal.
    for x in 1..=3 {
        state.map.tile_mut((x, 3).into()).unwrap().one_way = Some(Heading::East);
        state.map.tile_mut((x, 5).into()).unwrap().one_way = Some(Heading::West);
    }
    let topology = RoadTopology::compile(&state.map).unwrap();
    let legs = resolve_route_legs(
        &state,
        RoutingContext {
            road_topology: &topology,
        },
        TransitMode::Bus,
        &ids(&["stop-001", "stop-002"]),
        ServicePattern::Shuttle,
    );

    // Exact stop access is a single persisted road point, not a direction-
    // dependent choice among all adjacent roads. After the one-way mutation,
    // the saved access is revalidated and the route remains disconnected
    // rather than silently switching lanes through the stop anchor.
    let service_legs: Vec<_> = legs
        .iter()
        .filter(|leg| leg.kind == RouteLegKind::Service)
        .collect();
    assert_eq!(service_legs.len(), 2);
    assert!(
        service_legs.iter().all(|leg| {
            leg.status == RouteLegStatus::NetworkDisconnected
                && leg.failure_reason == Some(caelum_core::LegFailureReason::NetworkDisconnected)
        }),
        "service legs must preserve the exact access points: {legs:?}"
    );

    // The terminal reversal at stop-002 (3,4) must not jump between the
    // separate north/south access lanes via the unrelated (4,4)-(5,4) pair.
    // After the fix, the reversal resolves independently at the terminal's
    // own road_point and succeeds with a zero-step path (no road steps =
    // no lane jumping).
    let reversal = legs
        .iter()
        .find(|leg| {
            leg.kind == RouteLegKind::TerminalReversal && leg.from_waypoint_id == "stop-002"
        })
        .expect("terminal reversal at stop-002");
    // The reversal resolves independently at the terminal's own road_point:
    // it succeeds with a zero-step path (no road steps = no lane jumping).
    // Pin the exact outcome rather than a disjunction so a regression to
    // either a lane-jumping connected path or an unexpected failure reason is
    // caught.
    assert_eq!(
        reversal.status,
        RouteLegStatus::Connected,
        "reversal must stay connected at the terminal's own road_point: {legs:?}"
    );
    assert_eq!(
        reversal.failure_reason, None,
        "connected reversal must carry no failure reason: {legs:?}"
    );
    let path = reversal
        .current_path
        .as_ref()
        .expect("connected reversal has a current path");
    assert!(
        path.road_steps().is_empty(),
        "reversal must not jump between separate access lanes: {legs:?}"
    );
}

/// Regression: `seconds_until_next_vehicle_stop` must walk forward across
/// zero-step terminal reversal legs and return the cumulative time to the
/// first real service-leg completion. When it returned `None` for a vehicle
/// sitting on a zero-step reversal, `next_boundary_after` inserted no substep
/// boundary, so a coarse tick ran past the next vehicle arrival. The
/// `just_disembarked_trip_ids` zero-delta mechanism then gave the alighted
/// passenger zero walk time even though part of the oversized substep elapsed
/// after the actual arrival — producing different walking progress than
/// equivalent stepped ticks and breaking granularity independence.
#[test]
fn coarse_tick_through_zero_step_reversal_matches_stepped_ticks() {
    let mut state = metro_shuttle_state();
    state.paused = false;
    state.speed = 1;

    // Vehicle sits on the zero-step terminal reversal at stop-003 (10, 4),
    // itinerary index 2. The following leg (index 3) is the return service
    // from stop-003 to stop-002 (6, 4).
    state.transit.vehicles[0].itinerary_index = 2;
    state.transit.vehicles[0].path_step_index = 0;
    state.transit.vehicles[0].step_progress = 0.0;

    let service_leg_seconds = state.transit.metro_lines[0].legs[3]
        .current_path
        .as_ref()
        .unwrap()
        .total_travel_seconds();

    // Passenger is aboard, riding to stop-002 (6, 4), then walking 2 tiles
    // south to (6, 2). The walk leg is 40 seconds (20 s/tile).
    let ride_plan = metro_transit_plan((10, 4), (6, 4), ServiceDirection::Return, 3, 3);
    let plan = RoutePlan {
        legs: vec![
            ride_plan.legs[0].clone(),
            RouteLeg {
                mode: TransitMode::Walk,
                from: (6, 4).into(),
                to: (6, 2).into(),
                line_id: None,
                service_direction: None,
                board_itinerary_index: None,
                alight_itinerary_index: None,
            },
        ],
        estimated_seconds: service_leg_seconds + 40.0,
    };

    state.active_trips = vec![ActiveTrip {
        id: "trip-001".to_string(),
        sim_id: "sim-001".to_string(),
        purpose: TripPurpose::CommuteReturn,
        origin: (10, 4).into(),
        destination: (6, 2).into(),
        position: (10, 4).into(),
        status: TripStatus::Riding,
        deadline: 3_600.0,
        route_plan: Some(plan),
        current_leg_index: 0,
        patience_remaining: 240.0,
        private_car_trip: None,
    }];
    state.transit.vehicles[0].passenger_ids = vec!["trip-001".to_string()];

    // Total delta: service leg + 10 seconds of walking (0.5 tiles at 20 s/tile).
    let walk_seconds = 10.0;
    let total_delta = service_leg_seconds + walk_seconds;
    let topology = RoadTopology::compile(&state.map).expect("fixture topology compiles");

    // Coarse: one big tick through the full trip simulation.
    let coarse = tick_trips(&state, &topology, total_delta);

    // Stepped: many small ticks summing to the same total.
    let step = 0.5;
    let mut stepped = state.clone();
    let mut remaining = total_delta;
    while remaining > 0.0 {
        let delta = remaining.min(step);
        stepped = tick_trips(&stepped, &topology, delta);
        remaining -= delta;
    }

    let coarse_trip = coarse
        .active_trips
        .iter()
        .find(|t| t.id == "trip-001")
        .expect("trip-001 present after coarse tick");
    let stepped_trip = stepped
        .active_trips
        .iter()
        .find(|t| t.id == "trip-001")
        .expect("trip-001 present after stepped ticks");

    assert_eq!(
        coarse_trip.status, stepped_trip.status,
        "trip status diverged: coarse {:?} stepped {:?}",
        coarse_trip.status, stepped_trip.status
    );
    assert_eq!(
        coarse_trip.current_leg_index, stepped_trip.current_leg_index,
        "current_leg_index diverged: coarse {} stepped {}",
        coarse_trip.current_leg_index, stepped_trip.current_leg_index
    );
    assert!(
        (coarse_trip.position.x - stepped_trip.position.x).abs() < 0.001,
        "walk x diverged: coarse {} stepped {}",
        coarse_trip.position.x,
        stepped_trip.position.x
    );
    assert!(
        (coarse_trip.position.y - stepped_trip.position.y).abs() < 0.001,
        "walk y diverged: coarse {} stepped {} (service_leg_seconds={})",
        coarse_trip.position.y,
        stepped_trip.position.y,
        service_leg_seconds
    );
}
