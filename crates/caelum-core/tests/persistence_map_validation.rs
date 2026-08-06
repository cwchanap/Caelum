//! Coverage for the `persistence/map.rs` validation branches: scalar snapshot
//! state, rules & scenario, map tiles, and road structures.
//!
//! Each test builds a persistence-valid baseline snapshot (via the engine's
//! own intent pipeline + `snapshot_for_save`) and then mutates a single field
//! to exercise one rejection branch, asserting the exact `PersistenceError`.

mod common;

use caelum_core::model::{GrowthAction, GrowthWave, Heading, Point, RoundaboutSize};
use caelum_core::{
    clock, validate_snapshot, GameEngine, GameIntent, MapSize, ModeError, NumericError,
    PersistenceError, RoadPreset, RoadStructureError, ScenarioError, SnapshotField, TileError,
};
use common::persistence_fixtures::{campaign_snapshot, paused_snapshot, road_with_structure};

/// Helper: apply an intent and assert it was applied.
fn apply_intent(engine: &mut GameEngine, intent: GameIntent) {
    let result = engine.dispatch(intent);
    assert!(
        result.applied,
        "fixture intent rejected: {:?}",
        result.rejection
    );
}

// ===========================================================================
// scalar state validation
// ===========================================================================

#[test]
fn time_above_the_maximum_game_span_is_rejected() {
    let mut snapshot = paused_snapshot();
    let maximum = (f64::from(u32::MAX) + 1.0) * clock::GAME_DAY_SECONDS;
    snapshot.time = maximum;
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidNumericValue {
            entity: None,
            field: SnapshotField::Time,
            reason: NumericError::OutOfRange {
                minimum: 0.0,
                maximum,
                actual: maximum,
            },
        }
    );
}

#[test]
fn unsupported_speed_is_rejected() {
    let mut snapshot = paused_snapshot();
    snapshot.speed = 3;
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidModeSettings {
            field: SnapshotField::Speed,
            reason: ModeError::UnsupportedSpeed,
        }
    );
}

// ===========================================================================
// rules & scenario validation
// ===========================================================================

#[test]
fn growth_wave_paint_area_out_of_bounds_is_rejected() {
    let mut snapshot = campaign_snapshot();
    snapshot.scenario.growth_waves = vec![GrowthWave {
        id: "wave-1".to_string(),
        trigger_time: 100.0,
        message: "a".to_string(),
        applied: false,
        actions: vec![GrowthAction::PaintAreaRectangle {
            area: "residential".to_string(),
            start: Point { x: 27, y: 17 },
            end: Point { x: 30, y: 17 },
        }],
    }];
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidScenario {
            field: SnapshotField::GrowthWaveActions,
            reason: ScenarioError::ActionOutOfBounds {
                wave_id: "wave-1".to_string(),
                action_index: 0,
                point: Point { x: 30, y: 17 },
            },
        }
    );
}

#[test]
fn growth_wave_unknown_building_type_is_rejected() {
    let mut snapshot = campaign_snapshot();
    snapshot.scenario.growth_waves = vec![GrowthWave {
        id: "wave-1".to_string(),
        trigger_time: 100.0,
        message: "a".to_string(),
        applied: false,
        actions: vec![GrowthAction::PlaceBuilding {
            building_type: "unknownType".to_string(),
            origin: Point { x: 2, y: 2 },
            rotation: 0,
        }],
    }];
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidScenario {
            field: SnapshotField::GrowthWaveActions,
            reason: ScenarioError::UnknownBuildingType {
                wave_id: "wave-1".to_string(),
                action_index: 0,
            },
        }
    );
}

#[test]
fn growth_wave_invalid_building_rotation_is_rejected() {
    let mut snapshot = campaign_snapshot();
    snapshot.scenario.growth_waves = vec![GrowthWave {
        id: "wave-1".to_string(),
        trigger_time: 100.0,
        message: "a".to_string(),
        applied: false,
        actions: vec![GrowthAction::PlaceBuilding {
            building_type: "smallHouse".to_string(),
            origin: Point { x: 2, y: 2 },
            rotation: 45,
        }],
    }];
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidScenario {
            field: SnapshotField::GrowthWaveActions,
            reason: ScenarioError::InvalidBuildingRotation {
                wave_id: "wave-1".to_string(),
                action_index: 0,
            },
        }
    );
}

// ===========================================================================
// map tile validation
// ===========================================================================

#[test]
fn wrong_map_dimensions_are_rejected() {
    let mut snapshot = paused_snapshot();
    snapshot.map.width = 27;
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidMapDimensions {
            expected: MapSize {
                width: 28,
                height: 18
            },
            actual: MapSize {
                width: 27,
                height: 18
            },
        }
    );
}

#[test]
fn unsupported_tile_kind_is_rejected() {
    let mut snapshot = paused_snapshot();
    snapshot.map.tiles[0].kind = "water".to_string();
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidTile {
            tile_id: "tile-0-0".to_string(),
            reason: TileError::UnsupportedKind,
        }
    );
}

#[test]
fn unsupported_tile_area_is_rejected() {
    let mut snapshot = paused_snapshot();
    snapshot.map.tiles[0].area = Some("desert".to_string());
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidTile {
            tile_id: "tile-0-0".to_string(),
            reason: TileError::UnsupportedArea,
        }
    );
}

#[test]
fn non_road_tile_with_road_state_is_rejected() {
    let mut snapshot = paused_snapshot();
    snapshot.map.tiles[0].road_connections = vec![Heading::East];
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidTile {
            tile_id: "tile-0-0".to_string(),
            reason: TileError::NonRoadHasRoadState,
        }
    );
}

#[test]
fn road_tile_with_track_is_rejected() {
    let mut snapshot = paused_snapshot();
    snapshot.map.tiles[0].kind = "road".to_string();
    snapshot.map.tiles[0].has_track = true;
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidTile {
            tile_id: "tile-0-0".to_string(),
            reason: TileError::InvalidInfrastructureCoexistence,
        }
    );
}

// ===========================================================================
// road structure validation
// ===========================================================================

#[test]
fn dangling_tile_owner_is_rejected() {
    let mut snapshot = road_with_structure();
    // Point a tile's road_structure_id at a non-existent structure.
    snapshot.map.tiles[0].kind = "road".to_string();
    snapshot.map.tiles[0].road_structure_id = Some("nonexistent".to_string());
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidRoadStructure {
            structure_id: "nonexistent".to_string(),
            reason: RoadStructureError::DanglingTileOwner,
        }
    );
}

#[test]
fn standard_3x3_roundabout_is_persistence_valid() {
    // A 3x3 roundabout has a protected-island center tile with kind "empty".
    // The canonical validation accepts this because the template's
    // circulation_tiles list excludes the center, and the movement-facts
    // check verifies the exact kind per template.
    let mut engine = GameEngine::new();
    apply_intent(
        &mut engine,
        GameIntent::LayRoadLine {
            points: (2..=12).map(|x| Point { x, y: 5 }).collect(),
            preset: RoadPreset::TwoWay,
        },
    );
    apply_intent(
        &mut engine,
        GameIntent::PlaceRoundabout {
            origin: Point { x: 6, y: 5 },
            size: RoundaboutSize::Standard3x3,
        },
    );
    let snapshot = engine.snapshot_for_save();
    validate_snapshot(&snapshot).expect("3x3 roundabout must be persistence-valid");
}
