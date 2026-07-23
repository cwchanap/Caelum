import init, { WasmGameEngine } from "../../generated/caelum_wasm/caelum_wasm";
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

  let engine = new WasmGameEngine();

  return {
    async snapshot() {
      return engine.snapshot() as RustGameSnapshot;
    },
    async loadSnapshot(snapshot: RustGameSnapshot) {
      engine = WasmGameEngine.from_snapshot(snapshot);
      return engine.snapshot() as RustGameSnapshot;
    },
    async dispatch(intent: GameIntent) {
      return normalizeDispatchResult(engine.dispatch(intent) as DispatchResult);
    },
    async tick(deltaSeconds: number) {
      return normalizeDispatchResult(
        engine.tick(deltaSeconds) as DispatchResult,
      );
    },
    async reset() {
      return engine.reset() as RustGameSnapshot;
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
