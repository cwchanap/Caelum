mod entities;
mod error;
mod map;
mod trips;

pub use error::SnapshotLoadError;
pub(crate) use error::{
    AssignmentError, DerivedStateError, EntityError, EntityKind, EntityRef, MapSize, ModeError,
    NumericError, OwnershipError, PersistenceError, PersistenceResult, RoadStructureError,
    ScenarioError, SnapshotField, TileError,
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

fn validate_and_compile(mut snapshot: GameSnapshot) -> PersistenceResult<PreparedSnapshot> {
    if snapshot.schema_version != SNAPSHOT_SCHEMA_VERSION {
        return Err(PersistenceError::UnsupportedSchema {
            expected: SNAPSHOT_SCHEMA_VERSION,
            actual: snapshot.schema_version,
        });
    }
    map::normalize_shell(&mut snapshot);
    let topology = map::validate_shell_rules_map_and_compile(&snapshot)?;
    // Validate only the references and ownership that normalization traverses.
    // The complete entity/trip checks run again below, after derived fields have
    // been rebuilt, so stale serialized caches do not decide loadability.
    entities::validate_entities_for_normalization(&snapshot, &topology)?;
    normalize_derived_fields(&mut snapshot, &topology);
    let indexes = entities::validate_entities(&snapshot, &topology)?;
    trips::validate_trips(&snapshot, &indexes)?;
    Ok(PreparedSnapshot {
        snapshot,
        road_topology: topology,
    })
}

pub(crate) struct PreparedSnapshot {
    pub(crate) snapshot: GameSnapshot,
    pub(crate) road_topology: RoadTopology,
}

pub(crate) fn prepare_snapshot(snapshot: GameSnapshot) -> PersistenceResult<PreparedSnapshot> {
    validate_and_compile(snapshot)
}

pub(crate) fn normalize_snapshot_for_save(snapshot: &mut GameSnapshot, topology: &RoadTopology) {
    map::normalize_shell(snapshot);
    normalize_derived_fields(snapshot, topology);
}

/// Rebuild the derived fields that both the save and load/compile paths share,
/// in one fixed order (trips before entities) so a save→load round trip is
/// deterministic regardless of which path produced the snapshot.
fn normalize_derived_fields(snapshot: &mut GameSnapshot, topology: &RoadTopology) {
    trips::normalize_direct_fields(snapshot);
    entities::normalize_direct_fields(snapshot, topology);
}

/// Check a probed schema version against the current
/// [`SNAPSHOT_SCHEMA_VERSION`]. Returns `Ok(())` when it matches, or
/// [`SnapshotLoadError::UnsupportedSchema`] with `actual` set to the probed
/// version (or `0` when the probe could not read one). This is the single
/// source of truth for the version-comparison step shared by the WASM and
/// Tauri host bridges; each host performs its own backend-specific probe
/// deserialization and then delegates the comparison here.
pub fn check_schema_version(actual: u16) -> Result<(), SnapshotLoadError> {
    if actual != SNAPSHOT_SCHEMA_VERSION {
        return Err(SnapshotLoadError::UnsupportedSchema {
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
pub fn check_snapshot_schema(value: &serde_json::Value) -> Result<(), SnapshotLoadError> {
    let actual = SnapshotSchemaProbe::deserialize(value.into_deserializer())
        .map(|probe| probe.schema_version)
        .unwrap_or(0);
    check_schema_version(actual)
}

#[cfg(test)]
mod tests {
    use super::{validate_and_compile, NumericError, PersistenceError, SnapshotField, TileError};
    use crate::engine::GameEngine;
    use crate::model::Point;

    fn paused_snapshot() -> crate::model::GameSnapshot {
        let mut snapshot = GameEngine::new().snapshot();
        snapshot.paused = true;
        snapshot
    }

    #[test]
    fn nonfinite_time_is_rejected_without_copying_it_into_context() {
        let mut snapshot = paused_snapshot();
        snapshot.time = f64::NAN;
        match validate_and_compile(snapshot) {
            Err(error) => assert_eq!(
                error,
                PersistenceError::InvalidNumericValue {
                    entity: None,
                    field: SnapshotField::Time,
                    reason: NumericError::NotFinite,
                }
            ),
            Ok(_) => panic!("nonfinite time should be rejected"),
        }
    }

    #[test]
    fn row_major_tile_drift_has_a_deterministic_first_error() {
        let mut snapshot = paused_snapshot();
        snapshot.map.tiles[0].x = 1;
        match validate_and_compile(snapshot) {
            Err(error) => assert_eq!(
                error,
                PersistenceError::InvalidTile {
                    tile_id: "tile-0-0".to_string(),
                    reason: TileError::WrongRowMajorCoordinate {
                        expected: Point { x: 0, y: 0 },
                        actual: Point { x: 1, y: 0 },
                    },
                }
            ),
            Ok(_) => panic!("row-major tile drift should be rejected"),
        }
    }
}
