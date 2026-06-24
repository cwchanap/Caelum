use caelum_core::{GameEngine, GameIntent};

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
    assert_eq!(snapshot.metrics.state, "running");
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
    assert_eq!(
        result.rejection.as_deref(),
        Some("line not found: missing-route")
    );
}
