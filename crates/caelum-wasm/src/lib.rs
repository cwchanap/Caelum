use caelum_core::{
    GameEngine, GameIntent, GameSnapshot, PersistenceError, RoadMutationPreviewRequest,
    RoutePreviewRequest, SandboxCreationRequest, SnapshotSchemaProbe, SNAPSHOT_SCHEMA_VERSION,
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
        // Two-phase: probe `schemaVersion` before the full `GameSnapshot`
        // deserialization so a legacy schema-v3 save (which lacks the required
        // v4 `rules.sandbox.startingCapital` field) is rejected with the
        // structured persistence error instead of a generic
        // missing-field serde error. If the probe cannot read a schema version,
        // treat it as unknown (0) and still reject.
        //
        // `GameEngine::from_snapshot` validates the version again after full
        // deserialization; this probe exists to surface the typed persistence
        // error before deserialization can fail on a schema-v4-only field.
        let probe_schema_version =
            serde_wasm_bindgen::from_value::<SnapshotSchemaProbe>(snapshot.clone())
                .map(|probe| probe.schema_version)
                .unwrap_or(0);
        if probe_schema_version != SNAPSHOT_SCHEMA_VERSION {
            let error = PersistenceError::UnsupportedSchema {
                expected: SNAPSHOT_SCHEMA_VERSION,
                actual: probe_schema_version,
            };
            return Err(serde_wasm_bindgen::to_value(&error).unwrap_or_else(to_js_error));
        }
        let snapshot: GameSnapshot =
            serde_wasm_bindgen::from_value(snapshot).map_err(to_js_error)?;
        let inner = GameEngine::from_snapshot(snapshot)
            .map_err(|error| serde_wasm_bindgen::to_value(&error).unwrap_or_else(to_js_error))?;
        Ok(WasmGameEngine { inner })
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
