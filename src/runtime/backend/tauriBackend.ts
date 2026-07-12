import { invoke } from "@tauri-apps/api/core";

import {
  normalizeDispatchResult,
  normalizeRoadMutationPreviewResponse,
  normalizeRoutePreviewResponse,
} from "./shared";
import type {
  DispatchResult,
  GameBackend,
  GameIntent,
  RoadMutationPreviewRequest,
  RoadMutationPreviewResponse,
  RoutePreviewRequest,
  RoutePreviewResponse,
  RustGameSnapshot,
} from "./types";

export async function createTauriBackend(): Promise<GameBackend> {
  return {
    async snapshot() {
      return invoke<RustGameSnapshot>("game_snapshot");
    },
    async dispatch(intent: GameIntent) {
      const result = await invoke<DispatchResult>("game_dispatch", { intent });
      return normalizeDispatchResult(result);
    },
    async tick(deltaSeconds: number) {
      const result = await invoke<DispatchResult>("game_tick", {
        deltaSeconds,
      });
      return normalizeDispatchResult(result);
    },
    async reset() {
      return invoke<RustGameSnapshot>("game_reset");
    },
    async previewRoute(request: RoutePreviewRequest) {
      const response = await invoke<RoutePreviewResponse>(
        "game_preview_route",
        {
          request,
        },
      );
      return normalizeRoutePreviewResponse(response);
    },
    async previewRoadMutation(request: RoadMutationPreviewRequest) {
      const response = await invoke<RoadMutationPreviewResponse>(
        "game_preview_road_mutation",
        {
          request,
        },
      );
      return normalizeRoadMutationPreviewResponse(response);
    },
  };
}
