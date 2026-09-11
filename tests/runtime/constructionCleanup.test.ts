import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GameBackend } from "../../src/runtime/backend/types";
import { createGameRuntime } from "../../src/runtime/createGameRuntime";
import { createFakeGameHost } from "../helpers/gameHost";
import { createMemoryCitySaveStore } from "../../src/persistence/memoryCitySaveStore";
import {
  createPresentationUpdate,
  createRustSnapshot,
  previewBackendStubs,
} from "../fixtures/rustSnapshot";

// Hoisted mock for `createPreviewCoordinator` so a test can inject a
// post-lease construction failure (the call site runs after the persistence
// lease is acquired). By default it returns a no-op coordinator so existing
// tests are unaffected.
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
    async dispatch(_intent) {
      return {
        update: createPresentationUpdate(createRustSnapshot()),
        applied: true,
        rejection: null,
      };
    },
    async tick() {
      return {
        update: createPresentationUpdate(createRustSnapshot(), false),
        applied: false,
        rejection: null,
      };
    },
    async reset() {
      return {
        ok: true,
        update: createPresentationUpdate(createRustSnapshot()),
      };
    },
  };
}

describe("construction exception cleanup (P2)", () => {
  beforeEach(() => {
    previewCoordinatorFactory.create.mockClear();
  });

  it("releases the lease when a post-lease construction dependency throws", async () => {
    // A genuine failure after the persistence lease is held. The outer catch
    // must release the lease so a replacement runtime can proceed.
    const backend = createBackend();
    const store = createMemoryCitySaveStore();

    const constructionError = new Error("post-lease construction exploded");
    previewCoordinatorFactory.create.mockImplementationOnce(() => {
      throw constructionError;
    });

    await expect(
      createGameRuntime({
        createHost: createFakeGameHost,
        backend,
        saveStore: store,
      }),
    ).rejects.toBe(constructionError);

    // A replacement runtime using the same backend and store must succeed.
    const runtime = await createGameRuntime({
      createHost: createFakeGameHost,
      backend,
      saveStore: store,
    });
    await runtime.dispose();
  });
});
