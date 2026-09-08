//! Stable, cross-language entity id format shared with the TypeScript simulation.
//!
//! Tile ids are `"tile-{x}-{y}"`. Entity ids are `"{prefix}-{number:03}"` (zero-padded
//! to three digits), e.g. `"stop-001"`, `"route-004"`, `"sim-010"`. This exact format is
//! a contract with `src/domain/ids.ts` and the trip-id parsing in [`crate::trips`]:
//! do not change the padding or separators without updating both sides.

pub fn tile_id(x: i32, y: i32) -> String {
    format!("tile-{x}-{y}")
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

/// True iff `id` is the canonical citizen id the engine mints:
/// `sim-{ordinal:03}` (zero-padded to three digits), e.g. `sim-001`, `sim-010`,
/// `sim-1000`. The engine only ever produces this form via [`entity_id`], and
/// every `numeric_id_suffix` derivation (day-off, shift, daily seed, departure
/// jitter, the unassigned-worker ordering key) keys on the parsed ordinal — so
/// a non-canonical id (e.g. `sim-a`, `sim-1`, `legacy-001`) either parses to a
/// colliding ordinal or falls back to `1`, corrupting those derivations and
/// collapsing the unassigned-worker key. The persistence boundary rejects such
/// ids rather than accommodating them.
pub fn is_canonical_sim_id(id: &str) -> bool {
    let Some((prefix, suffix)) = id.rsplit_once('-') else {
        return false;
    };
    if prefix != "sim" {
        return false;
    }
    let Ok(ordinal) = suffix.parse::<usize>() else {
        return false;
    };
    id == entity_id("sim", ordinal)
}
