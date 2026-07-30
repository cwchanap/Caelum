import { afterEach, describe, expect, it, vi } from "vitest";

import { MAP_HEIGHT, MAP_WIDTH } from "../../src/scenario/sandbox";
import {
  isSandboxCreationError,
  isSandboxResetError,
} from "../../src/runtime/backend";
import { createWasmBackend } from "../../src/runtime/backend/wasmBackend";
import type {
  RoadMutationPreviewRequest,
  RoutePreviewRequest,
  RustGameSnapshot,
  SandboxCreationRequest,
} from "../../src/runtime/backend/types";

const dims = vi.hoisted(() => ({ width: 0, height: 0 }));
const fromSnapshot = vi.hoisted(() => vi.fn());
const fromSandboxRequest = vi.hoisted(() => vi.fn());
const sandboxFactory = vi.hoisted(
  (): {
    rejection: unknown;
    snapshot: Record<string, unknown> | null;
    resetRejection: unknown;
  } => ({
    rejection: undefined,
    snapshot: null,
    resetRejection: undefined,
  }),
);

vi.mock("../../src/generated/caelum_wasm/caelum_wasm", () => {
  const init = vi.fn().mockResolvedValue(undefined);
  class WasmGameEngine {
    #snapshot: Record<string, unknown>;
    #paused = true;

    constructor(
      snapshot: Record<string, unknown> = {
        day: 0,
        clockMinutes: 0,
        paused: true,
        map: { width: dims.width, height: dims.height },
      },
    ) {
      this.#snapshot = snapshot;
      if (typeof snapshot.paused === "boolean") {
        this.#paused = snapshot.paused;
      }
    }

    static from_snapshot(snapshot: unknown) {
      fromSnapshot(snapshot);
      return new WasmGameEngine(snapshot as Record<string, unknown>);
    }

    static from_sandbox_request(request: SandboxCreationRequest) {
      fromSandboxRequest(request);
      if (sandboxFactory.rejection !== undefined) {
        throw sandboxFactory.rejection;
      }
      return new WasmGameEngine(
        sandboxFactory.snapshot ?? {
          day: 0,
          clockMinutes: 0,
          paused: true,
          budget: request.startingCapital,
          rules: {
            gameMode: "sandbox",
            economyPreset: request.economyPreset,
            sandbox: {
              templateId: request.templateId,
              startingCapital: request.startingCapital,
              demandMultiplier: request.demandMultiplier,
              moveInRate: request.moveInRate,
            },
          },
          map: { width: dims.width, height: dims.height },
        },
      );
    }

    snapshot() {
      return {
        ...this.#snapshot,
        paused: this.#paused,
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
      if (sandboxFactory.resetRejection !== undefined) {
        throw sandboxFactory.resetRejection;
      }
      return this.snapshot();
    }
    preview_route(request: RoutePreviewRequest) {
      return {
        generation: request.generation,
        legs: [
          {
            fromWaypointId: request.waypointIds[0],
            toWaypointId: request.waypointIds[1],
            direction: request.pattern === "loop" ? "loop" : "outbound",
            kind: "service",
            status: "networkDisconnected",
            currentPath: undefined,
            lastValidPath: undefined,
            estimatedSeconds: undefined,
          },
        ],
        totalTravelSeconds: 0,
        initialVehicleCost: 0,
        affordable: true,
        turnSummary: {
          straight: 0,
          rightTurn: 0,
          leftTurn: 0,
          uTurn: 0,
          roundaboutEntry: 0,
        },
        missingWaypointIds: [],
        warnings: [],
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
    sandboxFactory.rejection = undefined;
    sandboxFactory.snapshot = null;
    sandboxFactory.resetRejection = undefined;
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

  it("resets the engine and returns the fresh snapshot result", async () => {
    const backend = await createWasmBackend();
    const result = await backend.reset();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected reset success");
    // The mock's reset() returns the current engine snapshot.
    expect(result.snapshot.day).toBe(0);
  });

  it("constructs a requested sandbox candidate before replacing the engine", async () => {
    const backend = await createWasmBackend();
    const request: SandboxCreationRequest = {
      templateId: "blankGrid",
      economyPreset: "creative",
      startingCapital: 42_000,
      demandMultiplier: 1.5,
      moveInRate: "paused",
    };

    const result = await backend.createSandbox(request);

    expect(fromSandboxRequest).toHaveBeenCalledWith(request);
    expect(result).toMatchObject({
      ok: true,
      snapshot: {
        budget: 42_000,
        rules: {
          economyPreset: "creative",
          sandbox: {
            templateId: "blankGrid",
            startingCapital: 42_000,
            demandMultiplier: 1.5,
          },
        },
      },
    });
    await expect(backend.snapshot()).resolves.toMatchObject({
      budget: 42_000,
    });
  });

  it("returns typed requested-construction failures without replacing the engine", async () => {
    const backend = await createWasmBackend();
    const before = await backend.snapshot();
    const error = {
      code: "invalidStartingCapital",
      context: {
        field: "startingCapital",
        attemptedValue: "-1",
      },
    };
    sandboxFactory.rejection = error;

    await expect(
      backend.createSandbox({
        templateId: "blankGrid",
        economyPreset: "standard",
        startingCapital: -1,
        demandMultiplier: 1,
        moveInRate: "paused",
      }),
    ).resolves.toEqual({ ok: false, error });
    await expect(backend.snapshot()).resolves.toEqual(before);
  });

  it("rethrows unexpected requested-construction string failures", async () => {
    const backend = await createWasmBackend();
    sandboxFactory.rejection = "serialization failed";

    await expect(
      backend.createSandbox({
        templateId: "crossroads",
        economyPreset: "standard",
        startingCapital: 120_000,
        demandMultiplier: 1,
        moveInRate: "paused",
      }),
    ).rejects.toBe("serialization failed");
  });

  it("returns typed reset failures and rethrows unexpected reset strings", async () => {
    const backend = await createWasmBackend();
    const error = {
      code: "unsupportedGameMode",
      context: { gameMode: "campaign" },
    };
    sandboxFactory.resetRejection = error;

    await expect(backend.reset()).resolves.toEqual({ ok: false, error });

    sandboxFactory.resetRejection = "reset serialization failed";
    await expect(backend.reset()).rejects.toBe("reset serialization failed");
  });

  it("loads a serialized snapshot and replaces the WASM engine", async () => {
    const backend = await createWasmBackend();
    const replacement = {
      ...(await backend.snapshot()),
      day: 3,
      clockMinutes: 480,
      paused: false,
    } as RustGameSnapshot;

    expect(backend.loadSnapshot).toBeDefined();
    const loaded = await backend.loadSnapshot!(replacement);

    expect(fromSnapshot).toHaveBeenCalledWith(replacement);
    expect(loaded).toMatchObject({
      day: 3,
      clockMinutes: 480,
      paused: false,
    });

    const dispatched = await backend.dispatch({
      type: "setPaused",
      paused: true,
    });
    expect(dispatched.snapshot).toMatchObject({
      day: 3,
      clockMinutes: 480,
      paused: true,
    });
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

  it.each([
    ["bus", ["stop-001", "stop-002"]],
    ["metro", ["station-001", "station-002"]],
  ] as const)(
    "normalizes broken %s preview leg options at the WASM boundary",
    async (mode, waypointIds) => {
      const backend = await createWasmBackend();

      const response = await backend.previewRoute({
        mode,
        pattern: "shuttle",
        waypointIds: [...waypointIds],
        routeId: null,
        expectedRevision: null,
        generation: mode === "bus" ? 61 : 62,
      });

      expect(response.legs).toHaveLength(1);
      expect(response.legs[0]).toMatchObject({
        fromWaypointId: waypointIds[0],
        toWaypointId: waypointIds[1],
        currentPath: null,
        lastValidPath: null,
        estimatedSeconds: null,
      });
    },
  );
});

describe("sandbox domain error guards", () => {
  it.each([
    "unknownTemplateId",
    "unknownEconomyPreset",
    "invalidStartingCapital",
    "invalidDemandMultiplier",
    "unknownMoveInRate",
    "templateInvariantViolation",
  ])("accepts exact creation code %s with valid recognized context", (code) => {
    expect(
      isSandboxCreationError({
        code,
        context: {
          field: "templateId",
          attemptedValue: "unknown",
          templateId: "crossroads",
        },
      }),
    ).toBe(true);
  });

  it.each([
    { code: "futureCode", context: {} },
    { code: "unknownTemplateId", context: [] },
    { code: "unknownTemplateId", context: null },
    {
      code: "invalidStartingCapital",
      context: { attemptedValue: 42 },
    },
  ])("rejects malformed creation domain value %#", (value) => {
    expect(isSandboxCreationError(value)).toBe(false);
  });

  it("accepts additional unknown creation context fields", () => {
    expect(
      isSandboxCreationError({
        code: "unknownTemplateId",
        context: {
          field: "templateId",
          attemptedValue: "unknown",
          futureDiagnostic: { value: 1 },
        },
      }),
    ).toBe(true);
  });

  it("accepts a null-prototype plain object as context", () => {
    // `Object.create(null)` has a null prototype, which `isPlainObject` must
    // still recognize as a plain object (the `prototype === null` branch).
    const context = Object.create(null);
    context.templateId = "crossroads";
    expect(isSandboxCreationError({ code: "unknownTemplateId", context })).toBe(
      true,
    );
  });

  it("accepts a null-prototype plain object as the reset context", () => {
    const context = Object.create(null);
    expect(isSandboxResetError({ code: "unsupportedGameMode", context })).toBe(
      true,
    );
  });

  it.each(["unsupportedGameMode", "templateInvariantViolation"])(
    "accepts exact reset code %s with valid recognized context",
    (code) => {
      expect(
        isSandboxResetError({
          code,
          context: {
            gameMode: "campaign",
            templateId: "crossroads",
          },
        }),
      ).toBe(true);
    },
  );

  it.each([
    { code: "futureCode", context: {} },
    { code: "unsupportedGameMode", context: [] },
    { code: "unsupportedGameMode", context: null },
    { code: "unsupportedGameMode", context: { gameMode: "unknown" } },
    {
      code: "templateInvariantViolation",
      context: { templateId: "growingSuburb" },
    },
  ])("rejects malformed reset domain value %#", (value) => {
    expect(isSandboxResetError(value)).toBe(false);
  });

  it("accepts additional unknown reset context fields", () => {
    expect(
      isSandboxResetError({
        code: "unsupportedGameMode",
        context: {
          gameMode: "campaign",
          futureDiagnostic: { value: 1 },
        },
      }),
    ).toBe(true);
  });
});
