import init, { WasmGameEngine } from "../../generated/caelum_wasm/caelum_wasm";
import type {
  DispatchResult,
  GameBackend,
  GameIntent,
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
    const dynamicImport = new Function(
      "specifier",
      "return import(specifier)",
    ) as (specifier: string) => Promise<unknown>;
    const { readFile } = (await dynamicImport("node:fs/promises")) as {
      readFile(path: URL): Promise<Uint8Array>;
    };
    return init({ module_or_path: await readFile(wasmUrl) });
  }

  return init();
}

export async function createWasmBackend(): Promise<GameBackend> {
  await initWasm();

  const engine = new WasmGameEngine();

  return {
    async snapshot() {
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
  };
}

function normalizeDispatchResult(result: DispatchResult): DispatchResult {
  return { ...result, rejection: result.rejection ?? null };
}
