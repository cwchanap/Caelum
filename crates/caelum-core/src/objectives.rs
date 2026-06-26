use std::cmp::Ordering;

use crate::model::{GameSnapshot, MetricsState, TripOutcome, TripOutcomeKind};

pub const MAX_LATE_RATIO: f64 = 0.25;
pub const MAX_UNSERVED_RATIO: f64 = 0.20;
pub const MAX_AVERAGE_WAIT_SECONDS: f64 = 180.0;
pub const ROLLING_WINDOW_SECONDS: f64 = 300.0;
pub const SURVIVAL_TIME_SECONDS: f64 = 1_200.0;

/// Drop trip outcomes older than the rolling evaluation window, keeping at least the
/// most recent outcome so objective gates never see an empty sample.
///
/// Intentional divergence from the TS oracle: TS keeps the full outcome history, while
/// the Rust core trims to a [`ROLLING_WINDOW_SECONDS`] window each evaluation. This makes
/// late/unserved ratios responsive to recent demand rather than lifetime totals, and is a
/// deliberate "more correct" choice. A WASM/Tauri consumer expecting the TS snapshot shape
/// must account for the trimmed `trip_outcomes` vector.
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
    if state.metrics.state != MetricsState::Running {
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
        next.metrics.state = MetricsState::Won;
        next.metrics.loss_reason = None;
        return next;
    }

    state.clone()
}

fn lose(state: &GameSnapshot, reason: &str) -> GameSnapshot {
    let mut next = state.clone();
    next.metrics.state = MetricsState::Lost;
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
        match outcome.outcome {
            TripOutcomeKind::Arrived => completed_trips += 1,
            TripOutcomeKind::Late => {
                completed_trips += 1;
                late_trips += 1;
            }
            TripOutcomeKind::Unserved => unserved_trips += 1,
        }
    }

    ObjectiveCounts {
        completed_trips,
        late_trips,
        unserved_trips,
    }
}
