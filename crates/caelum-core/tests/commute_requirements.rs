use caelum_core::commute::{
    departure_minute_for_sim, shift_template_for_id, worker_profile_for_id,
};
use caelum_core::model::{TripPurpose, TripStatus, WorkerProfile};
use caelum_core::{clock, GameEngine, GameIntent};

fn assigned_worker_engine() -> GameEngine {
    let mut engine = GameEngine::new();
    engine.dispatch(GameIntent::PaintAreaRectangle {
        area: "residential".to_string(),
        start: (2, 3).into(),
        end: (3, 4).into(),
    });
    engine.dispatch(GameIntent::PlaceBuilding {
        building_type: "smallHouse".to_string(),
        origin: (2, 3).into(),
        rotation: 0,
    });
    engine.dispatch(GameIntent::PaintAreaRectangle {
        area: "commercial".to_string(),
        start: (8, 3).into(),
        end: (9, 4).into(),
    });
    engine.dispatch(GameIntent::PlaceBuilding {
        building_type: "supermarket".to_string(),
        origin: (8, 3).into(),
        rotation: 0,
    });
    engine.dispatch(GameIntent::SetPaused { paused: false });
    engine
}

fn assigned_nearby_worker_engine() -> GameEngine {
    let mut engine = GameEngine::new();
    engine.dispatch(GameIntent::PaintAreaRectangle {
        area: "residential".to_string(),
        start: (2, 3).into(),
        end: (3, 3).into(),
    });
    engine.dispatch(GameIntent::PlaceBuilding {
        building_type: "smallHouse".to_string(),
        origin: (2, 3).into(),
        rotation: 0,
    });
    engine.dispatch(GameIntent::PaintAreaRectangle {
        area: "commercial".to_string(),
        start: (4, 3).into(),
        end: (5, 4).into(),
    });
    engine.dispatch(GameIntent::PlaceBuilding {
        building_type: "supermarket".to_string(),
        origin: (4, 3).into(),
        rotation: 0,
    });
    engine.dispatch(GameIntent::SetPaused { paused: false });
    engine
}

fn assigned_far_worker_engine() -> GameEngine {
    let mut engine = GameEngine::new();
    engine.dispatch(GameIntent::PaintAreaRectangle {
        area: "residential".to_string(),
        start: (2, 3).into(),
        end: (3, 3).into(),
    });
    engine.dispatch(GameIntent::PlaceBuilding {
        building_type: "smallHouse".to_string(),
        origin: (2, 3).into(),
        rotation: 0,
    });
    engine.dispatch(GameIntent::PaintAreaRectangle {
        area: "commercial".to_string(),
        start: (25, 16).into(),
        end: (26, 17).into(),
    });
    engine.dispatch(GameIntent::PlaceBuilding {
        building_type: "supermarket".to_string(),
        origin: (25, 16).into(),
        rotation: 0,
    });
    engine.dispatch(GameIntent::SetPaused { paused: false });
    engine
}

fn scheduled_time_seconds(day: u32, minute: u16) -> f64 {
    f64::from(day) * clock::GAME_DAY_SECONDS
        + (f64::from(minute) / f64::from(clock::MINUTES_PER_DAY)) * clock::GAME_DAY_SECONDS
}

#[test]
fn deterministic_worker_and_shift_distribution() {
    assert_eq!(worker_profile_for_id("sim-001"), WorkerProfile::Worker);
    assert_eq!(worker_profile_for_id("sim-010"), WorkerProfile::NonWorker);
    assert_eq!(shift_template_for_id("sim-001"), Some("standard"));
    assert_eq!(shift_template_for_id("sim-008"), Some("early"));
    assert_eq!(shift_template_for_id("sim-009"), Some("late"));
    assert_eq!(shift_template_for_id("sim-010"), None);
    assert_eq!(shift_template_for_id("sim-011"), Some("offPeak"));
    assert_eq!(shift_template_for_id("sim-020"), None);
}

#[test]
fn departure_jitter_is_stable_and_inside_window() {
    let first = departure_minute_for_sim("sim-001", "standard", "outbound");
    let second = departure_minute_for_sim("sim-001", "standard", "outbound");
    assert_eq!(first, second);
    assert!((420..=540).contains(&first));
}

#[test]
fn departure_jitter_uses_full_suffix_modulo_not_truncated_u16() {
    // A sim ordinal larger than u16::MAX must jitter from the full suffix. The modulo is
    // taken on usize before narrowing: 70_000 % 121 == 62, giving 420 + 62 == 482. The old
    // `as u16`-before-`%` path truncated 70_000 to 4464 and yielded 528 instead. This locks
    // the fix so the distribution can't silently shift for large ordinals.
    assert_eq!(
        departure_minute_for_sim("sim-70000", "standard", "outbound"),
        482,
    );
    assert!((420..=540).contains(&departure_minute_for_sim(
        "sim-70000",
        "standard",
        "outbound"
    )));
}

#[test]
fn outbound_requirement_spawns_for_assigned_workers() {
    let mut engine = assigned_worker_engine();

    let result = engine.tick(360.0);

    assert!(result
        .snapshot
        .active_trips
        .iter()
        .any(|trip| { trip.sim_id == "sim-001" && trip.purpose == TripPurpose::CommuteOutbound }));
}

#[test]
fn large_tick_only_advances_outbound_after_scheduled_departure() {
    let mut engine = assigned_worker_engine();
    let departure = departure_minute_for_sim("sim-001", "standard", "outbound");
    let scheduled = scheduled_time_seconds(0, departure);

    let result = engine.tick(360.0);
    let trip = result
        .snapshot
        .active_trips
        .iter()
        .find(|trip| trip.sim_id == "sim-001" && trip.purpose == TripPurpose::CommuteOutbound)
        .unwrap();

    let expected_x = 2.0 + ((360.0 - scheduled) / 20.0);
    assert_eq!(trip.status, TripStatus::Walking);
    assert!((trip.position.x - expected_x).abs() < 0.000_001);
    assert!((trip.position.y - 3.0).abs() < 0.000_001);
}

#[test]
fn ticking_exactly_to_scheduled_departure_spawns_outbound_without_moving() {
    let mut engine = assigned_worker_engine();
    let departure = departure_minute_for_sim("sim-001", "standard", "outbound");
    let scheduled = scheduled_time_seconds(0, departure);

    let result = engine.tick(scheduled);
    let trip = result
        .snapshot
        .active_trips
        .iter()
        .find(|trip| trip.sim_id == "sim-001" && trip.purpose == TripPurpose::CommuteOutbound)
        .unwrap();

    assert_eq!(trip.status, TripStatus::Idle);
    assert_eq!(trip.route_plan, None);
    assert!((trip.position.x - 2.0).abs() < 0.000_001);
    assert!((trip.position.y - 3.0).abs() < 0.000_001);
}

#[test]
fn large_tick_stops_at_return_boundary_after_outbound_arrives_same_tick() {
    let mut engine = assigned_nearby_worker_engine();
    let return_departure = departure_minute_for_sim("sim-001", "standard", "return");
    let scheduled_return = scheduled_time_seconds(0, return_departure);
    let post_return_elapsed = 10.0;

    let result = engine.tick(scheduled_return + post_return_elapsed);
    let trip = result
        .snapshot
        .active_trips
        .iter()
        .find(|trip| trip.sim_id == "sim-001" && trip.purpose == TripPurpose::CommuteReturn)
        .unwrap();

    assert_eq!(trip.status, TripStatus::Walking);
    assert!((trip.position.x - (4.0 - post_return_elapsed / 20.0)).abs() < 0.000_001);
    assert!((trip.position.y - 3.0).abs() < 0.000_001);
}

#[test]
fn large_tick_crossing_midnight_preserves_outbound_arrival_before_day_boundary() {
    let mut large_tick = assigned_far_worker_engine();
    let mut stepped_tick = assigned_far_worker_engine();
    let return_departure = departure_minute_for_sim("sim-001", "standard", "return");
    let return_time = scheduled_time_seconds(0, return_departure);
    let final_time = clock::GAME_DAY_SECONDS + 30.0;

    assert!(return_time < clock::GAME_DAY_SECONDS);
    assert!(clock::GAME_DAY_SECONDS < final_time);

    let large_result = large_tick.tick(final_time);
    let after_return_boundary = stepped_tick.tick(return_time);
    assert!(!after_return_boundary
        .snapshot
        .active_trips
        .iter()
        .any(|trip| trip.sim_id == "sim-001" && trip.purpose == TripPurpose::CommuteReturn));

    let mut stepped_snapshot = after_return_boundary.snapshot;
    while stepped_snapshot.time < clock::GAME_DAY_SECONDS
        && !stepped_snapshot
            .active_trips
            .iter()
            .any(|trip| trip.sim_id == "sim-001" && trip.purpose == TripPurpose::CommuteReturn)
    {
        stepped_snapshot = stepped_tick.tick(1.0).snapshot;
    }
    assert!(stepped_snapshot.time < clock::GAME_DAY_SECONDS);

    let stepped_result = stepped_tick.tick(final_time - stepped_snapshot.time);
    let expected_return = stepped_result
        .snapshot
        .active_trips
        .iter()
        .find(|trip| trip.sim_id == "sim-001" && trip.purpose == TripPurpose::CommuteReturn)
        .unwrap();
    let large_return = large_result
        .snapshot
        .active_trips
        .iter()
        .find(|trip| trip.sim_id == "sim-001" && trip.purpose == TripPurpose::CommuteReturn)
        .expect("large tick should match stepped tick and spawn a same-day return");

    assert!(large_return.id.starts_with("trip-day-0-trip-"));
    assert_eq!(large_return.status, expected_return.status);
    assert!((large_return.position.x - expected_return.position.x).abs() < 0.000_001);
    assert!((large_return.position.y - expected_return.position.y).abs() < 0.000_001);
}

#[test]
fn return_requirement_requires_successful_outbound() {
    let mut engine = GameEngine::new();
    engine.dispatch(GameIntent::PaintAreaRectangle {
        area: "residential".to_string(),
        start: (2, 3).into(),
        end: (3, 3).into(),
    });
    engine.dispatch(GameIntent::PlaceBuilding {
        building_type: "smallHouse".to_string(),
        origin: (2, 3).into(),
        rotation: 0,
    });
    engine.dispatch(GameIntent::SetPaused { paused: false });

    let evening = engine.tick(900.0);

    assert_eq!(evening.snapshot.active_trips.len(), 0);
    assert_eq!(evening.snapshot.metrics.unserved_trips, 0);
}
