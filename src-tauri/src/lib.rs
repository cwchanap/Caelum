use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use caelum_core::{
    DispatchResult, GameEngine, GameIntent, GameSnapshot, PersistenceError,
    RoadMutationPreviewRequest, RoadMutationPreviewResponse, RoutePreviewRequest,
    RoutePreviewResponse, SandboxCreationError, SandboxCreationRequest, SandboxResetError,
    SnapshotSchemaProbe, SNAPSHOT_SCHEMA_VERSION,
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

#[tauri::command]
fn game_load_snapshot(
    state: State<'_, EngineState>,
    snapshot: serde_json::Value,
) -> Result<GameSnapshot, serde_json::Value> {
    // Two-phase: probe `schemaVersion` before the full `GameSnapshot`
    // deserialization so a legacy schema-v3 save (which lacks the required v4
    // `rules.sandbox.startingCapital` field) is rejected with the structured
    // typed persistence error instead of a generic missing-field serde
    // error. If the probe itself cannot read a schema version (truly malformed
    // payload), treat the version as unknown (0) and still reject as
    // unsupported.
    //
    // `GameEngine::from_snapshot` validates the version again after full
    // deserialization; this probe exists to surface the typed persistence
    // error before deserialization can fail on a schema-v4-only field.
    let probe_schema_version = SnapshotSchemaProbe::deserialize(&snapshot)
        .map(|probe| probe.schema_version)
        .unwrap_or(0);
    if probe_schema_version != SNAPSHOT_SCHEMA_VERSION {
        return Err(serde_json::to_value(PersistenceError::UnsupportedSchema {
            expected: SNAPSHOT_SCHEMA_VERSION,
            actual: probe_schema_version,
        })
        .unwrap_or_else(|error| serde_json::Value::String(error.to_string())));
    }
    let snapshot: GameSnapshot = serde_json::from_value(snapshot)
        .map_err(|error| serde_json::Value::String(error.to_string()))?;
    let loaded = GameEngine::from_snapshot(snapshot).map_err(|error| {
        serde_json::to_value(error)
            .unwrap_or_else(|error| serde_json::Value::String(error.to_string()))
    })?;
    let mut engine = state
        .lock()
        .map_err(|error| serde_json::Value::String(error.to_string()))?;
    *engine = loaded;
    Ok(engine.snapshot())
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
            game_load_snapshot,
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
    use caelum_core::model::{GameMode, Point, SNAPSHOT_SCHEMA_VERSION};
    use caelum_core::{canonical_default_request, create_sandbox_snapshot};
    use serde_json::{json, Value};
    use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody};
    use tauri::test::{get_ipc_response, MockRuntime, INVOKE_KEY};
    use tauri::webview::InvokeRequest;
    use tauri::{App, Manager, Webview, WebviewWindow};

    fn sandbox_test_app(engine: GameEngine) -> App<MockRuntime> {
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        for command in ["game_create_sandbox", "game_reset", "game_snapshot"] {
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
                game_snapshot
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

    fn decode_snapshot(response: InvokeResponseBody) -> GameSnapshot {
        response
            .deserialize()
            .expect("successful IPC response should decode to GameSnapshot")
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
            assert_eq!(decode_snapshot(created), expected);

            let managed = ipc(&webview, "game_snapshot", InvokeBody::default())
                .expect("snapshot should resolve");
            assert_eq!(decode_snapshot(managed), expected);
        }

        let canonical = create_sandbox_snapshot(canonical_default_request()).unwrap();
        let default_app = sandbox_test_app(GameEngine::new());
        let default_webview = test_webview(&default_app);
        let default_snapshot = ipc(&default_webview, "game_snapshot", InvokeBody::default())
            .expect("default snapshot should resolve");
        assert_eq!(decode_snapshot(default_snapshot), canonical);
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
        assert_eq!(decode_snapshot(after), before);
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
            assert_eq!(decode_snapshot(after), before);
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
        assert_eq!(decode_snapshot(reset), expected);
        let managed =
            ipc(&webview, "game_snapshot", InvokeBody::default()).expect("snapshot should resolve");
        assert_eq!(decode_snapshot(managed), expected);
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
        assert_eq!(decode_snapshot(after), before);
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

    #[test]
    fn semantic_snapshot_load_rejection_preserves_persistence_error() {
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context.runtime_authority_mut().__allow_command(
            "game_load_snapshot".to_string(),
            tauri::utils::acl::ExecutionContext::Local,
        );
        let app = tauri::test::mock_builder()
            .manage(Mutex::new(GameEngine::new()))
            .invoke_handler(tauri::generate_handler![game_load_snapshot])
            .build(context)
            .expect("test Tauri app should build");
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("test webview should build");

        let mut snapshot = GameEngine::new().snapshot();
        snapshot.paused = false;
        let response = get_ipc_response(
            &webview,
            InvokeRequest {
                cmd: "game_load_snapshot".into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: "tauri://localhost".parse().unwrap(),
                body: InvokeBody::Json(json!({ "snapshot": snapshot })),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        );
        let error = response.expect_err("unpaused snapshot should reject");

        assert_eq!(error["code"], json!("invalidModeSettings"));
        assert_eq!(error["context"]["field"], json!("paused"));
        assert_eq!(
            error["context"]["reason"]["kind"],
            json!("persistenceRequiresPaused")
        );
    }

    #[test]
    fn schema_v3_save_missing_required_v4_starting_capital_is_structurally_rejected() {
        // A legacy schema-v3 save lacks the required v4
        // `rules.sandbox.startingCapital` field. The two-phase probe must reject
        // it with `UnsupportedSchema` before the full deserialize fails
        // with a generic missing-field error.
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context.runtime_authority_mut().__allow_command(
            "game_load_snapshot".to_string(),
            tauri::utils::acl::ExecutionContext::Local,
        );
        let app = tauri::test::mock_builder()
            .manage(Mutex::new(GameEngine::new()))
            .invoke_handler(tauri::generate_handler![game_load_snapshot])
            .build(context)
            .expect("test Tauri app should build");
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("test webview should build");

        // Start from a valid v4 snapshot's JSON, then regress it to a v3 shape:
        // drop the required sandbox setting and set `schemaVersion` to v3.
        let mut snapshot_value =
            serde_json::to_value(GameEngine::new().snapshot()).expect("snapshot serializes");
        let snapshot_obj = snapshot_value.as_object_mut().expect("snapshot is object");
        snapshot_obj["rules"]["sandbox"]
            .as_object_mut()
            .expect("sandbox rules are an object")
            .remove("startingCapital");
        snapshot_obj["schemaVersion"] = json!(SNAPSHOT_SCHEMA_VERSION - 1);

        let response = get_ipc_response(
            &webview,
            InvokeRequest {
                cmd: "game_load_snapshot".into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: "tauri://localhost".parse().unwrap(),
                body: InvokeBody::Json(json!({ "snapshot": snapshot_value })),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        );
        let error = response.expect_err("v3 save must be rejected as unsupported schema");

        assert_eq!(error["code"], json!("unsupportedSchema"));
        assert_eq!(error["context"]["expected"], json!(SNAPSHOT_SCHEMA_VERSION));
        assert_eq!(
            error["context"]["actual"],
            json!(SNAPSHOT_SCHEMA_VERSION - 1)
        );
    }
}
