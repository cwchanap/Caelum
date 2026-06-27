use caelum_core::model::{
    ActiveTrip, MetricsState, PlacedBuilding, Point, RouteLeg, RoutePlan, Sim, TransitMode,
    TransitNetwork, TripOutcome, TripOutcomeKind, TripPosition, TripPurpose, TripStatus, Vehicle,
    WorkerProfile,
};
use caelum_core::{clock, commute, objectives, state::create_initial_snapshot, transit, trips};
use caelum_core::{GameEngine, GameIntent};

fn sim(id: &str, home: Point, workplace: Option<Point>) -> Sim {
    Sim {
        id: id.to_string(),
        home: home.clone(),
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
                mode: TransitMode::Bus,
                from: bus_from,
                to: bus_to.clone(),
                line_id: Some(line_id.to_string()),
            },
            RouteLeg {
                mode: TransitMode::Walk,
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

    let next = trips::tick_trips(&state, 100.0);

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
        point: (2, 5).into(),
    });
    engine.dispatch(GameIntent::AddBusStop {
        point: (12, 5).into(),
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
        purpose: TripPurpose::CommuteOutbound,
        origin: (2, 5).into(),
        destination: (12, 5).into(),
        position: (2, 5).into(),
        status: TripStatus::Riding,
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
    assert_eq!(
        next.metrics.trip_outcomes[0].outcome,
        TripOutcomeKind::Arrived
    );
    assert!((next.metrics.trip_outcomes[0].time - 12.5).abs() < 0.000_001);
}

#[test]
fn just_disembarked_trip_does_not_consume_ride_time_as_walking_time() {
    let mut engine = GameEngine::new();
    road_line(&mut engine, 5, 2, 12);
    engine.dispatch(GameIntent::AddBusStop {
        point: (2, 5).into(),
    });
    engine.dispatch(GameIntent::AddBusStop {
        point: (12, 5).into(),
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
        purpose: TripPurpose::CommuteOutbound,
        origin: (2, 5).into(),
        destination: (13, 5).into(),
        position: (2, 5).into(),
        status: TripStatus::Riding,
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

    assert_eq!(walking.status, TripStatus::Walking);
    assert_eq!(walking.current_leg_index, 1);
    assert_eq!(walking.position, (12, 5).into());
    assert_eq!(disembarked.metrics.completed_trips, 0);
    assert!(disembarked.metrics.trip_outcomes.is_empty());

    let arrived = trips::tick_trips(&disembarked, 20.0);

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
fn waiting_trip_that_boards_and_disembarks_in_one_substep_does_not_advance_walk() {
    // A trip that is `Waiting` at a stop, boards at the start of a substep, and
    // reaches its alighting stop in that same substep goes `Waiting → Riding →
    // Walking` inside `tick_vehicles`. The ride consumes the whole substep, so
    // the following walk leg must start at the alighting stop with zero elapsed
    // time this substep. `just_disembarked_trip_ids` must treat this as a
    // zero-delta disembark; otherwise `advance_active_trips` spends the full
    // substep delta on the walk leg and the commute arrives early.
    let mut engine = GameEngine::new();
    road_line(&mut engine, 5, 2, 12);
    engine.dispatch(GameIntent::AddBusStop {
        point: (2, 5).into(),
    });
    engine.dispatch(GameIntent::AddBusStop {
        point: (12, 5).into(),
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
        purpose: TripPurpose::CommuteOutbound,
        origin: (2, 5).into(),
        destination: (13, 5).into(),
        position: (2, 5).into(),
        status: TripStatus::Waiting,
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
    // Vehicle starts at the boarding stop (progress 0) with a free seat; it
    // boards the waiting trip and reaches stop-002 in the same substep.
    assert_eq!(state.transit.vehicles[0].progress, 0.0);
    assert!(state.transit.vehicles[0].passenger_ids.is_empty());

    let disembarked = trips::tick_trips(&state, 12.5);
    let walking = &disembarked.active_trips[0];

    assert_eq!(walking.status, TripStatus::Walking);
    assert_eq!(walking.current_leg_index, 1);
    assert_eq!(walking.position, (12, 5).into());
    assert_eq!(disembarked.metrics.completed_trips, 0);
    assert!(disembarked.metrics.trip_outcomes.is_empty());

    let arrived = trips::tick_trips(&disembarked, 20.0);

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
fn vehicle_reaches_stop_when_substep_progress_lands_just_under_one_via_fp() {
    // FP under-shoot: a substep scheduled via `seconds_until_next_vehicle_stop`
    // to land exactly on the next stop can compute a progress of
    // 0.9999999999999999 instead of 1.0. The strict `progress < 1.0` check then
    // leaves the vehicle on the old segment, so riders do not disembark and the
    // next-stop boundary (a hair after `state.time`) is skipped by
    // `track_next_boundary`, delaying the arrival until some later substep. An
    // epsilon clamp at the stop boundary must treat proximity as a reach.
    //
    // A 4-tile segment gives `steps = 3`; a prior 0.25s advance leaves progress
    // at `(0.8 * 0.25) / 3`, whose exact-to-stop round-trip lands a hair under
    // 1.0 for this step count.
    let mut engine = GameEngine::new();
    road_line(&mut engine, 5, 2, 5);
    engine.dispatch(GameIntent::AddBusStop {
        point: (2, 5).into(),
    });
    engine.dispatch(GameIntent::AddBusStop {
        point: (5, 5).into(),
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
    state.transit.vehicles[0].progress = (transit::BUS_TILES_PER_SECOND * 0.25) / 3.0;
    state.active_trips = vec![ActiveTrip {
        id: "trip-001".to_string(),
        sim_id: "sim-001".to_string(),
        purpose: TripPurpose::CommuteOutbound,
        origin: (2, 5).into(),
        destination: (5, 5).into(),
        position: (2, 5).into(),
        status: TripStatus::Riding,
        deadline: 100.0,
        route_plan: Some(bus_plan((2, 5).into(), (5, 5).into(), "route-001")),
        current_leg_index: 0,
        patience_remaining: 240.0,
    }];
    state.transit.vehicles[0].passenger_ids = vec!["trip-001".to_string()];

    let seconds = transit::seconds_until_next_vehicle_stop(&state, &state.transit.vehicles[0])
        .expect("vehicle has a next stop");
    // Sanity: the unscaled round-trip is inexact and lands a hair under 1.0, so
    // this setup actually exercises the under-shoot path.
    let raw_progress =
        state.transit.vehicles[0].progress + (transit::BUS_TILES_PER_SECOND * seconds) / 3.0;
    assert!(
        raw_progress < 1.0,
        "test setup must trigger the FP under-shoot, got raw_progress = {raw_progress}"
    );

    let next = trips::tick_trips(&state, seconds);

    // The trip must disembark and arrive despite the FP under-shoot; without
    // the clamp it stays `Riding` (the arrival is delayed to a later substep).
    assert!(next.active_trips.is_empty());
    assert_eq!(next.metrics.completed_trips, 1);
}

#[test]
fn vehicle_carryover_clamps_to_zero_when_substep_progress_lands_just_over_one_via_fp() {
    // FP over-shoot: the same round-trip can land at 1.0000000000000002 instead
    // of 1.0. The vehicle reaches the stop (>= 1.0) and disembarks, but the
    // carried progress on the next segment is a tiny positive residual
    // (≈ 2e-16). Because boarding fires only when `vehicle.progress == 0.0`,
    // that residual silently blocks the next boarding. `disembark_vehicle` must
    // clamp a sub-epsilon carryover to 0.0.
    //
    // A 6-tile segment gives `steps = 5`; progress `(0.8 * 0.5) / 5 = 0.08`
    // whose exact-to-stop round-trip lands a hair over 1.0 for this step count.
    let mut engine = GameEngine::new();
    road_line(&mut engine, 5, 2, 7);
    engine.dispatch(GameIntent::AddBusStop {
        point: (2, 5).into(),
    });
    engine.dispatch(GameIntent::AddBusStop {
        point: (7, 5).into(),
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
    state.transit.vehicles[0].progress = (transit::BUS_TILES_PER_SECOND * 0.5) / 5.0;
    state.active_trips = vec![ActiveTrip {
        id: "trip-001".to_string(),
        sim_id: "sim-001".to_string(),
        purpose: TripPurpose::CommuteOutbound,
        origin: (2, 5).into(),
        destination: (7, 5).into(),
        position: (2, 5).into(),
        status: TripStatus::Riding,
        deadline: 100.0,
        route_plan: Some(bus_plan((2, 5).into(), (7, 5).into(), "route-001")),
        current_leg_index: 0,
        patience_remaining: 240.0,
    }];
    state.transit.vehicles[0].passenger_ids = vec!["trip-001".to_string()];

    let seconds = transit::seconds_until_next_vehicle_stop(&state, &state.transit.vehicles[0])
        .expect("vehicle has a next stop");
    let raw_progress =
        state.transit.vehicles[0].progress + (transit::BUS_TILES_PER_SECOND * seconds) / 5.0;
    assert!(
        raw_progress > 1.0,
        "test setup must trigger the FP over-shoot, got raw_progress = {raw_progress}"
    );

    let next = trips::tick_trips(&state, seconds);

    // The trip alights/arrives; the vehicle is back at a stop and ready to
    // board (progress exactly 0.0). Without the clamp the carryover is a tiny
    // positive residual that blocks the next boarding.
    assert!(next.active_trips.is_empty());
    assert_eq!(next.metrics.completed_trips, 1);
    assert_eq!(next.transit.vehicles[0].progress, 0.0);
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
        worker_profile: WorkerProfile::Worker,
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
        purpose: TripPurpose::CommuteOutbound,
        origin: home.clone(),
        destination: home,
        position: away_position.clone(),
        status: TripStatus::Idle,
        deadline: 2_000.0,
        route_plan: None,
        current_leg_index: 0,
        patience_remaining: 240.0,
    }];
    let metrics = state.metrics.clone();

    let next = trips::advance_active_trips(&state, 20.0);
    let fallback = &next.active_trips[0];

    assert_eq!(fallback.status, TripStatus::Idle);
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
        worker_profile: WorkerProfile::Worker,
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
        purpose: TripPurpose::CommuteReturn,
        origin: (5, 3).into(),
        destination: (2, 3).into(),
        position: (5, 3).into(),
        status: TripStatus::Idle,
        deadline: 2_000.0,
        route_plan: None,
        current_leg_index: 0,
        patience_remaining: 240.0,
    }];

    let next = trips::advance_active_trips(&state, 20.0);

    assert_eq!(next.active_trips[0].status, TripStatus::Walking);
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
        worker_profile: WorkerProfile::Worker,
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
        purpose: TripPurpose::CommuteOutbound,
        origin: home,
        destination: workplace.clone(),
        position: workplace.clone().into(),
        status: TripStatus::Walking,
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
        worker_profile: WorkerProfile::Worker,
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
        purpose: TripPurpose::CommuteReturn,
        origin: workplace.clone(),
        destination: home,
        position: workplace.clone().into(),
        status: TripStatus::Waiting,
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
    state.buildings = vec![destination_building(workplace.clone())];
    // Sim stranded at the workplace after day-0 return was unserved. Day-0
    // flags are set as they would be after the unserved return resolved;
    // `commute_day` is still 0 so the day-1 reset clears them.
    state.sims = vec![Sim {
        id: "sim-001".to_string(),
        home: home.clone(),
        position: workplace.clone(),
        worker_profile: WorkerProfile::Worker,
        shift_template: Some("standard".to_string()),
        workplace: Some(workplace.clone()),
        commute_day: 0,
        outbound_resolved_today: true,
        outbound_arrived_today: true,
        return_resolved_today: true,
        returned_home_today: false,
    }];
    state.active_trips = Vec::new();

    let next = trips::tick_trips(&state, 1.0);
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
            },
            RouteLeg {
                mode: TransitMode::Bus,
                from: (5, 3).into(),
                to: (22, 3).into(),
                line_id: Some("route-001".to_string()),
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

    let next = trips::tick_trips(&state, 60.0);

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
    let large_snapshot = trips::tick_trips(&state_with_zero_length_walk_then_bus(), 60.0);

    let mut stepped_snapshot = state_with_zero_length_walk_then_bus();
    for _ in 0..60 {
        stepped_snapshot = trips::tick_trips(&stepped_snapshot, 1.0);
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
            },
            RouteLeg {
                mode: TransitMode::Walk,
                from: (5, 3).into(),
                to: (5, 3).into(),
                line_id: None,
            },
        ],
    });
    trip.deadline = 1_000.0;
    state.active_trips = vec![trip];

    let next = trips::tick_trips(&state, 1.0);

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
            },
            RouteLeg {
                mode: TransitMode::Walk,
                from: (8, 3).into(),
                to: (8, 3).into(),
                line_id: None,
            },
            RouteLeg {
                mode: TransitMode::Bus,
                from: (8, 3).into(),
                to: (22, 3).into(),
                line_id: Some("route-002".to_string()),
            },
        ],
    });
    trip.current_leg_index = 1;
    trip.deadline = 1_000.0;
    state.active_trips = vec![trip];

    let next = trips::tick_trips(&state, 30.0);

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

    let large = trips::tick_trips(&build(), 100.0);

    let mut stepped = build();
    for _ in 0..100 {
        stepped = trips::tick_trips(&stepped, 1.0);
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
