use std::collections::{BTreeMap, BTreeSet};

use crate::building_catalog::building_definition;
use crate::clock::{self, GAME_DAY_SECONDS};
use crate::heading::{heading_rank, offset, opposite};
use crate::ids::tile_id;
use crate::model::{EconomyPreset, GameMode, GameSnapshot, GrowthAction, MetricsState, Point};
use crate::road_topology::RoadTopology;
use crate::sandbox::{MAP_HEIGHT, MAP_WIDTH};

use super::{
    DerivedStateError, MapSize, ModeError, NumericError, PersistenceError, PersistenceResult,
    RoadStructureError, ScenarioError, SnapshotField, TileError,
};

pub(super) fn validate_shell_rules_map_and_compile(
    snapshot: &GameSnapshot,
) -> PersistenceResult<RoadTopology> {
    if snapshot.schema_version != crate::model::SNAPSHOT_SCHEMA_VERSION {
        return Err(PersistenceError::UnsupportedSchema {
            expected: crate::model::SNAPSHOT_SCHEMA_VERSION,
            actual: snapshot.schema_version,
        });
    }
    validate_scalar_state(snapshot)?;
    validate_rules_and_scenario(snapshot)?;
    validate_map(snapshot)?;
    RoadTopology::compile(&snapshot.map).map_err(PersistenceError::from)
}

fn validate_scalar_state(snapshot: &GameSnapshot) -> PersistenceResult<()> {
    finite_non_negative(SnapshotField::Time, snapshot.time)?;
    let maximum_time = (f64::from(u32::MAX) + 1.0) * GAME_DAY_SECONDS;
    if snapshot.time >= maximum_time {
        return Err(PersistenceError::InvalidNumericValue {
            entity: None,
            field: SnapshotField::Time,
            reason: NumericError::OutOfRange {
                minimum: 0.0,
                maximum: maximum_time,
                actual: snapshot.time,
            },
        });
    }
    if snapshot.day != clock::day_index(snapshot.time) {
        return Err(PersistenceError::InvalidDerivedState {
            field: SnapshotField::Day,
            reason: DerivedStateError::ClockMismatch,
        });
    }
    if snapshot.clock_minutes != clock::clock_minutes(snapshot.time) {
        return Err(PersistenceError::InvalidDerivedState {
            field: SnapshotField::ClockMinutes,
            reason: DerivedStateError::ClockMismatch,
        });
    }
    if !matches!(snapshot.speed, 0 | 1 | 2 | 4) {
        return Err(PersistenceError::InvalidModeSettings {
            field: SnapshotField::Speed,
            reason: ModeError::UnsupportedSpeed,
        });
    }
    if !snapshot.paused {
        return Err(PersistenceError::InvalidModeSettings {
            field: SnapshotField::Paused,
            reason: ModeError::PersistenceRequiresPaused,
        });
    }
    if snapshot.budget < 0 {
        return Err(PersistenceError::InvalidNumericValue {
            entity: None,
            field: SnapshotField::Budget,
            reason: NumericError::Negative,
        });
    }
    Ok(())
}

fn finite_non_negative(field: SnapshotField, value: f64) -> PersistenceResult<()> {
    if !value.is_finite() {
        return Err(PersistenceError::InvalidNumericValue {
            entity: None,
            field,
            reason: NumericError::NotFinite,
        });
    }
    if value < 0.0 {
        return Err(PersistenceError::InvalidNumericValue {
            entity: None,
            field,
            reason: NumericError::Negative,
        });
    }
    Ok(())
}

fn validate_rules_and_scenario(snapshot: &GameSnapshot) -> PersistenceResult<()> {
    let sandbox = &snapshot.rules.sandbox;
    if sandbox.starting_capital.value() < 0 {
        return Err(PersistenceError::InvalidNumericValue {
            entity: None,
            field: SnapshotField::StartingCapital,
            reason: NumericError::Negative,
        });
    }
    let demand = sandbox.demand_multiplier.value();
    if !demand.is_finite() {
        return Err(PersistenceError::InvalidNumericValue {
            entity: None,
            field: SnapshotField::DemandMultiplier,
            reason: NumericError::NotFinite,
        });
    }
    if demand <= 0.0 {
        return Err(PersistenceError::InvalidNumericValue {
            entity: None,
            field: SnapshotField::DemandMultiplier,
            reason: NumericError::OutOfRange {
                minimum: f64::MIN_POSITIVE,
                maximum: f64::MAX,
                actual: demand,
            },
        });
    }

    match snapshot.rules.game_mode {
        GameMode::Sandbox => {
            if snapshot.scenario.objectives.is_some() {
                return Err(PersistenceError::InvalidModeSettings {
                    field: SnapshotField::ScenarioObjectives,
                    reason: ModeError::SandboxObjectivesPresent,
                });
            }
            if !snapshot.scenario.growth_waves.is_empty() {
                return Err(PersistenceError::InvalidModeSettings {
                    field: SnapshotField::ScenarioGrowthWaves,
                    reason: ModeError::SandboxGrowthWavesPresent,
                });
            }
            if snapshot.metrics.state != MetricsState::Running
                || snapshot.metrics.loss_reason.is_some()
            {
                return Err(PersistenceError::InvalidModeSettings {
                    field: SnapshotField::MetricsState,
                    reason: ModeError::SandboxTerminalState,
                });
            }
        }
        GameMode::Campaign => {
            if snapshot.rules.economy_preset != EconomyPreset::Standard {
                return Err(PersistenceError::InvalidModeSettings {
                    field: SnapshotField::EconomyPreset,
                    reason: ModeError::InvalidEconomyForMode,
                });
            }
            if snapshot.scenario.objectives.is_none()
                && snapshot.metrics.state != MetricsState::Running
            {
                return Err(PersistenceError::InvalidModeSettings {
                    field: SnapshotField::MetricsState,
                    reason: ModeError::CampaignTerminalWithoutObjectives,
                });
            }
        }
    }

    let mut ids = BTreeSet::new();
    let mut previous: Option<(&str, f64)> = None;
    let mut first_unapplied: Option<&str> = None;
    for wave in &snapshot.scenario.growth_waves {
        if wave.id.is_empty() || !ids.insert(wave.id.as_str()) {
            return Err(PersistenceError::InvalidScenario {
                field: SnapshotField::GrowthWaveId,
                reason: ScenarioError::DuplicateGrowthWaveId {
                    wave_id: wave.id.clone(),
                },
            });
        }
        finite_non_negative(SnapshotField::GrowthWaveTriggerTime, wave.trigger_time)?;
        if let Some((previous_id, previous_time)) = previous {
            if wave.trigger_time < previous_time {
                return Err(PersistenceError::InvalidScenario {
                    field: SnapshotField::GrowthWaveTriggerTime,
                    reason: ScenarioError::TriggerTimesOutOfOrder {
                        previous_wave_id: previous_id.to_string(),
                        wave_id: wave.id.clone(),
                    },
                });
            }
        }
        if !wave.applied {
            first_unapplied.get_or_insert(&wave.id);
        } else if let Some(first_unapplied_wave_id) = first_unapplied {
            return Err(PersistenceError::InvalidScenario {
                field: SnapshotField::ScenarioGrowthWaves,
                reason: ScenarioError::AppliedAfterUnapplied {
                    first_unapplied_wave_id: first_unapplied_wave_id.to_string(),
                    later_applied_wave_id: wave.id.clone(),
                },
            });
        }
        for (action_index, action) in wave.actions.iter().enumerate() {
            validate_growth_action(snapshot, &wave.id, action_index, action)?;
        }
        previous = Some((&wave.id, wave.trigger_time));
    }
    Ok(())
}

fn validate_growth_action(
    snapshot: &GameSnapshot,
    wave_id: &str,
    action_index: usize,
    action: &GrowthAction,
) -> PersistenceResult<()> {
    let action_index = u32::try_from(action_index).unwrap_or(u32::MAX);
    match action {
        GrowthAction::PaintAreaRectangle { start, end, .. } => {
            for point in [*start, *end] {
                if snapshot.map.tile(point).is_none() {
                    return Err(PersistenceError::InvalidScenario {
                        field: SnapshotField::GrowthWaveActions,
                        reason: ScenarioError::ActionOutOfBounds {
                            wave_id: wave_id.to_string(),
                            action_index,
                            point,
                        },
                    });
                }
            }
        }
        GrowthAction::PlaceBuilding {
            building_type,
            origin,
            rotation,
        } => {
            let Some(definition) = building_definition(building_type) else {
                return Err(PersistenceError::InvalidScenario {
                    field: SnapshotField::GrowthWaveActions,
                    reason: ScenarioError::UnknownBuildingType {
                        wave_id: wave_id.to_string(),
                        action_index,
                    },
                });
            };
            if !matches!(rotation, 0 | 90 | 180 | 270) {
                return Err(PersistenceError::InvalidScenario {
                    field: SnapshotField::GrowthWaveActions,
                    reason: ScenarioError::InvalidBuildingRotation {
                        wave_id: wave_id.to_string(),
                        action_index,
                    },
                });
            }
            let Some(footprint) = crate::buildings::footprint(definition, origin, *rotation) else {
                return Err(PersistenceError::InvalidScenario {
                    field: SnapshotField::GrowthWaveActions,
                    reason: ScenarioError::ActionOutOfBounds {
                        wave_id: wave_id.to_string(),
                        action_index,
                        point: *origin,
                    },
                });
            };
            if let Some(point) = footprint
                .into_iter()
                .find(|point| snapshot.map.tile(*point).is_none())
            {
                return Err(PersistenceError::InvalidScenario {
                    field: SnapshotField::GrowthWaveActions,
                    reason: ScenarioError::ActionOutOfBounds {
                        wave_id: wave_id.to_string(),
                        action_index,
                        point,
                    },
                });
            }
        }
    }
    Ok(())
}

fn validate_map(snapshot: &GameSnapshot) -> PersistenceResult<()> {
    let map = &snapshot.map;
    if map.width != MAP_WIDTH || map.height != MAP_HEIGHT {
        return Err(PersistenceError::InvalidMapDimensions {
            expected: MapSize {
                width: MAP_WIDTH,
                height: MAP_HEIGHT,
            },
            actual: MapSize {
                width: map.width,
                height: map.height,
            },
        });
    }
    let expected_count = usize::from(MAP_WIDTH) * usize::from(MAP_HEIGHT);
    if map.tiles.len() != expected_count {
        return Err(PersistenceError::InvalidTile {
            tile_id: String::new(),
            reason: TileError::WrongRowMajorCoordinate {
                expected: Point {
                    x: i32::from(MAP_WIDTH),
                    y: i32::from(MAP_HEIGHT),
                },
                actual: Point {
                    x: i32::try_from(map.tiles.len()).unwrap_or(i32::MAX),
                    y: 0,
                },
            },
        });
    }

    for (index, tile) in map.tiles.iter().enumerate() {
        let expected = Point {
            x: i32::try_from(index % usize::from(map.width)).unwrap_or(i32::MAX),
            y: i32::try_from(index / usize::from(map.width)).unwrap_or(i32::MAX),
        };
        let actual = Point {
            x: tile.x,
            y: tile.y,
        };
        if actual != expected {
            return Err(PersistenceError::InvalidTile {
                tile_id: tile.id.clone(),
                reason: TileError::WrongRowMajorCoordinate { expected, actual },
            });
        }
        let expected_id = tile_id(tile.x, tile.y);
        if tile.id != expected_id {
            return Err(PersistenceError::InvalidTile {
                tile_id: tile.id.clone(),
                reason: TileError::NonCanonicalId {
                    expected: expected_id,
                },
            });
        }
        if !matches!(tile.kind.as_str(), "empty" | "road") {
            return Err(invalid_tile(tile, TileError::UnsupportedKind));
        }
        if tile.area.as_deref().is_some_and(|area| {
            !matches!(
                area,
                "residential" | "commercial" | "industrial" | "office" | "civic" | "park"
            )
        }) {
            return Err(invalid_tile(tile, TileError::UnsupportedArea));
        }
        if tile.kind != "road"
            && (tile.one_way.is_some()
                || !tile.road_connections.is_empty()
                || tile.road_structure_id.is_some())
        {
            return Err(invalid_tile(tile, TileError::NonRoadHasRoadState));
        }
        if tile.kind == "road" && tile.has_track {
            return Err(invalid_tile(
                tile,
                TileError::InvalidInfrastructureCoexistence,
            ));
        }
        if let Some(one_way) = tile.one_way {
            if tile
                .road_connections
                .iter()
                .any(|heading| *heading != one_way && *heading != opposite(one_way))
            {
                return Err(invalid_tile(tile, TileError::InvalidOneWayAxis));
            }
        }
        let mut seen = BTreeSet::new();
        for heading in &tile.road_connections {
            if !seen.insert(*heading) {
                return Err(invalid_tile(tile, TileError::DuplicateRoadConnection));
            }
        }
        if tile
            .road_connections
            .windows(2)
            .any(|pair| heading_rank(pair[0]) >= heading_rank(pair[1]))
        {
            return Err(invalid_tile(
                tile,
                TileError::NonCanonicalRoadConnectionOrder,
            ));
        }
        for heading in &tile.road_connections {
            let neighbor_point = offset(actual, *heading);
            let Some(neighbor) = map.tile(neighbor_point) else {
                return Err(invalid_tile(
                    tile,
                    TileError::ConnectionOutOfBounds { heading: *heading },
                ));
            };
            if neighbor.kind != "road" {
                return Err(invalid_tile(
                    tile,
                    TileError::ConnectionToNonRoad {
                        neighbor: neighbor_point,
                    },
                ));
            }
            if !neighbor.road_connections.contains(&opposite(*heading)) {
                return Err(invalid_tile(
                    tile,
                    TileError::NonReciprocalConnection {
                        neighbor: neighbor_point,
                    },
                ));
            }
        }
    }
    validate_structures(snapshot)
}

fn validate_structures(snapshot: &GameSnapshot) -> PersistenceResult<()> {
    let map = &snapshot.map;
    let mut structures = BTreeMap::new();
    let mut owned_points = BTreeSet::new();
    for structure in &map.road_structures {
        let id = structure.id();
        if id.is_empty() || structures.insert(id, structure).is_some() {
            return Err(PersistenceError::InvalidRoadStructure {
                structure_id: id.to_string(),
                reason: RoadStructureError::NonCanonicalId,
            });
        }
        if structure.footprint().is_empty() {
            return Err(PersistenceError::InvalidRoadStructure {
                structure_id: id.to_string(),
                reason: RoadStructureError::EmptyFootprint,
            });
        }
        let mut local = BTreeSet::new();
        for point in structure.footprint() {
            if !local.insert(*point) {
                return Err(PersistenceError::InvalidRoadStructure {
                    structure_id: id.to_string(),
                    reason: RoadStructureError::DuplicateFootprintPoint,
                });
            }
            if !owned_points.insert(*point) {
                return Err(PersistenceError::InvalidRoadStructure {
                    structure_id: id.to_string(),
                    reason: RoadStructureError::OverlappingFootprint,
                });
            }
            let Some(tile) = map.tile(*point) else {
                return Err(PersistenceError::InvalidRoadStructure {
                    structure_id: id.to_string(),
                    reason: RoadStructureError::NonRoadFootprintTile,
                });
            };
            if tile.kind != "road" {
                return Err(PersistenceError::InvalidRoadStructure {
                    structure_id: id.to_string(),
                    reason: RoadStructureError::NonRoadFootprintTile,
                });
            }
            if tile.road_structure_id.as_deref() != Some(id) {
                return Err(PersistenceError::InvalidRoadStructure {
                    structure_id: id.to_string(),
                    reason: RoadStructureError::TileOwnerMismatch,
                });
            }
        }
        let mut port_ids = BTreeSet::new();
        for port in structure.ports() {
            if !port_ids.insert(port.id.as_str()) {
                return Err(PersistenceError::InvalidRoadStructure {
                    structure_id: id.to_string(),
                    reason: RoadStructureError::DuplicatePortId,
                });
            }
            if !local.contains(&port.point) {
                return Err(PersistenceError::InvalidRoadStructure {
                    structure_id: id.to_string(),
                    reason: RoadStructureError::InvalidBoundaryPort,
                });
            }
        }
    }
    for tile in &map.tiles {
        if let Some(owner) = &tile.road_structure_id {
            if !structures.contains_key(owner.as_str()) {
                return Err(PersistenceError::InvalidRoadStructure {
                    structure_id: owner.clone(),
                    reason: RoadStructureError::DanglingTileOwner,
                });
            }
        }
    }
    Ok(())
}

fn invalid_tile(tile: &crate::model::Tile, reason: TileError) -> PersistenceError {
    PersistenceError::InvalidTile {
        tile_id: tile.id.clone(),
        reason,
    }
}
