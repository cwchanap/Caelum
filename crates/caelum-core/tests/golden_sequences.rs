use caelum_core::model::{MetricsState, WorkerProfile};
use caelum_core::{clock, transit, trips, GameEngine, GameIntent};

#[test]
fn zone_build_and_route_sequence_has_stable_counts() {
    let mut engine = GameEngine::new();

    let residential = engine.dispatch(GameIntent::PaintAreaRectangle {
        area: "residential".to_string(),
        start: (2, 3).into(),
        end: (3, 4).into(),
    });
    assert!(residential.applied);

    let house = engine.dispatch(GameIntent::PlaceBuilding {
        building_type: "smallHouse".to_string(),
        origin: (2, 3).into(),
        rotation: 0,
    });
    assert!(house.applied);

    let commercial = engine.dispatch(GameIntent::PaintAreaRectangle {
        area: "commercial".to_string(),
        start: (8, 3).into(),
        end: (9, 4).into(),
    });
    assert!(commercial.applied);

    let supermarket = engine.dispatch(GameIntent::PlaceBuilding {
        building_type: "supermarket".to_string(),
        origin: (8, 3).into(),
        rotation: 0,
    });
    assert!(supermarket.applied);

    assert_eq!(supermarket.snapshot.buildings.len(), 2);
    assert_eq!(supermarket.snapshot.sims.len(), 4);
    assert_eq!(supermarket.snapshot.budget, 108_000);
}

// --- Multi-tick golden traces ------------------------------------------------
//
// The tests below pin the integrated tick pipeline (trip spawn/advance, metrics,
// objectives, day rollover). The asserted constants are golden values captured from
// the current Rust core; they are deliberately baked in so any regression in routing,
// trip lifecycle, or metric accounting surfaces as a test failure. They are NOT to be
// "fixed" by adjusting the constants — a change here means behaviour changed.

/// Minimal "nearby walker" city: a small house (4 residents, all standard workers)
/// whose occupants walk to a colocated supermarket. Walking needs no transit, so every
/// commute completes deterministically and on time.
fn nearby_walker_engine() -> GameEngine {
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

/// Golden trace over a full day-0 commute. By 900s every resident has completed the
/// outbound leg and two have completed the return; the other two (3-tile walks to
/// tiles (4,4)/(5,4)) are still mid-return. So the pipeline shows six lifetime
/// completions, two in-flight trips, zero late/unserved — while still "running" (the
/// survival win triggers at 1200s, see `won_via_real_tick_pipeline`).
#[test]
fn full_day_commute_trace_has_stable_golden_metrics() {
    let mut engine = nearby_walker_engine();

    let result = engine.tick(900.0);
    let snapshot = &result.snapshot;

    assert!(result.applied);
    assert_eq!(snapshot.day, 0);
    assert_eq!(snapshot.clock_minutes, 1080);
    assert_eq!(snapshot.metrics.state, MetricsState::Running);
    // 4 outbound + 2 return = 6 lifetime completions; sim-003/004 still walking home.
    assert_eq!(snapshot.metrics.completed_trips, 6);
    assert_eq!(snapshot.metrics.late_trips, 0);
    assert_eq!(snapshot.metrics.unserved_trips, 0);
    assert_eq!(snapshot.metrics.waiting_trip_count, 0);
    assert_eq!(snapshot.active_trips.len(), 2);
    // trip_outcomes is the rolling 300s window (see prune_trip_outcomes): only the two
    // ~890s returns survive; the four ~390s outbound arrivals were pruned.
    assert_eq!(snapshot.metrics.trip_outcomes.len(), 2);
}

/// A large forward tick and many 1s stepped ticks must reach byte-identical metric
/// counts — the substep pipeline must not depend on tick granularity.
#[test]
fn large_tick_matches_stepped_tick_for_full_commute() {
    let mut large = nearby_walker_engine();
    let mut stepped = nearby_walker_engine();

    let large_snapshot = large.tick(900.0).snapshot;

    let mut stepped_snapshot = stepped.tick(0.0).snapshot;
    while stepped_snapshot.time < 900.0 {
        stepped_snapshot = stepped.tick(1.0).snapshot;
    }

    assert_eq!(
        stepped_snapshot.metrics.completed_trips,
        large_snapshot.metrics.completed_trips
    );
    assert_eq!(
        stepped_snapshot.metrics.late_trips,
        large_snapshot.metrics.late_trips
    );
    assert_eq!(
        stepped_snapshot.metrics.unserved_trips,
        large_snapshot.metrics.unserved_trips
    );
    assert_eq!(stepped_snapshot.day, large_snapshot.day);
}

#[test]
fn won_via_real_tick_pipeline() {
    let mut engine = nearby_walker_engine();

    // Tick past the survival threshold with real completed demand in the pipeline.
    let result = engine.tick(clock::GAME_DAY_SECONDS + 1.0);

    assert_eq!(result.snapshot.metrics.state, MetricsState::Won);
    assert_eq!(result.snapshot.metrics.loss_reason, None);
    assert!(result.snapshot.metrics.completed_trips > 0);
}

#[test]
fn commute_respawns_across_day_boundary() {
    let mut engine = nearby_walker_engine();

    // Run all of day 0 to completion without crossing the survival win at 1200s.
    let mut snapshot = engine.tick(clock::GAME_DAY_SECONDS - 1.0).snapshot;
    assert_eq!(snapshot.day, 0);
    assert_eq!(snapshot.metrics.state, MetricsState::Running);
    assert!(snapshot.active_trips.is_empty());

    // Drive the raw tick across the day boundary. We call trips::tick_trips directly
    // because the engine wraps it with evaluate_objectives, which would terminate the
    // game by winning at exactly GAME_DAY_SECONDS. This isolates the day-rollover path
    // (reset_daily_commute_flags + spawn_due_commute_trips + sequence/day math).
    snapshot = trips::tick_trips(&snapshot, 400.0);

    assert_eq!(snapshot.day, 1);
    // Daily commute flags must reset so residents are eligible to commute again.
    assert!(snapshot.sims.iter().any(|sim| {
        sim.worker_profile == WorkerProfile::Worker
            && !sim.outbound_resolved_today
            && !sim.outbound_arrived_today
    }));
    // Fresh day-1 trips must spawn with day-1 ids, and no day-0 id may leak across.
    assert!(
        snapshot
            .active_trips
            .iter()
            .any(|trip| trip.id.starts_with("trip-day-1-trip-")),
        "day-1 commute trips should respawn after the day boundary"
    );
    assert!(snapshot
        .active_trips
        .iter()
        .all(|trip| !trip.id.starts_with("trip-day-0-trip-")));
}

/// Regression: a large tick advanced while a metro runs on a short segment must
/// progress the full `delta`, not truncate at the substep cap.
///
/// `next_boundary_after` breaks every substep at each vehicle's next stop arrival.
/// A 1-tile metro segment yields a stop boundary every `1 / METRO_TILES_PER_SECOND`
/// = 0.625s — denser than the old per-second substep budget. Before the fix, a 600s
/// tick with such a vehicle exhausted the cap at ~377s and silently dropped the
/// remaining ~223s, violating the tick's advance-by-delta contract (and the
/// determinism/granularity-independence invariant the rest of this file pins).
#[test]
fn large_tick_with_short_metro_segment_advances_full_delta() {
    let mut engine = GameEngine::new();
    // Two adjacent metro stations -> a single 1-tile segment between them.
    for x in 2..=3 {
        engine.dispatch(GameIntent::LayTrack {
            point: (x, 4).into(),
        });
    }
    engine.dispatch(GameIntent::AddMetroStation {
        point: (2, 4).into(),
    });
    engine.dispatch(GameIntent::AddMetroStation {
        point: (3, 4).into(),
    });
    engine.dispatch(GameIntent::AddMetroLine {
        station_ids: vec!["station-001".to_string(), "station-002".to_string()],
    });
    let assigned = engine.dispatch(GameIntent::AssignVehicle {
        mode: "metro".to_string(),
        line_id: "metro-001".to_string(),
    });
    assert!(
        assigned.applied,
        "vehicle should assign on a connected line"
    );

    let mut state = assigned.snapshot;
    state.paused = false;

    // Sanity: the densest boundary really is the 0.625s vehicle stop arrival, so
    // this setup genuinely exercises the failure mode.
    let boundary = transit::seconds_until_next_vehicle_stop(&state, &state.transit.vehicles[0])
        .expect("vehicle has a next stop");
    assert!(
        (boundary - 1.0 / transit::METRO_TILES_PER_SECOND).abs() < 1e-9,
        "expected a 0.625s stop boundary, got {boundary}"
    );

    let delta = 600.0_f64;
    let advanced = trips::tick_trips(&state, delta);

    assert!(
        (advanced.time - state.time - delta).abs() < 1e-6,
        "tick must advance the full {delta}s; only progressed {}s",
        advanced.time - state.time
    );
}

/// Regression companion to the above: a single large tick and many small ticks must
/// land the vehicle at the same place, since the substep pipeline is granularity
/// independent. This pins the fix against the opposite failure (the cap masking a
/// real divergence between coarse and fine stepping).
#[test]
fn short_metro_segment_large_tick_matches_stepped_tick() {
    let build = || -> caelum_core::GameSnapshot {
        let mut engine = GameEngine::new();
        for x in 2..=3 {
            engine.dispatch(GameIntent::LayTrack {
                point: (x, 4).into(),
            });
        }
        engine.dispatch(GameIntent::AddMetroStation {
            point: (2, 4).into(),
        });
        engine.dispatch(GameIntent::AddMetroStation {
            point: (3, 4).into(),
        });
        engine.dispatch(GameIntent::AddMetroLine {
            station_ids: vec!["station-001".to_string(), "station-002".to_string()],
        });
        let assigned = engine.dispatch(GameIntent::AssignVehicle {
            mode: "metro".to_string(),
            line_id: "metro-001".to_string(),
        });
        let mut state = assigned.snapshot;
        state.paused = false;
        state
    };

    let large = trips::tick_trips(&build(), 200.0);

    let mut stepped = build();
    for _ in 0..200 {
        stepped = trips::tick_trips(&stepped, 1.0);
    }

    assert!(
        (large.time - stepped.time).abs() < 1e-6,
        "large and stepped ticks must agree on time: large={} stepped={}",
        large.time,
        stepped.time
    );
    let (lv, sv) = (&large.transit.vehicles[0], &stepped.transit.vehicles[0]);
    assert_eq!(lv.itinerary_index % 2, sv.itinerary_index % 2);
    assert_eq!(lv.path_step_index, sv.path_step_index);
    assert!((lv.step_progress - sv.step_progress).abs() < 1e-9);
}
