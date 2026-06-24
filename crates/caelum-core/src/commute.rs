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
