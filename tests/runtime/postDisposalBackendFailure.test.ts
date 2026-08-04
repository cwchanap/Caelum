import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DispatchResult,
  GameBackend,
  GameIntent,
  RustGameSnapshot,
} from "../../src/runtime/backend/types";
import { createGameRuntime } from "../../src/runtime/createGameRuntime";
import { resetPersistenceCoordinatorRegistry } from "../../src/runtime/persistenceCoordinator";
import { resetBackendOwnershipRegistry } from "../../src/runtime/backendOwnership";
import type { RuntimeSnapshot } from "../../src/runtime/types";
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
// Delayed dispatch backend — a mutable backend whose `dispatch` can be
// blocked and then either resolved or rejected. Used to test failBackend
// publication behavior after disposal.
// ---------------------------------------------------------------------------

interface DelayedDispatchBackend extends GameBackend {
  blockNextDispatch(): Promise<void>;
  resolveDispatch(): void;
  rejectDispatch(error: Error): void;
  dispatchCalls: number;
}

function createDelayedDispatchBackend(): DelayedDispatchBackend {
  let snapshot = createRustSnapshot();
  const stubs = previewBackendStubs();
  let dispatchResolve!: () => void;
  let dispatchReject!: (error: Error) => void;
  let dispatchGate: Promise<void> | null = null;
  let dispatchStarted = false;
  let dispatchStartedResolve!: () => void;
  const dispatchStartedPromise = new Promise<void>((resolve) => {
    dispatchStartedResolve = resolve;
  });

  const noOpContext = {
    changedTiles: [],
    skippedTiles: [],
    affectedRouteIds: [],
    cost: 0,
  };

  return {
    async snapshot() {
      return snapshot;
    },
    snapshotForSave() {
      return stubs.snapshotForSave();
    },
    validateSnapshot(request) {
      return stubs.validateSnapshot(request);
    },
    async restoreSnapshot(request) {
      snapshot = request.snapshot as RustGameSnapshot;
      return { ok: true, snapshot };
    },
    async createSandbox(request) {
      const result = await stubs.createSandbox(request);
      if (result.ok) snapshot = result.snapshot;
      return result;
    },
    dispatchCalls: 0,
    blockNextDispatch() {
      dispatchGate = new Promise<void>((resolve, reject) => {
        dispatchResolve = resolve;
        dispatchReject = reject;
      });
      return dispatchStartedPromise;
    },
    resolveDispatch() {
      if (dispatchGate !== null) {
        dispatchResolve();
        dispatchGate = null;
      }
    },
    rejectDispatch(error) {
      if (dispatchGate !== null) {
        dispatchReject(error);
        dispatchGate = null;
      }
    },
    async dispatch(intent: GameIntent): Promise<DispatchResult> {
      (this as DelayedDispatchBackend).dispatchCalls += 1;
      if (dispatchGate !== null && !dispatchStarted) {
        dispatchStarted = true;
        dispatchStartedResolve();
        await dispatchGate;
      }
      const before = snapshot;
      if (intent.type === "setBudget") {
        snapshot = { ...snapshot, budget: intent.budget };
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
}

describe("post-disposal backend failure publication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    canvasHost.isRunning.mockReturnValue(false);
  });

  afterEach(() => {
    resetPersistenceCoordinatorRegistry();
    resetBackendOwnershipRegistry();
  });

  it("does not notify subscribers or render when a backend operation rejects after disposal", async () => {
    const backend = createDelayedDispatchBackend();
    const runtime = await createGameRuntime({
      backend,
      initialCity: null,
    });

    const listener = vi.fn();
    runtime.subscribe(listener);
    listener.mockClear();

    // Start a dispatch that blocks inside backend.dispatch.
    const dispatchBlocked = backend.blockNextDispatch();
    const dispatchPromise = runtime.debugSetBudget(42_000);
    await dispatchBlocked;

    // Record render count before disposal.
    const rendersBeforeDispose = canvasHost.render.mock.calls.length;

    // Call dispose(). dead = true, startDrainAndRelease begins,
    // gameplayQueue.drain() waits for the blocked dispatch.
    const disposePromise = runtime.dispose();

    // Assert disposal has not resolved (gameplay queue is still draining).
    const settledDispose = await Promise.race([
      disposePromise.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50)),
    ]);
    expect(settledDispose).toBe(false);

    // Reject the blocked dispatch. failBackend runs, but disposalRequested
    // is true, so it must NOT publishTerminalSnapshot.
    backend.rejectDispatch(new Error("backend exploded"));

    // The dispatch promise settles (failBackend returns a snapshot).
    await Promise.resolve(dispatchPromise).catch(() => {
      // failBackend may cause the dispatch to reject — that's fine.
    });

    // Disposal settles only after the backend operation settles.
    const disposeResult = await disposePromise;
    expect(disposeResult.status).toBe("released");

    // No subscriber notification after disposal.
    expect(listener).not.toHaveBeenCalled();

    // No canvas render after disposal.
    expect(canvasHost.render.mock.calls.length).toBe(rendersBeforeDispose);

    // The runtime is terminal with the backend error recorded.
    expect(runtime.getSnapshot().backendError).toBe("backend exploded");
    expect(runtime.getSnapshot().recovery.state).toBe("ok");
  });

  it("a comparable failure without disposal still publishes exactly once", async () => {
    const backend = createDelayedDispatchBackend();
    const runtime = await createGameRuntime({
      backend,
      initialCity: null,
    });

    const listener = vi.fn();
    runtime.subscribe(listener);
    listener.mockClear();

    const rendersBefore = canvasHost.render.mock.calls.length;

    // Start a dispatch that blocks inside backend.dispatch.
    const dispatchBlocked = backend.blockNextDispatch();
    const dispatchPromise = runtime.debugSetBudget(42_000);
    await dispatchBlocked;

    // Reject the dispatch WITHOUT calling dispose(). failBackend runs on
    // a LIVE runtime and must publish exactly once.
    backend.rejectDispatch(new Error("live backend failure"));

    // The dispatch promise settles (failBackend returns a snapshot).
    await Promise.resolve(dispatchPromise).catch(() => {
      // failBackend may cause the dispatch to reject — that's fine.
    });

    // Exactly one subscriber notification with the backend error.
    const calls = listener.mock.calls as Array<[RuntimeSnapshot]>;
    const errorCalls = calls.filter(
      (call) => call[0].backendError === "live backend failure",
    );
    expect(errorCalls).toHaveLength(1);

    // At least one render occurred (the terminal snapshot render).
    expect(canvasHost.render.mock.calls.length).toBeGreaterThan(rendersBefore);

    // The runtime is terminal.
    expect(runtime.getSnapshot().backendError).toBe("live backend failure");

    // A second rejection does not publish again.
    listener.mockClear();
    canvasHost.render.mockClear();
    // The runtime is already dead; a second dispatch short-circuits.
    await runtime.debugSetBudget(99_000);
    expect(listener).not.toHaveBeenCalled();
  });

  it("replacement runtime sees coherent backend state after post-disposal backend failure", async () => {
    const backend = createDelayedDispatchBackend();
    const runtime = await createGameRuntime({
      backend,
      initialCity: null,
    });

    // Start a dispatch that blocks and will be rejected after disposal.
    const dispatchBlocked = backend.blockNextDispatch();
    const dispatchPromise = runtime.debugSetBudget(55_000);
    await dispatchBlocked;

    const disposePromise = runtime.dispose();

    // Reject the dispatch after disposal.
    backend.rejectDispatch(new Error("post-disposal failure"));
    await Promise.resolve(dispatchPromise).catch(() => {
      // expected
    });

    await disposePromise;

    // A replacement runtime can initialize against the same backend.
    // The backend state is coherent (the dispatch was rejected before
    // mutating, so the backend retains its pre-dispatch state).
    const replacement = await createGameRuntime({
      backend,
      initialCity: null,
    });
    expect(replacement.getSnapshot().state.budget).toBe(120_000);
    expect(replacement.getSnapshot().backendError).toBeNull();
  });
});
