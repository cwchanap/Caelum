use caelum_core::clock::{GAME_DAY_SECONDS, MINUTES_PER_DAY};
use caelum_core::model::{GameMode, Point, TripPurpose, WorkerProfile};
use caelum_core::presentation::project_update;
use caelum_core::state::create_initial_snapshot;
use caelum_core::{
    canonical_default_request, create_sandbox_snapshot, GameEngine, GameIntent,
    SandboxCreationRequest, SandboxResetErrorCode,
};

const MORNING_CLOCK_MINUTE: u16 = 480; // 08:00

fn seconds_at_clock_minute(minute: u16) -> f64 {
    GAME_DAY_SECONDS * f64::from(minute) / f64::from(MINUTES_PER_DAY)
}

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

    let reset_update = engine.reset().unwrap();

    assert_eq!(reset_update, project_update(&expected, true));
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

    let reset_update = engine.reset().unwrap();

    assert_eq!(reset_update, project_update(&expected, true));
    assert_eq!(engine.snapshot(), expected);
}

#[test]
fn reset_replays_the_complete_original_small_town_request() {
    let request = request("smallTown", "creative", 42_000.0, 1.5);
    let expected = create_sandbox_snapshot(request.clone()).unwrap();
    let mut engine = GameEngine::from_sandbox_request(request).unwrap();

    let _ = engine.dispatch(GameIntent::SetPaused { paused: false });
    let _ = engine.tick(seconds_at_clock_minute(MORNING_CLOCK_MINUTE));
    engine.set_budget_for_test(7);

    let reset_update = engine.reset().unwrap();

    assert_eq!(reset_update, project_update(&expected, true));
    assert_eq!(engine.snapshot(), expected);
}

fn run_small_town_morning() -> caelum_core::model::GameSnapshot {
    let mut engine =
        GameEngine::from_sandbox_request(request("smallTown", "standard", 120_000.0, 1.0)).unwrap();
    assert!(
        engine
            .dispatch(GameIntent::SetPaused { paused: false })
            .applied
    );
    assert!(
        engine
            .tick(seconds_at_clock_minute(MORNING_CLOCK_MINUTE))
            .applied
    );
    engine.snapshot()
}

#[test]
fn small_town_resume_uses_existing_move_in_workplace_and_commute_rules_deterministically() {
    let first = run_small_town_morning();
    let second = run_small_town_morning();

    assert_eq!(first, second);
    assert_eq!(first.clock_minutes, MORNING_CLOCK_MINUTE);
    assert_eq!(first.sims.len(), 8);

    let workers = first
        .sims
        .iter()
        .filter(|sim| sim.worker_profile == WorkerProfile::Worker)
        .collect::<Vec<_>>();
    assert_eq!(workers.len(), 8);
    assert!(workers.iter().all(|sim| sim.workplace.is_some()));

    assert!(first
        .active_trips
        .iter()
        .any(|trip| trip.purpose == TripPurpose::CommuteOutbound));
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
