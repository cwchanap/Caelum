use std::sync::Mutex;

use caelum_core::{
    DispatchResult, GameEngine, GameIntent, GameSnapshot, GameplayRejection,
    RoadMutationPreviewRequest, RoadMutationPreviewResponse, RoutePreviewRequest,
    RoutePreviewResponse, SnapshotSchemaProbe, SNAPSHOT_SCHEMA_VERSION,
};
use tauri::State;

type EngineState = Mutex<GameEngine>;

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
fn game_reset(state: State<'_, EngineState>) -> Result<GameSnapshot, String> {
    let mut engine = state.lock().map_err(|error| error.to_string())?;
    Ok(engine.reset())
}

#[tauri::command]
fn game_load_snapshot(
    state: State<'_, EngineState>,
    snapshot: serde_json::Value,
) -> Result<GameSnapshot, serde_json::Value> {
    // Two-phase: probe `schemaVersion` before the full `GameSnapshot`
    // deserialization so a legacy schema-v2 save (which lacks the required v3
    // `rules` / `scenario.objectives` / `scenario.growthWaves` fields) is
    // rejected with the structured `UnsupportedSnapshotSchema` code instead of
    // a generic missing-field serde error. If the probe itself cannot read a
    // schema version (truly malformed payload), treat the version as unknown
    // (0) and still reject as unsupported.
    //
    // Defense-in-depth: `GameEngine::from_snapshot` (engine.rs) and the WASM
    // host (`caelum-wasm/src/lib.rs::WasmGameEngine::from_snapshot`) re-check
    // the schema version after deserialization. The three checks are
    // intentionally redundant — this probe exists to surface the structured
    // code before the full deserialize can fail generically.
    let probe_schema_version = serde_json::from_value::<SnapshotSchemaProbe>(snapshot.clone())
        .map(|probe| probe.schema_version)
        .unwrap_or(0);
    if probe_schema_version != SNAPSHOT_SCHEMA_VERSION {
        return Err(
            serde_json::to_value(GameplayRejection::unsupported_snapshot_schema(
                probe_schema_version,
            ))
            .unwrap_or_else(|error| serde_json::Value::String(error.to_string())),
        );
    }
    let snapshot: GameSnapshot = serde_json::from_value(snapshot)
        .map_err(|error| serde_json::Value::String(error.to_string()))?;
    let loaded = GameEngine::from_snapshot(snapshot).map_err(|rejection| {
        serde_json::to_value(rejection)
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
    use caelum_core::model::SNAPSHOT_SCHEMA_VERSION;
    use serde_json::json;
    use tauri::ipc::{CallbackFn, InvokeBody};
    use tauri::test::{get_ipc_response, INVOKE_KEY};
    use tauri::webview::InvokeRequest;

    #[test]
    fn snapshot_load_rejection_preserves_structured_code_and_context() {
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
        snapshot.schema_version = SNAPSHOT_SCHEMA_VERSION - 1;
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
        let error = response.expect_err("unsupported schema should reject");

        assert_eq!(error["code"], json!("unsupportedSnapshotSchema"));
        assert_eq!(
            error["context"]["expectedSchemaVersion"],
            json!(SNAPSHOT_SCHEMA_VERSION)
        );
        assert_eq!(
            error["context"]["actualSchemaVersion"],
            json!(SNAPSHOT_SCHEMA_VERSION - 1)
        );
    }

    #[test]
    fn schema_v2_save_missing_required_v3_fields_is_structurally_rejected() {
        // A legacy schema-v2 save lacks the required v3 `rules` field (and the
        // tightened `scenario.objectives` / `scenario.growthWaves` keys). The
        // two-phase probe must reject it with `UnsupportedSnapshotSchema`
        // before the full deserialize fails with a generic missing-field error.
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

        // Start from a valid v3 snapshot's JSON, then regress it to a v2 shape:
        // drop the required `rules` field and set `schemaVersion` to v2.
        let mut snapshot_value =
            serde_json::to_value(GameEngine::new().snapshot()).expect("snapshot serializes");
        let snapshot_obj = snapshot_value.as_object_mut().expect("snapshot is object");
        snapshot_obj.remove("rules");
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
        let error = response.expect_err("v2 save must be rejected as unsupported schema");

        assert_eq!(error["code"], json!("unsupportedSnapshotSchema"));
        assert_eq!(
            error["context"]["expectedSchemaVersion"],
            json!(SNAPSHOT_SCHEMA_VERSION)
        );
        assert_eq!(
            error["context"]["actualSchemaVersion"],
            json!(SNAPSHOT_SCHEMA_VERSION - 1)
        );
    }
}
