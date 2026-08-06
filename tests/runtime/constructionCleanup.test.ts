import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GameBackend } from "../../src/runtime/backend/types";
import { createGameRuntime } from "../../src/runtime/createGameRuntime";
import { resetBackendOwnershipRegistry } from "../../src/runtime/backendOwnership";
import { createMemorySaveStore } from "../../src/persistence/memorySaveStore";
import type { SaveStore } from "../../src/persistence/saveStore";
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

// Hoisted mock for `createPreviewCoordinator` so a test can inject a
// post-lease construction failure (the call site runs after both backend
// ownership and the persistence lease are acquired). By default it returns
// a no-op coordinator so existing tests are unaffected.
const previewCoordinatorFactory = vi.hoisted(() => ({
  create: vi.fn((_backend: unknown) => ({
    requestRoute: vi.fn().mockResolvedValue(null),
    requestRoadMutation: vi.fn().mockResolvedValue(null),
    invalidateRoute: vi.fn(),
    invalidateRoadMutation: vi.fn(),
  })),
}));

vi.mock("../../src/runtime/previewCoordinator", () => ({
  createPreviewCoordinator: vi.fn((backend: unknown) =>
    previewCoordinatorFactory.create(backend),
  ),
}));

function createBackend(): GameBackend {
  return {
    ...previewBackendStubs(),
    async snapshot() {
      return createRustSnapshot();
    },
    async dispatch(_intent) {
      const snapshot = createRustSnapshot();
      return {
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
    },
    async tick() {
      const snapshot = createRustSnapshot();
      return {
        snapshot,
        applied: false,
        rejection: null,
        context: {
          changedTiles: [],
          skippedTiles: [],
          affectedRouteIds: [],
          cost: 0,
        },
      };
    },
    async reset() {
      return { ok: true, snapshot: createRustSnapshot() };
    },
  };
}

describe("construction exception cleanup (P2)", () => {
  beforeEach(() => {
    resetBackendOwnershipRegistry();
    canvasHost.mount.mockClear();
    canvasHost.render.mockClear();
    previewCoordinatorFactory.create.mockClear();
  });

  afterEach(() => {
    resetBackendOwnershipRegistry();
  });

  it("releases backend ownership when beginRuntime throws — same backend retries", async () => {
    // P1/P2: beginRuntime() is called after backend ownership is acquired.
    // If it throws, the outer catch must release backend ownership so a
    // replacement runtime can initialize against the same engine. Reusing
    // the SAME backend object proves the ownership coordinator (object
    // identity when runtimeIdentity is absent) was released — a different
    // backend object would use a different coordinator and not demonstrate
    // the release.
    const backend = createBackend();
    const beginRuntimeError = new Error("beginRuntime exploded");
    (backend as GameBackend).beginRuntime = vi.fn(async () => {
      throw beginRuntimeError;
    });

    await expect(createGameRuntime({ backend })).rejects.toBe(
      beginRuntimeError,
    );

    // The same backend object, with beginRuntime now succeeding, must
    // acquire ownership — proving the failed construction released it.
    (backend as GameBackend).beginRuntime = vi.fn(async () => ({
      runtimeEpoch: 0,
      snapshot: createRustSnapshot(),
    }));
    const runtime = await createGameRuntime({ backend });
    await runtime.dispose();
  });

  it("fails fast before acquisition when singleRealm getter throws", async () => {
    // P2: `singleRealm` is captured BEFORE any capability is acquired. A
    // throwing getter fails fast before any lock is held. This is a
    // pre-acquisition failure by design.
    const memoryStore = createMemorySaveStore();
    const store: SaveStore = {
      ...memoryStore,
      storageIdentity: "single-realm-throw-test",
      get singleRealm(): boolean {
        throw new Error("singleRealm getter exploded");
      },
    };

    await expect(
      createGameRuntime({ backend: createBackend(), saveStore: store }),
    ).rejects.toThrow("singleRealm getter exploded");

    // A second runtime with a healthy store should succeed.
    const runtime = await createGameRuntime({
      backend: createBackend(),
      saveStore: createMemorySaveStore(),
    });
    await runtime.dispose();
  });

  it("rejects construction when listCities throws during bootstrap reconciliation", async () => {
    // After lease acquisition, bootstrap reconciliation calls
    // `saveStore.listCities()`. If it throws, the bootstrap reconciliation
    // catches it and sets `leaseStuck = true`, which pins both the lease
    // and backend ownership (intentional — the storage may be
    // inconsistent). `startDrainAndRelease` skips both releases when
    // `leaseStuck` is true, and the outer catch respects `pinRecovery =
    // true` and also skips both. This is NOT a leak — it's an intentional
    // pin that requires out-of-band reconciliation.
    const memoryStore = createMemorySaveStore();
    const store: SaveStore = {
      ...memoryStore,
      singleRealm: true,
      async listCities() {
        throw new Error("listCities exploded");
      },
    };

    await expect(
      createGameRuntime({ backend: createBackend(), saveStore: store }),
    ).rejects.toThrow("Bootstrap reconciliation failed");
  });

  it("releases both backend ownership and lease when a post-lease construction dependency throws", async () => {
    // P2: A genuine failure AFTER both capabilities (backend ownership and
    // the persistence lease) are held. `createPreviewCoordinator` runs
    // after the lease is acquired and bootstrap reconciliation completes.
    // If it throws, the outer catch must release BOTH capabilities so a
    // replacement runtime using the SAME backend can proceed — proving
    // neither capability leaked.
    const backend = createBackend();
    const store = createMemorySaveStore();

    const constructionError = new Error("post-lease construction exploded");
    previewCoordinatorFactory.create.mockImplementationOnce(() => {
      throw constructionError;
    });

    await expect(createGameRuntime({ backend, saveStore: store })).rejects.toBe(
      constructionError,
    );

    // A replacement runtime using the SAME backend object must succeed.
    // This proves backend ownership was released (same object-identity
    // coordinator). Each runtime constructs its own persistence
    // coordinator, so lease release is verified by the absence of a hang.
    const runtime = await createGameRuntime({ backend, saveStore: store });
    await runtime.dispose();
  });

  it("captures singleRealm once and does not re-read the getter during cleanup", async () => {
    // P2: `singleRealm` is captured once before acquisition. The cleanup
    // path (cleanupLateSuccessNewCity) uses the captured value, NOT a fresh
    // getter read. This test verifies the getter is read exactly once.
    const memoryStore = createMemorySaveStore();
    let singleRealmReads = 0;
    const store: SaveStore = {
      ...memoryStore,
      storageIdentity: "single-realm-read-count-test",
      get singleRealm() {
        singleRealmReads += 1;
        return true;
      },
    };

    const runtime = await createGameRuntime({
      backend: createBackend(),
      saveStore: store,
    });

    // The getter was read exactly once during construction.
    expect(singleRealmReads).toBe(1);

    await runtime.dispose();

    // The getter was NOT re-read during disposal.
    expect(singleRealmReads).toBe(1);
  });
});
