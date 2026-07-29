//! Coverage for the remaining uncovered `persistence/map.rs` validation
//! branches: `finite_non_negative` (negative / not-finite), growth-action
//! footprint overflow / off-map, map tile-count mismatch, one-way axis /
//! duplicate / non-canonical-order / out-of-bounds / non-road /
//! non-reciprocal road-connection checks, and the full set of
//! `validate_structures` rejection branches.
//!
//! Each test builds a persistence-valid baseline snapshot (via the shared
//! fixtures) and then mutates a single field to exercise one rejection branch,
//! asserting the exact `PersistenceError`.

mod common;

use caelum_core::model::{GrowthAction, GrowthWave, Heading, Point, RoadPort, RoadStructure};
use caelum_core::{
    validate_snapshot, NumericError, PersistenceError, RoadStructureError, ScenarioError,
    SnapshotField, TileError,
};
use common::persistence_fixtures::{
    campaign_snapshot, paused_snapshot, road_with_structure, tile_index,
};

// ===========================================================================
// finite_non_negative — negative / not-finite growth-wave trigger times
// ===========================================================================

#[test]
fn negative_growth_wave_trigger_time_is_rejected() {
    let mut snapshot = campaign_snapshot();
    snapshot.scenario.growth_waves = vec![GrowthWave {
        id: "wave-1".to_string(),
        trigger_time: -1.0,
        message: "x".to_string(),
        applied: false,
        actions: vec![],
    }];
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidNumericValue {
            entity: None,
            field: SnapshotField::GrowthWaveTriggerTime,
            reason: NumericError::Negative,
        }
    );
}

#[test]
fn non_finite_growth_wave_trigger_time_is_rejected() {
    let mut snapshot = campaign_snapshot();
    snapshot.scenario.growth_waves = vec![GrowthWave {
        id: "wave-1".to_string(),
        trigger_time: f64::NAN,
        message: "x".to_string(),
        applied: false,
        actions: vec![],
    }];
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidNumericValue {
            entity: None,
            field: SnapshotField::GrowthWaveTriggerTime,
            reason: NumericError::NotFinite,
        }
    );
}

// ===========================================================================
// validate_growth_action — PlaceBuilding footprint overflow / off-map
// ===========================================================================

#[test]
fn place_building_footprint_overflow_is_rejected() {
    let mut snapshot = campaign_snapshot();
    // Origin at i32::MAX causes `origin.x + width` to overflow inside
    // `buildings::footprint`, which returns `None`.
    let overflow_origin = Point { x: i32::MAX, y: 0 };
    snapshot.scenario.growth_waves = vec![GrowthWave {
        id: "wave-1".to_string(),
        trigger_time: 100.0,
        message: "x".to_string(),
        applied: false,
        actions: vec![GrowthAction::PlaceBuilding {
            building_type: "smallHouse".to_string(),
            origin: overflow_origin,
            rotation: 0,
        }],
    }];
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidScenario {
            field: SnapshotField::GrowthWaveActions,
            reason: ScenarioError::ActionOutOfBounds {
                wave_id: "wave-1".to_string(),
                action_index: 0,
                point: overflow_origin,
            },
        }
    );
}

#[test]
fn place_building_footprint_tile_off_map_is_rejected() {
    let mut snapshot = campaign_snapshot();
    // smallHouse is 2 wide × 1 tall; at origin (27, 17) the footprint is
    // [(27, 17), (28, 17)] — (28, 17) is off-map (MAP_WIDTH == 28). The
    // `footprint` helper returns `Some` (no overflow), so the off-map check
    // fires on the second tile.
    snapshot.scenario.growth_waves = vec![GrowthWave {
        id: "wave-1".to_string(),
        trigger_time: 100.0,
        message: "x".to_string(),
        applied: false,
        actions: vec![GrowthAction::PlaceBuilding {
            building_type: "smallHouse".to_string(),
            origin: Point { x: 27, y: 17 },
            rotation: 0,
        }],
    }];
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidScenario {
            field: SnapshotField::GrowthWaveActions,
            reason: ScenarioError::ActionOutOfBounds {
                wave_id: "wave-1".to_string(),
                action_index: 0,
                point: Point { x: 28, y: 17 },
            },
        }
    );
}

// ===========================================================================
// validate_map — tile count and road-connection branches
// ===========================================================================

#[test]
fn wrong_tile_count_is_rejected() {
    let mut snapshot = paused_snapshot();
    snapshot.map.tiles.pop();
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidTile {
            tile_id: String::new(),
            reason: TileError::CountMismatch {
                expected: 504,
                actual: 503,
            },
        }
    );
}

#[test]
fn invalid_one_way_axis_is_rejected() {
    let mut snapshot = paused_snapshot();
    snapshot.map.tiles[0].kind = "road".to_string();
    snapshot.map.tiles[0].one_way = Some(Heading::East);
    snapshot.map.tiles[0].road_connections = vec![Heading::East, Heading::North];
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidTile {
            tile_id: "tile-0-0".to_string(),
            reason: TileError::InvalidOneWayAxis,
        }
    );
}

#[test]
fn duplicate_road_connection_is_rejected() {
    let mut snapshot = paused_snapshot();
    snapshot.map.tiles[0].kind = "road".to_string();
    snapshot.map.tiles[0].road_connections = vec![Heading::East, Heading::East];
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidTile {
            tile_id: "tile-0-0".to_string(),
            reason: TileError::DuplicateRoadConnection,
        }
    );
}

#[test]
fn non_canonical_road_connection_order_is_rejected() {
    let mut snapshot = paused_snapshot();
    snapshot.map.tiles[0].kind = "road".to_string();
    snapshot.map.tiles[0].road_connections = vec![Heading::West, Heading::East];
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidTile {
            tile_id: "tile-0-0".to_string(),
            reason: TileError::NonCanonicalRoadConnectionOrder,
        }
    );
}

#[test]
fn connection_out_of_bounds_is_rejected() {
    let mut snapshot = paused_snapshot();
    snapshot.map.tiles[0].kind = "road".to_string();
    // (0, 0) has no tile to the West — off-map.
    snapshot.map.tiles[0].road_connections = vec![Heading::West];
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidTile {
            tile_id: "tile-0-0".to_string(),
            reason: TileError::ConnectionOutOfBounds {
                heading: Heading::West,
            },
        }
    );
}

#[test]
fn connection_to_non_road_is_rejected() {
    let mut snapshot = paused_snapshot();
    snapshot.map.tiles[0].kind = "road".to_string();
    // tiles[1] at (1, 0) stays "empty".
    snapshot.map.tiles[0].road_connections = vec![Heading::East];
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidTile {
            tile_id: "tile-0-0".to_string(),
            reason: TileError::ConnectionToNonRoad {
                neighbor: Point { x: 1, y: 0 },
            },
        }
    );
}

#[test]
fn non_reciprocal_connection_is_rejected() {
    let mut snapshot = paused_snapshot();
    snapshot.map.tiles[0].kind = "road".to_string();
    snapshot.map.tiles[0].road_connections = vec![Heading::East];
    // Neighbor at (1, 0) is road but lacks the reciprocal West connection.
    snapshot.map.tiles[1].kind = "road".to_string();
    snapshot.map.tiles[1].road_connections = vec![];
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidTile {
            tile_id: "tile-0-0".to_string(),
            reason: TileError::NonReciprocalConnection {
                neighbor: Point { x: 1, y: 0 },
            },
        }
    );
}

// ===========================================================================
// validate_structures — id / footprint / port branches
// ===========================================================================

#[test]
fn duplicate_structure_id_is_rejected() {
    let mut snapshot = road_with_structure();
    let existing = snapshot.map.road_structures[0].clone();
    let id = existing.id().to_string();
    // A second structure with the same ID is reported as
    // `RoadStructureError::NonCanonicalId` (the structure-id uniqueness pass
    // treats a repeated ID as non-canonical rather than emitting a dedicated
    // "duplicate" variant).
    snapshot.map.road_structures.push(existing);
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidRoadStructure {
            structure_id: id,
            reason: RoadStructureError::NonCanonicalId,
        }
    );
}

#[test]
fn empty_structure_footprint_is_rejected() {
    let mut snapshot = paused_snapshot();
    snapshot
        .map
        .road_structures
        .push(RoadStructure::AutomaticJunction {
            id: "empty-junction".to_string(),
            footprint: vec![],
            ports: vec![],
        });
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidRoadStructure {
            structure_id: "empty-junction".to_string(),
            reason: RoadStructureError::EmptyFootprint,
        }
    );
}

#[test]
fn duplicate_footprint_point_is_rejected() {
    let mut snapshot = paused_snapshot();
    // The first footprint point must pass all per-point checks (road tile with
    // a matching road_structure_id) so the loop reaches the second, duplicate
    // point and trips the `local.insert` guard.
    let index = tile_index(&snapshot, 10, 10);
    snapshot.map.tiles[index].kind = "road".to_string();
    snapshot.map.tiles[index].road_structure_id = Some("dup-footprint-junction".to_string());
    snapshot
        .map
        .road_structures
        .push(RoadStructure::AutomaticJunction {
            id: "dup-footprint-junction".to_string(),
            footprint: vec![Point { x: 10, y: 10 }, Point { x: 10, y: 10 }],
            ports: vec![],
        });
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidRoadStructure {
            structure_id: "dup-footprint-junction".to_string(),
            reason: RoadStructureError::DuplicateFootprintPoint,
        }
    );
}

#[test]
fn overlapping_structure_footprint_is_rejected() {
    let mut snapshot = road_with_structure();
    // (6, 5) is part of the existing roundabout's footprint.
    snapshot
        .map
        .road_structures
        .push(RoadStructure::AutomaticJunction {
            id: "overlap-junction".to_string(),
            footprint: vec![Point { x: 6, y: 5 }, Point { x: 10, y: 10 }],
            ports: vec![],
        });
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidRoadStructure {
            structure_id: "overlap-junction".to_string(),
            reason: RoadStructureError::OverlappingFootprint,
        }
    );
}

#[test]
fn structure_footprint_point_off_map_is_rejected() {
    let mut snapshot = paused_snapshot();
    snapshot
        .map
        .road_structures
        .push(RoadStructure::AutomaticJunction {
            id: "offmap-junction".to_string(),
            footprint: vec![Point { x: 30, y: 30 }],
            ports: vec![],
        });
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidRoadStructure {
            structure_id: "offmap-junction".to_string(),
            reason: RoadStructureError::NonRoadFootprintTile,
        }
    );
}

#[test]
fn structure_footprint_tile_not_road_is_rejected() {
    let mut snapshot = paused_snapshot();
    // Tile at (10, 10) is "empty" by default.
    snapshot
        .map
        .road_structures
        .push(RoadStructure::AutomaticJunction {
            id: "not-road-junction".to_string(),
            footprint: vec![Point { x: 10, y: 10 }],
            ports: vec![],
        });
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidRoadStructure {
            structure_id: "not-road-junction".to_string(),
            reason: RoadStructureError::NonRoadFootprintTile,
        }
    );
}

#[test]
fn structure_tile_owner_mismatch_is_rejected() {
    let mut snapshot = paused_snapshot();
    // Make tile (10, 10) a bare road tile with no structure owner.
    let index = tile_index(&snapshot, 10, 10);
    snapshot.map.tiles[index].kind = "road".to_string();
    snapshot
        .map
        .road_structures
        .push(RoadStructure::AutomaticJunction {
            id: "mismatch-junction".to_string(),
            footprint: vec![Point { x: 10, y: 10 }],
            ports: vec![],
        });
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidRoadStructure {
            structure_id: "mismatch-junction".to_string(),
            reason: RoadStructureError::TileOwnerMismatch,
        }
    );
}

/// Find the index of the roundabout structure produced by `road_with_structure()`.
/// The fixture may also emit automatic junctions, so we cannot assume index 0.
fn roundabout_index(snapshot: &caelum_core::GameSnapshot) -> usize {
    snapshot
        .map
        .road_structures
        .iter()
        .position(|structure| matches!(structure, RoadStructure::Roundabout { .. }))
        .expect("fixture must contain a roundabout")
}

#[test]
fn duplicate_structure_port_id_is_rejected() {
    let mut snapshot = road_with_structure();
    let idx = roundabout_index(&snapshot);
    let id = snapshot.map.road_structures[idx].id().to_string();
    let footprint = snapshot.map.road_structures[idx].footprint().to_vec();
    // Replace the existing roundabout with a structure whose ports share an id.
    // The footprint tiles are already road with a matching road_structure_id,
    // so all footprint checks pass before the duplicate-port-id check fires.
    // Both port points are inside the footprint so the boundary-port check
    // does not preempt the duplicate-id check.
    let port_point = footprint[0];
    snapshot.map.road_structures[idx] = RoadStructure::AutomaticJunction {
        id,
        footprint,
        ports: vec![
            RoadPort {
                id: "dup-port".to_string(),
                point: port_point,
                edge: Heading::East,
                direction: None,
            },
            RoadPort {
                id: "dup-port".to_string(),
                point: port_point,
                edge: Heading::West,
                direction: None,
            },
        ],
    };
    let id = snapshot.map.road_structures[idx].id().to_string();
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidRoadStructure {
            structure_id: id,
            reason: RoadStructureError::DuplicatePortId,
        }
    );
}

#[test]
fn invalid_structure_boundary_port_is_rejected() {
    let mut snapshot = road_with_structure();
    let idx = roundabout_index(&snapshot);
    let id = snapshot.map.road_structures[idx].id().to_string();
    let footprint = snapshot.map.road_structures[idx].footprint().to_vec();
    // The port's point is not in the structure's footprint.
    snapshot.map.road_structures[idx] = RoadStructure::AutomaticJunction {
        id,
        footprint,
        ports: vec![RoadPort {
            id: "bad-port".to_string(),
            point: Point { x: 99, y: 99 },
            edge: Heading::East,
            direction: None,
        }],
    };
    let id = snapshot.map.road_structures[idx].id().to_string();
    assert_eq!(
        validate_snapshot(&snapshot).unwrap_err(),
        PersistenceError::InvalidRoadStructure {
            structure_id: id,
            reason: RoadStructureError::InvalidBoundaryPort,
        }
    );
}
