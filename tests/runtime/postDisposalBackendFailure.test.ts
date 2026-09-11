import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GameBackend,
  GameIntent,
  RustGameSnapshot,
} from "../../src/runtime/backend/types";
import { createGameRuntime } from "../../src/runtime/createGameRuntime";
import { createFakeGameHost, lastFakeHost } from "../helpers/gameHost";
import type { RuntimeSnapshot } from "../../src/runtime/types";
import {
  createPresentationUpdate,
  createRustSnapshot,
  previewBackendStubs,
} from "../fixtures/rustSnapshot";

// ---------------------------------------------------------------------------
// Delayed dispatch backend — a mutable backend whose `dispatch` can be
// blocked and then either resolved or rejected. Used to test failBackend
// publication behavior after disposal.
// ---------------------------------------------------------------------------

interface DelayedDispatchBackend extends GameBackend {
  blockNextDispatch(): Promise<void>;
  resolveDispatch(): void;
  rejectDispatch(error: Error): void;
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

  return {
    presentation: stubs.presentation,
    snapshotForSave() {
      return stubs.snapshotForSave();
    },
    async restoreSnapshot(candidate) {
      snapshot = candidate as RustGameSnapshot;
      return { ok: true, update: createPresentationUpdate(snapshot) };
    },
    buildSandboxSnapshot: stubs.buildSandboxSnapshot,
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
    async dispatch(intent: GameIntent) {
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
        update: createPresentationUpdate(snapshot, snapshot !== before),
        applied: snapshot !== before,
        rejection: null,
      };
    },
    async tick() {
      return {
        update: createPresentationUpdate(snapshot, false),
        applied: false,
        rejection: null,
      };
    },
    async reset() {
      snapshot = createRustSnapshot();
      return {
        ok: true as const,
        update: createPresentationUpdate(snapshot),
      };
    },
    previewRoute: stubs.previewRoute,
    previewRoadMutation: stubs.previewRoadMutation,
  };
}

describe("post-disposal backend failure publication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not notify subscribers or render when a backend operation rejects after disposal", async () => {
    const backend = createDelayedDispatchBackend();
    const runtime = await createGameRuntime({
      createHost: createFakeGameHost,
      backend,
      initialCity: null,
    });
    const host = lastFakeHost()!;

    const listener = vi.fn();
    runtime.subscribe(listener);
    listener.mockClear();

    // Start a dispatch that blocks inside backend.dispatch.
    const dispatchBlocked = backend.blockNextDispatch();
    const dispatchPromise = runtime.debugSetBudget(42_000);
    await dispatchBlocked;

    // Record render count before disposal.
    const rendersBeforeDispose = host.render.mock.calls.length;

    // Disposal is terminal immediately even though this dispatch is still in
    // flight. It must suppress any later render or subscriber notification.
    runtime.dispose();
    expect(runtime.isRunning()).toBe(false);

    // Reject the blocked dispatch. failBackend runs, but disposalRequested
    // is true, so it must NOT publishTerminalSnapshot.
    backend.rejectDispatch(new Error("backend exploded"));

    // The dispatch promise settles (failBackend returns a snapshot).
    await Promise.resolve(dispatchPromise).catch(() => {
      // failBackend may cause the dispatch to reject — that's fine.
    });

    // No subscriber notification after disposal.
    expect(listener).not.toHaveBeenCalled();

    // No canvas render after disposal.
    expect(host.render.mock.calls.length).toBe(rendersBeforeDispose);

    // The runtime is terminal with the backend error recorded.
    expect(runtime.getSnapshot().backendError).toBe("backend exploded");
  });

  it("a comparable failure without disposal still publishes exactly once", async () => {
    const backend = createDelayedDispatchBackend();
    const runtime = await createGameRuntime({
      createHost: createFakeGameHost,
      backend,
      initialCity: null,
    });
    const host = lastFakeHost()!;

    const listener = vi.fn();
    runtime.subscribe(listener);
    listener.mockClear();

    const rendersBefore = host.render.mock.calls.length;

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
    expect(host.render.mock.calls.length).toBeGreaterThan(rendersBefore);

    // The runtime is terminal.
    expect(runtime.getSnapshot().backendError).toBe("live backend failure");

    // A second rejection does not publish again.
    listener.mockClear();
    host.render.mockClear();
    // The runtime is already dead; a second dispatch short-circuits.
    await runtime.debugSetBudget(99_000);
    expect(listener).not.toHaveBeenCalled();
  });
});
