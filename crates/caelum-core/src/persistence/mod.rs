mod entities;
mod error;
mod map;
mod trips;

pub use error::{
    AssignmentError, DerivedStateError, EntityError, EntityKind, EntityRef, MapSize, ModeError,
    NumericError, OwnershipError, PersistenceError, PersistenceResult, RoadStructureError,
    RoadTopologyError, ScenarioError, SnapshotField, TileError,
};

use crate::model::{GameSnapshot, SnapshotSchemaProbe, SNAPSHOT_SCHEMA_VERSION};
use crate::road_topology::RoadTopology;

/// Shared finite-and-non-negative validation for `f64` snapshot fields.
/// `entity` is `None` for shell/rules/scenario fields and `Some(_)` for
/// entity-scoped fields.
pub(super) fn finite_non_negative(
    entity: Option<EntityRef>,
    field: SnapshotField,
    value: f64,
) -> PersistenceResult<()> {
    if !value.is_finite() {
        return Err(PersistenceError::InvalidNumericValue {
            entity,
            field,
            reason: NumericError::NotFinite,
        });
    }
    if value < 0.0 {
        return Err(PersistenceError::InvalidNumericValue {
            entity,
            field,
            reason: NumericError::Negative,
        });
    }
    Ok(())
}

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

/// Load a `GameSnapshot` from a JSON value using the production two-phase
/// probe-then-deserialize path. The schema version is probed via
/// [`SnapshotSchemaProbe`] before the full `GameSnapshot` deserialization so a
/// legacy schema-v3 save (which lacks the required v4
/// `rules.sandbox.startingCapital` field) is rejected with a typed
/// [`PersistenceError::UnsupportedSchema`] instead of a generic missing-field
/// serde error. If the probe cannot read a schema version, `actual` is `0`.
/// A full-deserialization failure after the schema check passes is also
/// surfaced as `UnsupportedSchema { actual: 0 }` so callers see one consistent
/// typed error shape.
pub fn load_snapshot_from_json(value: serde_json::Value) -> PersistenceResult<GameSnapshot> {
    let probe_schema_version = serde_json::from_value::<SnapshotSchemaProbe>(value.clone())
        .map(|probe| probe.schema_version)
        .unwrap_or(0);
    if probe_schema_version != SNAPSHOT_SCHEMA_VERSION {
        return Err(PersistenceError::UnsupportedSchema {
            expected: SNAPSHOT_SCHEMA_VERSION,
            actual: probe_schema_version,
        });
    }
    serde_json::from_value(value).map_err(|_| PersistenceError::UnsupportedSchema {
        expected: SNAPSHOT_SCHEMA_VERSION,
        actual: 0,
    })
}
