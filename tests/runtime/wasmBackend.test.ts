import { afterEach, describe, expect, it, vi } from "vitest";

import { MAP_HEIGHT, MAP_WIDTH } from "../../src/scenario/growingSuburb";
import { createWasmBackend } from "../../src/runtime/backend/wasmBackend";
import type {
  RoadMutationPreviewRequest,
  RoutePreviewRequest,
} from "../../src/runtime/backend/types";

const dims = vi.hoisted(() => ({ width: 0, height: 0 }));

vi.mock("../../src/generated/caelum_wasm/caelum_wasm", () => {
  const init = vi.fn().mockResolvedValue(undefined);
  class WasmGameEngine {
    #paused = true;
    snapshot() {
      return {
        day: 0,
        clockMinutes: 0,
        paused: this.#paused,
        map: { width: dims.width, height: dims.height },
      };
    }
    dispatch(intent: { type: string; paused?: boolean }) {
      if (intent.type === "setPaused" && typeof intent.paused === "boolean") {
        this.#paused = intent.paused;
      }
      return {
        applied: true,
        rejection: null,
        context: {
          changedTiles: [],
          skippedTiles: [],
          affectedRouteIds: [],
          cost: 0,
        },
        snapshot: this.snapshot(),
      };
    }
    tick() {
      return {
        applied: true,
        rejection: null,
        context: {
          changedTiles: [],
          skippedTiles: [],
          affectedRouteIds: [],
          cost: 0,
        },
        snapshot: this.snapshot(),
      };
    }
    reset() {
      return this.snapshot();
    }
    preview_route(request: RoutePreviewRequest) {
      return {
        generation: request.generation,
        rejection: null,
      };
    }
    preview_road_mutation(request: RoadMutationPreviewRequest) {
      return {
        generation: request.generation,
        cost: 100,
        rejection: {
          code: "insufficientBudget",
          context: {
            requiredBudget: 100,
            availableBudget: 99,
            affectedRouteIds: [],
          },
        },
      };
    }
  }
  return { default: init, init, WasmGameEngine };
});

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn().mockResolvedValue(new Uint8Array(0)),
}));

dims.width = MAP_WIDTH;
dims.height = MAP_HEIGHT;

describe("createWasmBackend", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

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
    const backend = await createWasmBackend();
    const initial = await backend.snapshot();

    expect(initial.map.width).toBe(MAP_WIDTH);
    expect(initial.map.height).toBe(MAP_HEIGHT);
  });

  it("inits via the Bun runtime branch", async () => {
    vi.resetModules();
    vi.stubGlobal("Bun", {
      file: () => ({ arrayBuffer: async () => new ArrayBuffer(0) }),
    });
    const wasm =
      (await import("../../src/generated/caelum_wasm/caelum_wasm")) as unknown as {
        init: ReturnType<typeof vi.fn>;
      };
    const { createWasmBackend: create } =
      await import("../../src/runtime/backend/wasmBackend");

    const backend = await create();
    const snap = await backend.snapshot();
    expect(snap).toBeDefined();
    expect(wasm.init).toHaveBeenCalledWith({
      module_or_path: expect.any(ArrayBuffer),
    });
  });

  it("inits via the Node fs readFile branch", async () => {
    vi.resetModules();
    vi.stubGlobal("Bun", undefined);
    vi.stubGlobal("window", undefined);
    // @ts-expect-error — node:fs/promises is only typed under @types/node,
    // which is intentionally absent from tsconfig. The mock provides the impl.
    const fs = (await import("node:fs/promises")) as {
      readFile: ReturnType<typeof vi.fn>;
    };
    const wasm =
      (await import("../../src/generated/caelum_wasm/caelum_wasm")) as unknown as {
        init: ReturnType<typeof vi.fn>;
      };
    const { createWasmBackend: create } =
      await import("../../src/runtime/backend/wasmBackend");

    const backend = await create();
    expect(await backend.snapshot()).toBeDefined();
    expect(fs.readFile).toHaveBeenCalled();
    expect(wasm.init).toHaveBeenCalledWith({
      module_or_path: expect.any(Uint8Array),
    });
  });

  it("inits via the browser branch when window is defined", async () => {
    vi.resetModules();
    vi.stubGlobal("Bun", undefined);
    vi.stubGlobal("window", {});
    const wasm =
      (await import("../../src/generated/caelum_wasm/caelum_wasm")) as unknown as {
        init: ReturnType<typeof vi.fn>;
      };
    const { createWasmBackend: create } =
      await import("../../src/runtime/backend/wasmBackend");

    const backend = await create();
    expect(await backend.snapshot()).toBeDefined();
    expect(wasm.init).toHaveBeenCalledWith();
  });

  it("caches initWasm so init runs only once across backends", async () => {
    vi.resetModules();
    const wasm =
      (await import("../../src/generated/caelum_wasm/caelum_wasm")) as unknown as {
        init: ReturnType<typeof vi.fn>;
      };
    const { createWasmBackend: create } =
      await import("../../src/runtime/backend/wasmBackend");

    await create();
    await create();
    expect(wasm.init).toHaveBeenCalledTimes(1);
  });

  it("dispatches tick intents through the engine and normalizes the result", async () => {
    const backend = await createWasmBackend();
    const result = await backend.tick(0.5);
    expect(result.applied).toBe(true);
    expect(result.rejection).toBeNull();
    expect(result.snapshot).toBeDefined();
  });

  it("resets the engine and returns the fresh snapshot", async () => {
    const backend = await createWasmBackend();
    const resetSnapshot = await backend.reset();
    expect(resetSnapshot).toBeDefined();
    // The mock's reset() returns the current engine snapshot.
    expect(resetSnapshot.day).toBe(0);
  });

  it("forwards route and road preview requests to the WASM engine", async () => {
    const backend = await createWasmBackend();
    const routeRequest: RoutePreviewRequest = {
      mode: "bus",
      pattern: "loop",
      waypointIds: ["stop-001", "stop-002"],
      routeId: null,
      expectedRevision: null,
      generation: 41,
    };
    const roadRequest: RoadMutationPreviewRequest = {
      mutation: { type: "layRoad", point: { x: 4, y: 4 } },
      generation: 42,
    };

    await expect(backend.previewRoute(routeRequest)).resolves.toMatchObject({
      generation: 41,
      rejection: null,
    });
    await expect(backend.previewRoadMutation(roadRequest)).resolves.toEqual({
      generation: 42,
      cost: 100,
      rejection: {
        code: "insufficientBudget",
        context: {
          requiredBudget: 100,
          availableBudget: 99,
          affectedRouteIds: [],
        },
      },
    });
  });
});
