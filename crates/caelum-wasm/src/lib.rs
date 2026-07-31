use caelum_core::{
    check_schema_version, validate_snapshot, GameEngine, GameIntent, GameSnapshot,
    PersistenceError, PreparedEngineRestore, RoadMutationPreviewRequest, RoutePreviewRequest,
    SandboxCreationRequest, SnapshotSchemaProbe,
};
use serde::Serialize;
use wasm_bindgen::prelude::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum PersistenceOperation {
    SnapshotForSave,
    ValidateSnapshot,
    RestoreSnapshot,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum PersistenceValidationSource {
    ActiveEngine,
    Candidate,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum PersistenceSerializationPhase {
    SnapshotDecode,
    SnapshotEncode,
}

#[allow(dead_code)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum PersistenceHostErrorCode {
    StateUnavailable,
    InvokeFailed,
    MalformedSuccess,
    MalformedError,
}

#[derive(Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum PersistenceBridgeError {
    Validation {
        operation: PersistenceOperation,
        source: PersistenceValidationSource,
        error: PersistenceError,
    },
    Serialization {
        operation: PersistenceOperation,
        phase: PersistenceSerializationPhase,
        diagnostic: String,
    },
    Host {
        operation: PersistenceOperation,
        code: PersistenceHostErrorCode,
        diagnostic: String,
    },
}

fn validation_error(
    operation: PersistenceOperation,
    source: PersistenceValidationSource,
    error: PersistenceError,
) -> PersistenceBridgeError {
    PersistenceBridgeError::Validation {
        operation,
        source,
        error,
    }
}

fn serialization_error(
    operation: PersistenceOperation,
    phase: PersistenceSerializationPhase,
    error: impl std::fmt::Display,
) -> PersistenceBridgeError {
    PersistenceBridgeError::Serialization {
        operation,
        phase,
        diagnostic: error.to_string(),
    }
}

#[allow(dead_code)]
fn host_error(
    operation: PersistenceOperation,
    code: PersistenceHostErrorCode,
    diagnostic: impl Into<String>,
) -> PersistenceBridgeError {
    PersistenceBridgeError::Host {
        operation,
        code,
        diagnostic: diagnostic.into(),
    }
}

fn persistence_serializer() -> serde_wasm_bindgen::Serializer {
    serde_wasm_bindgen::Serializer::json_compatible().serialize_large_number_types_as_bigints(false)
}

fn to_persistence_js_value<T: Serialize + ?Sized>(
    value: &T,
) -> Result<JsValue, serde_wasm_bindgen::Error> {
    value.serialize(&persistence_serializer())
}

fn encode_bridge_error_or_fallback<T, E>(
    error: &PersistenceBridgeError,
    encode: impl FnOnce(&PersistenceBridgeError) -> Result<T, E>,
    fallback: impl FnOnce() -> T,
) -> T {
    encode(error).unwrap_or_else(|_encode_error| fallback())
}

fn persistence_js_error(error: PersistenceBridgeError) -> JsValue {
    encode_bridge_error_or_fallback(&error, to_persistence_js_value, || {
        JsValue::from_str("persistence bridge error serialization failed")
    })
}

fn validation_js_error(
    operation: PersistenceOperation,
    source: PersistenceValidationSource,
    error: PersistenceError,
) -> JsValue {
    persistence_js_error(validation_error(operation, source, error))
}

fn decode_snapshot_with<T, ProbeError, DecodeError>(
    value: T,
    operation: PersistenceOperation,
    probe: impl FnOnce(&T) -> Result<SnapshotSchemaProbe, ProbeError>,
    decode: impl FnOnce(T) -> Result<GameSnapshot, DecodeError>,
) -> Result<GameSnapshot, PersistenceBridgeError>
where
    DecodeError: std::fmt::Display,
{
    let actual = probe(&value).map(|probe| probe.schema_version).unwrap_or(0);
    check_schema_version(actual).map_err(|error| {
        validation_error(operation, PersistenceValidationSource::Candidate, error)
    })?;
    decode(value).map_err(|error| {
        serialization_error(
            operation,
            PersistenceSerializationPhase::SnapshotDecode,
            error,
        )
    })
}

fn decode_snapshot(
    value: JsValue,
    operation: PersistenceOperation,
) -> Result<GameSnapshot, JsValue> {
    decode_snapshot_with(
        value,
        operation,
        |value| serde_wasm_bindgen::from_value::<SnapshotSchemaProbe>(value.clone()),
        serde_wasm_bindgen::from_value::<GameSnapshot>,
    )
    .map_err(persistence_js_error)
}

fn validate_candidate(
    snapshot: &GameSnapshot,
    operation: PersistenceOperation,
) -> Result<(), PersistenceBridgeError> {
    validate_snapshot(snapshot)
        .map_err(|error| validation_error(operation, PersistenceValidationSource::Candidate, error))
}

fn prepare_snapshot_for_save(engine: &GameEngine) -> Result<GameSnapshot, PersistenceBridgeError> {
    engine.snapshot_for_save().map_err(|error| {
        validation_error(
            PersistenceOperation::SnapshotForSave,
            PersistenceValidationSource::ActiveEngine,
            error,
        )
    })
}

fn encode_snapshot<T, E>(
    snapshot: &GameSnapshot,
    operation: PersistenceOperation,
    encode: impl FnOnce(&GameSnapshot) -> Result<T, E>,
) -> Result<T, PersistenceBridgeError>
where
    E: std::fmt::Display,
{
    encode(snapshot).map_err(|error| {
        serialization_error(
            operation,
            PersistenceSerializationPhase::SnapshotEncode,
            error,
        )
    })
}

fn encode_prepared_restore<T, E>(
    prepared: PreparedEngineRestore,
    encode: impl FnOnce(&GameSnapshot) -> Result<T, E>,
) -> Result<(T, GameEngine), E> {
    let encoded = encode(prepared.snapshot())?;
    Ok((encoded, prepared.into_engine()))
}

#[wasm_bindgen]
pub struct WasmGameEngine {
    inner: GameEngine,
}

impl Default for WasmGameEngine {
    fn default() -> Self {
        Self::new()
    }
}

#[wasm_bindgen]
impl WasmGameEngine {
    #[wasm_bindgen(constructor)]
    pub fn new() -> WasmGameEngine {
        WasmGameEngine {
            inner: GameEngine::new(),
        }
    }

    pub fn from_sandbox_request(request: JsValue) -> Result<WasmGameEngine, JsValue> {
        let request: SandboxCreationRequest =
            serde_wasm_bindgen::from_value(request).map_err(to_js_error)?;
        let inner = GameEngine::from_sandbox_request(request)
            .map_err(|error| serde_wasm_bindgen::to_value(&error).unwrap_or_else(to_js_error))?;
        Ok(WasmGameEngine { inner })
    }

    pub fn snapshot(&self) -> Result<JsValue, JsValue> {
        serde_wasm_bindgen::to_value(&self.inner.snapshot()).map_err(to_js_error)
    }

    pub fn snapshot_for_save(&self) -> Result<JsValue, JsValue> {
        let snapshot = prepare_snapshot_for_save(&self.inner).map_err(persistence_js_error)?;
        encode_snapshot(
            &snapshot,
            PersistenceOperation::SnapshotForSave,
            to_persistence_js_value,
        )
        .map_err(persistence_js_error)
    }

    pub fn validate_snapshot(&self, snapshot: JsValue) -> Result<(), JsValue> {
        let operation = PersistenceOperation::ValidateSnapshot;
        let snapshot = decode_snapshot(snapshot, operation)?;
        validate_candidate(&snapshot, operation).map_err(persistence_js_error)
    }

    pub fn restore_snapshot(&mut self, snapshot: JsValue) -> Result<JsValue, JsValue> {
        let operation = PersistenceOperation::RestoreSnapshot;
        let snapshot = decode_snapshot(snapshot, operation)?;
        let prepared = GameEngine::prepare_restore(snapshot).map_err(|error| {
            validation_js_error(operation, PersistenceValidationSource::Candidate, error)
        })?;
        let (encoded, engine) = encode_prepared_restore(prepared, |snapshot| {
            encode_snapshot(snapshot, operation, to_persistence_js_value)
        })
        .map_err(persistence_js_error)?;
        self.inner = engine;
        Ok(encoded)
    }

    pub fn dispatch(&mut self, intent: JsValue) -> Result<JsValue, JsValue> {
        let intent: GameIntent = serde_wasm_bindgen::from_value(intent).map_err(to_js_error)?;
        serde_wasm_bindgen::to_value(&self.inner.dispatch(intent)).map_err(to_js_error)
    }

    pub fn tick(&mut self, delta_seconds: f64) -> Result<JsValue, JsValue> {
        serde_wasm_bindgen::to_value(&self.inner.tick(delta_seconds)).map_err(to_js_error)
    }

    pub fn reset(&mut self) -> Result<JsValue, JsValue> {
        let snapshot = self
            .inner
            .reset()
            .map_err(|error| serde_wasm_bindgen::to_value(&error).unwrap_or_else(to_js_error))?;
        serde_wasm_bindgen::to_value(&snapshot).map_err(to_js_error)
    }

    pub fn preview_route(&self, request: JsValue) -> Result<JsValue, JsValue> {
        let request: RoutePreviewRequest =
            serde_wasm_bindgen::from_value(request).map_err(to_js_error)?;
        serde_wasm_bindgen::to_value(&self.inner.preview_route(request)).map_err(to_js_error)
    }

    pub fn preview_road_mutation(&self, request: JsValue) -> Result<JsValue, JsValue> {
        let request: RoadMutationPreviewRequest =
            serde_wasm_bindgen::from_value(request).map_err(to_js_error)?;
        serde_wasm_bindgen::to_value(&self.inner.preview_road_mutation(request))
            .map_err(to_js_error)
    }
}

fn to_js_error(error: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use caelum_core::{PersistenceError, SnapshotField};
    use serde_json::{json, Value};

    const VALID_SNAPSHOT: &str =
        include_str!("../../../tests/fixtures/persistence/valid-paused.json");
    const UNPAUSED_SNAPSHOT: &str =
        include_str!("../../../tests/fixtures/persistence/unpaused.json");
    const MALFORMED_SNAPSHOT: &str =
        include_str!("../../../tests/fixtures/persistence/malformed-current-schema.json");

    fn decode_json(
        value: Value,
        operation: PersistenceOperation,
    ) -> Result<GameSnapshot, PersistenceBridgeError> {
        decode_snapshot_with(
            value,
            operation,
            |value| serde_json::from_value::<SnapshotSchemaProbe>(value.clone()),
            serde_json::from_value::<GameSnapshot>,
        )
    }

    fn error_json(error: PersistenceBridgeError) -> Value {
        serde_json::to_value(error).expect("bridge error must serialize")
    }

    #[test]
    fn bridge_validation_error_has_the_exact_public_json_shape() {
        let error = validation_error(
            PersistenceOperation::RestoreSnapshot,
            PersistenceValidationSource::Candidate,
            PersistenceError::UnsupportedSchema {
                expected: 4,
                actual: 3,
            },
        );

        assert_eq!(
            error_json(error),
            json!({
                "kind": "validation",
                "operation": "restoreSnapshot",
                "source": "candidate",
                "error": {
                    "code": "unsupportedSchema",
                    "context": {
                        "expected": 4,
                        "actual": 3
                    }
                }
            })
        );
    }

    #[test]
    fn unsupported_schema_is_candidate_validation_before_full_decode() {
        let error = decode_json(
            json!({
                "schemaVersion": 3,
                "map": {
                    "tiles": "the legacy body is intentionally not schema-v4"
                }
            }),
            PersistenceOperation::ValidateSnapshot,
        )
        .expect_err("schema mismatch must win over body decoding");

        assert_eq!(
            error_json(error),
            json!({
                "kind": "validation",
                "operation": "validateSnapshot",
                "source": "candidate",
                "error": {
                    "code": "unsupportedSchema",
                    "context": {
                        "expected": 4,
                        "actual": 3
                    }
                }
            })
        );
    }

    #[test]
    fn malformed_current_schema_is_snapshot_decode_serialization() {
        let value = serde_json::from_str(MALFORMED_SNAPSHOT).expect("fixture must be JSON");
        let error = decode_json(value, PersistenceOperation::RestoreSnapshot)
            .expect_err("matching-schema malformed body must fail full decode");
        let value = error_json(error);

        assert_eq!(value["kind"], "serialization");
        assert_eq!(value["operation"], "restoreSnapshot");
        assert_eq!(value["phase"], "snapshotDecode");
        assert!(
            value["diagnostic"]
                .as_str()
                .is_some_and(|diagnostic| diagnostic.contains("invalid type")),
            "unexpected diagnostic: {}",
            value["diagnostic"]
        );
    }

    #[test]
    fn unpaused_snapshot_is_semantic_candidate_validation() {
        let value = serde_json::from_str(UNPAUSED_SNAPSHOT).expect("fixture must be JSON");
        let snapshot = decode_json(value, PersistenceOperation::ValidateSnapshot)
            .expect("unpaused fixture must fully deserialize");
        let error =
            validate_candidate(&snapshot, PersistenceOperation::ValidateSnapshot).unwrap_err();

        assert_eq!(
            error_json(error),
            json!({
                "kind": "validation",
                "operation": "validateSnapshot",
                "source": "candidate",
                "error": {
                    "code": "invalidModeSettings",
                    "context": {
                        "field": "paused",
                        "reason": {
                            "kind": "persistenceRequiresPaused"
                        }
                    }
                }
            })
        );
    }

    #[test]
    fn invalid_active_engine_save_is_active_engine_validation() {
        let mut engine = GameEngine::new();
        engine.set_budget_for_test(-1);

        let error = prepare_snapshot_for_save(&engine).unwrap_err();

        assert_eq!(
            error_json(error),
            json!({
                "kind": "validation",
                "operation": "snapshotForSave",
                "source": "activeEngine",
                "error": {
                    "code": "invalidNumericValue",
                    "context": {
                        "field": "budget",
                        "reason": {
                            "kind": "negative"
                        }
                    }
                }
            })
        );
    }

    #[test]
    fn snapshot_encode_failure_has_the_exact_serialization_shape() {
        let snapshot: GameSnapshot =
            serde_json::from_str(VALID_SNAPSHOT).expect("valid fixture must decode");
        let error = encode_snapshot(
            &snapshot,
            PersistenceOperation::SnapshotForSave,
            |_snapshot| Err::<(), _>("synthetic encode failure"),
        )
        .unwrap_err();

        assert_eq!(
            error_json(error),
            json!({
                "kind": "serialization",
                "operation": "snapshotForSave",
                "phase": "snapshotEncode",
                "diagnostic": "synthetic encode failure"
            })
        );
    }

    #[test]
    fn every_bridge_error_variant_carries_its_operation() {
        let errors = [
            validation_error(
                PersistenceOperation::ValidateSnapshot,
                PersistenceValidationSource::Candidate,
                PersistenceError::InvalidModeSettings {
                    field: SnapshotField::Paused,
                    reason: caelum_core::ModeError::PersistenceRequiresPaused,
                },
            ),
            serialization_error(
                PersistenceOperation::RestoreSnapshot,
                PersistenceSerializationPhase::SnapshotDecode,
                "decode failed",
            ),
            host_error(
                PersistenceOperation::SnapshotForSave,
                PersistenceHostErrorCode::StateUnavailable,
                "state unavailable",
            ),
        ];

        let operations: Vec<_> = errors
            .into_iter()
            .map(error_json)
            .map(|value| value["operation"].clone())
            .collect();
        assert_eq!(
            operations,
            vec![
                json!("validateSnapshot"),
                json!("restoreSnapshot"),
                json!("snapshotForSave")
            ]
        );
    }

    #[test]
    fn failed_bridge_error_encoding_returns_only_the_opaque_fallback() {
        let error = serialization_error(
            PersistenceOperation::RestoreSnapshot,
            PersistenceSerializationPhase::SnapshotEncode,
            "snapshot encode failed",
        );

        let encoded = encode_bridge_error_or_fallback(
            &error,
            |_error| Err::<String, _>("bridge encoding failed"),
            || "opaque persistence bridge failure".to_string(),
        );

        assert_eq!(encoded, "opaque persistence bridge failure");
    }

    #[test]
    fn failed_prepared_restore_encoding_returns_no_engine() {
        let snapshot: GameSnapshot =
            serde_json::from_str(VALID_SNAPSHOT).expect("valid fixture must decode");
        let prepared = GameEngine::prepare_restore(snapshot).expect("fixture must prepare");

        let result: Result<((), GameEngine), &str> =
            encode_prepared_restore(prepared, |_snapshot| Err("encode failed"));

        assert!(matches!(result, Err("encode failed")));
    }

    #[test]
    fn prepared_restore_is_assigned_only_after_exact_snapshot_encoding_succeeds() {
        let mut source = GameEngine::new();
        assert!(source.dispatch(GameIntent::SetSpeed { speed: 2 }).applied);
        let candidate = source.snapshot_for_save().expect("source must save");
        let mut target = GameEngine::new();
        let before = target.snapshot();

        let failed = encode_prepared_restore(
            GameEngine::prepare_restore(candidate.clone()).expect("candidate must prepare"),
            |_snapshot| Err::<(), _>("encode failed"),
        );
        assert!(failed.is_err());
        assert_eq!(target.snapshot(), before);

        let (encoded, prepared_engine) = encode_prepared_restore(
            GameEngine::prepare_restore(candidate.clone()).expect("candidate must prepare"),
            |snapshot| Ok::<_, &str>(snapshot.clone()),
        )
        .expect("encoding must succeed");
        assert_eq!(encoded, candidate);
        assert_eq!(target.snapshot(), before);

        target = prepared_engine;
        assert_eq!(target.snapshot(), candidate);
    }
}
