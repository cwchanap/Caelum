//! Cross-language id-format contract parity with `src/domain/ids.ts`.
//!
//! These formats MUST stay in lockstep with the TypeScript id generators so that
//! Rust snapshots can be compared against, and handed to, the existing frontend
//! state. The Growing Suburb scenario and growth-wave tiles are keyed with the
//! TypeScript `tile-${x}-${y}` format; drifting here breaks parity/integration.

use caelum_core::ids::{entity_id, next_entity_id, tile_id};

#[test]
fn tile_id_matches_typescript_contract() {
    // src/domain/ids.ts: `tile-${x}-${y}`
    assert_eq!(tile_id(0, 0), "tile-0-0");
    assert_eq!(tile_id(3, 4), "tile-3-4");
    assert_eq!(tile_id(14, 17), "tile-14-17");
    // Regression guard: the bare "x,y" form is NOT the contract.
    assert_ne!(tile_id(3, 4), "3,4");
}

#[test]
fn entity_id_matches_typescript_contract() {
    // src/domain/ids.ts: `${prefix}-${String(index).padStart(3, "0")}`
    assert_eq!(entity_id("stop", 1), "stop-001");
    assert_eq!(entity_id("route", 4), "route-004");
    assert_eq!(entity_id("sim", 10), "sim-010");
}

#[test]
fn next_entity_id_picks_max_plus_one_ignoring_other_prefixes() {
    assert_eq!(
        next_entity_id("stop", vec!["stop-001".to_string(), "stop-003".to_string()]),
        "stop-004"
    );
    assert_eq!(next_entity_id("route", Vec::<String>::new()), "route-001");
    // Ids under a different prefix must not influence the max for this prefix.
    assert_eq!(
        next_entity_id(
            "stop",
            vec!["stop-002".to_string(), "station-009".to_string()]
        ),
        "stop-003"
    );
}
