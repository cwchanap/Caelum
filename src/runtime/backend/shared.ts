import type { GameplayRejection, RouteLegPath } from "../../domain/types";
import type {
  DispatchResult,
  RoadMutationPreviewResponse,
  RoutePreviewResponse,
} from "./types";

/** Normalize Rust `Option` fields across serde-wasm-bindgen and Tauri JSON. */
export function normalizeRouteLegPath(leg: RouteLegPath): RouteLegPath {
  return {
    ...leg,
    currentPath: leg.currentPath ?? null,
    lastValidPath: leg.lastValidPath ?? null,
    estimatedSeconds: leg.estimatedSeconds ?? null,
    failureReason: leg.failureReason ?? null,
  };
}

function normalizeGameplayRejection(
  rejection: GameplayRejection | null | undefined,
): GameplayRejection | null {
  if (rejection == null) return null;
  return {
    ...rejection,
    context: {
      ...rejection.context,
      affectedRouteIds: rejection.context.affectedRouteIds ?? [],
    },
  };
}

export function normalizeRoutePreviewResponse(
  response: RoutePreviewResponse,
): RoutePreviewResponse {
  return {
    ...response,
    legs: response.legs.map(normalizeRouteLegPath),
    rejection: normalizeGameplayRejection(response.rejection),
  };
}

// Both the WASM and Tauri backends round-trip `DispatchResult` through a
// serialization boundary (wasm-bindgen / Tauri IPC). A rejection that the Rust
// core emits as `None` can arrive as `undefined` on the JS side; normalize it to
// `null` so the runtime can treat `rejection` as a typed nullable value.
export function normalizeDispatchResult(
  result: DispatchResult,
): DispatchResult {
  return {
    ...result,
    rejection: normalizeGameplayRejection(result.rejection),
    context: {
      ...result.context,
      affectedRouteIds: result.context.affectedRouteIds ?? [],
    },
  };
}

// Same normalization concern as `normalizeDispatchResult` and
// `normalizeRoutePreviewResponse`: serde-wasm-bindgen may omit a Rust `None`
// rejection, while Tauri JSON emits `null`. Normalize to `null` so the runtime
// can treat `rejection` as a typed nullable value.
export function normalizeRoadMutationPreviewResponse(
  response: RoadMutationPreviewResponse,
): RoadMutationPreviewResponse {
  return {
    ...response,
    rejection: normalizeGameplayRejection(response.rejection),
  };
}
