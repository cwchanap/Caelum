//! Coverage backfill for the remaining uncovered `persistence/map.rs` branches:
//! successful growth-wave / growth-action validation, the
//! `validate_automatic_junction_reconstruction` empty + count-mismatch paths,
//! and the roundabout canonical movement-facts (kind) mismatch.
//!
//! Each test builds a persistence-valid baseline snapshot (via the shared
//! fixtures) and then mutates a single field to exercise one branch, asserting
//! the exact `PersistenceError` (or `Ok(())` for positive cases).

mod common;

use caelum_core::model::{
    GrowthAction, GrowthWave, Point, RoadPort, RoadStructure, RoundaboutSize,
};
use caelum_core::{
    create_sandbox_snapshot, validate_snapshot, GameEngine, GameIntent, PersistenceError,
    RoadPreset, RoadStructureError, SandboxCreationRequest, DEFAULT_STARTING_CAPITAL,
};
use common::persistence_fixtures::{apply, campaign_snapshot, road_with_structure};

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
// validate_roundabout_canonical — movement-facts kind mismatch
// ===========================================================================

/// Build a paused snapshot containing a Standard 3x3 roundabout (which has a
/// protected island tile expected to be "empty"). Forging that tile's kind to
/// "road" passes the per-point structure checks (roundabout tiles may be road
/// or empty) and `validate_map` (a road tile with no connections is valid), but
/// fails the canonical movement-facts kind check in
/// `validate_roundabout_canonical` (lines 582-585).
fn standard_roundabout_snapshot() -> caelum_core::GameSnapshot {
    let mut engine = GameEngine::new();
    apply(
        &mut engine,
        GameIntent::LayRoadLine {
            points: (2..=12).map(|x| Point { x, y: 5 }).collect(),
            preset: RoadPreset::TwoWay,
        },
    );
    apply(
        &mut engine,
        GameIntent::PlaceRoundabout {
            origin: Point { x: 6, y: 5 },
            size: RoundaboutSize::Standard3x3,
        },
    );
    engine.snapshot_for_save().expect("fixture must save")
}

#[test]
fn roundabout_protected_island_wrong_kind_is_rejected() {
    let mut snapshot = standard_roundabout_snapshot();
    // The 3x3 roundabout at origin (6, 5) has its protected island at (7, 6)
    // (offset (1, 1)), which the canonical template expects to be "empty".
    let index = 6 * 28 + 7;
    assert_eq!(snapshot.map.tiles[index].kind, "empty");
    snapshot.map.tiles[index].kind = "road".to_string();
    // Find the roundabout structure id for the expected error.
    let id = snapshot
        .map
        .road_structures
        .iter()
        .find_map(|structure| match structure {
            RoadStructure::Roundabout { id, .. } => Some(id.clone()),
            _ => None,
        })
        .expect("fixture must contain a roundabout");
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidRoadStructure {
            structure_id: id,
            reason: RoadStructureError::NonCanonicalMovementFacts,
        }
    );
}

// ===========================================================================
// validate_automatic_junction_reconstruction — count mismatch
// ===========================================================================

/// Build a paused snapshot containing a real automatic junction (a road
/// crossroads), used to exercise the reconstruction comparison.
fn crossroads_snapshot() -> caelum_core::GameSnapshot {
    let mut engine = GameEngine::new();
    apply(
        &mut engine,
        GameIntent::LayRoadLine {
            points: (2..=12).map(|x| Point { x, y: 5 }).collect(),
            preset: RoadPreset::TwoWay,
        },
    );
    apply(
        &mut engine,
        GameIntent::LayRoadLine {
            points: (2..=12).map(|y| Point { x: 7, y }).collect(),
            preset: RoadPreset::TwoWay,
        },
    );
    engine.snapshot_for_save().expect("fixture must save")
}

#[test]
fn extra_automatic_junction_count_mismatch_is_rejected() {
    let mut snapshot = crossroads_snapshot();
    // Pick a bare straight-road tile far from the real crossing to host a fake
    // automatic junction. Tile (2, 5) is part of the horizontal road but is a
    // straight segment (only East/West connections), so reconstruction will not
    // create a junction there.
    let fake_point = Point { x: 2, y: 5 };
    let fake_index = 5 * 28 + 2;
    assert_eq!(snapshot.map.tiles[fake_index].kind, "road");
    let fake_id = "fake-junction-001".to_string();
    snapshot.map.tiles[fake_index].road_structure_id = Some(fake_id.clone());
    snapshot
        .map
        .road_structures
        .push(RoadStructure::AutomaticJunction {
            id: fake_id.clone(),
            footprint: vec![fake_point],
            ports: vec![RoadPort {
                id: "fake-port".to_string(),
                point: fake_point,
                edge: caelum_core::model::Heading::East,
                direction: None,
            }],
        });
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidRoadStructure {
            structure_id: String::new(),
            reason: RoadStructureError::AutomaticJunctionMismatch,
        }
    );
}

// ===========================================================================
// validate_automatic_junction_reconstruction — stripped junctions must be
// rejected even when the serialized junction list is empty
// ===========================================================================

/// Starting from a valid crossroads snapshot, remove every AutomaticJunction
/// structure and clear the corresponding `road_structure_id` fields while
/// keeping the reciprocal road connections intact. The early return on empty
/// serialized junctions would skip reconstruction, letting the crossing
/// compile as ordinary roads. With the early return removed, reconstruction
/// produces a junction that has no serialized counterpart, so the count
/// mismatch rejects the forged snapshot.
#[test]
fn crossroads_with_all_junctions_stripped_is_rejected() {
    let mut snapshot = crossroads_snapshot();
    // Collect automatic-junction IDs before stripping.
    let automatic_ids: Vec<String> = snapshot
        .map
        .road_structures
        .iter()
        .filter(|structure| structure.is_automatic_junction())
        .map(|structure| structure.id().to_string())
        .collect();
    assert!(
        !automatic_ids.is_empty(),
        "crossroads fixture must contain automatic junctions"
    );
    // Clear ownership on every tile that belonged to an automatic junction.
    for tile in &mut snapshot.map.tiles {
        if tile
            .road_structure_id
            .as_ref()
            .is_some_and(|id| automatic_ids.contains(id))
        {
            tile.road_structure_id = None;
        }
    }
    // Remove all automatic-junction structures.
    snapshot
        .map
        .road_structures
        .retain(|structure| !structure.is_automatic_junction());
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidRoadStructure {
            structure_id: String::new(),
            reason: RoadStructureError::AutomaticJunctionMismatch,
        }
    );
}

// ===========================================================================
// validate_structures — reverse ownership pass: tile must be in owner footprint
// ===========================================================================

/// Find the roundabout structure ID in the snapshot.
fn roundabout_id(snapshot: &caelum_core::GameSnapshot) -> String {
    snapshot
        .map
        .road_structures
        .iter()
        .find_map(|structure| match structure {
            RoadStructure::Roundabout { id, .. } => Some(id.clone()),
            _ => None,
        })
        .expect("snapshot must contain a roundabout")
}

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
    let index = 5 * 28 + 2;
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
