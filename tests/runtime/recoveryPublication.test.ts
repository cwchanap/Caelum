import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DispatchResult,
  GameBackend,
  RustGameSnapshot,
} from "../../src/runtime/backend/types";
import { createGameRuntime } from "../../src/runtime/createGameRuntime";
import {
  createMemorySaveStore,
  createMemorySaveStoreFailureControls,
} from "../../src/persistence/memorySaveStore";
import type { SaveStore } from "../../src/persistence/saveStore";
import { resetPersistenceCoordinatorRegistry } from "../../src/runtime/persistenceCoordinator";
import type { RuntimeSnapshot } from "../../src/runtime/types";
import { createDelayedSaveStore } from "./delayedSaveStore";
import {
  createRustSnapshot,
  previewBackendStubs,
} from "../fixtures/rustSnapshot";

const canvasHost = vi.hoisted(() => ({
  mount: vi.fn(() => () => {}),
  render: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  syncAnimationLoop: vi.fn(),
  isRunning: vi.fn(() => false),
}));

vi.mock("../../src/runtime/createCanvasHost", () => ({
  createCanvasHost: vi.fn(() => canvasHost),
}));

function backendForTest(): GameBackend {
  let snapshot = createRustSnapshot();
  const stubs = previewBackendStubs();

  const noOpDispatch = (): DispatchResult => ({
    snapshot,
    applied: false,
    rejection: null,
    context: {
      changedTiles: [],
      skippedTiles: [],
      affectedRouteIds: [],
      cost: 0,
    },
  });

  return {
    ...stubs,
    async snapshot() {
      return snapshot;
    },
    async createSandbox(request) {
      const result = await stubs.createSandbox(request);
      if (result.ok) snapshot = result.snapshot;
      return result;
    },
    async snapshotForSave() {
      return { ok: true, snapshot: { ...snapshot, paused: true } };
    },
    async restoreSnapshot(request) {
      snapshot = request.snapshot as RustGameSnapshot;
      return { ok: true, snapshot };
    },
    async dispatch() {
      return noOpDispatch();
    },
    async tick() {
      return noOpDispatch();
    },
    async reset() {
      snapshot = createRustSnapshot();
      return { ok: true, snapshot };
    },
  };
}

describe("runtime recovery publication during disposal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    canvasHost.isRunning.mockReturnValue(false);
  });

  afterEach(() => {
    resetPersistenceCoordinatorRegistry();
  });

  it("does not render or notify subscribers when cleanup fails after disposal begins", async () => {
    const failures = createMemorySaveStoreFailureControls();
    const memoryStore = createMemorySaveStore({ failures });
    const throwingStore: SaveStore = {
      ...memoryStore,
      storageIdentity: "recovery-publication-disposal",
      async createWorkingSave(envelope) {
        const result = await memoryStore.createWorkingSave(envelope);
        if (!result.ok) return result;
        throw new Error("createWorkingSave threw after commit");
      },
    };
    const store = createDelayedSaveStore(throwingStore);
    store.defer("createWorkingSave");
    failures.failNext("deleteCity", "ioFailure");

    const runtime = await createGameRuntime({
      backend: backendForTest(),
      saveStore: store,
      initialCity: {
        id: "city-001",
        name: "Test City",
        cityCreatedAt: "2026-08-01T09:00:00.000Z",
      },
      now: () => "2026-08-01T10:00:00.000Z",
      appVersion: "0.1.0",
    });
    const listener = vi.fn();
    runtime.subscribe(listener);
    listener.mockClear();

    const activation = runtime.persistence.activateNewCity(
      {
        templateId: "blankGrid",
        economyPreset: "standard",
        startingCapital: 120_000,
        demandMultiplier: 1,
        moveInRate: "paused",
      },
      {
        id: "city-disposal-render-fail",
        name: "Disposal Render Fail",
        cityCreatedAt: "2026-08-01T11:00:00.000Z",
      },
    );

    await vi.waitFor(() => {
      expect(store.activeCount()).toBe(1);
    });

    const renderCallsBeforeDispose = canvasHost.render.mock.calls.length;
    const disposePromise = runtime.dispose();
    expect(canvasHost.render).toHaveBeenCalledTimes(renderCallsBeforeDispose);

    store.releaseNext("createWorkingSave");

    const activationResult = await activation;
    expect(activationResult.status).toBe("failed");
    const disposeResult = await disposePromise;
    expect(disposeResult).toMatchObject({
      status: "recoveryRequired",
      reason: "lateSuccessCleanupFailed",
      cityId: "city-disposal-render-fail",
    });

    expect(canvasHost.render).toHaveBeenCalledTimes(renderCallsBeforeDispose);
    const recoveryCalls = (
      listener.mock.calls as Array<[RuntimeSnapshot]>
    ).filter((call) => call[0].recovery.state === "recoveryRequired");
    expect(recoveryCalls).toHaveLength(0);
    expect(runtime.getSnapshot().recovery.state).toBe("recoveryRequired");
  });

  it("rejects multi-realm New City admission before any storage mutation (P2: singleRealm captured once)", async () => {
    // P2: `singleRealm` is captured once at construction time and never
    // re-read. A multi-realm adapter (`singleRealm: false`) is rejected at
    // `activateNewCity` admission before any storage mutation occurs — the
    // `multiRealmAmbiguousCleanup` disposal path is no longer reachable
    // through a mutable `singleRealm` getter because the value is frozen at
    // construction. This test verifies the new contract: the rejection
    // happens up front, no working save is created, and no disposal recovery
    // is needed.
    const memoryStore = createMemorySaveStore();
    const store: SaveStore = {
      ...memoryStore,
      storageIdentity: "recovery-publication-multi-realm",
      singleRealm: false,
    };

    const runtime = await createGameRuntime({
      backend: backendForTest(),
      saveStore: store,
      initialCity: {
        id: "city-001",
        name: "Test City",
        cityCreatedAt: "2026-08-01T09:00:00.000Z",
      },
      now: () => "2026-08-01T10:00:00.000Z",
      appVersion: "0.1.0",
    });
    const listener = vi.fn();
    runtime.subscribe(listener);
    listener.mockClear();

    const activation = runtime.persistence.activateNewCity(
      {
        templateId: "blankGrid",
        economyPreset: "standard",
        startingCapital: 120_000,
        demandMultiplier: 1,
        moveInRate: "paused",
      },
      {
        id: "city-multi-realm-admission",
        name: "Multi Realm Admission",
        cityCreatedAt: "2026-08-01T11:00:00.000Z",
      },
    );

    const activationResult = await activation;
    expect(activationResult.status).toBe("failed");
    if (activationResult.status === "failed") {
      expect(activationResult.error.kind).toBe("precondition");
      if (activationResult.error.kind === "precondition") {
        expect(activationResult.error.error.code).toBe(
          "multiRealmNewCityUnsupported",
        );
      }
    }

    // No working save was created — the rejection happened before any
    // storage mutation.
    const cities = await memoryStore.listCities();
    expect(cities.ok).toBe(true);
    if (cities.ok) {
      expect(
        cities.value.find((c) => c.cityId === "city-multi-realm-admission"),
      ).toBeUndefined();
    }

    // No recovery state — the runtime remains usable.
    expect(runtime.getSnapshot().recovery.state).not.toBe("recoveryRequired");

    const disposeResult = await runtime.dispose();
    expect(disposeResult).toMatchObject({ status: "released" });
  });
});
