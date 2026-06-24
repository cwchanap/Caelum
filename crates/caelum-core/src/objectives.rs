use std::cmp::Ordering;

use crate::model::{GameSnapshot, TripOutcome};

pub const MAX_LATE_RATIO: f64 = 0.25;
pub const MAX_UNSERVED_RATIO: f64 = 0.20;
pub const MAX_AVERAGE_WAIT_SECONDS: f64 = 180.0;
pub const ROLLING_WINDOW_SECONDS: f64 = 300.0;
pub const SURVIVAL_TIME_SECONDS: f64 = 1_200.0;

pub fn record_trip_outcome(
    state: &GameSnapshot,
    outcome: &str,
    wait_seconds: f64,
    time: f64,
) -> Result<GameSnapshot, String> {
    if !is_valid_trip_outcome(outcome) {
        return Err(format!("invalid trip outcome: {outcome}"));
    }

    let mut next = state.clone();
    record_trip_outcome_on_metrics(&mut next, outcome, wait_seconds, time);
    Ok(evaluate_objectives(&next))
}

fn is_valid_trip_outcome(outcome: &str) -> bool {
    matches!(outcome, "arrived" | "late" | "unserved")
}

fn record_trip_outcome_on_metrics(
    state: &mut GameSnapshot,
    outcome: &str,
    wait_seconds: f64,
    time: f64,
) {
    match outcome {
        "arrived" => {
            state.metrics.completed_trips += 1;
        }
        "late" => {
            state.metrics.completed_trips += 1;
            state.metrics.late_trips += 1;
        }
        "unserved" => {
            state.metrics.unserved_trips += 1;
        }
        _ => {}
    }

    let clamped_wait = wait_seconds.max(0.0);
    state.metrics.total_wait_seconds += clamped_wait;
    state.metrics.trip_outcomes.push(TripOutcome {
        outcome: outcome.to_string(),
        wait_seconds: clamped_wait,
        time,
    });
    prune_trip_outcomes(&mut state.metrics.trip_outcomes, time);
}

pub fn prune_trip_outcomes(outcomes: &mut Vec<TripOutcome>, current_time: f64) {
    if outcomes.is_empty() {
        return;
    }

    let latest_outcome = outcomes.iter().cloned().max_by(|left, right| {
        left.time
            .partial_cmp(&right.time)
            .unwrap_or(Ordering::Equal)
    });
    let window_start = current_time - ROLLING_WINDOW_SECONDS;
    outcomes.retain(|outcome| outcome.time >= window_start);

    if outcomes.is_empty() {
        if let Some(outcome) = latest_outcome {
            outcomes.push(outcome);
        }
    }
}

pub fn evaluate_objectives(state: &GameSnapshot) -> GameSnapshot {
    if state.metrics.state != "running" {
        return state.clone();
    }

    let counts = objective_counts(state);
    let total_trips = counts.completed_trips + counts.unserved_trips;

    if total_trips >= 10
        && f64::from(counts.unserved_trips) / f64::from(total_trips) > MAX_UNSERVED_RATIO
    {
        return lose(state, "Too many unserved citizens");
    }

    if counts.completed_trips >= 10
        && f64::from(counts.late_trips) / f64::from(counts.completed_trips) > MAX_LATE_RATIO
    {
        return lose(state, "Too many late arrivals");
    }

    if state.metrics.waiting_trip_count > 0
        && state.metrics.average_wait_seconds > MAX_AVERAGE_WAIT_SECONDS
    {
        return lose(state, "Average wait time is too high");
    }

    if state.time >= SURVIVAL_TIME_SECONDS && state.metrics.completed_trips > 0 {
        let mut next = state.clone();
        next.metrics.state = "won".to_string();
        next.metrics.loss_reason = None;
        return next;
    }

    state.clone()
}

fn lose(state: &GameSnapshot, reason: &str) -> GameSnapshot {
    let mut next = state.clone();
    next.metrics.state = "lost".to_string();
    next.metrics.loss_reason = Some(reason.to_string());
    next
}

struct ObjectiveCounts {
    completed_trips: u32,
    late_trips: u32,
    unserved_trips: u32,
}

fn objective_counts(state: &GameSnapshot) -> ObjectiveCounts {
    if state.metrics.trip_outcomes.is_empty() {
        return ObjectiveCounts {
            completed_trips: state.metrics.completed_trips,
            late_trips: state.metrics.late_trips,
            unserved_trips: state.metrics.unserved_trips,
        };
    }

    let window_start = state.time - ROLLING_WINDOW_SECONDS;
    let mut completed_trips = 0;
    let mut late_trips = 0;
    let mut unserved_trips = 0;

    for outcome in state
        .metrics
        .trip_outcomes
        .iter()
        .filter(|outcome| outcome.time >= window_start)
    {
        match outcome.outcome.as_str() {
            "arrived" => completed_trips += 1,
            "late" => {
                completed_trips += 1;
                late_trips += 1;
            }
            "unserved" => unserved_trips += 1,
            _ => {}
        }
    }

    ObjectiveCounts {
        completed_trips,
        late_trips,
        unserved_trips,
    }
}
