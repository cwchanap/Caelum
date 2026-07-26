import { invoke } from "@tauri-apps/api/core";

import { isSandboxCreationError, isSandboxResetError } from "./sandboxErrors";
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
  SandboxCreationRequest,
} from "./types";

export async function createTauriBackend(): Promise<GameBackend> {
  return {
    async snapshot() {
      return invoke<RustGameSnapshot>("game_snapshot");
    },
    // No production caller yet — save/load UI is deferred (see plan
    // 2026-07-22-route-editing-frontend.md). Exercised by tauriBackend tests
    // so the migration path through stop_access::normalize_snapshot_stops
    // stays covered.
    async loadSnapshot(snapshot: RustGameSnapshot) {
      return invoke<RustGameSnapshot>("game_load_snapshot", { snapshot });
    },
    async createSandbox(request: SandboxCreationRequest) {
      try {
        const snapshot = await invoke<RustGameSnapshot>("game_create_sandbox", {
          request,
        });
        return { ok: true, snapshot } as const;
      } catch (error: unknown) {
        if (isSandboxCreationError(error)) {
          return { ok: false, error } as const;
        }
        throw error;
      }
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
      try {
        const snapshot = await invoke<RustGameSnapshot>("game_reset");
        return { ok: true, snapshot } as const;
      } catch (error: unknown) {
        if (isSandboxResetError(error)) {
          return { ok: false, error } as const;
        }
        throw error;
      }
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
