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

    const rejected = await backend.dispatch({
      type: "setSpeed",
      speed: 3 as 0 | 1 | 2 | 4,
    });
    expect(rejected.applied).toBe(false);
    expect(rejected.rejection?.code).toBe("invalidSpeed");
  });

  it("round-trips a placeRoundabout dispatch through wasm-bindgen", async () => {
    const backend = await createWasmBackend();
    const before = await backend.snapshot();
    const structuresBefore = before.map.roadStructures.length;

    const result = await backend.dispatch({
      type: "placeRoundabout",
      origin: { x: 2, y: 2 },
      size: "compact2x2",
    });

    expect(result.applied).toBe(true);
    expect(result.rejection).toBeNull();
    expect(result.snapshot.map.roadStructures.length).toBe(
      structuresBefore + 1,
    );
    expect(
      result.snapshot.map.roadStructures.some((s) => s.kind === "roundabout"),
    ).toBe(true);
  });

  it("round-trips bus stop placement and route preview through wasm-bindgen", async () => {
    const backend = await createWasmBackend();

    const stopA = await backend.dispatch({
      type: "addBusStop",
      point: { x: 10, y: 8 },
    });
    expect(stopA.applied).toBe(true);
    expect(stopA.snapshot.transit.stops).toHaveLength(1);

    const stopB = await backend.dispatch({
      type: "addBusStop",
      point: { x: 5, y: 8 },
    });
    expect(stopB.applied).toBe(true);
    expect(stopB.snapshot.transit.stops).toHaveLength(2);

    const [stopAId, stopBId] = stopB.snapshot.transit.stops.map((s) => s.id);

    const preview = await backend.previewRoute({
      mode: "bus",
      pattern: "loop",
      waypointIds: [stopAId, stopBId],
      routeId: null,
      expectedRevision: null,
      generation: 1,
    });

    expect(Array.isArray(preview.legs)).toBe(true);
    expect(preview.legs.length).toBeGreaterThanOrEqual(1);
    expect(preview.missingWaypointIds).toEqual([]);
  });
});
