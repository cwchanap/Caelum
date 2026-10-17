import { describe, expect, it } from "vitest";

import { createWasmBackend } from "../../src/runtime/backend/wasmBackend";

const request = {
  templateId: "blankGrid",
  mapSize: "small",
  economyPreset: "standard",
  startingCapital: 120_000,
  demandMultiplier: 1,
} as const;

describe("WASM backend", () => {
  it("uses the final contract for pure build, save, and restore", async () => {
    const backend = await createWasmBackend();
    const before = await backend.presentation();
    const built = await backend.buildSandboxSnapshot(request);

    expect(built.ok).toBe(true);
    expect(await backend.presentation()).toEqual(before);

    const saved = await backend.snapshotForSave();
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;

    const restored = await backend.restoreSnapshot(saved.snapshot);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.update.scene).not.toBeNull();
    expect(restored.update.frame.budget).toBe(saved.snapshot.budget);
  });

  it("reports ticks as frame-only updates", async () => {
    const backend = await createWasmBackend();
    await backend.dispatch({ type: "setPaused", paused: false });

    const result = await backend.tick(0.5);

    expect(result.applied).toBe(true);
    expect(result.update.scene).toBeNull();
  });
});
