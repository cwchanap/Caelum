import { invoke } from "@tauri-apps/api/core";

import { isSandboxCreationError, isSandboxResetError } from "./sandboxErrors";
import { runRestoreOperation, runSnapshotOperation } from "./persistence";
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
  // The epoch is private to this adapter. It is acquired before the backend is
  // returned and is carried on every command that can replace or mutate the
  // managed native engine.
  const session = await invoke<{
    runtimeEpoch: number;
    snapshot: RustGameSnapshot;
  }>("game_begin_runtime");
  const runtimeEpoch = session.runtimeEpoch;
  let initialSnapshotPending = true;

  return {
    async snapshot() {
      if (initialSnapshotPending) {
        initialSnapshotPending = false;
        return session.snapshot;
      }
      return invoke<RustGameSnapshot>("game_snapshot");
    },
    snapshotForSave() {
      return runSnapshotOperation(() =>
        invoke("game_snapshot_for_save", { runtimeEpoch }),
      );
    },
    restoreSnapshot(snapshot) {
      return runRestoreOperation(() =>
        invoke("game_restore_snapshot", {
          snapshot,
          runtimeEpoch,
        }),
      );
    },
    async buildSandboxSnapshot(request: SandboxCreationRequest) {
      try {
        const snapshot = await invoke<RustGameSnapshot>(
          "game_build_sandbox_snapshot",
          { request },
        );
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
