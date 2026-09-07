use caelum_core::model::{
    ActiveTrip, CitizenRoutine, GameSnapshot, MaxAverageWaitSeconds, MetricsState, PlacedBuilding,
    Point, PrivateCarTrip, RollingWindowSeconds, RouteLeg, RouteLegStatus, RoutePlan,
    ScheduledActivity, ScheduledActivityKind, ServiceDirection, ServicePattern, Sim, TransitMode,
    TransitNetwork, TripOutcome, TripOutcomeKind, TripPosition, TripPurpose, TripStatus, Vehicle,
};
use caelum_core::{
    clock, commute, objectives, road_topology::RoadTopology, state::create_initial_snapshot,
    traffic, transit, trips,
};
use caelum_core::{GameEngine, GameIntent};
use common::persistence_fixtures::{travelling_worker_sim, worker_sim};

mod common;

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
        current_leg_wait_seconds: 0.0,
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

/// A persistence-valid zoned destination: the supermarket's canonical 2x2
/// footprint must be empty, commercially zoned tiles, and those occupied tiles
/// are what `has_valid_workplace_destination` and the private-car access
/// derivation match commute endpoints against.
fn place_destination(state: &mut GameSnapshot, id: &str, origin: Point) {
    for y in origin.y..origin.y + 2 {
        for x in origin.x..origin.x + 2 {
            let tile = state
                .map
                .tile_mut(Point { x, y })
                .expect("fixture tile exists");
            tile.area = Some("commercial".to_string());
        }
    }
    state.buildings.push(PlacedBuilding {
        id: id.to_string(),
        building_type: "supermarket".to_string(),
        origin,
        rotation: 0,
        occupied_tiles: vec![
            origin,
            Point {
                x: origin.x + 1,
                y: origin.y,
            },
            Point {
                x: origin.x,
                y: origin.y + 1,
            },
            Point {
                x: origin.x + 1,
                y: origin.y + 1,
            },
        ],
        placed_at: 0.0,
        transit_node_id: None,
    });
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

fn car_commute_fixture(sim_ids: &[&str]) -> GameSnapshot {
    let home = Point { x: 2, y: 3 };
    let workplace = Point { x: 12, y: 3 };
    let mut state = create_initial_snapshot();
    clear_roads(&mut state);
    common::corridor(
        &mut state,
        &(3..=11).map(|x| Point { x, y: 3 }).collect::<Vec<_>>(),
        None,
    );
    // Zoned, persistence-valid destination buildings anchor both commute
    // endpoints: `has_valid_workplace_destination` needs the workplace in a
    // destination footprint, and the private-car candidate derives road
    // access from the home/work footprints. The home footprint sits at x=1
    // so its 2x2 tiles avoid the corridor road at (3,3).
    place_destination(&mut state, "home", Point { x: 1, y: 2 });
    place_destination(&mut state, "work", workplace);
    state.sims = sim_ids
        .iter()
        .map(|id| worker_sim(id, home, Some(workplace)))
        .collect();
    let departure_minute = commute::departure_minute_for_sim(sim_ids[0], "standard", "outbound");
    state.time =
        f64::from(departure_minute) / f64::from(clock::MINUTES_PER_DAY) * clock::GAME_DAY_SECONDS;
    state.day = 0;
    state.clock_minutes = departure_minute;
    state.paused = false;
    state
}

fn bus_fractional_progress_fixture() -> (GameSnapshot, f64) {
    let home = Point { x: 2, y: 3 };
    let workplace = Point { x: 12, y: 3 };
    let mut engine = GameEngine::new();
    road_line(&mut engine, 3, 3, 11);
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
    let assigned = engine.dispatch(GameIntent::AssignVehicle {
        mode: "bus".to_string(),
        line_id: "route-001".to_string(),
    });
    assert!(
        assigned.applied,
        "bus fixture vehicle should apply: {assigned:?}"
    );

    let mut state = engine.snapshot();
    place_destination(&mut state, "home", Point { x: 1, y: 2 });
    place_destination(&mut state, "work", workplace);
    state.sims = std::iter::once(worker_sim("sim-001", home, Some(workplace)))
        .chain((0..4).map(|id| travelling_worker_sim(&format!("seed-car-sim-{id:03}"), home)))
        .collect();
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
            current_leg_wait_seconds: 0.0,
            private_car_trip: Some(PrivateCarTrip {
                path: bus_path.clone(),
                arrival_time: departure_time + 100.0,
            }),
        })
        .collect();

    (state, departure_time)
}

fn bus_arrival_order_fixture() -> GameSnapshot {
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
    let assigned = engine.dispatch(GameIntent::AssignVehicle {
        mode: "bus".to_string(),
        line_id: "route-001".to_string(),
    });
    assert!(
        assigned.applied,
        "bus fixture vehicle should apply: {assigned:?}"
    );

    let mut state = engine.snapshot();
    state.paused = false;
    state.sims = (0..5)
        .map(|id| travelling_worker_sim(&format!("arrival-car-sim-{id:03}"), (2, 3).into()))
        .collect();
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
        current_leg_wait_seconds: 0.0,
        private_car_trip: Some(PrivateCarTrip {
            path: bus_path.clone(),
            arrival_time,
        }),
    };
    state.active_trips = (0..4)
        .map(|id| make_car(id, 100.0))
        .chain(std::iter::once(make_car(4, 1.25)))
        .collect();

    state
}

fn staggered_car_arrival_fixture() -> GameSnapshot {
    let mut state = car_commute_fixture(&["sim-001"]);
    let home = Point { x: 2, y: 3 };
    let workplace = Point { x: 12, y: 3 };
    let topology = RoadTopology::compile(&state.map).expect("fixture topology compiles");
    let candidate = traffic::private_car_candidate(
        &state,
        &topology,
        &traffic::RoadFlow::new(),
        home,
        workplace,
    )
    .expect("staggered arrival fixture has a valid car path");
    state.sims = (0..5)
        .map(|index| travelling_worker_sim(&format!("arrival-sim-{index:03}"), home))
        .collect();
    state.active_trips = [0.5, 1.0, 1.5, 2.0, 2.5]
        .into_iter()
        .enumerate()
        .map(|(index, offset)| ActiveTrip {
            id: format!("trip-day-0-trip-{:03}", index + 1),
            sim_id: format!("arrival-sim-{index:03}"),
            purpose: TripPurpose::CommuteOutbound,
            origin: home,
            destination: workplace,
            position: home.into(),
            status: TripStatus::Driving,
            deadline: state.time + 900.0,
            route_plan: None,
            current_leg_index: 0,
            patience_remaining: 240.0,
            current_leg_wait_seconds: 0.0,
            private_car_trip: Some(PrivateCarTrip {
                path: candidate.path.clone(),
                arrival_time: state.time + offset,
            }),
        })
        .collect();
    state
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
        current_leg_wait_seconds: 0.0,
        private_car_trip: None,
    }
}

#[test]
fn car_mode_choice_uses_driving_when_car_eta_is_strictly_faster_than_walk() {
    let mut engine = common::running_engine_from_fixture(car_commute_fixture(&["sim-001"]));

    let result = engine.tick(0.0);
    assert!(result.rejection.is_none());
    let next = engine.snapshot();
    assert_eq!(next.active_trips.len(), 1);
    let outbound = &next.active_trips[0];

    assert_eq!(outbound.status, TripStatus::Driving);
    assert!(outbound.private_car_trip.is_some());
    assert!(outbound.route_plan.is_none());
}

#[test]
fn car_mode_choice_keeps_walk_lifecycle_when_car_access_is_unavailable() {
    let mut state = car_commute_fixture(&["sim-001"]);
    clear_roads(&mut state);

    let mut engine = common::running_engine_from_fixture(state);
    let result = engine.tick(0.0);
    assert!(result.rejection.is_none());
    let next = engine.snapshot();
    assert_eq!(next.active_trips.len(), 1);
    let outbound = &next.active_trips[0];

    // The walk fallback plan is stored at spawn with its implied status.
    assert_eq!(outbound.status, TripStatus::Walking);
    assert!(outbound.private_car_trip.is_none());
    assert!(outbound.route_plan.is_some());

    engine.tick(1.0);
    let walking = engine.snapshot();
    assert_eq!(walking.active_trips[0].status, TripStatus::Walking);
}

#[test]
fn same_time_worker_sees_prior_selected_car_flow_in_stable_sim_order() {
    // Suffix 485 has the same standard-shift departure minute as suffix 001,
    // while retaining a deterministic later sim iteration slot.
    let mut state = car_commute_fixture(&["sim-001", "sim-485"]);
    let home = Point { x: 2, y: 3 };
    let workplace = Point { x: 12, y: 3 };
    let topology = RoadTopology::compile(&state.map).expect("fixture topology compiles");
    let free_flow = traffic::private_car_candidate(
        &state,
        &topology,
        &traffic::RoadFlow::new(),
        home,
        workplace,
    );
    assert!(free_flow.is_some(), "car fixture has a free-flow candidate");
    let Some(free_flow) = free_flow else {
        return;
    };
    let seed_arrival_time = state.time + free_flow.estimated_seconds;
    let fixture_time = state.time;
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
            current_leg_wait_seconds: 0.0,
            private_car_trip: Some(PrivateCarTrip {
                path: free_flow.path.clone(),
                arrival_time: seed_arrival_time,
            }),
        })
        .collect();
    // The seeded driving trips reference these sims; keep them dormant so the
    // spawn pass never adds commute traffic for them.
    state
        .sims
        .extend((0..4).map(|index| travelling_worker_sim(&format!("seed-sim-{index}"), home)));

    let mut engine = common::running_engine_from_fixture(state);
    let result = engine.tick(0.0);
    assert!(result.rejection.is_none());
    let next = engine.snapshot();

    assert_eq!(
        next.active_trips
            .iter()
            .filter(|trip| trip.sim_id == "sim-001")
            .count(),
        1
    );
    assert_eq!(
        next.active_trips
            .iter()
            .filter(|trip| trip.sim_id == "sim-485")
            .count(),
        1
    );
    let Some(first_worker) = next
        .active_trips
        .iter()
        .find(|trip| trip.sim_id == "sim-001")
    else {
        return;
    };
    let Some(second_worker) = next
        .active_trips
        .iter()
        .find(|trip| trip.sim_id == "sim-485")
    else {
        return;
    };
    let first_arrival_time = first_worker
        .private_car_trip
        .as_ref()
        .map(|car| car.arrival_time);
    let second_arrival_time = second_worker
        .private_car_trip
        .as_ref()
        .map(|car| car.arrival_time);
    assert!(first_arrival_time.is_some(), "first worker chose car");
    assert!(second_arrival_time.is_some(), "second worker chose car");
    let Some(first_arrival_time) = first_arrival_time else {
        return;
    };
    let Some(second_arrival_time) = second_arrival_time else {
        return;
    };

    assert_eq!(first_worker.status, TripStatus::Driving);
    assert_eq!(second_worker.status, TripStatus::Driving);
    assert!(second_arrival_time > first_arrival_time);
    let admitted_flow = traffic::derive_road_flow(&next);
    assert_eq!(
        admitted_flow.get(&free_flow.path.road_steps()[0].position),
        Some(&6)
    );
    let free_road_seconds: f64 = free_flow
        .path
        .road_steps()
        .iter()
        .map(|step| step.travel_seconds)
        .sum();
    let fixed_car_seconds = free_flow.estimated_seconds - free_road_seconds;
    assert!(
        (first_arrival_time - fixture_time - fixed_car_seconds - free_road_seconds * 1.25).abs()
            < 1e-9,
        "first worker should see seeded flow of four: arrival={first_arrival_time}, free_flow={}s",
        free_flow.estimated_seconds
    );
    assert!(
        (second_arrival_time - fixture_time - fixed_car_seconds - free_road_seconds * 1.5).abs()
            < 1e-9,
        "second worker should see the first worker's selected flow: arrival={second_arrival_time}, free_flow={}s",
        free_flow.estimated_seconds
    );
}

#[test]
fn car_mode_choice_is_identical_for_coarse_and_fine_ticks() {
    let base = car_commute_fixture(&["sim-001"]);

    let mut coarse = common::running_engine_from_fixture(base.clone());
    coarse.tick(3.0);
    let coarse_snapshot = coarse.snapshot();

    let mut fine = common::running_engine_from_fixture(base);
    for _ in 0..3 {
        fine.tick(1.0);
    }
    let fine_snapshot = fine.snapshot();

    assert_eq!(coarse_snapshot.time, fine_snapshot.time);
    assert_eq!(coarse_snapshot.active_trips, fine_snapshot.active_trips);
    assert_eq!(
        caelum_core::traffic::derive_road_flow(&coarse_snapshot),
        caelum_core::traffic::derive_road_flow(&fine_snapshot)
    );
}

#[test]
fn fractional_bus_progress_rescales_only_remaining_time_at_car_departure() {
    let (state, departure_time) = bus_fractional_progress_fixture();
    let departure_delta = departure_time - state.time;
    let total_delta = departure_delta + 0.4;

    let mut coarse = common::running_engine_from_fixture(state.clone());
    coarse.tick(total_delta);
    let coarse_snapshot = coarse.snapshot();

    let mut split = common::running_engine_from_fixture(state);
    let at_departure_result = split.tick(departure_delta);
    assert!(at_departure_result.rejection.is_none());
    let at_departure = split.snapshot();
    assert_eq!(
        at_departure.transit.vehicles[0].step_progress, 0.7,
        "fractional progress stays in normalized coordinates at the flow boundary"
    );
    assert_eq!(
        traffic::derive_road_flow(&at_departure).get(&(3, 3).into()),
        Some(&5)
    );

    split.tick(total_delta - departure_delta);
    let split_snapshot = split.snapshot();
    assert_eq!(
        coarse_snapshot.transit.vehicles[0],
        split_snapshot.transit.vehicles[0]
    );
    assert_eq!(
        coarse_snapshot.transit.vehicles[0].itinerary_index, 0,
        "0.4s after departure is shorter than the rescaled 0.46875s remaining"
    );
    assert!(
        coarse_snapshot.transit.vehicles[0].step_progress > 0.95,
        "progress={}",
        coarse_snapshot.transit.vehicles[0].step_progress
    );
    assert!(coarse_snapshot.transit.vehicles[0].step_progress < 1.0);
}

#[test]
fn scheduled_car_departure_updates_flow_before_fractional_bus_boundary_estimate() {
    let (mut state, departure_time) = bus_fractional_progress_fixture();
    state.time = departure_time;
    state.day = 0;
    state.clock_minutes = clock::clock_minutes(state.time);
    state.transit.vehicles[0].step_progress = 0.5;

    let mut engine = common::running_engine_from_fixture(state);
    let result = engine.tick(0.0);
    assert!(result.rejection.is_none());
    let spawned = engine.snapshot();
    let flow = traffic::derive_road_flow(&spawned);
    let first_step = spawned.transit.routes[0].legs[0]
        .current_path
        .as_ref()
        .expect("bus route has a captured path")
        .road_steps()
        .first()
        .cloned()
        .expect("bus path has a road step");

    assert_eq!(first_step.travel_seconds, 1.25);
    assert_eq!(flow.get(&first_step.position), Some(&5));
    assert_eq!(traffic::congestion_multiplier(5), 1.25);
    assert_eq!(
        traffic::effective_road_step_seconds(&flow, &first_step),
        1.5625
    );
    let remaining_current_step = traffic::effective_road_step_seconds(&flow, &first_step)
        * (1.0 - spawned.transit.vehicles[0].step_progress);
    assert!((remaining_current_step - 0.78125).abs() < 1e-9);
    assert_eq!(spawned.transit.vehicles[0].step_progress, 0.5);
}

#[test]
fn arriving_car_contributes_to_bus_step_before_payload_is_cleared() {
    let state = bus_arrival_order_fixture();
    let current_path = state.transit.routes[0].legs[0].current_path.as_ref();
    assert!(current_path.is_some(), "bus route has a path");
    let Some(current_path) = current_path else {
        return;
    };
    let current_point = current_path.road_steps().first().map(|step| step.position);
    assert!(current_point.is_some(), "bus route has a road step");
    let Some(current_point) = current_point else {
        return;
    };

    let before_flow = traffic::derive_road_flow(&state);
    assert_eq!(before_flow.get(&current_point), Some(&5));
    let first_step = current_path
        .road_steps()
        .first()
        .expect("bus route has a first step");
    assert_eq!(
        traffic::effective_road_step_seconds(&before_flow, first_step),
        1.5625
    );

    let mut at_arrival_engine = common::running_engine_from_fixture(state.clone());
    at_arrival_engine.tick(1.25);
    let at_arrival = at_arrival_engine.snapshot();
    let bus = &at_arrival.transit.vehicles[0];
    assert_eq!(bus.path_step_index, 0);
    assert!((bus.step_progress - 0.8).abs() < 1e-9);
    assert_eq!(
        traffic::derive_road_flow(&at_arrival).get(&current_point),
        Some(&4)
    );
    let after_arrival_flow = traffic::derive_road_flow(&at_arrival);
    assert_eq!(
        traffic::effective_road_step_seconds(&after_arrival_flow, first_step),
        1.25
    );
    assert_eq!(at_arrival.metrics.completed_trips, 1);
    assert!(at_arrival
        .active_trips
        .iter()
        .all(|trip| trip.private_car_trip.is_some()));

    let flow = traffic::derive_road_flow(&at_arrival);
    let next_stop_seconds = transit::seconds_until_next_vehicle_stop(&at_arrival, &flow, bus);
    assert!(next_stop_seconds.is_some(), "bus has a next stop");
    if let Some(next_stop_seconds) = next_stop_seconds {
        assert!((next_stop_seconds - 6.5).abs() < 1e-9);
    }

    let mut coarse_engine = common::running_engine_from_fixture(state.clone());
    coarse_engine.tick(1.5);
    let coarse = coarse_engine.snapshot();

    let mut split_engine = common::running_engine_from_fixture(state);
    split_engine.tick(1.25);
    split_engine.tick(0.25);
    let split = split_engine.snapshot();

    assert_eq!(coarse.transit.vehicles[0], split.transit.vehicles[0]);
    assert_eq!(coarse.active_trips, split.active_trips);
    assert_eq!(
        coarse.metrics.completed_trips,
        split.metrics.completed_trips
    );
}

#[test]
fn staggered_car_arrivals_resolve_identically_in_coarse_and_split_ticks() {
    let state = staggered_car_arrival_fixture();
    let fixture_time = state.time;

    let mut coarse = common::running_engine_from_fixture(state.clone());
    coarse.tick(3.0);
    let coarse_snapshot = coarse.snapshot();

    let mut split = common::running_engine_from_fixture(state);
    for _ in 0..6 {
        split.tick(0.5);
    }
    let split_snapshot = split.snapshot();

    assert_eq!(coarse_snapshot.time, fixture_time + 3.0);
    assert_eq!(coarse_snapshot.time, split_snapshot.time);
    assert!(coarse_snapshot.active_trips.is_empty());
    assert!(split_snapshot.active_trips.is_empty());
    assert!(traffic::derive_road_flow(&coarse_snapshot).is_empty());
    assert!(traffic::derive_road_flow(&split_snapshot).is_empty());
    assert_eq!(coarse_snapshot.metrics.completed_trips, 5);
    assert_eq!(coarse_snapshot.metrics, split_snapshot.metrics);
}

#[test]
fn driving_trip_keeps_payload_and_flow_until_arrival_boundary() {
    let mut engine = common::running_engine_from_fixture(car_commute_fixture(&["sim-001"]));

    let result = engine.tick(0.0);
    assert!(result.rejection.is_none());
    let spawned = engine.snapshot();
    assert_eq!(spawned.active_trips.len(), 1);
    let arrival_time = spawned.active_trips[0]
        .private_car_trip
        .as_ref()
        .map(|car| car.arrival_time);
    assert!(arrival_time.is_some(), "car trip payload");
    let Some(arrival_time) = arrival_time else {
        return;
    };

    engine.tick(1.0);
    let before_arrival = engine.snapshot();
    assert_eq!(before_arrival.active_trips.len(), 1);
    let active = &before_arrival.active_trips[0];
    assert_eq!(active.status, TripStatus::Driving);
    assert!(active.private_car_trip.is_some());
    assert!(!caelum_core::traffic::derive_road_flow(&before_arrival).is_empty());

    engine.tick((arrival_time - before_arrival.time).max(0.0));
    let arrived = engine.snapshot();
    assert!(arrived.active_trips.is_empty());
    assert_eq!(arrived.metrics.completed_trips, 1);
    assert!(caelum_core::traffic::derive_road_flow(&arrived).is_empty());
}

#[test]
fn coarse_car_arrival_matches_ticks_split_at_arrival_boundary() {
    let base = car_commute_fixture(&["sim-001"]);

    let mut coarse = common::running_engine_from_fixture(base.clone());
    coarse.tick(12.0);
    let coarse_snapshot = coarse.snapshot();

    let mut fine = common::running_engine_from_fixture(base);
    for _ in 0..12 {
        fine.tick(1.0);
    }
    let fine_snapshot = fine.snapshot();

    assert_eq!(coarse_snapshot.time, fine_snapshot.time);
    assert_eq!(coarse_snapshot.active_trips, fine_snapshot.active_trips);
    assert_eq!(coarse_snapshot.sims, fine_snapshot.sims);
    assert_eq!(
        coarse_snapshot.metrics.completed_trips,
        fine_snapshot.metrics.completed_trips
    );
    assert_eq!(
        coarse_snapshot.metrics.late_trips,
        fine_snapshot.metrics.late_trips
    );
    assert_eq!(
        coarse_snapshot.metrics.unserved_trips,
        fine_snapshot.metrics.unserved_trips
    );
}

#[test]
fn missing_driving_payload_becomes_unserved_and_saveable() {
    let mut state = GameEngine::new().snapshot();
    state.sims = vec![worker_sim("sim-001", (2, 3).into(), None)];
    state.sims[0].next_activity = None; // the hand-authored trip owns the citizen
    state.active_trips = vec![driving_trip_without_payload()];

    let next = trips::advance_active_trips(&state, &traffic::RoadFlow::new(), 0.0);
    assert!(next.active_trips.is_empty());
    assert_eq!(next.metrics.unserved_trips, 1);
    assert_eq!(
        next.metrics.trip_outcomes[0].outcome,
        TripOutcomeKind::Unserved
    );

    let engine = GameEngine::from_snapshot(next);
    assert!(engine.is_ok(), "unserved result is persistence-valid");
    if let Ok(engine) = engine {
        let saved = engine.snapshot_for_save();
        assert!(saved.active_trips.is_empty());
    }
}

#[test]
fn walking_movement_scales_by_simulated_time() {
    let mut state = create_initial_snapshot();
    state.sims = vec![worker_sim("sim-001", (2, 3).into(), Some((5, 3).into()))];
    state.sims[0].next_activity = None; // the hand-authored trip owns the citizen
    state.active_trips = vec![trip(
        "trip-001",
        TripStatus::Idle,
        (2, 3).into(),
        (5, 3).into(),
    )];

    let next = trips::advance_active_trips(&state, &traffic::RoadFlow::new(), 1.0);
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

        let next = trips::advance_active_trips(&state, &traffic::RoadFlow::new(), 20.0);

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

    let next = trips::advance_active_trips(&state, &traffic::RoadFlow::new(), 10.0);

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

    let next = trips::advance_active_trips(&state, &traffic::RoadFlow::new(), 1.0);
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
    let _assigned = engine.dispatch(GameIntent::AssignVehicle {
        mode: "bus".to_string(),
        line_id: "route-001".to_string(),
    });
    let mut state = engine.snapshot();
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

    let next = transit::tick_vehicles(&state, &traffic::RoadFlow::new(), 0.0);

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

    let next = trips::advance_active_trips(&state, &traffic::RoadFlow::new(), 1.0);
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

    let next = trips::advance_active_trips(&state, &traffic::RoadFlow::new(), 2.0);

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
    on_time.sims = vec![worker_sim("sim-001", (2, 3).into(), Some((3, 3).into()))];
    on_time.sims[0].next_activity = None; // the hand-authored trip owns the citizen
    on_time.active_trips = vec![trip(
        "trip-001",
        TripStatus::Idle,
        (2, 3).into(),
        (3, 3).into(),
    )];
    let arrived = trips::advance_active_trips(&on_time, &traffic::RoadFlow::new(), 20.0);

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
    let late_next = trips::advance_active_trips(&late, &traffic::RoadFlow::new(), 1.0);

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

    let next = trips::advance_active_trips(&state, &traffic::RoadFlow::new(), 1.0);

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

    let next = trips::advance_active_trips(&state, &traffic::RoadFlow::new(), 1.0);

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
    state.sims = vec![travelling_worker_sim("sim-001", (2, 3).into())];
    let mut waiting = trip(
        "trip-001",
        TripStatus::Waiting,
        (7, 8).into(),
        (22, 8).into(),
    );
    waiting.route_plan = Some(bus_plan((7, 8).into(), (22, 8).into(), "route-001"));
    waiting.patience_remaining = 5.0;
    state.active_trips = vec![waiting];

    let mut engine = common::running_engine_from_fixture(state);
    let result = engine.tick(100.0);
    assert!(result.rejection.is_none());
    let next = engine.snapshot();

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

    let next = trips::advance_active_trips(&state, &traffic::RoadFlow::new(), 0.0);

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
    let _vehicle = engine.dispatch(GameIntent::AssignVehicle {
        mode: "bus".to_string(),
        line_id: "route-001".to_string(),
    });

    let mut state = engine.snapshot();
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
        current_leg_wait_seconds: 0.0,
        private_car_trip: None,
    }];
    state.transit.vehicles[0].passenger_ids = vec!["trip-001".to_string()];
    state.sims = vec![travelling_worker_sim("sim-001", (2, 3).into())];

    let mut coarse = common::running_engine_from_fixture(state.clone());
    coarse.tick(12.5);
    let coarse_snapshot = coarse.snapshot();

    let mut fine = common::running_engine_from_fixture(state);
    for _ in 0..10 {
        fine.tick(1.25);
    }
    let next = fine.snapshot();

    assert!(next.active_trips.is_empty());
    assert_eq!(next.metrics.completed_trips, 1);
    assert_eq!(next.metrics.trip_outcomes.len(), 1);
    assert_eq!(
        next.metrics.trip_outcomes[0].outcome,
        TripOutcomeKind::Arrived
    );
    assert!((next.metrics.trip_outcomes[0].time - 12.5).abs() < 0.000_001);

    // Coarse-tick equivalence: one 12.5s tick must match ten 1.25s ticks.
    assert!(coarse_snapshot.active_trips.is_empty());
    assert_eq!(
        coarse_snapshot.metrics.completed_trips,
        next.metrics.completed_trips
    );
    assert_eq!(
        coarse_snapshot.metrics.trip_outcomes.len(),
        next.metrics.trip_outcomes.len()
    );
    assert_eq!(
        coarse_snapshot.metrics.trip_outcomes[0].outcome,
        next.metrics.trip_outcomes[0].outcome
    );
    assert!(
        (coarse_snapshot.metrics.trip_outcomes[0].time - next.metrics.trip_outcomes[0].time).abs()
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
    let _vehicle = engine.dispatch(GameIntent::AssignVehicle {
        mode: "bus".to_string(),
        line_id: "route-001".to_string(),
    });

    let mut state = engine.snapshot();
    let starting_budget = state.budget;
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
        current_leg_wait_seconds: 0.0,
        private_car_trip: None,
    }];
    state.transit.vehicles[0].passenger_ids = vec!["trip-001".to_string()];
    state.sims = vec![travelling_worker_sim("sim-001", (2, 3).into())];

    let mut coarse = common::running_engine_from_fixture(state.clone());
    coarse.tick(12.5);
    let coarse_disembarked = coarse.snapshot();

    let mut fine = common::running_engine_from_fixture(state);
    for _ in 0..10 {
        fine.tick(1.25);
    }
    let disembarked = fine.snapshot();
    let walking = &disembarked.active_trips[0];

    assert_eq!(walking.status, TripStatus::Walking);
    assert_eq!(walking.current_leg_index, 1);
    assert_eq!(walking.position, (12, 4).into());
    assert!(walking
        .route_plan
        .as_ref()
        .is_some_and(|plan| { plan.legs.iter().any(|leg| leg.mode == TransitMode::Bus) }));
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

    let coarse_engine_arrival = coarse.tick(20.0);
    assert!(coarse_engine_arrival.rejection.is_none());
    let coarse_arrived = coarse.snapshot();
    let arrived_result = fine.tick(20.0);
    assert!(arrived_result.rejection.is_none());
    let arrived = fine.snapshot();

    assert_eq!(arrived.budget, starting_budget + 200);
    assert_eq!(coarse_arrived.budget, arrived.budget);
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
    let _vehicle = engine.dispatch(GameIntent::AssignVehicle {
        mode: "bus".to_string(),
        line_id: "route-001".to_string(),
    });

    let mut state = engine.snapshot();
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
        current_leg_wait_seconds: 0.0,
        private_car_trip: None,
    }];
    // Vehicle starts at the boarding stop with a free seat.
    assert_eq!(state.transit.vehicles[0].step_progress, 0.0);
    assert!(state.transit.vehicles[0].passenger_ids.is_empty());
    state.sims = vec![travelling_worker_sim("sim-001", (2, 3).into())];

    let mut coarse = common::running_engine_from_fixture(state.clone());
    coarse.tick(12.5);
    let coarse_disembarked = coarse.snapshot();

    let mut fine = common::running_engine_from_fixture(state);
    for _ in 0..10 {
        fine.tick(1.25);
    }
    let disembarked = fine.snapshot();
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

    fine.tick(20.0);
    let arrived = fine.snapshot();

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
    let _vehicle = engine.dispatch(GameIntent::AssignVehicle {
        mode: "bus".to_string(),
        line_id: "route-001".to_string(),
    });

    let mut state = engine.snapshot();
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
        current_leg_wait_seconds: 0.0,
        private_car_trip: None,
    }];
    state.transit.vehicles[0].passenger_ids = vec!["trip-001".to_string()];
    state.sims = vec![travelling_worker_sim("sim-001", (2, 3).into())];

    let seconds = transit::seconds_until_next_vehicle_stop(
        &state,
        &traffic::RoadFlow::new(),
        &state.transit.vehicles[0],
    )
    .expect("vehicle has a next stop");
    let mut engine = common::running_engine_from_fixture(state);
    let result = engine.tick(seconds);
    assert!(result.rejection.is_none());
    let next = engine.snapshot();

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
    let _vehicle = engine.dispatch(GameIntent::AssignVehicle {
        mode: "bus".to_string(),
        line_id: "route-001".to_string(),
    });

    let mut state = engine.snapshot();
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
        current_leg_wait_seconds: 0.0,
        private_car_trip: None,
    }];
    state.transit.vehicles[0].passenger_ids = vec!["trip-001".to_string()];

    let next = transit::tick_vehicles(&state, &traffic::RoadFlow::new(), 0.5);

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
        routine: CitizenRoutine::Worker {
            shift_template: "standard".to_string(),
            workplace: Some(workplace),
        },
        // The cross-midnight outbound still owns the citizen.
        next_activity: None,
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
        current_leg_wait_seconds: 0.0,
        private_car_trip: None,
    }];

    let arrived = trips::advance_active_trips(&state, &traffic::RoadFlow::new(), 0.0);
    let sim = arrived.sims.iter().find(|sim| sim.id == "sim-001").unwrap();
    assert!(arrived.active_trips.is_empty());
    assert_eq!(sim.position, workplace);
    assert_eq!(
        sim.next_activity.as_ref().map(|activity| activity.kind),
        Some(ScheduledActivityKind::DailyRoutine),
        "the cross-midnight arrival defers to the next daily routine"
    );

    // Give the stranded worker a real placed workplace so the state matches
    // what gameplay can produce.
    let mut with_destination = arrived.clone();
    place_destination(&mut with_destination, "workplace", Point { x: 8, y: 3 });

    // Immediately after the cross-midnight arrival no return has unlocked:
    // the citizen defers to the daily routine, whose wake is still ahead.
    let mut engine = common::running_engine_from_fixture(with_destination);
    let result = engine.tick(10.0);
    assert!(result.rejection.is_none());
    let ticked = engine.snapshot();
    assert!(!ticked
        .active_trips
        .iter()
        .any(|trip| trip.sim_id == "sim-001" && trip.purpose == TripPurpose::CommuteReturn));

    // At the day-1 routine wake the away-from-home guard resolves the citizen
    // into today's return window instead of an outbound from the workplace.
    let return_minute = commute::departure_minute_for_sim("sim-001", "standard", "return");
    let return_time = clock::GAME_DAY_SECONDS
        + (f64::from(return_minute) / f64::from(clock::MINUTES_PER_DAY)) * clock::GAME_DAY_SECONDS;
    let result = engine.tick(return_time - ticked.time + 1.0);
    assert!(result.rejection.is_none());
    let ticked = engine.snapshot();

    assert!(
        !ticked
            .active_trips
            .iter()
            .any(|trip| trip.sim_id == "sim-001" && trip.purpose == TripPurpose::CommuteOutbound),
        "the cross-midnight arrival must not produce a day-1 outbound from the workplace"
    );
    let recovery_return = ticked
        .active_trips
        .iter()
        .find(|trip| trip.sim_id == "sim-001" && trip.purpose == TripPurpose::CommuteReturn)
        .expect("today's return window brings the stranded citizen home");
    assert_eq!(recovery_return.origin, Point { x: 8, y: 3 });
    assert_eq!(recovery_return.destination, Point { x: 2, y: 3 });
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
        routine: CitizenRoutine::Worker {
            shift_template: "standard".to_string(),
            workplace: Some((3, 3).into()),
        },
        // Waiting at the workplace for today's return wake.
        next_activity: Some(ScheduledActivity {
            kind: ScheduledActivityKind::PrimaryReturn,
            due_time: return_time,
        }),
    }];

    let mut engine = common::running_engine_from_fixture(state);
    let result = engine.tick(20.0);
    assert!(result.rejection.is_none());
    let arrived = engine.snapshot();
    let sim = arrived.sims.iter().find(|sim| sim.id == "sim-001").unwrap();

    assert!(arrived.active_trips.is_empty());
    assert_eq!(arrived.metrics.completed_trips, 1);
    assert_eq!(sim.position, Point { x: 2, y: 3 });
    assert_eq!(
        sim.next_activity.as_ref().map(|activity| activity.kind),
        Some(ScheduledActivityKind::DailyRoutine),
        "the completed return hands the citizen back to tomorrow's routine"
    );

    let again_result = engine.tick(0.0);
    assert!(again_result.rejection.is_none());
    let ticked_again = engine.snapshot();

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
    // An in-bounds workplace: the map is 28 tiles wide, so the original x=28
    // point was not persistence-valid.
    let workplace = Point { x: 27, y: 17 };
    state.time = departure_time;
    state.day = 0;
    state.clock_minutes = departure_minute;
    state.paused = false;
    state.sims = vec![travelling_worker_sim("sim-001", home)];
    state.active_trips = vec![ActiveTrip {
        id: "trip-day-0-trip-001".to_string(),
        sim_id: "sim-001".to_string(),
        purpose: TripPurpose::CommuteOutbound,
        origin: home,
        destination: workplace,
        position: Point { x: 7, y: 8 }.into(),
        status: TripStatus::Waiting,
        deadline: departure_time + 900.0,
        route_plan: Some(bus_plan(Point { x: 7, y: 8 }, workplace, "route-001")),
        current_leg_index: 0,
        patience_remaining: 1.0,
        current_leg_wait_seconds: 0.0,
        private_car_trip: None,
    }];

    let mut engine = common::running_engine_from_fixture(state);
    let result = engine.tick(2.0);
    assert!(result.rejection.is_none());
    let next = engine.snapshot();
    let sim = next.sims.iter().find(|sim| sim.id == "sim-001").unwrap();

    assert!(next.active_trips.is_empty());
    assert_eq!(next.metrics.unserved_trips, 1);
    assert_eq!(next.metrics.trip_outcomes.len(), 1);
    assert_eq!(
        sim.next_activity.as_ref().map(|activity| activity.kind),
        Some(ScheduledActivityKind::DailyRoutine),
        "the unserved outbound defers to the next daily routine"
    );
}

#[test]
fn unserved_same_day_return_is_not_respawned_after_pruning() {
    let mut state = create_initial_snapshot();
    let return_minute = commute::departure_minute_for_sim("sim-001", "standard", "return");
    let return_time =
        (f64::from(return_minute) / f64::from(clock::MINUTES_PER_DAY)) * clock::GAME_DAY_SECONDS;
    let home = Point { x: 2, y: 3 };
    // An in-bounds workplace: the map is 28 tiles wide, so the original x=28
    // point was not persistence-valid.
    let workplace = Point { x: 27, y: 17 };
    state.time = return_time;
    state.day = 0;
    state.clock_minutes = return_minute;
    state.paused = false;
    state.sims = vec![Sim {
        id: "sim-001".to_string(),
        home,
        position: workplace,
        routine: CitizenRoutine::Worker {
            shift_template: "standard".to_string(),
            workplace: Some(workplace),
        },
        // The hand-authored return trip owns the citizen.
        next_activity: None,
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
        route_plan: Some(bus_plan(workplace, home, "route-001")),
        current_leg_index: 0,
        patience_remaining: 1.0,
        current_leg_wait_seconds: 0.0,
        private_car_trip: None,
    }];

    let mut engine = common::running_engine_from_fixture(state);
    let result = engine.tick(2.0);
    assert!(result.rejection.is_none());
    let next = engine.snapshot();
    let sim = next.sims.iter().find(|sim| sim.id == "sim-001").unwrap();

    assert!(next.active_trips.is_empty());
    assert_eq!(next.metrics.unserved_trips, 1);
    assert_eq!(next.metrics.trip_outcomes.len(), 1);
    assert_eq!(
        sim.next_activity.as_ref().map(|activity| activity.kind),
        Some(ScheduledActivityKind::DailyRoutine),
        "the unserved return hands the citizen back to tomorrow's routine"
    );
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
    place_destination(&mut state, "workplace", workplace);
    // Sim stranded at the workplace after day-0 return was unserved: the
    // resolution handler scheduled next day's routine wake, and the citizen
    // waits away from home.
    state.sims = vec![Sim {
        id: "sim-001".to_string(),
        home,
        position: workplace,
        routine: CitizenRoutine::Worker {
            shift_template: "standard".to_string(),
            workplace: Some(workplace),
        },
        next_activity: Some(ScheduledActivity {
            kind: ScheduledActivityKind::DailyRoutine,
            due_time: day1_departure,
        }),
    }];
    state.active_trips = Vec::new();

    let mut engine = common::running_engine_from_fixture(state);
    let result = engine.tick(1.0);
    assert!(result.rejection.is_none());
    let next = engine.snapshot();
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
    // The sim is away from home, so the daily routine resolved into today's
    // return wake to bring them home instead of an outbound.
    assert_eq!(
        sim.next_activity.as_ref().map(|activity| activity.kind),
        Some(ScheduledActivityKind::PrimaryReturn),
    );
    assert_eq!(sim.position, workplace);
}

#[test]
fn return_trip_in_progress_across_midnight_does_not_trigger_stranded_guard() {
    // Regression: when a return trip from the previous day is still in
    // progress at the midnight rollover, `sim.position` is still the workplace
    // (position is only updated on trip arrival). The daily-routine stranded
    // guard must NOT treat the citizen as stranded — they are in transit,
    // owned by that trip, and carry no daily-routine wake that could fire.
    let mut state = create_initial_snapshot();
    let home = Point { x: 2, y: 3 };
    let workplace = Point { x: 8, y: 3 };
    state.time = clock::GAME_DAY_SECONDS + 1.0;
    state.day = 1;
    state.clock_minutes = clock::clock_minutes(state.time);
    state.paused = false;
    place_destination(&mut state, "workplace", workplace);
    // The in-progress return owns the citizen: no next activity, so the
    // daily-routine stranded guard cannot fire for them.
    state.sims = vec![Sim {
        id: "sim-001".to_string(),
        home,
        position: workplace,
        routine: CitizenRoutine::Worker {
            shift_template: "standard".to_string(),
            workplace: Some(workplace),
        },
        next_activity: None,
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
        current_leg_wait_seconds: 0.0,
        private_car_trip: None,
    }];

    let mut engine = common::running_engine_from_fixture(state);
    let result = engine.tick(1.0);
    assert!(result.rejection.is_none());
    let next = engine.snapshot();
    let sim = next.sims.iter().find(|sim| sim.id == "sim-001").unwrap();

    // The stranded guard must not fire while a return trip is in progress:
    // the citizen is still travelling, owned by that trip.
    assert!(
        sim.next_activity.is_none(),
        "a citizen mid-return must stay travelling, not scheduled"
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
    place_destination(&mut state, "workplace", workplace);
    state.sims = vec![Sim {
        id: "sim-003".to_string(),
        home,
        position: workplace,
        routine: CitizenRoutine::Worker {
            shift_template: "standard".to_string(),
            workplace: Some(workplace),
        },
        // The cross-midnight return owns the citizen until it lands home.
        next_activity: None,
    }];
    // Active return trip from day 0, walking home, 1 tile away from arrival.
    state.active_trips = vec![ActiveTrip {
        id: "trip-day-0-trip-001".to_string(),
        sim_id: "sim-003".to_string(),
        purpose: TripPurpose::CommuteReturn,
        origin: workplace,
        destination: home,
        position: Point { x: 3, y: 3 }.into(),
        status: TripStatus::Walking,
        deadline: 2_000.0,
        route_plan: Some(walk_plan(Point { x: 3, y: 3 }, home, 20.0)),
        current_leg_index: 0,
        patience_remaining: 240.0,
        current_leg_wait_seconds: 0.0,
        private_car_trip: None,
    }];

    // Drive the tick to just past the day-1 return departure so the return
    // trip has spawned but has not yet completed (1s of a 120s walk).
    let return_minute = commute::departure_minute_for_sim("sim-003", "standard", "return");
    let day1_return_time = clock::GAME_DAY_SECONDS
        + (f64::from(return_minute) / f64::from(clock::MINUTES_PER_DAY)) * clock::GAME_DAY_SECONDS;
    let fixture_time = state.time;
    let mut engine = common::running_engine_from_fixture(state);
    let result = engine.tick(day1_return_time - fixture_time + 1.0);
    assert!(result.rejection.is_none());
    let next = engine.snapshot();

    let sim = next.sims.iter().find(|sim| sim.id == "sim-003").unwrap();

    // The day-1 outbound should have spawned and arrived (the sim was at home
    // after the cross-midnight return arrived, before the outbound departure).
    // Without the exact-time chain, the outbound would never run after the
    // cross-midnight return brought the sim home, and the return would spawn
    // from home instead.
    assert_eq!(
        sim.position, workplace,
        "day-1 outbound should have arrived after the cross-midnight return brought the sim home"
    );

    // A legitimate day-1 return originates at the workplace (after the
    // outbound arrives) and is still in progress; a phantom home→home return
    // would have completed instantly at the workplace.
    let active_return = next
        .active_trips
        .iter()
        .find(|trip| trip.sim_id == "sim-003" && trip.purpose == TripPurpose::CommuteReturn);
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
        routine: CitizenRoutine::Worker {
            shift_template: "standard".to_string(),
            workplace: Some((3, 3).into()),
        },
        // Waiting at the workplace for today's return wake.
        next_activity: Some(ScheduledActivity {
            kind: ScheduledActivityKind::PrimaryReturn,
            due_time: return_time,
        }),
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
        current_leg_wait_seconds: 0.0,
        private_car_trip: None,
    }];
    // The injected walking trip references sim-002; keep it dormant so the
    // spawn pass never adds commute traffic for it.
    state
        .sims
        .push(travelling_worker_sim("sim-002", (8, 3).into()));

    let mut engine = common::running_engine_from_fixture(state);
    let result = engine.tick(0.0);
    assert!(result.rejection.is_none());
    let next = engine.snapshot();

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
    state.sims = vec![travelling_worker_sim("sim-001", (2, 3).into())];
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

    let mut engine = common::running_engine_from_fixture(state);
    let result = engine.tick(60.0);
    assert!(result.rejection.is_none());
    let next = engine.snapshot();

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

    let mut large = common::running_engine_from_fixture(state.clone());
    large.tick(60.0);
    let large_snapshot = large.snapshot();

    let mut stepped = common::running_engine_from_fixture(state);
    for _ in 0..60 {
        stepped.tick(1.0);
    }
    let stepped_snapshot = stepped.snapshot();

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
    state.sims = vec![travelling_worker_sim("sim-001", (2, 3).into())];

    let mut engine = common::running_engine_from_fixture(state);
    let result = engine.tick(1.0);
    assert!(result.rejection.is_none());
    let next = engine.snapshot();

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
    state.sims = vec![travelling_worker_sim("sim-001", (2, 3).into())];

    let mut engine = common::running_engine_from_fixture(state);
    let result = engine.tick(30.0);
    assert!(result.rejection.is_none());
    let next = engine.snapshot();

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
    let mut large = common::running_engine_from_fixture(start.clone());
    large.tick(100.0);
    let large_snapshot = large.snapshot();

    let mut stepped = common::running_engine_from_fixture(start);
    for _ in 0..100 {
        stepped.tick(1.0);
    }
    let stepped_snapshot = stepped.snapshot();

    assert_eq!(
        large_snapshot.metrics.unserved_trips,
        stepped_snapshot.metrics.unserved_trips
    );
    assert!(
        (large_snapshot.metrics.total_wait_seconds - stepped_snapshot.metrics.total_wait_seconds)
            .abs()
            < 0.001,
        "large wait {}s != stepped wait {}s",
        large_snapshot.metrics.total_wait_seconds,
        stepped_snapshot.metrics.total_wait_seconds
    );
    assert_eq!(large_snapshot.metrics.trip_outcomes.len(), 1);
    assert_eq!(
        large_snapshot.metrics.trip_outcomes[0].outcome,
        TripOutcomeKind::Unserved
    );
    // The trip drained 30s of patience this tick (patience_remaining was 30s).
    assert!(
        (large_snapshot.metrics.total_wait_seconds - 30.0).abs() < 0.001,
        "expected 30s accrued wait, got {}",
        large_snapshot.metrics.total_wait_seconds
    );
    // Outcome fires at patience boundary: start (100s) + 30s drained.
    assert!(
        (large_snapshot.metrics.trip_outcomes[0].time - 130.0).abs() < 0.001,
        "expected outcome at t=130, got {}",
        large_snapshot.metrics.trip_outcomes[0].time
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
    state.sims = vec![travelling_worker_sim("sim-001", (2, 3).into())];

    let mut engine = common::running_engine_from_fixture(state);
    let result = engine.tick(70.0);
    assert!(result.rejection.is_none());
    let next = engine.snapshot();

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
    state.sims = vec![travelling_worker_sim("sim-001", (2, 3).into())];

    // A 200s coarse tick: the aggregate average crosses 180s at t=31s, well
    // before Trip A's patience expiry at t=61s. Without the aggregate boundary
    // the crossing is missed and the loss is never detected.
    let mut engine = common::running_engine_from_fixture(state);
    let result = engine.tick(200.0);
    assert!(result.rejection.is_none());
    let next = engine.snapshot();

    assert_eq!(next.metrics.state, MetricsState::Lost);
    assert_eq!(
        next.metrics.loss_reason.as_deref(),
        Some("Average wait time is too high")
    );
}

fn assert_average_wait_loss_matches_coarse_and_fine(state: &caelum_core::GameSnapshot) {
    let mut coarse = common::running_engine_from_fixture(state.clone());
    coarse.tick(300.0);
    let coarse_snapshot = coarse.snapshot();

    let mut fine = common::running_engine_from_fixture(state.clone());
    fine.tick(1.0);
    let fine_snapshot = fine.snapshot();

    assert_eq!(coarse_snapshot.metrics.state, MetricsState::Lost);
    assert_eq!(fine_snapshot.metrics.state, MetricsState::Lost);
    assert_eq!(
        coarse_snapshot.metrics.loss_reason.as_deref(),
        Some("Average wait time is too high")
    );
    assert_eq!(
        coarse_snapshot.metrics.loss_reason,
        fine_snapshot.metrics.loss_reason
    );
    assert_eq!(coarse_snapshot.time, fine_snapshot.time);
    assert!(
        (coarse_snapshot.time - 0.000_002).abs() < 1e-12,
        "expected strict-threshold sample at t=0.000002, got {}",
        coarse_snapshot.time
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
    state.sims = vec![travelling_worker_sim("sim-001", (2, 3).into())];

    assert_average_wait_loss_matches_coarse_and_fine(&state);
}

#[test]
fn coarse_tick_samples_per_trip_wait_when_zero_threshold_is_already_equal() {
    let mut state = common::campaign_state();
    state.paused = false;
    state.scenario.objectives.as_mut().unwrap().max_average_wait =
        MaxAverageWaitSeconds::new(0.0).unwrap();

    // A just-spawned waiting trip with a full patience budget has zero
    // elapsed wait, so both the per-trip terminal tracker and the aggregate
    // tracker sit exactly on the 0s threshold — the strict-threshold sample
    // (one epsilon past the `>` gate) must still be scheduled. (The old
    // construction parked the trip in Idle with a plan, which the persistence
    // boundary rightly rejects as unsavable state.)
    let mut just_spawned = trip(
        "trip-001",
        TripStatus::Waiting,
        (7, 8).into(),
        (22, 8).into(),
    );
    just_spawned.route_plan = Some(bus_plan((7, 8).into(), (22, 8).into(), "route-001"));
    state.active_trips = vec![just_spawned];
    state.sims = vec![travelling_worker_sim("sim-001", (2, 3).into())];

    assert_average_wait_loss_matches_coarse_and_fine(&state);
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
    state.sims = vec![travelling_worker_sim("sim-001", (2, 3).into())];

    let mut engine = common::running_engine_from_fixture(state);
    let result = engine.tick(400.0);
    assert!(result.rejection.is_none());
    let next = engine.snapshot();

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
        state.sims = vec![travelling_worker_sim("sim-001", (2, 3).into())];
        state
    }

    let mut coarse = common::running_engine_from_fixture(build());
    coarse.tick(700.0);
    let coarse_snapshot = coarse.snapshot();

    let mut fine = common::running_engine_from_fixture(build());
    // Bound the fine-grained loop so a regression that never reaches a terminal
    // state fails the test instead of hanging CI. 700 seconds of game time at
    // 1-second ticks is the same horizon as the coarse tick; the cap is generous
    // beyond that to absorb substep re-evaluations.
    const MAX_FINE_TICKS: usize = 2_000;
    let mut iterations = 0;
    while fine.snapshot().metrics.state == MetricsState::Running {
        iterations += 1;
        assert!(
            iterations <= MAX_FINE_TICKS,
            "fine-grained loop did not reach a terminal state within {MAX_FINE_TICKS} ticks"
        );
        fine.tick(1.0);
    }
    let fine_snapshot = fine.snapshot();
    assert_ne!(
        fine_snapshot.metrics.state,
        MetricsState::Running,
        "fine-grained loop must reach a terminal state"
    );

    assert_eq!(coarse_snapshot.metrics.state, MetricsState::Lost);
    assert_eq!(
        coarse_snapshot.metrics.loss_reason,
        fine_snapshot.metrics.loss_reason
    );
    assert_eq!(coarse_snapshot.time, fine_snapshot.time);
    assert_eq!(
        coarse_snapshot.metrics.unserved_trips,
        fine_snapshot.metrics.unserved_trips
    );
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
    let mut coarse = common::running_engine_from_fixture(state.clone());
    coarse.tick(15.0);
    let coarse_snapshot = coarse.snapshot();

    assert_eq!(coarse_snapshot.metrics.state, MetricsState::Lost);
    assert_eq!(
        coarse_snapshot.metrics.loss_reason.as_deref(),
        Some("Too many unserved citizens")
    );

    // Fine ticks must also detect the loss, confirming the coarse tick's
    // terminal state is not a divergence from the granularity-independent
    // invariant.
    let mut fine = common::running_engine_from_fixture(state);
    let mut iterations = 0;
    while fine.snapshot().metrics.state == MetricsState::Running {
        iterations += 1;
        assert!(
            iterations <= 100,
            "fine-grained loop did not reach a terminal state within 100 ticks"
        );
        fine.tick(1.0);
    }
    let fine_snapshot = fine.snapshot();
    assert_eq!(fine_snapshot.metrics.state, MetricsState::Lost);
    assert_eq!(
        coarse_snapshot.metrics.loss_reason,
        fine_snapshot.metrics.loss_reason
    );
}

// === Stage B: Student, day-off, and bounded optional demand ===

fn scheduled_time_seconds(day: u32, minute: u16) -> f64 {
    f64::from(day) * clock::GAME_DAY_SECONDS
        + (f64::from(minute) / f64::from(clock::MINUTES_PER_DAY)) * clock::GAME_DAY_SECONDS
}

/// Zoned, persistence-valid building placement for the Stage-B fixtures
/// (`width` x 2 footprint, matching the canonical catalog shapes).
fn place_stage_b_building(
    state: &mut GameSnapshot,
    id: &str,
    building_type: &str,
    origin: Point,
    width: i32,
    area: &str,
) {
    for y in origin.y..origin.y + 2 {
        for x in origin.x..origin.x + width {
            let tile = state
                .map
                .tile_mut(Point { x, y })
                .expect("fixture tile exists");
            tile.area = Some(area.to_string());
        }
    }
    state.buildings.push(PlacedBuilding {
        id: id.to_string(),
        building_type: building_type.to_string(),
        origin,
        rotation: 0,
        occupied_tiles: (origin.x..origin.x + width)
            .flat_map(|x| [Point { x, y: origin.y }, Point { x, y: origin.y + 1 }])
            .collect(),
        placed_at: 0.0,
        transit_node_id: None,
    });
}

/// A quiet one-corridor sandbox with a school and one optional site (the
/// only eligible outing building), starting at `start`. No housing, so no
/// move-ins disturb the pinned flows; citizens are handed in directly.
fn stage_b_fixture(sims: Vec<Sim>, start: f64) -> GameSnapshot {
    let mut state = create_initial_snapshot();
    clear_roads(&mut state);
    common::corridor(
        &mut state,
        &(3..=24).map(|x| Point { x, y: 8 }).collect::<Vec<_>>(),
        None,
    );
    place_stage_b_building(
        &mut state,
        "building-school",
        "school",
        Point { x: 6, y: 10 },
        3,
        "civic",
    );
    place_stage_b_building(
        &mut state,
        "building-market",
        "supermarket",
        Point { x: 18, y: 10 },
        2,
        "commercial",
    );
    state.sims = sims;
    state.time = start;
    state.day = clock::day_index(start);
    state.clock_minutes = clock::clock_minutes(start);
    state.paused = false;
    state
}

fn stage_b_student(day0_wake: f64) -> Sim {
    Sim {
        id: "sim-010".to_string(),
        home: Point { x: 2, y: 7 },
        position: Point { x: 2, y: 7 },
        routine: CitizenRoutine::Student,
        next_activity: Some(ScheduledActivity {
            kind: ScheduledActivityKind::DailyRoutine,
            due_time: day0_wake,
        }),
    }
}

fn stage_b_worker(id: &str, wake: f64, workplace: Option<Point>) -> Sim {
    Sim {
        id: id.to_string(),
        home: Point { x: 2, y: 7 },
        position: Point { x: 2, y: 7 },
        routine: CitizenRoutine::Worker {
            shift_template: "standard".to_string(),
            workplace,
        },
        next_activity: Some(ScheduledActivity {
            kind: ScheduledActivityKind::DailyRoutine,
            due_time: wake,
        }),
    }
}

/// The first citizen id whose day off is `day` and whose optional-outing
/// eligibility on that day matches `eligible`. Pure derivation over the
/// published deterministic helpers, so the fixtures stay reproducible.
fn day_off_citizen(day: u32, eligible: bool) -> String {
    (1..=1000)
        .map(|suffix| format!("sim-{suffix:03}"))
        .find(|id| {
            commute::is_day_off(id, day)
                && commute::stable_daily_seed(id, day, commute::OPTIONAL_SALT).is_multiple_of(4)
                    == eligible
        })
        .expect("a matching citizen exists within the first 1000 ids")
}

/// Drive two engines from the same fixture to `end` — one coarse tick, 1s
/// steps — and assert every Stage-B observable matches.
fn assert_stage_b_equivalence(base: GameSnapshot, end: f64) -> GameSnapshot {
    let mut coarse = common::running_engine_from_fixture(base.clone());
    coarse.tick(end - base.time);
    let coarse_snapshot = coarse.snapshot();

    let mut fine = common::running_engine_from_fixture(base);
    while fine.snapshot().time + 1.0 <= end {
        fine.tick(1.0);
    }
    fine.tick(end - fine.snapshot().time);
    let fine_snapshot = fine.snapshot();

    assert!(
        (coarse_snapshot.time - fine_snapshot.time).abs() < 1e-6,
        "coarse {} vs fine {}",
        coarse_snapshot.time,
        fine_snapshot.time
    );
    assert_eq!(
        coarse_snapshot.sims.len(),
        fine_snapshot.sims.len(),
        "citizen sets diverge"
    );
    for (left, right) in coarse_snapshot.sims.iter().zip(&fine_snapshot.sims) {
        assert_eq!(left.id, right.id);
        assert_eq!(left.routine, right.routine);
        assert_eq!(left.home, right.home);
        assert_eq!(left.next_activity, right.next_activity);
        assert_eq!(
            left.position, right.position,
            "{} position diverges",
            left.id
        );
    }
    assert_eq!(
        coarse_snapshot.active_trips.len(),
        fine_snapshot.active_trips.len(),
        "active trip sets diverge"
    );
    for (left, right) in coarse_snapshot
        .active_trips
        .iter()
        .zip(&fine_snapshot.active_trips)
    {
        assert_eq!(left.id, right.id);
        assert_eq!(left.purpose, right.purpose);
        assert_eq!(left.status, right.status);
        assert_eq!(left.destination, right.destination);
        assert!(
            (left.position.x - right.position.x).abs() < 1e-6
                && (left.position.y - right.position.y).abs() < 1e-6
        );
    }
    assert_eq!(
        coarse_snapshot.metrics.completed_trips,
        fine_snapshot.metrics.completed_trips
    );
    assert_eq!(
        coarse_snapshot.metrics.late_trips,
        fine_snapshot.metrics.late_trips
    );
    assert_eq!(
        coarse_snapshot.metrics.unserved_trips,
        fine_snapshot.metrics.unserved_trips
    );
    coarse_snapshot
}

#[test]
fn student_school_commute_matches_across_coarse_and_fine_ticks() {
    let outbound_minute = commute::student_departure_minute("sim-010", "outbound");
    let return_minute = commute::student_departure_minute("sim-010", "return");
    let start = scheduled_time_seconds(0, outbound_minute) - 5.0;
    let return_time = scheduled_time_seconds(0, return_minute);
    let base = stage_b_fixture(vec![stage_b_student(start)], start);

    // Stepped observation: the outbound heads to a school footprint tile and
    // its arrival hands the student to the 15:00–16:00 return window.
    let mut observer = common::running_engine_from_fixture(base.clone());
    observer.tick(5.0);
    let observer_snapshot = observer.snapshot();
    let outbound = observer_snapshot
        .active_trips
        .iter()
        .find(|trip| trip.sim_id == "sim-010" && trip.purpose == TripPurpose::CommuteOutbound)
        .expect("school-day outbound spawns at the student window")
        .clone();
    let school_tiles: Vec<Point> = observer_snapshot
        .buildings
        .iter()
        .filter(|building| building.building_type == "school")
        .flat_map(|building| building.occupied_tiles.iter().copied())
        .collect();
    assert!(school_tiles.contains(&outbound.destination));

    let mut observer = common::running_engine_from_fixture(base.clone());
    observer.tick(return_time - start - 1.0);
    let waiting = observer.snapshot();
    let student = waiting.sims.iter().find(|sim| sim.id == "sim-010").unwrap();
    assert_eq!(student.position, outbound.destination);
    assert_eq!(
        student.next_activity.clone(),
        Some(ScheduledActivity {
            kind: ScheduledActivityKind::PrimaryReturn,
            due_time: return_time,
        }),
        "arrival at school schedules the afternoon return wake"
    );

    // Full-day granularity equivalence through outbound, return, and home.
    let coarse = assert_stage_b_equivalence(base, return_time + 400.0);
    let student = coarse.sims.iter().find(|sim| sim.id == "sim-010").unwrap();
    assert_eq!(student.position, student.home, "the student is home again");
    assert_eq!(
        student.next_activity.as_ref().map(|activity| activity.kind),
        Some(ScheduledActivityKind::DailyRoutine),
        "the completed return hands the student to the next school morning"
    );
}

#[test]
fn day_off_suppresses_primary_demand_and_matches_across_granularity() {
    // A worker whose day off is day 1 and who is NOT eligible for an outing
    // that day: the day passes without their primary outbound despite the
    // assigned workplace, and the commute resumes on day 2.
    let id = day_off_citizen(1, false);
    let wake = scheduled_time_seconds(
        1,
        commute::departure_minute_for_sim(&id, "standard", "outbound"),
    );
    // The workplace is a school tile: a job building that is not an optional
    // site, so the day off cannot produce any demand at all.
    let base = stage_b_fixture(
        vec![stage_b_worker(&id, wake, Some(Point { x: 6, y: 10 }))],
        scheduled_time_seconds(1, 0),
    );

    // Falsifying observation: the day off itself must produce nothing. The
    // fixture's only demand source is this citizen, so a deleted suppression
    // (a day-1 commute from the assigned workplace) would show up as an
    // in-flight trip or a nonzero counter by day 2's start.
    let mut day1 = common::running_engine_from_fixture(base.clone());
    day1.tick(scheduled_time_seconds(2, 0) - base.time);
    let day1_snapshot = day1.snapshot();
    assert!(
        day1_snapshot
            .active_trips
            .iter()
            .all(|trip| trip.sim_id != id),
        "the day-off citizen has no trip in flight on their day off"
    );
    assert_eq!(
        (
            day1_snapshot.metrics.completed_trips,
            day1_snapshot.metrics.unserved_trips,
            day1_snapshot.metrics.waiting_trip_count,
        ),
        (0, 0, 0),
        "the day-off citizen contributes no completed, unserved, or waiting trips"
    );

    // End on day 2's evening: after the resumed commute's return, before the
    // day-3 wake.
    let coarse = assert_stage_b_equivalence(base, wake + 2.0 * clock::GAME_DAY_SECONDS - 200.0);

    let worker = coarse
        .sims
        .iter()
        .find(|sim| sim.id == id)
        .expect("worker persists");
    assert_eq!(
        worker.next_activity.as_ref().map(|activity| activity.kind),
        Some(ScheduledActivityKind::DailyRoutine),
        "the day-off citizen hands back to the daily routine"
    );
    assert!(
        coarse
            .metrics
            .completed_trips
            .max(coarse.metrics.unserved_trips)
            >= 1,
        "day 2's commute proves the suppression was day-off specific"
    );
}

#[test]
fn optional_outing_dwell_and_return_match_across_coarse_and_fine_ticks() {
    // A day-off citizen eligible for the outing: outbound in 11:00–15:00,
    // exactly 120 in-game minutes of dwell, then the return home.
    let day = 0_u32;
    let id = day_off_citizen(day, true);
    let morning_wake = scheduled_time_seconds(
        day,
        commute::departure_minute_for_sim(&id, "standard", "outbound"),
    );
    let base = stage_b_fixture(
        vec![stage_b_worker(&id, morning_wake, None)],
        morning_wake - 5.0,
    );

    // Stepped observation of the dwell boundary: the outing outbound's
    // resolution schedules the OptionalReturn exactly 120 in-game minutes
    // after the resolved-at time.
    let mut stepped = common::running_engine_from_fixture(base.clone());
    let mut saw_outing = false;
    let mut dwell_boundary = None;
    for _ in 0..2_000 {
        stepped.tick(1.0);
        let snapshot = stepped.snapshot();
        saw_outing |= snapshot
            .active_trips
            .iter()
            .any(|trip| trip.sim_id == id && trip.purpose == TripPurpose::OptionalOutbound);
        if !saw_outing {
            continue;
        }
        let outing_active = snapshot
            .active_trips
            .iter()
            .any(|trip| trip.sim_id == id && trip.purpose == TripPurpose::OptionalOutbound);
        let wake = snapshot
            .sims
            .iter()
            .find(|sim| sim.id == id)
            .and_then(|sim| sim.next_activity.clone());
        if !outing_active {
            let activity = wake.expect("an idle day-off citizen carries their next wake");
            assert_eq!(activity.kind, ScheduledActivityKind::OptionalReturn);
            dwell_boundary = Some((snapshot.time, activity.due_time));
            break;
        }
    }
    let (observed_at, return_due) =
        dwell_boundary.expect("the outing outbound resolves into an OptionalReturn wake");
    assert!(
        (return_due - observed_at - 100.0).abs() < 1.0,
        "OptionalReturn dwell is 120 in-game minutes (observed within one 1s step): {} - {}",
        return_due,
        observed_at
    );

    let coarse = assert_stage_b_equivalence(base, return_due + clock::GAME_DAY_SECONDS / 2.0);
    let citizen = coarse.sims.iter().find(|sim| sim.id == id).unwrap();
    assert_eq!(citizen.position, citizen.home, "the outing ends at home");
    assert_eq!(
        citizen.next_activity.as_ref().map(|activity| activity.kind),
        Some(ScheduledActivityKind::DailyRoutine)
    );
    assert!(
        coarse.active_trips.iter().all(|trip| trip.sim_id != id),
        "at most one outing: nothing else stays active"
    );
}

#[test]
fn failed_optional_return_recovers_at_the_next_daily_routine() {
    // A hand-authored OptionalReturn that cannot be served: the citizen waits
    // at the outing site with no same-timestamp retry, and the next day's
    // routine wake resolves them into a return home.
    fn failed_return_fixture() -> GameSnapshot {
        let home = Point { x: 2, y: 7 };
        let site = Point { x: 18, y: 10 };
        let mut state = stage_b_fixture(
            vec![Sim {
                id: "sim-003".to_string(),
                home,
                position: site,
                routine: CitizenRoutine::Worker {
                    shift_template: "standard".to_string(),
                    workplace: None,
                },
                // The failing return owns the citizen.
                next_activity: None,
            }],
            700.0,
        );
        state.active_trips = vec![ActiveTrip {
            id: "trip-day-0-trip-001".to_string(),
            sim_id: "sim-003".to_string(),
            purpose: TripPurpose::OptionalReturn,
            origin: site,
            destination: home,
            position: site.into(),
            status: TripStatus::Waiting,
            deadline: 1_600.0,
            route_plan: Some(bus_plan(site, home, "route-001")),
            current_leg_index: 0,
            patience_remaining: 1.0,
            current_leg_wait_seconds: 0.0,
            private_car_trip: None,
        }];
        state
    }

    let mut engine = common::running_engine_from_fixture(failed_return_fixture());
    engine.tick(2.0);
    let failed = engine.snapshot();
    let worker = failed.sims.iter().find(|sim| sim.id == "sim-003").unwrap();
    let next_wake = scheduled_time_seconds(
        1,
        commute::departure_minute_for_sim("sim-003", "standard", "outbound"),
    );
    assert_eq!(
        worker.next_activity.clone(),
        Some(ScheduledActivity {
            kind: ScheduledActivityKind::DailyRoutine,
            due_time: next_wake,
        }),
        "the unserved return waits until the next DailyRoutine"
    );
    assert!(
        failed.active_trips.is_empty(),
        "no same-day retry is scheduled for the failed return"
    );

    // At the next DailyRoutine the away-from-home guard resolves the citizen
    // into the day's return window, which brings them home.
    let return_minute = commute::departure_minute_for_sim("sim-003", "standard", "return");
    let return_window = scheduled_time_seconds(1, return_minute);
    // The walk home is a 19-tile manhattan leg (380s), so end well after it.
    let end = return_window + 500.0;
    let mut observer = common::running_engine_from_fixture(failed_return_fixture());
    observer.tick(return_window - 700.0 + 1.0);
    let wake_snapshot = observer.snapshot();
    let return_demand = wake_snapshot
        .active_trips
        .iter()
        .find(|trip| trip.sim_id == "sim-003" && trip.purpose == TripPurpose::CommuteReturn)
        .expect("the recovery wake emits the return home");
    assert_eq!(return_demand.origin, Point { x: 18, y: 10 });
    assert_eq!(return_demand.destination, Point { x: 2, y: 7 });

    let coarse = assert_stage_b_equivalence(failed_return_fixture(), end);
    let citizen = coarse.sims.iter().find(|sim| sim.id == "sim-003").unwrap();
    assert_eq!(citizen.position, citizen.home, "the recovery returns home");
}
