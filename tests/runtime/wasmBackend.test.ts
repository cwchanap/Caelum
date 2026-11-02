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

  it("forwards the fieldless undoLastBuild intent to the engine", async () => {
    const backend = await createWasmBackend();
    const built = await backend.buildSandboxSnapshot(request);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const restored = await backend.restoreSnapshot(built.snapshot);
    expect(restored.ok).toBe(true);

    const laid = await backend.dispatch({
      type: "layRoadLine",
      points: [
        { x: 2, y: 5 },
        { x: 3, y: 5 },
        { x: 4, y: 5 },
      ],
      preset: "twoWay",
    });
    expect(laid.applied).toBe(true);
    expect(laid.update.frame.budget).toBeLessThan(request.startingCapital);

    const undone = await backend.dispatch({ type: "undoLastBuild" });
    expect(undone.applied).toBe(true);
    expect(undone.rejection).toBeNull();
    expect(undone.update.frame.budget).toBe(request.startingCapital);

    const second = await backend.dispatch({ type: "undoLastBuild" });
    expect(second.applied).toBe(false);
    expect(second.rejection?.code).toBe("nothingToUndo");
  });
});
