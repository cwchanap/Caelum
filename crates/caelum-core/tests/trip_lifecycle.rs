use caelum_core::buildings::assign_workplaces;
use caelum_core::model::{
    ActiveTrip, GameSnapshot, Heading, MaxAverageWaitSeconds, MetricsState, PlacedBuilding, Point,
    PrivateCarTrip, RollingWindowSeconds, RouteLeg, RouteLegStatus, RoutePlan, ServiceDirection,
    ServicePattern, Sim, TransitMode, TransitNetwork, TripOutcome, TripOutcomeKind, TripPosition,
    TripPurpose, TripStatus, Vehicle, WorkerProfile,
};
use caelum_core::road_topology::RoadTopology;
use caelum_core::{
    clock, commute, objectives, state::create_initial_snapshot, traffic, transit, trips,
};
use caelum_core::{GameEngine, GameIntent};

mod common;

fn sim(id: &str, home: Point, workplace: Option<Point>) -> Sim {
    Sim {
        id: id.to_string(),
        home,
        position: home,
        worker_profile: WorkerProfile::Worker,
        shift_template: Some("standard".to_string()),
        workplace,
        commute_day: 0,
        outbound_resolved_today: false,
        outbound_arrived_today: false,
        return_resolved_today: false,
        returned_home_today: false,
    }
}

fn trip(id: &str, status: TripStatus, position: TripPosition, destination: Point) -> ActiveTrip {
    ActiveTrip {
        id: id.to_string(),
        sim_id: "sim-001".to_string(),
        purpose: TripPurpose::CommuteOutbound,
        origin: Point { x: 2, y: 3 },
        destination,
        position,
        status,
        deadline: 900.0,
        route_plan: None,
        current_leg_index: 0,
        patience_remaining: 240.0,
        private_car_trip: None,
    }
}

fn walk_plan(from: Point, to: Point, estimated_seconds: f64) -> RoutePlan {
    RoutePlan {
        estimated_seconds,
        legs: vec![RouteLeg {
            mode: TransitMode::Walk,
            from,
            to,
            line_id: None,
            service_direction: None,
            board_itinerary_index: None,
            alight_itinerary_index: None,
        }],
    }
}

fn bus_plan(from: Point, to: Point, line_id: &str) -> RoutePlan {
    RoutePlan {
        estimated_seconds: 120.0,
        legs: vec![RouteLeg {
            mode: TransitMode::Bus,
            from,
            to,
            line_id: Some(line_id.to_string()),
            service_direction: Some(ServiceDirection::Loop),
            board_itinerary_index: Some(0),
            alight_itinerary_index: Some(0),
        }],
    }
}

fn destination_building(point: Point) -> PlacedBuilding {
    PlacedBuilding {
        id: "building-001".to_string(),
        building_type: "supermarket".to_string(),
        origin: point,
        rotation: 0,
        occupied_tiles: vec![point],
        placed_at: 0.0,
        transit_node_id: None,
    }
}

fn placed_building(id: &str, building_type: &str, occupied_tiles: Vec<Point>) -> PlacedBuilding {
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

#[test]
fn assign_workplaces_clears_stale_assignments_when_no_workplaces_remain() {
    let mut state = create_initial_snapshot();
    state.buildings = vec![placed_building(
        "building-001",
        "smallHouse",
        vec![Point { x: 2, y: 3 }],
    )];
    state.sims = vec![sim(
        "sim-001",
        Point { x: 2, y: 3 },
        Some(Point { x: 99, y: 99 }),
    )];

    assign_workplaces(&mut state);

    assert_eq!(state.sims[0].workplace, None);
}

#[test]
fn assign_workplaces_sorts_buildings_and_fills_slots_in_sim_order() {
    let supermarket_tiles = vec![
        Point { x: 8, y: 3 },
        Point { x: 9, y: 3 },
        Point { x: 8, y: 4 },
        Point { x: 9, y: 4 },
    ];
    let factory_tiles = vec![
        Point { x: 12, y: 3 },
        Point { x: 13, y: 3 },
        Point { x: 14, y: 3 },
        Point { x: 12, y: 4 },
        Point { x: 13, y: 4 },
        Point { x: 14, y: 4 },
    ];
    let mut state = create_initial_snapshot();
    // Deliberately reverse the vector order: assignment must sort by building
    // ID, not by insertion order.
    state.buildings = vec![
        placed_building("building-002", "factory", factory_tiles.clone()),
        placed_building("building-001", "supermarket", supermarket_tiles.clone()),
    ];
    state.sims = (1..=11)
        .map(|index| sim(&format!("sim-2{index:02}"), Point { x: 2, y: 3 }, None))
        .collect();

    assign_workplaces(&mut state);

    let assigned: Vec<_> = state.sims.iter().filter_map(|sim| sim.workplace).collect();
    assert_eq!(assigned.len(), 10);
    assert_eq!(&assigned[..4], supermarket_tiles.as_slice());
    assert_eq!(&assigned[4..], factory_tiles.as_slice());
    assert_eq!(state.sims[10].workplace, None);
}

fn bus_then_walk_plan(bus_from: Point, bus_to: Point, walk_to: Point, line_id: &str) -> RoutePlan {
    RoutePlan {
        estimated_seconds: 140.0,
        legs: vec![
            RouteLeg {
                mode: TransitMode::Bus,
                from: bus_from,
                to: bus_to,
                line_id: Some(line_id.to_string()),
                service_direction: Some(ServiceDirection::Loop),
                board_itinerary_index: Some(0),
                alight_itinerary_index: Some(0),
            },
            RouteLeg {
                mode: TransitMode::Walk,
                from: bus_to,
                to: walk_to,
                line_id: None,
                service_direction: None,
                board_itinerary_index: None,
                alight_itinerary_index: None,
            },
        ],
    }
}

fn road_line(engine: &mut GameEngine, y: i32, from_x: i32, to_x: i32) {
    for x in from_x..=to_x {
        engine.dispatch(GameIntent::LayRoad {
            point: (x, y).into(),
        });
    }
}

fn clear_roads(state: &mut GameSnapshot) {
    state.map.road_structures.clear();
    for tile in &mut state.map.tiles {
        tile.kind = "empty".to_string();
        tile.one_way = None;
        tile.road_connections.clear();
        tile.road_structure_id = None;
        tile.has_track = false;
    }
}

fn heading_between(from: Point, to: Point) -> Heading {
    match (to.x - from.x, to.y - from.y) {
        (0, -1) => Heading::North,
        (1, 0) => Heading::East,
        (0, 1) => Heading::South,
        (-1, 0) => Heading::West,
        delta => panic!("fixture points are not adjacent: {delta:?}"),
    }
}

fn opposite(heading: Heading) -> Heading {
    match heading {
        Heading::North => Heading::South,
        Heading::East => Heading::West,
        Heading::South => Heading::North,
        Heading::West => Heading::East,
    }
}

fn two_way_corridor(state: &mut GameSnapshot, points: &[Point]) {
    for &point in points {
        let tile = state.map.tile_mut(point).expect("fixture tile exists");
        tile.kind = "road".to_string();
    }
    for pair in points.windows(2) {
        let heading = heading_between(pair[0], pair[1]);
        state
            .map
            .tile_mut(pair[0])
            .expect("fixture tile exists")
            .road_connections
            .push(heading);
        state
            .map
            .tile_mut(pair[1])
            .expect("fixture tile exists")
            .road_connections
            .push(opposite(heading));
    }
}

fn commute_endpoint(id: &str, building_type: &str, point: Point) -> PlacedBuilding {
    PlacedBuilding {
        id: id.to_string(),
        building_type: building_type.to_string(),
        origin: point,
        rotation: 0,
        occupied_tiles: vec![point],
        placed_at: 0.0,
        transit_node_id: None,
    }
}

fn car_commute_fixture(sim_ids: &[&str]) -> (GameSnapshot, RoadTopology) {
    let home = Point { x: 2, y: 3 };
    let workplace = Point { x: 10, y: 3 };
    let mut state = create_initial_snapshot();
    clear_roads(&mut state);
    two_way_corridor(
        &mut state,
        &(3..=9).map(|x| Point { x, y: 3 }).collect::<Vec<_>>(),
    );
    state.buildings = vec![
        // A destination building keeps the fixture free of automatic Sandbox
        // move-ins; the commute lifecycle only needs stable building footprints.
        commute_endpoint("home", "supermarket", home),
        commute_endpoint("work", "supermarket", workplace),
    ];
    state.sims = sim_ids
        .iter()
        .map(|id| sim(id, home, Some(workplace)))
        .collect();
    let departure_minute = commute::departure_minute_for_sim(sim_ids[0], "standard", "outbound");
    state.time =
        f64::from(departure_minute) / f64::from(clock::MINUTES_PER_DAY) * clock::GAME_DAY_SECONDS;
    state.day = 0;
    state.clock_minutes = departure_minute;
    state.paused = false;
    let topology = RoadTopology::compile(&state.map).expect("fixture topology compiles");
    (state, topology)
}

fn bus_fractional_progress_fixture() -> (GameSnapshot, RoadTopology, f64) {
    let home = Point { x: 2, y: 3 };
    let workplace = Point { x: 10, y: 3 };
    let mut engine = GameEngine::new();
    road_line(&mut engine, 3, 3, 9);
    engine.dispatch(GameIntent::AddBusStop {
        point: (3, 2).into(),
    });
    engine.dispatch(GameIntent::AddBusStop {
        point: (9, 2).into(),
    });
    let route = engine.dispatch(GameIntent::CreateRoute {
        mode: TransitMode::Bus,
        pattern: ServicePattern::Loop,
        waypoint_ids: vec!["stop-001".to_string(), "stop-002".to_string()],
    });
    assert!(route.applied, "bus fixture route should apply: {route:?}");

    let mut state = route.snapshot;
    state.buildings = vec![
        commute_endpoint("home", "supermarket", home),
        commute_endpoint("work", "supermarket", workplace),
    ];
    state.sims = vec![sim("sim-001", home, Some(workplace))];
    let departure_minute = commute::departure_minute_for_sim("sim-001", "standard", "outbound");
    let departure_time =
        f64::from(departure_minute) / f64::from(clock::MINUTES_PER_DAY) * clock::GAME_DAY_SECONDS;
    state.time = departure_time - 0.25;
    state.day = 0;
    state.clock_minutes = clock::clock_minutes(state.time);
    state.paused = false;

    let bus_path = state.transit.routes[0].legs[0]
        .current_path
        .clone()
        .expect("bus route has a path");
    state.transit.vehicles[0].step_progress = 0.5;
    state.active_trips = (0..4)
        .map(|id| ActiveTrip {
            id: format!("seed-car-trip-{id:03}"),
            sim_id: format!("seed-car-sim-{id:03}"),
            purpose: TripPurpose::CommuteOutbound,
            origin: home,
            destination: workplace,
            position: home.into(),
            status: TripStatus::Driving,
            deadline: departure_time + 900.0,
            route_plan: None,
            current_leg_index: 0,
            patience_remaining: 240.0,
            private_car_trip: Some(PrivateCarTrip {
                path: bus_path.clone(),
                arrival_time: departure_time + 100.0,
            }),
        })
        .collect();

    let topology = RoadTopology::compile(&state.map).expect("fixture topology compiles");
    (state, topology, departure_time)
}

fn bus_arrival_order_fixture() -> (GameSnapshot, RoadTopology) {
    let mut engine = GameEngine::new();
    road_line(&mut engine, 3, 3, 9);
    engine.dispatch(GameIntent::AddBusStop {
        point: (3, 2).into(),
    });
    engine.dispatch(GameIntent::AddBusStop {
        point: (9, 2).into(),
    });
    let route = engine.dispatch(GameIntent::CreateRoute {
        mode: TransitMode::Bus,
        pattern: ServicePattern::Loop,
        waypoint_ids: vec!["stop-001".to_string(), "stop-002".to_string()],
    });
    assert!(route.applied, "bus fixture route should apply: {route:?}");

    let mut state = route.snapshot;
    state.paused = false;
    state.sims.clear();
    let bus_path = state.transit.routes[0].legs[0]
        .current_path
        .clone()
        .expect("bus route has a path");
    let make_car = |id: usize, arrival_time: f64| ActiveTrip {
        id: format!("arrival-car-trip-{id:03}"),
        sim_id: format!("arrival-car-sim-{id:03}"),
        purpose: TripPurpose::CommuteOutbound,
        origin: (2, 3).into(),
        destination: (10, 3).into(),
        position: (2, 3).into(),
        status: TripStatus::Driving,
        deadline: 900.0,
        route_plan: None,
        current_leg_index: 0,
        patience_remaining: 240.0,
        private_car_trip: Some(PrivateCarTrip {
            path: bus_path.clone(),
            arrival_time,
        }),
    };
    state.active_trips = (0..4)
        .map(|id| make_car(id, 100.0))
        .chain(std::iter::once(make_car(4, 1.25)))
        .collect();

    let topology = RoadTopology::compile(&state.map).expect("fixture topology compiles");
    (state, topology)
}

fn driving_trip_without_payload() -> ActiveTrip {
    ActiveTrip {
        id: "trip-day-0-trip-001".to_string(),
        sim_id: "sim-001".to_string(),
        purpose: TripPurpose::CommuteOutbound,
        origin: (2, 3).into(),
        destination: (10, 3).into(),
        position: (2, 3).into(),
        status: TripStatus::Driving,
        deadline: 900.0,
        route_plan: None,
        current_leg_index: 0,
        patience_remaining: 240.0,
        private_car_trip: None,
    }
}

fn tick_trips(state: &GameSnapshot, topology: &RoadTopology, delta_seconds: f64) -> GameSnapshot {
    trips::tick_trips(state, topology, delta_seconds)
}

fn tick_trips_with_objectives(
    state: &GameSnapshot,
    topology: &RoadTopology,
    delta_seconds: f64,
) -> GameSnapshot {
    trips::tick_trips_with_objectives(state, topology, delta_seconds)
}

#[test]
fn car_mode_choice_uses_driving_when_car_eta_is_strictly_faster_than_walk() {
    let (state, topology) = car_commute_fixture(&["sim-001"]);

    let next = tick_trips(&state, &topology, 0.0);
    let outbound = next
        .active_trips
        .first()
        .expect("outbound trip spawned at its due boundary");

    assert_eq!(outbound.status, TripStatus::Driving);
    assert!(outbound.private_car_trip.is_some());
    assert!(outbound.route_plan.is_none());
}

#[test]
fn car_mode_choice_keeps_walk_lifecycle_when_car_access_is_unavailable() {
    let (mut state, _topology) = car_commute_fixture(&["sim-001"]);
    clear_roads(&mut state);
    let topology = RoadTopology::compile(&state.map).expect("fixture topology compiles");

    let next = tick_trips(&state, &topology, 0.0);
    let outbound = next
        .active_trips
        .first()
        .expect("outbound trip spawned at its due boundary");

    assert_eq!(outbound.status, TripStatus::Idle);
    assert!(outbound.private_car_trip.is_none());

    let walking = tick_trips(&next, &topology, 1.0);
    assert_eq!(walking.active_trips[0].status, TripStatus::Walking);
}

#[test]
fn same_time_worker_sees_prior_selected_car_flow_in_stable_sim_order() {
    // Suffix 485 has the same standard-shift departure minute as suffix 001,
    // while retaining a deterministic later sim iteration slot.
    let (mut state, topology) = car_commute_fixture(&["sim-001", "sim-485"]);
    let home = Point { x: 2, y: 3 };
    let workplace = Point { x: 10, y: 3 };
    let free_flow = traffic::private_car_candidate(&state, &topology, home, workplace)
        .expect("car fixture has a free-flow candidate");
    let seed_arrival_time = state.time + free_flow.estimated_seconds;
    state.active_trips = (0..4)
        .map(|index| ActiveTrip {
            id: format!("seed-trip-{index}"),
            sim_id: format!("seed-sim-{index}"),
            purpose: TripPurpose::CommuteOutbound,
            origin: home,
            destination: workplace,
            position: home.into(),
            status: TripStatus::Driving,
            deadline: state.time + 900.0,
            route_plan: None,
            current_leg_index: 0,
            patience_remaining: 240.0,
            private_car_trip: Some(PrivateCarTrip {
                path: free_flow.path.clone(),
                arrival_time: seed_arrival_time,
            }),
        })
        .collect();

    let next = tick_trips(&state, &topology, 0.0);

    let first_worker = next
        .active_trips
        .iter()
        .find(|trip| trip.sim_id == "sim-001")
        .expect("first same-time worker spawned");
    let second_worker = next
        .active_trips
        .iter()
        .find(|trip| trip.sim_id == "sim-485")
        .expect("second same-time worker spawned");
    let first_arrival_time = first_worker
        .private_car_trip
        .as_ref()
        .expect("first worker chose car")
        .arrival_time;
    let second_arrival_time = second_worker
        .private_car_trip
        .as_ref()
        .expect("second worker chose car")
        .arrival_time;

    assert_eq!(first_worker.status, TripStatus::Driving);
    assert_eq!(second_worker.status, TripStatus::Driving);
    assert!(second_arrival_time > first_arrival_time);
    assert!(
        (first_arrival_time - state.time - free_flow.estimated_seconds * 1.25).abs() < 1e-9,
        "first worker should see seeded flow of four: arrival={first_arrival_time}, free_flow={}s",
        free_flow.estimated_seconds
    );
    assert!(
        (second_arrival_time - state.time - free_flow.estimated_seconds * 1.5).abs() < 1e-9,
        "second worker should see the first worker's selected flow: arrival={second_arrival_time}, free_flow={}s",
        free_flow.estimated_seconds
    );
}

#[test]
fn car_mode_choice_is_identical_for_coarse_and_fine_ticks() {
    let (state, topology) = car_commute_fixture(&["sim-001"]);
    let coarse = tick_trips(&state, &topology, 3.0);

    let mut fine = state.clone();
    for _ in 0..3 {
        fine = tick_trips(&fine, &topology, 1.0);
    }

    assert_eq!(coarse.time, fine.time);
    assert_eq!(coarse.active_trips, fine.active_trips);
    assert_eq!(
        caelum_core::traffic::active_car_flow(&coarse),
        caelum_core::traffic::active_car_flow(&fine)
    );
}

#[test]
fn fractional_bus_progress_rescales_only_remaining_time_at_car_departure() {
    let (state, topology, departure_time) = bus_fractional_progress_fixture();
    let departure_delta = departure_time - state.time;
    let total_delta = departure_delta + 0.4;

    let coarse = tick_trips(&state, &topology, total_delta);
    let at_departure = tick_trips(&state, &topology, departure_delta);
    assert_eq!(
        at_departure.transit.vehicles[0].step_progress, 0.7,
        "fractional progress stays in normalized coordinates at the flow boundary"
    );
    assert_eq!(traffic::road_flow_at(&at_departure, (3, 3).into()), 5);

    let split = tick_trips(&at_departure, &topology, total_delta - departure_delta);
    assert_eq!(coarse.transit.vehicles[0], split.transit.vehicles[0]);
    assert_eq!(
        coarse.transit.vehicles[0].itinerary_index, 0,
        "0.4s after departure is shorter than the rescaled 0.46875s remaining"
    );
    assert!(
        coarse.transit.vehicles[0].step_progress > 0.95,
        "progress={}",
        coarse.transit.vehicles[0].step_progress
    );
    assert!(coarse.transit.vehicles[0].step_progress < 1.0);
}

#[test]
fn arriving_car_contributes_to_bus_step_before_payload_is_cleared() {
    let (state, topology) = bus_arrival_order_fixture();
    let current_point = state.transit.routes[0].legs[0]
        .current_path
        .as_ref()
        .expect("bus route has a path")
        .road_steps()[0]
        .position;

    let at_arrival = tick_trips(&state, &topology, 1.25);
    let bus = &at_arrival.transit.vehicles[0];
    assert_eq!(bus.path_step_index, 0);
    assert!((bus.step_progress - 0.8).abs() < 1e-9);
    assert_eq!(traffic::road_flow_at(&at_arrival, current_point), 4);
    assert_eq!(at_arrival.metrics.completed_trips, 1);
    assert!(at_arrival
        .active_trips
        .iter()
        .all(|trip| trip.private_car_trip.is_some()));

    let next_stop_seconds =
        transit::seconds_until_next_vehicle_stop(&at_arrival, bus).expect("bus has a next stop");
    assert!((next_stop_seconds - 6.5).abs() < 1e-9);

    let coarse = tick_trips(&state, &topology, 1.5);
    let split = tick_trips(&at_arrival, &topology, 0.25);
    assert_eq!(coarse.transit.vehicles[0], split.transit.vehicles[0]);
    assert_eq!(coarse.active_trips, split.active_trips);
    assert_eq!(
        coarse.metrics.completed_trips,
        split.metrics.completed_trips
    );
}

#[test]
fn driving_trip_keeps_payload_and_flow_until_arrival_boundary() {
    let (state, topology) = car_commute_fixture(&["sim-001"]);
    let spawned = tick_trips(&state, &topology, 0.0);
    let arrival_time = spawned.active_trips[0]
        .private_car_trip
        .as_ref()
        .expect("car trip payload")
        .arrival_time;

    let before_arrival = tick_trips(&spawned, &topology, 1.0);
    let active = before_arrival
        .active_trips
        .first()
        .expect("car remains active before arrival");
    assert_eq!(active.status, TripStatus::Driving);
    assert!(active.private_car_trip.is_some());
    assert!(!caelum_core::traffic::active_car_flow(&before_arrival).is_empty());

    let arrived = tick_trips(&spawned, &topology, (arrival_time - spawned.time).max(0.0));
    assert!(arrived.active_trips.is_empty());
    assert_eq!(arrived.metrics.completed_trips, 1);
    assert!(caelum_core::traffic::active_car_flow(&arrived).is_empty());
}

#[test]
fn coarse_car_arrival_matches_ticks_split_at_arrival_boundary() {
    let (state, topology) = car_commute_fixture(&["sim-001"]);
    let coarse = tick_trips(&state, &topology, 12.0);

    let mut fine = state.clone();
    for _ in 0..12 {
        fine = tick_trips(&fine, &topology, 1.0);
    }

    assert_eq!(coarse.time, fine.time);
    assert_eq!(coarse.active_trips, fine.active_trips);
    assert_eq!(coarse.sims, fine.sims);
    assert_eq!(coarse.metrics.completed_trips, fine.metrics.completed_trips);
    assert_eq!(coarse.metrics.late_trips, fine.metrics.late_trips);
    assert_eq!(coarse.metrics.unserved_trips, fine.metrics.unserved_trips);
}

#[test]
fn missing_driving_payload_becomes_unserved_and_saveable() {
    let mut state = GameEngine::new().snapshot();
    state.sims = vec![sim("sim-001", (2, 3).into(), None)];
    state.active_trips = vec![driving_trip_without_payload()];

    let next = trips::advance_active_trips(&state, 0.0);
    assert!(next.active_trips.is_empty());
    assert_eq!(next.metrics.unserved_trips, 1);
    assert_eq!(
        next.metrics.trip_outcomes[0].outcome,
        TripOutcomeKind::Unserved
    );

    let engine = GameEngine::from_snapshot(next).expect("unserved result is persistence-valid");
    let saved = engine.snapshot_for_save();
    assert!(saved.active_trips.is_empty());
}

#[test]
fn walking_movement_scales_by_simulated_time() {
    let mut state = create_initial_snapshot();
    state.sims = vec![sim("sim-001", (2, 3).into(), Some((5, 3).into()))];
    state.active_trips = vec![trip(
        "trip-001",
        TripStatus::Idle,
        (2, 3).into(),
        (5, 3).into(),
    )];

    let next = trips::advance_active_trips(&state, 1.0);
    let advanced = &next.active_trips[0];

    assert_eq!(advanced.status, TripStatus::Walking);
    assert!((advanced.position.x - 2.05).abs() < 0.000_001);
    assert!((advanced.position.y - 3.0).abs() < 0.000_001);
    assert_eq!(next.metrics.completed_trips, 0);
}

#[test]
fn terminal_trips_are_pruned_without_double_counting() {
    for status in [TripStatus::Arrived, TripStatus::Late, TripStatus::Unserved] {
        let mut state = create_initial_snapshot();
        state.metrics.completed_trips = 11;
        state.metrics.late_trips = 3;
        state.metrics.unserved_trips = 5;
        let mut terminal = trip("trip-001", status, (4, 4).into(), (5, 4).into());
        terminal.route_plan = Some(walk_plan((4, 4).into(), (5, 4).into(), 20.0));
        terminal.patience_remaining = 123.0;
        state.active_trips = vec![terminal.clone()];

        let next = trips::advance_active_trips(&state, 20.0);

        assert!(next.active_trips.is_empty());
        assert_eq!(next.metrics.completed_trips, state.metrics.completed_trips);
        assert_eq!(next.metrics.late_trips, state.metrics.late_trips);
        assert_eq!(next.metrics.unserved_trips, state.metrics.unserved_trips);
    }
}

#[test]
fn riding_trips_stay_attached_to_vehicles_until_disembarked() {
    let mut state = create_initial_snapshot();
    let mut riding = trip(
        "trip-001",
        TripStatus::Riding,
        (7, 8).into(),
        (15, 8).into(),
    );
    riding.route_plan = Some(bus_plan((7, 8).into(), (15, 8).into(), "route-001"));
    riding.patience_remaining = 123.0;
    state.active_trips = vec![riding.clone()];
    state.transit.vehicles = vec![Vehicle {
        id: "vehicle-001".to_string(),
        mode: TransitMode::Bus,
        line_id: "route-001".to_string(),
        capacity: 18,
        passenger_ids: vec!["trip-001".to_string()],
        itinerary_index: 0,
        path_step_index: 0,
        step_progress: 0.5,
        parked_position: None,
    }];

    let next = trips::advance_active_trips(&state, 10.0);

    assert_eq!(next.active_trips[0], riding);
    assert_eq!(
        next.metrics.total_wait_seconds,
        state.metrics.total_wait_seconds
    );
}

#[test]
fn riding_trip_without_vehicle_replans_from_current_position() {
    let mut state = create_initial_snapshot();
    state.transit = TransitNetwork {
        stops: Vec::new(),
        stations: Vec::new(),
        routes: Vec::new(),
        metro_lines: Vec::new(),
        vehicles: Vec::new(),
    };
    let mut riding = trip(
        "trip-001",
        TripStatus::Riding,
        (15, 8).into(),
        (23, 8).into(),
    );
    riding.origin = Point { x: 2, y: 3 };
    riding.route_plan = Some(bus_plan((7, 8).into(), (15, 8).into(), "route-001"));
    state.active_trips = vec![riding];

    let next = trips::advance_active_trips(&state, 1.0);
    let recovered = &next.active_trips[0];

    assert_ne!(recovered.status, TripStatus::Riding);
    assert_eq!(
        recovered.route_plan.as_ref().unwrap().legs[0].from,
        Point { x: 15, y: 8 }
    );
}

#[test]
fn stale_plan_cannot_board_a_route_with_a_disconnected_leg() {
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
    let mut state = assigned.snapshot;
    state.transit.routes[0].path_broken = false;
    state.transit.routes[0].legs[0].status = RouteLegStatus::NetworkDisconnected;
    state.transit.routes[0].legs[0].current_path = None;
    let mut waiting = trip(
        "trip-001",
        TripStatus::Waiting,
        (2, 4).into(),
        (12, 4).into(),
    );
    waiting.route_plan = Some(bus_plan((2, 4).into(), (12, 4).into(), "route-001"));
    state.active_trips = vec![waiting];

    let next = transit::tick_vehicles(&state, 0.0);

    assert!(next.transit.vehicles[0].passenger_ids.is_empty());
    assert_eq!(next.active_trips[0].status, TripStatus::Waiting);
}

#[test]
fn fractional_idle_position_snaps_before_replanning() {
    let mut state = create_initial_snapshot();
    state.active_trips = vec![trip(
        "trip-001",
        TripStatus::Idle,
        TripPosition { x: 5.3, y: 8.0 },
        (23, 8).into(),
    )];

    let next = trips::advance_active_trips(&state, 1.0);
    let replanned = &next.active_trips[0];

    assert_ne!(replanned.status, TripStatus::Unserved);
    assert_eq!(
        replanned.route_plan.as_ref().unwrap().legs[0].from,
        Point { x: 5, y: 8 }
    );
}

#[test]
fn waiting_trips_lose_patience_and_update_wait_metrics() {
    let mut state = create_initial_snapshot();
    let mut waiting = trip(
        "trip-001",
        TripStatus::Waiting,
        (7, 8).into(),
        (22, 8).into(),
    );
    waiting.route_plan = Some(bus_plan((7, 8).into(), (22, 8).into(), "route-001"));
    waiting.patience_remaining = 1.0;
    state.active_trips = vec![waiting];

    let next = trips::advance_active_trips(&state, 2.0);

    assert!(next.active_trips.is_empty());
    assert_eq!(next.metrics.unserved_trips, 1);
    assert_eq!(next.metrics.total_wait_seconds, 1.0);
    assert_eq!(next.metrics.waiting_trip_count, 0);
    assert_eq!(next.metrics.average_wait_seconds, 0.0);
    assert_eq!(
        next.metrics.trip_outcomes,
        vec![TripOutcome {
            outcome: TripOutcomeKind::Unserved,
            wait_seconds: 240.0,
            time: 1.0,
        }]
    );
}

#[test]
fn short_walking_route_arrives_and_late_arrival_counts_late() {
    let mut on_time = create_initial_snapshot();
    on_time.time = 20.0;
    on_time.sims = vec![sim("sim-001", (2, 3).into(), Some((3, 3).into()))];
    on_time.active_trips = vec![trip(
        "trip-001",
        TripStatus::Idle,
        (2, 3).into(),
        (3, 3).into(),
    )];
    let arrived = trips::advance_active_trips(&on_time, 20.0);

    assert!(arrived.active_trips.is_empty());
    assert_eq!(arrived.metrics.completed_trips, 1);
    assert_eq!(arrived.metrics.late_trips, 0);
    assert_eq!(
        arrived.metrics.trip_outcomes,
        vec![TripOutcome {
            outcome: TripOutcomeKind::Arrived,
            wait_seconds: 0.0,
            time: 20.0,
        }]
    );
    assert_eq!(
        arrived
            .sims
            .iter()
            .find(|sim| sim.id == "sim-001")
            .unwrap()
            .position,
        Point { x: 3, y: 3 }
    );

    let mut late = create_initial_snapshot();
    late.time = 1.0;
    let mut terminal_leg = trip(
        "trip-002",
        TripStatus::Walking,
        (3, 3).into(),
        (3, 3).into(),
    );
    terminal_leg.deadline = 0.0;
    terminal_leg.route_plan = Some(bus_plan((7, 8).into(), (23, 8).into(), "route-001"));
    terminal_leg.current_leg_index = 1;
    late.active_trips = vec![terminal_leg];
    let late_next = trips::advance_active_trips(&late, 1.0);

    assert!(late_next.active_trips.is_empty());
    assert_eq!(late_next.metrics.completed_trips, 1);
    assert_eq!(late_next.metrics.late_trips, 1);
    assert_eq!(
        late_next.metrics.trip_outcomes,
        vec![TripOutcome {
            outcome: TripOutcomeKind::Late,
            wait_seconds: 0.0,
            time: 1.0,
        }]
    );
}

#[test]
fn empty_route_plan_not_at_destination_is_unserved_not_phantom_arrival() {
    // Defensive guard (trips.rs): a trip whose plan has no remaining leg must only count as
    // arrived when it is actually at its destination. An empty plan with the sim still
    // mid-route is a routing regression and must surface as unserved, never a phantom
    // completion.
    let mut state = create_initial_snapshot();
    state.time = 1.0;
    let mut stranded = trip(
        "trip-001",
        TripStatus::Walking,
        TripPosition { x: 5.0, y: 8.0 },
        (23, 8).into(),
    );
    stranded.deadline = 1_000.0;
    stranded.route_plan = Some(RoutePlan {
        legs: Vec::new(),
        estimated_seconds: 0.0,
    });
    stranded.current_leg_index = 0;
    state.active_trips = vec![stranded];

    let next = trips::advance_active_trips(&state, 1.0);

    assert!(next.active_trips.is_empty());
    assert_eq!(next.metrics.completed_trips, 0);
    assert_eq!(next.metrics.unserved_trips, 1);
    assert_eq!(
        next.metrics.trip_outcomes[0].outcome,
        TripOutcomeKind::Unserved
    );
}

#[test]
fn no_route_planning_marks_trip_unserved() {
    let mut state = create_initial_snapshot();
    state.active_trips = vec![trip(
        "trip-001",
        TripStatus::Idle,
        (2, 3).into(),
        (28, 17).into(),
    )];

    let next = trips::advance_active_trips(&state, 1.0);

    assert!(next.active_trips.is_empty());
    assert_eq!(next.metrics.unserved_trips, 1);
    assert_eq!(
        next.metrics.trip_outcomes,
        vec![TripOutcome {
            outcome: TripOutcomeKind::Unserved,
            wait_seconds: 0.0,
            time: 0.0,
        }]
    );
}

#[test]
fn waiting_timeout_outcome_uses_exact_time_under_large_tick() {
    let mut state = create_initial_snapshot();
    state.time = 100.0;
    state.day = clock::day_index(state.time);
    state.clock_minutes = clock::clock_minutes(state.time);
    state.paused = false;
    let mut waiting = trip(
        "trip-001",
        TripStatus::Waiting,
        (7, 8).into(),
        (22, 8).into(),
    );
    waiting.route_plan = Some(bus_plan((7, 8).into(), (22, 8).into(), "route-001"));
    waiting.patience_remaining = 5.0;
    state.active_trips = vec![waiting];

    let topology = RoadTopology::compile(&state.map).expect("fixture topology compiles");
    let next = tick_trips(&state, &topology, 100.0);

    assert!(next.active_trips.is_empty());
    assert_eq!(next.metrics.unserved_trips, 1);
    assert_eq!(next.metrics.total_wait_seconds, 5.0);
    assert_eq!(next.metrics.trip_outcomes.len(), 1);
    assert_eq!(
        next.metrics.trip_outcomes[0].outcome,
        TripOutcomeKind::Unserved
    );
    assert_eq!(next.metrics.trip_outcomes[0].wait_seconds, 240.0);
    assert!((next.metrics.trip_outcomes[0].time - 105.0).abs() < 0.000_001);
}

#[test]
fn stale_history_pruning_keeps_history_signal_for_empty_window() {
    let mut state = create_initial_snapshot();
    state.time = 1_000.0;
    state.metrics.unserved_trips = 10;
    state.metrics.trip_outcomes = (0..10)
        .map(|index| TripOutcome {
            outcome: TripOutcomeKind::Unserved,
            wait_seconds: 0.0,
            time: 100.0 + f64::from(index),
        })
        .collect();

    let next = trips::advance_active_trips(&state, 0.0);

    assert_eq!(next.metrics.trip_outcomes.len(), 1);
    assert_eq!(next.metrics.trip_outcomes[0].time, 109.0);
    assert_eq!(
        objectives::evaluate_objectives(&next).metrics.state,
        MetricsState::Running
    );
}

#[test]
fn riding_arrival_outcome_uses_vehicle_stop_boundary_time() {
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
    let vehicle = engine.dispatch(GameIntent::AssignVehicle {
        mode: "bus".to_string(),
        line_id: "route-001".to_string(),
    });

    let mut state = vehicle.snapshot;
    state.paused = false;
    state.active_trips = vec![ActiveTrip {
        id: "trip-001".to_string(),
        sim_id: "sim-001".to_string(),
        purpose: TripPurpose::CommuteOutbound,
        origin: (2, 4).into(),
        destination: (12, 4).into(),
        position: (2, 4).into(),
        status: TripStatus::Riding,
        deadline: 100.0,
        route_plan: Some(bus_plan((2, 4).into(), (12, 4).into(), "route-001")),
        current_leg_index: 0,
        patience_remaining: 240.0,
        private_car_trip: None,
    }];
    state.transit.vehicles[0].passenger_ids = vec!["trip-001".to_string()];

    let topology = RoadTopology::compile(&state.map).expect("fixture topology compiles");
    let coarse = tick_trips(&state, &topology, 12.5);
    let mut next = state;
    for _ in 0..10 {
        next = tick_trips(&next, &topology, 1.25);
    }

    assert!(next.active_trips.is_empty());
    assert_eq!(next.metrics.completed_trips, 1);
    assert_eq!(next.metrics.trip_outcomes.len(), 1);
    assert_eq!(
        next.metrics.trip_outcomes[0].outcome,
        TripOutcomeKind::Arrived
    );
    assert!((next.metrics.trip_outcomes[0].time - 12.5).abs() < 0.000_001);

    // Coarse-tick equivalence: one 12.5s tick must match ten 1.25s ticks.
    assert!(coarse.active_trips.is_empty());
    assert_eq!(coarse.metrics.completed_trips, next.metrics.completed_trips);
    assert_eq!(
        coarse.metrics.trip_outcomes.len(),
        next.metrics.trip_outcomes.len()
    );
    assert_eq!(
        coarse.metrics.trip_outcomes[0].outcome,
        next.metrics.trip_outcomes[0].outcome
    );
    assert!(
        (coarse.metrics.trip_outcomes[0].time - next.metrics.trip_outcomes[0].time).abs()
            < 0.000_001
    );
}

#[test]
fn just_disembarked_trip_does_not_consume_ride_time_as_walking_time() {
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
    let vehicle = engine.dispatch(GameIntent::AssignVehicle {
        mode: "bus".to_string(),
        line_id: "route-001".to_string(),
    });

    let mut state = vehicle.snapshot;
    state.paused = false;
    state.active_trips = vec![ActiveTrip {
        id: "trip-001".to_string(),
        sim_id: "sim-001".to_string(),
        purpose: TripPurpose::CommuteOutbound,
        origin: (2, 4).into(),
        destination: (13, 4).into(),
        position: (2, 4).into(),
        status: TripStatus::Riding,
        deadline: 100.0,
        route_plan: Some(bus_then_walk_plan(
            (2, 4).into(),
            (12, 4).into(),
            (13, 4).into(),
            "route-001",
        )),
        current_leg_index: 0,
        patience_remaining: 240.0,
        private_car_trip: None,
    }];
    state.transit.vehicles[0].passenger_ids = vec!["trip-001".to_string()];

    let topology = RoadTopology::compile(&state.map).expect("fixture topology compiles");
    let coarse_disembarked = tick_trips(&state, &topology, 12.5);
    let mut disembarked = state;
    for _ in 0..10 {
        disembarked = tick_trips(&disembarked, &topology, 1.25);
    }
    let walking = &disembarked.active_trips[0];

    assert_eq!(walking.status, TripStatus::Walking);
    assert_eq!(walking.current_leg_index, 1);
    assert_eq!(walking.position, (12, 4).into());
    assert_eq!(disembarked.metrics.completed_trips, 0);
    assert!(disembarked.metrics.trip_outcomes.is_empty());

    // Coarse-tick equivalence: one 12.5s tick must match ten 1.25s ticks.
    assert_eq!(
        coarse_disembarked.active_trips.len(),
        disembarked.active_trips.len()
    );
    assert_eq!(
        coarse_disembarked.metrics.completed_trips,
        disembarked.metrics.completed_trips
    );

    let arrived = tick_trips(&disembarked, &topology, 20.0);

    assert!(arrived.active_trips.is_empty());
    assert_eq!(arrived.metrics.completed_trips, 1);
    assert_eq!(arrived.metrics.trip_outcomes.len(), 1);
    assert_eq!(
        arrived.metrics.trip_outcomes[0].outcome,
        TripOutcomeKind::Arrived
    );
    assert!((arrived.metrics.trip_outcomes[0].time - 32.5).abs() < 0.000_001);
}

#[test]
fn waiting_trip_that_boards_and_disembarks_does_not_advance_the_following_walk() {
    // Even when a tick ends exactly at the final ride-step boundary, the
    // following walk leg must begin at the alighting stop with zero elapsed
    // walking time.
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
    let vehicle = engine.dispatch(GameIntent::AssignVehicle {
        mode: "bus".to_string(),
        line_id: "route-001".to_string(),
    });

    let mut state = vehicle.snapshot;
    state.paused = false;
    state.active_trips = vec![ActiveTrip {
        id: "trip-001".to_string(),
        sim_id: "sim-001".to_string(),
        purpose: TripPurpose::CommuteOutbound,
        origin: (2, 4).into(),
        destination: (13, 4).into(),
        position: (2, 4).into(),
        status: TripStatus::Waiting,
        deadline: 100.0,
        route_plan: Some(bus_then_walk_plan(
            (2, 4).into(),
            (12, 4).into(),
            (13, 4).into(),
            "route-001",
        )),
        current_leg_index: 0,
        patience_remaining: 240.0,
        private_car_trip: None,
    }];
    // Vehicle starts at the boarding stop with a free seat.
    assert_eq!(state.transit.vehicles[0].step_progress, 0.0);
    assert!(state.transit.vehicles[0].passenger_ids.is_empty());

    let topology = RoadTopology::compile(&state.map).expect("fixture topology compiles");
    let coarse_disembarked = tick_trips(&state, &topology, 12.5);
    let mut disembarked = state;
    for _ in 0..10 {
        disembarked = tick_trips(&disembarked, &topology, 1.25);
    }
    let walking = &disembarked.active_trips[0];

    assert_eq!(walking.status, TripStatus::Walking);
    assert_eq!(walking.current_leg_index, 1);
    assert_eq!(walking.position, (12, 4).into());
    assert_eq!(disembarked.metrics.completed_trips, 0);
    assert!(disembarked.metrics.trip_outcomes.is_empty());

    // Coarse-tick equivalence: one 12.5s tick must match ten 1.25s ticks.
    assert_eq!(
        coarse_disembarked.active_trips.len(),
        disembarked.active_trips.len()
    );
    assert_eq!(
        coarse_disembarked.metrics.completed_trips,
        disembarked.metrics.completed_trips
    );

    let arrived = tick_trips(&disembarked, &topology, 20.0);

    assert!(arrived.active_trips.is_empty());
    assert_eq!(arrived.metrics.completed_trips, 1);
    assert_eq!(arrived.metrics.trip_outcomes.len(), 1);
    assert_eq!(
        arrived.metrics.trip_outcomes[0].outcome,
        TripOutcomeKind::Arrived
    );
    assert!((arrived.metrics.trip_outcomes[0].time - 32.5).abs() < 0.000_001);
}

#[test]
fn large_tick_consumes_all_duration_until_the_next_stop() {
    let mut engine = GameEngine::new();
    road_line(&mut engine, 5, 2, 5);
    engine.dispatch(GameIntent::AddBusStop {
        point: (2, 4).into(),
    });
    engine.dispatch(GameIntent::AddBusStop {
        point: (5, 4).into(),
    });
    engine.dispatch(GameIntent::CreateRoute {
        mode: TransitMode::Bus,
        pattern: ServicePattern::Loop,
        waypoint_ids: vec!["stop-001".to_string(), "stop-002".to_string()],
    });
    let vehicle = engine.dispatch(GameIntent::AssignVehicle {
        mode: "bus".to_string(),
        line_id: "route-001".to_string(),
    });

    let mut state = vehicle.snapshot;
    state.paused = false;
    state.transit.vehicles[0].step_progress = 0.2;
    state.active_trips = vec![ActiveTrip {
        id: "trip-001".to_string(),
        sim_id: "sim-001".to_string(),
        purpose: TripPurpose::CommuteOutbound,
        origin: (2, 4).into(),
        destination: (5, 4).into(),
        position: (2, 4).into(),
        status: TripStatus::Riding,
        deadline: 100.0,
        route_plan: Some(bus_plan((2, 4).into(), (5, 4).into(), "route-001")),
        current_leg_index: 0,
        patience_remaining: 240.0,
        private_car_trip: None,
    }];
    state.transit.vehicles[0].passenger_ids = vec!["trip-001".to_string()];

    let seconds = transit::seconds_until_next_vehicle_stop(&state, &state.transit.vehicles[0])
        .expect("vehicle has a next stop");
    let topology = RoadTopology::compile(&state.map).expect("fixture topology compiles");
    let next = tick_trips(&state, &topology, seconds);

    assert_eq!(next.transit.vehicles[0].itinerary_index, 1);
    assert_eq!(next.transit.vehicles[0].path_step_index, 0);
    assert_eq!(next.transit.vehicles[0].step_progress, 0.0);
    assert!(next.active_trips.is_empty());
    assert_eq!(next.metrics.completed_trips, 1);
}

#[test]
fn cursor_resets_progress_at_path_step_boundary() {
    let mut engine = GameEngine::new();
    road_line(&mut engine, 5, 2, 7);
    engine.dispatch(GameIntent::AddBusStop {
        point: (2, 4).into(),
    });
    engine.dispatch(GameIntent::AddBusStop {
        point: (7, 4).into(),
    });
    engine.dispatch(GameIntent::CreateRoute {
        mode: TransitMode::Bus,
        pattern: ServicePattern::Loop,
        waypoint_ids: vec!["stop-001".to_string(), "stop-002".to_string()],
    });
    let vehicle = engine.dispatch(GameIntent::AssignVehicle {
        mode: "bus".to_string(),
        line_id: "route-001".to_string(),
    });

    let mut state = vehicle.snapshot;
    state.paused = false;
    state.transit.vehicles[0].step_progress = 0.6;
    state.active_trips = vec![ActiveTrip {
        id: "trip-001".to_string(),
        sim_id: "sim-001".to_string(),
        purpose: TripPurpose::CommuteOutbound,
        origin: (2, 4).into(),
        destination: (7, 4).into(),
        position: (2, 4).into(),
        status: TripStatus::Riding,
        deadline: 100.0,
        route_plan: Some(bus_plan((2, 4).into(), (7, 4).into(), "route-001")),
        current_leg_index: 0,
        patience_remaining: 240.0,
        private_car_trip: None,
    }];
    state.transit.vehicles[0].passenger_ids = vec!["trip-001".to_string()];

    let next = transit::tick_vehicles(&state, 0.5);

    assert_eq!(next.transit.vehicles[0].path_step_index, 1);
    assert_eq!(next.transit.vehicles[0].step_progress, 0.0);
    assert_eq!(next.active_trips[0].status, TripStatus::Riding);
}

#[test]
fn previous_day_outbound_arriving_after_midnight_does_not_unlock_current_day_return() {
    let mut state = create_initial_snapshot();
    let home = Point { x: 2, y: 3 };
    let workplace = Point { x: 8, y: 3 };
    state.time = clock::GAME_DAY_SECONDS + 1.0;
    state.day = 1;
    state.clock_minutes = clock::clock_minutes(state.time);
    state.paused = false;
    state.sims = vec![Sim {
        id: "sim-001".to_string(),
        home,
        position: home,
        worker_profile: WorkerProfile::Worker,
        shift_template: Some("standard".to_string()),
        workplace: Some(workplace),
        commute_day: 1,
        outbound_resolved_today: false,
        outbound_arrived_today: false,
        return_resolved_today: false,
        returned_home_today: false,
    }];
    state.active_trips = vec![ActiveTrip {
        id: "trip-day-0-trip-001".to_string(),
        sim_id: "sim-001".to_string(),
        purpose: TripPurpose::CommuteOutbound,
        origin: home,
        destination: workplace,
        position: workplace.into(),
        status: TripStatus::Walking,
        deadline: 2_000.0,
        route_plan: Some(walk_plan(workplace, workplace, 0.0)),
        current_leg_index: 0,
        patience_remaining: 240.0,
        private_car_trip: None,
    }];

    let arrived = trips::advance_active_trips(&state, 0.0);
    let sim = arrived.sims.iter().find(|sim| sim.id == "sim-001").unwrap();
    assert!(arrived.active_trips.is_empty());
    assert_eq!(sim.position, workplace);
    assert!(!sim.outbound_resolved_today);
    assert!(!sim.outbound_arrived_today);

    let return_minute = commute::departure_minute_for_sim("sim-001", "standard", "return");
    let return_time = clock::GAME_DAY_SECONDS
        + (f64::from(return_minute) / f64::from(clock::MINUTES_PER_DAY)) * clock::GAME_DAY_SECONDS;
    let mut after_return_window = arrived.clone();
    after_return_window.time = return_time;
    after_return_window.day = 1;
    after_return_window.clock_minutes = return_minute;
    after_return_window.paused = false;

    let topology =
        RoadTopology::compile(&after_return_window.map).expect("fixture topology compiles");
    let ticked = tick_trips(&after_return_window, &topology, 0.0);

    assert!(!ticked
        .active_trips
        .iter()
        .any(|trip| trip.sim_id == "sim-001" && trip.purpose == TripPurpose::CommuteReturn));
}

#[test]
fn completed_same_day_return_is_not_respawned_after_pruning() {
    let mut state = create_initial_snapshot();
    let return_minute = commute::departure_minute_for_sim("sim-001", "standard", "return");
    let return_time =
        (f64::from(return_minute) / f64::from(clock::MINUTES_PER_DAY)) * clock::GAME_DAY_SECONDS;
    state.time = return_time;
    state.day = 0;
    state.clock_minutes = return_minute;
    state.paused = false;
    state.sims = vec![Sim {
        id: "sim-001".to_string(),
        home: (2, 3).into(),
        position: (3, 3).into(),
        worker_profile: WorkerProfile::Worker,
        shift_template: Some("standard".to_string()),
        workplace: Some((3, 3).into()),
        commute_day: 0,
        outbound_resolved_today: true,
        outbound_arrived_today: true,
        return_resolved_today: false,
        returned_home_today: false,
    }];

    let topology = RoadTopology::compile(&state.map).expect("fixture topology compiles");
    let arrived = tick_trips(&state, &topology, 20.0);
    let sim = arrived.sims.iter().find(|sim| sim.id == "sim-001").unwrap();

    assert!(arrived.active_trips.is_empty());
    assert_eq!(arrived.metrics.completed_trips, 1);
    assert_eq!(sim.position, Point { x: 2, y: 3 });
    assert!(sim.return_resolved_today);
    assert!(sim.returned_home_today);

    let ticked_again = tick_trips(&arrived, &topology, 0.0);

    assert!(ticked_again.active_trips.is_empty());
    assert_eq!(ticked_again.metrics.completed_trips, 1);
}

#[test]
fn unserved_same_day_outbound_is_not_respawned_after_pruning() {
    let mut state = create_initial_snapshot();
    let departure_minute = commute::departure_minute_for_sim("sim-001", "standard", "outbound");
    let departure_time =
        (f64::from(departure_minute) / f64::from(clock::MINUTES_PER_DAY)) * clock::GAME_DAY_SECONDS;
    let home = Point { x: 2, y: 3 };
    let workplace = Point { x: 28, y: 17 };
    state.time = departure_time;
    state.day = 0;
    state.clock_minutes = departure_minute;
    state.paused = false;
    state.buildings = vec![destination_building(workplace)];
    state.sims = vec![sim("sim-001", home, Some(workplace))];
    state.active_trips = vec![ActiveTrip {
        id: "trip-day-0-trip-001".to_string(),
        sim_id: "sim-001".to_string(),
        purpose: TripPurpose::CommuteOutbound,
        origin: home,
        destination: workplace,
        position: Point { x: 7, y: 8 }.into(),
        status: TripStatus::Waiting,
        deadline: departure_time + 900.0,
        route_plan: Some(bus_plan(
            Point { x: 7, y: 8 },
            Point { x: 22, y: 8 },
            "route-001",
        )),
        current_leg_index: 0,
        patience_remaining: 1.0,
        private_car_trip: None,
    }];

    let topology = RoadTopology::compile(&state.map).expect("fixture topology compiles");
    let next = tick_trips(&state, &topology, 2.0);
    let sim = next.sims.iter().find(|sim| sim.id == "sim-001").unwrap();

    assert!(next.active_trips.is_empty());
    assert_eq!(next.metrics.unserved_trips, 1);
    assert_eq!(next.metrics.trip_outcomes.len(), 1);
    assert!(sim.outbound_resolved_today);
    assert!(!sim.outbound_arrived_today);
}

#[test]
fn unserved_same_day_return_is_not_respawned_after_pruning() {
    let mut state = create_initial_snapshot();
    let return_minute = commute::departure_minute_for_sim("sim-001", "standard", "return");
    let return_time =
        (f64::from(return_minute) / f64::from(clock::MINUTES_PER_DAY)) * clock::GAME_DAY_SECONDS;
    let home = Point { x: 2, y: 3 };
    let workplace = Point { x: 28, y: 17 };
    state.time = return_time;
    state.day = 0;
    state.clock_minutes = return_minute;
    state.paused = false;
    state.sims = vec![Sim {
        id: "sim-001".to_string(),
        home,
        position: workplace,
        worker_profile: WorkerProfile::Worker,
        shift_template: Some("standard".to_string()),
        workplace: Some(workplace),
        commute_day: 0,
        outbound_resolved_today: true,
        outbound_arrived_today: true,
        return_resolved_today: false,
        returned_home_today: false,
    }];
    state.active_trips = vec![ActiveTrip {
        id: "trip-day-0-trip-001".to_string(),
        sim_id: "sim-001".to_string(),
        purpose: TripPurpose::CommuteReturn,
        origin: workplace,
        destination: home,
        position: workplace.into(),
        status: TripStatus::Waiting,
        deadline: return_time + 900.0,
        route_plan: Some(bus_plan(workplace, Point { x: 7, y: 8 }, "route-001")),
        current_leg_index: 0,
        patience_remaining: 1.0,
        private_car_trip: None,
    }];

    let topology = RoadTopology::compile(&state.map).expect("fixture topology compiles");
    let next = tick_trips(&state, &topology, 2.0);
    let sim = next.sims.iter().find(|sim| sim.id == "sim-001").unwrap();

    assert!(next.active_trips.is_empty());
    assert_eq!(next.metrics.unserved_trips, 1);
    assert_eq!(next.metrics.trip_outcomes.len(), 1);
    assert!(sim.return_resolved_today);
    assert!(!sim.returned_home_today);
}

#[test]
fn stranded_sim_at_workplace_does_not_spawn_phantom_outbound_next_day() {
    // Regression: when a previous day's return trip was unserved, the sim is
    // stranded at the workplace. The midnight reset clears the daily commute
    // flags, so at the next day's outbound departure the spawn condition still
    // passes (valid workplace, flags cleared). `build_trip` then uses
    // `sim.position` (the workplace) as the trip position while the destination
    // is that same workplace, producing a zero-distance phantom outbound that
    // `tick_trip` immediately scores as arrived — inflating `completed_trips`
    // and masking the stranded state. The outbound spawn must be gated on the
    // sim actually being at home.
    let mut state = create_initial_snapshot();
    let departure_minute = commute::departure_minute_for_sim("sim-001", "standard", "outbound");
    let day1_departure = clock::GAME_DAY_SECONDS
        + (f64::from(departure_minute) / f64::from(clock::MINUTES_PER_DAY))
            * clock::GAME_DAY_SECONDS;
    let home = Point { x: 2, y: 3 };
    let workplace = Point { x: 8, y: 3 };
    state.time = day1_departure;
    state.day = 1;
    state.clock_minutes = departure_minute;
    state.paused = false;
    state.buildings = vec![destination_building(workplace)];
    // Sim stranded at the workplace after day-0 return was unserved. Day-0
    // flags are set as they would be after the unserved return resolved;
    // `commute_day` is still 0 so the day-1 reset clears them.
    state.sims = vec![Sim {
        id: "sim-001".to_string(),
        home,
        position: workplace,
        worker_profile: WorkerProfile::Worker,
        shift_template: Some("standard".to_string()),
        workplace: Some(workplace),
        commute_day: 0,
        outbound_resolved_today: true,
        outbound_arrived_today: true,
        return_resolved_today: true,
        returned_home_today: false,
    }];
    state.active_trips = Vec::new();

    let topology = RoadTopology::compile(&state.map).expect("fixture topology compiles");
    let next = tick_trips(&state, &topology, 1.0);
    let sim = next.sims.iter().find(|sim| sim.id == "sim-001").unwrap();

    assert!(
        !next
            .active_trips
            .iter()
            .any(|trip| trip.sim_id == "sim-001" && trip.purpose == TripPurpose::CommuteOutbound),
        "stranded sim should not spawn a phantom outbound from the workplace"
    );
    assert_eq!(
        next.metrics.completed_trips, 0,
        "phantom outbound must not be counted as a completed trip"
    );
    assert_eq!(next.metrics.unserved_trips, 0);
    // The sim is already at work, so the outbound is resolved and the return
    // trip is unlocked to bring them home.
    assert!(sim.outbound_resolved_today);
    assert!(sim.outbound_arrived_today);
    assert_eq!(sim.position, workplace);
}

#[test]
fn return_trip_in_progress_across_midnight_does_not_trigger_stranded_guard() {
    // Regression: when a return trip from the previous day is still in
    // progress at the midnight rollover, `sim.position` is still the workplace
    // (position is only updated on trip arrival). The stranded-sim guard at
    // the outbound spawn must NOT fire — the sim is in transit, not stranded.
    // If it did, it would set `outbound_resolved_today` and
    // `outbound_arrived_today`, unlocking the return spawn. Once the
    // in-progress return arrives home (setting `sim.position = home` but, due
    // to the day mismatch in `apply_arrival_to_sim`, NOT setting
    // `returned_home_today`/`return_resolved_today`), the current day's return
    // departure would spawn a home→home phantom return trip and count a
    // phantom completion.
    let mut state = create_initial_snapshot();
    let home = Point { x: 2, y: 3 };
    let workplace = Point { x: 8, y: 3 };
    state.time = clock::GAME_DAY_SECONDS + 1.0;
    state.day = 1;
    state.clock_minutes = clock::clock_minutes(state.time);
    state.paused = false;
    state.buildings = vec![destination_building(workplace)];
    // Day-0 flags are set as they would be after the outbound completed and the
    // return spawned; `commute_day` is still 0 so the day-1 reset clears them.
    state.sims = vec![Sim {
        id: "sim-001".to_string(),
        home,
        position: workplace,
        worker_profile: WorkerProfile::Worker,
        shift_template: Some("standard".to_string()),
        workplace: Some(workplace),
        commute_day: 0,
        outbound_resolved_today: true,
        outbound_arrived_today: true,
        return_resolved_today: false,
        returned_home_today: false,
    }];
    // Active return trip from day 0, walking home, 1 tile away from arrival.
    state.active_trips = vec![ActiveTrip {
        id: "trip-day-0-trip-001".to_string(),
        sim_id: "sim-001".to_string(),
        purpose: TripPurpose::CommuteReturn,
        origin: workplace,
        destination: home,
        position: Point { x: 3, y: 3 }.into(),
        status: TripStatus::Walking,
        deadline: 2_000.0,
        route_plan: Some(walk_plan(Point { x: 3, y: 3 }, home, 20.0)),
        current_leg_index: 0,
        patience_remaining: 240.0,
        private_car_trip: None,
    }];

    let topology = RoadTopology::compile(&state.map).expect("fixture topology compiles");
    let next = tick_trips(&state, &topology, 1.0);
    let sim = next.sims.iter().find(|sim| sim.id == "sim-001").unwrap();

    // The stranded guard must not fire while a return trip is in progress.
    assert!(
        !sim.outbound_resolved_today,
        "stranded guard must not resolve outbound while a return trip is in progress"
    );
    assert!(
        !sim.outbound_arrived_today,
        "stranded guard must not mark outbound arrived while a return trip is in progress"
    );
    // No phantom outbound should spawn.
    assert!(
        !next
            .active_trips
            .iter()
            .any(|trip| trip.sim_id == "sim-001" && trip.purpose == TripPurpose::CommuteOutbound),
        "no outbound should spawn while a return trip is in progress"
    );
    // The return trip should still be active.
    assert!(
        next.active_trips
            .iter()
            .any(|trip| trip.sim_id == "sim-001" && trip.purpose == TripPurpose::CommuteReturn),
        "the in-progress return trip should still be active"
    );
}

#[test]
fn return_trip_crossing_midnight_does_not_spawn_phantom_home_to_home_return() {
    // Full-scenario regression: a return trip from day 0 that crosses midnight
    // must not cause a phantom home→home return trip on day 1. The stranded
    // guard must skip the sim (it is in transit), the return trip arrives home
    // normally, and the day-1 commute proceeds as a legitimate
    // outbound-then-return cycle — not a phantom home→home return.
    let mut state = create_initial_snapshot();
    let home = Point { x: 2, y: 3 };
    let workplace = Point { x: 8, y: 3 };
    state.time = clock::GAME_DAY_SECONDS + 1.0;
    state.day = 1;
    state.clock_minutes = clock::clock_minutes(state.time);
    state.paused = false;
    state.buildings = vec![destination_building(workplace)];
    state.sims = vec![Sim {
        id: "sim-001".to_string(),
        home,
        position: workplace,
        worker_profile: WorkerProfile::Worker,
        shift_template: Some("standard".to_string()),
        workplace: Some(workplace),
        commute_day: 0,
        outbound_resolved_today: true,
        outbound_arrived_today: true,
        return_resolved_today: false,
        returned_home_today: false,
    }];
    // Active return trip from day 0, walking home, 1 tile away from arrival.
    state.active_trips = vec![ActiveTrip {
        id: "trip-day-0-trip-001".to_string(),
        sim_id: "sim-001".to_string(),
        purpose: TripPurpose::CommuteReturn,
        origin: workplace,
        destination: home,
        position: Point { x: 3, y: 3 }.into(),
        status: TripStatus::Walking,
        deadline: 2_000.0,
        route_plan: Some(walk_plan(Point { x: 3, y: 3 }, home, 20.0)),
        current_leg_index: 0,
        patience_remaining: 240.0,
        private_car_trip: None,
    }];

    // Drive the tick to just past the day-1 return departure so the return
    // trip has spawned but has not yet completed (1s of a 120s walk).
    let return_minute = commute::departure_minute_for_sim("sim-001", "standard", "return");
    let day1_return_time = clock::GAME_DAY_SECONDS
        + (f64::from(return_minute) / f64::from(clock::MINUTES_PER_DAY)) * clock::GAME_DAY_SECONDS;
    let topology = RoadTopology::compile(&state.map).expect("fixture topology compiles");
    let next = tick_trips(&state, &topology, day1_return_time - state.time + 1.0);

    let sim = next.sims.iter().find(|sim| sim.id == "sim-001").unwrap();

    // The day-1 outbound should have spawned and arrived (the sim was at home
    // after the cross-midnight return arrived, before the outbound departure).
    // Without the fix, the stranded guard suppresses the outbound, leaving
    // `outbound_arrived_today` set only by the guard itself — but no actual
    // outbound trip runs, so the sim never reaches the workplace and the
    // return spawns from home instead.
    assert!(
        sim.outbound_arrived_today,
        "day-1 outbound should have arrived after the cross-midnight return brought the sim home"
    );

    // A legitimate day-1 return originates at the workplace (after the
    // outbound arrives) and is still in progress. A phantom home→home return
    // would have completed instantly and set `return_resolved_today`.
    assert!(
        !sim.return_resolved_today,
        "day-1 return should still be in progress, not resolved by a phantom home→home completion"
    );
    let active_return = next
        .active_trips
        .iter()
        .find(|trip| trip.sim_id == "sim-001" && trip.purpose == TripPurpose::CommuteReturn);
    let active_return =
        active_return.expect("a day-1 return trip should be active and in progress");
    assert_eq!(
        active_return.origin, workplace,
        "day-1 return should originate from the workplace, not home (phantom)"
    );
}

#[test]
fn spawned_return_uses_monotonic_trip_sequence_after_pruning() {
    let mut state = create_initial_snapshot();
    let return_minute = commute::departure_minute_for_sim("sim-001", "standard", "return");
    let return_time =
        (f64::from(return_minute) / f64::from(clock::MINUTES_PER_DAY)) * clock::GAME_DAY_SECONDS;
    state.time = return_time;
    state.day = 0;
    state.clock_minutes = return_minute;
    state.paused = false;
    state.trip_sequence_day = 0;
    state.next_trip_sequence = 3;
    state.sims = vec![Sim {
        id: "sim-001".to_string(),
        home: (2, 3).into(),
        position: (3, 3).into(),
        worker_profile: WorkerProfile::Worker,
        shift_template: Some("standard".to_string()),
        workplace: Some((3, 3).into()),
        commute_day: 0,
        outbound_resolved_today: true,
        outbound_arrived_today: true,
        return_resolved_today: false,
        returned_home_today: false,
    }];
    state.active_trips = vec![ActiveTrip {
        id: "trip-day-0-trip-002".to_string(),
        sim_id: "sim-002".to_string(),
        purpose: TripPurpose::CommuteOutbound,
        origin: (8, 3).into(),
        destination: (9, 3).into(),
        position: (8, 3).into(),
        status: TripStatus::Walking,
        deadline: return_time + 900.0,
        route_plan: Some(walk_plan((8, 3).into(), (9, 3).into(), 20.0)),
        current_leg_index: 0,
        patience_remaining: 240.0,
        private_car_trip: None,
    }];

    let topology = RoadTopology::compile(&state.map).expect("fixture topology compiles");
    let next = tick_trips(&state, &topology, 0.0);

    let ids = next
        .active_trips
        .iter()
        .map(|trip| trip.id.as_str())
        .collect::<Vec<_>>();
    assert!(ids.contains(&"trip-day-0-trip-002"));
    assert!(ids.contains(&"trip-day-0-trip-003"));
    assert_eq!(next.next_trip_sequence, 4);
}

/// A zero-length walk leg (boarding at the trip's current tile, or transferring
/// between two lines at the same stop) completes instantly and produces no
/// substep boundary. Without collapsing it, a large tick consumes the whole
/// substep on the no-op walk without accruing wait time for the following
/// transit leg, breaking the large-tick vs stepped-tick equivalence.
fn state_with_zero_length_walk_then_bus() -> caelum_core::model::GameSnapshot {
    let mut state = create_initial_snapshot();
    state.time = 100.0;
    state.day = clock::day_index(state.time);
    state.clock_minutes = clock::clock_minutes(state.time);
    state.paused = false;
    // No transit vehicles: the trip just waits at the boarding point so we can
    // isolate wait-time accrual without depending on vehicle movement.
    state.transit = TransitNetwork {
        stops: Vec::new(),
        stations: Vec::new(),
        routes: Vec::new(),
        metro_lines: Vec::new(),
        vehicles: Vec::new(),
    };
    // Route plan: Walk (5,3)->(5,3) [zero-length], then Bus (5,3)->(22,3).
    // The trip is already at the boarding tile, so the first walk leg is a no-op.
    let plan = RoutePlan {
        estimated_seconds: 120.0,
        legs: vec![
            RouteLeg {
                mode: TransitMode::Walk,
                from: (5, 3).into(),
                to: (5, 3).into(),
                line_id: None,
                service_direction: None,
                board_itinerary_index: None,
                alight_itinerary_index: None,
            },
            RouteLeg {
                mode: TransitMode::Bus,
                from: (5, 3).into(),
                to: (22, 3).into(),
                line_id: Some("route-001".to_string()),
                service_direction: Some(ServiceDirection::Loop),
                board_itinerary_index: Some(0),
                alight_itinerary_index: Some(0),
            },
        ],
    };
    let mut trip = trip(
        "trip-001",
        TripStatus::Walking,
        (5, 3).into(),
        (22, 3).into(),
    );
    trip.route_plan = Some(plan);
    trip.deadline = 1_000.0;
    state.active_trips = vec![trip];
    state
}

#[test]
fn zero_length_walk_leg_accrues_wait_time_under_large_tick() {
    let state = state_with_zero_length_walk_then_bus();
    let topology = RoadTopology::compile(&state.map).expect("fixture topology compiles");

    let next = tick_trips(&state, &topology, 60.0);

    // The zero-length walk must be collapsed so the following bus leg's wait
    // time is accrued for the full substep, not dropped to zero.
    assert_eq!(next.active_trips.len(), 1);
    assert_eq!(next.active_trips[0].status, TripStatus::Waiting);
    assert_eq!(next.active_trips[0].current_leg_index, 1);
    assert!(
        (next.metrics.total_wait_seconds - 60.0).abs() < 0.000_001,
        "expected 60s of wait accrued, got {}",
        next.metrics.total_wait_seconds
    );
}

#[test]
fn zero_length_walk_leg_preserves_large_tick_vs_stepped_tick_equivalence() {
    let state = state_with_zero_length_walk_then_bus();
    let topology = RoadTopology::compile(&state.map).expect("fixture topology compiles");
    let large_snapshot = tick_trips(&state, &topology, 60.0);

    let mut stepped_snapshot = state;
    for _ in 0..60 {
        stepped_snapshot = tick_trips(&stepped_snapshot, &topology, 1.0);
    }

    assert!(
        (large_snapshot.metrics.total_wait_seconds - stepped_snapshot.metrics.total_wait_seconds)
            .abs()
            < 0.001,
        "large tick wait {}s != stepped tick wait {}s",
        large_snapshot.metrics.total_wait_seconds,
        stepped_snapshot.metrics.total_wait_seconds
    );
}

/// When every walk leg in the plan is zero-length and the trip is already at its
/// destination (e.g. origin == destination, or a transit drop-off at the exact
/// destination tile), collapsing all of them must walk past the final leg and
/// score an immediate arrival — not strand the trip Walking forever.
#[test]
fn all_zero_length_walks_collapses_to_immediate_arrival() {
    let mut state = create_initial_snapshot();
    state.time = 100.0;
    state.day = clock::day_index(state.time);
    state.clock_minutes = clock::clock_minutes(state.time);
    state.paused = false;
    let mut trip = trip(
        "trip-001",
        TripStatus::Walking,
        (5, 3).into(),
        (5, 3).into(),
    );
    trip.route_plan = Some(RoutePlan {
        estimated_seconds: 0.0,
        legs: vec![
            RouteLeg {
                mode: TransitMode::Walk,
                from: (5, 3).into(),
                to: (5, 3).into(),
                line_id: None,
                service_direction: None,
                board_itinerary_index: None,
                alight_itinerary_index: None,
            },
            RouteLeg {
                mode: TransitMode::Walk,
                from: (5, 3).into(),
                to: (5, 3).into(),
                line_id: None,
                service_direction: None,
                board_itinerary_index: None,
                alight_itinerary_index: None,
            },
        ],
    });
    trip.deadline = 1_000.0;
    state.active_trips = vec![trip];

    let topology = RoadTopology::compile(&state.map).expect("fixture topology compiles");
    let next = tick_trips(&state, &topology, 1.0);

    assert!(next.active_trips.is_empty());
    assert_eq!(next.metrics.completed_trips, 1);
    assert_eq!(next.metrics.trip_outcomes.len(), 1);
    assert_eq!(
        next.metrics.trip_outcomes[0].outcome,
        TripOutcomeKind::Arrived
    );
}

/// A zero-length transfer walk between two transit legs (two lines sharing the
/// same transfer anchor) must collapse so the trip moves straight from one wait
/// leg to the next without burning a substep on the no-op walk.
#[test]
fn zero_length_transfer_walk_collapses_between_transit_legs() {
    let mut state = create_initial_snapshot();
    state.time = 100.0;
    state.day = clock::day_index(state.time);
    state.clock_minutes = clock::clock_minutes(state.time);
    state.paused = false;
    state.transit = TransitNetwork {
        stops: Vec::new(),
        stations: Vec::new(),
        routes: Vec::new(),
        metro_lines: Vec::new(),
        vehicles: Vec::new(),
    };
    // Plan: Bus to (8,3), zero-length walk transfer at (8,3), then Bus onward.
    let mut trip = trip(
        "trip-001",
        TripStatus::Walking,
        (8, 3).into(),
        (22, 3).into(),
    );
    trip.position = (8, 3).into();
    trip.route_plan = Some(RoutePlan {
        estimated_seconds: 240.0,
        legs: vec![
            RouteLeg {
                mode: TransitMode::Bus,
                from: (5, 3).into(),
                to: (8, 3).into(),
                line_id: Some("route-001".to_string()),
                service_direction: Some(ServiceDirection::Loop),
                board_itinerary_index: Some(0),
                alight_itinerary_index: Some(0),
            },
            RouteLeg {
                mode: TransitMode::Walk,
                from: (8, 3).into(),
                to: (8, 3).into(),
                line_id: None,
                service_direction: None,
                board_itinerary_index: None,
                alight_itinerary_index: None,
            },
            RouteLeg {
                mode: TransitMode::Bus,
                from: (8, 3).into(),
                to: (22, 3).into(),
                line_id: Some("route-002".to_string()),
                service_direction: Some(ServiceDirection::Loop),
                board_itinerary_index: Some(0),
                alight_itinerary_index: Some(0),
            },
        ],
    });
    trip.current_leg_index = 1;
    trip.deadline = 1_000.0;
    state.active_trips = vec![trip];

    let topology = RoadTopology::compile(&state.map).expect("fixture topology compiles");
    let next = tick_trips(&state, &topology, 30.0);

    // The zero-length transfer walk at leg index 1 must collapse, advancing
    // straight to the second bus leg (index 2) and accruing its wait time.
    assert_eq!(next.active_trips.len(), 1);
    assert_eq!(next.active_trips[0].status, TripStatus::Waiting);
    assert_eq!(next.active_trips[0].current_leg_index, 2);
    assert!(
        (next.metrics.total_wait_seconds - 30.0).abs() < 0.000_001,
        "expected 30s wait for the second bus leg, got {}",
        next.metrics.total_wait_seconds
    );
}

/// A trip stuck behind a zero-length walk that then waits for a vehicle must time
/// out at exactly the patience boundary under both a large tick and stepped ticks.
/// This exercises the boundary tracker's patience tracking for the transit leg
/// hidden behind the no-op walk: the substep must break at patience so the
/// unserved outcome is recorded at the same instant regardless of tick granularity.
#[test]
fn zero_length_walk_then_wait_timeout_matches_across_tick_granularities() {
    fn build() -> caelum_core::model::GameSnapshot {
        let mut state = state_with_zero_length_walk_then_bus();
        // Drain patience so the trip times out 30s into the wait, well inside a
        // 100s large tick — this is the window where boundary tracking matters.
        state.active_trips[0].patience_remaining = 30.0;
        state
    }

    let start = build();
    let topology = RoadTopology::compile(&start.map).expect("fixture topology compiles");
    let large = tick_trips(&start, &topology, 100.0);

    let mut stepped = start;
    for _ in 0..100 {
        stepped = tick_trips(&stepped, &topology, 1.0);
    }

    assert_eq!(large.metrics.unserved_trips, stepped.metrics.unserved_trips);
    assert!(
        (large.metrics.total_wait_seconds - stepped.metrics.total_wait_seconds).abs() < 0.001,
        "large wait {}s != stepped wait {}s",
        large.metrics.total_wait_seconds,
        stepped.metrics.total_wait_seconds
    );
    assert_eq!(large.metrics.trip_outcomes.len(), 1);
    assert_eq!(
        large.metrics.trip_outcomes[0].outcome,
        TripOutcomeKind::Unserved
    );
    // The trip drained 30s of patience this tick (patience_remaining was 30s).
    assert!(
        (large.metrics.total_wait_seconds - 30.0).abs() < 0.001,
        "expected 30s accrued wait, got {}",
        large.metrics.total_wait_seconds
    );
    // Outcome fires at patience boundary: start (100s) + 30s drained.
    assert!(
        (large.metrics.trip_outcomes[0].time - 130.0).abs() < 0.001,
        "expected outcome at t=130, got {}",
        large.metrics.trip_outcomes[0].time
    );
}

/// Regression: a coarse tick that spans a waiting trip past the 180s average-wait
/// loss threshold and then to its 240s patience expiry must still detect the loss.
/// Without per-substep objective evaluation and a boundary at the wait-threshold,
/// the trip expires inside one substep and `waiting_trip_count` drops to 0 on the
/// final snapshot, so `evaluate_objectives` sees no loss — even though stepped
/// ticks (which sample metrics each tick) would lose.
#[test]
fn coarse_tick_detects_wait_loss_before_patience_expiry() {
    let mut state = common::campaign_state();
    state.paused = false;
    let mut waiting = trip(
        "trip-001",
        TripStatus::Waiting,
        (7, 8).into(),
        (22, 8).into(),
    );
    waiting.route_plan = Some(bus_plan((7, 8).into(), (22, 8).into(), "route-001"));
    // Waited 170s so far (patience 70s remaining). A 70s coarse tick spans from
    // 170s of wait past the 180s threshold to the 240s patience expiry.
    waiting.patience_remaining = 70.0;
    state.active_trips = vec![waiting];

    let topology = RoadTopology::compile(&state.map).expect("fixture topology compiles");
    let next = tick_trips_with_objectives(&state, &topology, 70.0);

    assert_eq!(next.metrics.state, MetricsState::Lost);
    assert_eq!(
        next.metrics.loss_reason.as_deref(),
        Some("Average wait time is too high")
    );
}

/// Regression: a coarse tick can miss the aggregate `average_wait_seconds`
/// crossing `MAX_AVERAGE_WAIT_SECONDS` even when no individual trip's wait
/// threshold boundary fires at the right time. Two waiting trips with unequal
/// wait times: Trip A (wait=179s, patience=61s) and Trip B (wait=119s,
/// patience=121s). The aggregate average is 149s, crossing 180s at t=31s. But
/// the per-trip wait-threshold boundary for Trip A fires at t=1s (when its own
/// wait hits 180s, aggregate still 150s), and the next boundary is Trip A's
/// patience expiry at t=61s — by which point Trip A leaves the waiting set and
/// the average drops to exactly 180s (not strictly greater). Trip B then
/// expires at t=121s. Without an aggregate-wait boundary, the loss between
/// t=31s and t=61s is never sampled and the simulation incorrectly continues.
#[test]
fn coarse_tick_detects_aggregate_wait_loss_between_per_trip_boundaries() {
    let mut state = common::campaign_state();
    state.paused = false;
    state.time = 0.0;

    let mut trip_a = trip(
        "trip-001",
        TripStatus::Waiting,
        (7, 8).into(),
        (22, 8).into(),
    );
    trip_a.route_plan = Some(bus_plan((7, 8).into(), (22, 8).into(), "route-001"));
    trip_a.patience_remaining = 61.0; // waited 179s

    let mut trip_b = trip(
        "trip-002",
        TripStatus::Waiting,
        (7, 8).into(),
        (22, 8).into(),
    );
    trip_b.route_plan = Some(bus_plan((7, 8).into(), (22, 8).into(), "route-001"));
    trip_b.patience_remaining = 121.0; // waited 119s

    state.active_trips = vec![trip_a, trip_b];

    // A 200s coarse tick: the aggregate average crosses 180s at t=31s, well
    // before Trip A's patience expiry at t=61s. Without the aggregate boundary
    // the crossing is missed and the loss is never detected.
    let topology = RoadTopology::compile(&state.map).expect("fixture topology compiles");
    let next = tick_trips_with_objectives(&state, &topology, 200.0);

    assert_eq!(next.metrics.state, MetricsState::Lost);
    assert_eq!(
        next.metrics.loss_reason.as_deref(),
        Some("Average wait time is too high")
    );
}

fn assert_average_wait_loss_matches_coarse_and_fine(
    state: &caelum_core::GameSnapshot,
    topology: &RoadTopology,
) {
    let coarse = tick_trips_with_objectives(state, topology, 300.0);
    let fine = tick_trips_with_objectives(state, topology, 1.0);

    assert_eq!(coarse.metrics.state, MetricsState::Lost);
    assert_eq!(fine.metrics.state, MetricsState::Lost);
    assert_eq!(
        coarse.metrics.loss_reason.as_deref(),
        Some("Average wait time is too high")
    );
    assert_eq!(coarse.metrics.loss_reason, fine.metrics.loss_reason);
    assert_eq!(coarse.time, fine.time);
    assert!(
        (coarse.time - 0.000_002).abs() < 1e-12,
        "expected strict-threshold sample at t=0.000002, got {}",
        coarse.time
    );
}

#[test]
fn coarse_tick_samples_aggregate_wait_when_threshold_is_already_equal() {
    let mut state = common::campaign_state();
    state.paused = false;
    state.scenario.objectives.as_mut().unwrap().max_average_wait =
        MaxAverageWaitSeconds::new(149.0).unwrap();

    let mut trip_a = trip(
        "trip-001",
        TripStatus::Waiting,
        (7, 8).into(),
        (22, 8).into(),
    );
    trip_a.route_plan = Some(bus_plan((7, 8).into(), (22, 8).into(), "route-001"));
    trip_a.patience_remaining = 61.0; // waited 179s

    let mut trip_b = trip(
        "trip-002",
        TripStatus::Waiting,
        (7, 8).into(),
        (22, 8).into(),
    );
    trip_b.route_plan = Some(bus_plan((7, 8).into(), (22, 8).into(), "route-001"));
    trip_b.patience_remaining = 121.0; // waited 119s; aggregate average is exactly 149s

    state.active_trips = vec![trip_a, trip_b];

    let topology = RoadTopology::compile(&state.map).expect("fixture topology compiles");
    assert_average_wait_loss_matches_coarse_and_fine(&state, &topology);
}

#[test]
fn coarse_tick_samples_per_trip_wait_when_zero_threshold_is_already_equal() {
    let mut state = common::campaign_state();
    state.paused = false;
    state.scenario.objectives.as_mut().unwrap().max_average_wait =
        MaxAverageWaitSeconds::new(0.0).unwrap();

    // Idle is intentional: aggregate tracking sees no waiting trip yet, so the
    // per-trip terminal tracker must schedule the strict-threshold sample.
    let mut idle = trip("trip-001", TripStatus::Idle, (7, 8).into(), (22, 8).into());
    idle.route_plan = Some(bus_plan((7, 8).into(), (22, 8).into(), "route-001"));
    state.active_trips = vec![idle];

    let topology = RoadTopology::compile(&state.map).expect("fixture topology compiles");
    assert_average_wait_loss_matches_coarse_and_fine(&state, &topology);
}

/// Regression: a coarse tick that generates bad outcomes early and advances past
/// the 300s rolling window must still detect the loss. Without per-substep
/// objective evaluation, `prune_trip_outcomes` drops the stale outcomes by the
/// final snapshot and `evaluate_objectives` sees an empty in-range window.
#[test]
fn coarse_tick_detects_rolling_window_loss_before_outcomes_expire() {
    let mut state = common::campaign_state();
    state.paused = false;
    state.time = 0.0;
    // Ten trips that will time out (unserved) at t=10s, each with 10s patience.
    state.active_trips = (0..10)
        .map(|index| {
            let mut waiting = trip(
                &format!("trip-{index:03}"),
                TripStatus::Waiting,
                (7, 8).into(),
                (22, 8).into(),
            );
            waiting.route_plan = Some(bus_plan((7, 8).into(), (22, 8).into(), "route-001"));
            waiting.patience_remaining = 10.0;
            waiting
        })
        .collect();

    // A 400s coarse tick: the trips expire at t=10s (generating 10 unserved
    // outcomes), then the tick advances 390s past the 300s rolling window. By
    // the final snapshot at t=400s, the outcomes at t=10s are pruned (window
    // start = 100s). Without per-substep evaluation, the loss is missed.
    let topology = RoadTopology::compile(&state.map).expect("fixture topology compiles");
    let next = tick_trips_with_objectives(&state, &topology, 400.0);

    assert_eq!(next.metrics.state, MetricsState::Lost);
    assert_eq!(
        next.metrics.loss_reason.as_deref(),
        Some("Too many unserved citizens")
    );
}

#[test]
fn custom_campaign_window_matches_coarse_and_fine_objective_ticks() {
    fn build() -> caelum_core::GameSnapshot {
        let mut state = common::campaign_state();
        state.paused = false;
        state
            .scenario
            .objectives
            .as_mut()
            .unwrap()
            .rolling_window_seconds = RollingWindowSeconds::new(600.0).unwrap();
        state.scenario.objectives.as_mut().unwrap().max_average_wait =
            MaxAverageWaitSeconds::new(300.0).unwrap();
        state.active_trips = (0..10)
            .map(|index| {
                let mut waiting = trip(
                    &format!("trip-{index:03}"),
                    TripStatus::Waiting,
                    (7, 8).into(),
                    (22, 8).into(),
                );
                waiting.route_plan = Some(bus_plan((7, 8).into(), (22, 8).into(), "route-001"));
                waiting.patience_remaining = 10.0;
                waiting
            })
            .collect();
        state
    }

    let start = build();
    let topology = RoadTopology::compile(&start.map).expect("fixture topology compiles");
    let coarse = tick_trips_with_objectives(&start, &topology, 700.0);
    let mut fine = start;
    // Bound the fine-grained loop so a regression that never reaches a terminal
    // state fails the test instead of hanging CI. 700 seconds of game time at
    // 1-second ticks is the same horizon as the coarse tick; the cap is generous
    // beyond that to absorb substep re-evaluations.
    const MAX_FINE_TICKS: usize = 2_000;
    let mut iterations = 0;
    while fine.metrics.state == MetricsState::Running {
        iterations += 1;
        assert!(
            iterations <= MAX_FINE_TICKS,
            "fine-grained loop did not reach a terminal state within {MAX_FINE_TICKS} ticks"
        );
        fine = tick_trips_with_objectives(&fine, &topology, 1.0);
    }
    assert_ne!(
        fine.metrics.state,
        MetricsState::Running,
        "fine-grained loop must reach a terminal state"
    );

    assert_eq!(coarse.metrics.state, MetricsState::Lost);
    assert_eq!(coarse.metrics.loss_reason, fine.metrics.loss_reason);
    assert_eq!(coarse.time, fine.time);
    assert_eq!(coarse.metrics.unserved_trips, fine.metrics.unserved_trips);
}

/// Regression: a coarse tick that spans the expiry of "good" outcomes (arrived)
/// while "bad" outcomes (unserved) are still in the rolling window must break at
/// the good-outcome expiry boundary and detect the loss there. Without an
/// outcome-expiry boundary in `next_boundary_after`, the coarse tick prunes both
/// groups together by the final substep and the loss — which fine ticks detect
/// the instant the good outcomes expire — is missed.
///
/// Scenario: a 10s custom rolling window, 40 arrived outcomes at t=0, 10
/// unserved outcomes at t=5. At t=5 the unserved ratio is 10/50 = 0.20 (not
/// above the default 0.20 threshold). At t=10+eps the 40 arrivals expire,
/// leaving 10/10 = 1.0 unserved in the window — a loss. A coarse tick from
/// t=5 to t=20 must sample that instant rather than jumping to t=20 where both
/// groups are gone.
#[test]
fn coarse_tick_detects_loss_when_good_outcomes_expire_before_bad_ones() {
    let mut state = common::campaign_state();
    state.paused = false;
    state.time = 5.0;
    state
        .scenario
        .objectives
        .as_mut()
        .unwrap()
        .rolling_window_seconds = RollingWindowSeconds::new(10.0).unwrap();
    state.metrics.completed_trips = 40;
    state.metrics.unserved_trips = 10;
    state.metrics.trip_outcomes = (0..40)
        .map(|_| TripOutcome {
            outcome: TripOutcomeKind::Arrived,
            wait_seconds: 0.0,
            time: 0.0,
        })
        .chain((0..10).map(|_| TripOutcome {
            outcome: TripOutcomeKind::Unserved,
            wait_seconds: 0.0,
            time: 5.0,
        }))
        .collect();

    // The coarse tick spans both expiry instants (arrivals at t=10, unserved at
    // t=15). The substep must break at t=10+eps, prune the arrivals, and
    // evaluate the loss gate on the remaining 10 unserved outcomes.
    let topology = RoadTopology::compile(&state.map).expect("fixture topology compiles");
    let coarse = tick_trips_with_objectives(&state, &topology, 15.0);

    assert_eq!(coarse.metrics.state, MetricsState::Lost);
    assert_eq!(
        coarse.metrics.loss_reason.as_deref(),
        Some("Too many unserved citizens")
    );

    // Fine ticks must also detect the loss, confirming the coarse tick's
    // terminal state is not a divergence from the granularity-independent
    // invariant.
    let mut fine = state.clone();
    let mut iterations = 0;
    while fine.metrics.state == MetricsState::Running {
        iterations += 1;
        assert!(
            iterations <= 100,
            "fine-grained loop did not reach a terminal state within 100 ticks"
        );
        fine = tick_trips_with_objectives(&fine, &topology, 1.0);
    }
    assert_eq!(fine.metrics.state, MetricsState::Lost);
    assert_eq!(coarse.metrics.loss_reason, fine.metrics.loss_reason);
}
