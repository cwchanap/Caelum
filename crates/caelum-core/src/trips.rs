use std::collections::{HashMap, HashSet};

use crate::clock::{self, GAME_DAY_SECONDS, MINUTES_PER_DAY};
use crate::commute::{departure_minute_for_sim, trip_deadline_seconds};
use crate::model::{
    ActiveTrip, GameMode, GameSnapshot, Metrics, MetricsState, ObjectiveThresholds, Point,
    RoutePlan, Sim, TransitMode, TripOutcome, TripOutcomeKind, TripPosition, TripPurpose,
    TripStatus, WorkerProfile,
};
use crate::objectives;
use crate::router;
use crate::transit;

const WALK_SECONDS_PER_TILE: f64 = 20.0;
pub const WAIT_PATIENCE_SECONDS: f64 = 240.0;
const DEADLINE_GRACE_SECONDS: f64 = 300.0;
const EPSILON: f64 = 0.000_001;

fn plan_route(state: &GameSnapshot, origin: &Point, destination: &Point) -> Option<RoutePlan> {
    router::find_route_plan(state, origin, destination)
}

/// Boundaries per sim per day: outbound spawn + outbound resolution + return
/// spawn + return resolution, plus headroom for the walk-leg / patience /
/// deadline boundaries a single commute can generate. Used both in
/// `max_tick_substeps` (initial cap) and in the post-growth cap widening
/// inside `tick_trips_substepped`.
const SIM_SHIFT_BOUNDARIES_PER_DAY: usize = 6;

struct TripTickResult {
    trip: ActiveTrip,
    completed_trips: u32,
    late_trips: u32,
    unserved_trips: u32,
    wait_seconds: f64,
    outcome: Option<TripOutcome>,
}

struct TripMetricDelta {
    completed_trips: u32,
    late_trips: u32,
    unserved_trips: u32,
    wait_seconds: f64,
    outcomes: Vec<TripOutcome>,
}

pub fn tick_trips(state: &GameSnapshot, delta_seconds: f64) -> GameSnapshot {
    tick_trips_substepped(state, delta_seconds, |_| false)
}

/// Like [`tick_trips`] but evaluates objectives after every substep and stops the
/// tick as soon as a loss or win condition is reached.
///
/// A coarse tick (e.g. resuming from a suspended browser tab) can span a waiting
/// trip past a campaign average-wait loss threshold and then to its 240s patience
/// expiry, or generate bad outcomes that fall outside the active rolling window by
/// the time the final substep completes. Evaluating objectives only once on the
/// final snapshot misses those loss conditions — the expired trip is gone from
/// `waiting_trip_count`, and the stale outcomes are pruned. Per-substep
/// evaluation makes a coarse tick equivalent to a sequence of stepped ticks for
/// objective detection, preserving the determinism/granularity-independence
/// invariant.
pub fn tick_trips_with_objectives(state: &GameSnapshot, delta_seconds: f64) -> GameSnapshot {
    tick_trips_substepped(state, delta_seconds, |next| {
        let evaluated = objectives::evaluate_objectives(next);
        *next = evaluated;
        next.metrics.state != MetricsState::Running
    })
}

fn tick_trips_substepped(
    state: &GameSnapshot,
    delta_seconds: f64,
    mut on_substep: impl FnMut(&mut GameSnapshot) -> bool,
) -> GameSnapshot {
    if state.paused || state.metrics.state != MetricsState::Running || state.speed == 0 {
        return state.clone();
    }

    let scaled_delta = clock::scaled_delta(delta_seconds, state.speed);
    let mut next = state.clone();
    let final_time = next.time + scaled_delta;
    sync_clock(&mut next);

    let mut early_termination = false;
    let mut steps = 0;
    // The substep budget is computed from the current snapshot, but growth
    // waves applied inside the loop can spawn new sims whose departure
    // boundaries weren't counted in `events_per_day`. Widen the cap when the
    // sim count grows so the post-growth event budget is always accounted for
    // and the tick cannot be truncated in release builds.
    let mut cap = max_tick_substeps(&next, final_time);
    let mut last_sim_count = next.sims.len();
    loop {
        if steps >= cap || final_time - next.time <= EPSILON {
            break;
        }

        crate::growth::apply_due_growth_waves(&mut next);
        let sim_count = next.sims.len();
        if sim_count > last_sim_count {
            let start_day = clock::day_index(next.time);
            let end_day = clock::day_index(final_time);
            let day_count = end_day.saturating_sub(start_day) as usize + 1;
            let additional = sim_count
                .saturating_sub(last_sim_count)
                .saturating_mul(SIM_SHIFT_BOUNDARIES_PER_DAY)
                .saturating_mul(day_count);
            cap = cap.saturating_add(additional);
            last_sim_count = sim_count;
        }

        reset_daily_commute_flags(&mut next);
        spawn_due_commute_trips(&mut next);

        let substep_end = next_boundary_after(&next)
            .map(|boundary| boundary.min(final_time))
            .unwrap_or(final_time);
        let substep_delta = (substep_end - next.time).max(0.0);
        if substep_delta <= EPSILON {
            break;
        }

        next = advance_tick_substep(&next, substep_delta);
        steps += 1;
        if on_substep(&mut next) {
            early_termination = true;
            break;
        }
    }

    if !early_termination {
        // The substep cap is an upper bound on legitimate boundary events (see
        // `max_tick_substeps`). Reaching here with unprocessed time means a boundary
        // source is denser than the budget — a correctness regression. Surface it
        // in debug/test builds via debug_assert, but still process the remaining
        // time through normal boundary progression so release builds never return
        // a partially advanced tick.
        let dropped = final_time - next.time;
        debug_assert!(
            dropped <= EPSILON,
            "tick substep cap exhausted at time {} before final_time {} (dropped {}s)",
            next.time,
            final_time,
            dropped
        );

        while final_time - next.time > EPSILON {
            crate::growth::apply_due_growth_waves(&mut next);
            reset_daily_commute_flags(&mut next);
            spawn_due_commute_trips(&mut next);

            let substep_end = next_boundary_after(&next)
                .map(|boundary| boundary.min(final_time))
                .unwrap_or(final_time);
            let mut substep_delta = (substep_end - next.time).max(0.0);
            if substep_delta <= EPSILON {
                // No forward boundary: still consume residual time so the tick
                // contract (advance by delta) holds in release builds.
                substep_delta = final_time - next.time;
                if substep_delta <= EPSILON {
                    break;
                }
            }

            next = advance_tick_substep(&next, substep_delta);
            if on_substep(&mut next) {
                early_termination = true;
                break;
            }
        }

        if !early_termination {
            crate::growth::apply_due_growth_waves(&mut next);
            reset_daily_commute_flags(&mut next);
            spawn_due_commute_trips(&mut next);
        }
    }

    next
}

/// Upper bound on the number of fixed-size substeps a single tick may take.
///
/// A tick from `state.time` to `final_time` is broken at every meaningful boundary
/// (day rollover, each sim's scheduled outbound/return departure, each active trip's
/// next walk/patience/deadline event, each transit vehicle's next stop arrival, and
/// each unapplied growth wave's trigger time) so spawn, boarding, growth, and
/// day-rollover logic fire at exactly the right instant. The cap is the sum of four
/// independent upper bounds on the number of such events:
/// - `day_count * events_per_day` — one boundary per sim shift event
///   (`SIM_SHIFT_BOUNDARIES_PER_DAY` covers the outbound/return spawn + resolution
///   boundaries) plus `2` for the day boundary, across every day the tick spans;
/// - `per_second_net` — a 1-second-granularity safety net over the elapsed time,
///   which covers the sparse walk-leg / sim-departure / day boundaries; and
/// - `vehicle_bound` — one substep per transit stop arrival, the densest source. A
///   vehicle on the shortest possible segment (1 tile) reaches its next stop every
///   `1 / METRO_TILES_PER_SECOND` seconds, and metro is the fastest mode so it
///   upper-bounds bus arrivals too. Each vehicle contributes independently, so the
///   union of arrival events over the tick is at most
///   `duration * METRO_TILES_PER_SECOND * vehicle_count`; and
/// - campaign `growth_waves.len()` — one boundary per unapplied growth wave, since each wave
///   fires at its own `trigger_time` (see `next_boundary_after` and `crate::growth`).
/// - campaign `trip_outcomes.len()` — one boundary per in-window outcome expiry, since
///   `next_boundary_after` breaks at the instant each outcome falls out of the rolling
///   evaluation window so a coarse tick samples the loss gates there (see
///   `next_boundary_after`'s outcome-expiry block). The vector is pruned to the window,
///   so this term is bounded by the recent trip-resolution count.
///
/// then `+1`. Without `vehicle_bound`, a large delta advanced while a metro runs on
/// short segments exhausts the per-second budget before reaching `final_time` and
/// silently returns a snapshot hundreds of seconds early (a one-tile metro segment
/// yields a stop boundary every 0.625s, faster than one per second). All terms are
/// saturating, so an enormous delta cannot overflow.
fn max_tick_substeps(state: &GameSnapshot, final_time: f64) -> usize {
    let start_day = clock::day_index(state.time);
    let end_day = clock::day_index(final_time);
    let day_count = end_day.saturating_sub(start_day) as usize + 1;
    let events_per_day = state
        .sims
        .len()
        .saturating_mul(SIM_SHIFT_BOUNDARIES_PER_DAY)
        .saturating_add(2);

    let duration = (final_time - state.time).max(0.0);
    let per_second_net = duration.ceil() as usize;
    let vehicle_bound =
        (duration * transit::METRO_TILES_PER_SECOND * state.transit.vehicles.len() as f64).ceil()
            as usize;
    let growth_wave_bound = if state.rules.game_mode == GameMode::Campaign {
        state.scenario.growth_waves.len()
    } else {
        0
    };
    let outcome_expiry_bound = if state.rules.game_mode == GameMode::Campaign {
        state.metrics.trip_outcomes.len()
    } else {
        0
    };

    day_count
        .saturating_mul(events_per_day)
        .saturating_add(per_second_net)
        .saturating_add(vehicle_bound)
        .saturating_add(growth_wave_bound)
        .saturating_add(outcome_expiry_bound)
        .saturating_add(1)
}

fn advance_tick_substep(state: &GameSnapshot, delta_seconds: f64) -> GameSnapshot {
    let mut next = state.clone();
    next.time += delta_seconds;
    sync_clock(&mut next);
    reset_daily_commute_flags(&mut next);

    let vehicle_state = transit::tick_vehicles(&next, delta_seconds);
    let just_disembarked_trip_ids = just_disembarked_trip_ids(&next, &vehicle_state);
    advance_active_trips_with_zero_delta_ids(
        &vehicle_state,
        delta_seconds,
        &just_disembarked_trip_ids,
    )
}

fn sync_clock(state: &mut GameSnapshot) {
    state.day = clock::day_index(state.time);
    state.clock_minutes = clock::clock_minutes(state.time);
}

pub fn advance_active_trips(state: &GameSnapshot, delta_seconds: f64) -> GameSnapshot {
    advance_active_trips_with_zero_delta_ids(state, delta_seconds, &HashSet::new())
}

fn advance_active_trips_with_zero_delta_ids(
    state: &GameSnapshot,
    delta_seconds: f64,
    zero_delta_trip_ids: &HashSet<String>,
) -> GameSnapshot {
    let mut results = Vec::with_capacity(state.active_trips.len());

    for trip in &state.active_trips {
        let trip_delta_seconds = if zero_delta_trip_ids.contains(&trip.id) {
            0.0
        } else {
            delta_seconds
        };
        let tick_start_time = (state.time - trip_delta_seconds).max(0.0);
        results.push(tick_trip(state, trip, trip_delta_seconds, tick_start_time));
    }

    let metric_delta = TripMetricDelta {
        completed_trips: results.iter().map(|result| result.completed_trips).sum(),
        late_trips: results.iter().map(|result| result.late_trips).sum(),
        unserved_trips: results.iter().map(|result| result.unserved_trips).sum(),
        wait_seconds: results.iter().map(|result| result.wait_seconds).sum(),
        outcomes: results
            .iter()
            .filter_map(|result| result.outcome.clone())
            .collect(),
    };

    let mut next = state.clone();
    next.active_trips = Vec::with_capacity(results.len());
    for result in results {
        if is_terminal_status(result.trip.status) {
            apply_commute_resolution_to_sim(&mut next, &result.trip);
        }
        if result.completed_trips > 0 {
            apply_arrival_to_sim(&mut next, &result.trip);
        }
        if !is_terminal_status(result.trip.status) {
            next.active_trips.push(result.trip);
        }
    }

    let retention_window_seconds = objectives::effective_rolling_window_seconds(state);
    next.metrics = update_metrics(
        &state.metrics,
        &next.active_trips,
        metric_delta,
        state.time,
        retention_window_seconds,
    );
    next
}

fn just_disembarked_trip_ids(before: &GameSnapshot, after: &GameSnapshot) -> HashSet<String> {
    after
        .active_trips
        .iter()
        .filter(|trip| {
            let Some(previous) = before
                .active_trips
                .iter()
                .find(|candidate| candidate.id == trip.id)
            else {
                return false;
            };

            // A trip that alighted during `tick_vehicles` must not be advanced
            // again by `advance_active_trips` in the same substep: the ride
            // already consumed the substep delta, so the following walk leg
            // should start at the alighting stop with zero elapsed time. This
            // covers two transitions:
            //   - `Riding → Walking`: the trip was already aboard and rode to
            //     its alighting stop;
            //   - `Waiting → Walking`: the trip boarded at the start of the
            //     substep (vehicle at progress 0) and reached its alighting
            //     stop in that same substep. `tick_vehicles` folds the board
            //     and the disembark into one pass, so the `before` snapshot
            //     still shows `Waiting`. Without including it here, the walk
            //     leg would be advanced by the full substep delta and the
            //     commute would arrive early (short segments / high speed /
            //     large ticks).
            // A `Waiting` trip can only become `Walking` inside `tick_vehicles`
            // via board-then-disembark, so the leg-advance + off-vehicle guards
            // keep this precise.
            matches!(previous.status, TripStatus::Riding | TripStatus::Waiting)
                && trip.status == TripStatus::Walking
                && trip.current_leg_index > previous.current_leg_index
                && !is_trip_on_vehicle(after, &trip.id)
        })
        .map(|trip| trip.id.clone())
        .collect()
}

fn reset_daily_commute_flags(state: &mut GameSnapshot) {
    if state.trip_sequence_day != state.day {
        state.trip_sequence_day = state.day;
        state.next_trip_sequence = 1;
    }

    for sim in &mut state.sims {
        if sim.commute_day != state.day {
            sim.commute_day = state.day;
            sim.outbound_resolved_today = false;
            sim.outbound_arrived_today = false;
            sim.return_resolved_today = false;
            sim.returned_home_today = false;
        }
    }
}

fn spawn_due_commute_trips(state: &mut GameSnapshot) {
    let sims = state.sims.clone();

    for sim in sims {
        if sim.worker_profile != WorkerProfile::Worker {
            continue;
        }
        let Some(template) = sim.shift_template.as_deref() else {
            continue;
        };

        if !sim.outbound_resolved_today
            && !sim.outbound_arrived_today
            && has_valid_workplace_destination(state, &sim)
        {
            // `has_valid_workplace_destination` above guarantees a workplace, but
            // prefer a defensive `continue` over `.expect()` so a future regression
            // in that guard surfaces as a skipped sim rather than a panic.
            let Some(workplace) = sim.workplace else {
                continue;
            };

            // Stranded-sim guard: the only way a worker is not at home at the
            // start of a day's outbound window is that the previous day's return
            // trip was unserved, leaving them stranded at (or near) the
            // workplace. The midnight reset cleared the daily flags, so without
            // this guard the spawn condition below would fire and `build_trip`
            // would use `sim.position` (the workplace) as the trip position
            // while the destination is that same workplace — a zero-distance
            // phantom outbound that `tick_trip` immediately scores as arrived,
            // inflating `completed_trips` and masking the stranded state. The
            // sim is already at work, so resolve the outbound and unlock the
            // return trip to bring them home.
            //
            // Active-trip exception: if the sim still has an in-progress trip
            // (e.g., a return trip from the previous day that has not yet
            // arrived across the midnight boundary), `sim.position` is still
            // the workplace even though the sim is in transit, not stranded.
            // Applying the stranded guard here would set
            // `outbound_resolved_today`/`outbound_arrived_today`, unlocking the
            // return spawn; once the in-progress return arrives home (setting
            // `sim.position = home` but, due to the day mismatch in
            // `apply_arrival_to_sim`, NOT setting `returned_home_today`/
            // `return_resolved_today`), the current day's return departure
            // would spawn a home→home phantom return trip and count a phantom
            // completion. Skip the sim entirely and let the active trip
            // resolve naturally; the normal spawn logic handles the next
            // outbound once the sim is back at home.
            if sim.position != sim.home {
                if has_active_trip_for_sim(state, &sim.id) {
                    continue;
                }
                if let Some(sim) = state
                    .sims
                    .iter_mut()
                    .find(|candidate| candidate.id == sim.id)
                {
                    sim.outbound_resolved_today = true;
                    sim.outbound_arrived_today = true;
                }
                continue;
            }

            let departure = departure_minute_for_sim(&sim.id, template, "outbound");
            let scheduled_time = scheduled_time_seconds(state.day, departure);
            if state.time + EPSILON >= scheduled_time
                && !has_trip_for_sim_day(state, &sim.id, TripPurpose::CommuteOutbound, state.day)
            {
                // Late-assignment guard: when `state.time` is already past the
                // scheduled departure, the workplace was assigned after the
                // departure boundary (e.g., housing existed with no destinations
                // and a destination was built mid-day). The substep machinery
                // breaks at the departure only when a workplace already exists,
                // so a spawn meaningfully past `scheduled_time` can only arise
                // from a mid-day assignment. Spawning now would anchor the trip
                // to the past `scheduled_time`, giving it a shortened or
                // already-expired deadline (`scheduled_time + 900`) and
                // recording spurious late/unserved demand even though no commute
                // requirement existed at the departure boundary. Skip today's
                // outbound; the worker commutes normally on the next day when
                // the scheduled departure is in the future relative to
                // `state.time`.
                if state.time > scheduled_time + EPSILON {
                    if let Some(sim) = state
                        .sims
                        .iter_mut()
                        .find(|candidate| candidate.id == sim.id)
                    {
                        sim.outbound_resolved_today = true;
                    }
                    continue;
                }
                let trip = build_trip(
                    state,
                    &sim.id,
                    TripPurpose::CommuteOutbound,
                    sim.home,
                    workplace,
                    sim.position.into(),
                    scheduled_time,
                );
                state.active_trips.push(trip);
            }
        }

        if !sim.outbound_arrived_today {
            continue;
        }
        if sim.return_resolved_today || sim.returned_home_today {
            continue;
        }
        let return_departure = departure_minute_for_sim(&sim.id, template, "return");
        let scheduled_time = scheduled_time_seconds(state.day, return_departure);
        if state.time + EPSILON >= scheduled_time
            && !has_trip_for_sim_day(state, &sim.id, TripPurpose::CommuteReturn, state.day)
        {
            let trip = build_trip(
                state,
                &sim.id,
                TripPurpose::CommuteReturn,
                sim.position,
                sim.home,
                sim.position.into(),
                scheduled_time,
            );
            state.active_trips.push(trip);
        }
    }
}

fn next_boundary_after(state: &GameSnapshot) -> Option<f64> {
    let after = state.time + EPSILON;
    let mut next = None;
    let active_thresholds = active_objective_thresholds(state);
    let next_day_boundary = (f64::from(state.day) + 1.0) * GAME_DAY_SECONDS;
    if next_day_boundary > after {
        next = Some(next_day_boundary);
    }

    if let Some(survival_time) = active_thresholds
        .map(|thresholds| thresholds.survival_time.value())
        .filter(|survival_time| *survival_time > after)
    {
        track_next_boundary(&mut next, survival_time, after);
    }

    for sim in &state.sims {
        if sim.worker_profile != WorkerProfile::Worker {
            continue;
        }
        let Some(template) = sim.shift_template.as_deref() else {
            continue;
        };

        if !sim.outbound_resolved_today
            && !sim.outbound_arrived_today
            && has_valid_workplace_destination(state, sim)
            && !has_trip_for_sim_day(state, &sim.id, TripPurpose::CommuteOutbound, state.day)
        {
            let departure = departure_minute_for_sim(&sim.id, template, "outbound");
            track_next_boundary(
                &mut next,
                scheduled_time_seconds(state.day, departure),
                after,
            );
        }

        if !sim.return_resolved_today
            && !sim.returned_home_today
            && !has_trip_for_sim_day(state, &sim.id, TripPurpose::CommuteReturn, state.day)
        {
            let return_departure = departure_minute_for_sim(&sim.id, template, "return");
            track_next_boundary(
                &mut next,
                scheduled_time_seconds(state.day, return_departure),
                after,
            );
        }
    }

    for trip in &state.active_trips {
        track_active_trip_boundary(
            &mut next,
            state,
            trip,
            after,
            active_thresholds.map(|thresholds| thresholds.max_average_wait.value()),
        );
    }

    track_aggregate_wait_boundary(
        &mut next,
        state,
        after,
        active_thresholds.map(|thresholds| thresholds.max_average_wait.value()),
    );

    for vehicle in &state.transit.vehicles {
        if let Some(seconds) = transit::seconds_until_next_vehicle_stop(state, vehicle) {
            track_next_boundary(&mut next, state.time + seconds, after);
        }
    }

    if state.rules.game_mode == GameMode::Campaign {
        for wave in &state.scenario.growth_waves {
            if !wave.applied {
                track_next_boundary(&mut next, wave.trigger_time, after);
            }
        }
    }

    // Track the instant each in-window trip outcome falls out of the rolling
    // evaluation window. A coarse tick that spans an outcome expiry must break
    // there so `evaluate_objectives` samples the rolling counts after the
    // expiring outcomes are pruned but before later outcomes expire — otherwise
    // a burst of good outcomes expiring before bad ones flips the unserved/late
    // ratio above the threshold and is missed because both groups are pruned
    // together by the time the final substep evaluates. Only meaningful when
    // campaign objectives are active; sandbox mode never evaluates loss gates.
    if active_thresholds.is_some() {
        let retention_window = objectives::effective_rolling_window_seconds(state);
        for outcome in &state.metrics.trip_outcomes {
            track_next_boundary(&mut next, outcome.time + retention_window + EPSILON, after);
        }
    }

    next
}

fn active_objective_thresholds(state: &GameSnapshot) -> Option<&ObjectiveThresholds> {
    if state.rules.game_mode == GameMode::Campaign {
        state.scenario.objectives.as_ref()
    } else {
        None
    }
}

/// Track a boundary at the instant the aggregate `average_wait_seconds` metric
/// can cross the active campaign average-wait threshold, so a coarse substep samples the loss
/// gate there instead of skipping over the crossing.
///
/// The per-trip `wait_threshold_remaining` boundary in
/// `track_waiting_terminal_boundaries` only fires when an *individual* trip's
/// wait crosses the threshold. But the aggregate average can cross the
/// threshold between two per-trip boundaries and then recede when a trip
/// expires (patience reaches 0) — causing the loss to be missed entirely.
///
/// Between boundary events every waiting trip's wait grows at 1s/s, so the
/// average also grows at 1s/s and crosses the threshold after
/// `max_average_wait - current_average` seconds. This is computed from
/// the trips' `patience_remaining` (not `state.metrics.average_wait_seconds`,
/// which is stale until the first `update_metrics` call). Patience expiries and
/// vehicle boardings are already tracked as boundaries, so the substep ends
/// there first and this boundary is recomputed from the new state — keeping the
/// calculation correct as the waiting set changes.
fn track_aggregate_wait_boundary(
    next: &mut Option<f64>,
    state: &GameSnapshot,
    after: f64,
    max_average_wait: Option<f64>,
) {
    let Some(max_average_wait) = max_average_wait else {
        return;
    };
    let waiting_trips: Vec<&ActiveTrip> = state
        .active_trips
        .iter()
        .filter(|trip| trip.status == TripStatus::Waiting)
        .collect();
    if waiting_trips.is_empty() {
        return;
    }

    let current_wait_seconds: f64 = waiting_trips
        .iter()
        .map(|trip| (WAIT_PATIENCE_SECONDS - trip.patience_remaining).max(0.0))
        .sum();
    let average_wait_seconds = current_wait_seconds / f64::from(waiting_trips.len() as u32);
    let seconds_to_threshold = max_average_wait - average_wait_seconds;
    if seconds_to_threshold > EPSILON {
        track_next_boundary(next, state.time + seconds_to_threshold + EPSILON, after);
    } else if seconds_to_threshold >= -EPSILON {
        // Equality needs one sample strictly beyond the `>` threshold. Use a
        // boundary later than `after`; after that substep the wait is beyond
        // this equality band, preventing repeated epsilon-boundary loops.
        track_next_boundary(next, after + EPSILON, after);
    }
}

fn track_active_trip_boundary(
    next: &mut Option<f64>,
    state: &GameSnapshot,
    trip: &ActiveTrip,
    after: f64,
    max_average_wait: Option<f64>,
) {
    if is_terminal_status(trip.status)
        || is_home_fallback_trip(state, trip)
        || (trip.status == TripStatus::Riding && is_trip_on_vehicle(state, &trip.id))
    {
        return;
    }

    let route_plan = if trip.route_plan.is_none() || trip.status == TripStatus::Riding {
        let snapped_origin = snap_position_to_point(&trip.position);
        plan_route(state, &snapped_origin, &trip.destination)
    } else {
        trip.route_plan.clone()
    };
    let Some(route_plan) = route_plan else {
        return;
    };

    let current_leg_index = if trip.route_plan.is_none() || trip.status == TripStatus::Riding {
        0
    } else {
        trip.current_leg_index
    };
    // Walk the plan forward past any leading zero-length walk legs (a no-op
    // boarding/transfer walk where the trip is already at `leg.to`). This mirrors
    // the collapse in `tick_trip`: `seconds_to_next_walk_boundary` returns `None`
    // for such legs, and without skipping them the tracker would miss the boundary
    // of the transit leg waiting behind the no-op walk (e.g. its patience/deadline
    // terminal), leaving the substep machinery blind to the trip's effective state.
    let mut leg_index = current_leg_index;
    loop {
        let Some(leg) = route_plan.legs.get(leg_index) else {
            return;
        };
        if leg.mode != TransitMode::Walk {
            track_waiting_terminal_boundaries(next, state, trip, after, max_average_wait);
            return;
        }
        match seconds_to_next_walk_boundary(&trip.position, &leg.to) {
            Some(seconds) => {
                track_next_boundary(next, state.time + seconds, after);
                return;
            }
            None => leg_index += 1,
        }
    }
}

fn track_waiting_terminal_boundaries(
    next: &mut Option<f64>,
    state: &GameSnapshot,
    trip: &ActiveTrip,
    after: f64,
    max_average_wait: Option<f64>,
) {
    // Break at the average-wait loss threshold so a coarse substep doesn't span
    // from below the active average-wait threshold all the way to patience
    // expiry without sampling the metric. A trip that has waited
    // `WAIT_PATIENCE_SECONDS - patience_remaining` seconds crosses the threshold
    // after `patience_remaining - (WAIT_PATIENCE_SECONDS - max_average_wait)`
    // more seconds. A tiny `EPSILON` offset lands the sample strictly above the
    // threshold because the loss gate uses `>` not `>=`.
    if let Some(max_average_wait) = max_average_wait {
        let seconds_to_threshold =
            trip.patience_remaining - (WAIT_PATIENCE_SECONDS - max_average_wait);
        if seconds_to_threshold > EPSILON {
            track_next_boundary(next, state.time + seconds_to_threshold + EPSILON, after);
        } else if seconds_to_threshold >= -EPSILON {
            // As with the aggregate tracker, advance once beyond equality and
            // then fall out of the epsilon band to avoid a zero-progress loop.
            track_next_boundary(next, after + EPSILON, after);
        }
    }

    if trip.patience_remaining > EPSILON {
        track_next_boundary(next, state.time + trip.patience_remaining, after);
    }

    let deadline_timeout = trip.deadline + DEADLINE_GRACE_SECONDS;
    if deadline_timeout > state.time {
        track_next_boundary(next, deadline_timeout, after);
    }
}

fn seconds_to_next_walk_boundary(position: &TripPosition, target: &Point) -> Option<f64> {
    let x_distance = f64::from(target.x) - position.x;
    if x_distance.abs() > EPSILON {
        return Some(x_distance.abs() * WALK_SECONDS_PER_TILE);
    }

    let y_distance = f64::from(target.y) - position.y;
    if y_distance.abs() > EPSILON {
        return Some(y_distance.abs() * WALK_SECONDS_PER_TILE);
    }

    None
}

fn track_next_boundary(next: &mut Option<f64>, candidate: f64, after: f64) {
    if candidate <= after {
        return;
    }

    if next.as_ref().map_or(true, |current| candidate < *current) {
        *next = Some(candidate);
    }
}

fn build_trip(
    state: &mut GameSnapshot,
    sim_id: &str,
    purpose: TripPurpose,
    origin: Point,
    destination: Point,
    position: TripPosition,
    scheduled_time: f64,
) -> ActiveTrip {
    ActiveTrip {
        id: next_trip_id_for_day(state),
        sim_id: sim_id.to_string(),
        purpose,
        origin,
        destination,
        position,
        status: TripStatus::Idle,
        deadline: trip_deadline_seconds(scheduled_time),
        route_plan: None,
        current_leg_index: 0,
        patience_remaining: WAIT_PATIENCE_SECONDS,
    }
}

fn next_trip_id_for_day(state: &mut GameSnapshot) -> String {
    if state.trip_sequence_day != state.day {
        state.trip_sequence_day = state.day;
        state.next_trip_sequence = 1;
    }

    let prefix = format!("trip-day-{}-trip-", state.day);
    let next_number = state.next_trip_sequence.max(1);
    state.next_trip_sequence = next_number + 1;
    format!("{prefix}{next_number:03}")
}

fn has_trip_for_sim_day(
    state: &GameSnapshot,
    sim_id: &str,
    purpose: TripPurpose,
    day: u32,
) -> bool {
    let prefix = format!("trip-day-{day}-trip-");
    state.active_trips.iter().any(|trip| {
        trip.id.starts_with(&prefix) && trip.sim_id == sim_id && trip.purpose == purpose
    })
}

/// Whether the sim has any non-terminal active trip (regardless of service
/// day). Used by the stranded-sim guard to distinguish a sim genuinely
/// stranded at the workplace from one still in transit on a cross-midnight
/// return trip.
fn has_active_trip_for_sim(state: &GameSnapshot, sim_id: &str) -> bool {
    state
        .active_trips
        .iter()
        .any(|trip| trip.sim_id == sim_id && !is_terminal_status(trip.status))
}

fn scheduled_time_seconds(day: u32, minute: u16) -> f64 {
    f64::from(day) * GAME_DAY_SECONDS
        + (f64::from(minute) / f64::from(MINUTES_PER_DAY)) * GAME_DAY_SECONDS
}

fn tick_trip(
    state: &GameSnapshot,
    trip: &ActiveTrip,
    delta_seconds: f64,
    tick_start_time: f64,
) -> TripTickResult {
    if is_terminal_status(trip.status) || is_home_fallback_trip(state, trip) {
        return unchanged(trip);
    }

    if trip.status == TripStatus::Riding && is_trip_on_vehicle(state, &trip.id) {
        return unchanged(trip);
    }

    let mut next_trip = trip.clone();
    let mut route_plan = next_trip.route_plan.clone();

    if next_trip.status == TripStatus::Riding {
        next_trip.status = TripStatus::Idle;
        next_trip.route_plan = None;
        next_trip.current_leg_index = 0;
        route_plan = None;
    }

    if route_plan.is_none() {
        let snapped_origin = snap_position_to_point(&next_trip.position);
        let Some(planned_route) = plan_route(state, &snapped_origin, &next_trip.destination) else {
            return TripTickResult {
                trip: mark_unserved(next_trip),
                completed_trips: 0,
                late_trips: 0,
                unserved_trips: 1,
                wait_seconds: 0.0,
                outcome: Some(trip_outcome(
                    TripOutcomeKind::Unserved,
                    0.0,
                    tick_start_time,
                )),
            };
        };

        next_trip.route_plan = Some(planned_route.clone());
        next_trip.current_leg_index = 0;
        next_trip.status = status_after_leg(&planned_route, 0);
        route_plan = Some(planned_route);
    }

    // Invariant: the block above guarantees `route_plan` is `Some` here — it
    // either was already set, or planning just succeeded, or planning failed
    // and we early-returned. Guard defensively so a future regression that
    // leaves `route_plan` empty marks the trip unserved instead of panicking
    // under the Tauri Mutex mid-tick (which would brick the game for the
    // remainder of the session).
    let Some(route_plan) = route_plan else {
        return TripTickResult {
            trip: mark_unserved(next_trip),
            completed_trips: 0,
            late_trips: 0,
            unserved_trips: 1,
            wait_seconds: 0.0,
            outcome: Some(trip_outcome(
                TripOutcomeKind::Unserved,
                0.0,
                tick_start_time,
            )),
        };
    };
    if is_walking_only(&route_plan)
        && state.time > next_trip.deadline
        && state.time + route_plan.estimated_seconds > next_trip.deadline
    {
        return TripTickResult {
            trip: mark_unserved(next_trip),
            completed_trips: 0,
            late_trips: 0,
            unserved_trips: 1,
            wait_seconds: 0.0,
            outcome: Some(trip_outcome(
                TripOutcomeKind::Unserved,
                0.0,
                tick_start_time,
            )),
        };
    }

    // Collapse any leading zero-length walk legs — a no-op walk (boarding at the
    // trip's current tile, or transferring between two lines at the same stop)
    // where the trip is already at `leg.to`. Non-zero walks are boundary-protected
    // via `next_boundary_after`, but a zero-length walk produces no boundary, so
    // without this collapse a large tick consumes the whole substep on the no-op
    // walk and returns without accruing wait time for the following transit leg or
    // allowing boarding. Collapsing lets the trip fall through to the wait/ride
    // processing in the same substep, preserving large-tick vs stepped-tick
    // equivalence.
    let original_leg_index = next_trip.current_leg_index;
    while route_plan
        .legs
        .get(next_trip.current_leg_index)
        .is_some_and(|leg| {
            leg.mode == TransitMode::Walk && same_position_and_point(&next_trip.position, &leg.to)
        })
    {
        next_trip.current_leg_index += 1;
    }
    if next_trip.current_leg_index != original_leg_index {
        next_trip.status = status_after_leg(&route_plan, next_trip.current_leg_index);
    }

    let Some(leg) = route_plan.legs.get(next_trip.current_leg_index) else {
        // No remaining leg. The legitimate case is a zero-leg plan (or a plan whose
        // legs were all collapsed zero-length walks) with the trip already at its
        // destination. If instead the position is not at the destination, a routing
        // regression produced an empty plan mid-trip — surface that as unserved
        // rather than recording a phantom arrival.
        if same_position_and_point(&next_trip.position, &next_trip.destination) {
            return score_arrival(next_trip, state.time);
        }
        return TripTickResult {
            trip: mark_unserved(next_trip),
            completed_trips: 0,
            late_trips: 0,
            unserved_trips: 1,
            wait_seconds: 0.0,
            outcome: Some(trip_outcome(
                TripOutcomeKind::Unserved,
                0.0,
                tick_start_time,
            )),
        };
    };

    if leg.mode == TransitMode::Walk {
        next_trip.position = move_toward(
            &next_trip.position,
            &leg.to,
            (delta_seconds / WALK_SECONDS_PER_TILE).max(0.0),
        );
        if same_position_and_point(&next_trip.position, &leg.to) {
            next_trip.current_leg_index += 1;
            next_trip.status = status_after_leg(&route_plan, next_trip.current_leg_index);
        } else {
            next_trip.status = TripStatus::Walking;
        }

        if next_trip.status == TripStatus::Arrived {
            return score_arrival(next_trip, state.time);
        }

        return TripTickResult {
            trip: next_trip,
            completed_trips: 0,
            late_trips: 0,
            unserved_trips: 0,
            wait_seconds: 0.0,
            outcome: None,
        };
    }

    let terminal_wait_seconds =
        waiting_terminal_elapsed_seconds(&next_trip, delta_seconds, tick_start_time, state.time);
    let elapsed_wait_seconds = terminal_wait_seconds.unwrap_or(delta_seconds);
    next_trip.status = TripStatus::Waiting;
    next_trip.patience_remaining = (next_trip.patience_remaining - elapsed_wait_seconds).max(0.0);

    if terminal_wait_seconds.is_some() {
        let outcome_wait_seconds = (WAIT_PATIENCE_SECONDS - next_trip.patience_remaining).max(0.0);
        return TripTickResult {
            trip: mark_unserved(next_trip),
            completed_trips: 0,
            late_trips: 0,
            unserved_trips: 1,
            wait_seconds: elapsed_wait_seconds,
            outcome: Some(trip_outcome(
                TripOutcomeKind::Unserved,
                outcome_wait_seconds,
                tick_start_time + elapsed_wait_seconds,
            )),
        };
    }

    TripTickResult {
        trip: next_trip,
        completed_trips: 0,
        late_trips: 0,
        unserved_trips: 0,
        wait_seconds: delta_seconds,
        outcome: None,
    }
}

fn waiting_terminal_elapsed_seconds(
    trip: &ActiveTrip,
    delta_seconds: f64,
    tick_start_time: f64,
    tick_end_time: f64,
) -> Option<f64> {
    let patience_elapsed = if trip.patience_remaining <= delta_seconds {
        Some(trip.patience_remaining.max(0.0))
    } else {
        None
    };
    let deadline_timeout = trip.deadline + DEADLINE_GRACE_SECONDS;
    let deadline_elapsed = if tick_start_time >= deadline_timeout {
        Some(0.0)
    } else if tick_end_time >= deadline_timeout {
        Some((deadline_timeout - tick_start_time).max(0.0))
    } else {
        None
    };

    match (patience_elapsed, deadline_elapsed) {
        (Some(left), Some(right)) => Some(left.min(right)),
        (Some(elapsed), None) | (None, Some(elapsed)) => Some(elapsed),
        (None, None) => None,
    }
}

fn unchanged(trip: &ActiveTrip) -> TripTickResult {
    TripTickResult {
        trip: trip.clone(),
        completed_trips: 0,
        late_trips: 0,
        unserved_trips: 0,
        wait_seconds: 0.0,
        outcome: None,
    }
}

fn score_arrival(mut trip: ActiveTrip, time: f64) -> TripTickResult {
    let late = time > trip.deadline;
    trip.status = if late {
        TripStatus::Late
    } else {
        TripStatus::Arrived
    };
    TripTickResult {
        trip,
        completed_trips: 1,
        late_trips: u32::from(late),
        unserved_trips: 0,
        wait_seconds: 0.0,
        outcome: Some(trip_outcome(
            if late {
                TripOutcomeKind::Late
            } else {
                TripOutcomeKind::Arrived
            },
            0.0,
            time,
        )),
    }
}

fn trip_outcome(outcome: TripOutcomeKind, wait_seconds: f64, time: f64) -> TripOutcome {
    TripOutcome {
        outcome,
        wait_seconds: wait_seconds.max(0.0),
        time,
    }
}

fn mark_unserved(mut trip: ActiveTrip) -> ActiveTrip {
    trip.status = TripStatus::Unserved;
    trip.patience_remaining = trip.patience_remaining.max(0.0);
    trip
}

fn update_metrics(
    metrics: &Metrics,
    trips: &[ActiveTrip],
    metric_delta: TripMetricDelta,
    current_time: f64,
    retention_window_seconds: f64,
) -> Metrics {
    let total_wait_seconds = metrics.total_wait_seconds + metric_delta.wait_seconds;
    let waiting_trip_count = trips
        .iter()
        .filter(|trip| trip.status == TripStatus::Waiting)
        .count() as u32;
    let current_wait_seconds: f64 = trips
        .iter()
        .filter(|trip| trip.status == TripStatus::Waiting)
        .map(|trip| (WAIT_PATIENCE_SECONDS - trip.patience_remaining).max(0.0))
        .sum();

    let mut trip_outcomes = metrics
        .trip_outcomes
        .iter()
        .cloned()
        .chain(metric_delta.outcomes)
        .collect();
    objectives::prune_trip_outcomes(&mut trip_outcomes, current_time, retention_window_seconds);

    Metrics {
        late_trips: metrics.late_trips + metric_delta.late_trips,
        completed_trips: metrics.completed_trips + metric_delta.completed_trips,
        unserved_trips: metrics.unserved_trips + metric_delta.unserved_trips,
        total_wait_seconds,
        waiting_trip_count,
        average_wait_seconds: if waiting_trip_count > 0 {
            current_wait_seconds / f64::from(waiting_trip_count)
        } else {
            0.0
        },
        trip_outcomes,
        state: metrics.state,
        loss_reason: metrics.loss_reason.clone(),
    }
}

fn apply_arrival_to_sim(state: &mut GameSnapshot, trip: &ActiveTrip) {
    let Some(sim) = state.sims.iter_mut().find(|sim| sim.id == trip.sim_id) else {
        return;
    };

    match trip.purpose {
        TripPurpose::CommuteOutbound => {
            sim.position = trip.destination;
            if trip_service_day(trip).is_some_and(|day| day == state.day) {
                sim.outbound_arrived_today = true;
            }
        }
        TripPurpose::CommuteReturn => {
            sim.position = sim.home;
            if trip_service_day(trip).is_some_and(|day| day == state.day) {
                sim.returned_home_today = true;
            }
        }
    }
}

fn apply_commute_resolution_to_sim(state: &mut GameSnapshot, trip: &ActiveTrip) {
    if !trip_service_day(trip).is_some_and(|day| day == state.day) {
        return;
    }

    let Some(sim) = state.sims.iter_mut().find(|sim| sim.id == trip.sim_id) else {
        return;
    };

    match trip.purpose {
        TripPurpose::CommuteOutbound => {
            sim.outbound_resolved_today = true;
        }
        TripPurpose::CommuteReturn => {
            sim.return_resolved_today = true;
        }
    }
}

fn is_terminal_status(status: TripStatus) -> bool {
    matches!(
        status,
        TripStatus::Arrived | TripStatus::Late | TripStatus::Unserved
    )
}

fn trip_service_day(trip: &ActiveTrip) -> Option<u32> {
    let id = trip.id.strip_prefix("trip-day-")?;
    let (day, _) = id.split_once("-trip-")?;
    day.parse().ok()
}

fn status_after_leg(route_plan: &RoutePlan, next_leg_index: usize) -> TripStatus {
    match route_plan.legs.get(next_leg_index) {
        None => TripStatus::Arrived,
        Some(leg) if leg.mode == TransitMode::Walk => TripStatus::Walking,
        Some(_) => TripStatus::Waiting,
    }
}

fn is_walking_only(route_plan: &RoutePlan) -> bool {
    route_plan
        .legs
        .iter()
        .all(|leg| leg.mode == TransitMode::Walk)
}

fn is_trip_on_vehicle(state: &GameSnapshot, trip_id: &str) -> bool {
    state
        .transit
        .vehicles
        .iter()
        .any(|vehicle| vehicle.passenger_ids.iter().any(|id| id == trip_id))
}

fn is_home_fallback_trip(state: &GameSnapshot, trip: &ActiveTrip) -> bool {
    let Some(sim) = state.sims.iter().find(|sim| sim.id == trip.sim_id) else {
        return false;
    };

    if trip.destination != sim.home || trip.purpose == TripPurpose::CommuteReturn {
        return false;
    }

    if trip.purpose == TripPurpose::CommuteOutbound && !has_valid_workplace_destination(state, sim)
    {
        return true;
    }

    trip.origin == sim.home && same_position_and_point(&trip.position, &sim.home)
}

fn has_valid_workplace_destination(state: &GameSnapshot, sim: &Sim) -> bool {
    let Some(workplace) = sim.workplace.as_ref() else {
        return false;
    };

    crate::buildings::destination_points(state)
        .iter()
        .any(|destination| destination == workplace)
}

/// Retarget active outbound trips left dormant on a home-fallback destination
/// once their sim has been promoted to a real (non-home) workplace by
/// `buildings::assign_workplaces`.
///
/// A home-fallback trip has `destination == sim.home` and is held dormant by
/// `is_home_fallback_trip`: it neither progresses nor resolves. When a real
/// destination later appears, `assign_workplaces` reassigns the sim's
/// `workplace` away from home, but the stale trip still targets home and —
/// because it is dormant and never terminal — its id keeps
/// `has_trip_for_sim_day` true, blocking any fresh outbound spawn. The worker
/// is therefore stuck non-commuting despite now holding a valid workplace.
///
/// This rewrites each such trip onto the sim's current workplace, resetting the
/// route plan, status, patience/deadline window, and id so the commute resumes
/// from the sim's current position (home). Mirrors the legacy `retargetCitizens`
/// destination/timer reset in `src/simulation/buildingSelectors.ts`.
///
/// The id is regenerated for the current day because it encodes the service day
/// (`trip-day-{day}-trip-{n}`), which `has_trip_for_sim_day`,
/// `apply_arrival_to_sim`, and `apply_commute_resolution_to_sim` all parse back
/// out. A dormant home-fallback trip can survive across day boundaries (it is
/// non-terminal and `tick_trip` returns it unchanged), so a trip spawned on day
/// N that is retargeted on day M would otherwise keep its day-N id: the stale
/// prefix makes `has_trip_for_sim_day(_, _, M)` miss it and allow a duplicate
/// same-day outbound spawn, and `trip_service_day != state.day` prevents the
/// retargeted arrival/resolution from setting today's commute flags.
///
/// Home-fallback trips are dormant at home and never aboard a vehicle, so no
/// passenger-id cleanup is required (unlike the bulldoze retarget in
/// `transit::cleanup_removed_destination_references`).
pub fn retarget_home_fallback_trips(state: &mut GameSnapshot) {
    // Collect sims promoted out of a home-fallback to a real (non-home, valid)
    // workplace up front, so the trip loop can mutate `active_trips` without
    // aliasing the immutable `sims` borrow used by `has_valid_workplace_destination`.
    let promoted: HashMap<String, (Point, Point)> = state
        .sims
        .iter()
        .filter_map(|sim| {
            let workplace = sim.workplace.as_ref()?;
            if workplace == &sim.home || !has_valid_workplace_destination(state, sim) {
                return None;
            }
            Some((sim.id.clone(), (sim.home, *workplace)))
        })
        .collect();

    if promoted.is_empty() {
        return;
    }

    // Collect the indices of stale home-fallback trips first. The retarget must
    // regenerate each trip's id via `next_trip_id_for_day(state)`, which borrows
    // the trip-sequence counters on `state`; doing that inside a `&mut
    // state.active_trips` loop would alias the borrow. Index collection decouples
    // the selection pass from the mutation pass.
    let mut to_retarget: Vec<(usize, Point)> = Vec::new();
    for (index, trip) in state.active_trips.iter().enumerate() {
        if trip.purpose != TripPurpose::CommuteOutbound || trip.status == TripStatus::Riding {
            continue;
        }
        let Some((home, workplace)) = promoted.get(&trip.sim_id) else {
            continue;
        };
        // Only stale home-fallback trips: still targeting home while the sim
        // now holds a real non-home workplace.
        if trip.destination != *home {
            continue;
        }
        to_retarget.push((index, *workplace));
    }

    for (index, workplace) in to_retarget {
        // Regenerate the id for the current day so the day-encoded prefix matches
        // `state.day` (see function doc). This also advances `next_trip_sequence`
        // exactly as a freshly-spawned trip would.
        let new_id = next_trip_id_for_day(state);
        let trip = &mut state.active_trips[index];
        trip.id = new_id;
        trip.status = TripStatus::Idle;
        trip.route_plan = None;
        trip.current_leg_index = 0;
        trip.destination = workplace;
        trip.deadline = trip_deadline_seconds(state.time);
        trip.patience_remaining = WAIT_PATIENCE_SECONDS;
    }
}

fn snap_position_to_point(position: &TripPosition) -> Point {
    Point {
        x: position.x.round() as i32,
        y: position.y.round() as i32,
    }
}

fn move_toward(from: &TripPosition, to: &Point, max_distance: f64) -> TripPosition {
    let target_x = f64::from(to.x);
    let target_y = f64::from(to.y);
    let x_distance = target_x - from.x;
    let y_distance = target_y - from.y;

    if x_distance.abs() > EPSILON {
        let step = x_distance.signum() * x_distance.abs().min(max_distance);
        return TripPosition {
            x: from.x + step,
            y: from.y,
        };
    }

    if y_distance.abs() > EPSILON {
        let step = y_distance.signum() * y_distance.abs().min(max_distance);
        return TripPosition {
            x: from.x,
            y: from.y + step,
        };
    }

    from.clone()
}

fn same_position_and_point(position: &TripPosition, point: &Point) -> bool {
    (position.x - f64::from(point.x)).abs() < EPSILON
        && (position.y - f64::from(point.y)).abs() < EPSILON
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scenario::growing_suburb_growth_waves;
    use crate::state::create_initial_snapshot;

    #[test]
    fn sandbox_mid_tick_growth_wave_does_not_schedule_or_apply_growth() {
        let mut sandbox_with_wave = create_initial_snapshot();
        sandbox_with_wave.paused = false;
        let mut waves = growing_suburb_growth_waves();
        waves[0].trigger_time = 120.0;
        sandbox_with_wave.scenario.growth_waves = waves;

        let mut sandbox_without_wave = create_initial_snapshot();
        sandbox_without_wave.paused = false;

        assert_eq!(
            next_boundary_after(&sandbox_with_wave),
            next_boundary_after(&sandbox_without_wave),
            "sandbox waves do not create tick boundaries"
        );
        assert_eq!(
            max_tick_substeps(&sandbox_with_wave, 300.0),
            max_tick_substeps(&sandbox_without_wave, 300.0),
            "sandbox waves do not consume the substep budget"
        );

        let next = tick_trips(&sandbox_with_wave, 300.0);
        let baseline = tick_trips(&sandbox_without_wave, 300.0);

        assert_eq!(next.time, baseline.time, "sandbox tick timing is unchanged");
        assert_eq!(next.buildings, baseline.buildings);
        assert_eq!(next.sims, baseline.sims);
        assert!(!next.scenario.growth_waves[0].applied);
    }
}
