pub fn numeric_id_suffix(id: &str) -> usize {
    id.rsplit_once('-')
        .and_then(|(_, suffix)| suffix.parse::<usize>().ok())
        .unwrap_or(1)
}

pub fn worker_profile_for_id(id: &str) -> &'static str {
    if numeric_id_suffix(id) % 10 == 0 {
        "nonWorker"
    } else {
        "worker"
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
    let jitter = numeric_id_suffix(sim_id) as u16 % (span + 1);
    start + jitter
}

pub fn trip_deadline_seconds(scheduled_time: f64) -> f64 {
    scheduled_time + 900.0
}
