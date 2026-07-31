import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  DispatchResult,
  GameIntent,
  RoadMutationPreviewRequest,
  RoutePreviewRequest,
  RustGameSnapshot,
  SandboxCreationRequest,
} from "../../src/runtime/backend/types";
import { SNAPSHOT_SCHEMA_VERSION } from "../../src/domain/types";
import { createRustSnapshot } from "../fixtures/rustSnapshot";

// Mock the Tauri IPC bridge so the backend can be exercised in a node test
// environment without a real Tauri runtime. The mock captures every `invoke`
// call so the tests can assert the exact command name and argument shape the
// TS wrapper passes across the IPC boundary — the contract the Rust
// `#[tauri::command]` handlers in `src-tauri/src/lib.rs` depend on.
const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: Record<string, unknown>) =>
    invokeMock(command, args),
}));

// Importing after the mock is registered ensures the backend module picks up
// the mocked `invoke`.
import { createTauriBackend } from "../../src/runtime/backend/tauriBackend";

describe("createTauriBackend", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("snapshot() invokes game_snapshot with no args and returns the raw snapshot", async () => {
    const snapshot = createRustSnapshot({ paused: false });
    invokeMock.mockResolvedValueOnce(snapshot);

    const backend = await createTauriBackend();
    const result = await backend.snapshot();

    expect(invokeMock).toHaveBeenCalledWith("game_snapshot", undefined);
    expect(result).toEqual(snapshot);
    expect(result.paused).toBe(false);
    expect(result.scenario.objectives).toBeNull();
    expect(result.scenario.growthWaves).toEqual([]);
    expect(result.rules).toEqual({
      gameMode: "sandbox",
      economyPreset: "standard",
      sandbox: {
        templateId: "crossroads",
        startingCapital: 120_000,
        demandMultiplier: 1,
        moveInRate: "paused",
      },
    });
  });

  it("dispatch() invokes game_dispatch with the intent and normalizes a None rejection", async () => {
    const snapshot = createRustSnapshot({ paused: false });
    // Tauri's serde_json serializer emits `null` for `Option<String>::None`,
    // but the JS value arrives as `null` here. The wrapper must still pass it
    // through `normalizeDispatchResult` so a hypothetical `undefined` (the
    // serde-wasm-bindgen shape) would also be coerced to `null`.
    const raw: DispatchResult = {
      snapshot,
      applied: true,
      rejection: null,
      context: {
        changedTiles: [],
        skippedTiles: [],
        affectedRouteIds: [],
        cost: 0,
      },
    };
    invokeMock.mockResolvedValueOnce(raw);

    const backend = await createTauriBackend();
    const intent: GameIntent = { type: "setPaused", paused: false };
    const result = await backend.dispatch(intent);

    expect(invokeMock).toHaveBeenCalledWith("game_dispatch", { intent });
    expect(result.applied).toBe(true);
    expect(result.rejection).toBeNull();
    expect(result.snapshot.paused).toBe(false);
  });

  it("dispatch() coerces an undefined rejection (serde-wasm-bindgen shape) to null", async () => {
    // Guards the cross-serializer divergence: serde_json emits `null` for
    // `None`, while serde-wasm-bindgen can drop the field to `undefined`. The
    // Tauri wrapper shares `normalizeDispatchResult` with the WASM wrapper, so
    // it must tolerate both shapes and always surface `string | null`.
    const snapshot = createRustSnapshot();
    const raw = {
      snapshot,
      applied: true,
      rejection: undefined,
      context: {
        changedTiles: [],
        skippedTiles: [],
        affectedRouteIds: [],
        cost: 0,
      },
    } as unknown as DispatchResult;
    invokeMock.mockResolvedValueOnce(raw);

    const backend = await createTauriBackend();
    const result = await backend.dispatch({ type: "setSpeed", speed: 2 });

    expect(result.rejection).toBeNull();
    expect(result.applied).toBe(true);
  });

  it("dispatch() preserves a structured Some rejection unchanged", async () => {
    const snapshot = createRustSnapshot();
    const raw: DispatchResult = {
      snapshot,
      applied: false,
      rejection: {
        code: "invalidSpeed",
        context: { affectedRouteIds: [] },
      },
      context: {
        changedTiles: [],
        skippedTiles: [],
        affectedRouteIds: [],
        cost: 0,
      },
    };
    invokeMock.mockResolvedValueOnce(raw);

    const backend = await createTauriBackend();
    // The TS `GameIntent.setSpeed` type constrains speed to `0 | 1 | 2 | 4`,
    // but the Rust field is `u8` and the engine rejects out-of-range values at
    // runtime. Cast to exercise the rejection path that a Tauri host would
    // surface if a malformed intent reached the command handler.
    const intent = { type: "setSpeed", speed: 3 } as unknown as GameIntent;
    const result = await backend.dispatch(intent);

    expect(invokeMock).toHaveBeenCalledWith("game_dispatch", { intent });
    expect(result.applied).toBe(false);
    expect(result.rejection).toEqual({
      code: "invalidSpeed",
      context: { affectedRouteIds: [] },
    });
  });

  it("tick() invokes game_tick with deltaSeconds and normalizes the result", async () => {
    const snapshot = createRustSnapshot({ day: 1 });
    const raw: DispatchResult = {
      snapshot,
      applied: true,
      rejection: null,
      context: {
        changedTiles: [],
        skippedTiles: [],
        affectedRouteIds: [],
        cost: 0,
      },
    };
    invokeMock.mockResolvedValueOnce(raw);

    const backend = await createTauriBackend();
    const result = await backend.tick(0.5);

    expect(invokeMock).toHaveBeenCalledWith("game_tick", { deltaSeconds: 0.5 });
    expect(result.applied).toBe(true);
    expect(result.rejection).toBeNull();
    expect(result.snapshot.day).toBe(1);
  });

  it("reset() invokes game_reset with no args and returns a success result", async () => {
    const snapshot = createRustSnapshot({ day: 0, paused: true });
    invokeMock.mockResolvedValueOnce(snapshot);

    const backend = await createTauriBackend();
    const result = await backend.reset();

    expect(invokeMock).toHaveBeenCalledWith("game_reset", undefined);
    expect(result).toEqual({
      ok: true,
      snapshot: snapshot as RustGameSnapshot,
    });
  });

  it("createSandbox() invokes game_create_sandbox and returns a success result", async () => {
    const request: SandboxCreationRequest = {
      templateId: "blankGrid",
      economyPreset: "creative",
      startingCapital: 42_000,
      demandMultiplier: 1.5,
      moveInRate: "paused",
    };
    const snapshot = createRustSnapshot({
      budget: 42_000,
      rules: {
        gameMode: "sandbox",
        economyPreset: "creative",
        sandbox: {
          templateId: "blankGrid",
          startingCapital: 42_000,
          demandMultiplier: 1.5,
          moveInRate: "paused",
        },
      },
    });
    invokeMock.mockResolvedValueOnce(snapshot);

    const backend = await createTauriBackend();
    const result = await backend.createSandbox(request);

    expect(invokeMock).toHaveBeenCalledWith("game_create_sandbox", { request });
    expect(result).toEqual({ ok: true, snapshot });
  });

  it("returns typed creation/reset command rejections as domain results", async () => {
    const creationError = {
      code: "unknownTemplateId",
      context: {
        field: "templateId",
        attemptedValue: "unknown",
      },
    };
    const resetError = {
      code: "unsupportedGameMode",
      context: { gameMode: "campaign" },
    };
    invokeMock
      .mockRejectedValueOnce(creationError)
      .mockRejectedValueOnce(resetError);
    const backend = await createTauriBackend();

    await expect(
      backend.createSandbox({
        templateId: "unknown",
        economyPreset: "standard",
        startingCapital: 120_000,
        demandMultiplier: 1,
        moveInRate: "paused",
      }),
    ).resolves.toEqual({ ok: false, error: creationError });
    await expect(backend.reset()).resolves.toEqual({
      ok: false,
      error: resetError,
    });
  });

  it("rethrows unexpected creation/reset command string rejections", async () => {
    invokeMock
      .mockRejectedValueOnce("mutex poisoned")
      .mockRejectedValueOnce("mutex poisoned");
    const backend = await createTauriBackend();

    await expect(
      backend.createSandbox({
        templateId: "crossroads",
        economyPreset: "standard",
        startingCapital: 120_000,
        demandMultiplier: 1,
        moveInRate: "paused",
      }),
    ).rejects.toBe("mutex poisoned");
    await expect(backend.reset()).rejects.toBe("mutex poisoned");
  });

  it("invokes exact persistence commands and preserves raw snapshot successes", async () => {
    const saved = createRustSnapshot({
      paused: true,
      scenario: {
        name: "Crossroads",
        objectives: undefined,
        growthWaves: [],
      },
    });
    const restored = createRustSnapshot({ day: 3, paused: true });
    invokeMock
      .mockResolvedValueOnce(saved)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(restored);

    const backend = await createTauriBackend();
    const saveResult = await backend.snapshotForSave();
    const validationResult = await backend.validateSnapshot({
      snapshot: restored,
    });
    const restoreResult = await backend.restoreSnapshot({
      snapshot: restored,
    });

    expect(invokeMock).toHaveBeenNthCalledWith(
      1,
      "game_snapshot_for_save",
      undefined,
    );
    expect(invokeMock).toHaveBeenNthCalledWith(2, "game_validate_snapshot", {
      snapshot: restored,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(3, "game_restore_snapshot", {
      snapshot: restored,
    });
    expect(saveResult).toEqual({ ok: true, snapshot: saved });
    expect(saveResult.ok && saveResult.snapshot).toBe(saved);
    expect(validationResult).toEqual({ ok: true });
    expect(restoreResult).toEqual({ ok: true, snapshot: restored });
    expect(restoreResult.ok && restoreResult.snapshot).toBe(restored);
  });

  it("accepts null as Tauri validation success", async () => {
    invokeMock.mockResolvedValueOnce(null);
    const candidate = createRustSnapshot();
    const backend = await createTauriBackend();

    await expect(
      backend.validateSnapshot({ snapshot: candidate }),
    ).resolves.toEqual({ ok: true });
    expect(invokeMock).toHaveBeenCalledWith("game_validate_snapshot", {
      snapshot: candidate,
    });
  });

  it("rejects undefined as malformed Tauri validation success", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    const backend = await createTauriBackend();

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

  it("preserves known Tauri bridge errors as typed results", async () => {
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
    invokeMock.mockRejectedValueOnce(error);
    const backend = await createTauriBackend();

    await expect(
      backend.restoreSnapshot({ snapshot: createRustSnapshot() }),
    ).resolves.toEqual({ ok: false, error });
  });

  it("normalizes an opaque Tauri invoke rejection to host/invokeFailed", async () => {
    invokeMock.mockRejectedValueOnce(
      "persistence bridge error encoding failed: synthetic failure",
    );
    const backend = await createTauriBackend();

    await expect(
      backend.restoreSnapshot({ snapshot: createRustSnapshot() }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        kind: "host",
        operation: "restoreSnapshot",
        code: "invokeFailed",
        diagnostic: expect.stringContaining(
          "persistence bridge error encoding failed",
        ),
      },
    });
  });

  it("maps malformed Tauri successes and errors through the shared contract", async () => {
    invokeMock
      .mockResolvedValueOnce({ schemaVersion: "4" })
      .mockRejectedValueOnce({ unexpected: true });
    const backend = await createTauriBackend();

    await expect(backend.snapshotForSave()).resolves.toMatchObject({
      ok: false,
      error: {
        kind: "host",
        operation: "snapshotForSave",
        code: "malformedSuccess",
      },
    });
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

  it("rejects a wrong-schema Tauri snapshot success", async () => {
    invokeMock.mockResolvedValueOnce({
      schemaVersion: SNAPSHOT_SCHEMA_VERSION - 1,
    });
    const backend = await createTauriBackend();

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

  it("invokes the immutable route and road preview commands", async () => {
    const routeRequest: RoutePreviewRequest = {
      mode: "bus",
      pattern: "loop",
      waypointIds: ["stop-001", "stop-002"],
      routeId: null,
      expectedRevision: null,
      generation: 51,
    };
    const roadRequest: RoadMutationPreviewRequest = {
      mutation: { type: "removeAtTile", point: { x: 5, y: 5 } },
      generation: 52,
    };
    invokeMock
      .mockResolvedValueOnce({
        generation: 51,
        legs: [],
        totalTravelSeconds: 0,
        initialVehicleCost: 8_000,
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
      })
      .mockResolvedValueOnce({
        generation: 52,
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

    const backend = await createTauriBackend();
    await expect(backend.previewRoute(routeRequest)).resolves.toMatchObject({
      generation: 51,
      rejection: null,
    });
    await expect(backend.previewRoadMutation(roadRequest)).resolves.toEqual({
      generation: 52,
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
    expect(invokeMock).toHaveBeenNthCalledWith(1, "game_preview_route", {
      request: routeRequest,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(
      2,
      "game_preview_road_mutation",
      {
        request: roadRequest,
      },
    );
  });
});
