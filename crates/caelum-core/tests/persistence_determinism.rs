use std::time::{Duration, Instant};

use caelum_core::model::{
    ActiveTrip, EconomyPreset, Point, ServicePattern, Sim, TransitMode, TripPosition, TripPurpose,
    TripStatus,
};
use caelum_core::{
    commute, validate_snapshot, GameEngine, GameIntent, RoadPreset, SandboxCreationRequest,
};

fn apply(engine: &mut GameEngine, intent: GameIntent) {
    let result = engine.dispatch(intent);
    assert!(
        result.applied,
        "fixture intent was rejected or unchanged: {:?}",
        result.rejection
    );
}

fn apply_tick(engine: &mut GameEngine, seconds: f64) {
    let result = engine.tick(seconds);
    assert!(result.applied, "tick {seconds} must apply");
}

fn production_fixture() -> GameEngine {
    let mut engine = GameEngine::new();
    apply(
        &mut engine,
        GameIntent::LayRoadLine {
            points: (2..=12).map(|x| Point { x, y: 5 }).collect(),
            preset: RoadPreset::TwoWay,
        },
    );
    for point in [Point { x: 2, y: 4 }, Point { x: 10, y: 4 }] {
        apply(&mut engine, GameIntent::AddBusStop { point });
    }
    apply(
        &mut engine,
        GameIntent::CreateRoute {
            mode: TransitMode::Bus,
            pattern: ServicePattern::Loop,
            waypoint_ids: vec!["stop-001".to_string(), "stop-002".to_string()],
        },
    );
    apply(
        &mut engine,
        GameIntent::PaintAreaRectangle {
            area: "residential".to_string(),
            start: Point { x: 2, y: 3 },
            end: Point { x: 3, y: 3 },
        },
    );
    apply(
        &mut engine,
        GameIntent::PlaceBuilding {
            building_type: "smallHouse".to_string(),
            origin: Point { x: 2, y: 3 },
            rotation: 0,
        },
    );
    apply(
        &mut engine,
        GameIntent::PaintAreaRectangle {
            area: "commercial".to_string(),
            start: Point { x: 6, y: 3 },
            end: Point { x: 7, y: 4 },
        },
    );
    apply(
        &mut engine,
        GameIntent::PlaceBuilding {
            building_type: "supermarket".to_string(),
            origin: Point { x: 6, y: 3 },
            rotation: 0,
        },
    );
    apply(&mut engine, GameIntent::SetPaused { paused: false });

    apply_tick(&mut engine, 350.9);
    apply_tick(&mut engine, 80.1);
    let snapshot = engine.snapshot();
    assert!(!snapshot.sims.is_empty());
    assert!(!snapshot.active_trips.is_empty());
    assert!(!snapshot.metrics.trip_outcomes.is_empty());
    engine
}

#[test]
fn every_reachable_production_state_is_savable() {
    let mut engine = production_fixture();

    apply(&mut engine, GameIntent::SetSpeed { speed: 2 });
    apply_tick(&mut engine, 15.0);
    apply(
        &mut engine,
        GameIntent::DeleteRoute {
            route_id: "route-001".to_string(),
        },
    );
    apply(
        &mut engine,
        GameIntent::LayRoad {
            point: Point { x: 12, y: 10 },
        },
    );
    apply_tick(&mut engine, 20.0);
    apply(&mut engine, GameIntent::SetPaused { paused: true });
}

#[test]
fn restored_engine_has_identical_future_results_and_topology() {
    let mut original = production_fixture();
    apply(&mut original, GameIntent::SetPaused { paused: true });
    let saved = original.snapshot_for_save();
    let mut restored = GameEngine::from_snapshot(saved.clone()).unwrap();

    assert_eq!(restored.snapshot(), saved);
    assert_eq!(
        original.road_topology_for_test(),
        restored.road_topology_for_test()
    );

    let intents_and_ticks = [
        Either::Intent(GameIntent::SetPaused { paused: false }),
        Either::Tick(30.0),
        Either::Intent(GameIntent::SetSpeed { speed: 2 }),
        Either::Tick(15.0),
        Either::Intent(GameIntent::LayRoad {
            point: Point { x: 12, y: 10 },
        }),
        Either::Tick(20.0),
        Either::Intent(GameIntent::SetPaused { paused: true }),
    ];

    for operation in intents_and_ticks {
        let (original_result, restored_result) = match operation {
            Either::Intent(intent) => {
                (original.dispatch(intent.clone()), restored.dispatch(intent))
            }
            Either::Tick(seconds) => (original.tick(seconds), restored.tick(seconds)),
        };
        assert_eq!(original_result, restored_result);
        assert_eq!(original.snapshot(), restored.snapshot());
        assert_eq!(
            original.road_topology_for_test(),
            restored.road_topology_for_test()
        );
    }
}

#[test]
fn restored_creative_snapshot_immediately_applies_nominal_road_cost_without_deduction() {
    let mut direct = GameEngine::from_sandbox_request(SandboxCreationRequest {
        template_id: "blankGrid".to_string(),
        economy_preset: "creative".to_string(),
        starting_capital: Some(0.0),
        demand_multiplier: Some(1.0),
        move_in_rate: "paused".to_string(),
    })
    .expect("Creative Blank Grid request should construct directly");
    let snapshot = direct.snapshot();
    assert_eq!(snapshot.rules.economy_preset, EconomyPreset::Creative);
    assert_eq!(snapshot.budget, 0);
    assert!(snapshot.paused);

    let mut restored = GameEngine::from_snapshot(snapshot.clone()).unwrap();
    let restored_before = restored.snapshot();
    assert_eq!(restored.snapshot(), snapshot);
    assert_eq!(
        restored.road_topology_for_test(),
        direct.road_topology_for_test()
    );

    let result = restored.dispatch(GameIntent::LayRoad {
        point: Point { x: 2, y: 2 },
    });
    let direct_result = direct.dispatch(GameIntent::LayRoad {
        point: Point { x: 2, y: 2 },
    });

    assert!(result.applied);
    assert_eq!(result.snapshot.budget, restored_before.budget);
    assert_eq!(
        result.snapshot.rules.economy_preset,
        EconomyPreset::Creative
    );
    assert_eq!(result, direct_result);
    assert_eq!(restored.snapshot(), direct.snapshot());
    assert_eq!(
        restored.road_topology_for_test(),
        direct.road_topology_for_test()
    );
}

enum Either {
    Intent(GameIntent),
    Tick(f64),
}

fn large_validation_fixture() -> caelum_core::GameSnapshot {
    let mut engine = GameEngine::new();
    apply(
        &mut engine,
        GameIntent::LayRoadLine {
            points: (2..=12).map(|x| Point { x, y: 5 }).collect(),
            preset: RoadPreset::TwoWay,
        },
    );
    for point in [Point { x: 2, y: 4 }, Point { x: 10, y: 4 }] {
        apply(&mut engine, GameIntent::AddBusStop { point });
    }
    apply(
        &mut engine,
        GameIntent::CreateRoute {
            mode: TransitMode::Bus,
            pattern: ServicePattern::Loop,
            waypoint_ids: vec!["stop-001".to_string(), "stop-002".to_string()],
        },
    );

    let mut snapshot = engine.snapshot_for_save();
    let route_template = snapshot.transit.routes[0].clone();
    let vehicle_template = snapshot.transit.vehicles[0].clone();
    snapshot.transit.routes.clear();
    snapshot.transit.vehicles.clear();
    for stop in &mut snapshot.transit.stops {
        for platform in &mut stop.platforms {
            platform.route_ids.clear();
        }
    }
    for number in 1..=100 {
        let route_id = format!("route-{number:03}");
        let vehicle_id = format!("vehicle-{number:03}");
        let mut route = route_template.clone();
        route.id.clone_from(&route_id);
        route.name = format!("Route {number}");
        route.vehicle_ids = vec![vehicle_id.clone()];
        snapshot.transit.routes.push(route);

        let mut vehicle = vehicle_template.clone();
        vehicle.id = vehicle_id;
        vehicle.line_id.clone_from(&route_id);
        snapshot.transit.vehicles.push(vehicle);
        for stop in &mut snapshot.transit.stops {
            stop.platforms[0].route_ids.push(route_id.clone());
        }
    }

    snapshot.sims = (1..=1_000)
        .map(|number| {
            let id = format!("sim-{number:03}");
            Sim {
                id: id.clone(),
                home: Point { x: 1, y: 1 },
                position: Point { x: 1, y: 1 },
                worker_profile: commute::worker_profile_for_id(&id),
                shift_template: commute::shift_template_for_id(&id).map(str::to_string),
                workplace: None,
                commute_day: 0,
                outbound_resolved_today: false,
                outbound_arrived_today: false,
                return_resolved_today: false,
                returned_home_today: false,
            }
        })
        .collect();
    snapshot.active_trips = snapshot
        .sims
        .iter()
        .enumerate()
        .map(|(index, sim)| ActiveTrip {
            id: format!("trip-day-0-trip-{:03}", index + 1),
            sim_id: sim.id.clone(),
            purpose: TripPurpose::CommuteOutbound,
            origin: sim.home,
            destination: sim.home,
            position: TripPosition::from(sim.home),
            status: TripStatus::Idle,
            deadline: 900.0,
            route_plan: None,
            current_leg_index: 0,
            patience_remaining: 240.0,
        })
        .collect();
    snapshot.trip_sequence_day = 0;
    snapshot.next_trip_sequence = 1_001;
    validate_snapshot(&snapshot).unwrap();
    snapshot
}

fn percentile(sorted: &[Duration], percentile: usize) -> Duration {
    let rank = (sorted.len() * percentile).div_ceil(100);
    sorted[rank.saturating_sub(1).min(sorted.len() - 1)]
}

fn measure(label: &str, mut operation: impl FnMut()) {
    let cold_started = Instant::now();
    operation();
    let cold = cold_started.elapsed();

    for _ in 0..2 {
        operation();
    }

    let mut samples = Vec::with_capacity(25);
    for _ in 0..25 {
        let started = Instant::now();
        operation();
        samples.push(started.elapsed());
    }
    samples.sort();

    let median = samples[samples.len() / 2];
    let p95 = percentile(&samples, 95);
    println!("{label}: cold={cold:?}, median={median:?}, p95={p95:?}, samples=25");
    assert!(median > Duration::ZERO);
}

#[test]
#[ignore = "non-CI release performance evidence"]
fn persistence_validation_benchmark() {
    let snapshot = large_validation_fixture();
    measure("native validate", || {
        validate_snapshot(&snapshot).unwrap();
    });
    measure("native prepared restore", || {
        drop(GameEngine::from_snapshot(snapshot.clone()).unwrap());
    });
}
