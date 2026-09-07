use caelum_core::commute::{
    departure_minute_for_sim, is_canonical_shift_template, is_day_off, optional_departure_minute,
    shift_template_for_id, stable_daily_seed, student_departure_minute, OPTIONAL_SALT,
};
use caelum_core::model::{CitizenRoutine, Point, TripPurpose, TripStatus};
use caelum_core::{clock, GameEngine, GameIntent};

mod common;
use common::is_student_id;

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
    assert!(!is_student_id("sim-001"));
    assert!(is_student_id("sim-010"));
    assert_eq!(shift_template_for_id("sim-001"), Some("standard"));
    assert_eq!(shift_template_for_id("sim-008"), Some("early"));
    assert_eq!(shift_template_for_id("sim-009"), Some("late"));
    assert_eq!(shift_template_for_id("sim-010"), None);
    assert_eq!(shift_template_for_id("sim-011"), Some("offPeak"));
    assert_eq!(shift_template_for_id("sim-020"), None);
}

#[test]
fn canonical_shift_templates_are_exactly_the_gameplay_minted_set() {
    for template in ["standard", "early", "late", "offPeak"] {
        assert!(is_canonical_shift_template(template));
    }
    assert!(!is_canonical_shift_template("swing"));
    assert!(!is_canonical_shift_template(""));
    for suffix in 1..=40usize {
        let id = format!("sim-{suffix:03}");
        if let Some(template) = shift_template_for_id(&id) {
            assert!(
                is_canonical_shift_template(template),
                "shift_template_for_id minted a non-canonical template: {template}"
            );
        }
    }
}

#[test]
fn stable_daily_seed_is_deterministic_and_sensitive_to_salt_and_day() {
    for id in ["sim-001", "sim-010", "sim-12345"] {
        for day in [0_u32, 1, 6, 7] {
            assert_eq!(
                stable_daily_seed(id, day, OPTIONAL_SALT),
                stable_daily_seed(id, day, OPTIONAL_SALT),
                "same input must produce the same seed"
            );
            assert_ne!(
                stable_daily_seed(id, day, OPTIONAL_SALT),
                stable_daily_seed(id, day, OPTIONAL_SALT + 1),
                "a distinct salt must change the seed"
            );
            assert_ne!(
                stable_daily_seed(id, day, OPTIONAL_SALT),
                stable_daily_seed(id, day + 1, OPTIONAL_SALT),
                "a distinct day must change the seed"
            );
        }
    }
}

#[test]
fn day_off_follows_a_fixed_one_in_seven_rotation() {
    // Representative Worker (sim-001) and Student (sim-010) ids each get
    // exactly one day off per seven-day cycle, always the same one.
    for (citizen_id, expected_day) in [("sim-001", 1_u32), ("sim-010", 3), ("sim-014", 0)] {
        for day in 0..7_u32 {
            assert_eq!(
                is_day_off(citizen_id, day),
                day == expected_day,
                "{citizen_id} day {day} day-off mismatch"
            );
        }
    }
}

#[test]
fn student_windows_are_inside_the_school_morning_and_afternoon_spans() {
    for id in ["sim-010", "sim-020", "sim-70000"] {
        let outbound = student_departure_minute(id, "outbound");
        let return_minute = student_departure_minute(id, "return");
        assert_eq!(student_departure_minute(id, "outbound"), outbound);
        assert!((450..=510).contains(&outbound), "outbound {outbound}");
        assert!(
            (900..=960).contains(&return_minute),
            "return {return_minute}"
        );
        let optional = optional_departure_minute(id, 0);
        assert!((660..=900).contains(&optional), "optional {optional}");
        assert_eq!(optional_departure_minute(id, 0), optional);
    }
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

    let _result = engine.tick(360.0);

    assert!(engine
        .snapshot()
        .active_trips
        .iter()
        .any(|trip| { trip.sim_id == "sim-001" && trip.purpose == TripPurpose::CommuteOutbound }));
}

#[test]
fn large_tick_only_advances_outbound_after_scheduled_departure() {
    let mut engine = assigned_worker_engine();
    let departure = departure_minute_for_sim("sim-001", "standard", "outbound");
    let scheduled = scheduled_time_seconds(0, departure);

    let _result = engine.tick(360.0);
    let snapshot = engine.snapshot();
    let trip = snapshot
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

    let _result = engine.tick(scheduled);
    let snapshot = engine.snapshot();
    let trip = snapshot
        .active_trips
        .iter()
        .find(|trip| trip.sim_id == "sim-001" && trip.purpose == TripPurpose::CommuteOutbound)
        .unwrap();

    // The spawn stores the winning non-car plan and its implied status; the
    // trip has not moved yet (position assertions below).
    assert_eq!(trip.status, TripStatus::Walking);
    assert!(trip.route_plan.is_some());
    assert!((trip.position.x - 2.0).abs() < 0.000_001);
    assert!((trip.position.y - 3.0).abs() < 0.000_001);
}

#[test]
fn large_tick_stops_at_return_boundary_after_outbound_arrives_same_tick() {
    let mut engine = assigned_nearby_worker_engine();
    let return_departure = departure_minute_for_sim("sim-001", "standard", "return");
    let scheduled_return = scheduled_time_seconds(0, return_departure);
    let post_return_elapsed = 10.0;

    let _result = engine.tick(scheduled_return + post_return_elapsed);
    let snapshot = engine.snapshot();
    let trip = snapshot
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

    let _large_result = large_tick.tick(final_time);
    let _after_return_boundary = stepped_tick.tick(return_time);
    assert!(!stepped_tick
        .snapshot()
        .active_trips
        .iter()
        .any(|trip| trip.sim_id == "sim-001" && trip.purpose == TripPurpose::CommuteReturn));

    let mut stepped_snapshot = stepped_tick.snapshot();
    while stepped_snapshot.time < clock::GAME_DAY_SECONDS
        && !stepped_snapshot
            .active_trips
            .iter()
            .any(|trip| trip.sim_id == "sim-001" && trip.purpose == TripPurpose::CommuteReturn)
    {
        stepped_tick.tick(1.0);
        stepped_snapshot = stepped_tick.snapshot();
    }
    assert!(stepped_snapshot.time < clock::GAME_DAY_SECONDS);

    let _stepped_result = stepped_tick.tick(final_time - stepped_snapshot.time);
    let snapshot = stepped_tick.snapshot();
    let expected_return = snapshot
        .active_trips
        .iter()
        .find(|trip| trip.sim_id == "sim-001" && trip.purpose == TripPurpose::CommuteReturn)
        .unwrap();
    let snapshot = large_tick.snapshot();
    let large_return = snapshot
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

    let _evening = engine.tick(900.0);

    assert_eq!(engine.snapshot().active_trips.len(), 0);
    assert_eq!(engine.snapshot().metrics.unserved_trips, 0);
}

fn student_school_engine() -> GameEngine {
    let mut engine = GameEngine::new();
    for origin in [(2, 3), (5, 3), (8, 3)] {
        engine.dispatch(GameIntent::PaintAreaRectangle {
            area: "residential".to_string(),
            start: origin.into(),
            end: (origin.0 + 1, origin.1).into(),
        });
        let placed = engine.dispatch(GameIntent::PlaceBuilding {
            building_type: "smallHouse".to_string(),
            origin: origin.into(),
            rotation: 0,
        });
        assert!(placed.applied, "fixture house must place: {placed:?}");
    }
    engine.dispatch(GameIntent::PaintAreaRectangle {
        area: "civic".to_string(),
        start: (6, 10).into(),
        end: (8, 11).into(),
    });
    let school = engine.dispatch(GameIntent::PlaceBuilding {
        building_type: "school".to_string(),
        origin: (6, 10).into(),
        rotation: 0,
    });
    assert!(school.applied, "fixture school must place: {school:?}");
    engine.dispatch(GameIntent::SetPaused { paused: false });
    engine
}

#[test]
fn student_school_destination_is_deterministic_across_independent_engines() {
    // Two engines built by the same intents must derive the same seeded
    // school destination for the canonical Student (every 10th move-in).
    let mut first = student_school_engine();
    let mut second = student_school_engine();
    // Twelve housing slots move in within the first 550s; sim-010's day-0
    // school departure has already passed by then, so their first school
    // commute is day 1's outbound wake.
    let _ = first.tick(1_600.0);
    let _ = second.tick(1_600.0);

    let first_snapshot = first.snapshot();
    let second_snapshot = second.snapshot();
    let school_tiles: Vec<Point> = first_snapshot
        .buildings
        .iter()
        .filter(|building| building.building_type == "school")
        .flat_map(|building| building.occupied_tiles.iter().copied())
        .collect();
    assert!(!school_tiles.is_empty());

    for snapshot in [&first_snapshot, &second_snapshot] {
        let student = snapshot
            .sims
            .iter()
            .find(|sim| sim.id == "sim-010")
            .expect("the tenth move-in is the canonical Student");
        assert!(matches!(student.routine, CitizenRoutine::Student));
        let outbound = snapshot
            .active_trips
            .iter()
            .find(|trip| trip.sim_id == "sim-010" && trip.purpose == TripPurpose::CommuteOutbound)
            .expect("the student commutes to school on a school day");
        assert!(
            school_tiles.contains(&outbound.destination),
            "student destination must be a school footprint tile: {:?}",
            outbound.destination
        );
    }
    let first_destination = first_snapshot
        .active_trips
        .iter()
        .find(|trip| trip.sim_id == "sim-010")
        .map(|trip| trip.destination);
    let second_destination = second_snapshot
        .active_trips
        .iter()
        .find(|trip| trip.sim_id == "sim-010")
        .map(|trip| trip.destination);
    assert_eq!(first_destination, second_destination);
}

#[test]
fn worker_assigned_workplace_after_scheduled_departure_skips_today_outbound() {
    // Regression: when housing exists with no destinations and a destination is
    // built mid-day (after the worker's scheduled outbound departure has already
    // passed), spawning a retroactive trip anchored to the past `scheduled_time`
    // gives it a shortened or already-expired deadline (`scheduled_time + 900`).
    // The worker had no commute requirement at the departure boundary, so
    // today's outbound commute should be skipped — the worker commutes normally
    // on the next day when the scheduled departure is in the future.
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

    // sim-001 is a "standard" worker. Tick past its scheduled outbound departure
    // with no destination built yet — no trip should spawn (no workplace).
    let departure = departure_minute_for_sim("sim-001", "standard", "outbound");
    let scheduled = scheduled_time_seconds(0, departure);
    let past_departure = scheduled + 50.0;
    engine.tick(past_departure);
    let before_destination = engine.snapshot();
    assert!(
        !before_destination
            .active_trips
            .iter()
            .any(|trip| trip.sim_id == "sim-001"),
        "no trip should spawn before a workplace exists"
    );
    assert_eq!(before_destination.metrics.unserved_trips, 0);

    // Build a destination mid-day — assign_workplaces assigns sim-001 a workplace
    // after its scheduled departure has already passed.
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

    // Tick forward. Without the fix, this spawns a retroactive outbound trip
    // anchored to the past `scheduled_time`, producing a shortened SLA.
    engine.tick(60.0);

    let after = engine.snapshot();
    assert!(
        !after
            .active_trips
            .iter()
            .any(|trip| trip.sim_id == "sim-001" && trip.purpose == TripPurpose::CommuteOutbound),
        "worker assigned after departure should not spawn a retroactive outbound trip"
    );
    assert_eq!(after.metrics.unserved_trips, 0);
    assert_eq!(after.metrics.late_trips, 0);
}
