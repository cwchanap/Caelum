import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DispatchResult,
  GameBackend,
  GameIntent,
  RustGameSnapshot,
} from "../../src/runtime/backend/types";
import { createGameRuntime } from "../../src/runtime/createGameRuntime";
import { type ActiveCityIdentity } from "../../src/runtime/persistenceCoordinator";
import { resetBackendOwnershipRegistry } from "../../src/runtime/backendOwnership";
import { createMemoryCitySaveStore } from "../../src/persistence/memoryCitySaveStore";
import type { CitySaveStore } from "../../src/persistence/citySaveStore";
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

// ---------------------------------------------------------------------------
// Shared blocking backend — a mutable backend engine that can block
// `restoreSnapshot` and `dispatch` before mutating, and can be configured to
// throw on `snapshot`. Multiple runtime construction calls against the same
// backend object share one backend ownership coordinator (object identity
// fallback when `runtimeIdentity` is not set). When `runtimeIdentity` IS set,
// separate backend objects with the same identity share one coordinator.
// ---------------------------------------------------------------------------

interface SharedBlockingBackend extends GameBackend {
  snapshotCalls: number;
  dispatchCalls: number;
  restoreCalls: number;
  setSnapshot(next: RustGameSnapshot): void;
  failNextSnapshot(error: Error): void;
  blockNextRestore(): Promise<void>;
  releaseRestore(): void;
  blockNextDispatch(): Promise<void>;
  releaseDispatch(): void;
  rejectBlockedDispatch(error: Error): void;
}

function createSharedBlockingBackend(options: {
  identity?: string;
  initial?: RustGameSnapshot;
}): SharedBlockingBackend {
  let snapshot = options.initial ?? createRustSnapshot();
  let snapshotError: Error | null = null;
  const stubs = previewBackendStubs();

  // Restore gate
  let restoreResolve!: () => void;
  let restoreGate: Promise<void> | null = null;
  let restoreStarted = false;
  let restoreStartedResolve!: () => void;
  let restoreStartedPromise = new Promise<void>((resolve) => {
    restoreStartedResolve = resolve;
  });

  // Dispatch gate
  let dispatchResolve!: () => void;
  let dispatchReject!: (error: Error) => void;
  let dispatchGate: Promise<void> | null = null;
  let dispatchStarted = false;
  let dispatchStartedResolve!: () => void;
  let dispatchStartedPromise = new Promise<void>((resolve) => {
    dispatchStartedResolve = resolve;
  });

  const noOpContext = {
    changedTiles: [],
    skippedTiles: [],
    affectedRouteIds: [],
    cost: 0,
  };

  const backend: SharedBlockingBackend = {
    ...(options.identity !== undefined
      ? { runtimeIdentity: options.identity }
      : {}),
    snapshotCalls: 0,
    dispatchCalls: 0,
    restoreCalls: 0,
    setSnapshot(next) {
      snapshot = next;
    },
    failNextSnapshot(error) {
      snapshotError = error;
    },
    blockNextRestore() {
      restoreGate = new Promise<void>((resolve) => {
        restoreResolve = resolve;
      });
      restoreStarted = false;
      restoreStartedPromise = new Promise<void>((resolve) => {
        restoreStartedResolve = resolve;
      });
      return restoreStartedPromise;
    },
    releaseRestore() {
      if (restoreGate !== null) {
        restoreResolve();
        restoreGate = null;
      }
    },
    blockNextDispatch() {
      dispatchGate = new Promise<void>((resolve, reject) => {
        dispatchResolve = resolve;
        dispatchReject = reject;
      });
      dispatchStarted = false;
      dispatchStartedPromise = new Promise<void>((resolve) => {
        dispatchStartedResolve = resolve;
      });
      return dispatchStartedPromise;
    },
    releaseDispatch() {
      if (dispatchGate !== null) {
        dispatchResolve();
        dispatchGate = null;
      }
    },
    rejectBlockedDispatch(error) {
      if (dispatchGate !== null) {
        dispatchReject(error);
        dispatchGate = null;
      }
    },
    async snapshot() {
      backend.snapshotCalls += 1;
      if (snapshotError !== null) {
        const err = snapshotError;
        snapshotError = null;
        throw err;
      }
      return snapshot;
    },
    snapshotForSave() {
      return stubs.snapshotForSave();
    },
    validateSnapshot(request) {
      return stubs.validateSnapshot(request);
    },
    async restoreSnapshot(request) {
      backend.restoreCalls += 1;
      if (restoreGate !== null && !restoreStarted) {
        restoreStarted = true;
        restoreStartedResolve();
        await restoreGate;
      }
      snapshot = request.snapshot as RustGameSnapshot;
      return { ok: true, snapshot };
    },
    async createSandbox(request) {
      const result = await stubs.createSandbox(request);
      if (result.ok) snapshot = result.snapshot;
      return result;
    },
    async dispatch(intent: GameIntent): Promise<DispatchResult> {
      backend.dispatchCalls += 1;
      if (dispatchGate !== null && !dispatchStarted) {
        dispatchStarted = true;
        dispatchStartedResolve();
        await dispatchGate;
      }
      const before = snapshot;
      switch (intent.type) {
        case "setBudget":
          snapshot = { ...snapshot, budget: intent.budget };
          break;
        case "setPaused":
          snapshot = { ...snapshot, paused: intent.paused };
          break;
        case "setSpeed":
          snapshot = { ...snapshot, speed: intent.speed };
          break;
        default:
          break;
      }
      return {
        snapshot,
        applied: snapshot !== before,
        rejection: null,
        context: noOpContext,
      };
    },
    async tick(): Promise<DispatchResult> {
      return {
        snapshot,
        applied: false,
        rejection: null,
        context: noOpContext,
      };
    },
    async reset() {
      snapshot = createRustSnapshot();
      return { ok: true, snapshot };
    },
    previewRoute: stubs.previewRoute,
    previewRoadMutation: stubs.previewRoadMutation,
  };

  return backend;
}

function cityIdentity(id = "city-001"): ActiveCityIdentity {
  return {
    id,
    name: "Test City",
    createdAt: "2026-08-01T09:00:00.000Z",
  };
}

async function seedCity(
  store: CitySaveStore,
  city: ActiveCityIdentity,
  snapshot: RustGameSnapshot,
): Promise<void> {
  const result = await store.createCity({
    city,
    savedAt: "2026-08-01T10:00:00.000Z",
    snapshot,
  });
  if (!result.ok) throw new Error(`Failed to seed city: ${result.error.code}`);
}

describe("backend ownership coordination", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    canvasHost.isRunning.mockReturnValue(false);
  });

  afterEach(() => {
    resetBackendOwnershipRegistry();
  });

  it("load during replacement: B cannot snapshot until A's restoration settles and A is disposed", async () => {
    const backend = createSharedBlockingBackend({
      identity: "test-engine-load-replace",
    });
    const store = createMemoryCitySaveStore();

    const loadedCity = cityIdentity("city-loaded");
    const loadedSnapshot = createRustSnapshot({
      paused: true,
      budget: 77_000,
    });
    await seedCity(store, loadedCity, loadedSnapshot);

    // Runtime A starts with no active city and a different budget.
    const runtimeA = await createGameRuntime({
      backend,
      saveStore: store,
      initialCity: null,
      now: () => "2026-08-01T10:00:00.000Z",
    });

    // Block the next restoreSnapshot so the load hangs mid-operation.
    const restoreBlocked = backend.blockNextRestore();

    // Start loading the seeded city. This enters the gameplay queue and
    // calls backend.restoreSnapshot, which blocks.
    const loadPromise = runtimeA.persistence.load(loadedCity.id);

    // Wait until the restore is actually blocked inside the gameplay queue.
    await restoreBlocked;

    // Begin constructing runtime B against the same backend and store.
    // B must block on backend ownership — A still holds it.
    const runtimeBPromise = createGameRuntime({
      backend,
      saveStore: store,
      initialCity: null,
      now: () => "2026-08-01T10:00:00.000Z",
    });

    // Assert B has not resolved yet (backend ownership is still held by A).
    const settledB = await Promise.race([
      runtimeBPromise.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50)),
    ]);
    expect(settledB).toBe(false);

    // Release the restoration. The load completes (the backend now holds
    // the loaded city's snapshot).
    backend.releaseRestore();
    const loadResult = await loadPromise;
    expect(loadResult.status).toBe("completed");

    // Dispose A. This drains the gameplay queue (already empty) and the
    // persistence lease, then releases both. B can now acquire backend
    // ownership and read the snapshot.
    await runtimeA.dispose();

    // B resolves and its state reflects the loaded city's snapshot.
    const runtimeB = await runtimeBPromise;
    expect(runtimeB.getSnapshot().state.budget).toBe(77_000);
    expect(runtimeB.getSnapshot().state.paused).toBe(true);
  });

  it("dispatch during disposal: B initializes from the post-dispatch backend state", async () => {
    const backend = createSharedBlockingBackend({
      identity: "test-engine-dispatch-dispose",
    });

    const runtimeA = await createGameRuntime({
      backend,
      initialCity: null,
    });

    // Block the next dispatch so it hangs before mutating the backend.
    const dispatchBlocked = backend.blockNextDispatch();

    // Start a dispatch (setBudget). It enters the gameplay queue and blocks
    // inside backend.dispatch before the mutation.
    const dispatchPromise = runtimeA.debugSetBudget(50_000);

    // Wait until the dispatch is actually blocked.
    await dispatchBlocked;

    // Call dispose(). dead = true is set, startDrainAndRelease begins, but
    // gameplayQueue.drain() waits for the blocked dispatch.
    const disposePromise = runtimeA.dispose();

    // Begin constructing B. B blocks on backend ownership (A still holds it
    // because the gameplay queue hasn't drained).
    const runtimeBPromise = createGameRuntime({
      backend,
      initialCity: null,
    });

    // Assert disposal and B have not resolved yet.
    const settledDispose = await Promise.race([
      disposePromise.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50)),
    ]);
    expect(settledDispose).toBe(false);

    const settledB = await Promise.race([
      runtimeBPromise.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50)),
    ]);
    expect(settledB).toBe(false);

    // Release the dispatch. The mutation applies (budget → 50_000), the
    // dispatch completes, the gameplay queue drains, the lease drains, and
    // both are released.
    backend.releaseDispatch();

    // The dispatch promise may reject or resolve depending on dead-state
    // handling; either way the backend is mutated.
    try {
      await dispatchPromise;
    } catch {
      // dead-runtime dispatch may throw — that's fine.
    }

    await disposePromise;

    // B resolves and its state reflects the post-dispatch backend state.
    const runtimeB = await runtimeBPromise;
    expect(runtimeB.getSnapshot().state.budget).toBe(50_000);
  });

  it("no-store replacement: backend ownership alone serializes runtimes", async () => {
    const backend = createSharedBlockingBackend({
      identity: "test-engine-no-store",
    });

    // No city save store — backend ownership is the sole serialization point.
    const runtimeA = await createGameRuntime({
      backend,
      initialCity: null,
    });

    const dispatchBlocked = backend.blockNextDispatch();
    const dispatchPromise = runtimeA.debugSetBudget(30_000);
    await dispatchBlocked;

    const disposePromise = runtimeA.dispose();

    const runtimeBPromise = createGameRuntime({
      backend,
      initialCity: null,
    });

    // Neither disposal nor B has resolved.
    const settledDispose = await Promise.race([
      disposePromise.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50)),
    ]);
    expect(settledDispose).toBe(false);

    const settledB = await Promise.race([
      runtimeBPromise.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50)),
    ]);
    expect(settledB).toBe(false);

    backend.releaseDispatch();
    try {
      await dispatchPromise;
    } catch {
      // dead-runtime dispatch may throw — fine.
    }

    await disposePromise;
    const runtimeB = await runtimeBPromise;
    expect(runtimeB.getSnapshot().state.budget).toBe(30_000);
  });

  it("construction failure: backend ownership is released so a later runtime can initialize", async () => {
    const identity = "test-engine-construction-fail";
    const backend = createSharedBlockingBackend({ identity });

    const runtimeA = await createGameRuntime({
      backend,
      initialCity: null,
    });
    await runtimeA.dispose();

    // A separate backend object with the same identity but a throwing
    // snapshot. It shares the backend ownership coordinator with A's backend.
    const throwingBackend = createSharedBlockingBackend({ identity });
    throwingBackend.failNextSnapshot(new Error("construction boom"));

    // B's construction throws after acquiring backend ownership.
    await expect(
      createGameRuntime({ backend: throwingBackend, initialCity: null }),
    ).rejects.toThrow("construction boom");

    // A third backend with the same identity and a working snapshot can
    // initialize — backend ownership was released by B's construction failure.
    const backendC = createSharedBlockingBackend({ identity });
    const runtimeC = await createGameRuntime({
      backend: backendC,
      initialCity: null,
    });
    expect(runtimeC.getSnapshot().state.budget).toBe(120_000);
    await runtimeC.dispose();
  });
});
