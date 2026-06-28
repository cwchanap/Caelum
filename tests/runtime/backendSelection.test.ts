import { describe, expect, it, vi } from "vitest";

import type { GameBackend } from "../../src/runtime/backend/types";
import { createBackend, isTauriRuntime } from "../../src/runtime/backend";

describe("backend selection", () => {
  it("detects Tauri by the runtime internals marker", () => {
    expect(isTauriRuntime({})).toBe(false);
    expect(isTauriRuntime({ __TAURI_INTERNALS__: {} })).toBe(true);
  });

  it("uses Tauri when the marker exists without creating the WASM backend", async () => {
    const tauriBackend = {} as GameBackend;
    const wasmBackend = {} as GameBackend;
    const createTauri = vi.fn(async () => tauriBackend);
    const createWasm = vi.fn(async () => wasmBackend);

    await expect(
      createBackend({
        windowLike: { __TAURI_INTERNALS__: {} },
        createTauri,
        createWasm,
      }),
    ).resolves.toBe(tauriBackend);

    expect(createTauri).toHaveBeenCalledTimes(1);
    expect(createWasm).not.toHaveBeenCalled();
  });

  it("uses WASM when the Tauri marker is absent", async () => {
    const tauriBackend = {} as GameBackend;
    const wasmBackend = {} as GameBackend;
    const createTauri = vi.fn(async () => tauriBackend);
    const createWasm = vi.fn(async () => wasmBackend);

    await expect(
      createBackend({
        windowLike: {},
        createTauri,
        createWasm,
      }),
    ).resolves.toBe(wasmBackend);

    expect(createTauri).not.toHaveBeenCalled();
    expect(createWasm).toHaveBeenCalledTimes(1);
  });
});
