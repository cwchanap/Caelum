pub fn tile_id(x: i32, y: i32) -> String {
    format!("{x},{y}")
}

pub fn entity_id(prefix: &str, number: usize) -> String {
    format!("{prefix}-{number:03}")
}

pub fn next_entity_id(prefix: &str, existing: impl IntoIterator<Item = String>) -> String {
    let max = existing
        .into_iter()
        .filter_map(|id| {
            id.strip_prefix(&format!("{prefix}-"))
                .and_then(|suffix| suffix.parse::<usize>().ok())
        })
        .max()
        .unwrap_or(0);
    entity_id(prefix, max + 1)
}
