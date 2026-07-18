import { describe, expect, it } from "vitest";

import { SNAPSHOT_SCHEMA_VERSION } from "../../src/domain/types";
import { createWasmBackend } from "../../src/runtime/backend/wasmBackend";

/**
 * Loads the real built WASM artifact (not the vi.mock in wasmBackend.test.ts).
 * Requires `bun run ensure-wasm` / pretest hook so src/generated/caelum_wasm exists.
 */
describe("real WASM artifact smoke", () => {
  it("loads the built module and returns a schema-valid snapshot", async () => {
    const backend = await createWasmBackend();
    const snapshot = await backend.snapshot();

    expect(snapshot.schemaVersion).toBe(SNAPSHOT_SCHEMA_VERSION);
    expect(snapshot.map.width).toBeGreaterThan(0);
    expect(snapshot.map.height).toBeGreaterThan(0);
    expect(Array.isArray(snapshot.map.tiles)).toBe(true);
    expect(snapshot.map.tiles.length).toBe(
      snapshot.map.width * snapshot.map.height,
    );

    const tick = await backend.tick(0);
    expect(tick.rejection).toBeNull();
    expect(typeof tick.applied).toBe("boolean");
    expect(tick.snapshot.schemaVersion).toBe(SNAPSHOT_SCHEMA_VERSION);

    const rejected = await backend.dispatch({ type: "setSpeed", speed: 3 });
    expect(rejected.applied).toBe(false);
    expect(rejected.rejection?.code).toBe("invalidSpeed");
  });
});
