use caelum_core::model::TripOutcome;
use caelum_core::{objectives, state::create_initial_snapshot, GameEngine, GameIntent};

#[test]
fn completed_trips_increment_metrics() {
    let state = create_initial_snapshot();

    let next = objectives::record_trip_outcome(&state, "arrived", 30.0, 100.0).unwrap();

    assert_eq!(next.metrics.completed_trips, 1);
    assert_eq!(next.metrics.late_trips, 0);
    assert_eq!(next.metrics.unserved_trips, 0);
    assert_eq!(next.metrics.total_wait_seconds, 30.0);
    assert_eq!(
        next.metrics.trip_outcomes,
        vec![TripOutcome {
            outcome: "arrived".to_string(),
            wait_seconds: 30.0,
            time: 100.0,
        }]
    );
}

#[test]
fn record_trip_outcome_clamps_negative_wait_seconds() {
    let state = create_initial_snapshot();

    let next = objectives::record_trip_outcome(&state, "late", -12.0, 100.0).unwrap();

    assert_eq!(next.metrics.completed_trips, 1);
    assert_eq!(next.metrics.late_trips, 1);
    assert_eq!(next.metrics.total_wait_seconds, 0.0);
    assert_eq!(next.metrics.trip_outcomes[0].wait_seconds, 0.0);
}

#[test]
fn invalid_record_trip_outcome_is_rejected_without_mutating_metrics() {
    let state = create_initial_snapshot();
    let before = state.metrics.clone();

    let result = objectives::record_trip_outcome(&state, "teleported", 30.0, 100.0);

    assert!(result.is_err());
    assert_eq!(result.unwrap_err(), "invalid trip outcome: teleported");
    assert_eq!(state.metrics, before);
}

#[test]
fn survival_requires_served_demand() {
    let mut engine = GameEngine::new();
    engine.dispatch(GameIntent::SetPaused { paused: false });

    let result = engine.tick(1_201.0);

    assert_eq!(result.snapshot.metrics.state, "running");
}

#[test]
fn survival_wins_after_served_demand() {
    let mut state = create_initial_snapshot();
    state.time = 1_201.0;
    state.metrics.completed_trips = 1;

    let evaluated = objectives::evaluate_objectives(&state);

    assert_eq!(evaluated.metrics.state, "won");
    assert_eq!(evaluated.metrics.loss_reason, None);
}

#[test]
fn loss_gates_use_trip_totals_and_minimum_sample_sizes() {
    let mut below_gate = create_initial_snapshot();
    below_gate.metrics.unserved_trips = 9;
    assert_eq!(
        objectives::evaluate_objectives(&below_gate).metrics.state,
        "running"
    );

    let mut unserved = create_initial_snapshot();
    unserved.metrics.completed_trips = 7;
    unserved.metrics.unserved_trips = 3;
    let evaluated_unserved = objectives::evaluate_objectives(&unserved);
    assert_eq!(evaluated_unserved.metrics.state, "lost");
    assert_eq!(
        evaluated_unserved.metrics.loss_reason.as_deref(),
        Some("Too many unserved citizens")
    );

    let mut late = create_initial_snapshot();
    late.metrics.completed_trips = 10;
    late.metrics.late_trips = 3;
    let evaluated_late = objectives::evaluate_objectives(&late);
    assert_eq!(evaluated_late.metrics.state, "lost");
    assert_eq!(
        evaluated_late.metrics.loss_reason.as_deref(),
        Some("Too many late arrivals")
    );
}

#[test]
fn average_wait_loss_requires_waiting_trips() {
    let mut no_waiters = create_initial_snapshot();
    no_waiters.metrics.average_wait_seconds = 181.0;
    assert_eq!(
        objectives::evaluate_objectives(&no_waiters).metrics.state,
        "running"
    );

    let mut waiting = no_waiters;
    waiting.metrics.waiting_trip_count = 1;
    let evaluated = objectives::evaluate_objectives(&waiting);

    assert_eq!(evaluated.metrics.state, "lost");
    assert_eq!(
        evaluated.metrics.loss_reason.as_deref(),
        Some("Average wait time is too high")
    );
}

#[test]
fn rolling_window_outcomes_override_aggregate_trip_ratios() {
    let mut state = create_initial_snapshot();
    state.time = 1_000.0;
    state.metrics.completed_trips = 20;
    state.metrics.late_trips = 8;
    state.metrics.trip_outcomes = (0..6)
        .map(|index| TripOutcome {
            outcome: "late".to_string(),
            wait_seconds: 0.0,
            time: 100.0 + f64::from(index),
        })
        .chain((0..2).map(|index| TripOutcome {
            outcome: "late".to_string(),
            wait_seconds: 0.0,
            time: 990.0 + f64::from(index),
        }))
        .chain((0..8).map(|index| TripOutcome {
            outcome: "arrived".to_string(),
            wait_seconds: 0.0,
            time: 980.0 + f64::from(index),
        }))
        .collect();

    let evaluated = objectives::evaluate_objectives(&state);

    assert_eq!(evaluated.metrics.state, "running");
}

#[test]
fn stale_rolling_window_unserved_failures_do_not_cause_loss() {
    let mut state = create_initial_snapshot();
    state.time = 1_000.0;
    state.metrics.unserved_trips = 10;
    state.metrics.trip_outcomes = (0..10)
        .map(|index| TripOutcome {
            outcome: "unserved".to_string(),
            wait_seconds: 0.0,
            time: 100.0 + f64::from(index),
        })
        .collect();

    let evaluated = objectives::evaluate_objectives(&state);

    assert_eq!(evaluated.metrics.state, "running");
}

#[test]
fn already_finished_objective_states_are_preserved() {
    let mut won = create_initial_snapshot();
    won.metrics.state = "won".to_string();
    won.metrics.completed_trips = 10;
    won.metrics.late_trips = 10;

    let mut lost = create_initial_snapshot();
    lost.metrics.state = "lost".to_string();
    lost.metrics.loss_reason = Some("Existing loss".to_string());
    lost.time = 1_201.0;
    lost.metrics.completed_trips = 1;

    assert_eq!(objectives::evaluate_objectives(&won), won);
    assert_eq!(objectives::evaluate_objectives(&lost), lost);
}
