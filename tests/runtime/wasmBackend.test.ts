import { describe, expect, it } from "vitest";

import { createWasmBackend } from "../../src/runtime/backend/wasmBackend";

const request = {
  templateId: "blankGrid",
  economyPreset: "standard",
  startingCapital: 120_000,
  demandMultiplier: 1,
  moveInRate: "paused",
} as const;

describe("WASM backend", () => {
  it("uses the final contract for pure build, save, and restore", async () => {
    const backend = await createWasmBackend();
    const before = await backend.snapshot();
    const built = await backend.buildSandboxSnapshot(request);

    expect(built.ok).toBe(true);
    expect(await backend.snapshot()).toEqual(before);

    const saved = await backend.snapshotForSave();
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;

    const restored = await backend.restoreSnapshot(saved.snapshot);
    expect(restored).toEqual(saved);
  });

  it("reports a definitive invalid restore without replacing the engine", async () => {
    const backend = await createWasmBackend();
    const before = await backend.snapshot();
    const candidate = {
      ...before,
      map: { ...before.map, tiles: before.map.tiles.slice(0, -1) },
    };

    await expect(backend.restoreSnapshot(candidate)).resolves.toMatchObject({
      ok: false,
      error: { code: "invalidSnapshot" },
    });
    expect(await backend.snapshot()).toEqual(before);
  });
});
