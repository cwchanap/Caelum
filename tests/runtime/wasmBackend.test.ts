import { describe, expect, it } from "vitest";

import { MAP_HEIGHT, MAP_WIDTH } from "../../src/scenario/growingSuburb";
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

  it("exposes map dimensions matching the TS mirror of the Rust constants", async () => {
    // Drift guard: `src/scenario/growingSuburb.ts` hand-mirrors
    // `crates/caelum-core/src/scenario.rs` (MAP_WIDTH / MAP_HEIGHT). The e2e
    // helpers and render geometry both key off the TS constants, so a silent
    // drift would misalign every tile→pixel mapping. Assert against the real
    // WASM snapshot — the authoritative source — rather than the mirrored value.
    const backend = await createWasmBackend();
    const initial = await backend.snapshot();

    expect(initial.map.width).toBe(MAP_WIDTH);
    expect(initial.map.height).toBe(MAP_HEIGHT);
  });
});
