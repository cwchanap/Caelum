use caelum_core::model::{
    ActiveTrip, Point, RouteLeg, RoutePlan, Sim, TransitNetwork, TripPosition, Vehicle,
};
use caelum_core::{clock, commute, state::create_initial_snapshot, trips};

fn sim(id: &str, home: Point, workplace: Option<Point>) -> Sim {
    Sim {
        id: id.to_string(),
        home: home.clone(),
        position: home,
        worker_profile: "worker".to_string(),
        shift_template: Some("standard".to_string()),
        workplace,
        commute_day: 0,
        outbound_arrived_today: false,
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
fn terminal_trips_do_not_advance_again() {
    for status in ["arrived", "late", "unserved"] {
        let mut state = create_initial_snapshot();
        let mut terminal = trip("trip-001", status, (4, 4).into(), (5, 4).into());
        terminal.route_plan = Some(walk_plan((4, 4).into(), (5, 4).into(), 20.0));
        terminal.patience_remaining = 123.0;
        state.active_trips = vec![terminal.clone()];

        let next = trips::advance_active_trips(&state, 20.0);

        assert_eq!(next.active_trips[0], terminal);
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
    let unserved = &next.active_trips[0];

    assert_eq!(unserved.status, "unserved");
    assert_eq!(unserved.patience_remaining, 0.0);
    assert_eq!(next.metrics.unserved_trips, 1);
    assert_eq!(next.metrics.total_wait_seconds, 2.0);
    assert_eq!(next.metrics.waiting_trip_count, 0);
    assert_eq!(next.metrics.average_wait_seconds, 0.0);
}

#[test]
fn short_walking_route_arrives_and_late_arrival_counts_late() {
    let mut on_time = create_initial_snapshot();
    on_time.time = 20.0;
    on_time.sims = vec![sim("sim-001", (2, 3).into(), Some((3, 3).into()))];
    on_time.active_trips = vec![trip("trip-001", "idle", (2, 3).into(), (3, 3).into())];
    let arrived = trips::advance_active_trips(&on_time, 20.0);

    assert_eq!(arrived.active_trips[0].status, "arrived");
    assert_eq!(arrived.metrics.completed_trips, 1);
    assert_eq!(arrived.metrics.late_trips, 0);
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

    assert_eq!(late_next.active_trips[0].status, "late");
    assert_eq!(late_next.metrics.completed_trips, 1);
    assert_eq!(late_next.metrics.late_trips, 1);
}

#[test]
fn no_route_planning_marks_trip_unserved() {
    let mut state = create_initial_snapshot();
    state.active_trips = vec![trip("trip-001", "idle", (2, 3).into(), (28, 17).into())];

    let next = trips::advance_active_trips(&state, 1.0);

    assert_eq!(next.active_trips[0].status, "unserved");
    assert!(next.active_trips[0].route_plan.is_none());
    assert_eq!(next.metrics.unserved_trips, 1);
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
        outbound_arrived_today: false,
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
        outbound_arrived_today: true,
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
        outbound_arrived_today: false,
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
    assert_eq!(arrived.active_trips[0].status, "arrived");
    assert_eq!(sim.position, workplace);
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
