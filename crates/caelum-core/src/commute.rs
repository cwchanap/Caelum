use crate::engine::RoutingContext;
use crate::model::{GameSnapshot, Point, RoutePlan, WorkerProfile};
use crate::router;

pub fn plan_route(
    state: &GameSnapshot,
    context: RoutingContext<'_>,
    origin: &Point,
    destination: &Point,
) -> Option<RoutePlan> {
    router::plan_route(state, context, origin, destination)
}

pub fn numeric_id_suffix(id: &str) -> usize {
    id.rsplit_once('-')
        .and_then(|(_, suffix)| suffix.parse::<usize>().ok())
        .unwrap_or(1)
}

pub fn worker_profile_for_id(id: &str) -> WorkerProfile {
    if numeric_id_suffix(id) % 10 == 0 {
        WorkerProfile::NonWorker
    } else {
        WorkerProfile::Worker
    }
}

pub fn shift_template_for_id(id: &str) -> Option<&'static str> {
    let suffix = numeric_id_suffix(id);
    if suffix % 10 == 0 {
        return None;
    }

    let worker_ordinal = suffix - (suffix / 10);
    match (worker_ordinal - 1) % 10 {
        0..=6 => Some("standard"),
        7 => Some("early"),
        8 => Some("late"),
        _ => Some("offPeak"),
    }
}

pub fn departure_minute_for_sim(sim_id: &str, template: &str, direction: &str) -> u16 {
    let (start, end) = match (template, direction) {
        ("standard", "outbound") => (420, 540),
        ("standard", "return") => (1_020, 1_140),
        ("early", "outbound") => (330, 420),
        ("early", "return") => (900, 990),
        ("late", "outbound") => (600, 690),
        ("late", "return") => (1_170, 1_260),
        ("offPeak", "outbound") => (780, 870),
        ("offPeak", "return") => (1_080, 1_170),
        _ => (420, 540),
    };
    let span = end - start;
    // Take the modulo on the full `usize` suffix, then narrow. Casting to `u16` first
    // would truncate suffixes > u16::MAX before the modulo, silently shifting the jitter
    // distribution for very large sim ordinals. The modulo result is always <= span
    // (<= 120), so the final `as u16` cannot truncate.
    let jitter = (numeric_id_suffix(sim_id) % usize::from(span + 1)) as u16;
    start + jitter
}

pub fn trip_deadline_seconds(scheduled_time: f64) -> f64 {
    scheduled_time + 900.0
}
