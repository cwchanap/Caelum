use std::sync::Mutex;

use serde::Serialize;

use caelum_core::{
    check_snapshot_schema, validate_snapshot, DispatchResult, GameEngine, GameIntent, GameSnapshot,
    PersistenceError, RoadMutationPreviewRequest, RoadMutationPreviewResponse, RoutePreviewRequest,
    RoutePreviewResponse, SandboxCreationError, SandboxCreationRequest, SandboxResetError,
    SaveSnapshotCapture,
};
use tauri::State;

type EngineState = Mutex<GameEngine>;

/// Wire-format contract for Tauri command errors.
///
/// Uses `#[serde(untagged)]` so that `Domain(E)` serializes as `E`'s JSON
/// representation (a structured object with `code`/`context` fields) and
/// `Host(String)` serializes as a plain JSON string. Frontend consumers
/// discriminate between the two by `typeof error === "string"` (host) vs
/// `typeof error === "object" && error.code !== undefined` (domain). This
/// matches the existing `shared.ts` normalization layer, which handles both
/// shapes. Changing to explicit tagged variants would be a wire-format break
/// requiring frontend consumer updates; the typeof-based contract is
/// intentional and documented here.
#[derive(Serialize)]
#[serde(untagged)]
enum TauriCommandError<E> {
    Domain(E),
    Host(String),
}

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

#[derive(Debug, Serialize)]
#[serde(untagged)]
enum EncodedPersistenceBridgeError {
    Structured(serde_json::Value),
    Opaque(String),
}

impl PersistenceBridgeError {
    fn validation(
        operation: PersistenceOperation,
        source: PersistenceValidationSource,
        error: PersistenceError,
    ) -> Self {
        Self::Validation {
            operation,
            source,
            error,
        }
    }

    fn serialization(
        operation: PersistenceOperation,
        phase: PersistenceSerializationPhase,
        diagnostic: impl ToString,
    ) -> Self {
        Self::Serialization {
            operation,
            phase,
            diagnostic: diagnostic.to_string(),
        }
    }

    fn host(
        operation: PersistenceOperation,
        code: PersistenceHostErrorCode,
        diagnostic: impl ToString,
    ) -> Self {
        Self::Host {
            operation,
            code,
            diagnostic: diagnostic.to_string(),
        }
    }
}

fn encode_persistence_result_with<T, E>(
    result: Result<T, PersistenceBridgeError>,
    encode_error: impl FnOnce(&PersistenceBridgeError) -> Result<serde_json::Value, E>,
) -> Result<T, EncodedPersistenceBridgeError>
where
    E: std::fmt::Display,
{
    result.map_err(|error| match encode_error(&error) {
        Ok(encoded) => EncodedPersistenceBridgeError::Structured(encoded),
        Err(encoding_error) => EncodedPersistenceBridgeError::Opaque(format!(
            "persistence bridge error encoding failed: {encoding_error}"
        )),
    })
}

fn encode_persistence_result<T>(
    result: Result<T, PersistenceBridgeError>,
) -> Result<T, EncodedPersistenceBridgeError> {
    encode_persistence_result_with(result, |error| serde_json::to_value(error))
}

fn state_unavailable(
    operation: PersistenceOperation,
    error: impl ToString,
) -> PersistenceBridgeError {
    PersistenceBridgeError::host(operation, PersistenceHostErrorCode::StateUnavailable, error)
}

fn decode_snapshot(
    value: serde_json::Value,
    operation: PersistenceOperation,
) -> Result<GameSnapshot, PersistenceBridgeError> {
    check_snapshot_schema(&value).map_err(|error| {
        PersistenceBridgeError::validation(operation, PersistenceValidationSource::Candidate, error)
    })?;
    serde_json::from_value(value).map_err(|error| {
        PersistenceBridgeError::serialization(
            operation,
            PersistenceSerializationPhase::SnapshotDecode,
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
        PersistenceBridgeError::serialization(
            operation,
            PersistenceSerializationPhase::SnapshotEncode,
            error,
        )
    })
}

fn capture_save(state: &EngineState) -> Result<SaveSnapshotCapture, PersistenceBridgeError> {
    let engine = state
        .lock()
        .map_err(|error| state_unavailable(PersistenceOperation::SnapshotForSave, error))?;
    Ok(engine.capture_snapshot_for_save())
}

fn restore_snapshot_with<T, E>(
    state: &EngineState,
    snapshot: serde_json::Value,
    encode: impl FnOnce(&GameSnapshot) -> Result<T, E>,
) -> Result<T, PersistenceBridgeError>
where
    E: std::fmt::Display,
{
    let operation = PersistenceOperation::RestoreSnapshot;
    let snapshot = decode_snapshot(snapshot, operation)?;
    let prepared = GameEngine::prepare_restore(snapshot).map_err(|error| {
        PersistenceBridgeError::validation(operation, PersistenceValidationSource::Candidate, error)
    })?;
    let encoded = encode_snapshot(prepared.snapshot(), operation, encode)?;
    let mut engine = state
        .lock()
        .map_err(|error| state_unavailable(operation, error))?;
    *engine = prepared.into_engine();
    Ok(encoded)
}

#[tauri::command]
fn game_snapshot(state: State<'_, EngineState>) -> Result<GameSnapshot, String> {
    let engine = state.lock().map_err(|error| error.to_string())?;
    Ok(engine.snapshot())
}

#[tauri::command]
fn game_dispatch(
    state: State<'_, EngineState>,
    intent: GameIntent,
) -> Result<DispatchResult, String> {
    let mut engine = state.lock().map_err(|error| error.to_string())?;
    Ok(engine.dispatch(intent))
}

#[tauri::command]
fn game_tick(state: State<'_, EngineState>, delta_seconds: f64) -> Result<DispatchResult, String> {
    let mut engine = state.lock().map_err(|error| error.to_string())?;
    Ok(engine.tick(delta_seconds))
}

#[tauri::command]
fn game_create_sandbox(
    state: State<'_, EngineState>,
    request: SandboxCreationRequest,
) -> Result<GameSnapshot, TauriCommandError<SandboxCreationError>> {
    let candidate = GameEngine::from_sandbox_request(request).map_err(TauriCommandError::Domain)?;
    let snapshot = candidate.snapshot();
    let mut engine = state
        .lock()
        .map_err(|error| TauriCommandError::Host(error.to_string()))?;
    *engine = candidate;
    Ok(snapshot)
}

#[tauri::command]
fn game_reset(
    state: State<'_, EngineState>,
) -> Result<GameSnapshot, TauriCommandError<SandboxResetError>> {
    let mut engine = state
        .lock()
        .map_err(|error| TauriCommandError::Host(error.to_string()))?;
    engine.reset().map_err(TauriCommandError::Domain)
}

fn snapshot_for_save_body(
    state: &EngineState,
) -> Result<serde_json::Value, PersistenceBridgeError> {
    let capture = capture_save(state)?;
    let snapshot = capture.prepare().map_err(|error| {
        PersistenceBridgeError::validation(
            PersistenceOperation::SnapshotForSave,
            PersistenceValidationSource::ActiveEngine,
            error,
        )
    })?;
    encode_snapshot(
        &snapshot,
        PersistenceOperation::SnapshotForSave,
        |snapshot| serde_json::to_value(snapshot),
    )
}

#[tauri::command]
fn game_snapshot_for_save(
    state: State<'_, EngineState>,
) -> Result<serde_json::Value, EncodedPersistenceBridgeError> {
    encode_persistence_result(snapshot_for_save_body(&state))
}

fn validate_snapshot_body(snapshot: serde_json::Value) -> Result<(), PersistenceBridgeError> {
    let operation = PersistenceOperation::ValidateSnapshot;
    let snapshot = decode_snapshot(snapshot, operation)?;
    validate_snapshot(&snapshot).map_err(|error| {
        PersistenceBridgeError::validation(operation, PersistenceValidationSource::Candidate, error)
    })
}

#[tauri::command]
fn game_validate_snapshot(
    snapshot: serde_json::Value,
) -> Result<(), EncodedPersistenceBridgeError> {
    encode_persistence_result(validate_snapshot_body(snapshot))
}

#[tauri::command]
fn game_restore_snapshot(
    state: State<'_, EngineState>,
    snapshot: serde_json::Value,
) -> Result<serde_json::Value, EncodedPersistenceBridgeError> {
    encode_persistence_result(restore_snapshot_with(&state, snapshot, |snapshot| {
        serde_json::to_value(snapshot)
    }))
}

#[tauri::command]
fn game_preview_route(
    state: State<'_, EngineState>,
    request: RoutePreviewRequest,
) -> Result<RoutePreviewResponse, String> {
    let engine = state.lock().map_err(|error| error.to_string())?;
    Ok(engine.preview_route(request))
}

#[tauri::command]
fn game_preview_road_mutation(
    state: State<'_, EngineState>,
    request: RoadMutationPreviewRequest,
) -> Result<RoadMutationPreviewResponse, String> {
    let engine = state.lock().map_err(|error| error.to_string())?;
    Ok(engine.preview_road_mutation(request))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Mutex::new(GameEngine::new()))
        .invoke_handler(tauri::generate_handler![
            game_snapshot,
            game_dispatch,
            game_tick,
            game_create_sandbox,
            game_reset,
            game_snapshot_for_save,
            game_validate_snapshot,
            game_restore_snapshot,
            game_preview_route,
            game_preview_road_mutation
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use caelum_core::model::{GameMode, Point};
    use caelum_core::{canonical_default_request, create_sandbox_snapshot};
    use serde_json::{json, Value};
    use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody};
    use tauri::test::{get_ipc_response, MockRuntime, INVOKE_KEY};
    use tauri::webview::InvokeRequest;
    use tauri::{App, Manager, Webview, WebviewWindow};

    fn sandbox_test_app(engine: GameEngine) -> App<MockRuntime> {
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        for command in [
            "game_create_sandbox",
            "game_reset",
            "game_snapshot",
            "game_snapshot_for_save",
            "game_validate_snapshot",
            "game_restore_snapshot",
            "game_dispatch",
        ] {
            context.runtime_authority_mut().__allow_command(
                command.to_string(),
                tauri::utils::acl::ExecutionContext::Local,
            );
        }
        tauri::test::mock_builder()
            .manage(Mutex::new(engine))
            .invoke_handler(tauri::generate_handler![
                game_create_sandbox,
                game_reset,
                game_snapshot,
                game_snapshot_for_save,
                game_validate_snapshot,
                game_restore_snapshot,
                game_dispatch
            ])
            .build(context)
            .expect("test Tauri app should build")
    }

    fn test_webview(app: &App<MockRuntime>) -> WebviewWindow<MockRuntime> {
        tauri::WebviewWindowBuilder::new(app, "main", Default::default())
            .build()
            .expect("test webview should build")
    }

    fn ipc<W: AsRef<Webview<MockRuntime>>>(
        webview: &W,
        command: &str,
        body: InvokeBody,
    ) -> Result<InvokeResponseBody, Value> {
        get_ipc_response(
            webview,
            InvokeRequest {
                cmd: command.into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: "tauri://localhost".parse().unwrap(),
                body,
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        )
    }

    fn sandbox_request_body(request: &Value) -> InvokeBody {
        InvokeBody::Json(json!({ "request": request }))
    }

    fn persistence_snapshot_body(snapshot: &Value) -> InvokeBody {
        InvokeBody::Json(json!({ "snapshot": snapshot }))
    }

    fn dispatch_body(intent: Value) -> InvokeBody {
        InvokeBody::Json(json!({ "intent": intent }))
    }

    fn decode_snapshot_response(response: InvokeResponseBody) -> GameSnapshot {
        response
            .deserialize()
            .expect("successful IPC response should decode to GameSnapshot")
    }

    fn decode_dispatch_result(response: InvokeResponseBody) -> DispatchResult {
        response
            .deserialize()
            .expect("successful IPC response should decode to DispatchResult")
    }

    #[test]
    fn restored_creative_snapshot_dispatch_matches_direct_core_oracle() {
        let mut snapshot = GameEngine::new().snapshot();
        snapshot.paused = true;
        snapshot.budget = 0;
        snapshot.rules.economy_preset = caelum_core::model::EconomyPreset::Creative;
        let snapshot_value = serde_json::to_value(&snapshot).expect("snapshot serializes");
        let direct_snapshot =
            serde_json::from_value(snapshot_value.clone()).expect("snapshot JSON should decode");
        let mut direct = GameEngine::from_snapshot(direct_snapshot)
            .expect("Creative snapshot should restore directly");
        let expected = direct.dispatch(GameIntent::LayRoad {
            point: Point { x: 2, y: 2 },
        });

        let app = sandbox_test_app(GameEngine::new());
        let webview = test_webview(&app);
        let loaded = ipc(
            &webview,
            "game_restore_snapshot",
            persistence_snapshot_body(&snapshot_value),
        )
        .expect("Creative snapshot should load through IPC");
        assert_eq!(decode_snapshot_response(loaded), snapshot);

        let actual = ipc(
            &webview,
            "game_dispatch",
            dispatch_body(json!({
                "type": "layRoad",
                "point": { "x": 2, "y": 2 }
            })),
        )
        .expect("Creative road should dispatch through IPC");
        let actual = decode_dispatch_result(actual);

        assert_eq!(actual, expected);
        assert!(actual.applied);
        assert_eq!(actual.context.cost, 100);
        assert_eq!(actual.snapshot.budget, 0);
        assert_eq!(
            actual.snapshot.rules.economy_preset,
            caelum_core::model::EconomyPreset::Creative
        );
        assert_eq!(
            actual
                .snapshot
                .map
                .tile(Point { x: 2, y: 2 })
                .expect("road tile should exist")
                .kind,
            "road"
        );
    }

    #[test]
    fn game_create_sandbox_matches_direct_factory_and_replaces_managed_engine() {
        let cases = [
            json!({
                "templateId": "crossroads",
                "economyPreset": "standard",
                "startingCapital": 120_000,
                "demandMultiplier": 1,
                "moveInRate": "paused"
            }),
            json!({
                "templateId": "blankGrid",
                "economyPreset": "creative",
                "startingCapital": 42_000,
                "demandMultiplier": 1.5,
                "moveInRate": "paused"
            }),
            json!({
                "templateId": "crossroads",
                "economyPreset": "standard",
                "startingCapital": 7_500,
                "demandMultiplier": 2.25,
                "moveInRate": "paused"
            }),
        ];

        let app = sandbox_test_app(GameEngine::new());
        let webview = test_webview(&app);

        for request_value in cases {
            let request =
                serde_json::from_value(request_value.clone()).expect("request should decode");
            let expected = create_sandbox_snapshot(request).expect("request should be valid");

            let created = ipc(
                &webview,
                "game_create_sandbox",
                sandbox_request_body(&request_value),
            )
            .expect("valid creation should resolve");
            assert_eq!(decode_snapshot_response(created), expected);

            let managed = ipc(&webview, "game_snapshot", InvokeBody::default())
                .expect("snapshot should resolve");
            assert_eq!(decode_snapshot_response(managed), expected);
        }

        let canonical = create_sandbox_snapshot(canonical_default_request()).unwrap();
        let default_app = sandbox_test_app(GameEngine::new());
        let default_webview = test_webview(&default_app);
        let default_snapshot = ipc(&default_webview, "game_snapshot", InvokeBody::default())
            .expect("default snapshot should resolve");
        assert_eq!(decode_snapshot_response(default_snapshot), canonical);
    }

    #[test]
    fn game_create_sandbox_domain_errors_are_objects_and_preserve_managed_state() {
        let before = GameEngine::new().snapshot();
        let app = sandbox_test_app(GameEngine::new());
        let webview = test_webview(&app);
        let invalid = json!({
            "templateId": "unknown",
            "economyPreset": "standard",
            "startingCapital": 120_000,
            "demandMultiplier": 1,
            "moveInRate": "paused"
        });

        let error = ipc(
            &webview,
            "game_create_sandbox",
            sandbox_request_body(&invalid),
        )
        .expect_err("invalid creation should reject");

        assert!(error.is_object());
        assert_eq!(error["code"], json!("unknownTemplateId"));
        assert_eq!(error["context"]["field"], json!("templateId"));
        assert_eq!(error["context"]["attemptedValue"], json!("unknown"));
        let after =
            ipc(&webview, "game_snapshot", InvokeBody::default()).expect("snapshot should resolve");
        assert_eq!(decode_snapshot_response(after), before);
    }

    #[test]
    fn game_create_sandbox_null_numeric_values_return_typed_errors_without_mutation() {
        let before = GameEngine::new().snapshot();
        let app = sandbox_test_app(GameEngine::new());
        let webview = test_webview(&app);
        let cases = [
            (
                "startingCapital",
                "invalidStartingCapital",
                json!({
                    "templateId": "crossroads",
                    "economyPreset": "standard",
                    "startingCapital": null,
                    "demandMultiplier": 1,
                    "moveInRate": "paused"
                }),
            ),
            (
                "demandMultiplier",
                "invalidDemandMultiplier",
                json!({
                    "templateId": "crossroads",
                    "economyPreset": "standard",
                    "startingCapital": 120_000,
                    "demandMultiplier": null,
                    "moveInRate": "paused"
                }),
            ),
        ];

        for (field, code, request) in cases {
            let error = ipc(
                &webview,
                "game_create_sandbox",
                sandbox_request_body(&request),
            )
            .expect_err("null numeric value should reject");

            assert!(error.is_object());
            assert_eq!(error["code"], json!(code));
            assert_eq!(error["context"]["field"], json!(field));
            assert_eq!(error["context"]["attemptedValue"], json!("null"));
            let after = ipc(&webview, "game_snapshot", InvokeBody::default())
                .expect("snapshot should resolve");
            assert_eq!(decode_snapshot_response(after), before);
        }
    }

    #[test]
    fn game_create_sandbox_reset_replays_complete_request_through_ipc() {
        let request_value = json!({
            "templateId": "blankGrid",
            "economyPreset": "creative",
            "startingCapital": 42_000,
            "demandMultiplier": 1.5,
            "moveInRate": "paused"
        });
        let request = serde_json::from_value(request_value.clone()).expect("request should decode");
        let expected = create_sandbox_snapshot(request).expect("request should be valid");
        let app = sandbox_test_app(GameEngine::new());
        let webview = test_webview(&app);
        ipc(
            &webview,
            "game_create_sandbox",
            sandbox_request_body(&request_value),
        )
        .expect("valid creation should resolve");

        {
            let state = app.state::<EngineState>();
            let mut engine = state.lock().expect("managed engine should lock");
            engine.set_budget_for_test(7);
            let _ = engine.dispatch(GameIntent::LayRoad {
                point: Point { x: 3, y: 3 },
            });
            assert_ne!(engine.snapshot(), expected);
        }

        let reset = ipc(&webview, "game_reset", InvokeBody::default())
            .expect("sandbox reset should resolve");
        assert_eq!(decode_snapshot_response(reset), expected);
        let managed =
            ipc(&webview, "game_snapshot", InvokeBody::default()).expect("snapshot should resolve");
        assert_eq!(decode_snapshot_response(managed), expected);
    }

    #[test]
    fn game_create_sandbox_campaign_reset_is_typed_and_preserves_state() {
        let mut campaign = GameEngine::new().snapshot();
        campaign.rules.game_mode = GameMode::Campaign;
        let before = campaign.clone();
        let engine = GameEngine::from_snapshot(campaign).expect("campaign snapshot should load");
        let app = sandbox_test_app(engine);
        let webview = test_webview(&app);

        let error = ipc(&webview, "game_reset", InvokeBody::default())
            .expect_err("campaign reset should reject");

        assert!(error.is_object());
        assert_eq!(error["code"], json!("unsupportedGameMode"));
        assert_eq!(error["context"]["gameMode"], json!("campaign"));
        let after =
            ipc(&webview, "game_snapshot", InvokeBody::default()).expect("snapshot should resolve");
        assert_eq!(decode_snapshot_response(after), before);
    }

    #[test]
    fn game_create_sandbox_host_command_errors_serialize_as_strings() {
        let serialized = serde_json::to_value(
            TauriCommandError::<caelum_core::SandboxCreationError>::Host(
                "mutex poisoned".to_string(),
            ),
        )
        .unwrap();

        assert!(serialized.is_string());
    }

    const VALID_SNAPSHOT: &str = include_str!("../../tests/fixtures/persistence/valid-paused.json");
    const UNSUPPORTED_SNAPSHOT: &str =
        include_str!("../../tests/fixtures/persistence/unsupported-schema.json");
    const UNPAUSED_SNAPSHOT: &str = include_str!("../../tests/fixtures/persistence/unpaused.json");
    const MALFORMED_SNAPSHOT: &str =
        include_str!("../../tests/fixtures/persistence/malformed-current-schema.json");
    const LATE_CORRUPTION_SNAPSHOT: &str =
        include_str!("../../tests/fixtures/persistence/late-derived-corruption.json");

    fn fixture(source: &str) -> Value {
        serde_json::from_str(source).expect("persistence fixture must be valid JSON")
    }

    fn bridge_error_json(error: PersistenceBridgeError) -> Value {
        serde_json::to_value(error).expect("bridge error must serialize")
    }

    #[test]
    fn persistence_bridge_errors_have_exact_tagged_json_shapes() {
        let cases = [
            (
                PersistenceBridgeError::validation(
                    PersistenceOperation::RestoreSnapshot,
                    PersistenceValidationSource::Candidate,
                    caelum_core::PersistenceError::UnsupportedSchema {
                        expected: 4,
                        actual: 3,
                    },
                ),
                json!({
                    "kind": "validation",
                    "operation": "restoreSnapshot",
                    "source": "candidate",
                    "error": {
                        "code": "unsupportedSchema",
                        "context": { "expected": 4, "actual": 3 }
                    }
                }),
            ),
            (
                PersistenceBridgeError::validation(
                    PersistenceOperation::SnapshotForSave,
                    PersistenceValidationSource::ActiveEngine,
                    caelum_core::PersistenceError::InvalidNumericValue {
                        entity: None,
                        field: caelum_core::SnapshotField::Budget,
                        reason: caelum_core::NumericError::Negative,
                    },
                ),
                json!({
                    "kind": "validation",
                    "operation": "snapshotForSave",
                    "source": "activeEngine",
                    "error": {
                        "code": "invalidNumericValue",
                        "context": {
                            "field": "budget",
                            "reason": { "kind": "negative" }
                        }
                    }
                }),
            ),
            (
                PersistenceBridgeError::serialization(
                    PersistenceOperation::ValidateSnapshot,
                    PersistenceSerializationPhase::SnapshotDecode,
                    "synthetic decode failure",
                ),
                json!({
                    "kind": "serialization",
                    "operation": "validateSnapshot",
                    "phase": "snapshotDecode",
                    "diagnostic": "synthetic decode failure"
                }),
            ),
            (
                PersistenceBridgeError::serialization(
                    PersistenceOperation::RestoreSnapshot,
                    PersistenceSerializationPhase::SnapshotEncode,
                    "synthetic encode failure",
                ),
                json!({
                    "kind": "serialization",
                    "operation": "restoreSnapshot",
                    "phase": "snapshotEncode",
                    "diagnostic": "synthetic encode failure"
                }),
            ),
            (
                PersistenceBridgeError::host(
                    PersistenceOperation::SnapshotForSave,
                    PersistenceHostErrorCode::StateUnavailable,
                    "synthetic state failure",
                ),
                json!({
                    "kind": "host",
                    "operation": "snapshotForSave",
                    "code": "stateUnavailable",
                    "diagnostic": "synthetic state failure"
                }),
            ),
        ];

        for (actual, expected) in cases {
            assert_eq!(bridge_error_json(actual), expected);
        }
    }

    #[test]
    fn persistence_commands_are_registered_and_legacy_load_is_not() {
        let app = sandbox_test_app(GameEngine::new());
        let webview = test_webview(&app);
        let snapshot = fixture(VALID_SNAPSHOT);

        let saved = ipc(&webview, "game_snapshot_for_save", InvokeBody::default())
            .expect("save command should be registered");
        let saved: Value = saved.deserialize().expect("save response must be JSON");
        assert_eq!(saved["paused"], json!(true));

        let validated = ipc(
            &webview,
            "game_validate_snapshot",
            persistence_snapshot_body(&snapshot),
        )
        .expect("validation command should be registered");
        let validated: Value = validated
            .deserialize()
            .expect("validation response must be JSON null");
        assert_eq!(validated, Value::Null);

        let restored = ipc(
            &webview,
            "game_restore_snapshot",
            persistence_snapshot_body(&snapshot),
        )
        .expect("restore command should be registered");
        let restored: Value = restored
            .deserialize()
            .expect("restore response must be JSON");
        assert_eq!(restored, snapshot);

        let error = ipc(
            &webview,
            "game_load_snapshot",
            persistence_snapshot_body(&snapshot),
        )
        .expect_err("legacy load command must not be registered");
        assert!(
            error
                .as_str()
                .is_some_and(|diagnostic| diagnostic.contains("game_load_snapshot")),
            "unexpected missing-command error: {error}"
        );
    }

    #[test]
    fn capture_save_releases_mutex_before_preparation() {
        let state = Mutex::new(GameEngine::new());

        let capture = capture_save(&state).unwrap();

        assert!(state.try_lock().is_ok(), "capture must release the mutex");
        let saved = capture.prepare().unwrap();
        assert!(saved.paused);
    }

    #[test]
    fn save_returns_paused_snapshot_without_mutating_active_engine() {
        let mut engine = GameEngine::new();
        assert!(
            engine
                .dispatch(GameIntent::SetPaused { paused: false })
                .applied
        );
        let app = sandbox_test_app(engine);
        let webview = test_webview(&app);

        let saved = ipc(&webview, "game_snapshot_for_save", InvokeBody::default())
            .expect("save should resolve");
        let saved: Value = saved.deserialize().expect("save response must be JSON");
        assert_eq!(saved["paused"], json!(true));

        let active = ipc(&webview, "game_snapshot", InvokeBody::default())
            .expect("active snapshot should resolve");
        assert!(!decode_snapshot_response(active).paused);
    }

    #[test]
    fn save_active_engine_failure_is_tagged_and_preserves_state() {
        let mut engine = GameEngine::new();
        engine.set_budget_for_test(-1);
        let before = engine.snapshot();
        let app = sandbox_test_app(engine);
        let webview = test_webview(&app);

        let error = ipc(&webview, "game_snapshot_for_save", InvokeBody::default())
            .expect_err("invalid active engine must reject save");

        assert_eq!(
            error,
            json!({
                "kind": "validation",
                "operation": "snapshotForSave",
                "source": "activeEngine",
                "error": {
                    "code": "invalidNumericValue",
                    "context": {
                        "field": "budget",
                        "reason": { "kind": "negative" }
                    }
                }
            })
        );
        let active = ipc(&webview, "game_snapshot", InvokeBody::default())
            .expect("active snapshot should resolve");
        assert_eq!(decode_snapshot_response(active), before);
    }

    #[test]
    fn validation_is_stateless_and_classifies_fixture_failures() {
        validate_snapshot_body(fixture(VALID_SNAPSHOT)).expect("valid fixture should validate");

        let unsupported = validate_snapshot_body(fixture(UNSUPPORTED_SNAPSHOT))
            .expect_err("legacy fixture must fail schema validation");
        assert_eq!(
            bridge_error_json(unsupported),
            json!({
                "kind": "validation",
                "operation": "validateSnapshot",
                "source": "candidate",
                "error": {
                    "code": "unsupportedSchema",
                    "context": { "expected": 4, "actual": 3 }
                }
            })
        );

        let malformed = validate_snapshot_body(fixture(MALFORMED_SNAPSHOT))
            .expect_err("malformed current-schema fixture must fail decode");
        let malformed = bridge_error_json(malformed);
        assert_eq!(malformed["kind"], "serialization");
        assert_eq!(malformed["operation"], "validateSnapshot");
        assert_eq!(malformed["phase"], "snapshotDecode");
        assert!(
            malformed["diagnostic"]
                .as_str()
                .is_some_and(|diagnostic| diagnostic.contains("invalid type")),
            "unexpected decode diagnostic: {}",
            malformed["diagnostic"]
        );

        let unpaused = validate_snapshot_body(fixture(UNPAUSED_SNAPSHOT))
            .expect_err("unpaused fixture must fail semantic validation");
        assert_eq!(
            bridge_error_json(unpaused),
            json!({
                "kind": "validation",
                "operation": "validateSnapshot",
                "source": "candidate",
                "error": {
                    "code": "invalidModeSettings",
                    "context": {
                        "field": "paused",
                        "reason": { "kind": "persistenceRequiresPaused" }
                    }
                }
            })
        );
    }

    #[test]
    fn restore_early_and_late_failures_preserve_managed_state() {
        let app = sandbox_test_app(GameEngine::new());
        let webview = test_webview(&app);
        let before = ipc(&webview, "game_snapshot", InvokeBody::default())
            .map(decode_snapshot_response)
            .expect("initial snapshot should resolve");

        for candidate in [
            fixture(UNSUPPORTED_SNAPSHOT),
            fixture(MALFORMED_SNAPSHOT),
            fixture(UNPAUSED_SNAPSHOT),
            fixture(LATE_CORRUPTION_SNAPSHOT),
        ] {
            ipc(
                &webview,
                "game_restore_snapshot",
                persistence_snapshot_body(&candidate),
            )
            .expect_err("invalid restore candidate must reject");
            let after = ipc(&webview, "game_snapshot", InvokeBody::default())
                .map(decode_snapshot_response)
                .expect("snapshot after rejection should resolve");
            assert_eq!(after, before);
        }
    }

    #[test]
    fn restore_success_returns_exact_snapshot_and_subsequent_dispatch_uses_restored_rules() {
        let mut candidate = GameEngine::new().snapshot();
        candidate.paused = true;
        candidate.budget = 0;
        candidate.rules.economy_preset = caelum_core::model::EconomyPreset::Creative;
        let candidate_value = serde_json::to_value(&candidate).expect("candidate must encode");
        let app = sandbox_test_app(GameEngine::new());
        let webview = test_webview(&app);

        let restored = ipc(
            &webview,
            "game_restore_snapshot",
            persistence_snapshot_body(&candidate_value),
        )
        .expect("valid candidate should restore");
        let restored: Value = restored
            .deserialize()
            .expect("restore response must be JSON");
        assert_eq!(restored, candidate_value);

        let dispatched = ipc(
            &webview,
            "game_dispatch",
            dispatch_body(json!({
                "type": "layRoad",
                "point": { "x": 2, "y": 2 }
            })),
        )
        .expect("Creative road should dispatch after restore");
        let dispatched = decode_dispatch_result(dispatched);
        assert!(dispatched.applied);
        assert_eq!(dispatched.snapshot.budget, 0);
        assert_eq!(
            dispatched.snapshot.rules.economy_preset,
            caelum_core::model::EconomyPreset::Creative
        );
    }

    #[test]
    fn restore_encode_failure_is_tagged_before_managed_state_swap() {
        let state = Mutex::new(GameEngine::new());
        let before = state.lock().unwrap().snapshot();

        let error = restore_snapshot_with(&state, fixture(VALID_SNAPSHOT), |_snapshot| {
            Err::<Value, _>("synthetic encode failure")
        })
        .expect_err("encoding failure must reject");

        assert_eq!(
            bridge_error_json(error),
            json!({
                "kind": "serialization",
                "operation": "restoreSnapshot",
                "phase": "snapshotEncode",
                "diagnostic": "synthetic encode failure"
            })
        );
        assert_eq!(state.lock().unwrap().snapshot(), before);
    }

    #[test]
    fn structured_error_encoding_failure_falls_back_before_managed_state_swap() {
        let state = Mutex::new(GameEngine::new());
        let before = state.lock().unwrap().snapshot();
        let result = restore_snapshot_with(&state, fixture(VALID_SNAPSHOT), |_snapshot| {
            Err::<Value, _>("synthetic response encode failure")
        });

        let error = encode_persistence_result_with(result, |_error| {
            Err::<Value, _>("synthetic structured error encode failure")
        })
        .expect_err("structured error encoding must use the opaque fallback");

        assert_eq!(
            serde_json::to_value(error).expect("opaque fallback must serialize"),
            json!(
                "persistence bridge error encoding failed: synthetic structured error encode failure"
            )
        );
        assert_eq!(state.lock().unwrap().snapshot(), before);
    }

    #[test]
    fn poisoned_restore_mutex_maps_to_state_unavailable_without_swapping() {
        let app = sandbox_test_app(GameEngine::new());
        let webview = test_webview(&app);
        let state = app.state::<EngineState>();
        let before = state.lock().unwrap().snapshot();
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = state.lock().unwrap();
            panic!("poison persistence mutex");
        }));

        let error = ipc(
            &webview,
            "game_restore_snapshot",
            persistence_snapshot_body(&fixture(VALID_SNAPSHOT)),
        )
        .expect_err("poisoned mutex must reject");
        assert_eq!(error["kind"], "host");
        assert_eq!(error["operation"], "restoreSnapshot");
        assert_eq!(error["code"], "stateUnavailable");
        assert!(
            error["diagnostic"]
                .as_str()
                .is_some_and(|diagnostic| diagnostic.contains("poisoned")),
            "unexpected lock diagnostic: {}",
            error["diagnostic"]
        );
        let poisoned = match state.lock() {
            Ok(_) => panic!("mutex must remain poisoned"),
            Err(error) => error,
        };
        assert_eq!(poisoned.into_inner().snapshot(), before);
    }
}
