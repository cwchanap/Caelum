//! Coverage for the `persistence/map.rs` validation branches: scalar snapshot
//! state, rules & scenario, map tiles, and road structures.
//!
//! Each test builds a persistence-valid baseline snapshot (via the engine's
//! own intent pipeline + `snapshot_for_save`) and then mutates a single field
//! to exercise one rejection branch, asserting the exact `PersistenceError`.

mod common;

use caelum_core::model::{
    EconomyPreset, GrowthAction, GrowthWave, Heading, MetricsState, Point, RoadStructure,
    RoundaboutSize,
};
use caelum_core::{
    clock, scenario, validate_snapshot, DerivedStateError, GameEngine, GameIntent, MapSize,
    ModeError, NumericError, PersistenceError, RoadPreset, RoadStructureError, ScenarioError,
    SnapshotField, TileError,
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

/// A paused snapshot with an automatic junction (horizontal + vertical road
/// crossing), for automatic-junction reconstruction validation tests.
fn snapshot_with_automatic_junction() -> caelum_core::GameSnapshot {
    let mut engine = GameEngine::new();
    apply_intent(
        &mut engine,
        GameIntent::LayRoadLine {
            points: (2..=10).map(|x| Point { x, y: 5 }).collect(),
            preset: RoadPreset::TwoWay,
        },
    );
    apply_intent(
        &mut engine,
        GameIntent::LayRoadLine {
            points: (3..=7).map(|y| Point { x: 6, y }).collect(),
            preset: RoadPreset::TwoWay,
        },
    );
    engine
        .snapshot_for_save()
        .expect("junction fixture must save")
}

/// Find the first roundabout in the snapshot's road structures.
fn first_roundabout(snapshot: &caelum_core::GameSnapshot) -> usize {
    snapshot
        .map
        .road_structures
        .iter()
        .position(|s| matches!(s, RoadStructure::Roundabout { .. }))
        .expect("snapshot must contain a roundabout")
}

/// Find the first automatic junction in the snapshot's road structures.
fn first_automatic_junction(snapshot: &caelum_core::GameSnapshot) -> usize {
    snapshot
        .map
        .road_structures
        .iter()
        .position(|s| matches!(s, RoadStructure::AutomaticJunction { .. }))
        .expect("snapshot must contain an automatic junction")
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

// ===========================================================================
// canonical road structure reconstruction
// ===========================================================================

#[test]
fn roundabout_with_non_canonical_id_is_rejected() {
    let mut snapshot = road_with_structure();
    let index = first_roundabout(&snapshot);
    let old_id = snapshot.map.road_structures[index].id().to_string();
    let new_id = "roundabout:fake:6,5".to_string();
    // Update the structure ID and all tile references so the basic ownership
    // checks pass; the canonical check catches the non-canonical ID format.
    if let RoadStructure::Roundabout { id, .. } = &mut snapshot.map.road_structures[index] {
        *id = new_id.clone();
    }
    for tile in &mut snapshot.map.tiles {
        if tile.road_structure_id.as_deref() == Some(&old_id) {
            tile.road_structure_id = Some(new_id.clone());
        }
    }
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidRoadStructure {
            structure_id: new_id,
            reason: RoadStructureError::NonCanonicalId,
        }
    );
}

#[test]
fn roundabout_with_non_canonical_footprint_is_rejected() {
    let mut snapshot = road_with_structure();
    let index = first_roundabout(&snapshot);
    // Swap the first two footprint points so the set is the same (basic
    // ownership checks pass) but the order diverges from the canonical
    // row-major template footprint.
    if let RoadStructure::Roundabout { footprint, .. } = &mut snapshot.map.road_structures[index] {
        footprint.swap(0, 1);
    }
    let id = snapshot.map.road_structures[index].id().to_string();
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidRoadStructure {
            structure_id: id,
            reason: RoadStructureError::NonCanonicalFootprint,
        }
    );
}

#[test]
fn roundabout_with_non_canonical_lane_facts_is_rejected() {
    let mut snapshot = road_with_structure();
    let index = first_roundabout(&snapshot);
    let footprint: Vec<Point> = snapshot.map.road_structures[index].footprint().to_vec();
    // Set one_way on a footprint tile; the basic tile validation does not
    // check one_way for road tiles, but the canonical lane-facts check does.
    let point = footprint[0];
    if let Some(tile) = snapshot.map.tile_mut(point) {
        tile.one_way = Some(Heading::East);
    }
    let id = snapshot.map.road_structures[index].id().to_string();
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidRoadStructure {
            structure_id: id,
            reason: RoadStructureError::NonCanonicalLaneFacts,
        }
    );
}

#[test]
fn roundabout_with_non_canonical_movement_facts_is_rejected() {
    let mut snapshot = road_with_structure();
    let index = first_roundabout(&snapshot);
    let footprint: Vec<Point> = snapshot.map.road_structures[index].footprint().to_vec();
    // Add an internal reciprocal connection between two footprint tiles
    // (both are road tiles, so tile-level reciprocity passes). The canonical
    // movement-facts check catches the extra connection.
    let a = footprint[0];
    let b = footprint[2];
    let heading_ab = Heading::South;
    let heading_ba = Heading::North;
    if let Some(tile) = snapshot.map.tile_mut(a) {
        tile.road_connections.push(heading_ab);
        tile.road_connections.sort_by_key(|h| match h {
            Heading::North => 0,
            Heading::East => 1,
            Heading::South => 2,
            Heading::West => 3,
        });
        tile.road_connections.dedup();
    }
    if let Some(tile) = snapshot.map.tile_mut(b) {
        tile.road_connections.push(heading_ba);
        tile.road_connections.sort_by_key(|h| match h {
            Heading::North => 0,
            Heading::East => 1,
            Heading::South => 2,
            Heading::West => 3,
        });
        tile.road_connections.dedup();
    }
    let id = snapshot.map.road_structures[index].id().to_string();
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidRoadStructure {
            structure_id: id,
            reason: RoadStructureError::NonCanonicalMovementFacts,
        }
    );
}

#[test]
fn roundabout_with_non_canonical_ports_is_rejected() {
    let mut snapshot = road_with_structure();
    let index = first_roundabout(&snapshot);
    // Change a port's direction so it diverges from the canonical
    // reconstruction (which derives direction from the current map state).
    if let RoadStructure::Roundabout { ports, .. } = &mut snapshot.map.road_structures[index] {
        if let Some(port) = ports.first_mut() {
            port.direction = Some(caelum_core::model::PortDirection::Inbound);
        }
    }
    let id = snapshot.map.road_structures[index].id().to_string();
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidRoadStructure {
            structure_id: id,
            reason: RoadStructureError::NonCanonicalMovementFacts,
        }
    );
}

#[test]
fn automatic_junction_with_forged_port_is_rejected() {
    let mut snapshot = snapshot_with_automatic_junction();
    let index = first_automatic_junction(&snapshot);
    // Add a forged port that the reconstruction would not produce. The basic
    // checks only verify the port point is in the footprint, so a forged port
    // with a valid point passes the basic checks but diverges from the
    // authoritative reconstruction.
    let footprint: Vec<Point> = snapshot.map.road_structures[index].footprint().to_vec();
    let id = snapshot.map.road_structures[index].id().to_string();
    let forged_port = caelum_core::model::RoadPort {
        id: format!("{id}-forged-port"),
        point: footprint[0],
        edge: Heading::North,
        direction: None,
    };
    if let RoadStructure::AutomaticJunction { ports, .. } = &mut snapshot.map.road_structures[index]
    {
        ports.push(forged_port);
    }
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidRoadStructure {
            structure_id: id,
            reason: RoadStructureError::AutomaticJunctionMismatch,
        }
    );
}

#[test]
fn automatic_junction_with_non_canonical_id_is_rejected() {
    let mut snapshot = snapshot_with_automatic_junction();
    let index = first_automatic_junction(&snapshot);
    let old_id = snapshot.map.road_structures[index].id().to_string();
    let new_id = "junction-fake-id".to_string();
    if let RoadStructure::AutomaticJunction { id, .. } = &mut snapshot.map.road_structures[index] {
        *id = new_id.clone();
    }
    for tile in &mut snapshot.map.tiles {
        if tile.road_structure_id.as_deref() == Some(&old_id) {
            tile.road_structure_id = Some(new_id.clone());
        }
    }
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidRoadStructure {
            structure_id: new_id,
            reason: RoadStructureError::AutomaticJunctionMismatch,
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
    let snapshot = engine.snapshot_for_save().expect("3x3 fixture must save");
    validate_snapshot(&snapshot).expect("3x3 roundabout must be persistence-valid");
}
