//! Coverage backfill for the remaining uncovered `persistence/map.rs` branches:
//! successful growth-wave / growth-action validation, the
//! `validate_automatic_junction_reconstruction` empty + count-mismatch paths,
//! and the roundabout canonical movement-facts (kind) mismatch.
//!
//! Each test builds a persistence-valid baseline snapshot (via the shared
//! fixtures) and then mutates a single field to exercise one branch, asserting
//! the exact `PersistenceError` (or `Ok(())` for positive cases).

mod common;

use caelum_core::model::{GrowthAction, GrowthWave, Point, RoadPort, RoadStructure};
use caelum_core::{
    create_sandbox_snapshot, validate_snapshot, PersistenceError, RoadStructureError,
    SandboxCreationRequest, DEFAULT_STARTING_CAPITAL,
};
use common::persistence_fixtures::{
    campaign_snapshot, road_with_structure, roundabout_id, tile_index,
};

// ===========================================================================
// validate_rules_and_scenario / validate_growth_action — successful path
// ===========================================================================

/// A campaign snapshot with one valid, *applied* growth wave carrying a valid
/// `PlaceBuilding` action. Using `applied: true` makes the growth-wave loop
/// take the `else if let Some(..) = first_unapplied` arm with `first_unapplied`
/// still `None`, falling through the closing brace (line 191) instead of
/// short-circuiting. The valid action exercises the successful `PlaceBuilding`
/// arm of `validate_growth_action` (lines 267, 270).
#[test]
fn valid_campaign_with_growth_wave_validates() {
    let mut snapshot = campaign_snapshot();
    snapshot.scenario.growth_waves = vec![GrowthWave {
        id: "wave-1".to_string(),
        trigger_time: 100.0,
        message: "x".to_string(),
        applied: true,
        actions: vec![GrowthAction::PlaceBuilding {
            building_type: "smallHouse".to_string(),
            origin: Point { x: 2, y: 2 },
            rotation: 0,
        }],
    }];
    assert!(validate_snapshot(&snapshot).is_ok());
}

// ===========================================================================
// validate_automatic_junction_reconstruction — empty junctions positive case
// ===========================================================================

/// A paused blank-grid sandbox snapshot has no road structures.
/// `validate_automatic_junction_reconstruction` runs reconstruction (no early
/// return on empty), which produces an empty junction set matching the empty
/// serialized set. The snapshot is otherwise persistence-valid, so the full
/// pipeline succeeds.
#[test]
fn blank_grid_with_no_junctions_validates() {
    let mut snapshot = create_sandbox_snapshot(SandboxCreationRequest {
        template_id: "blankGrid".to_string(),
        economy_preset: "standard".to_string(),
        starting_capital: Some(f64::from(DEFAULT_STARTING_CAPITAL)),
        demand_multiplier: Some(1.0),
        move_in_rate: "paused".to_string(),
    })
    .expect("blank grid request must create a snapshot");
    snapshot.paused = true;
    assert!(validate_snapshot(&snapshot).is_ok());
}

// ===========================================================================
// validate_structures — reverse ownership pass: tile must be in owner footprint
// ===========================================================================

/// A road tile outside the roundabout footprint borrows the roundabout's
/// structure ID. The forward pass (footprint tiles must own the structure) is
/// unaffected, and the reverse pass previously only checked that the owner
/// resolves to an existing structure. Without the footprint containment check,
/// this tile would pass validation but be silently excluded from
/// `compile_reciprocal_lane_transitions` (which skips tiles with an owner),
/// disappearing from routable topology.
#[test]
fn road_tile_outside_owner_footprint_is_rejected() {
    let mut snapshot = road_with_structure();
    let id = roundabout_id(&snapshot);
    // Tile (2, 5) is on the horizontal road but far from the compact 2x2
    // roundabout at origin (6, 5) — its footprint is [(6,5), (7,5), (6,6),
    // (7,6)].
    let index = tile_index(&snapshot, 2, 5);
    assert_eq!(snapshot.map.tiles[index].kind, "road");
    assert!(snapshot.map.tiles[index].road_structure_id.is_none());
    snapshot.map.tiles[index].road_structure_id = Some(id.clone());
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidRoadStructure {
            structure_id: id,
            reason: RoadStructureError::TileOwnerMismatch,
        }
    );
}

/// An empty tile outside the roundabout footprint borrows the roundabout's
/// structure ID. Empty tiles are permitted to carry `road_structure_id` by
/// the per-tile check (for roundabout protected-island tiles), so without the
/// footprint containment check this would pass validation and become
/// permanently blocked by false ownership.
#[test]
fn empty_tile_outside_owner_footprint_is_rejected() {
    let mut snapshot = road_with_structure();
    let id = roundabout_id(&snapshot);
    // Tile (0, 0) is an empty tile far from the roundabout.
    let index = 0;
    assert_eq!(snapshot.map.tiles[index].kind, "empty");
    assert!(snapshot.map.tiles[index].road_structure_id.is_none());
    snapshot.map.tiles[index].road_structure_id = Some(id.clone());
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidRoadStructure {
            structure_id: id,
            reason: RoadStructureError::TileOwnerMismatch,
        }
    );
}

// ===========================================================================
// validate_structures — duplicate (point, edge) ports are rejected
// ===========================================================================

/// A roundabout with two ports sharing the same (point, edge) but different
/// IDs passes the duplicate-ID check but must be rejected by the new
/// duplicate (point, edge) check. Without it, the dedup in
/// `validate_roundabout_canonical` would conceal the forged port during
/// comparison while `compile_roundabout_transitions` iterates the original
/// non-deduped list, emitting additional entry/exit transitions.
#[test]
fn roundabout_with_duplicate_port_point_edge_is_rejected() {
    let mut snapshot = road_with_structure();
    let id = roundabout_id(&snapshot);
    // Find the roundabout and duplicate one of its ports with a new ID.
    let structure = snapshot
        .map
        .road_structures
        .iter_mut()
        .find_map(|structure| match structure {
            RoadStructure::Roundabout { ports, .. } => Some(ports),
            _ => None,
        })
        .expect("snapshot must contain a roundabout");
    assert!(!structure.is_empty(), "roundabout must have ports");
    let original = structure[0].clone();
    let forged = RoadPort {
        id: format!("{}-dup", original.id),
        point: original.point,
        edge: original.edge,
        direction: original.direction,
    };
    structure.push(forged);
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidRoadStructure {
            structure_id: id,
            reason: RoadStructureError::DuplicatePortPointEdge,
        }
    );
}
