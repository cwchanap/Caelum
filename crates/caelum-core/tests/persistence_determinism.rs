use caelum_core::model::{EconomyPreset, Point, ServicePattern, TransitMode};
use caelum_core::{GameEngine, GameIntent, RoadPreset, SandboxCreationRequest};

fn assert_savable(engine: &GameEngine, label: &str) {
    let saved = engine.snapshot_for_save();
    GameEngine::from_snapshot(saved).unwrap_or_else(|error| {
        panic!("{label} produced a state that cannot be restored: {error:?}")
    });
}

fn apply(engine: &mut GameEngine, intent: GameIntent) {
    let label = format!("dispatch {intent:?}");
    let result = engine.dispatch(intent);
    assert!(
        result.applied,
        "fixture intent was rejected or unchanged: {:?}",
        result.rejection
    );
    assert_savable(engine, &label);
}

fn apply_tick(engine: &mut GameEngine, seconds: f64) {
    let result = engine.tick(seconds);
    assert!(result.applied, "tick {seconds} must apply");
    assert_savable(engine, &format!("tick {seconds}"));
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

    // `snapshot()` publishes derived bus service metrics while
    // `snapshot_for_save()` strips them, so restore fidelity is compared on
    // the normalized save form.
    assert_eq!(restored.snapshot_for_save(), saved);
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
        assert_savable(&original, "original continuation state");
        assert_savable(&restored, "restored continuation state");
    }
}

#[test]
fn restored_creative_snapshot_immediately_applies_nominal_road_cost_without_deduction() {
    let mut direct = GameEngine::from_sandbox_request(SandboxCreationRequest {
        template_id: "blankGrid".to_string(),
        economy_preset: "creative".to_string(),
        starting_capital: Some(0.0),
        demand_multiplier: Some(1.0),
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
