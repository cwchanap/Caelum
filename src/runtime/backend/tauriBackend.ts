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
  //
  // The epoch is null until `beginRuntime` completes. The Rust host's
  // `OwnedEngine` starts at epoch 0, so a pre-session `runtimeEpoch: 0`
  // would match the host's initial epoch and be accepted — allowing
  // unsessioned mutations. Rejecting all mutating commands while the epoch
  // is null closes that gap: no command reaches the host before a session
  // has begun.
  let runtimeEpoch: number | null = null;
  const requireEpoch = (): number => {
    if (runtimeEpoch === null) {
      throw new Error(
        "Tauri backend command invoked before beginRuntime completed",
      );
    }
    return runtimeEpoch;
  };
  return {
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
    async snapshotForSave() {
      const epoch = requireEpoch();
      return runPersistenceSnapshotOperation("snapshotForSave", () =>
        invoke("game_snapshot_for_save", { runtimeEpoch: epoch }),
      );
    },
    validateSnapshot(request) {
      return runPersistenceValidationOperation(null, () =>
        invoke("game_validate_snapshot", { snapshot: request.snapshot }),
      );
    },
    async restoreSnapshot(request) {
      const epoch = requireEpoch();
      return runPersistenceSnapshotOperation("restoreSnapshot", () =>
        invoke("game_restore_snapshot", {
          snapshot: request.snapshot,
          runtimeEpoch: epoch,
        }),
      );
    },
    async createSandbox(request: SandboxCreationRequest) {
      const epoch = requireEpoch();
      try {
        const snapshot = await invoke<RustGameSnapshot>("game_create_sandbox", {
          request,
          runtimeEpoch: epoch,
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
      const epoch = requireEpoch();
      const result = await invoke<DispatchResult>("game_dispatch", {
        intent,
        runtimeEpoch: epoch,
      });
      return normalizeDispatchResult(result);
    },
    async tick(deltaSeconds: number) {
      const epoch = requireEpoch();
      const result = await invoke<DispatchResult>("game_tick", {
        deltaSeconds,
        runtimeEpoch: epoch,
      });
      return normalizeDispatchResult(result);
    },
    async reset() {
      const epoch = requireEpoch();
      try {
        const snapshot = await invoke<RustGameSnapshot>("game_reset", {
          runtimeEpoch: epoch,
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
