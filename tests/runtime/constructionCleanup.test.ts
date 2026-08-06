import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GameBackend } from "../../src/runtime/backend/types";
import { createGameRuntime } from "../../src/runtime/createGameRuntime";
import { createMemoryCitySaveStore } from "../../src/persistence/memoryCitySaveStore";
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
    async snapshot() {
      return createRustSnapshot();
    },
    async dispatch(_intent) {
      const snapshot = createRustSnapshot();
      return {
        snapshot,
        applied: true,
        rejection: null,
      };
    },
    async tick() {
      const snapshot = createRustSnapshot();
      return {
        snapshot,
        applied: false,
        rejection: null,
      };
    },
    async reset() {
      return { ok: true, snapshot: createRustSnapshot() };
    },
  };
}

describe("construction exception cleanup (P2)", () => {
  beforeEach(() => {
    canvasHost.mount.mockClear();
    canvasHost.render.mockClear();
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

    await expect(createGameRuntime({ backend, saveStore: store })).rejects.toBe(
      constructionError,
    );

    // A replacement runtime using the same backend and store must succeed.
    const runtime = await createGameRuntime({ backend, saveStore: store });
    await runtime.dispose();
  });
});
