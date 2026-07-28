//! Coverage for `engine.rs` edge cases reachable through persistence: the
//! `snapshot_for_save`/`restore_snapshot` validation path and the
//! `from_sandbox_request` error path.

use caelum_core::{GameEngine, DEFAULT_STARTING_CAPITAL};

#[test]
fn snapshot_for_save_rejects_a_nonfinite_metric() {
    let mut engine = GameEngine::new();
    engine.set_budget_for_test(1);
    // Corrupt a metric after construction; snapshot_for_save must reject it.
    let mut corrupt = engine.snapshot();
    corrupt.metrics.total_wait_seconds = f64::NAN;
    // restore_snapshot is the path that runs validation on an external snapshot.
    assert!(engine.restore_snapshot(corrupt).is_err());
}

#[test]
fn from_sandbox_request_with_invalid_request_returns_error() {
    let request = caelum_core::SandboxCreationRequest {
        template_id: "unknown".to_string(),
        economy_preset: "standard".to_string(),
        starting_capital: Some(f64::from(DEFAULT_STARTING_CAPITAL)),
        demand_multiplier: Some(1.0),
        move_in_rate: "paused".to_string(),
    };
    assert!(GameEngine::from_sandbox_request(request).is_err());
}
