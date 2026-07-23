use caelum_core::{
    GameEngine, GameIntent, GameSnapshot, RoadMutationPreviewRequest, RoutePreviewRequest,
};
use wasm_bindgen::prelude::*;

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

    pub fn from_snapshot(snapshot: JsValue) -> Result<WasmGameEngine, JsValue> {
        let snapshot: GameSnapshot =
            serde_wasm_bindgen::from_value(snapshot).map_err(to_js_error)?;
        let inner = GameEngine::from_snapshot(snapshot).map_err(|rejection| {
            serde_wasm_bindgen::to_value(&rejection).unwrap_or_else(to_js_error)
        })?;
        Ok(WasmGameEngine { inner })
    }

    pub fn snapshot(&self) -> Result<JsValue, JsValue> {
        serde_wasm_bindgen::to_value(&self.inner.snapshot()).map_err(to_js_error)
    }

    pub fn dispatch(&mut self, intent: JsValue) -> Result<JsValue, JsValue> {
        let intent: GameIntent = serde_wasm_bindgen::from_value(intent).map_err(to_js_error)?;
        serde_wasm_bindgen::to_value(&self.inner.dispatch(intent)).map_err(to_js_error)
    }

    pub fn tick(&mut self, delta_seconds: f64) -> Result<JsValue, JsValue> {
        serde_wasm_bindgen::to_value(&self.inner.tick(delta_seconds)).map_err(to_js_error)
    }

    pub fn reset(&mut self) -> Result<JsValue, JsValue> {
        serde_wasm_bindgen::to_value(&self.inner.reset()).map_err(to_js_error)
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
