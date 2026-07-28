mod entities;
mod error;
mod map;
mod trips;

pub use error::{
    AssignmentError, DerivedStateError, EntityError, EntityKind, EntityRef, MapSize, ModeError,
    NumericError, OwnershipError, PersistenceError, PersistenceResult, RoadStructureError,
    RoadTopologyError, ScenarioError, SnapshotField, TileError,
};

use crate::model::GameSnapshot;
use crate::road_topology::RoadTopology;

fn validate_and_compile(snapshot: &GameSnapshot) -> PersistenceResult<RoadTopology> {
    let topology = map::validate_shell_rules_map_and_compile(snapshot)?;
    let indexes = entities::validate_entities(snapshot, &topology)?;
    trips::validate_trips(snapshot, &indexes)?;
    Ok(topology)
}

pub(crate) struct PreparedSnapshot {
    pub(crate) snapshot: GameSnapshot,
    pub(crate) road_topology: RoadTopology,
}

pub(crate) fn prepare_snapshot(snapshot: GameSnapshot) -> PersistenceResult<PreparedSnapshot> {
    let road_topology = validate_and_compile(&snapshot)?;
    Ok(PreparedSnapshot {
        snapshot,
        road_topology,
    })
}

pub fn validate_snapshot(snapshot: &GameSnapshot) -> PersistenceResult<()> {
    validate_and_compile(snapshot).map(drop)
}
