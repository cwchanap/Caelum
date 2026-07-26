use caelum_core::model::{MetricsState, TripOutcome, TripOutcomeKind};
use caelum_core::{
    objectives,
    scenario::{growing_suburb_campaign, growing_suburb_objectives},
    state::create_initial_snapshot,
    GameEngine, GameIntent, GameSnapshot,
};

fn campaign_state() -> GameSnapshot {
    let mut state = create_initial_snapshot();
    let (rules, scenario) = growing_suburb_campaign(growing_suburb_objectives(), Vec::new());
    state.rules = rules;
    state.scenario = scenario;
    state
}

#[test]
fn survival_requires_served_demand() {
    let mut engine = GameEngine::new();
    engine.dispatch(GameIntent::SetPaused { paused: false });

    let result = engine.tick(1_201.0);

    assert_eq!(result.snapshot.metrics.state, MetricsState::Running);
}

#[test]
fn survival_wins_after_served_demand() {
    let mut state = campaign_state();
    state.time = 1_201.0;
    state.metrics.completed_trips = 1;

    let evaluated = objectives::evaluate_objectives(&state);

    assert_eq!(evaluated.metrics.state, MetricsState::Won);
    assert_eq!(evaluated.metrics.loss_reason, None);
}

#[test]
fn loss_gates_use_trip_totals_and_minimum_sample_sizes() {
    let mut below_gate = campaign_state();
    below_gate.metrics.unserved_trips = 9;
    assert_eq!(
        objectives::evaluate_objectives(&below_gate).metrics.state,
        MetricsState::Running
    );

    let mut unserved = campaign_state();
    unserved.metrics.completed_trips = 7;
    unserved.metrics.unserved_trips = 3;
    let evaluated_unserved = objectives::evaluate_objectives(&unserved);
    assert_eq!(evaluated_unserved.metrics.state, MetricsState::Lost);
    assert_eq!(
        evaluated_unserved.metrics.loss_reason.as_deref(),
        Some("Too many unserved citizens")
    );

    let mut late = campaign_state();
    late.metrics.completed_trips = 10;
    late.metrics.late_trips = 3;
    let evaluated_late = objectives::evaluate_objectives(&late);
    assert_eq!(evaluated_late.metrics.state, MetricsState::Lost);
    assert_eq!(
        evaluated_late.metrics.loss_reason.as_deref(),
        Some("Too many late arrivals")
    );
}

#[test]
fn average_wait_loss_requires_waiting_trips() {
    let mut no_waiters = campaign_state();
    no_waiters.metrics.average_wait_seconds = 181.0;
    assert_eq!(
        objectives::evaluate_objectives(&no_waiters).metrics.state,
        MetricsState::Running
    );

    let mut waiting = no_waiters;
    waiting.metrics.waiting_trip_count = 1;
    let evaluated = objectives::evaluate_objectives(&waiting);

    assert_eq!(evaluated.metrics.state, MetricsState::Lost);
    assert_eq!(
        evaluated.metrics.loss_reason.as_deref(),
        Some("Average wait time is too high")
    );
}

#[test]
fn rolling_window_outcomes_override_aggregate_trip_ratios() {
    let mut state = campaign_state();
    state.time = 1_000.0;
    state.metrics.completed_trips = 20;
    state.metrics.late_trips = 8;
    state.metrics.trip_outcomes = (0..6)
        .map(|index| TripOutcome {
            outcome: TripOutcomeKind::Late,
            wait_seconds: 0.0,
            time: 100.0 + f64::from(index),
        })
        .chain((0..2).map(|index| TripOutcome {
            outcome: TripOutcomeKind::Late,
            wait_seconds: 0.0,
            time: 990.0 + f64::from(index),
        }))
        .chain((0..8).map(|index| TripOutcome {
            outcome: TripOutcomeKind::Arrived,
            wait_seconds: 0.0,
            time: 980.0 + f64::from(index),
        }))
        .collect();

    let evaluated = objectives::evaluate_objectives(&state);

    assert_eq!(evaluated.metrics.state, MetricsState::Running);
}

#[test]
fn stale_rolling_window_unserved_failures_do_not_cause_loss() {
    let mut state = campaign_state();
    state.time = 1_000.0;
    state.metrics.unserved_trips = 10;
    state.metrics.trip_outcomes = (0..10)
        .map(|index| TripOutcome {
            outcome: TripOutcomeKind::Unserved,
            wait_seconds: 0.0,
            time: 100.0 + f64::from(index),
        })
        .collect();

    let evaluated = objectives::evaluate_objectives(&state);

    assert_eq!(evaluated.metrics.state, MetricsState::Running);
}

#[test]
fn already_finished_objective_states_are_preserved() {
    let mut won = campaign_state();
    won.metrics.state = MetricsState::Won;
    won.metrics.completed_trips = 10;
    won.metrics.late_trips = 10;

    let mut lost = campaign_state();
    lost.metrics.state = MetricsState::Lost;
    lost.metrics.loss_reason = Some("Existing loss".to_string());
    lost.time = 1_201.0;
    lost.metrics.completed_trips = 1;

    assert_eq!(objectives::evaluate_objectives(&won), won);
    assert_eq!(objectives::evaluate_objectives(&lost), lost);
}

#[test]
fn sandbox_with_served_demand_runs_past_campaign_survival_time() {
    let mut snapshot = create_initial_snapshot();
    snapshot.paused = false;
    snapshot.metrics.completed_trips = 1;
    let mut engine = GameEngine::from_snapshot(snapshot).unwrap();

    let result = engine.tick(1_201.0);

    assert_eq!(result.snapshot.time, 1_201.0);
    assert_eq!(result.snapshot.metrics.state, MetricsState::Running);
}

#[test]
fn sandbox_ignores_loss_producing_metrics() {
    let mut state = create_initial_snapshot();
    state.scenario.objectives = Some(growing_suburb_objectives());
    state.metrics.completed_trips = 7;
    state.metrics.unserved_trips = 3;

    assert_eq!(
        objectives::evaluate_objectives(&state).metrics.state,
        MetricsState::Running
    );
}

#[test]
fn campaign_uses_thresholds_from_its_snapshot() {
    let mut state = campaign_state();
    state.metrics.completed_trips = 10;
    state.metrics.late_trips = 3;
    state.scenario.objectives.as_mut().unwrap().max_late_ratio = 0.5;

    assert_eq!(
        objectives::evaluate_objectives(&state).metrics.state,
        MetricsState::Running
    );
}

#[test]
fn valid_custom_campaign_window_drives_pruning_and_scoring() {
    let mut state = campaign_state();
    state.time = 1_000.0;
    state
        .scenario
        .objectives
        .as_mut()
        .unwrap()
        .rolling_window_seconds = 600.0;
    state.metrics.completed_trips = 100;
    state.metrics.unserved_trips = 10;
    state.metrics.trip_outcomes = (0..100)
        .map(|_| TripOutcome {
            outcome: TripOutcomeKind::Arrived,
            wait_seconds: 0.0,
            time: 100.0,
        })
        .chain((0..10).map(|_| TripOutcome {
            outcome: TripOutcomeKind::Unserved,
            wait_seconds: 0.0,
            time: 500.0,
        }))
        .collect();

    let window = objectives::effective_rolling_window_seconds(&state);
    assert_eq!(window, 600.0);

    let mut retained = state.metrics.trip_outcomes.clone();
    objectives::prune_trip_outcomes(&mut retained, state.time, window);
    assert_eq!(retained.len(), 10);
    assert_eq!(
        objectives::evaluate_objectives(&state).metrics.state,
        MetricsState::Lost
    );
}

#[test]
fn invalid_campaign_windows_use_the_same_300_second_fallback() {
    for invalid in [0.0, -1.0, f64::NAN, f64::INFINITY] {
        let mut state = campaign_state();
        state.time = 1_000.0;
        state
            .scenario
            .objectives
            .as_mut()
            .unwrap()
            .rolling_window_seconds = invalid;
        state.metrics.completed_trips = 100;
        state.metrics.unserved_trips = 10;
        state.metrics.trip_outcomes = (0..100)
            .map(|_| TripOutcome {
                outcome: TripOutcomeKind::Arrived,
                wait_seconds: 0.0,
                time: 100.0,
            })
            .chain((0..10).map(|_| TripOutcome {
                outcome: TripOutcomeKind::Unserved,
                wait_seconds: 0.0,
                time: 750.0,
            }))
            .collect();

        let window = objectives::effective_rolling_window_seconds(&state);
        assert_eq!(window, objectives::ROLLING_WINDOW_SECONDS);

        let mut retained = state.metrics.trip_outcomes.clone();
        objectives::prune_trip_outcomes(&mut retained, state.time, window);
        assert_eq!(retained.len(), 10);
        assert!(retained
            .iter()
            .all(|outcome| outcome.outcome == TripOutcomeKind::Unserved));

        assert_eq!(
            objectives::evaluate_objectives(&state).metrics.state,
            MetricsState::Lost
        );
    }
}

#[test]
fn sandbox_and_objective_less_campaign_use_default_retention() {
    let mut sandbox = create_initial_snapshot();
    let mut attached = growing_suburb_objectives();
    attached.rolling_window_seconds = 600.0;
    sandbox.scenario.objectives = Some(attached);
    assert_eq!(
        objectives::effective_rolling_window_seconds(&sandbox),
        objectives::ROLLING_WINDOW_SECONDS
    );

    let (rules, mut scenario) = growing_suburb_campaign(growing_suburb_objectives(), Vec::new());
    scenario.objectives = None;
    sandbox.rules = rules;
    sandbox.scenario = scenario;
    assert_eq!(
        objectives::effective_rolling_window_seconds(&sandbox),
        objectives::ROLLING_WINDOW_SECONDS
    );
}

#[test]
fn loaded_terminal_sandbox_remains_frozen() {
    let mut snapshot = create_initial_snapshot();
    snapshot.paused = false;
    snapshot.metrics.state = MetricsState::Won;
    let mut engine = GameEngine::from_snapshot(snapshot).unwrap();

    let result = engine.tick(60.0);

    assert!(!result.applied);
    assert_eq!(result.snapshot.time, 0.0);
    assert_eq!(result.snapshot.metrics.state, MetricsState::Won);
}
