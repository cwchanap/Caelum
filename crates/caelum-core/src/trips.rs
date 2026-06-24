use crate::clock::{self, GAME_DAY_SECONDS, MINUTES_PER_DAY};
use crate::commute::{departure_minute_for_sim, trip_deadline_seconds};
use crate::model::{ActiveTrip, GameSnapshot, Metrics, Point, RoutePlan, Sim, TripPosition};
use crate::router;
use crate::transit;

const WALK_SECONDS_PER_TILE: f64 = 20.0;
const WAIT_PATIENCE_SECONDS: f64 = 240.0;
const DEADLINE_GRACE_SECONDS: f64 = 300.0;
const EPSILON: f64 = 0.000_001;

struct TripTickResult {
    trip: ActiveTrip,
    completed_trips: u32,
    late_trips: u32,
    unserved_trips: u32,
    wait_seconds: f64,
}

pub fn tick_trips(state: &GameSnapshot, delta_seconds: f64) -> GameSnapshot {
    if state.paused || state.metrics.state != "running" || state.speed == 0 {
        return state.clone();
    }

    let scaled_delta = clock::scaled_delta(delta_seconds, state.speed);
    let mut next = state.clone();
    let final_time = next.time + scaled_delta;
    sync_clock(&mut next);

    for _ in 0..max_tick_substeps(&next, final_time) {
        if final_time - next.time <= EPSILON {
            break;
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
    }

    reset_daily_commute_flags(&mut next);
    spawn_due_commute_trips(&mut next);
    next
}

fn max_tick_substeps(state: &GameSnapshot, final_time: f64) -> usize {
    let start_day = clock::day_index(state.time);
    let end_day = clock::day_index(final_time);
    let day_count = end_day.saturating_sub(start_day) as usize + 1;
    let events_per_day = state.sims.len().saturating_mul(6).saturating_add(2);
    day_count.saturating_mul(events_per_day).saturating_add(1)
}

fn advance_tick_substep(state: &GameSnapshot, delta_seconds: f64) -> GameSnapshot {
    let mut next = state.clone();
    next.time += delta_seconds;
    sync_clock(&mut next);
    reset_daily_commute_flags(&mut next);

    let vehicle_state = transit::tick_vehicles(&next, delta_seconds);
    advance_active_trips(&vehicle_state, delta_seconds)
}

fn sync_clock(state: &mut GameSnapshot) {
    state.day = clock::day_index(state.time);
    state.clock_minutes = clock::clock_minutes(state.time);
}

pub fn advance_active_trips(state: &GameSnapshot, delta_seconds: f64) -> GameSnapshot {
    let mut results = Vec::with_capacity(state.active_trips.len());

    for trip in &state.active_trips {
        results.push(tick_trip(state, trip, delta_seconds));
    }

    let completed_trips = results.iter().map(|result| result.completed_trips).sum();
    let late_trips = results.iter().map(|result| result.late_trips).sum();
    let unserved_trips = results.iter().map(|result| result.unserved_trips).sum();
    let wait_seconds = results.iter().map(|result| result.wait_seconds).sum();

    let mut next = state.clone();
    next.active_trips = Vec::with_capacity(results.len());
    for result in results {
        if result.completed_trips > 0 {
            apply_arrival_to_sim(&mut next, &result.trip);
        }
        next.active_trips.push(result.trip);
    }

    next.metrics = update_metrics(
        &state.metrics,
        &next.active_trips,
        completed_trips,
        late_trips,
        unserved_trips,
        wait_seconds,
    );
    next
}

fn reset_daily_commute_flags(state: &mut GameSnapshot) {
    for sim in &mut state.sims {
        if sim.commute_day != state.day {
            sim.commute_day = state.day;
            sim.outbound_arrived_today = false;
        }
    }
}

fn spawn_due_commute_trips(state: &mut GameSnapshot) {
    let sims = state.sims.clone();

    for sim in sims {
        if sim.worker_profile != "worker" {
            continue;
        }
        let Some(template) = sim.shift_template.as_deref() else {
            continue;
        };

        if !sim.outbound_arrived_today && has_valid_workplace_destination(state, &sim) {
            let workplace = sim
                .workplace
                .clone()
                .expect("valid workplace destination requires a workplace");
            let departure = departure_minute_for_sim(&sim.id, template, "outbound");
            let scheduled_time = scheduled_time_seconds(state.day, departure);
            if state.time + EPSILON >= scheduled_time
                && !has_trip_for_sim_day(state, &sim.id, "commuteOutbound", state.day)
            {
                let trip = build_trip(
                    state,
                    &sim.id,
                    "commuteOutbound",
                    sim.home.clone(),
                    workplace,
                    sim.position.clone().into(),
                    scheduled_time,
                );
                state.active_trips.push(trip);
            }
        }

        if !sim.outbound_arrived_today {
            continue;
        }
        let return_departure = departure_minute_for_sim(&sim.id, template, "return");
        let scheduled_time = scheduled_time_seconds(state.day, return_departure);
        if state.time + EPSILON >= scheduled_time
            && !has_trip_for_sim_day(state, &sim.id, "commuteReturn", state.day)
        {
            let trip = build_trip(
                state,
                &sim.id,
                "commuteReturn",
                sim.position.clone(),
                sim.home.clone(),
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
    let next_day_boundary = (f64::from(state.day) + 1.0) * GAME_DAY_SECONDS;
    if next_day_boundary > after {
        next = Some(next_day_boundary);
    }

    for sim in &state.sims {
        if sim.worker_profile != "worker" {
            continue;
        }
        let Some(template) = sim.shift_template.as_deref() else {
            continue;
        };

        if !sim.outbound_arrived_today
            && has_valid_workplace_destination(state, sim)
            && !has_trip_for_sim_day(state, &sim.id, "commuteOutbound", state.day)
        {
            let departure = departure_minute_for_sim(&sim.id, template, "outbound");
            track_next_boundary(
                &mut next,
                scheduled_time_seconds(state.day, departure),
                after,
            );
        }

        if !has_trip_for_sim_day(state, &sim.id, "commuteReturn", state.day) {
            let return_departure = departure_minute_for_sim(&sim.id, template, "return");
            track_next_boundary(
                &mut next,
                scheduled_time_seconds(state.day, return_departure),
                after,
            );
        }
    }

    for trip in &state.active_trips {
        track_active_trip_boundary(&mut next, state, trip, after);
    }

    next
}

fn track_active_trip_boundary(
    next: &mut Option<f64>,
    state: &GameSnapshot,
    trip: &ActiveTrip,
    after: f64,
) {
    if matches!(trip.status.as_str(), "arrived" | "late" | "unserved")
        || is_home_fallback_trip(state, trip)
        || (trip.status == "riding" && is_trip_on_vehicle(state, &trip.id))
    {
        return;
    }

    let route_plan = if trip.route_plan.is_none() || trip.status == "riding" {
        let snapped_origin = snap_position_to_point(&trip.position);
        router::find_route_plan(state, &snapped_origin, &trip.destination)
    } else {
        trip.route_plan.clone()
    };
    let Some(route_plan) = route_plan else {
        return;
    };

    let current_leg_index = if trip.route_plan.is_none() || trip.status == "riding" {
        0
    } else {
        trip.current_leg_index
    };
    let Some(leg) = route_plan.legs.get(current_leg_index) else {
        return;
    };
    if leg.mode != "walk" {
        return;
    }

    let Some(seconds) = seconds_to_next_walk_boundary(&trip.position, &leg.to) else {
        return;
    };
    track_next_boundary(next, state.time + seconds, after);
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

    if next.is_none_or(|current| candidate < current) {
        *next = Some(candidate);
    }
}

fn build_trip(
    state: &GameSnapshot,
    sim_id: &str,
    purpose: &str,
    origin: Point,
    destination: Point,
    position: TripPosition,
    scheduled_time: f64,
) -> ActiveTrip {
    ActiveTrip {
        id: next_trip_id_for_day(state, state.day),
        sim_id: sim_id.to_string(),
        purpose: purpose.to_string(),
        origin,
        destination,
        position,
        status: "idle".to_string(),
        deadline: trip_deadline_seconds(scheduled_time),
        route_plan: None,
        current_leg_index: 0,
        patience_remaining: WAIT_PATIENCE_SECONDS,
    }
}

fn next_trip_id_for_day(state: &GameSnapshot, day: u32) -> String {
    let prefix = format!("trip-day-{day}-trip-");
    let next_number = state
        .active_trips
        .iter()
        .filter(|trip| trip.id.starts_with(&prefix))
        .count()
        + 1;
    format!("{prefix}{next_number:03}")
}

fn has_trip_for_sim_day(state: &GameSnapshot, sim_id: &str, purpose: &str, day: u32) -> bool {
    let prefix = format!("trip-day-{day}-trip-");
    state.active_trips.iter().any(|trip| {
        trip.id.starts_with(&prefix) && trip.sim_id == sim_id && trip.purpose == purpose
    })
}

fn scheduled_time_seconds(day: u32, minute: u16) -> f64 {
    f64::from(day) * GAME_DAY_SECONDS
        + (f64::from(minute) / f64::from(MINUTES_PER_DAY)) * GAME_DAY_SECONDS
}

fn tick_trip(state: &GameSnapshot, trip: &ActiveTrip, delta_seconds: f64) -> TripTickResult {
    if matches!(trip.status.as_str(), "arrived" | "late" | "unserved")
        || is_home_fallback_trip(state, trip)
    {
        return unchanged(trip);
    }

    if trip.status == "riding" && is_trip_on_vehicle(state, &trip.id) {
        return unchanged(trip);
    }

    let mut next_trip = trip.clone();
    let mut route_plan = next_trip.route_plan.clone();

    if next_trip.status == "riding" {
        next_trip.status = "idle".to_string();
        next_trip.route_plan = None;
        next_trip.current_leg_index = 0;
        route_plan = None;
    }

    if route_plan.is_none() {
        let snapped_origin = snap_position_to_point(&next_trip.position);
        let Some(planned_route) =
            router::find_route_plan(state, &snapped_origin, &next_trip.destination)
        else {
            return TripTickResult {
                trip: mark_unserved(next_trip),
                completed_trips: 0,
                late_trips: 0,
                unserved_trips: 1,
                wait_seconds: 0.0,
            };
        };

        next_trip.route_plan = Some(planned_route.clone());
        next_trip.current_leg_index = 0;
        next_trip.status = status_after_leg(&planned_route, 0).to_string();
        route_plan = Some(planned_route);
    }

    let route_plan = route_plan.expect("route plan is set after planning");
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
        };
    }

    let Some(leg) = route_plan.legs.get(next_trip.current_leg_index) else {
        return score_arrival(next_trip, state.time);
    };

    if leg.mode == "walk" {
        next_trip.position = move_toward(
            &next_trip.position,
            &leg.to,
            (delta_seconds / WALK_SECONDS_PER_TILE).max(0.0),
        );
        if same_position_and_point(&next_trip.position, &leg.to) {
            next_trip.current_leg_index += 1;
            next_trip.status =
                status_after_leg(&route_plan, next_trip.current_leg_index).to_string();
        } else {
            next_trip.status = "walking".to_string();
        }

        if next_trip.status == "arrived" {
            return score_arrival(next_trip, state.time);
        }

        return TripTickResult {
            trip: next_trip,
            completed_trips: 0,
            late_trips: 0,
            unserved_trips: 0,
            wait_seconds: 0.0,
        };
    }

    next_trip.status = "waiting".to_string();
    next_trip.patience_remaining = (next_trip.patience_remaining - delta_seconds).max(0.0);

    if next_trip.patience_remaining <= 0.0
        || state.time > next_trip.deadline + DEADLINE_GRACE_SECONDS
    {
        return TripTickResult {
            trip: mark_unserved(next_trip),
            completed_trips: 0,
            late_trips: 0,
            unserved_trips: 1,
            wait_seconds: delta_seconds,
        };
    }

    TripTickResult {
        trip: next_trip,
        completed_trips: 0,
        late_trips: 0,
        unserved_trips: 0,
        wait_seconds: delta_seconds,
    }
}

fn unchanged(trip: &ActiveTrip) -> TripTickResult {
    TripTickResult {
        trip: trip.clone(),
        completed_trips: 0,
        late_trips: 0,
        unserved_trips: 0,
        wait_seconds: 0.0,
    }
}

fn score_arrival(mut trip: ActiveTrip, time: f64) -> TripTickResult {
    let late = time > trip.deadline;
    trip.status = if late { "late" } else { "arrived" }.to_string();
    TripTickResult {
        trip,
        completed_trips: 1,
        late_trips: u32::from(late),
        unserved_trips: 0,
        wait_seconds: 0.0,
    }
}

fn mark_unserved(mut trip: ActiveTrip) -> ActiveTrip {
    trip.status = "unserved".to_string();
    trip.patience_remaining = trip.patience_remaining.max(0.0);
    trip
}

fn update_metrics(
    metrics: &Metrics,
    trips: &[ActiveTrip],
    completed_trips: u32,
    late_trips: u32,
    unserved_trips: u32,
    wait_seconds: f64,
) -> Metrics {
    let total_wait_seconds = metrics.total_wait_seconds + wait_seconds;
    let waiting_trip_count = trips.iter().filter(|trip| trip.status == "waiting").count() as u32;
    let current_wait_seconds: f64 = trips
        .iter()
        .filter(|trip| trip.status == "waiting")
        .map(|trip| (WAIT_PATIENCE_SECONDS - trip.patience_remaining).max(0.0))
        .sum();

    Metrics {
        late_trips: metrics.late_trips + late_trips,
        completed_trips: metrics.completed_trips + completed_trips,
        unserved_trips: metrics.unserved_trips + unserved_trips,
        total_wait_seconds,
        waiting_trip_count,
        average_wait_seconds: if waiting_trip_count > 0 {
            current_wait_seconds / f64::from(waiting_trip_count)
        } else {
            0.0
        },
        state: metrics.state.clone(),
        loss_reason: metrics.loss_reason.clone(),
    }
}

fn apply_arrival_to_sim(state: &mut GameSnapshot, trip: &ActiveTrip) {
    let Some(sim) = state.sims.iter_mut().find(|sim| sim.id == trip.sim_id) else {
        return;
    };

    match trip.purpose.as_str() {
        "commuteOutbound" => {
            sim.position = trip.destination.clone();
            if trip_service_day(trip).is_some_and(|day| day == state.day) {
                sim.outbound_arrived_today = true;
            }
        }
        "commuteReturn" => {
            sim.position = sim.home.clone();
        }
        _ => {}
    }
}

fn trip_service_day(trip: &ActiveTrip) -> Option<u32> {
    let id = trip.id.strip_prefix("trip-day-")?;
    let (day, _) = id.split_once("-trip-")?;
    day.parse().ok()
}

fn status_after_leg(route_plan: &RoutePlan, next_leg_index: usize) -> &'static str {
    match route_plan.legs.get(next_leg_index) {
        None => "arrived",
        Some(leg) if leg.mode == "walk" => "walking",
        Some(_) => "waiting",
    }
}

fn is_walking_only(route_plan: &RoutePlan) -> bool {
    route_plan.legs.iter().all(|leg| leg.mode == "walk")
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

    if trip.destination != sim.home || trip.purpose == "commuteReturn" {
        return false;
    }

    if trip.purpose == "commuteOutbound" && !has_valid_workplace_destination(state, sim) {
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
