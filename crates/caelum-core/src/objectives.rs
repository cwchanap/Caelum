use std::cmp::Ordering;

use crate::model::{GameMode, GameSnapshot, MetricsState, TripOutcome, TripOutcomeKind};

pub const MAX_LATE_RATIO: f64 = 0.25;
pub const MAX_UNSERVED_RATIO: f64 = 0.20;
pub const MAX_AVERAGE_WAIT_SECONDS: f64 = 180.0;
pub const ROLLING_WINDOW_SECONDS: f64 = 300.0;
pub const SURVIVAL_TIME_SECONDS: f64 = 1_200.0;

/// Drop trip outcomes older than the rolling evaluation window, keeping at least the
/// most recent outcome so the `trip_outcomes` vector is never empty (e.g. for
/// serialization/inspection of a non-empty sample).
///
/// Note: the retained fallback does **not** influence scoring. `objective_counts`
/// re-filters `trip_outcomes` by the same effective rolling window before
/// counting, and the fallback is, by construction, older than the window — it was pruned
/// precisely because it fell outside it, and `state.time` only advances, so the window
/// start only moves forward. The scoring filter can therefore still yield zero in-range
/// outcomes; in that case the loss gates see all-zero rolling counts and (requiring at
/// least 10 trips) do not fire from the window, while the win gate consults the lifetime
/// `completed_trips` counter rather than the rolling window.
///
/// Intentional divergence from the TS oracle: TS keeps the full outcome history, while
/// the Rust core trims to the effective rolling window each evaluation. This makes
/// late/unserved ratios responsive to recent demand rather than lifetime totals, and is a
/// deliberate "more correct" choice. The in-range counts still match TS, which filters
/// its full history by the same window; only the pruned fallback is Rust-specific and is
/// not scored. A WASM/Tauri consumer expecting the TS snapshot shape must account for the
/// trimmed `trip_outcomes` vector.
///
/// Campaign snapshots may configure a rolling window. All other snapshots use
/// the stable default so retention remains bounded even when no objectives are
/// active. The configured value is a validated [`RollingWindowSeconds`](crate::model::RollingWindowSeconds)
/// newtype, so it is guaranteed finite and positive; no runtime coercion is needed.
pub fn effective_rolling_window_seconds(state: &GameSnapshot) -> f64 {
    if state.rules.game_mode != GameMode::Campaign {
        return ROLLING_WINDOW_SECONDS;
    }

    let Some(objectives) = state.scenario.objectives.as_ref() else {
        return ROLLING_WINDOW_SECONDS;
    };
    objectives.rolling_window_seconds.value()
}

pub fn prune_trip_outcomes(
    outcomes: &mut Vec<TripOutcome>,
    current_time: f64,
    retention_window_seconds: f64,
) {
    if outcomes.is_empty() {
        return;
    }

    let latest_outcome = outcomes.iter().cloned().max_by(|left, right| {
        left.time
            .partial_cmp(&right.time)
            .unwrap_or(Ordering::Equal)
    });
    let window_start = current_time - retention_window_seconds;
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
    if state.rules.game_mode != GameMode::Campaign {
        return state.clone();
    }
    let Some(thresholds) = state.scenario.objectives.as_ref() else {
        return state.clone();
    };

    let rolling_window_seconds = effective_rolling_window_seconds(state);
    let counts = objective_counts(state, rolling_window_seconds);
    let total_trips = counts.completed_trips + counts.unserved_trips;

    if total_trips >= 10
        && f64::from(counts.unserved_trips) / f64::from(total_trips)
            > thresholds.max_unserved_ratio.value()
    {
        return lose(state, "Too many unserved citizens");
    }

    if counts.completed_trips >= 10
        && f64::from(counts.late_trips) / f64::from(counts.completed_trips)
            > thresholds.max_late_ratio.value()
    {
        return lose(state, "Too many late arrivals");
    }

    if state.metrics.waiting_trip_count > 0
        && state.metrics.average_wait_seconds > thresholds.max_average_wait.value()
    {
        return lose(state, "Average wait time is too high");
    }

    // Win gate: intentionally reads the LIFETIME `state.metrics.completed_trips`
    // counter, not the rolling-window `counts.completed_trips` in scope above.
    // A campaign must not lose its survival win just because demand went quiet
    // in the last rolling window (the window can legitimately contain zero
    // in-range outcomes — see `prune_trip_outcomes`). The loss gates above
    // correctly use rolling-window counts so a burst of late/unserved trips
    // fails the campaign even when lifetime totals look healthy; this
    // lifetime-vs-window asymmetry is deliberate.
    if state.time >= thresholds.survival_time.value() && state.metrics.completed_trips > 0 {
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

fn objective_counts(state: &GameSnapshot, rolling_window_seconds: f64) -> ObjectiveCounts {
    if state.metrics.trip_outcomes.is_empty() {
        return ObjectiveCounts {
            completed_trips: state.metrics.completed_trips,
            late_trips: state.metrics.late_trips,
            unserved_trips: state.metrics.unserved_trips,
        };
    }

    let window_start = state.time - rolling_window_seconds;
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
