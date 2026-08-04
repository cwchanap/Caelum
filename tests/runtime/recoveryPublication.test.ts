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

  it("suppresses multi-realm ambiguity publication during disposal", async () => {
    // Defense-in-depth coverage for the retained multiRealmAmbiguousCleanup
    // branch. Current admission rejects multi-realm New City before mutation;
    // this mutable capability simulates a legacy/bypassed workflow whose
    // adapter becomes conservatively multi-realm before cleanup.
    const memoryStore = createMemorySaveStore();
    let capabilityReads = 0;
    let releaseCreate!: () => void;
    let resolveCreateStarted!: () => void;
    const createStarted = new Promise<void>((resolve) => {
      resolveCreateStarted = resolve;
    });
    const createRelease = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const store: SaveStore = {
      ...memoryStore,
      storageIdentity: "recovery-publication-multi-realm",
      get singleRealm() {
        capabilityReads += 1;
        return capabilityReads < 3;
      },
      async createWorkingSave(envelope) {
        resolveCreateStarted();
        await createRelease;
        const result = await memoryStore.createWorkingSave(envelope);
        if (!result.ok) return result;
        throw new Error("createWorkingSave threw after commit");
      },
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
        id: "city-disposal-multi-realm",
        name: "Disposal Multi Realm",
        cityCreatedAt: "2026-08-01T11:00:00.000Z",
      },
    );
    await createStarted;

    const renderCallsBeforeDispose = canvasHost.render.mock.calls.length;
    const disposePromise = runtime.dispose();
    releaseCreate();

    const activationResult = await activation;
    expect(activationResult.status).toBe("failed");
    const disposeResult = await disposePromise;
    expect(disposeResult).toMatchObject({
      status: "recoveryRequired",
      reason: "multiRealmAmbiguousCleanup",
      cityId: "city-disposal-multi-realm",
    });

    expect(canvasHost.render).toHaveBeenCalledTimes(renderCallsBeforeDispose);
    const recoveryCalls = (
      listener.mock.calls as Array<[RuntimeSnapshot]>
    ).filter((call) => call[0].recovery.state === "recoveryRequired");
    expect(recoveryCalls).toHaveLength(0);
    expect(runtime.getSnapshot().recovery.state).toBe("recoveryRequired");
  });
});
