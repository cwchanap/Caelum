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
use serde::de::IntoDeserializer;
use serde::Deserialize;

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

/// Check a probed schema version against the current
/// [`SNAPSHOT_SCHEMA_VERSION`]. Returns `Ok(())` when it matches, or
/// [`PersistenceError::UnsupportedSchema`] with `actual` set to the probed
/// version (or `0` when the probe could not read one). This is the single
/// source of truth for the version-comparison step shared by the WASM and
/// Tauri host bridges; each host performs its own backend-specific probe
/// deserialization and then delegates the comparison here.
pub fn check_schema_version(actual: u16) -> Result<(), PersistenceError> {
    if actual != SNAPSHOT_SCHEMA_VERSION {
        return Err(PersistenceError::UnsupportedSchema {
            expected: SNAPSHOT_SCHEMA_VERSION,
            actual,
        });
    }
    Ok(())
}

/// Probe `schemaVersion` from a JSON value via [`SnapshotSchemaProbe`] and
/// check it with [`check_schema_version`]. If the probe cannot deserialize
/// (missing `schemaVersion`, wrong type, or truly malformed payload), `actual`
/// is `0` and the snapshot is rejected as unsupported. Hosts that use
/// `serde_json` (Tauri, core tests) call this directly; the WASM host probes
/// via `serde_wasm_bindgen` and calls [`check_schema_version`] with the
/// resulting version.
pub fn check_snapshot_schema(value: &serde_json::Value) -> Result<(), PersistenceError> {
    let actual = SnapshotSchemaProbe::deserialize(value.into_deserializer())
        .map(|probe| probe.schema_version)
        .unwrap_or(0);
    check_schema_version(actual)
}
