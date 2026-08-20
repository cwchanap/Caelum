use std::collections::HashSet;

use crate::building_catalog::building_definition;
use crate::clock::{self, GAME_DAY_SECONDS, MINUTES_PER_DAY};
use crate::commute::{departure_minute_for_sim, trip_deadline_seconds, WALK_SECONDS_PER_TILE};
use crate::model::{
    ActiveTrip, GameMode, GameSnapshot, Metrics, MetricsState, ObjectiveThresholds, Point,
    PrivateCarTrip, RoutePlan, Sim, TransitMode, TripOutcome, TripOutcomeKind, TripPosition,
    TripPurpose, TripStatus, WorkerProfile,
};
use crate::objectives;
use crate::population;
use crate::road_topology::RoadTopology;
use crate::router;
use crate::traffic;
use crate::transit;

pub const WAIT_PATIENCE_SECONDS: f64 = 240.0;

pub(crate) fn elapsed_wait_seconds(trip: &ActiveTrip) -> f64 {
    (WAIT_PATIENCE_SECONDS - trip.patience_remaining).max(0.0)
}

/// Wait accumulated on the current transit leg's waiting stint only. Unlike
/// [`elapsed_wait_seconds`], this resets to zero whenever `current_leg_index`
/// advances, so a rider who waited on a previous line does not carry that
/// wait into the current line's route health. Used by service-health
/// aggregation; trip-wide abandonment still uses the cumulative
/// `patience_remaining` budget.
pub(crate) fn current_leg_wait_seconds(trip: &ActiveTrip) -> f64 {
    trip.current_leg_wait_seconds.max(0.0)
}

const DEADLINE_GRACE_SECONDS: f64 = 300.0;
pub(crate) const EPSILON: f64 = 0.000_001;

fn plan_route(
    state: &GameSnapshot,
    flow: &traffic::RoadFlow,
    origin: &Point,
    destination: &Point,
) -> Option<RoutePlan> {
    router::find_route_plan(state, flow, origin, destination)
}

/// Boundaries per sim per day: outbound spawn + outbound resolution + return
/// spawn + return resolution, plus headroom for the walk-leg / patience /
/// deadline boundaries a single commute can generate. Driving arrival is an
/// existing outbound/return resolution boundary, not a seventh category. Used both in
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

pub fn tick_trips(
    state: &GameSnapshot,
    road_topology: &RoadTopology,
    delta_seconds: f64,
) -> GameSnapshot {
    tick_trips_substepped(state, road_topology, delta_seconds, |_| false)
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
pub fn tick_trips_with_objectives(
    state: &GameSnapshot,
    road_topology: &RoadTopology,
    delta_seconds: f64,
) -> GameSnapshot {
    tick_trips_substepped(state, road_topology, delta_seconds, |next| {
        // Use the opt variant so the common no-fire path skips the snapshot
        // clone the legacy wrapper would perform on every substep.
        if let Some(evaluated) = objectives::evaluate_objectives_opt(next) {
            *next = evaluated;
        }
        next.metrics.state != MetricsState::Running
    })
}

fn apply_due_world_events(state: &mut GameSnapshot) {
    crate::growth::apply_due_growth_waves(state);
    population::apply_due_move_ins(state);
}

/// Derive the road-flow map for this scheduling iteration and spawn due
/// commute trips into the same snapshot, admitting same-time cars into the
/// returned map so planning, boundary estimation, and the substep all see the
/// post-spawn flow.
fn derive_flow_and_spawn(
    state: &mut GameSnapshot,
    road_topology: &RoadTopology,
) -> traffic::RoadFlow {
    let mut road_flow = traffic::derive_road_flow(state);
    spawn_due_commute_trips(state, road_topology, &mut road_flow);
    road_flow
}

fn tick_trips_substepped(
    state: &GameSnapshot,
    road_topology: &RoadTopology,
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

    // Evaluate objectives at the current timestamp before advancing time.
    // A loaded snapshot whose metrics already satisfy a terminal condition
    // (e.g. `time >= survivalTime` with completed trips, or `average_wait`
    // already above the loss threshold) must be detected at its current
    // timestamp, not at the next boundary — otherwise coarse and fine ticks
    // produce different terminal timestamps, breaking the granularity-
    // independence invariant. Process due events (growth, daily flags, trip
    // spawning) first so the evaluation sees the correct state at the current
    // time, then evaluate. If terminal, return immediately.
    apply_due_world_events(&mut next);
    reset_daily_commute_flags(&mut next);
    derive_flow_and_spawn(&mut next, road_topology);
    if on_substep(&mut next) {
        return next;
    }

    let mut early_termination = false;
    let mut steps = 0;
    // The substep budget is computed from the current snapshot, but growth
    // waves applied inside the loop can spawn new sims whose departure
    // boundaries weren't counted in `events_per_day`, and each substep appends
    // new `TripOutcome`s whose expiry boundaries weren't counted in
    // `outcome_expiry_bound`. Widen the cap when either count grows so the
    // post-growth/post-substep event budget is always accounted for and the
    // tick cannot be truncated in release builds. The outcome widening is
    // Campaign-only, matching the `outcome_expiry_bound` term in
    // `max_tick_substeps` (sandbox mode never tracks outcome-expiry
    // boundaries — see `next_boundary_after`).
    let mut cap = max_tick_substeps(&next, final_time);
    let mut last_sim_count = next.sims.len();
    let campaign_mode = next.rules.game_mode == GameMode::Campaign;
    let mut last_outcome_count = if campaign_mode {
        next.metrics.trip_outcomes.len()
    } else {
        0
    };
    loop {
        if steps >= cap || final_time - next.time <= EPSILON {
            break;
        }

        apply_due_world_events(&mut next);
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
        if campaign_mode {
            let outcome_count = next.metrics.trip_outcomes.len();
            if outcome_count > last_outcome_count {
                cap = cap.saturating_add(outcome_count.saturating_sub(last_outcome_count));
                last_outcome_count = outcome_count;
            }
        }

        reset_daily_commute_flags(&mut next);
        let road_flow = derive_flow_and_spawn(&mut next, road_topology);

        let substep_end = next_boundary_after(&next, &road_flow)
            .map(|boundary| boundary.min(final_time))
            .unwrap_or(final_time);
        let substep_delta = (substep_end - next.time).max(0.0);
        if substep_delta <= EPSILON {
            break;
        }

        next = advance_tick_substep(&next, &road_flow, substep_delta);
        steps += 1;
        // Apply growth waves whose trigger time was reached by this substep
        // before evaluating objectives. Without this, a wave due at the same
        // timestamp as a terminal objective would never fire: `on_substep` would
        // break the loop, and the wave would remain permanently unapplied in the
        // terminal snapshot (growth is otherwise applied only at the top of the
        // next iteration, which never runs).
        apply_due_world_events(&mut next);
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
            apply_due_world_events(&mut next);
            reset_daily_commute_flags(&mut next);
            let road_flow = derive_flow_and_spawn(&mut next, road_topology);

            let substep_end = next_boundary_after(&next, &road_flow)
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

            next = advance_tick_substep(&next, &road_flow, substep_delta);
            // Same post-substep growth application as the main loop — see the
            // comment there for why this must precede `on_substep`.
            apply_due_world_events(&mut next);
            if on_substep(&mut next) {
                early_termination = true;
                break;
            }
        }

        if !early_termination {
            apply_due_world_events(&mut next);
            reset_daily_commute_flags(&mut next);
            derive_flow_and_spawn(&mut next, road_topology);
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
///   fires at its own `trigger_time` (see `next_boundary_after` and `crate::growth`); and
/// - sandbox remaining resident slots — one boundary per due housing move-in, so a coarse tick
///   can process every deterministic occupancy timestamp without exhausting the cap.
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
    let move_in_bound = remaining_move_in_slots(state);
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
        .saturating_add(move_in_bound)
        .saturating_add(outcome_expiry_bound)
        .saturating_add(1)
}

fn remaining_move_in_slots(state: &GameSnapshot) -> usize {
    if state.rules.game_mode != GameMode::Sandbox {
        return 0;
    }

    state
        .buildings
        .iter()
        .filter_map(|building| {
            let definition = building_definition(&building.building_type)?;
            if definition.resident_capacity == 0 {
                return None;
            }
            let occupancy = population::resident_occupancy(state, building);
            Some(usize::from(definition.resident_capacity).saturating_sub(occupancy))
        })
        .sum()
}

fn advance_tick_substep(
    state: &GameSnapshot,
    flow: &traffic::RoadFlow,
    delta_seconds: f64,
) -> GameSnapshot {
    let previous_day = state.day;
    let mut next = state.clone();
    next.time += delta_seconds;
    sync_clock(&mut next);
    crate::operating_cost::apply_day_boundary_charge(&mut next, previous_day);
    reset_daily_commute_flags(&mut next);

    let vehicle_state = transit::tick_vehicles(&next, flow, delta_seconds);
    let just_disembarked_trip_ids = just_disembarked_trip_ids(&next, &vehicle_state);
    advance_active_trips_with_zero_delta_ids(
        &vehicle_state,
        flow,
        delta_seconds,
        &just_disembarked_trip_ids,
    )
}

fn sync_clock(state: &mut GameSnapshot) {
    state.day = clock::day_index(state.time);
    state.clock_minutes = clock::clock_minutes(state.time);
}

pub fn advance_active_trips(
    state: &GameSnapshot,
    flow: &traffic::RoadFlow,
    delta_seconds: f64,
) -> GameSnapshot {
    advance_active_trips_with_zero_delta_ids(state, flow, delta_seconds, &HashSet::new())
}

fn advance_active_trips_with_zero_delta_ids(
    state: &GameSnapshot,
    flow: &traffic::RoadFlow,
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
        results.push(tick_trip(
            state,
            flow,
            trip,
            trip_delta_seconds,
            tick_start_time,
        ));
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

fn private_car_trip_if_faster(
    non_car_plan: Option<&RoutePlan>,
    car: Option<traffic::PrivateCarCandidate>,
    current_time: f64,
) -> Option<PrivateCarTrip> {
    let car = car.filter(|car| {
        non_car_plan.map_or(true, |plan| car.estimated_seconds < plan.estimated_seconds)
    })?;
    Some(PrivateCarTrip {
        path: car.path,
        arrival_time: current_time + car.estimated_seconds,
    })
}

fn spawn_due_commute_trips(
    state: &mut GameSnapshot,
    road_topology: &RoadTopology,
    road_flow: &mut traffic::RoadFlow,
) {
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
                let trip = build_commute_trip(
                    state,
                    road_topology,
                    road_flow,
                    &sim.id,
                    TripPurpose::CommuteOutbound,
                    sim.home,
                    workplace,
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
            let trip = build_commute_trip(
                state,
                road_topology,
                road_flow,
                &sim.id,
                TripPurpose::CommuteReturn,
                sim.position,
                sim.home,
                scheduled_time,
            );
            state.active_trips.push(trip);
        }
    }
}

fn next_boundary_after(state: &GameSnapshot, flow: &traffic::RoadFlow) -> Option<f64> {
    let mut next = None;
    let active_thresholds = active_objective_thresholds(state);
    let next_day_boundary = (f64::from(state.day) + 1.0) * GAME_DAY_SECONDS;
    track_next_boundary(&mut next, next_day_boundary, state.time);

    if let Some(survival_time) =
        active_thresholds.map(|thresholds| thresholds.survival_time.value())
    {
        track_next_boundary(&mut next, survival_time, state.time);
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
                state.time,
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
                state.time,
            );
        }
    }

    for trip in &state.active_trips {
        track_active_trip_boundary(
            &mut next,
            state,
            flow,
            trip,
            active_thresholds.map(|thresholds| thresholds.max_average_wait.value()),
        );
    }

    track_aggregate_wait_boundary(
        &mut next,
        state,
        active_thresholds.map(|thresholds| thresholds.max_average_wait.value()),
    );

    for vehicle in &state.transit.vehicles {
        if let Some(seconds) = transit::seconds_until_next_vehicle_stop(state, flow, vehicle) {
            track_next_boundary(&mut next, state.time + seconds, state.time);
        }
    }

    if state.rules.game_mode == GameMode::Campaign {
        for wave in &state.scenario.growth_waves {
            if !wave.applied {
                track_next_boundary(&mut next, wave.trigger_time, state.time);
            }
        }
    }

    if state.rules.game_mode == GameMode::Sandbox {
        for building in &state.buildings {
            let Some(definition) = building_definition(&building.building_type) else {
                continue;
            };
            if definition.resident_capacity == 0 {
                continue;
            }
            let occupancy = population::resident_occupancy(state, building);
            if occupancy >= usize::from(definition.resident_capacity) {
                continue;
            }
            let due = building.placed_at + occupancy as f64 * population::MOVE_IN_INTERVAL_SECONDS;
            if due > state.time {
                track_next_boundary(&mut next, due, state.time);
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
    //
    // The `2 * EPSILON` offset (rather than the single `EPSILON` used elsewhere)
    // ensures the candidate is strictly later than `state.time + EPSILON` even
    // when `state.time` is exactly at the expiry (`outcome.time +
    // retention_window`). `track_next_boundary` now promotes candidates in
    // `(state.time, state.time + EPSILON]` to `state.time + 2 * EPSILON`, so a
    // single `EPSILON` would also suffice, but the explicit `2 * EPSILON` keeps
    // the expiry sample strictly beyond the equality band without relying on
    // the promotion — preventing a coarse tick starting at the exact expiry
    // from skipping the boundary and pruning both the expiring and later
    // outcomes together, missing the loss gate that fine ticks detect.
    if active_thresholds.is_some() {
        let retention_window = objectives::effective_rolling_window_seconds(state);
        for outcome in &state.metrics.trip_outcomes {
            track_next_boundary(
                &mut next,
                outcome.time + retention_window + 2.0 * EPSILON,
                state.time,
            );
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
        .map(|trip| elapsed_wait_seconds(trip))
        .sum();
    let average_wait_seconds = current_wait_seconds / f64::from(waiting_trips.len() as u32);
    let seconds_to_threshold = max_average_wait - average_wait_seconds;
    if seconds_to_threshold > EPSILON {
        track_next_boundary(
            next,
            state.time + seconds_to_threshold + EPSILON,
            state.time,
        );
    } else if seconds_to_threshold >= -EPSILON {
        // Equality needs one sample strictly beyond the `>` threshold. Use a
        // boundary later than `state.time + EPSILON`; after that substep the
        // wait is beyond this equality band, preventing repeated epsilon-boundary
        // loops.
        track_next_boundary(next, state.time + 2.0 * EPSILON, state.time);
    }
}

fn track_active_trip_boundary(
    next: &mut Option<f64>,
    state: &GameSnapshot,
    flow: &traffic::RoadFlow,
    trip: &ActiveTrip,
    max_average_wait: Option<f64>,
) {
    if is_terminal_status(trip.status) {
        return;
    }

    if trip.status == TripStatus::Driving {
        if let Some(car) = &trip.private_car_trip {
            track_next_boundary(next, car.arrival_time, state.time);
        }
        return;
    }

    if trip.status == TripStatus::Riding && is_trip_on_vehicle(state, &trip.id) {
        return;
    }

    let route_plan = if trip.route_plan.is_none() || trip.status == TripStatus::Riding {
        let snapped_origin = snap_position_to_point(&trip.position);
        plan_route(state, flow, &snapped_origin, &trip.destination)
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
            track_waiting_terminal_boundaries(next, state, trip, max_average_wait);
            return;
        }
        match seconds_to_next_walk_boundary(&trip.position, &leg.to) {
            Some(seconds) => {
                track_next_boundary(next, state.time + seconds, state.time);
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
    max_average_wait: Option<f64>,
) {
    // Break at the average-wait loss threshold so a coarse substep doesn't span
    // from below the active average-wait threshold all the way to patience
    // expiry without sampling the metric. The shared elapsed-wait helper
    // determines each trip's current wait; the threshold is crossed after
    // `patience_remaining - (WAIT_PATIENCE_SECONDS - max_average_wait)` more
    // seconds. A tiny `EPSILON` offset lands the sample strictly above the
    // threshold because the loss gate uses `>` not `>=`.
    if let Some(max_average_wait) = max_average_wait {
        let seconds_to_threshold =
            trip.patience_remaining - (WAIT_PATIENCE_SECONDS - max_average_wait);
        if seconds_to_threshold > EPSILON {
            track_next_boundary(
                next,
                state.time + seconds_to_threshold + EPSILON,
                state.time,
            );
        } else if seconds_to_threshold >= -EPSILON {
            // As with the aggregate tracker, advance once beyond equality and
            // then fall out of the epsilon band to avoid a zero-progress loop.
            track_next_boundary(next, state.time + 2.0 * EPSILON, state.time);
        }
    }

    if trip.patience_remaining > EPSILON {
        track_next_boundary(next, state.time + trip.patience_remaining, state.time);
    }

    let deadline_timeout = trip.deadline + DEADLINE_GRACE_SECONDS;
    if deadline_timeout > state.time {
        track_next_boundary(next, deadline_timeout, state.time);
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

fn track_next_boundary(next: &mut Option<f64>, candidate: f64, state_time: f64) {
    // A candidate at or before `state_time` is already due and was (or should
    // have been) processed during current-time pre-processing (growth waves,
    // commute spawning). Reject it so the substep doesn't revisit the current
    // instant.
    if candidate <= state_time {
        return;
    }
    // A candidate in `(state_time, state_time + EPSILON]` is not yet due (the
    // pre-processing checks `trigger_time <= state.time`) but would be
    // discarded by a strict `> after` filter — lost between the current-time
    // pre-processing and the next-boundary schedule. Promote it to a strictly
    // forward sample so the substep machinery breaks here, applies the event,
    // and re-evaluates objectives at a deterministic timestamp regardless of
    // tick granularity. Without this, a survival objective or growth wave at
    // `state.time + EPSILON/2` is skipped until the next unrelated boundary,
    // and coarse vs fine ticks terminate at different timestamps.
    let after = state_time + EPSILON;
    let sample = if candidate <= after {
        after + EPSILON
    } else {
        candidate
    };

    if next.as_ref().map_or(true, |current| sample < *current) {
        *next = Some(sample);
    }
}

/// Plan one due commute trip: compare the non-car route plan against the
/// private-car candidate, then build the trip in the chosen mode. A chosen car
/// is registered into `road_flow` immediately so same-time sims plan against
/// it. When the non-car plan wins, it is stored on the trip (with the status
/// and leg index it implies) so `tick_trip` and boundary tracking reuse it
/// instead of re-planning the same origin/destination.
#[allow(clippy::too_many_arguments)]
fn build_commute_trip(
    state: &mut GameSnapshot,
    road_topology: &RoadTopology,
    road_flow: &mut traffic::RoadFlow,
    sim_id: &str,
    purpose: TripPurpose,
    origin: Point,
    destination: Point,
    scheduled_time: f64,
) -> ActiveTrip {
    let non_car_plan = router::find_route_plan(state, road_flow, &origin, &destination);
    let chosen_car = private_car_trip_if_faster(
        non_car_plan.as_ref(),
        traffic::private_car_candidate(state, road_topology, road_flow, origin, destination),
        state.time,
    );
    let mut trip = build_trip(
        state,
        sim_id,
        purpose,
        origin,
        destination,
        origin.into(),
        scheduled_time,
    );
    if let Some(car) = chosen_car {
        traffic::add_car_path_to_flow(road_flow, &car.path);
        trip.status = TripStatus::Driving;
        trip.private_car_trip = Some(car);
    } else if let Some(plan) = non_car_plan.filter(|plan| !plan.legs.is_empty()) {
        // An empty-leg plan would leave the trip Arrived before any tick
        // scores it; leave planless trips to `tick_trip`'s own handling.
        trip.status = status_after_leg(&plan, 0);
        trip.route_plan = Some(plan);
    }
    trip
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
        current_leg_wait_seconds: 0.0,
        private_car_trip: None,
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
    flow: &traffic::RoadFlow,
    trip: &ActiveTrip,
    delta_seconds: f64,
    tick_start_time: f64,
) -> TripTickResult {
    if is_terminal_status(trip.status) {
        return unchanged(trip);
    }

    if trip.status == TripStatus::Driving {
        let Some(car) = trip.private_car_trip.as_ref() else {
            let unserved = mark_unserved(trip.clone());
            return TripTickResult {
                trip: unserved,
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

        if state.time + EPSILON < car.arrival_time {
            return unchanged(trip);
        }

        let mut arrived = trip.clone();
        arrived.position = arrived.destination.into();
        return score_arrival(arrived, state.time);
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
        next_trip.current_leg_wait_seconds = 0.0;
        route_plan = None;
    }

    if route_plan.is_none() {
        let snapped_origin = snap_position_to_point(&next_trip.position);
        let Some(planned_route) = plan_route(state, flow, &snapped_origin, &next_trip.destination)
        else {
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
        next_trip.current_leg_wait_seconds = 0.0;
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
        next_trip.current_leg_wait_seconds = 0.0;
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
            next_trip.current_leg_wait_seconds = 0.0;
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
    let wait_seconds = terminal_wait_seconds.unwrap_or(delta_seconds);
    next_trip.status = TripStatus::Waiting;
    next_trip.patience_remaining = (next_trip.patience_remaining - wait_seconds).max(0.0);
    next_trip.current_leg_wait_seconds =
        (next_trip.current_leg_wait_seconds + wait_seconds).max(0.0);

    if terminal_wait_seconds.is_some() {
        let outcome_wait_seconds = elapsed_wait_seconds(&next_trip);
        return TripTickResult {
            trip: mark_unserved(next_trip),
            completed_trips: 0,
            late_trips: 0,
            unserved_trips: 1,
            wait_seconds,
            outcome: Some(trip_outcome(
                TripOutcomeKind::Unserved,
                outcome_wait_seconds,
                tick_start_time + wait_seconds,
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
    trip.private_car_trip = None;
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
    trip.private_car_trip = None;
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
        .map(elapsed_wait_seconds)
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

#[allow(dead_code)]
pub(crate) fn plan_used_transit(route_plan: &RoutePlan) -> bool {
    !is_walking_only(route_plan)
}

fn is_trip_on_vehicle(state: &GameSnapshot, trip_id: &str) -> bool {
    state
        .transit
        .vehicles
        .iter()
        .any(|vehicle| vehicle.passenger_ids.iter().any(|id| id == trip_id))
}

fn has_valid_workplace_destination(state: &GameSnapshot, sim: &Sim) -> bool {
    let Some(workplace) = sim.workplace.as_ref() else {
        return false;
    };

    crate::buildings::workplace_points(state)
        .iter()
        .any(|destination| destination == workplace)
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
    use crate::model::{
        ActiveTrip, GrowthAction, GrowthWave, MaxAverageWaitSeconds, MaxLateRatio,
        MaxUnservedRatio, MetricsState, ObjectiveThresholds, Point, PrivateCarTrip,
        RollingWindowSeconds, SurvivalTimeSeconds, TransitPath, TripOutcome, TripOutcomeKind,
        TripPosition, TripPurpose, TripStatus,
    };
    use crate::road_topology::RoadTopology;
    use crate::scenario::{growing_suburb_campaign, growing_suburb_growth_waves};
    use crate::state::create_initial_snapshot;

    /// Build a campaign snapshot with custom objectives, paused=false, speed=1.
    fn campaign_snapshot(
        objectives: ObjectiveThresholds,
        growth_waves: Vec<GrowthWave>,
    ) -> GameSnapshot {
        let mut state = create_initial_snapshot();
        let (rules, scenario) = growing_suburb_campaign(objectives, growth_waves);
        state.rules = rules;
        state.scenario = scenario;
        state.paused = false;
        state
    }

    /// Custom objectives with the given rolling window and survival time.
    fn objectives_with(rolling_window: f64, survival_time: f64) -> ObjectiveThresholds {
        ObjectiveThresholds {
            max_late_ratio: MaxLateRatio::new(0.25).expect("valid MaxLateRatio"),
            max_unserved_ratio: MaxUnservedRatio::new(0.20).expect("valid MaxUnservedRatio"),
            max_average_wait: MaxAverageWaitSeconds::new(180.0)
                .expect("valid MaxAverageWaitSeconds"),
            rolling_window_seconds: RollingWindowSeconds::new(rolling_window)
                .expect("valid RollingWindowSeconds"),
            survival_time: SurvivalTimeSeconds::new(survival_time)
                .expect("valid SurvivalTimeSeconds"),
        }
    }

    fn tick_for_test(
        state: &GameSnapshot,
        topology: &RoadTopology,
        delta_seconds: f64,
    ) -> GameSnapshot {
        super::tick_trips(state, topology, delta_seconds)
    }

    fn tick_with_objectives_for_test(
        state: &GameSnapshot,
        topology: &RoadTopology,
        delta_seconds: f64,
    ) -> GameSnapshot {
        super::tick_trips_with_objectives(state, topology, delta_seconds)
    }

    fn trip_with_private_car_payload() -> ActiveTrip {
        ActiveTrip {
            id: "trip-driving".to_string(),
            sim_id: "sim-driving".to_string(),
            purpose: TripPurpose::CommuteOutbound,
            origin: Point { x: 1, y: 1 },
            destination: Point { x: 2, y: 1 },
            position: TripPosition { x: 1.0, y: 1.0 },
            status: TripStatus::Driving,
            deadline: 200.0,
            route_plan: None,
            current_leg_index: 0,
            patience_remaining: 240.0,
            current_leg_wait_seconds: 0.0,
            private_car_trip: Some(PrivateCarTrip {
                path: TransitPath::Road {
                    steps: Vec::new(),
                    total_travel_seconds: 0.0,
                },
                arrival_time: 101.25,
            }),
        }
    }

    #[test]
    fn elapsed_wait_seconds_uses_shared_patience_authority() {
        let mut trip = trip_with_private_car_payload();
        trip.patience_remaining = WAIT_PATIENCE_SECONDS - 90.0;
        assert_eq!(elapsed_wait_seconds(&trip), 90.0);

        trip.patience_remaining = WAIT_PATIENCE_SECONDS;
        assert_eq!(elapsed_wait_seconds(&trip), 0.0);
    }

    #[test]
    fn current_leg_wait_seconds_is_independent_of_trip_wide_patience() {
        let mut trip = trip_with_private_car_payload();
        // Trip-wide patience consumed 130 s, but only 1 s waited on the current
        // leg (e.g. after transferring from a previous line).
        trip.patience_remaining = WAIT_PATIENCE_SECONDS - 130.0;
        trip.current_leg_wait_seconds = 1.0;
        assert_eq!(current_leg_wait_seconds(&trip), 1.0);
        assert_eq!(elapsed_wait_seconds(&trip), 130.0);

        trip.current_leg_wait_seconds = 0.0;
        assert_eq!(current_leg_wait_seconds(&trip), 0.0);
    }

    #[test]
    fn score_arrival_clears_private_car_payload() {
        let result = score_arrival(trip_with_private_car_payload(), 101.0);

        assert_eq!(result.trip.status, TripStatus::Arrived);
        assert!(result.trip.private_car_trip.is_none());
    }

    #[test]
    fn mark_unserved_clears_private_car_payload() {
        let trip = mark_unserved(trip_with_private_car_payload());

        assert_eq!(trip.status, TripStatus::Unserved);
        assert!(trip.private_car_trip.is_none());
    }

    #[test]
    fn equal_private_car_eta_keeps_the_non_car_plan() {
        let non_car_plan = RoutePlan {
            legs: Vec::new(),
            estimated_seconds: 10.0,
        };
        let car = crate::traffic::PrivateCarCandidate {
            path: TransitPath::Road {
                steps: Vec::new(),
                total_travel_seconds: 10.0,
            },
            estimated_seconds: 10.0,
        };

        assert!(private_car_trip_if_faster(Some(&non_car_plan), Some(car), 100.0).is_none());
    }

    #[test]
    fn strict_car_choice_switches_when_non_car_eta_becomes_slower() {
        let free_flow_non_car_plan = RoutePlan {
            legs: Vec::new(),
            estimated_seconds: 100.0,
        };
        let congested_non_car_plan = RoutePlan {
            legs: Vec::new(),
            estimated_seconds: 110.0,
        };
        let car = crate::traffic::PrivateCarCandidate {
            path: TransitPath::Road {
                steps: Vec::new(),
                total_travel_seconds: 0.0,
            },
            estimated_seconds: 105.0,
        };

        assert!(private_car_trip_if_faster(
            Some(&free_flow_non_car_plan),
            Some(car.clone()),
            100.0
        )
        .is_none());
        assert!(
            private_car_trip_if_faster(Some(&congested_non_car_plan), Some(car), 100.0).is_some()
        );
    }

    #[test]
    fn sandbox_mid_tick_growth_wave_does_not_schedule_or_apply_growth() {
        let mut sandbox_with_wave = create_initial_snapshot();
        sandbox_with_wave.paused = false;
        let mut waves = growing_suburb_growth_waves();
        waves[0].trigger_time = 120.0;
        sandbox_with_wave.scenario.growth_waves = waves;

        let mut sandbox_without_wave = create_initial_snapshot();
        sandbox_without_wave.paused = false;
        let flow = traffic::RoadFlow::new();

        assert_eq!(
            next_boundary_after(&sandbox_with_wave, &flow),
            next_boundary_after(&sandbox_without_wave, &flow),
            "sandbox waves do not create tick boundaries"
        );
        assert_eq!(
            max_tick_substeps(&sandbox_with_wave, 300.0),
            max_tick_substeps(&sandbox_without_wave, 300.0),
            "sandbox waves do not consume the substep budget"
        );

        let topology =
            RoadTopology::compile(&sandbox_with_wave.map).expect("fixture topology compiles");
        let next = tick_for_test(&sandbox_with_wave, &topology, 300.0);
        let baseline = tick_for_test(&sandbox_without_wave, &topology, 300.0);

        assert_eq!(next.time, baseline.time, "sandbox tick timing is unchanged");
        assert_eq!(next.buildings, baseline.buildings);
        assert_eq!(next.sims, baseline.sims);
        assert!(!next.scenario.growth_waves[0].applied);
    }

    /// Regression test for Finding 1: when `state.time` is exactly at the first
    /// outcome's expiry time, the expiry boundary must still be tracked so a
    /// coarse tick samples the loss gate there. With a single `EPSILON` offset,
    /// the candidate equals `after = state.time + EPSILON` and is discarded,
    /// causing the tick to skip to the next expiry where both outcome groups are
    /// pruned together — missing the loss that fine ticks detect.
    #[test]
    fn outcome_expiry_boundary_at_exact_start_time_is_sampled() {
        let objectives = objectives_with(10.0, 1200.0);
        let mut state = campaign_snapshot(objectives, Vec::new());
        state.time = 10.0;
        state.day = clock::day_index(state.time);
        state.clock_minutes = clock::clock_minutes(state.time);

        // 40 Arrived outcomes at t=0 (expire at t=10), 10 Unserved at t=5
        // (expire at t=15). At t=10 the 40 arrivals fall out of the window,
        // leaving 10 unserved out of 10 total → ratio 1.0 > 0.2 → loss.
        state.metrics.completed_trips = 40;
        state.metrics.unserved_trips = 10;
        state.metrics.trip_outcomes = (0..40)
            .map(|_| TripOutcome {
                outcome: TripOutcomeKind::Arrived,
                wait_seconds: 0.0,
                time: 0.0,
            })
            .chain((0..10).map(|_| TripOutcome {
                outcome: TripOutcomeKind::Unserved,
                wait_seconds: 0.0,
                time: 5.0,
            }))
            .collect();

        // Coarse tick from t=10 to t=20 — spans past the unserved expiry at t=15.
        let topology = RoadTopology::compile(&state.map).expect("fixture topology compiles");
        let next = tick_with_objectives_for_test(&state, &topology, 10.0);

        assert_eq!(
            next.metrics.state,
            MetricsState::Lost,
            "coarse tick starting at exact expiry must detect the loss"
        );
    }

    /// Regression test for Finding 2: a growth wave whose `trigger_time` equals
    /// the survival win time must be applied before the terminal snapshot is
    /// returned. Without post-substep growth application, `on_substep` terminates
    /// the loop at the win boundary, and the wave remains permanently unapplied.
    #[test]
    fn growth_wave_at_survival_time_is_applied_before_termination() {
        let objectives = objectives_with(300.0, 100.0);
        let wave = GrowthWave {
            id: "wave-at-win".to_string(),
            trigger_time: 100.0,
            message: String::new(),
            applied: false,
            actions: vec![
                GrowthAction::PaintAreaRectangle {
                    area: "residential".to_string(),
                    start: Point { x: 2, y: 3 },
                    end: Point { x: 3, y: 3 },
                },
                GrowthAction::PlaceBuilding {
                    building_type: "smallHouse".to_string(),
                    origin: Point { x: 2, y: 3 },
                    rotation: 0,
                },
            ],
        };
        let mut state = campaign_snapshot(objectives, vec![wave]);
        state.time = 99.0;
        state.day = clock::day_index(state.time);
        state.clock_minutes = clock::clock_minutes(state.time);
        state.metrics.completed_trips = 1;

        let topology = RoadTopology::compile(&state.map).expect("fixture topology compiles");
        let next = tick_with_objectives_for_test(&state, &topology, 2.0);

        assert_eq!(
            next.metrics.state,
            MetricsState::Won,
            "campaign wins at survival time"
        );
        assert!(
            next.scenario.growth_waves[0].applied,
            "growth wave at survival time must be applied before termination"
        );
    }

    /// Regression test for Finding 3: a loaded campaign whose `state.time` is
    /// already past `survivalTime` with completed trips must be detected as won
    /// at the current timestamp, without advancing to the next boundary. Without
    /// pre-loop objective evaluation, a 1s tick and a 300s tick would produce
    /// different terminal timestamps.
    #[test]
    fn already_satisfied_survival_objective_detected_at_current_time() {
        let objectives = objectives_with(300.0, 100.0);
        let mut state = campaign_snapshot(objectives, Vec::new());
        state.time = 100.0;
        state.day = clock::day_index(state.time);
        state.clock_minutes = clock::clock_minutes(state.time);
        state.metrics.completed_trips = 1;

        let topology = RoadTopology::compile(&state.map).expect("fixture topology compiles");
        let next = tick_with_objectives_for_test(&state, &topology, 1.0);

        assert_eq!(
            next.metrics.state,
            MetricsState::Won,
            "already-satisfied survival objective detected without advancing"
        );
        assert_eq!(
            next.time, 100.0,
            "terminal timestamp is the current time, not the next boundary"
        );
    }

    /// Regression test for the near-current boundary gap: when `state.time` is
    /// within `EPSILON` below a survival boundary, the boundary falls in
    /// `(state.time, state.time + EPSILON]`. It is not yet due during
    /// current-time pre-processing (`survivalTime > state.time`) but was also
    /// discarded by the old `> after` filter in `next_boundary_after` — lost
    /// until the next unrelated boundary. A 1s tick and a 300s tick would then
    /// terminate at different timestamps, breaking granularity independence.
    /// `track_next_boundary` now promotes such candidates to
    /// `state.time + 2 * EPSILON` so both granularities fire at the same
    /// promoted boundary.
    #[test]
    fn survival_boundary_in_epsilon_gap_fires_deterministically_across_granularities() {
        let survival_time = 100.0;
        let objectives = objectives_with(300.0, survival_time);
        let mut state = campaign_snapshot(objectives, Vec::new());
        // Land `state.time` halfway into the epsilon gap below the boundary.
        state.time = survival_time - EPSILON / 2.0;
        state.day = clock::day_index(state.time);
        state.clock_minutes = clock::clock_minutes(state.time);
        state.metrics.completed_trips = 1;

        // Coarse: one 300s tick spanning well past the survival boundary.
        let topology = RoadTopology::compile(&state.map).expect("fixture topology compiles");
        let coarse = tick_with_objectives_for_test(&state, &topology, 300.0);

        // Fine: 300 × 1s ticks; the survival boundary fires inside the first.
        let mut fine = state.clone();
        for _ in 0..300 {
            if fine.metrics.state != MetricsState::Running {
                break;
            }
            fine = tick_with_objectives_for_test(&fine, &topology, 1.0);
        }

        assert_eq!(
            coarse.metrics.state,
            MetricsState::Won,
            "coarse tick detects the survival win"
        );
        assert_eq!(
            fine.metrics.state,
            MetricsState::Won,
            "fine ticks detect the survival win"
        );
        assert_eq!(
            coarse.time, fine.time,
            "coarse and fine terminate at the same promoted boundary timestamp"
        );
    }

    /// Regression test for the near-current boundary gap on growth waves: a
    /// wave whose `trigger_time` falls in `(state.time, state.time + EPSILON]`
    /// must still fire at a deterministic substep boundary regardless of tick
    /// granularity. Without the promotion in `track_next_boundary`, the wave
    /// was discarded by the `<= after` filter and only applied at the
    /// post-loop cleanup — at different timestamps for coarse vs fine ticks.
    /// By aligning the wave's `trigger_time` with the survival win time, the
    /// terminal timestamp becomes the observable: coarse and fine must both
    /// terminate at the same promoted boundary with the wave applied.
    #[test]
    fn growth_wave_in_epsilon_gap_fires_deterministically_across_granularities() {
        let trigger_time = 120.0;
        let mut seed_waves = growing_suburb_growth_waves();
        seed_waves[0].trigger_time = trigger_time;

        // Survival win coincides with the wave so the terminal timestamp
        // observes whether the wave boundary was tracked or lost.
        let objectives = objectives_with(300.0, trigger_time);
        let mut state = campaign_snapshot(objectives, seed_waves);
        // Land `state.time` halfway into the epsilon gap below the trigger.
        state.time = trigger_time - EPSILON / 2.0;
        state.day = clock::day_index(state.time);
        state.clock_minutes = clock::clock_minutes(state.time);
        state.metrics.completed_trips = 1;

        // Coarse: one 300s tick spanning past the trigger.
        let topology = RoadTopology::compile(&state.map).expect("fixture topology compiles");
        let coarse = tick_with_objectives_for_test(&state, &topology, 300.0);

        // Fine: 300 × 1s ticks; the wave fires inside the first.
        let mut fine = state.clone();
        for _ in 0..300 {
            if fine.metrics.state != MetricsState::Running {
                break;
            }
            fine = tick_with_objectives_for_test(&fine, &topology, 1.0);
        }

        assert!(
            coarse.scenario.growth_waves[0].applied,
            "coarse tick applied the epsilon-gap wave"
        );
        assert!(
            fine.scenario.growth_waves[0].applied,
            "fine ticks applied the epsilon-gap wave"
        );
        assert_eq!(
            coarse.metrics.state,
            MetricsState::Won,
            "coarse tick detects the win at the wave/survival boundary"
        );
        assert_eq!(
            fine.metrics.state,
            MetricsState::Won,
            "fine ticks detect the win at the wave/survival boundary"
        );
        assert_eq!(coarse.buildings, fine.buildings, "buildings match");
        assert_eq!(coarse.sims, fine.sims, "spawned sims match");
        assert_eq!(coarse.map, fine.map, "map/zoning match");
        assert_eq!(
            coarse.time, fine.time,
            "both terminate at the same promoted boundary timestamp"
        );
    }
}
