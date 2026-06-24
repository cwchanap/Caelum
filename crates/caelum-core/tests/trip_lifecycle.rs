use caelum_core::model::{
    ActiveTrip, PlacedBuilding, Point, RouteLeg, RoutePlan, Sim, TransitNetwork, TripOutcome,
    TripPosition, Vehicle,
};
use caelum_core::{clock, commute, objectives, state::create_initial_snapshot, trips};
use caelum_core::{GameEngine, GameIntent};

fn sim(id: &str, home: Point, workplace: Option<Point>) -> Sim {
    Sim {
        id: id.to_string(),
        home: home.clone(),
        position: home,
        worker_profile: "worker".to_string(),
        shift_template: Some("standard".to_string()),
        workplace,
        commute_day: 0,
        outbound_resolved_today: false,
        outbound_arrived_today: false,
        return_resolved_today: false,
        returned_home_today: false,
    }
}

fn trip(id: &str, status: &str, position: TripPosition, destination: Point) -> ActiveTrip {
    ActiveTrip {
        id: id.to_string(),
        sim_id: "sim-001".to_string(),
        purpose: "commuteOutbound".to_string(),
        origin: Point { x: 2, y: 3 },
        destination,
        position,
        status: status.to_string(),
        deadline: 900.0,
        route_plan: None,
        current_leg_index: 0,
        patience_remaining: 240.0,
    }
}

fn walk_plan(from: Point, to: Point, estimated_seconds: f64) -> RoutePlan {
    RoutePlan {
        estimated_seconds,
        legs: vec![RouteLeg {
            mode: "walk".to_string(),
            from,
            to,
            line_id: None,
        }],
    }
}

fn bus_plan(from: Point, to: Point, line_id: &str) -> RoutePlan {
    RoutePlan {
        estimated_seconds: 120.0,
        legs: vec![RouteLeg {
            mode: "bus".to_string(),
            from,
            to,
            line_id: Some(line_id.to_string()),
        }],
    }
}

fn destination_building(point: Point) -> PlacedBuilding {
    PlacedBuilding {
        id: "building-001".to_string(),
        building_type: "supermarket".to_string(),
        origin: point.clone(),
        rotation: 0,
        occupied_tiles: vec![point],
        transit_node_id: None,
    }
}

fn bus_then_walk_plan(bus_from: Point, bus_to: Point, walk_to: Point, line_id: &str) -> RoutePlan {
    RoutePlan {
        estimated_seconds: 140.0,
        legs: vec![
            RouteLeg {
                mode: "bus".to_string(),
                from: bus_from,
                to: bus_to.clone(),
                line_id: Some(line_id.to_string()),
            },
            RouteLeg {
                mode: "walk".to_string(),
                from: bus_to,
                to: walk_to,
                line_id: None,
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

#[test]
fn walking_movement_scales_by_simulated_time() {
    let mut state = create_initial_snapshot();
    state.sims = vec![sim("sim-001", (2, 3).into(), Some((5, 3).into()))];
    state.active_trips = vec![trip("trip-001", "idle", (2, 3).into(), (5, 3).into())];

    let next = trips::advance_active_trips(&state, 1.0);
    let advanced = &next.active_trips[0];

    assert_eq!(advanced.status, "walking");
    assert!((advanced.position.x - 2.05).abs() < 0.000_001);
    assert!((advanced.position.y - 3.0).abs() < 0.000_001);
    assert_eq!(next.metrics.completed_trips, 0);
}

#[test]
fn terminal_trips_are_pruned_without_double_counting() {
    for status in ["arrived", "late", "unserved"] {
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
    let mut riding = trip("trip-001", "riding", (7, 8).into(), (15, 8).into());
    riding.route_plan = Some(bus_plan((7, 8).into(), (15, 8).into(), "route-001"));
    riding.patience_remaining = 123.0;
    state.active_trips = vec![riding.clone()];
    state.transit.vehicles = vec![Vehicle {
        id: "vehicle-001".to_string(),
        mode: "bus".to_string(),
        line_id: "route-001".to_string(),
        capacity: 18,
        passenger_ids: vec!["trip-001".to_string()],
        segment_index: 0,
        progress: 0.5,
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
    let mut riding = trip("trip-001", "riding", (15, 8).into(), (23, 8).into());
    riding.origin = Point { x: 2, y: 3 };
    riding.route_plan = Some(bus_plan((7, 8).into(), (15, 8).into(), "route-001"));
    state.active_trips = vec![riding];

    let next = trips::advance_active_trips(&state, 1.0);
    let recovered = &next.active_trips[0];

    assert_ne!(recovered.status, "riding");
    assert_eq!(
        recovered.route_plan.as_ref().unwrap().legs[0].from,
        Point { x: 15, y: 8 }
    );
}

#[test]
fn fractional_idle_position_snaps_before_replanning() {
    let mut state = create_initial_snapshot();
    state.active_trips = vec![trip(
        "trip-001",
        "idle",
        TripPosition { x: 5.3, y: 8.0 },
        (23, 8).into(),
    )];

    let next = trips::advance_active_trips(&state, 1.0);
    let replanned = &next.active_trips[0];

    assert_ne!(replanned.status, "unserved");
    assert_eq!(
        replanned.route_plan.as_ref().unwrap().legs[0].from,
        Point { x: 5, y: 8 }
    );
}

#[test]
fn waiting_trips_lose_patience_and_update_wait_metrics() {
    let mut state = create_initial_snapshot();
    let mut waiting = trip("trip-001", "waiting", (7, 8).into(), (22, 8).into());
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
            outcome: "unserved".to_string(),
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
    on_time.active_trips = vec![trip("trip-001", "idle", (2, 3).into(), (3, 3).into())];
    let arrived = trips::advance_active_trips(&on_time, 20.0);

    assert!(arrived.active_trips.is_empty());
    assert_eq!(arrived.metrics.completed_trips, 1);
    assert_eq!(arrived.metrics.late_trips, 0);
    assert_eq!(
        arrived.metrics.trip_outcomes,
        vec![TripOutcome {
            outcome: "arrived".to_string(),
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
    let mut terminal_leg = trip("trip-002", "walking", (3, 3).into(), (3, 3).into());
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
            outcome: "late".to_string(),
            wait_seconds: 0.0,
            time: 1.0,
        }]
    );
}

#[test]
fn no_route_planning_marks_trip_unserved() {
    let mut state = create_initial_snapshot();
    state.active_trips = vec![trip("trip-001", "idle", (2, 3).into(), (28, 17).into())];

    let next = trips::advance_active_trips(&state, 1.0);

    assert!(next.active_trips.is_empty());
    assert_eq!(next.metrics.unserved_trips, 1);
    assert_eq!(
        next.metrics.trip_outcomes,
        vec![TripOutcome {
            outcome: "unserved".to_string(),
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
    let mut waiting = trip("trip-001", "waiting", (7, 8).into(), (22, 8).into());
    waiting.route_plan = Some(bus_plan((7, 8).into(), (22, 8).into(), "route-001"));
    waiting.patience_remaining = 5.0;
    state.active_trips = vec![waiting];

    let next = trips::tick_trips(&state, 100.0);

    assert!(next.active_trips.is_empty());
    assert_eq!(next.metrics.unserved_trips, 1);
    assert_eq!(next.metrics.total_wait_seconds, 5.0);
    assert_eq!(next.metrics.trip_outcomes.len(), 1);
    assert_eq!(next.metrics.trip_outcomes[0].outcome, "unserved");
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
            outcome: "unserved".to_string(),
            wait_seconds: 0.0,
            time: 100.0 + f64::from(index),
        })
        .collect();

    let next = trips::advance_active_trips(&state, 0.0);

    assert_eq!(next.metrics.trip_outcomes.len(), 1);
    assert_eq!(next.metrics.trip_outcomes[0].time, 109.0);
    assert_eq!(
        objectives::evaluate_objectives(&next).metrics.state,
        "running"
    );
}

#[test]
fn riding_arrival_outcome_uses_vehicle_stop_boundary_time() {
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
    let vehicle = engine.dispatch(GameIntent::AssignVehicle {
        mode: "bus".to_string(),
        line_id: "route-001".to_string(),
    });

    let mut state = vehicle.snapshot;
    state.paused = false;
    state.active_trips = vec![ActiveTrip {
        id: "trip-001".to_string(),
        sim_id: "sim-001".to_string(),
        purpose: "commuteOutbound".to_string(),
        origin: (2, 5).into(),
        destination: (12, 5).into(),
        position: (2, 5).into(),
        status: "riding".to_string(),
        deadline: 100.0,
        route_plan: Some(bus_plan((2, 5).into(), (12, 5).into(), "route-001")),
        current_leg_index: 0,
        patience_remaining: 240.0,
    }];
    state.transit.vehicles[0].passenger_ids = vec!["trip-001".to_string()];

    let next = trips::tick_trips(&state, 20.0);

    assert!(next.active_trips.is_empty());
    assert_eq!(next.metrics.completed_trips, 1);
    assert_eq!(next.metrics.trip_outcomes.len(), 1);
    assert_eq!(next.metrics.trip_outcomes[0].outcome, "arrived");
    assert!((next.metrics.trip_outcomes[0].time - 12.5).abs() < 0.000_001);
}

#[test]
fn just_disembarked_trip_does_not_consume_ride_time_as_walking_time() {
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
    let vehicle = engine.dispatch(GameIntent::AssignVehicle {
        mode: "bus".to_string(),
        line_id: "route-001".to_string(),
    });

    let mut state = vehicle.snapshot;
    state.paused = false;
    state.active_trips = vec![ActiveTrip {
        id: "trip-001".to_string(),
        sim_id: "sim-001".to_string(),
        purpose: "commuteOutbound".to_string(),
        origin: (2, 5).into(),
        destination: (13, 5).into(),
        position: (2, 5).into(),
        status: "riding".to_string(),
        deadline: 100.0,
        route_plan: Some(bus_then_walk_plan(
            (2, 5).into(),
            (12, 5).into(),
            (13, 5).into(),
            "route-001",
        )),
        current_leg_index: 0,
        patience_remaining: 240.0,
    }];
    state.transit.vehicles[0].passenger_ids = vec!["trip-001".to_string()];

    let disembarked = trips::tick_trips(&state, 12.5);
    let walking = &disembarked.active_trips[0];

    assert_eq!(walking.status, "walking");
    assert_eq!(walking.current_leg_index, 1);
    assert_eq!(walking.position, (12, 5).into());
    assert_eq!(disembarked.metrics.completed_trips, 0);
    assert!(disembarked.metrics.trip_outcomes.is_empty());

    let arrived = trips::tick_trips(&disembarked, 20.0);

    assert!(arrived.active_trips.is_empty());
    assert_eq!(arrived.metrics.completed_trips, 1);
    assert_eq!(arrived.metrics.trip_outcomes.len(), 1);
    assert_eq!(arrived.metrics.trip_outcomes[0].outcome, "arrived");
    assert!((arrived.metrics.trip_outcomes[0].time - 32.5).abs() < 0.000_001);
}

#[test]
fn outbound_home_fallback_trip_stays_dormant_when_away_from_home() {
    let mut state = create_initial_snapshot();
    let home = Point { x: 2, y: 3 };
    let away_position = TripPosition { x: 5.0, y: 3.0 };
    state.sims = vec![Sim {
        id: "sim-001".to_string(),
        home: home.clone(),
        position: Point { x: 5, y: 3 },
        worker_profile: "worker".to_string(),
        shift_template: Some("standard".to_string()),
        workplace: None,
        commute_day: 0,
        outbound_resolved_today: false,
        outbound_arrived_today: false,
        return_resolved_today: false,
        returned_home_today: false,
    }];
    state.active_trips = vec![ActiveTrip {
        id: "trip-001".to_string(),
        sim_id: "sim-001".to_string(),
        purpose: "commuteOutbound".to_string(),
        origin: home.clone(),
        destination: home,
        position: away_position.clone(),
        status: "idle".to_string(),
        deadline: 2_000.0,
        route_plan: None,
        current_leg_index: 0,
        patience_remaining: 240.0,
    }];
    let metrics = state.metrics.clone();

    let next = trips::advance_active_trips(&state, 20.0);
    let fallback = &next.active_trips[0];

    assert_eq!(fallback.status, "idle");
    assert_eq!(fallback.position, away_position);
    assert!(fallback.route_plan.is_none());
    assert_eq!(fallback.current_leg_index, 0);
    assert_eq!(fallback.patience_remaining, 240.0);
    assert_eq!(next.metrics, metrics);
}

#[test]
fn return_home_trip_is_not_treated_as_home_fallback() {
    let mut state = create_initial_snapshot();
    state.sims = vec![Sim {
        id: "sim-001".to_string(),
        home: (2, 3).into(),
        position: (5, 3).into(),
        worker_profile: "worker".to_string(),
        shift_template: Some("standard".to_string()),
        workplace: Some((5, 3).into()),
        commute_day: 0,
        outbound_resolved_today: true,
        outbound_arrived_today: true,
        return_resolved_today: false,
        returned_home_today: false,
    }];
    state.active_trips = vec![ActiveTrip {
        id: "trip-001".to_string(),
        sim_id: "sim-001".to_string(),
        purpose: "commuteReturn".to_string(),
        origin: (5, 3).into(),
        destination: (2, 3).into(),
        position: (5, 3).into(),
        status: "idle".to_string(),
        deadline: 2_000.0,
        route_plan: None,
        current_leg_index: 0,
        patience_remaining: 240.0,
    }];

    let next = trips::advance_active_trips(&state, 20.0);

    assert_eq!(next.active_trips[0].status, "walking");
    assert!((next.active_trips[0].position.x - 4.0).abs() < 0.000_001);
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
        home: home.clone(),
        position: home.clone(),
        worker_profile: "worker".to_string(),
        shift_template: Some("standard".to_string()),
        workplace: Some(workplace.clone()),
        commute_day: 1,
        outbound_resolved_today: false,
        outbound_arrived_today: false,
        return_resolved_today: false,
        returned_home_today: false,
    }];
    state.active_trips = vec![ActiveTrip {
        id: "trip-day-0-trip-001".to_string(),
        sim_id: "sim-001".to_string(),
        purpose: "commuteOutbound".to_string(),
        origin: home,
        destination: workplace.clone(),
        position: workplace.clone().into(),
        status: "walking".to_string(),
        deadline: 2_000.0,
        route_plan: Some(walk_plan(workplace.clone(), workplace.clone(), 0.0)),
        current_leg_index: 0,
        patience_remaining: 240.0,
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

    let ticked = trips::tick_trips(&after_return_window, 0.0);

    assert!(!ticked
        .active_trips
        .iter()
        .any(|trip| trip.sim_id == "sim-001" && trip.purpose == "commuteReturn"));
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
        worker_profile: "worker".to_string(),
        shift_template: Some("standard".to_string()),
        workplace: Some((3, 3).into()),
        commute_day: 0,
        outbound_resolved_today: true,
        outbound_arrived_today: true,
        return_resolved_today: false,
        returned_home_today: false,
    }];

    let arrived = trips::tick_trips(&state, 20.0);
    let sim = arrived.sims.iter().find(|sim| sim.id == "sim-001").unwrap();

    assert!(arrived.active_trips.is_empty());
    assert_eq!(arrived.metrics.completed_trips, 1);
    assert_eq!(sim.position, Point { x: 2, y: 3 });
    assert!(sim.return_resolved_today);
    assert!(sim.returned_home_today);

    let ticked_again = trips::tick_trips(&arrived, 0.0);

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
    state.buildings = vec![destination_building(workplace.clone())];
    state.sims = vec![sim("sim-001", home.clone(), Some(workplace.clone()))];
    state.active_trips = vec![ActiveTrip {
        id: "trip-day-0-trip-001".to_string(),
        sim_id: "sim-001".to_string(),
        purpose: "commuteOutbound".to_string(),
        origin: home,
        destination: workplace,
        position: Point { x: 7, y: 8 }.into(),
        status: "waiting".to_string(),
        deadline: departure_time + 900.0,
        route_plan: Some(bus_plan(
            Point { x: 7, y: 8 },
            Point { x: 22, y: 8 },
            "route-001",
        )),
        current_leg_index: 0,
        patience_remaining: 1.0,
    }];

    let next = trips::tick_trips(&state, 2.0);
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
        home: home.clone(),
        position: workplace.clone(),
        worker_profile: "worker".to_string(),
        shift_template: Some("standard".to_string()),
        workplace: Some(workplace.clone()),
        commute_day: 0,
        outbound_resolved_today: true,
        outbound_arrived_today: true,
        return_resolved_today: false,
        returned_home_today: false,
    }];
    state.active_trips = vec![ActiveTrip {
        id: "trip-day-0-trip-001".to_string(),
        sim_id: "sim-001".to_string(),
        purpose: "commuteReturn".to_string(),
        origin: workplace.clone(),
        destination: home,
        position: workplace.clone().into(),
        status: "waiting".to_string(),
        deadline: return_time + 900.0,
        route_plan: Some(bus_plan(workplace, Point { x: 7, y: 8 }, "route-001")),
        current_leg_index: 0,
        patience_remaining: 1.0,
    }];

    let next = trips::tick_trips(&state, 2.0);
    let sim = next.sims.iter().find(|sim| sim.id == "sim-001").unwrap();

    assert!(next.active_trips.is_empty());
    assert_eq!(next.metrics.unserved_trips, 1);
    assert_eq!(next.metrics.trip_outcomes.len(), 1);
    assert!(sim.return_resolved_today);
    assert!(!sim.returned_home_today);
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
        worker_profile: "worker".to_string(),
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
        purpose: "commuteOutbound".to_string(),
        origin: (8, 3).into(),
        destination: (9, 3).into(),
        position: (8, 3).into(),
        status: "walking".to_string(),
        deadline: return_time + 900.0,
        route_plan: Some(walk_plan((8, 3).into(), (9, 3).into(), 20.0)),
        current_leg_index: 0,
        patience_remaining: 240.0,
    }];

    let next = trips::tick_trips(&state, 0.0);

    let ids = next
        .active_trips
        .iter()
        .map(|trip| trip.id.as_str())
        .collect::<Vec<_>>();
    assert!(ids.contains(&"trip-day-0-trip-002"));
    assert!(ids.contains(&"trip-day-0-trip-003"));
    assert_eq!(next.next_trip_sequence, 4);
}
