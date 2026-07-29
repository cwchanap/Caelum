use std::collections::{BTreeMap, BTreeSet};

use crate::building_catalog::building_definition;
use crate::clock::{self, GAME_DAY_SECONDS};
use crate::heading::{heading_rank, offset, opposite};
use crate::ids::tile_id;
use crate::model::{
    EconomyPreset, GameMap, GameMode, GameSnapshot, GrowthAction, Heading, MetricsState, Point,
    RoadStructure,
};
use crate::road_topology::RoadTopology;
use crate::roundabouts::{recapture_boundary_ports, roundabout_structure_id, roundabout_template};
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
    super::finite_non_negative(None, SnapshotField::Time, snapshot.time)?;
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
        super::finite_non_negative(
            None,
            SnapshotField::GrowthWaveTriggerTime,
            wave.trigger_time,
        )?;
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
            reason: TileError::CountMismatch {
                expected: expected_count,
                actual: map.tiles.len(),
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
                || (tile.road_structure_id.is_some() && tile.kind != "empty"))
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
            // Roundabout protected-island tiles are "empty"; all other
            // structure-owned tiles must be "road". The canonical
            // reconstruction check below verifies the exact kind per template.
            let kind_ok = match structure {
                RoadStructure::Roundabout { .. } => tile.kind == "road" || tile.kind == "empty",
                RoadStructure::AutomaticJunction { .. } => tile.kind == "road",
            };
            if !kind_ok {
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
        let mut port_point_edges: BTreeSet<(Point, Heading)> = BTreeSet::new();
        for port in structure.ports() {
            if !port_ids.insert(port.id.as_str()) {
                return Err(PersistenceError::InvalidRoadStructure {
                    structure_id: id.to_string(),
                    reason: RoadStructureError::DuplicatePortId,
                });
            }
            // Reject duplicate (point, edge) pairs even when the port IDs
            // differ. Without this, a forged second port at the same boundary
            // edge could pass the basic checks, be concealed by the dedup in
            // `validate_roundabout_canonical`, yet still emit additional
            // entry/exit transitions during topology compilation (which
            // iterates the original non-deduped port list).
            if !port_point_edges.insert((port.point, port.edge)) {
                return Err(PersistenceError::InvalidRoadStructure {
                    structure_id: id.to_string(),
                    reason: RoadStructureError::DuplicatePortPointEdge,
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
            let Some(structure) = structures.get(owner.as_str()) else {
                return Err(PersistenceError::InvalidRoadStructure {
                    structure_id: owner.clone(),
                    reason: RoadStructureError::DanglingTileOwner,
                });
            };
            // The tile must actually belong to the resolved structure's
            // footprint. Without this, an unrelated road or empty tile can
            // borrow an existing structure ID, pass validation, and either
            // disappear from ordinary topology (road tiles with an owner are
            // excluded from `compile_reciprocal_lane_transitions`) or become
            // permanently blocked by false ownership.
            let tile_point = Point {
                x: tile.x,
                y: tile.y,
            };
            if !structure.footprint().contains(&tile_point) {
                return Err(PersistenceError::InvalidRoadStructure {
                    structure_id: owner.clone(),
                    reason: RoadStructureError::TileOwnerMismatch,
                });
            }
        }
    }

    // Canonical reconstruction: verify each structure matches what the
    // authoritative roundabout/automatic-junction helpers would produce from
    // the map's current road state. A self-consistent but forged structure
    // would pass the basic checks above but diverge from reconstruction.
    for structure in &map.road_structures {
        match structure {
            RoadStructure::Roundabout { .. } => {
                validate_roundabout_canonical(map, structure)?;
            }
            RoadStructure::AutomaticJunction { .. } => {
                // Handled collectively by reconstruction below.
            }
        }
    }
    validate_automatic_junction_reconstruction(snapshot)?;

    Ok(())
}

/// Reconstruct each roundabout from its `(size, origin)` via the authoritative
/// `roundabout_template` helper and compare its canonical ID, footprint, lane
/// facts, movement facts, and boundary ports against the serialized structure.
fn validate_roundabout_canonical(
    map: &GameMap,
    structure: &RoadStructure,
) -> PersistenceResult<()> {
    let RoadStructure::Roundabout {
        id,
        origin,
        size,
        footprint,
        ports,
    } = structure
    else {
        return Ok(());
    };

    // 1. Canonical ID.
    let expected_id = roundabout_structure_id(*size, *origin);
    if id != &expected_id {
        return Err(PersistenceError::InvalidRoadStructure {
            structure_id: id.to_string(),
            reason: RoadStructureError::NonCanonicalId,
        });
    }

    // 2. Canonical footprint.
    let template = roundabout_template(*size, *origin);
    if footprint.as_slice() != template.footprint.as_slice() {
        return Err(PersistenceError::InvalidRoadStructure {
            structure_id: id.to_string(),
            reason: RoadStructureError::NonCanonicalFootprint,
        });
    }

    // 3. Lane facts: all footprint tiles must have one_way == None and
    //    must not carry track (roundabout tiles are road/empty infrastructure,
    //    not track infrastructure).
    for point in footprint {
        if map
            .tile(*point)
            .is_some_and(|tile| tile.one_way.is_some() || tile.has_track)
        {
            return Err(PersistenceError::InvalidRoadStructure {
                structure_id: id.to_string(),
                reason: RoadStructureError::NonCanonicalLaneFacts,
            });
        }
    }

    // 4. Movement facts: kind and road_connections match the canonical state
    //    derived from the template + current boundary ports.
    let expected_ports = recapture_boundary_ports(map, &template);
    let mut expected_port_edges: BTreeMap<Point, Vec<Heading>> = BTreeMap::new();
    for port in &expected_ports {
        expected_port_edges
            .entry(port.point)
            .or_default()
            .push(port.edge);
    }
    for edges in expected_port_edges.values_mut() {
        edges.sort_by_key(|heading| heading_rank(*heading));
        edges.dedup();
    }
    for point in footprint {
        let Some(tile) = map.tile(*point) else {
            return Err(PersistenceError::InvalidRoadStructure {
                structure_id: id.to_string(),
                reason: RoadStructureError::NonCanonicalMovementFacts,
            });
        };
        let expected_kind = if template.circulation_tiles.contains(point) {
            "road"
        } else {
            "empty"
        };
        if tile.kind != expected_kind {
            return Err(PersistenceError::InvalidRoadStructure {
                structure_id: id.to_string(),
                reason: RoadStructureError::NonCanonicalMovementFacts,
            });
        }
        let expected_connections = expected_port_edges.get(point).cloned().unwrap_or_default();
        if tile.road_connections != expected_connections {
            return Err(PersistenceError::InvalidRoadStructure {
                structure_id: id.to_string(),
                reason: RoadStructureError::NonCanonicalMovementFacts,
            });
        }
    }

    // 5. Boundary ports match the canonical reconstruction. Compare the
    //    exact sorted vectors without deduplication — duplicate (point, edge)
    //    pairs are already rejected by the forward pass, and deduplicating
    //    only for validation could hide ports that remain observable to
    //    topology compilation (which iterates the original port list).
    let mut serialized_ports = ports.clone();
    serialized_ports.sort_by_key(|port| (port.point, port.edge, port.id.clone()));
    let mut reconstructed_ports = expected_ports;
    reconstructed_ports.sort_by_key(|port| (port.point, port.edge, port.id.clone()));
    if serialized_ports != reconstructed_ports {
        return Err(PersistenceError::InvalidRoadStructure {
            structure_id: id.to_string(),
            reason: RoadStructureError::NonCanonicalMovementFacts,
        });
    }

    Ok(())
}

/// Reconstruct every automatic junction by cloning the map, clearing all
/// automatic-junction structures and tile ownership, and running the
/// authoritative `refresh_all_automatic_junctions` on the clone. Compare the
/// reconstructed structures' IDs, footprints, and ports against the serialized
/// structures. Any mismatch indicates a forged or stale serialized junction.
fn validate_automatic_junction_reconstruction(snapshot: &GameSnapshot) -> PersistenceResult<()> {
    let serialized_junctions: Vec<&RoadStructure> = snapshot
        .map
        .road_structures
        .iter()
        .filter(|structure| structure.is_automatic_junction())
        .collect();

    // Always run reconstruction even when no junctions are serialized.
    // A blank map naturally reconstructs an empty set, but a crossroads map
    // with every serialized junction removed (and road_structure_id cleared)
    // must be rejected — the crossing would otherwise compile as ordinary
    // roads. Skipping reconstruction when the candidate claims no junctions
    // lets the corrupted snapshot control whether the canonical oracle runs.
    //
    // Clone the map and strip all automatic-junction state so the
    // reconstruction starts from the same authored-road baseline.
    let mut clone = snapshot.map.clone();
    let automatic_ids: BTreeSet<String> = snapshot
        .map
        .road_structures
        .iter()
        .filter(|structure| structure.is_automatic_junction())
        .map(|structure| structure.id().to_string())
        .collect();
    for tile in &mut clone.tiles {
        if tile
            .road_structure_id
            .as_ref()
            .is_some_and(|id| automatic_ids.contains(id))
        {
            tile.road_structure_id = None;
        }
    }
    clone
        .road_structures
        .retain(|structure| !structure.is_automatic_junction());

    // Rebuild automatic junctions from the authored-road state.
    crate::road::refresh_all_automatic_junctions(&mut clone).map_err(|_| {
        PersistenceError::InvalidRoadStructure {
            structure_id: String::new(),
            reason: RoadStructureError::AutomaticJunctionMismatch,
        }
    })?;

    let reconstructed_junctions: Vec<&RoadStructure> = clone
        .road_structures
        .iter()
        .filter(|structure| structure.is_automatic_junction())
        .collect();

    // The reconstructed set must match the serialized set exactly.
    if reconstructed_junctions.len() != serialized_junctions.len() {
        return Err(PersistenceError::InvalidRoadStructure {
            structure_id: String::new(),
            reason: RoadStructureError::AutomaticJunctionMismatch,
        });
    }

    let reconstructed_by_id: BTreeMap<&str, &RoadStructure> = reconstructed_junctions
        .iter()
        .map(|junction| (junction.id(), *junction))
        .collect();

    for serialized in &serialized_junctions {
        let Some(reconstructed) = reconstructed_by_id.get(serialized.id()) else {
            return Err(PersistenceError::InvalidRoadStructure {
                structure_id: serialized.id().to_string(),
                reason: RoadStructureError::AutomaticJunctionMismatch,
            });
        };
        if serialized.footprint() != reconstructed.footprint()
            || serialized.ports() != reconstructed.ports()
        {
            return Err(PersistenceError::InvalidRoadStructure {
                structure_id: serialized.id().to_string(),
                reason: RoadStructureError::AutomaticJunctionMismatch,
            });
        }
        // Per-tile invariant check: each footprint tile's kind, one_way,
        // has_track, road_connections, and road_structure_id must match the
        // reconstructed state. This closes the asymmetry with roundabout
        // validation, which checks lane facts and movement facts per tile.
        // Without this, a forged snapshot with correct junction footprints
        // and ports but wrong per-tile state would pass validation.
        for point in serialized.footprint() {
            let Some(serialized_tile) = snapshot.map.tile(*point) else {
                return Err(PersistenceError::InvalidRoadStructure {
                    structure_id: serialized.id().to_string(),
                    reason: RoadStructureError::AutomaticJunctionMismatch,
                });
            };
            let Some(reconstructed_tile) = clone.tile(*point) else {
                return Err(PersistenceError::InvalidRoadStructure {
                    structure_id: serialized.id().to_string(),
                    reason: RoadStructureError::AutomaticJunctionMismatch,
                });
            };
            if serialized_tile.kind != reconstructed_tile.kind
                || serialized_tile.one_way != reconstructed_tile.one_way
                || serialized_tile.has_track != reconstructed_tile.has_track
                || serialized_tile.road_connections != reconstructed_tile.road_connections
                || serialized_tile.road_structure_id != reconstructed_tile.road_structure_id
            {
                return Err(PersistenceError::InvalidRoadStructure {
                    structure_id: serialized.id().to_string(),
                    reason: RoadStructureError::AutomaticJunctionMismatch,
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
