import { describe, expect, it } from "vitest";

import { createWasmBackend } from "../../src/runtime/backend/wasmBackend";

describe("createWasmBackend", () => {
  it("creates a Rust WASM backend and dispatches pause intents", async () => {
    const backend = await createWasmBackend();

    const initial = await backend.snapshot();
    expect(initial.paused).toBe(true);
    expect(initial.day).toBe(0);
    expect(initial.clockMinutes).toBe(0);

    const result = await backend.dispatch({ type: "setPaused", paused: false });

    expect(result.applied).toBe(true);
    expect(result.rejection).toBeNull();
    expect(result.snapshot.paused).toBe(false);
  });
});
