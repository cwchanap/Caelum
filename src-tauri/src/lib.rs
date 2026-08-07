use std::sync::Mutex;

use serde::Serialize;

use caelum_core::{
    check_snapshot_schema, create_sandbox_snapshot, DispatchResult, GameEngine, GameIntent,
    GameSnapshot, RoadMutationPreviewRequest, RoadMutationPreviewResponse, RoutePreviewRequest,
    RoutePreviewResponse, SandboxCreationError, SandboxCreationRequest, SandboxResetError,
    SnapshotLoadError,
};
use tauri::State;

/// The managed engine paired with a monotonic runtime epoch.
///
/// The epoch is the cross-reload ownership authority: every
/// `game_begin_runtime` call increments it and returns the new value plus the
/// authoritative snapshot from the same critical section. A webview reload
/// destroys the JavaScript runtime while this Rust process and its engine stay
/// alive, so stale mutating commands are rejected before they can commit.
struct OwnedEngine {
    engine: GameEngine,
    runtime_epoch: u64,
}

type EngineState = Mutex<OwnedEngine>;

#[derive(Debug, Serialize)]
struct StaleRuntimeEpoch {
    code: &'static str,
    context: StaleRuntimeEpochContext,
}

#[derive(Debug, Serialize)]
struct StaleRuntimeEpochContext {
    expected: u64,
    actual: u64,
}

const STALE_RUNTIME_EPOCH_CODE: &str = "staleRuntimeEpoch";

fn stale_runtime_epoch(expected: u64, actual: u64) -> StaleRuntimeEpoch {
    StaleRuntimeEpoch {
        code: STALE_RUNTIME_EPOCH_CODE,
        context: StaleRuntimeEpochContext { expected, actual },
    }
}

/// Wire-format error for commands whose domain failure is a typed value.
#[derive(Serialize)]
#[serde(untagged)]
enum TauriCommandError<E> {
    StaleEpoch(StaleRuntimeEpoch),
    Domain(E),
    Host(String),
}

/// Gameplay rejections travel inside `DispatchResult`; this covers only host
/// failures and stale runtime epochs.
#[derive(Serialize)]
#[serde(untagged)]
enum GameplayCommandError {
    StaleEpoch(StaleRuntimeEpoch),
    Host(String),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BeginRuntimeResponse {
    runtime_epoch: u64,
    snapshot: GameSnapshot,
}

#[derive(Debug, Serialize)]
#[serde(
    tag = "code",
    content = "context",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum SnapshotCommandError {
    UnsupportedSchema { expected: u16, actual: u16 },
    InvalidSnapshot(String),
    HostFailure(String),
}

impl From<SnapshotLoadError> for SnapshotCommandError {
    fn from(error: SnapshotLoadError) -> Self {
        match error {
            SnapshotLoadError::UnsupportedSchema { expected, actual } => {
                Self::UnsupportedSchema { expected, actual }
            }
            SnapshotLoadError::InvalidSnapshot(diagnostic) => Self::InvalidSnapshot(diagnostic),
        }
    }
}

/// Reject a snapshot command whose issuing runtime has been superseded. Shared
/// by `game_snapshot_for_save` and `restore_snapshot_with`; both classify a
/// stale epoch as `HostFailure` (the engine is unchanged, so the outcome is
/// ambiguous rather than a definitive load failure).
fn ensure_snapshot_runtime_epoch(
    owned_epoch: u64,
    runtime_epoch: u64,
) -> Result<(), SnapshotCommandError> {
    if owned_epoch != runtime_epoch {
        return Err(SnapshotCommandError::HostFailure(format!(
            "stale runtime epoch: expected {owned_epoch}, actual {runtime_epoch}"
        )));
    }
    Ok(())
}

fn decode_snapshot(value: serde_json::Value) -> Result<GameSnapshot, SnapshotCommandError> {
    check_snapshot_schema(&value)
        .map_err(|error| SnapshotCommandError::from(SnapshotLoadError::from(error)))?;
    serde_json::from_value(value)
        .map_err(|error| SnapshotCommandError::InvalidSnapshot(error.to_string()))
}

fn restore_snapshot_with(
    state: &EngineState,
    snapshot: serde_json::Value,
    runtime_epoch: u64,
) -> Result<serde_json::Value, SnapshotCommandError> {
    let snapshot = decode_snapshot(snapshot)?;
    let candidate = GameEngine::from_snapshot(snapshot).map_err(SnapshotCommandError::from)?;
    let encoded = serde_json::to_value(candidate.snapshot())
        .map_err(|error| SnapshotCommandError::HostFailure(error.to_string()))?;
    let mut owned = state
        .lock()
        .map_err(|error| SnapshotCommandError::HostFailure(error.to_string()))?;
    ensure_snapshot_runtime_epoch(owned.runtime_epoch, runtime_epoch)?;
    owned.engine = candidate;
    Ok(encoded)
}

#[tauri::command]
fn game_snapshot(state: State<'_, EngineState>) -> Result<GameSnapshot, String> {
    let owned = state.lock().map_err(|error| error.to_string())?;
    Ok(owned.engine.snapshot())
}

#[tauri::command]
fn game_begin_runtime(state: State<'_, EngineState>) -> Result<BeginRuntimeResponse, String> {
    let mut owned = state.lock().map_err(|error| error.to_string())?;
    owned.runtime_epoch += 1;
    let epoch = owned.runtime_epoch;
    let snapshot = owned.engine.snapshot();
    Ok(BeginRuntimeResponse {
        runtime_epoch: epoch,
        snapshot,
    })
}

#[tauri::command]
fn game_dispatch(
    state: State<'_, EngineState>,
    intent: GameIntent,
    runtime_epoch: u64,
) -> Result<DispatchResult, GameplayCommandError> {
    let mut owned = state
        .lock()
        .map_err(|error| GameplayCommandError::Host(error.to_string()))?;
    if owned.runtime_epoch != runtime_epoch {
        return Err(GameplayCommandError::StaleEpoch(stale_runtime_epoch(
            owned.runtime_epoch,
            runtime_epoch,
        )));
    }
    Ok(owned.engine.dispatch(intent))
}

#[tauri::command]
fn game_tick(
    state: State<'_, EngineState>,
    delta_seconds: f64,
    runtime_epoch: u64,
) -> Result<DispatchResult, GameplayCommandError> {
    let mut owned = state
        .lock()
        .map_err(|error| GameplayCommandError::Host(error.to_string()))?;
    if owned.runtime_epoch != runtime_epoch {
        return Err(GameplayCommandError::StaleEpoch(stale_runtime_epoch(
            owned.runtime_epoch,
            runtime_epoch,
        )));
    }
    Ok(owned.engine.tick(delta_seconds))
}

#[tauri::command]
fn game_build_sandbox_snapshot(
    request: SandboxCreationRequest,
) -> Result<GameSnapshot, SandboxCreationError> {
    create_sandbox_snapshot(request)
}

#[tauri::command]
fn game_reset(
    state: State<'_, EngineState>,
    runtime_epoch: u64,
) -> Result<GameSnapshot, TauriCommandError<SandboxResetError>> {
    let mut owned = state
        .lock()
        .map_err(|error| TauriCommandError::Host(error.to_string()))?;
    if owned.runtime_epoch != runtime_epoch {
        return Err(TauriCommandError::StaleEpoch(stale_runtime_epoch(
            owned.runtime_epoch,
            runtime_epoch,
        )));
    }
    owned.engine.reset().map_err(TauriCommandError::Domain)
}

#[tauri::command]
fn game_snapshot_for_save(
    state: State<'_, EngineState>,
    runtime_epoch: u64,
) -> Result<serde_json::Value, SnapshotCommandError> {
    let owned = state
        .lock()
        .map_err(|error| SnapshotCommandError::HostFailure(error.to_string()))?;
    ensure_snapshot_runtime_epoch(owned.runtime_epoch, runtime_epoch)?;
    serde_json::to_value(owned.engine.snapshot_for_save())
        .map_err(|error| SnapshotCommandError::HostFailure(error.to_string()))
}

#[tauri::command]
fn game_restore_snapshot(
    state: State<'_, EngineState>,
    snapshot: serde_json::Value,
    runtime_epoch: u64,
) -> Result<serde_json::Value, SnapshotCommandError> {
    restore_snapshot_with(&state, snapshot, runtime_epoch)
}

#[tauri::command]
fn game_preview_route(
    state: State<'_, EngineState>,
    request: RoutePreviewRequest,
) -> Result<RoutePreviewResponse, String> {
    let owned = state.lock().map_err(|error| error.to_string())?;
    Ok(owned.engine.preview_route(request))
}

#[tauri::command]
fn game_preview_road_mutation(
    state: State<'_, EngineState>,
    request: RoadMutationPreviewRequest,
) -> Result<RoadMutationPreviewResponse, String> {
    let owned = state.lock().map_err(|error| error.to_string())?;
    Ok(owned.engine.preview_road_mutation(request))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Mutex::new(OwnedEngine {
            engine: GameEngine::new(),
            runtime_epoch: 0,
        }))
        .invoke_handler(tauri::generate_handler![
            game_snapshot,
            game_begin_runtime,
            game_dispatch,
            game_tick,
            game_build_sandbox_snapshot,
            game_reset,
            game_snapshot_for_save,
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
    use caelum_core::{canonical_default_request, create_sandbox_snapshot};
    use tauri::Manager;

    #[test]
    fn sandbox_build_is_pure() {
        let request = canonical_default_request();
        let expected = create_sandbox_snapshot(request.clone()).expect("default request");
        let actual = game_build_sandbox_snapshot(request).expect("default request");
        assert_eq!(actual, expected);
    }

    #[test]
    fn invalid_restore_preserves_the_managed_engine() {
        let engine = GameEngine::new();
        let state = Mutex::new(OwnedEngine {
            engine: engine.clone(),
            runtime_epoch: 0,
        });
        let mut candidate = engine.snapshot();
        candidate.map.tiles.pop();

        let result = restore_snapshot_with(
            &state,
            serde_json::to_value(candidate).expect("candidate serializes"),
            0,
        );

        assert!(matches!(
            result,
            Err(SnapshotCommandError::InvalidSnapshot(_))
        ));
        assert_eq!(
            state.lock().expect("state lock").engine.snapshot(),
            engine.snapshot()
        );
    }

    #[test]
    fn stale_restore_does_not_replace_the_managed_engine() {
        let engine = GameEngine::new();
        let state = Mutex::new(OwnedEngine {
            engine: engine.clone(),
            runtime_epoch: 2,
        });

        let result = restore_snapshot_with(
            &state,
            serde_json::to_value(engine.snapshot()).expect("snapshot serializes"),
            1,
        );

        assert!(matches!(result, Err(SnapshotCommandError::HostFailure(_))));
        assert_eq!(
            state.lock().expect("state lock").engine.snapshot(),
            engine.snapshot()
        );
    }

    #[test]
    fn command_happy_path_dispatches_ticks_saves_and_restores() {
        let app = tauri::test::mock_app();
        assert!(app.manage(Mutex::new(OwnedEngine {
            engine: GameEngine::new(),
            runtime_epoch: 0,
        })));
        let state = app.state::<EngineState>();
        let session = game_begin_runtime(state.clone()).expect("runtime begins");

        let dispatched = game_dispatch(
            state.clone(),
            GameIntent::SetPaused { paused: false },
            session.runtime_epoch,
        )
        .unwrap_or_else(|_| panic!("dispatch succeeds"));
        assert!(dispatched.applied);

        let ticked = game_tick(state.clone(), 1.0, session.runtime_epoch)
            .unwrap_or_else(|_| panic!("tick succeeds"));
        assert!(ticked.snapshot.time > dispatched.snapshot.time);

        let saved = game_snapshot_for_save(state.clone(), session.runtime_epoch)
            .expect("save capture succeeds");
        let restored = game_restore_snapshot(state, saved.clone(), session.runtime_epoch)
            .expect("valid restore succeeds");

        assert_eq!(restored, saved);
    }
}
