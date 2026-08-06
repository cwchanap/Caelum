use caelum_core::model::{
    MaxLateRatio, MetricsState, ObjectiveThresholds, RollingWindowSeconds, TripOutcome,
    TripOutcomeKind,
};
use caelum_core::{
    objectives,
    scenario::{growing_suburb_campaign, growing_suburb_objectives},
    state::create_initial_snapshot,
    GameEngine, GameIntent,
};

mod common;

#[test]
fn survival_requires_served_demand() {
    let mut engine = GameEngine::new();
    engine.dispatch(GameIntent::SetPaused { paused: false });

    let result = engine.tick(1_201.0);

    assert_eq!(result.snapshot.metrics.state, MetricsState::Running);
}

#[test]
fn survival_wins_after_served_demand() {
    let mut state = common::campaign_state();
    state.time = 1_201.0;
    state.metrics.completed_trips = 1;

    let evaluated = objectives::evaluate_objectives(&state);

    assert_eq!(evaluated.metrics.state, MetricsState::Won);
    assert_eq!(evaluated.metrics.loss_reason, None);
}

#[test]
fn loss_gates_use_trip_totals_and_minimum_sample_sizes() {
    let mut below_gate = common::campaign_state();
    below_gate.metrics.unserved_trips = 9;
    assert_eq!(
        objectives::evaluate_objectives(&below_gate).metrics.state,
        MetricsState::Running
    );

    let mut unserved = common::campaign_state();
    unserved.metrics.completed_trips = 7;
    unserved.metrics.unserved_trips = 3;
    let evaluated_unserved = objectives::evaluate_objectives(&unserved);
    assert_eq!(evaluated_unserved.metrics.state, MetricsState::Lost);
    assert_eq!(
        evaluated_unserved.metrics.loss_reason.as_deref(),
        Some("Too many unserved citizens")
    );

    let mut late = common::campaign_state();
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
    let mut no_waiters = common::campaign_state();
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
    let mut state = common::campaign_state();
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
    let mut state = common::campaign_state();
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
    let mut won = common::campaign_state();
    won.metrics.state = MetricsState::Won;
    won.metrics.completed_trips = 10;
    won.metrics.late_trips = 10;

    let mut lost = common::campaign_state();
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
    snapshot.metrics.completed_trips = 1;
    let mut engine = common::running_engine_from_fixture(snapshot);

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
    let mut state = common::campaign_state();
    state.metrics.completed_trips = 10;
    state.metrics.late_trips = 3;
    state.scenario.objectives.as_mut().unwrap().max_late_ratio = MaxLateRatio::new(0.5).unwrap();

    assert_eq!(
        objectives::evaluate_objectives(&state).metrics.state,
        MetricsState::Running
    );
}

#[test]
fn valid_custom_campaign_window_drives_pruning_and_scoring() {
    let mut state = common::campaign_state();
    state.time = 1_000.0;
    state
        .scenario
        .objectives
        .as_mut()
        .unwrap()
        .rolling_window_seconds = RollingWindowSeconds::new(600.0).unwrap();
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
fn invalid_objective_thresholds_are_rejected_at_construction() {
    // The threshold fields are validated newtypes (see `model::ObjectiveThresholds`).
    // Bad campaign authoring must fail loudly rather than be silently coerced to
    // the default at evaluation time. This replaces the previous runtime-fallback
    // behavior, which is now unreachable because the newtypes cannot represent
    // invalid values. NaN/Infinity are reachable here and via the WASM JsValue
    // path (JS numbers can carry them); JSON cannot carry them as numbers, so the
    // JSON deserialization case is covered separately below for finite invalids.
    for invalid in [0.0, -1.0, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        assert!(
            RollingWindowSeconds::new(invalid).is_err(),
            "RollingWindowSeconds must reject {invalid:?}"
        );
    }
    for invalid in [0.0, -1.0, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        assert!(
            caelum_core::model::SurvivalTimeSeconds::new(invalid).is_err(),
            "SurvivalTimeSeconds must reject {invalid:?}"
        );
    }
    for invalid in [-0.1, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        assert!(
            MaxLateRatio::new(invalid).is_err(),
            "MaxLateRatio must reject {invalid:?}"
        );
        assert!(
            caelum_core::model::MaxUnservedRatio::new(invalid).is_err(),
            "MaxUnservedRatio must reject {invalid:?}"
        );
        assert!(
            caelum_core::model::MaxAverageWaitSeconds::new(invalid).is_err(),
            "MaxAverageWaitSeconds must reject {invalid:?}"
        );
    }
}

#[test]
fn invalid_objective_thresholds_are_rejected_at_json_deserialization() {
    // JSON cannot carry NaN/Infinity as numbers (serde_json maps them to null,
    // which fails as a wrong-type error before the newtype runs). The finite
    // invalid values here exercise the newtype's predicate rejection through the
    // serde `try_from = "f64"` path.
    let base = growing_suburb_objectives();
    let base_value = serde_json::to_value(&base).expect("objectives serialize");

    for (field, invalid) in [
        ("rollingWindowSeconds", 0.0),
        ("rollingWindowSeconds", -1.0),
        ("survivalTime", 0.0),
        ("survivalTime", -1.0),
        ("maxLateRatio", -0.1),
        ("maxUnservedRatio", -0.1),
        ("maxAverageWait", -1.0),
    ] {
        let mut value = base_value.clone();
        value[field] = serde_json::json!(invalid);
        let result: Result<ObjectiveThresholds, _> = serde_json::from_value(value);
        assert!(
            result.is_err(),
            "field {field} = {invalid:?} must be rejected at deserialization"
        );
    }
}

#[test]
fn sandbox_and_objective_less_campaign_use_default_retention() {
    let mut sandbox = create_initial_snapshot();
    let mut attached = growing_suburb_objectives();
    attached.rolling_window_seconds = RollingWindowSeconds::new(600.0).unwrap();
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
