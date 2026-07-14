use caelum_core::model::{MetricsState, ServicePattern, TransitMode};
use caelum_core::{GameEngine, GameIntent, RejectionCode, RoadPreset};

fn assert_intent_json(intent: GameIntent, json: serde_json::Value) {
    let decoded: GameIntent =
        serde_json::from_value(json.clone()).expect("intent should deserialize");
    assert_eq!(decoded, intent);
    let serialized = serde_json::to_value(&decoded).expect("intent should serialize");
    assert_eq!(serialized, json);
}

#[test]
fn assign_vehicle_intent_uses_camel_case_json_fields() {
    let intent: GameIntent = serde_json::from_value(serde_json::json!({
        "type": "assignVehicle",
        "mode": "bus",
        "lineId": "route-001"
    }))
    .expect("assign vehicle intent should deserialize from camelCase JSON");

    assert_eq!(
        intent,
        GameIntent::AssignVehicle {
            mode: "bus".to_string(),
            line_id: "route-001".to_string(),
        }
    );

    let serialized =
        serde_json::to_value(&intent).expect("assign vehicle intent should serialize to JSON");

    assert_eq!(
        serialized,
        serde_json::json!({
            "type": "assignVehicle",
            "mode": "bus",
            "lineId": "route-001"
        })
    );
    assert!(serialized.get("line_id").is_none());
}

#[test]
fn transit_intents_use_camel_case_json_fields() {
    assert_intent_json(
        GameIntent::LayRoad {
            point: (3, 4).into(),
        },
        serde_json::json!({
            "type": "layRoad",
            "point": { "x": 3, "y": 4 }
        }),
    );
    assert_intent_json(
        GameIntent::AddBusStop {
            point: (5, 6).into(),
        },
        serde_json::json!({
            "type": "addBusStop",
            "point": { "x": 5, "y": 6 }
        }),
    );
    assert_intent_json(
        GameIntent::CreateRoute {
            mode: TransitMode::Metro,
            pattern: ServicePattern::Loop,
            waypoint_ids: vec!["station-001".to_string(), "station-002".to_string()],
        },
        serde_json::json!({
            "type": "createRoute",
            "mode": "metro",
            "pattern": "loop",
            "waypointIds": ["station-001", "station-002"]
        }),
    );
    assert_intent_json(
        GameIntent::AssignRouteToPlatform {
            node_id: "stop-001".to_string(),
            route_id: "route-001".to_string(),
            platform_id: "stop-001-p0".to_string(),
        },
        serde_json::json!({
            "type": "assignRouteToPlatform",
            "nodeId": "stop-001",
            "routeId": "route-001",
            "platformId": "stop-001-p0"
        }),
    );
}

#[test]
fn area_and_building_intents_use_camel_case_json_fields() {
    let paint_intent: GameIntent = serde_json::from_value(serde_json::json!({
        "type": "paintAreaRectangle",
        "area": "residential",
        "start": { "x": 2, "y": 3 },
        "end": { "x": 4, "y": 4 }
    }))
    .expect("paint area intent should deserialize from camelCase JSON");

    assert_eq!(
        paint_intent,
        GameIntent::PaintAreaRectangle {
            area: "residential".to_string(),
            start: (2, 3).into(),
            end: (4, 4).into(),
        }
    );

    let serialized_paint =
        serde_json::to_value(&paint_intent).expect("paint area intent should serialize to JSON");
    assert_eq!(
        serialized_paint,
        serde_json::json!({
            "type": "paintAreaRectangle",
            "area": "residential",
            "start": { "x": 2, "y": 3 },
            "end": { "x": 4, "y": 4 }
        })
    );

    let building_intent: GameIntent = serde_json::from_value(serde_json::json!({
        "type": "placeBuilding",
        "buildingType": "largeHouse",
        "origin": { "x": 2, "y": 3 },
        "rotation": 90
    }))
    .expect("place building intent should deserialize from camelCase JSON");

    assert_eq!(
        building_intent,
        GameIntent::PlaceBuilding {
            building_type: "largeHouse".to_string(),
            origin: (2, 3).into(),
            rotation: 90,
        }
    );

    let serialized_building = serde_json::to_value(&building_intent)
        .expect("place building intent should serialize to JSON");
    assert_eq!(
        serialized_building,
        serde_json::json!({
            "type": "placeBuilding",
            "buildingType": "largeHouse",
            "origin": { "x": 2, "y": 3 },
            "rotation": 90
        })
    );
    assert!(serialized_building.get("building_type").is_none());
}

#[test]
fn new_engine_exposes_initial_snapshot() {
    let engine = GameEngine::new();
    let snapshot = engine.snapshot();

    assert_eq!(snapshot.time, 0.0);
    assert_eq!(snapshot.day, 0);
    assert_eq!(snapshot.clock_minutes, 0);
    assert!(snapshot.paused);
    assert_eq!(snapshot.speed, 1);
    assert_eq!(snapshot.map.width, 28);
    assert_eq!(snapshot.map.height, 18);
    assert_eq!(snapshot.metrics.state, MetricsState::Running);
}

#[test]
fn no_op_tick_returns_unapplied_snapshot() {
    // A fresh engine is paused with speed 1; a zero-delta tick must return the
    // previous snapshot unchanged with `applied == false` (engine.rs contract).
    let mut engine = GameEngine::new();
    let before = engine.snapshot();

    let result = engine.tick(0.0);

    assert!(!result.applied);
    assert!(result.rejection.is_none());
    assert_eq!(result.snapshot, before);
}

#[test]
fn serialized_snapshot_does_not_include_the_engine_topology_cache() {
    let engine = GameEngine::new();
    let value = serde_json::to_value(engine.snapshot()).expect("snapshot should serialize");

    assert!(value.get("roadTopology").is_none());
    assert!(value.get("road_topology").is_none());
}

#[test]
fn invalid_intent_returns_rejection_and_unchanged_snapshot() {
    let mut engine = GameEngine::new();
    let before = engine.snapshot();

    let result = engine.dispatch(GameIntent::AssignVehicle {
        mode: "bus".to_string(),
        line_id: "missing-route".to_string(),
    });

    assert!(!result.applied);
    assert_eq!(result.snapshot, before);
    let rejection = result.rejection.expect("missing route should reject");
    assert_eq!(rejection.code, RejectionCode::RouteNotFound);
    assert_eq!(rejection.context.route_id.as_deref(), Some("missing-route"));
}

#[test]
fn set_paused_applies_without_mutating_prior_snapshot() {
    let mut engine = GameEngine::new();
    let before = engine.snapshot();
    assert!(before.paused);

    let result = engine.dispatch(GameIntent::SetPaused { paused: false });

    assert!(result.applied);
    assert!(result.rejection.is_none());
    assert!(!result.snapshot.paused);
    // The previously published snapshot is unaffected (clone-on-read discipline).
    assert!(before.paused);
    assert_ne!(result.snapshot, before);
}

#[test]
fn set_speed_accepts_valid_speeds_and_persists() {
    let mut engine = GameEngine::new();

    // 0 is the special no-op speed (accepted by dispatch, freezes the tick pipeline);
    // 1/2/4 are the real speed multipliers. Each must apply and persist.
    for speed in [0, 1, 2, 4] {
        let result = engine.dispatch(GameIntent::SetSpeed { speed });
        assert!(result.applied);
        assert!(result.rejection.is_none());
        assert_eq!(result.snapshot.speed, speed);
    }
}

#[test]
fn set_speed_rejects_invalid_speed_without_changing_snapshot() {
    let mut engine = GameEngine::new();
    engine.dispatch(GameIntent::SetSpeed { speed: 2 });
    let before = engine.snapshot();

    let result = engine.dispatch(GameIntent::SetSpeed { speed: 3 });

    assert!(!result.applied);
    assert_eq!(result.snapshot, before);
    assert_eq!(result.snapshot.speed, 2);
    assert_eq!(
        result.rejection.map(|rejection| rejection.code),
        Some(RejectionCode::InvalidSpeed)
    );
}

fn replay_intent_sequence() -> Vec<GameIntent> {
    // A non-trial sequence exercising road topology compilation, transit node
    // creation, route building, vehicle assignment, and speed/pause mutations —
    // the paths most likely to leak HashMap-iteration order into serialized state.
    vec![
        GameIntent::LayRoadLine {
            points: (2..=8)
                .map(|x| caelum_core::model::Point { x, y: 5 })
                .collect(),
            preset: RoadPreset::TwoWay,
        },
        GameIntent::AddBusStop {
            point: caelum_core::model::Point { x: 2, y: 5 },
        },
        GameIntent::AddBusStop {
            point: caelum_core::model::Point { x: 8, y: 5 },
        },
        GameIntent::CreateRoute {
            mode: TransitMode::Bus,
            pattern: ServicePattern::Loop,
            waypoint_ids: vec!["stop-001".to_string(), "stop-002".to_string()],
        },
        GameIntent::AssignVehicle {
            mode: "bus".to_string(),
            line_id: "route-001".to_string(),
        },
        GameIntent::SetSpeed { speed: 1 },
        GameIntent::SetPaused { paused: false },
    ]
}

#[test]
fn identical_replay_produces_identical_snapshots() {
    // Two independent engines fed the same intent sequence (and then the same
    // tick deltas) must converge to byte-identical snapshots. This guards
    // against future HashMap-iteration order leaking into serialized state.
    let intents = replay_intent_sequence();

    let mut engine_a = GameEngine::new();
    let mut engine_b = GameEngine::new();
    assert_eq!(engine_a.snapshot(), engine_b.snapshot());

    for intent in intents {
        let result_a = engine_a.dispatch(intent.clone());
        let result_b = engine_b.dispatch(intent);
        assert_eq!(result_a.applied, result_b.applied);
        assert_eq!(engine_a.snapshot(), engine_b.snapshot());
    }

    // Tick both engines with identical deltas and confirm they stay in lockstep.
    for delta in [0.25, 0.5, 1.0, 0.125] {
        let tick_a = engine_a.tick(delta);
        let tick_b = engine_b.tick(delta);
        assert_eq!(tick_a.applied, tick_b.applied);
        assert_eq!(engine_a.snapshot(), engine_b.snapshot());
    }
}
