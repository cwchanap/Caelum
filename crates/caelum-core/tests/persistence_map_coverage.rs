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
use common::persistence_fixtures::{apply, campaign_snapshot};

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
// validate_automatic_junction_reconstruction — empty early return (line 628)
// ===========================================================================

/// A paused blank-grid sandbox snapshot has no road structures, so
/// `validate_automatic_junction_reconstruction` hits the empty-junctions early
/// return (line 628). The snapshot is otherwise persistence-valid, so the full
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
