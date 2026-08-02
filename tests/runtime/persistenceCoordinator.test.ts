import { describe, expect, it, vi } from "vitest";
import {
  createMemorySaveStore,
  createMemorySaveStoreFailureControls,
  type MemorySaveStoreFailureControls,
} from "../../src/persistence/memorySaveStore";
import { buildSaveEnvelope } from "../../src/persistence/envelope";
import type {
  AutosaveSummary,
  CheckpointSummary,
} from "../../src/persistence/saveStore";
import type {
  GameBackend,
  RustGameSnapshot,
  SandboxCreationRequest,
} from "../../src/runtime/backend/types";
import { createGameRuntime } from "../../src/runtime/createGameRuntime";
import {
  runtimeUnavailable,
  type ActiveCityIdentity,
  type GameplayWriteRequest,
  type NewCityIdentity,
  type PersistenceOperationResult,
} from "../../src/runtime/persistenceCoordinator";
import type { RuntimeController } from "../../src/runtime/types";
import {
  createRustSnapshot,
  previewBackendStubs,
} from "../fixtures/rustSnapshot";
import {
  createDelayedSaveStore,
  type DelayedSaveStore,
} from "./delayedSaveStore";

interface CoordinatorHarness {
  runtime: RuntimeController;
  backend: GameBackend & {
    snapshotForSaveCalls: number;
    restoreSnapshotCalls: number;
    tickCalls: number;
  };
  store: DelayedSaveStore;
  failures: MemorySaveStoreFailureControls;
  checkpointRequest(): GameplayWriteRequest<CheckpointSummary>;
  autosaveRequest(): GameplayWriteRequest<AutosaveSummary>;
}

function cityIdentity(id = "city-001"): ActiveCityIdentity {
  return {
    id,
    name: "Test City",
    cityCreatedAt: "2026-08-01T09:00:00.000Z",
  };
}

function sandboxRequest(): SandboxCreationRequest {
  return {
    templateId: "blankGrid",
    economyPreset: "standard",
    startingCapital: 120_000,
    demandMultiplier: 1,
    moveInRate: "paused",
  };
}

function newCityIdentity(): NewCityIdentity {
  return {
    id: "city-002",
    name: "New City",
    cityCreatedAt: "2026-08-01T10:00:00.000Z",
  };
}

function checkpointRequest(
  store: DelayedSaveStore,
): GameplayWriteRequest<CheckpointSummary> {
  return {
    kind: "checkpoint",
    write: ({ city, envelope }) =>
      store.writeCheckpoint({
        checkpointId: "checkpoint-001",
        cityId: city.id,
        name: "Checkpoint",
        note: null,
        envelope,
      }),
  };
}

function autosaveRequest(
  store: DelayedSaveStore,
): GameplayWriteRequest<AutosaveSummary> {
  return {
    kind: "autosave",
    write: ({ city, envelope }) =>
      store.writeAutosave({
        autosaveId: "autosave-001",
        cityId: city.id,
        generation: 1,
        envelope,
      }),
  };
}

async function createCoordinatorHarness(options?: {
  activeCity?: ActiveCityIdentity | null;
  clean?: boolean;
}): Promise<CoordinatorHarness> {
  let snapshot = createRustSnapshot();
  const preview = previewBackendStubs();
  const backend: CoordinatorHarness["backend"] = {
    ...preview,
    snapshotForSaveCalls: 0,
    restoreSnapshotCalls: 0,
    tickCalls: 0,
    async snapshot() {
      return snapshot;
    },
    async dispatch(intent) {
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
        context: { changedTiles: [], skippedTiles: [], cost: 0 },
      };
    },
    async tick(deltaSeconds) {
      backend.tickCalls += 1;
      const before = snapshot;
      if (!snapshot.paused && snapshot.speed !== 0) {
        snapshot = {
          ...snapshot,
          time: snapshot.time + deltaSeconds * snapshot.speed,
        };
      }
      return {
        snapshot,
        applied: snapshot !== before,
        rejection: null,
        context: { changedTiles: [], skippedTiles: [], cost: 0 },
      };
    },
    async reset() {
      snapshot = createRustSnapshot();
      return { ok: true, snapshot };
    },
    async createSandbox(request) {
      const result = await preview.createSandbox(request);
      if (result.ok) snapshot = result.snapshot;
      return result;
    },
    async snapshotForSave() {
      backend.snapshotForSaveCalls += 1;
      return { ok: true, snapshot: { ...snapshot, paused: true } };
    },
    async restoreSnapshot(request) {
      backend.restoreSnapshotCalls += 1;
      snapshot = request.snapshot as RustGameSnapshot;
      return { ok: true, snapshot };
    },
  };
  const failures = createMemorySaveStoreFailureControls();
  const store = createDelayedSaveStore(createMemorySaveStore({ failures }));
  const initialCity =
    options?.activeCity === undefined ? cityIdentity() : options.activeCity;
  const runtime = await createGameRuntime({
    backend,
    saveStore: store,
    initialCity,
    lastSavedAt: initialCity === null ? null : "2026-08-01T09:30:00.000Z",
    now: () => "2026-08-01T10:00:00.000Z",
    appVersion: "0.1.0",
  });
  if (options?.clean !== true) {
    await runtime.debugSetBudget(100_000);
  }
  return {
    runtime,
    backend,
    store,
    failures,
    checkpointRequest: () => checkpointRequest(store),
    autosaveRequest: () => autosaveRequest(store),
  };
}

function coordinatorBackend(): GameBackend {
  let snapshot = createRustSnapshot();
  return {
    ...previewBackendStubs(),
    async snapshot() {
      return snapshot;
    },
    async dispatch() {
      return {
        snapshot,
        applied: false,
        rejection: null,
        context: { changedTiles: [], skippedTiles: [], cost: 0 },
      };
    },
    async tick() {
      return {
        snapshot,
        applied: false,
        rejection: null,
        context: { changedTiles: [], skippedTiles: [], cost: 0 },
      };
    },
    async reset() {
      snapshot = createRustSnapshot();
      return { ok: true, snapshot };
    },
  };
}

describe("runtime persistence coordinator contracts", () => {
  it("represents supersession without a runtime error", () => {
    const result: PersistenceOperationResult<{ savedAt: string }> = {
      status: "superseded",
    };
    expect(result.status).toBe("superseded");
  });

  it("creates a typed unavailable result", () => {
    expect(runtimeUnavailable("saveWorking")).toEqual({
      status: "failed",
      error: {
        kind: "precondition",
        error: { code: "runtimeUnavailable", operation: "saveWorking" },
      },
    });
  });

  it("returns matching typed store failures when no SaveStore is configured", async () => {
    const runtime = await createGameRuntime({ backend: coordinatorBackend() });
    const write = vi.fn();
    const cases = [
      [runtime.persistence.saveWorking(), "writeWorkingSave"],
      [runtime.persistence.renameActiveCity("Renamed"), "renameCity"],
      [
        runtime.persistence.load({ kind: "working", cityId: "city-001" }),
        "readWorkingSave",
      ],
      [
        runtime.persistence.load({
          kind: "checkpoint",
          cityId: "city-001",
          checkpointId: "checkpoint-001",
        }),
        "readCheckpoint",
      ],
      [
        runtime.persistence.load({
          kind: "autosave",
          cityId: "city-001",
          autosaveId: "autosave-001",
        }),
        "readAutosave",
      ],
      [
        runtime.persistence.activateNewCity(
          {
            templateId: "blankGrid",
            economyPreset: "standard",
            startingCapital: 120_000,
            demandMultiplier: 1,
            moveInRate: "paused",
          },
          {
            id: "city-002",
            name: "New City",
            cityCreatedAt: "2026-08-01T10:00:00.000Z",
          },
        ),
        "writeWorkingSave",
      ],
      [
        runtime.persistence.runGameplayWrite({
          kind: "checkpoint",
          write,
        }),
        "writeCheckpoint",
      ],
      [
        runtime.persistence.runGameplayWrite({
          kind: "autosave",
          write,
        }),
        "writeAutosave",
      ],
    ] as const;

    for (const [operation, storeOperation] of cases) {
      await expect(operation).resolves.toEqual({
        status: "failed",
        error: {
          kind: "store",
          error: {
            operation: storeOperation,
            code: "unavailable",
            retryable: true,
            diagnostic: "No SaveStore is configured",
          },
        },
      });
    }
    expect(write).not.toHaveBeenCalled();
  });

  it("returns runtime unavailable after a fatal backend failure without a SaveStore", async () => {
    const base = coordinatorBackend();
    const runtime = await createGameRuntime({
      backend: {
        ...base,
        async dispatch() {
          throw new Error("fatal backend failure");
        },
      },
    });

    await runtime.debugSetBudget(100_000);

    await expect(runtime.persistence.saveWorking()).resolves.toEqual(
      runtimeUnavailable("saveWorking"),
    );
  });

  it("delays selected store operations and records mutation order", async () => {
    const store = createDelayedSaveStore(createMemorySaveStore());
    store.defer("renameCity");

    const rename = store.renameCity("city-001", "Renamed");
    await store.waitForActive("renameCity");

    expect(store.activeCount()).toBe(1);
    expect(store.mutationOrder()).toEqual(["renameCity"]);
    store.releaseNext("renameCity");
    await rename;
    expect(store.activeCount()).toBe(0);
  });

  it("delegates an undeferred store operation without a microtask boundary", async () => {
    const delegate = createMemorySaveStore();
    const listCities = vi.spyOn(delegate, "listCities");
    const store = createDelayedSaveStore(delegate);

    const listing = store.listCities();

    expect(listCities).toHaveBeenCalledTimes(1);
    await listing;
  });

  it("keeps gameplay-write request factories bound to their harness", async () => {
    const first = await createCoordinatorHarness({ clean: true });
    const second = await createCoordinatorHarness({ clean: true });
    const snapshot = createRustSnapshot();
    const envelope = buildSaveEnvelope({
      city: { id: cityIdentity().id, name: cityIdentity().name },
      cityCreatedAt: cityIdentity().cityCreatedAt,
      savedAt: "2026-08-01T10:00:00.000Z",
      appVersion: "0.1.0",
      snapshot,
    });

    await first.checkpointRequest().write({
      city: cityIdentity(),
      envelope,
    });

    expect(first.store.mutationOrder()).toEqual(["writeCheckpoint"]);
    expect(second.store.mutationOrder()).toEqual([]);
  });

  it("composes the deterministic coordinator harness", async () => {
    const harness = await createCoordinatorHarness({ clean: true });

    expect(harness.runtime.getSnapshot().persistence).toMatchObject({
      activeCity: cityIdentity(),
      dirty: false,
      lastSavedAt: "2026-08-01T09:30:00.000Z",
    });
    expect(harness.backend.snapshotForSaveCalls).toBe(0);
    expect(harness.backend.restoreSnapshotCalls).toBe(0);
    expect(harness.backend.tickCalls).toBe(0);
    expect(harness.store.activeCount()).toBe(0);
    expect(sandboxRequest()).toMatchObject({ templateId: "blankGrid" });
    expect(newCityIdentity()).toMatchObject({ id: "city-002" });
    expect(harness.checkpointRequest().kind).toBe("checkpoint");
    expect(harness.autosaveRequest().kind).toBe("autosave");
  });
});
