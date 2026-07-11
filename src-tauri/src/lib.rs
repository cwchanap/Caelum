use std::sync::Mutex;

use caelum_core::{
    DispatchResult, GameEngine, GameIntent, GameSnapshot, RoadMutationPreviewRequest,
    RoadMutationPreviewResponse, RoutePreviewRequest, RoutePreviewResponse,
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
