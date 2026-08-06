import { afterEach, describe, expect, it, vi } from "vitest";

import { SNAPSHOT_SCHEMA_VERSION } from "../../src/domain/types";
import { MAP_HEIGHT, MAP_WIDTH } from "../../src/scenario/sandbox";
import {
  isSandboxCreationError,
  isSandboxResetError,
} from "../../src/runtime/backend";
import { createWasmBackend } from "../../src/runtime/backend/wasmBackend";
import type {
  RoadMutationPreviewRequest,
  RoutePreviewRequest,
  SandboxCreationRequest,
} from "../../src/runtime/backend/types";
import { createRustSnapshot } from "../fixtures/rustSnapshot";

const dims = vi.hoisted(() => ({ width: 0, height: 0 }));
const fromSandboxRequest = vi.hoisted(() => vi.fn());
const wasmControl = vi.hoisted(() => ({
  init: vi.fn().mockResolvedValue(undefined),
  constructed: [] as object[],
  snapshotForSave: {
    calls: [] as Array<{ receiver: object; args: unknown[] }>,
    value: undefined as unknown,
    error: undefined as unknown,
    shouldThrow: false,
  },
  validateSnapshot: {
    calls: [] as Array<{ receiver: object; snapshot: unknown }>,
    value: undefined as unknown,
    error: undefined as unknown,
    shouldThrow: false,
  },
  restoreSnapshot: {
    calls: [] as Array<{ receiver: object; snapshot: unknown }>,
    value: undefined as unknown,
    error: undefined as unknown,
    shouldThrow: false,
  },
}));
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
      wasmControl.constructed.push(this);
      this.#snapshot = snapshot;
      if (typeof snapshot.paused === "boolean") {
        this.#paused = snapshot.paused;
      }
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
    snapshot_for_save(...args: unknown[]) {
      wasmControl.snapshotForSave.calls.push({ receiver: this, args });
      if (wasmControl.snapshotForSave.shouldThrow) {
        throw wasmControl.snapshotForSave.error;
      }
      return wasmControl.snapshotForSave.value;
    }
    validate_snapshot(snapshot: unknown) {
      wasmControl.validateSnapshot.calls.push({ receiver: this, snapshot });
      if (wasmControl.validateSnapshot.shouldThrow) {
        throw wasmControl.validateSnapshot.error;
      }
      return wasmControl.validateSnapshot.value;
    }
    restore_snapshot(snapshot: unknown) {
      wasmControl.restoreSnapshot.calls.push({ receiver: this, snapshot });
      if (wasmControl.restoreSnapshot.shouldThrow) {
        throw wasmControl.restoreSnapshot.error;
      }
      const restored = wasmControl.restoreSnapshot.value;
      if (typeof restored === "object" && restored !== null) {
        this.#snapshot = restored as Record<string, unknown>;
        if ("paused" in restored && typeof restored.paused === "boolean") {
          this.#paused = restored.paused;
        }
      }
      return restored;
    }
    dispatch(intent: { type: string; paused?: boolean }) {
      if (intent.type === "setPaused" && typeof intent.paused === "boolean") {
        this.#paused = intent.paused;
      }
      return {
        applied: true,
        rejection: null,
        snapshot: this.snapshot(),
      };
    }
    tick() {
      return {
        applied: true,
        rejection: null,
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
  return {
    default: wasmControl.init,
    init: wasmControl.init,
    WasmGameEngine,
  };
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
    wasmControl.init.mockResolvedValue(undefined);
    wasmControl.constructed.length = 0;
    for (const operation of [
      wasmControl.snapshotForSave,
      wasmControl.validateSnapshot,
      wasmControl.restoreSnapshot,
    ]) {
      operation.calls.length = 0;
      operation.value = undefined;
      operation.error = undefined;
      operation.shouldThrow = false;
    }
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

  it("forwards persistence operations to the stable WASM wrapper and preserves raw snapshots", async () => {
    const backend = await createWasmBackend();
    const saved = createRustSnapshot({ paused: true });
    const replacement = createRustSnapshot({
      day: 3,
      clockMinutes: 480,
    });
    wasmControl.snapshotForSave.value = saved;
    wasmControl.validateSnapshot.value = undefined;
    wasmControl.restoreSnapshot.value = replacement;
    const engine = wasmControl.constructed[0];

    await expect(backend.snapshotForSave()).resolves.toEqual({
      ok: true,
      snapshot: saved,
    });
    await expect(
      backend.validateSnapshot({ snapshot: replacement }),
    ).resolves.toEqual({ ok: true });
    await expect(
      backend.restoreSnapshot({ snapshot: replacement }),
    ).resolves.toEqual({
      ok: true,
      snapshot: replacement,
    });
    expect(wasmControl.snapshotForSave.calls).toEqual([
      { receiver: engine, args: [] },
    ]);
    expect(wasmControl.validateSnapshot.calls).toEqual([
      { receiver: engine, snapshot: replacement },
    ]);
    expect(wasmControl.restoreSnapshot.calls).toEqual([
      { receiver: engine, snapshot: replacement },
    ]);
    expect(wasmControl.constructed).toEqual([engine]);
  });

  it("accepts undefined as WASM validation success", async () => {
    wasmControl.validateSnapshot.value = undefined;
    const backend = await createWasmBackend();

    await expect(
      backend.validateSnapshot({ snapshot: createRustSnapshot() }),
    ).resolves.toEqual({ ok: true });
  });

  it("rejects null as malformed WASM validation success", async () => {
    wasmControl.validateSnapshot.value = null;
    const backend = await createWasmBackend();

    await expect(
      backend.validateSnapshot({ snapshot: createRustSnapshot() }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        kind: "host",
        operation: "validateSnapshot",
        code: "malformedSuccess",
      },
    });
  });

  it("preserves known WASM bridge errors as typed results", async () => {
    const error = {
      kind: "validation",
      operation: "restoreSnapshot",
      source: "candidate",
      error: {
        code: "unsupportedSchema",
        context: {
          expected: SNAPSHOT_SCHEMA_VERSION,
          actual: SNAPSHOT_SCHEMA_VERSION - 1,
        },
      },
    } as const;
    wasmControl.restoreSnapshot.shouldThrow = true;
    wasmControl.restoreSnapshot.error = error;
    const backend = await createWasmBackend();

    await expect(
      backend.restoreSnapshot({ snapshot: createRustSnapshot() }),
    ).resolves.toEqual({ ok: false, error });
  });

  it("maps malformed WASM successes and errors through the shared contract", async () => {
    wasmControl.snapshotForSave.value = { schemaVersion: "4" };
    const backend = await createWasmBackend();

    await expect(backend.snapshotForSave()).resolves.toMatchObject({
      ok: false,
      error: {
        kind: "host",
        operation: "snapshotForSave",
        code: "malformedSuccess",
      },
    });

    wasmControl.validateSnapshot.shouldThrow = true;
    wasmControl.validateSnapshot.error = { unexpected: true };
    await expect(
      backend.validateSnapshot({ snapshot: createRustSnapshot() }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        kind: "host",
        operation: "validateSnapshot",
        code: "malformedError",
      },
    });
  });

  it("rejects a wrong-schema WASM snapshot success", async () => {
    wasmControl.restoreSnapshot.value = {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION - 1,
    };
    const backend = await createWasmBackend();

    await expect(
      backend.restoreSnapshot({ snapshot: createRustSnapshot() }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        kind: "host",
        operation: "restoreSnapshot",
        code: "malformedSuccess",
      },
    });
  });

  it("rejects backend creation on initialization failure without constructing an engine", async () => {
    vi.resetModules();
    wasmControl.constructed.length = 0;
    const initError = new Error("WASM initialization failed");
    wasmControl.init.mockRejectedValueOnce(initError);
    const { createWasmBackend: create } =
      await import("../../src/runtime/backend/wasmBackend");

    await expect(create()).rejects.toBe(initError);
    expect(wasmControl.constructed).toHaveLength(0);
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
