use caelum_core::{
    check_schema_version, create_sandbox_snapshot, GameEngine, GameIntent, GameSnapshot,
    RoadMutationPreviewRequest, RoutePreviewRequest, SandboxCreationRequest, SnapshotLoadError,
    SnapshotSchemaProbe,
};
use serde::Serialize;
use wasm_bindgen::prelude::*;

fn to_snapshot_js_value<T: Serialize + ?Sized>(value: &T) -> Result<JsValue, JsValue> {
    serde_wasm_bindgen::to_value(value).map_err(to_js_error)
}

fn snapshot_js_error(error: SnapshotLoadError) -> JsValue {
    to_snapshot_js_value(&error)
        .unwrap_or_else(|_| JsValue::from_str("snapshot error serialization failed"))
}

fn decode_snapshot(value: JsValue) -> Result<GameSnapshot, JsValue> {
    let actual = serde_wasm_bindgen::from_value::<SnapshotSchemaProbe>(value.clone())
        .map(|probe| probe.schema_version)
        .unwrap_or(0);
    check_schema_version(actual)
        .map_err(|error| snapshot_js_error(SnapshotLoadError::from(error)))?;
    serde_wasm_bindgen::from_value(value)
        .map_err(|error| snapshot_js_error(SnapshotLoadError::InvalidSnapshot(error.to_string())))
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

    pub fn build_sandbox_snapshot(request: JsValue) -> Result<JsValue, JsValue> {
        let request: SandboxCreationRequest =
            serde_wasm_bindgen::from_value(request).map_err(to_js_error)?;
        let snapshot = create_sandbox_snapshot(request)
            .map_err(|error| serde_wasm_bindgen::to_value(&error).unwrap_or_else(to_js_error))?;
        to_snapshot_js_value(&snapshot)
    }

    pub fn snapshot(&self) -> Result<JsValue, JsValue> {
        to_snapshot_js_value(&self.inner.snapshot())
    }

    pub fn snapshot_for_save(&self) -> Result<JsValue, JsValue> {
        to_snapshot_js_value(&self.inner.snapshot_for_save())
    }

    pub fn restore_snapshot(&mut self, snapshot: JsValue) -> Result<JsValue, JsValue> {
        let snapshot = decode_snapshot(snapshot)?;
        let restored = self
            .inner
            .restore_snapshot(snapshot)
            .map_err(snapshot_js_error)?;
        to_snapshot_js_value(&restored)
    }

    pub fn dispatch(&mut self, intent: JsValue) -> Result<JsValue, JsValue> {
        let intent: GameIntent = serde_wasm_bindgen::from_value(intent).map_err(to_js_error)?;
        to_snapshot_js_value(&self.inner.dispatch(intent))
    }

    pub fn tick(&mut self, delta_seconds: f64) -> Result<JsValue, JsValue> {
        to_snapshot_js_value(&self.inner.tick(delta_seconds))
    }

    pub fn reset(&mut self) -> Result<JsValue, JsValue> {
        let snapshot = self
            .inner
            .reset()
            .map_err(|error| serde_wasm_bindgen::to_value(&error).unwrap_or_else(to_js_error))?;
        to_snapshot_js_value(&snapshot)
    }

    pub fn preview_route(&self, request: JsValue) -> Result<JsValue, JsValue> {
        let request: RoutePreviewRequest =
            serde_wasm_bindgen::from_value(request).map_err(to_js_error)?;
        to_snapshot_js_value(&self.inner.preview_route(request))
    }

    pub fn preview_road_mutation(&self, request: JsValue) -> Result<JsValue, JsValue> {
        let request: RoadMutationPreviewRequest =
            serde_wasm_bindgen::from_value(request).map_err(to_js_error)?;
        to_snapshot_js_value(&self.inner.preview_road_mutation(request))
    }
}

fn to_js_error(error: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&error.to_string())
}
