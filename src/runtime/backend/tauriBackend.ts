import { invoke } from "@tauri-apps/api/core";

import { isSandboxCreationError, isSandboxResetError } from "./sandboxErrors";
import {
  runPersistenceSnapshotOperation,
  runPersistenceValidationOperation,
} from "./persistence";
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
  RuntimeSession,
  RustGameSnapshot,
  SandboxCreationRequest,
} from "./types";

export async function createTauriBackend(): Promise<GameBackend> {
  // The runtime epoch is acquired atomically via `game_begin_runtime` and
  // carried on every subsequent mutating command. The Rust host rejects
  // commands whose epoch does not match the current `OwnedEngine` epoch,
  // preventing a stale command from a previous webview realm (after a soft
  // reload) from mutating the engine after a new runtime session has begun.
  let runtimeEpoch = 0;
  return {
    // The Tauri backend is process-global: every facade invokes commands
    // against one `Mutex<GameEngine>` in the Rust host. All facades share
    // one stable identity so the backend ownership coordinator gives them
    // one exclusive lease, serializing runtime lifetimes across separate
    // facade objects that address the same engine.
    runtimeIdentity: "tauri:process-engine",
    async beginRuntime(): Promise<RuntimeSession> {
      const response = await invoke<{
        runtimeEpoch: number;
        snapshot: RustGameSnapshot;
      }>("game_begin_runtime");
      runtimeEpoch = response.runtimeEpoch;
      return response;
    },
    async snapshot() {
      return invoke<RustGameSnapshot>("game_snapshot");
    },
    snapshotForSave() {
      return runPersistenceSnapshotOperation("snapshotForSave", () =>
        invoke("game_snapshot_for_save", { runtimeEpoch }),
      );
    },
    validateSnapshot(request) {
      return runPersistenceValidationOperation(null, () =>
        invoke("game_validate_snapshot", { snapshot: request.snapshot }),
      );
    },
    restoreSnapshot(request) {
      return runPersistenceSnapshotOperation("restoreSnapshot", () =>
        invoke("game_restore_snapshot", {
          snapshot: request.snapshot,
          runtimeEpoch,
        }),
      );
    },
    async createSandbox(request: SandboxCreationRequest) {
      try {
        const snapshot = await invoke<RustGameSnapshot>("game_create_sandbox", {
          request,
          runtimeEpoch,
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
      const result = await invoke<DispatchResult>("game_dispatch", {
        intent,
        runtimeEpoch,
      });
      return normalizeDispatchResult(result);
    },
    async tick(deltaSeconds: number) {
      const result = await invoke<DispatchResult>("game_tick", {
        deltaSeconds,
        runtimeEpoch,
      });
      return normalizeDispatchResult(result);
    },
    async reset() {
      try {
        const snapshot = await invoke<RustGameSnapshot>("game_reset", {
          runtimeEpoch,
        });
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
