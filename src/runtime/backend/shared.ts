import type { RouteLegPath } from "../../domain/types";
import type { DispatchResult, RoutePreviewResponse } from "./types";

/** Normalize Rust `Option` fields across serde-wasm-bindgen and Tauri JSON. */
export function normalizeRouteLegPath(leg: RouteLegPath): RouteLegPath {
  return {
    ...leg,
    currentPath: leg.currentPath ?? null,
    lastValidPath: leg.lastValidPath ?? null,
    estimatedSeconds: leg.estimatedSeconds ?? null,
  };
}

export function normalizeRoutePreviewResponse(
  response: RoutePreviewResponse,
): RoutePreviewResponse {
  return {
    ...response,
    legs: response.legs.map(normalizeRouteLegPath),
    rejection: response.rejection ?? null,
  };
}

// Both the WASM and Tauri backends round-trip `DispatchResult` through a
// serialization boundary (wasm-bindgen / Tauri IPC). A rejection that the Rust
// core emits as `None` can arrive as `undefined` on the JS side; normalize it to
// `null` so the runtime can treat `rejection` as a typed nullable value.
export function normalizeDispatchResult(
  result: DispatchResult,
): DispatchResult {
  return { ...result, rejection: result.rejection ?? null };
}
