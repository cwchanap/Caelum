//! Coverage for the `persistence/map.rs` validation branches: scalar snapshot
//! state, rules & scenario, map tiles, and road structures.
//!
//! Each test builds a persistence-valid baseline snapshot (via the engine's
//! own intent pipeline + `snapshot_for_save`) and then mutates a single field
//! to exercise one rejection branch, asserting the exact `PersistenceError`.

mod common;

use caelum_core::model::{EconomyPreset, GrowthAction, GrowthWave, Heading, MetricsState, Point};
use caelum_core::{
    clock, scenario, validate_snapshot, DerivedStateError, MapSize, ModeError, NumericError,
    PersistenceError, RoadStructureError, ScenarioError, SnapshotField, TileError,
};
use common::persistence_fixtures::{campaign_snapshot, paused_snapshot, road_with_structure};

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
fn day_index_mismatch_with_time_is_rejected() {
    let mut snapshot = paused_snapshot();
    snapshot.day = clock::day_index(snapshot.time) + 1;
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidDerivedState {
            field: SnapshotField::Day,
            reason: DerivedStateError::ClockMismatch,
        }
    );
}

#[test]
fn clock_minutes_mismatch_with_time_is_rejected() {
    let mut snapshot = paused_snapshot();
    snapshot.clock_minutes = clock::clock_minutes(snapshot.time) + 1;
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidDerivedState {
            field: SnapshotField::ClockMinutes,
            reason: DerivedStateError::ClockMismatch,
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

#[test]
fn negative_budget_is_rejected() {
    let mut snapshot = paused_snapshot();
    snapshot.budget = -1;
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidNumericValue {
            entity: None,
            field: SnapshotField::Budget,
            reason: NumericError::Negative,
        }
    );
}

// ===========================================================================
// rules & scenario validation
// ===========================================================================

#[test]
fn sandbox_with_objectives_is_rejected() {
    let mut snapshot = paused_snapshot();
    let (_rules, scenario) =
        scenario::growing_suburb_campaign(scenario::growing_suburb_objectives(), Vec::new());
    // Keep sandbox game_mode but inject campaign objectives.
    snapshot.scenario = scenario;
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidModeSettings {
            field: SnapshotField::ScenarioObjectives,
            reason: ModeError::SandboxObjectivesPresent,
        }
    );
}

#[test]
fn sandbox_with_growth_waves_is_rejected() {
    let mut snapshot = paused_snapshot();
    snapshot.scenario.growth_waves = vec![GrowthWave {
        id: "wave-1".to_string(),
        trigger_time: 100.0,
        message: "x".to_string(),
        applied: false,
        actions: vec![],
    }];
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidModeSettings {
            field: SnapshotField::ScenarioGrowthWaves,
            reason: ModeError::SandboxGrowthWavesPresent,
        }
    );
}

#[test]
fn sandbox_in_a_terminal_state_is_rejected() {
    let mut snapshot = paused_snapshot();
    snapshot.metrics.state = MetricsState::Lost;
    snapshot.metrics.loss_reason = Some("bankrupt".to_string());
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidModeSettings {
            field: SnapshotField::MetricsState,
            reason: ModeError::SandboxTerminalState,
        }
    );
}

#[test]
fn campaign_with_creative_economy_is_rejected() {
    let mut snapshot = campaign_snapshot();
    snapshot.rules.economy_preset = EconomyPreset::Creative;
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidModeSettings {
            field: SnapshotField::EconomyPreset,
            reason: ModeError::InvalidEconomyForMode,
        }
    );
}

#[test]
fn campaign_terminal_without_objectives_is_rejected() {
    let mut snapshot = campaign_snapshot();
    snapshot.scenario.objectives = None;
    snapshot.metrics.state = MetricsState::Lost;
    snapshot.metrics.loss_reason = Some("bankrupt".to_string());
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidModeSettings {
            field: SnapshotField::MetricsState,
            reason: ModeError::CampaignTerminalWithoutObjectives,
        }
    );
}

#[test]
fn duplicate_growth_wave_id_is_rejected() {
    let mut snapshot = campaign_snapshot();
    snapshot.scenario.growth_waves = vec![
        GrowthWave {
            id: "wave-1".to_string(),
            trigger_time: 100.0,
            message: "a".to_string(),
            applied: false,
            actions: vec![],
        },
        GrowthWave {
            id: "wave-1".to_string(),
            trigger_time: 200.0,
            message: "b".to_string(),
            applied: false,
            actions: vec![],
        },
    ];
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidScenario {
            field: SnapshotField::GrowthWaveId,
            reason: ScenarioError::DuplicateGrowthWaveId {
                wave_id: "wave-1".to_string(),
            },
        }
    );
}

#[test]
fn growth_wave_trigger_times_out_of_order_are_rejected() {
    let mut snapshot = campaign_snapshot();
    snapshot.scenario.growth_waves = vec![
        GrowthWave {
            id: "wave-1".to_string(),
            trigger_time: 200.0,
            message: "a".to_string(),
            applied: false,
            actions: vec![],
        },
        GrowthWave {
            id: "wave-2".to_string(),
            trigger_time: 100.0,
            message: "b".to_string(),
            applied: false,
            actions: vec![],
        },
    ];
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidScenario {
            field: SnapshotField::GrowthWaveTriggerTime,
            reason: ScenarioError::TriggerTimesOutOfOrder {
                previous_wave_id: "wave-1".to_string(),
                wave_id: "wave-2".to_string(),
            },
        }
    );
}

#[test]
fn applied_growth_wave_after_an_unapplied_one_is_rejected() {
    let mut snapshot = campaign_snapshot();
    snapshot.scenario.growth_waves = vec![
        GrowthWave {
            id: "wave-1".to_string(),
            trigger_time: 100.0,
            message: "a".to_string(),
            applied: false,
            actions: vec![],
        },
        GrowthWave {
            id: "wave-2".to_string(),
            trigger_time: 200.0,
            message: "b".to_string(),
            applied: true,
            actions: vec![],
        },
    ];
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidScenario {
            field: SnapshotField::ScenarioGrowthWaves,
            reason: ScenarioError::AppliedAfterUnapplied {
                first_unapplied_wave_id: "wave-1".to_string(),
                later_applied_wave_id: "wave-2".to_string(),
            },
        }
    );
}

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
fn non_canonical_tile_id_is_rejected() {
    let mut snapshot = paused_snapshot();
    snapshot.map.tiles[1].id = "tile-wrong".to_string();
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidTile {
            tile_id: "tile-wrong".to_string(),
            reason: TileError::NonCanonicalId {
                expected: "tile-1-0".to_string(),
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
