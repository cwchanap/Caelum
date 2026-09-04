import { describe, expect, it } from "vitest";

import { createWasmBackend } from "../../src/runtime/backend/wasmBackend";

describe("WASM artifact smoke test", () => {
  it("loads the generated artifact and preserves state on invalid restore", async () => {
    const backend = await createWasmBackend();
    const original = await backend.presentation();
    const saved = await backend.snapshotForSave();

    expect(saved.ok).toBe(true);
    if (!saved.ok) return;

    const invalid = {
      ...saved.snapshot,
      map: { ...saved.snapshot.map, tiles: [] },
    };
    const restored = await backend.restoreSnapshot(invalid);

    expect(restored).toMatchObject({
      ok: false,
      error: { code: "invalidSnapshot" },
    });
    expect(await backend.presentation()).toEqual(original);
  });
});
