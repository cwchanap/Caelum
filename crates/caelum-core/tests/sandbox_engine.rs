use caelum_core::model::{GameMode, Point};
use caelum_core::state::create_initial_snapshot;
use caelum_core::{
    canonical_default_request, create_sandbox_snapshot, GameEngine, GameIntent,
    SandboxCreationRequest, SandboxResetErrorCode,
};

fn request(
    template_id: &str,
    economy_preset: &str,
    starting_capital: f64,
    demand_multiplier: f64,
) -> SandboxCreationRequest {
    SandboxCreationRequest {
        template_id: template_id.to_string(),
        economy_preset: economy_preset.to_string(),
        starting_capital: Some(starting_capital),
        demand_multiplier: Some(demand_multiplier),
        move_in_rate: "paused".to_string(),
    }
}

#[test]
fn requested_engine_matches_public_factory() {
    let request = request("blankGrid", "creative", 42_000.0, 1.5);
    let expected = create_sandbox_snapshot(request.clone()).unwrap();

    let engine = GameEngine::from_sandbox_request(request).unwrap();

    assert_eq!(engine.snapshot(), expected);
}

#[test]
fn reset_replays_the_complete_original_blank_grid_request() {
    let request = request("blankGrid", "creative", 42_000.0, 1.5);
    let expected = create_sandbox_snapshot(request.clone()).unwrap();
    let mut engine = GameEngine::from_sandbox_request(request).unwrap();

    engine.set_budget_for_test(7);
    let _ = engine.dispatch(GameIntent::LayRoad {
        point: Point { x: 3, y: 3 },
    });

    let reset = engine.reset().unwrap();

    assert_eq!(reset, expected);
    assert_eq!(engine.snapshot(), expected);
}

#[test]
fn reset_replays_the_complete_original_crossroads_request() {
    let request = request("crossroads", "standard", 7_500.0, 2.25);
    let expected = create_sandbox_snapshot(request.clone()).unwrap();
    let mut engine = GameEngine::from_sandbox_request(request).unwrap();

    engine.set_budget_for_test(7);
    let _ = engine.dispatch(GameIntent::LayRoad {
        point: Point { x: 3, y: 3 },
    });

    let reset = engine.reset().unwrap();

    assert_eq!(reset, expected);
    assert_eq!(engine.snapshot(), expected);
}

#[test]
fn default_engine_construction_matches_the_canonical_factory() {
    let expected = create_sandbox_snapshot(canonical_default_request()).unwrap();

    assert_eq!(GameEngine::new().snapshot(), expected);
    assert_eq!(GameEngine::default().snapshot(), expected);
    assert_eq!(create_initial_snapshot(), expected);
}

#[test]
fn campaign_reset_is_rejected_without_mutating_snapshot_or_topology() {
    let mut campaign = create_initial_snapshot();
    campaign.rules.game_mode = GameMode::Campaign;
    let mut engine = GameEngine::from_snapshot(campaign).unwrap();
    let before_snapshot = engine.snapshot();
    let before_topology = engine.road_topology_for_test().clone();

    let error = engine.reset().unwrap_err();

    assert_eq!(error.code, SandboxResetErrorCode::UnsupportedGameMode);
    assert_eq!(error.context.game_mode, Some(GameMode::Campaign));
    assert_eq!(engine.snapshot(), before_snapshot);
    assert_eq!(engine.road_topology_for_test(), &before_topology);
}
