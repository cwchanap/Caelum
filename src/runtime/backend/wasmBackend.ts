import init, { WasmGameEngine } from "../../generated/caelum_wasm/caelum_wasm";
import { isSandboxCreationError, isSandboxResetError } from "./sandboxErrors";
import { runRestoreOperation, runSnapshotOperation } from "./persistence";
import {
  normalizeUpdateResult,
  normalizeRoadMutationPreviewResponse,
  normalizeRoutePreviewResponse,
} from "./shared";
import type {
  GameBackend,
  GameIntent,
  GameplayUpdateResult,
  PresentationUpdate,
  RoadMutationPreviewRequest,
  RoadMutationPreviewResponse,
  RoutePreviewRequest,
  RoutePreviewResponse,
  SandboxCreationRequest,
} from "./types";

let initPromise: Promise<unknown> | null = null;

type BunRuntime = {
  file(path: URL): { arrayBuffer(): Promise<ArrayBuffer> };
};

function initWasm(): Promise<unknown> {
  initPromise ??= initWithRuntimeWasmSource();
  return initPromise;
}

async function initWithRuntimeWasmSource(): Promise<unknown> {
  const wasmUrl = new URL(
    "../../generated/caelum_wasm/caelum_wasm_bg.wasm",
    import.meta.url,
  );
  const bun = (globalThis as typeof globalThis & { Bun?: BunRuntime }).Bun;
  if (bun !== undefined) {
    return init({ module_or_path: await bun.file(wasmUrl).arrayBuffer() });
  }

  if (typeof window === "undefined") {
    // @ts-expect-error - node:fs/promises is only available in Node/Vitest, not browser
    const { readFile } = await import(/* @vite-ignore */ "node:fs/promises");
    return init({ module_or_path: await readFile(wasmUrl) });
  }

  return init();
}

export async function createWasmBackend(): Promise<GameBackend> {
  await initWasm();

  const engine = new WasmGameEngine();

  return {
    presentation() {
      return Promise.resolve(engine.presentation() as PresentationUpdate);
    },
    snapshotForSave() {
      return runSnapshotOperation(() => engine.snapshot_for_save());
    },
    restoreSnapshot(snapshot) {
      return runRestoreOperation(() => engine.restore_snapshot(snapshot));
    },
    async buildSandboxSnapshot(request: SandboxCreationRequest) {
      try {
        const snapshot = WasmGameEngine.build_sandbox_snapshot(request);
        return { ok: true, snapshot } as const;
      } catch (error: unknown) {
        if (isSandboxCreationError(error)) {
          return { ok: false, error } as const;
        }
        throw error;
      }
    },
    async dispatch(intent: GameIntent) {
      return normalizeUpdateResult(
        engine.dispatch(intent) as GameplayUpdateResult,
      );
    },
    async tick(deltaSeconds: number) {
      return normalizeUpdateResult(
        engine.tick(deltaSeconds) as GameplayUpdateResult,
      );
    },
    async reset() {
      try {
        const update = engine.reset() as PresentationUpdate;
        return { ok: true, update } as const;
      } catch (error: unknown) {
        if (isSandboxResetError(error)) {
          return { ok: false, error } as const;
        }
        throw error;
      }
    },
    async previewRoute(request: RoutePreviewRequest) {
      const response = engine.preview_route(request) as RoutePreviewResponse;
      return normalizeRoutePreviewResponse(response);
    },
    async previewRoadMutation(request: RoadMutationPreviewRequest) {
      const response = engine.preview_road_mutation(
        request,
      ) as RoadMutationPreviewResponse;
      return normalizeRoadMutationPreviewResponse(response);
    },
  };
}
