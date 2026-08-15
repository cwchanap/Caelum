mod common;

use caelum_core::model::{
    GameSnapshot, MetricsState, MovementKind, RoundaboutSize, ServicePattern, TransitMode,
    WorkerProfile,
};
use caelum_core::road_topology::RoadTopology;
use caelum_core::traffic::RoadFlow;
use caelum_core::{
    clock,
    scenario::{growing_suburb_campaign, growing_suburb_objectives},
    transit, trips, GameEngine, GameIntent, RoadPreset,
};

fn tick_trips(state: &GameSnapshot, topology: &RoadTopology, delta_seconds: f64) -> GameSnapshot {
    trips::tick_trips(state, topology, delta_seconds)
}

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
    assert_eq!(supermarket.snapshot.sims.len(), 0);
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

fn nearby_walker_campaign_engine() -> GameEngine {
    let mut engine = nearby_walker_engine();
    // Sandbox occupancy is tick-driven. Fill the housing before switching the
    // fixture into campaign mode, whose growth pipeline intentionally does not
    // apply Sandbox move-ins.
    engine.tick(500.0);
    let mut snapshot = engine.snapshot();
    let (rules, scenario) = growing_suburb_campaign(growing_suburb_objectives(), Vec::new());
    snapshot.rules = rules;
    snapshot.scenario = scenario;
    common::running_engine_from_fixture(snapshot)
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
    let mut engine = nearby_walker_campaign_engine();

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

    // Drive the raw tick across the day boundary. This isolates the day-rollover path
    // (reset_daily_commute_flags + spawn_due_commute_trips + sequence/day math); it no
    // longer needs to avoid a default-sandbox win.
    let topology = RoadTopology::compile(&snapshot.map).expect("fixture topology compiles");
    snapshot = tick_trips(&snapshot, &topology, 400.0);

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
    let created = engine.dispatch(GameIntent::CreateRoute {
        mode: TransitMode::Metro,
        pattern: ServicePattern::Loop,
        waypoint_ids: vec!["station-001".to_string(), "station-002".to_string()],
    });
    assert!(created.applied, "connected route should create its vehicle");

    let mut state = created.snapshot;
    state.paused = false;

    // Sanity: the densest boundary really is the 0.625s vehicle stop arrival, so
    // this setup genuinely exercises the failure mode.
    let boundary = transit::seconds_until_next_vehicle_stop(
        &state,
        &RoadFlow::new(),
        &state.transit.vehicles[0],
    )
    .expect("vehicle has a next stop");
    assert!(
        (boundary - 1.0 / transit::METRO_TILES_PER_SECOND).abs() < 1e-9,
        "expected a 0.625s stop boundary, got {boundary}"
    );

    let delta = 600.0_f64;
    let topology = RoadTopology::compile(&state.map).expect("fixture topology compiles");
    let advanced = tick_trips(&state, &topology, delta);

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
        let created = engine.dispatch(GameIntent::CreateRoute {
            mode: TransitMode::Metro,
            pattern: ServicePattern::Loop,
            waypoint_ids: vec!["station-001".to_string(), "station-002".to_string()],
        });
        assert!(created.applied, "connected route should create its vehicle");
        let mut state = created.snapshot;
        state.paused = false;
        state
    };

    let start = build();
    let topology = RoadTopology::compile(&start.map).expect("fixture topology compiles");
    let large = tick_trips(&start, &topology, 200.0);

    let mut stepped = start;
    for _ in 0..200 {
        stepped = tick_trips(&stepped, &topology, 1.0);
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

/// A deployed, time-spaced multi-bus route used by the granularity regression.
/// Its perimeter is long enough that the authoritative 60s floor requires more
/// than one bus, so every deployed cursor participates in the comparison.
fn deployed_bus_snapshot() -> caelum_core::GameSnapshot {
    let mut engine = GameEngine::new();
    for points in [
        (2..=25).map(|x| (x, 2).into()).collect::<Vec<_>>(),
        (2..=15).map(|y| (25, y).into()).collect::<Vec<_>>(),
        (2..=25).rev().map(|x| (x, 15).into()).collect::<Vec<_>>(),
        (2..=15).rev().map(|y| (2, y).into()).collect::<Vec<_>>(),
    ] {
        let result = engine.dispatch(GameIntent::LayRoadLine {
            points,
            preset: RoadPreset::TwoWay,
        });
        assert!(result.applied, "perimeter road should apply: {result:?}");
    }
    for point in [(2, 1), (25, 1), (25, 16), (2, 16)] {
        let result = engine.dispatch(GameIntent::AddBusStop {
            point: point.into(),
        });
        assert!(result.applied, "perimeter stop should apply: {result:?}");
    }
    let created = engine.dispatch(GameIntent::CreateRoute {
        mode: TransitMode::Bus,
        pattern: ServicePattern::Loop,
        waypoint_ids: (1..=4).map(|index| format!("stop-{index:03}")).collect(),
    });
    assert!(
        created.applied,
        "perimeter bus route should create: {created:?}"
    );
    let targeted = engine.dispatch(GameIntent::SetBusTargetHeadway {
        route_id: "route-001".to_string(),
        target_headway_seconds: 60,
    });
    assert!(
        targeted.applied,
        "perimeter target should apply: {targeted:?}"
    );
    let required = targeted.snapshot.transit.routes[0]
        .service_metrics
        .as_ref()
        .and_then(|metrics| metrics.required_fleet)
        .expect("perimeter route should have required fleet");
    assert!(
        required > 1,
        "granularity fixture must deploy multiple buses"
    );
    engine.set_budget_for_test(
        i32::try_from(required)
            .unwrap()
            .checked_mul(transit::BUS_COST)
            .unwrap(),
    );
    let deployed = engine.dispatch(GameIntent::DeployBusFleet {
        route_id: "route-001".to_string(),
    });
    assert!(
        deployed.applied,
        "perimeter fleet should deploy: {deployed:?}"
    );
    let mut state = deployed.snapshot;
    state.paused = false;
    state
}

#[test]
fn deployed_bus_fleet_is_granularity_independent() {
    let start = deployed_bus_snapshot();
    let topology = RoadTopology::compile(&start.map).expect("fixture topology compiles");
    let large = tick_trips(&start, &topology, 200.0);
    let leg_count = start.transit.routes[0].legs.len();

    let mut stepped = start;
    for _ in 0..200 {
        stepped = tick_trips(&stepped, &topology, 1.0);
    }

    assert!((large.time - stepped.time).abs() < 1e-6);
    assert_eq!(large.transit.vehicles.len(), stepped.transit.vehicles.len());
    for (large_vehicle, stepped_vehicle) in
        large.transit.vehicles.iter().zip(&stepped.transit.vehicles)
    {
        assert_eq!(large_vehicle.id, stepped_vehicle.id);
        assert_eq!(
            large_vehicle.itinerary_index % leg_count,
            stepped_vehicle.itinerary_index % leg_count
        );
        assert_eq!(
            large_vehicle.path_step_index,
            stepped_vehicle.path_step_index
        );
        assert!(
            (large_vehicle.step_progress - stepped_vehicle.step_progress).abs() < 1e-9,
            "vehicle {} diverged: large={} stepped={}",
            large_vehicle.id,
            large_vehicle.step_progress,
            stepped_vehicle.step_progress
        );
    }
}

// --- Roundabout route goldens ------------------------------------------------
//
// These pin the roundabout routing/circulation path that the earlier goldens
// (walking commutes, short metro segments) do not cover. The bus route below
// runs from (2,5) to (10,5) through a Standard3x3 roundabout at (5,4), so its
// `RoadPathStep` sequence includes a `RoundaboutEntry`/circulation/exit block —
// the new movement kinds this branch introduced. The asserts are deliberately
// baked in so any regression in roundabout geometry, router tie-break, or the
// substep pipeline surfaces as a test failure; they are NOT to be "fixed" by
// adjusting the constants.

/// Bus route fixture whose path enters, circulates, and exits a Standard3x3
/// roundabout. Mirrors the setup in
/// `transit_build::vehicle_time_through_roundabout_matches_authoritative_path_duration`,
/// but returns the post-creation snapshot (unpaused) so tick goldens can drive
/// it directly through `tick_trips`.
fn roundabout_bus_snapshot() -> caelum_core::GameSnapshot {
    let mut engine = GameEngine::new();
    // Horizontal arterial at y=5 carrying the bus from x=2 to x=10.
    for x in 2..=10 {
        engine.dispatch(GameIntent::LayRoad {
            point: (x, 5).into(),
        });
    }
    // Vertical road at x=6 gives the roundabout a north/south port to capture.
    for y in 1..=9 {
        engine.dispatch(GameIntent::LayRoad {
            point: (6, y).into(),
        });
    }
    engine.dispatch(GameIntent::AddBusStop {
        point: (2, 4).into(),
    });
    engine.dispatch(GameIntent::AddBusStop {
        point: (10, 4).into(),
    });
    let created = engine.dispatch(GameIntent::CreateRoute {
        mode: TransitMode::Bus,
        pattern: ServicePattern::Loop,
        waypoint_ids: vec!["stop-001".to_string(), "stop-002".to_string()],
    });
    assert!(created.applied, "roundabout bus route should create");
    let assigned = engine.dispatch(GameIntent::AssignVehicle {
        mode: "bus".to_string(),
        line_id: "route-001".to_string(),
    });
    assert!(
        assigned.applied,
        "roundabout bus fixture should assign: {assigned:?}"
    );
    let placed = engine.dispatch(GameIntent::PlaceRoundabout {
        origin: (5, 4).into(),
        size: RoundaboutSize::Standard3x3,
    });
    assert!(placed.applied, "roundabout should place on the arterial");

    // Sanity: the route really does circulate through the roundabout — without
    // this, the golden below would silently degrade to a straight-line bus test
    // and stop pinning the new movement kinds.
    let route = &placed.snapshot.transit.routes[0];
    let path = route.legs[0]
        .current_path
        .as_ref()
        .expect("roundabout bus leg has a resolved path");
    assert!(
        path.road_steps()
            .iter()
            .any(|step| step.movement == MovementKind::RoundaboutEntry),
        "bus path must enter the roundabout"
    );

    let mut state = placed.snapshot;
    state.paused = false;
    state
}

/// Determinism golden: a single large tick and many 1s stepped ticks must land
/// the roundabout-circulating bus at the same (itinerary_index mod 2,
/// path_step_index, step_progress). This is the roundabout analogue of
/// `short_metro_segment_large_tick_matches_stepped_tick` and pins that the
/// substep pipeline is granularity-independent across the roundabout
/// entry/circulation/exit block, not just straight segments.
#[test]
fn roundabout_bus_large_tick_matches_stepped_tick() {
    let start = roundabout_bus_snapshot();
    let topology = RoadTopology::compile(&start.map).expect("fixture topology compiles");
    let large = tick_trips(&start, &topology, 200.0);

    let mut stepped = start;
    for _ in 0..200 {
        stepped = tick_trips(&stepped, &topology, 1.0);
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
    assert!(
        (lv.step_progress - sv.step_progress).abs() < 1e-9,
        "vehicle step_progress must match: large={} stepped={}",
        lv.step_progress,
        sv.step_progress
    );
}

/// Metric golden: after a fixed 120s of real ticks the roundabout-circulating
/// bus is at a stable, baked-in (itinerary_index, path_step_index,
/// step_progress). This pins the roundabout circulation rate and the leg-advance
/// accounting against regressions in `PathGeometry` arc parametrization or the
/// `RoundaboutEntry`/`RoundaboutCirculation`/`RoundaboutExit` step durations.
/// The constants are captured from the current Rust core; a change here means
/// behaviour changed.
#[test]
fn roundabout_bus_vehicle_has_stable_golden_state_after_fixed_duration() {
    let state = roundabout_bus_snapshot();
    let topology = RoadTopology::compile(&state.map).expect("fixture topology compiles");
    let after = tick_trips(&state, &topology, 120.0);
    let vehicle = &after.transit.vehicles[0];

    // After 120s the bus has completed leg 0 (one stop-to-stop pass through the
    // roundabout) and is 60% through the first step of leg 1. The exact values
    // are deterministic given the roundabout step durations; bake them in.
    assert_eq!(vehicle.itinerary_index, 1);
    assert_eq!(vehicle.path_step_index, 0);
    assert!(
        (vehicle.step_progress - 0.6).abs() < 1e-9,
        "step_progress must be 0.6, got {}",
        vehicle.step_progress
    );
}
