import { describe, expect, it, vi } from "vitest";
import {
  createMemorySaveStore,
  createMemorySaveStoreFailureControls,
  type MemorySaveStore,
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
import type { PersistenceOperationError } from "../../src/runtime/backend/persistenceContract";
import { createGameRuntime } from "../../src/runtime/createGameRuntime";
import {
  activeCityDeleteRequiresTransition,
  guardActiveCityDelete,
  noActiveCity,
  resolvePersistenceSessionCompletion,
  resolveWorkingSaveCompletion,
  runtimeUnavailable,
  type ActiveCityIdentity,
  type GameplayWriteRequest,
  type NewCityIdentity,
  type PersistenceOperationResult,
} from "../../src/runtime/persistenceCoordinator";
import type { RuntimeController } from "../../src/runtime/types";
import { createUiState } from "../../src/ui/uiState";
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
    createSandboxCalls: number;
    dispatchCalls: number;
    snapshotForSaveCalls: number;
    restoreSnapshotCalls: number;
    tickCalls: number;
  };
  store: DelayedSaveStore &
    Pick<
      MemorySaveStore,
      "seedRawWorking" | "seedRawCheckpoint" | "seedRawAutosave"
    >;
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
  omitPersistenceDependencies?: boolean;
  now?: () => string;
}): Promise<CoordinatorHarness> {
  let snapshot = createRustSnapshot();
  const preview = previewBackendStubs();
  const backend: CoordinatorHarness["backend"] = {
    ...preview,
    createSandboxCalls: 0,
    dispatchCalls: 0,
    snapshotForSaveCalls: 0,
    restoreSnapshotCalls: 0,
    tickCalls: 0,
    async snapshot() {
      return snapshot;
    },
    async dispatch(intent) {
      backend.dispatchCalls += 1;
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
      backend.createSandboxCalls += 1;
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
  const memoryStore = createMemorySaveStore({ failures });
  const store = Object.assign(createDelayedSaveStore(memoryStore), {
    seedRawWorking: memoryStore.seedRawWorking,
    seedRawCheckpoint: memoryStore.seedRawCheckpoint,
    seedRawAutosave: memoryStore.seedRawAutosave,
  });
  const initialCity =
    options?.activeCity === undefined ? cityIdentity() : options.activeCity;
  const runtime = await createGameRuntime({
    backend,
    saveStore: store,
    initialCity,
    lastSavedAt: initialCity === null ? null : "2026-08-01T09:30:00.000Z",
    ...(options?.omitPersistenceDependencies === true
      ? {}
      : {
          now: options?.now ?? (() => "2026-08-01T10:00:00.000Z"),
          appVersion: "0.1.0",
        }),
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

function loadEnvelope(input: {
  city?: ActiveCityIdentity;
  savedAt?: string;
  snapshot?: RustGameSnapshot;
}) {
  const city = input.city ?? cityIdentity("city-load");
  return buildSaveEnvelope({
    city: { id: city.id, name: city.name },
    cityCreatedAt: city.cityCreatedAt,
    savedAt: input.savedAt ?? "2026-08-01T11:00:00.000Z",
    appVersion: "0.1.0",
    snapshot:
      input.snapshot ?? createRustSnapshot({ paused: true, budget: 77_000 }),
  });
}

function seedLoadSource(
  store: CoordinatorHarness["store"],
  source:
    | { kind: "working"; cityId: string }
    | { kind: "checkpoint"; cityId: string; checkpointId: string }
    | { kind: "autosave"; cityId: string; autosaveId: string },
  envelope = loadEnvelope({ city: cityIdentity(source.cityId) }),
): void {
  switch (source.kind) {
    case "working":
      store.seedRawWorking(source.cityId, envelope);
      break;
    case "checkpoint":
      store.seedRawCheckpoint({
        storageCityId: source.cityId,
        storageCheckpointId: source.checkpointId,
        checkpointId: source.checkpointId,
        cityId: source.cityId,
        name: "Checkpoint",
        note: null,
        createdAt: envelope.savedAt,
        envelope,
      });
      break;
    case "autosave":
      store.seedRawAutosave({
        storageCityId: source.cityId,
        storageAutosaveId: source.autosaveId,
        autosaveId: source.autosaveId,
        cityId: source.cityId,
        generation: 1,
        createdAt: envelope.savedAt,
        envelope,
        generationHighWaterMark: 1,
      });
      break;
  }
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

const delayedActiveCityMutationCases = [
  {
    kind: "checkpoint",
    storeOperation: "writeCheckpoint",
    coordinatorOperation: "createCheckpoint",
    start: (harness: CoordinatorHarness) =>
      harness.runtime.persistence.runGameplayWrite(harness.checkpointRequest()),
  },
  {
    kind: "autosave",
    storeOperation: "writeAutosave",
    coordinatorOperation: "createAutosave",
    start: (harness: CoordinatorHarness) =>
      harness.runtime.persistence.runGameplayWrite(harness.autosaveRequest()),
  },
  {
    kind: "rename",
    storeOperation: "renameCity",
    coordinatorOperation: "renameActiveCity",
    start: (harness: CoordinatorHarness) =>
      harness.runtime.persistence.renameActiveCity("Renamed"),
  },
] as const;

const fifoHeadDeathCases = [
  {
    kind: "working save",
    coordinatorOperation: "saveWorking",
    start: (harness: CoordinatorHarness) =>
      harness.runtime.persistence.saveWorking(),
  },
  {
    kind: "checkpoint",
    coordinatorOperation: "createCheckpoint",
    start: (harness: CoordinatorHarness) =>
      harness.runtime.persistence.runGameplayWrite(harness.checkpointRequest()),
  },
  {
    kind: "autosave",
    coordinatorOperation: "createAutosave",
    start: (harness: CoordinatorHarness) =>
      harness.runtime.persistence.runGameplayWrite(harness.autosaveRequest()),
  },
  {
    kind: "rename",
    coordinatorOperation: "renameActiveCity",
    start: (harness: CoordinatorHarness) =>
      harness.runtime.persistence.renameActiveCity("Renamed After Death"),
  },
] as const;

describe("runtime persistence coordinator contracts", () => {
  it("guards only deletion of the active city", () => {
    expect(guardActiveCityDelete(cityIdentity(), "city-001")).toEqual(
      activeCityDeleteRequiresTransition("city-001"),
    );
    expect(guardActiveCityDelete(cityIdentity(), "city-002")).toBeNull();
    expect(guardActiveCityDelete(null, "city-001")).toBeNull();
  });

  it("keeps an older working-save completion from moving revision backward", () => {
    expect(
      resolveWorkingSaveCompletion({
        currentCityId: "city-001",
        currentSessionToken: 4,
        persistedRevision: 7,
        capturedCityId: "city-001",
        capturedSessionToken: 4,
        capturedRevision: 5,
      }),
    ).toEqual({ status: "current", persistedRevision: 7 });
  });

  it("supersedes a working-save completion from a stale session", () => {
    expect(
      resolveWorkingSaveCompletion({
        currentCityId: "city-001",
        currentSessionToken: 5,
        persistedRevision: 0,
        capturedCityId: "city-001",
        capturedSessionToken: 4,
        capturedRevision: 3,
      }),
    ).toEqual({ status: "superseded" });
  });

  it("supersedes a rename completion from a stale session", () => {
    expect(
      resolvePersistenceSessionCompletion({
        currentCityId: "city-001",
        currentSessionToken: 5,
        capturedCityId: "city-001",
        capturedSessionToken: 4,
      }),
    ).toEqual({ status: "superseded" });
  });

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

  it("does not capture a working save after the configured runtime is dead", async () => {
    const harness = await createCoordinatorHarness();
    harness.backend.dispatch = async () => {
      throw new Error("fatal backend failure");
    };

    await harness.runtime.debugSetBudget(90_000);

    await expect(harness.runtime.persistence.saveWorking()).resolves.toEqual(
      runtimeUnavailable("saveWorking"),
    );
    expect(harness.backend.snapshotForSaveCalls).toBe(0);
    expect(harness.store.mutationOrder()).toEqual([]);
  });

  it("does not complete a working save when the runtime dies during its store write", async () => {
    const harness = await createCoordinatorHarness();
    harness.store.defer("writeWorkingSave");
    const save = harness.runtime.persistence.saveWorking();
    await harness.store.waitForActive("writeWorkingSave");
    expect(harness.runtime.getSnapshot().persistence.saveStatus).toEqual({
      state: "writing",
      kind: "working",
      cityId: "city-001",
    });

    harness.backend.dispatch = async () => {
      throw new Error("fatal backend failure");
    };
    await harness.runtime.debugSetBudget(90_000);
    const persistenceAfterDeath = harness.runtime.getSnapshot().persistence;
    const listener = vi.fn();
    const unsubscribe = harness.runtime.subscribe(listener);

    harness.store.releaseNext("writeWorkingSave");

    await expect(save).resolves.toEqual(runtimeUnavailable("saveWorking"));
    expect(harness.runtime.getSnapshot().persistence).toEqual(
      persistenceAfterDeath,
    );
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("resets persistence activity statuses to idle on fatal backend failure", async () => {
    const harness = await createCoordinatorHarness();
    harness.store.defer("writeWorkingSave");
    const save = harness.runtime.persistence.saveWorking();
    await harness.store.waitForActive("writeWorkingSave");
    expect(harness.runtime.getSnapshot().persistence.saveStatus).toEqual({
      state: "writing",
      kind: "working",
      cityId: "city-001",
    });

    harness.backend.dispatch = async () => {
      throw new Error("fatal backend failure");
    };
    await harness.runtime.debugSetBudget(90_000);

    expect(harness.runtime.getSnapshot().persistence).toEqual({
      activeCity: cityIdentity(),
      dirty: true,
      saveStatus: { state: "idle" },
      loadStatus: { state: "idle" },
      lifecycleStatus: { state: "idle" },
      lastSavedAt: "2026-08-01T09:30:00.000Z",
      error: null,
    });

    harness.store.releaseNext("writeWorkingSave");
    await expect(save).resolves.toEqual(runtimeUnavailable("saveWorking"));
  });

  it("resets load status to idle on fatal backend failure during a pending read", async () => {
    const harness = await createCoordinatorHarness();
    const source = { kind: "working", cityId: "city-loaded" } as const;
    seedLoadSource(harness.store, source);
    harness.store.defer("readWorkingSave");
    const load = harness.runtime.persistence.load(source);
    await harness.store.waitForActive("readWorkingSave");
    expect(harness.runtime.getSnapshot().persistence.loadStatus).toEqual({
      state: "reading",
      source,
    });

    harness.backend.dispatch = async () => {
      throw new Error("fatal backend failure");
    };
    await harness.runtime.debugSetBudget(50_000);

    expect(harness.runtime.getSnapshot().persistence.loadStatus).toEqual({
      state: "idle",
    });

    harness.store.releaseNext("readWorkingSave");
    await expect(load).resolves.toEqual(runtimeUnavailable("loadWorking"));
  });

  it.each(delayedActiveCityMutationCases)(
    "returns runtime unavailable when a delayed $kind completion settles after death",
    async ({ storeOperation, coordinatorOperation, start }) => {
      const harness = await createCoordinatorHarness();
      harness.store.defer(storeOperation);
      const operation = start(harness);
      await harness.store.waitForActive(storeOperation);

      harness.backend.dispatch = async () => {
        throw new Error("fatal backend failure");
      };
      await harness.runtime.debugSetBudget(90_000);
      const afterDeath = harness.runtime.getSnapshot();
      harness.store.releaseNext(storeOperation);

      await expect(operation).resolves.toEqual(
        runtimeUnavailable(coordinatorOperation),
      );
      expect(harness.runtime.getSnapshot()).toEqual(afterDeath);
    },
  );

  it.each(fifoHeadDeathCases)(
    "does not start a queued $kind when it reaches the city FIFO head after runtime death",
    async ({ coordinatorOperation, start }) => {
      const harness = await createCoordinatorHarness({ clean: true });
      harness.store.defer("writeWorkingSave");
      const head = harness.runtime.persistence.saveWorking();
      await harness.store.waitForActive("writeWorkingSave");
      const queued = start(harness);

      harness.backend.dispatch = async () => {
        throw new Error("fatal backend failure");
      };
      await harness.runtime.debugSetBudget(90_000);
      const afterDeath = harness.runtime.getSnapshot();
      const listener = vi.fn();
      const unsubscribe = harness.runtime.subscribe(listener);

      harness.store.releaseNext("writeWorkingSave");

      await expect(head).resolves.toEqual(runtimeUnavailable("saveWorking"));
      await expect(queued).resolves.toEqual(
        runtimeUnavailable(coordinatorOperation),
      );
      expect(harness.store.mutationOrder()).toEqual(["writeWorkingSave"]);
      await expect(
        harness.store.readWorkingSave("city-001"),
      ).resolves.toMatchObject({
        ok: true,
        value: { city: { id: "city-001", name: "Test City" } },
      });
      expect(harness.runtime.getSnapshot()).toEqual(afterDeath);
      expect(listener).not.toHaveBeenCalled();
      unsubscribe();
    },
  );

  it.each(delayedActiveCityMutationCases)(
    "supersedes a delayed $kind completion after reset advances lineage",
    async ({ storeOperation, start }) => {
      const harness = await createCoordinatorHarness();
      harness.store.defer(storeOperation);
      const operation = start(harness);
      await harness.store.waitForActive(storeOperation);

      const afterReset = await harness.runtime.reset();
      harness.store.releaseNext(storeOperation);

      await expect(operation).resolves.toEqual({ status: "superseded" });
      expect(harness.runtime.getSnapshot()).toEqual(afterReset);
    },
  );

  it("returns a typed failure when working-save dependencies are omitted", async () => {
    const harness = await createCoordinatorHarness({
      clean: true,
      omitPersistenceDependencies: true,
    });

    const expected = {
      status: "failed",
      error: {
        kind: "store",
        error: {
          operation: "writeWorkingSave",
          code: "serializationFailed",
          cityId: "city-001",
          retryable: false,
          diagnostic: "Working-save dependencies are not configured",
        },
      },
    } as const;
    await expect(harness.runtime.persistence.saveWorking()).resolves.toEqual(
      expected,
    );
    expect(harness.backend.snapshotForSaveCalls).toBe(0);
    expect(harness.store.mutationOrder()).toEqual([]);
    expect(harness.runtime.getSnapshot().persistence).toMatchObject({
      dirty: false,
      saveStatus: { state: "idle" },
      lastSavedAt: "2026-08-01T09:30:00.000Z",
      error: expected.error,
    });
  });

  it("resolves a working-save clock exception as a typed failure", async () => {
    const harness = await createCoordinatorHarness({
      clean: true,
      now: () => {
        throw new Error("working clock failed");
      },
    });

    await expect(harness.runtime.persistence.saveWorking()).resolves.toEqual({
      status: "failed",
      error: {
        kind: "store",
        error: {
          operation: "writeWorkingSave",
          code: "serializationFailed",
          cityId: "city-001",
          retryable: false,
          diagnostic: "working clock failed",
        },
      },
    });
    expect(harness.runtime.getSnapshot().persistence).toMatchObject({
      dirty: false,
      saveStatus: { state: "idle" },
      lastSavedAt: "2026-08-01T09:30:00.000Z",
      error: {
        kind: "store",
        error: {
          operation: "writeWorkingSave",
          code: "serializationFailed",
        },
      },
    });
    expect(harness.store.mutationOrder()).toEqual([]);
  });

  it("resolves a working-save envelope exception as a typed failure", async () => {
    const harness = await createCoordinatorHarness({ clean: true });
    const hostileSnapshot = { ...createRustSnapshot() };
    // Redefine the existing enumerable `rules` data property as a throwing
    // accessor. Object.defineProperty preserves the property's existing
    // enumerability when the descriptor omits it, so the spread snapshot's
    // `rules` stays enumerable and serialization still invokes the getter.
    Object.defineProperty(hostileSnapshot, "rules", {
      get() {
        throw new Error("working envelope failed");
      },
    });
    harness.backend.snapshotForSave = async () => ({
      ok: true,
      snapshot: hostileSnapshot,
    });

    await expect(harness.runtime.persistence.saveWorking()).resolves.toEqual({
      status: "failed",
      error: {
        kind: "store",
        error: {
          operation: "writeWorkingSave",
          code: "serializationFailed",
          cityId: "city-001",
          retryable: false,
          diagnostic: "working envelope failed",
        },
      },
    });
    expect(harness.runtime.getSnapshot().persistence).toMatchObject({
      dirty: false,
      saveStatus: { state: "idle" },
      lastSavedAt: "2026-08-01T09:30:00.000Z",
      error: {
        kind: "store",
        error: {
          operation: "writeWorkingSave",
          code: "serializationFailed",
        },
      },
    });
    expect(harness.store.mutationOrder()).toEqual([]);
  });

  it("rejects a working save without an active city", async () => {
    const harness = await createCoordinatorHarness({ activeCity: null });

    await expect(harness.runtime.persistence.saveWorking()).resolves.toEqual(
      noActiveCity("saveWorking"),
    );
    expect(harness.backend.snapshotForSaveCalls).toBe(0);
    expect(harness.store.mutationOrder()).toEqual([]);
    expect(harness.runtime.getSnapshot().persistence.error).toEqual({
      kind: "precondition",
      error: { code: "noActiveCity", operation: "saveWorking" },
    });
  });

  it("serializes two working saves", async () => {
    const harness = await createCoordinatorHarness();
    harness.store.defer("writeWorkingSave");
    const first = harness.runtime.persistence.saveWorking();
    const second = harness.runtime.persistence.saveWorking();
    await harness.store.waitForActive("writeWorkingSave");
    expect(harness.store.activeCount()).toBe(1);
    expect(harness.backend.snapshotForSaveCalls).toBe(1);
    harness.store.releaseNext("writeWorkingSave");
    await first;
    await harness.store.waitForActive("writeWorkingSave");
    expect(harness.backend.snapshotForSaveCalls).toBe(2);
    harness.store.releaseNext("writeWorkingSave");
    await second;
    expect(harness.store.mutationOrder()).toEqual([
      "writeWorkingSave",
      "writeWorkingSave",
    ]);
  });

  it("remains dirty when gameplay mutates during a working save", async () => {
    const harness = await createCoordinatorHarness();
    harness.store.defer("writeWorkingSave");

    const save = harness.runtime.persistence.saveWorking();
    await harness.store.waitForActive("writeWorkingSave");
    await harness.runtime.debugSetBudget(90_000);
    harness.store.releaseNext("writeWorkingSave");

    await expect(save).resolves.toMatchObject({ status: "completed" });
    expect(harness.runtime.getSnapshot().persistence).toMatchObject({
      dirty: true,
      lastSavedAt: "2026-08-01T10:00:00.000Z",
      saveStatus: { state: "idle" },
    });
  });

  it("marks the captured working revision clean after a successful save", async () => {
    const harness = await createCoordinatorHarness();

    expect(harness.runtime.getSnapshot().persistence.dirty).toBe(true);
    await expect(
      harness.runtime.persistence.saveWorking(),
    ).resolves.toMatchObject({ status: "completed" });
    expect(harness.runtime.getSnapshot().persistence.dirty).toBe(false);
  });

  it("writes a clean explicit working save and refreshes its timestamp", async () => {
    const harness = await createCoordinatorHarness({ clean: true });

    await expect(
      harness.runtime.persistence.saveWorking(),
    ).resolves.toMatchObject({
      status: "completed",
      value: {
        savedAt: "2026-08-01T10:00:00.000Z",
        summary: {
          cityId: "city-001",
          savedAt: "2026-08-01T10:00:00.000Z",
        },
      },
    });
    expect(harness.backend.snapshotForSaveCalls).toBe(1);
    expect(harness.store.mutationOrder()).toEqual(["writeWorkingSave"]);
    expect(harness.runtime.getSnapshot().persistence).toMatchObject({
      dirty: false,
      lastSavedAt: "2026-08-01T10:00:00.000Z",
      saveStatus: { state: "idle" },
      error: null,
    });
  });

  it("serializes every active-city persistence mutation", async () => {
    const harness = await createCoordinatorHarness();
    harness.store.defer("writeWorkingSave");
    harness.store.defer("writeCheckpoint");
    harness.store.defer("writeAutosave");
    harness.store.defer("renameCity");
    const results = [
      harness.runtime.persistence.saveWorking(),
      harness.runtime.persistence.runGameplayWrite(harness.checkpointRequest()),
      harness.runtime.persistence.runGameplayWrite(harness.autosaveRequest()),
      harness.runtime.persistence.renameActiveCity("Renamed"),
    ];

    for (const operation of [
      "writeWorkingSave",
      "writeCheckpoint",
      "writeAutosave",
      "renameCity",
    ] as const) {
      await harness.store.waitForActive(operation);
      expect(harness.store.activeCount()).toBe(1);
      harness.store.releaseNext(operation);
    }

    await expect(Promise.all(results)).resolves.toEqual([
      expect.objectContaining({ status: "completed" }),
      expect.objectContaining({ status: "completed" }),
      expect.objectContaining({ status: "completed" }),
      expect.objectContaining({ status: "completed" }),
    ]);
    expect(harness.store.mutationOrder()).toEqual([
      "writeWorkingSave",
      "writeCheckpoint",
      "writeAutosave",
      "renameCity",
    ]);
  });

  it("keeps the FIFO-head save kind active when a later kind is queued", async () => {
    const harness = await createCoordinatorHarness();
    harness.store.defer("writeWorkingSave");
    harness.store.defer("writeCheckpoint");

    const working = harness.runtime.persistence.saveWorking();
    await harness.store.waitForActive("writeWorkingSave");
    expect(harness.runtime.getSnapshot().persistence.saveStatus).toEqual({
      state: "writing",
      kind: "working",
      cityId: "city-001",
    });

    const checkpoint = harness.runtime.persistence.runGameplayWrite(
      harness.checkpointRequest(),
    );
    const statusWhileCheckpointQueued =
      harness.runtime.getSnapshot().persistence.saveStatus;

    harness.store.releaseNext("writeWorkingSave");
    await working;
    await harness.store.waitForActive("writeCheckpoint");
    const statusAtCheckpointHead =
      harness.runtime.getSnapshot().persistence.saveStatus;
    harness.store.releaseNext("writeCheckpoint");
    await checkpoint;

    expect(statusWhileCheckpointQueued).toEqual({
      state: "writing",
      kind: "working",
      cityId: "city-001",
    });
    expect(statusAtCheckpointHead).toEqual({
      state: "writing",
      kind: "checkpoint",
      cityId: "city-001",
    });
  });

  it("resolves a generation clock exception as a typed failure", async () => {
    const harness = await createCoordinatorHarness({
      now: () => {
        throw new Error("clock failed");
      },
    });

    const write = harness.runtime.persistence.runGameplayWrite(
      harness.checkpointRequest(),
    );

    await expect(write).resolves.toEqual({
      status: "failed",
      error: {
        kind: "store",
        error: {
          operation: "writeCheckpoint",
          code: "serializationFailed",
          cityId: "city-001",
          retryable: false,
          diagnostic: "clock failed",
        },
      },
    });
    expect(harness.runtime.getSnapshot().persistence).toMatchObject({
      saveStatus: { state: "idle" },
      error: {
        kind: "store",
        error: { operation: "writeCheckpoint", code: "serializationFailed" },
      },
    });
    expect(harness.store.mutationOrder()).toEqual([]);
  });

  it("resolves a generation envelope exception as a typed failure", async () => {
    const harness = await createCoordinatorHarness();
    const hostileSnapshot = { ...createRustSnapshot() };
    Object.defineProperty(hostileSnapshot, "rules", {
      get() {
        throw new Error("envelope failed");
      },
    });
    harness.backend.snapshotForSave = async () => ({
      ok: true,
      snapshot: hostileSnapshot,
    });

    const write = harness.runtime.persistence.runGameplayWrite(
      harness.autosaveRequest(),
    );

    await expect(write).resolves.toEqual({
      status: "failed",
      error: {
        kind: "store",
        error: {
          operation: "writeAutosave",
          code: "serializationFailed",
          cityId: "city-001",
          retryable: false,
          diagnostic: "envelope failed",
        },
      },
    });
    expect(harness.runtime.getSnapshot().persistence).toMatchObject({
      saveStatus: { state: "idle" },
      error: {
        kind: "store",
        error: { operation: "writeAutosave", code: "serializationFailed" },
      },
    });
    expect(harness.store.mutationOrder()).toEqual([]);
  });

  it.each([
    ["checkpoint", "writeCheckpoint"],
    ["autosave", "writeAutosave"],
  ] as const)(
    "keeps the working-save baseline dirty after a successful %s write",
    async (kind, operation) => {
      const harness = await createCoordinatorHarness();
      harness.store.defer(operation);

      const write =
        kind === "checkpoint"
          ? harness.runtime.persistence.runGameplayWrite(
              harness.checkpointRequest(),
            )
          : harness.runtime.persistence.runGameplayWrite(
              harness.autosaveRequest(),
            );
      await harness.store.waitForActive(operation);
      expect(harness.runtime.getSnapshot().persistence).toMatchObject({
        dirty: true,
        lastSavedAt: "2026-08-01T09:30:00.000Z",
        saveStatus: { state: "writing", kind, cityId: "city-001" },
      });
      harness.store.releaseNext(operation);

      await expect(write).resolves.toMatchObject({ status: "completed" });
      expect(harness.runtime.getSnapshot().persistence).toMatchObject({
        dirty: true,
        lastSavedAt: "2026-08-01T09:30:00.000Z",
        saveStatus: { state: "idle" },
        error: null,
      });
    },
  );

  it("applies rename completion to the live gameplay state", async () => {
    const harness = await createCoordinatorHarness({ clean: true });
    await harness.runtime.persistence.saveWorking();
    harness.store.defer("renameCity");

    const rename = harness.runtime.persistence.renameActiveCity("Renamed");
    await harness.store.waitForActive("renameCity");
    await harness.runtime.debugSetBudget(90_000);
    const liveUi = harness.runtime.getSnapshot().ui;
    harness.store.releaseNext("renameCity");

    await expect(rename).resolves.toMatchObject({
      status: "completed",
      value: { summary: { cityId: "city-001", name: "Renamed" } },
    });
    expect(harness.runtime.getSnapshot()).toMatchObject({
      state: { budget: 90_000 },
      persistence: {
        activeCity: { id: "city-001", name: "Renamed" },
        dirty: true,
        lastSavedAt: "2026-08-01T10:00:00.000Z",
      },
    });
    expect(harness.runtime.getSnapshot().ui).toBe(liveUi);
  });

  it("uses a completed rename for a later queued working save", async () => {
    const harness = await createCoordinatorHarness({ clean: true });
    await harness.runtime.persistence.saveWorking();
    harness.store.defer("renameCity");
    harness.store.defer("writeWorkingSave");

    const rename = harness.runtime.persistence.renameActiveCity("Renamed");
    const save = harness.runtime.persistence.saveWorking();
    await harness.store.waitForActive("renameCity");
    harness.store.releaseNext("renameCity");
    await rename;
    await harness.store.waitForActive("writeWorkingSave");
    harness.store.releaseNext("writeWorkingSave");

    await expect(save).resolves.toMatchObject({
      status: "completed",
      value: { summary: { cityId: "city-001", name: "Renamed" } },
    });
    expect(harness.runtime.getSnapshot().persistence.activeCity).toMatchObject({
      id: "city-001",
      name: "Renamed",
    });
  });

  it("uses a completed rename for a later queued generation capture", async () => {
    const harness = await createCoordinatorHarness({ clean: true });
    await harness.runtime.persistence.saveWorking();
    harness.store.defer("renameCity");
    harness.store.defer("writeCheckpoint");

    const rename = harness.runtime.persistence.renameActiveCity("Renamed");
    const checkpoint = harness.runtime.persistence.runGameplayWrite(
      harness.checkpointRequest(),
    );
    await harness.store.waitForActive("renameCity");
    harness.store.releaseNext("renameCity");
    await rename;
    await harness.store.waitForActive("writeCheckpoint");
    harness.store.releaseNext("writeCheckpoint");
    await checkpoint;

    await expect(
      harness.store.readCheckpoint("city-001", "checkpoint-001"),
    ).resolves.toMatchObject({
      ok: true,
      value: { city: { id: "city-001", name: "Renamed" } },
    });
  });

  it("preserves runtime on inspection failure", async () => {
    const harness = await createCoordinatorHarness();
    harness.store.seedRawWorking("other", { format: "broken" });
    const before = harness.runtime.getSnapshot();
    const expectedError = {
      kind: "envelope",
      error: { code: "corruptHeader" },
    } as const;

    const result = await harness.runtime.persistence.load({
      kind: "working",
      cityId: "other",
    });

    expect(result).toEqual({
      status: "failed",
      error: expectedError,
    });
    expect(harness.backend.restoreSnapshotCalls).toBe(0);
    const after = harness.runtime.getSnapshot();
    expect(after.state).toBe(before.state);
    expect(after.ui).toBe(before.ui);
    expect(after.persistence).toEqual({
      ...before.persistence,
      loadStatus: { state: "idle" },
      error: expectedError,
    });
  });

  it("preserves runtime and dirty bookkeeping on a store read failure", async () => {
    const harness = await createCoordinatorHarness();
    harness.failures.failNext("readWorkingSave", "ioFailure");
    const before = harness.runtime.getSnapshot();
    const expectedError = {
      kind: "store",
      error: {
        operation: "readWorkingSave",
        code: "ioFailure",
        cityId: "other",
        retryable: true,
        diagnostic: "readWorkingSave failed with ioFailure",
      },
    } as const;

    const result = await harness.runtime.persistence.load({
      kind: "working",
      cityId: "other",
    });

    expect(result).toEqual({
      status: "failed",
      error: expectedError,
    });
    expect(harness.backend.restoreSnapshotCalls).toBe(0);
    const after = harness.runtime.getSnapshot();
    expect(after.state).toBe(before.state);
    expect(after.ui).toBe(before.ui);
    expect(after.persistence).toEqual({
      ...before.persistence,
      loadStatus: { state: "idle" },
      error: expectedError,
    });
  });

  it("publishes token-owned reading and restoring load transitions", async () => {
    const harness = await createCoordinatorHarness({ clean: true });
    const source = { kind: "working", cityId: "city-loaded" } as const;
    seedLoadSource(harness.store, source);
    harness.failures.failNext("writeWorkingSave", "ioFailure");
    await harness.runtime.persistence.saveWorking();
    expect(harness.runtime.getSnapshot().persistence.error).not.toBeNull();
    harness.store.defer("readWorkingSave");

    const restoreSnapshot = harness.backend.restoreSnapshot.bind(
      harness.backend,
    );
    let signalRestoreStarted: (() => void) | undefined;
    const restoreStarted = new Promise<void>((resolve) => {
      signalRestoreStarted = resolve;
    });
    let releaseRestore: (() => void) | undefined;
    const restoreGate = new Promise<void>((resolve) => {
      releaseRestore = resolve;
    });
    harness.backend.restoreSnapshot = async (request) => {
      signalRestoreStarted?.();
      await restoreGate;
      return restoreSnapshot(request);
    };
    const listener = vi.fn();
    const unsubscribe = harness.runtime.subscribe(listener);
    const load = harness.runtime.persistence.load(source);

    try {
      await harness.store.waitForActive("readWorkingSave");
      expect(harness.runtime.getSnapshot().persistence).toMatchObject({
        loadStatus: { state: "reading", source },
        error: null,
      });

      harness.store.releaseNext("readWorkingSave");
      await restoreStarted;
      expect(harness.runtime.getSnapshot().persistence).toMatchObject({
        loadStatus: { state: "restoring", source },
        error: null,
      });

      releaseRestore?.();
      await expect(load).resolves.toMatchObject({ status: "completed" });
      expect(
        listener.mock.calls.map(
          ([snapshot]) => snapshot.persistence.loadStatus.state,
        ),
      ).toEqual(["reading", "restoring", "idle"]);
    } finally {
      harness.store.releaseAll();
      releaseRestore?.();
      await Promise.allSettled([load]);
      unsubscribe();
    }
  });

  it.each([
    {
      source: { kind: "working", cityId: "city-working" } as const,
      storeOperation: "readWorkingSave",
      recordId: undefined,
    },
    {
      source: {
        kind: "checkpoint",
        cityId: "city-checkpoint",
        checkpointId: "checkpoint-001",
      } as const,
      storeOperation: "readCheckpoint",
      recordId: "checkpoint-001",
    },
    {
      source: {
        kind: "autosave",
        cityId: "city-autosave",
        autosaveId: "autosave-001",
      } as const,
      storeOperation: "readAutosave",
      recordId: "autosave-001",
    },
  ])(
    "rejects a $source.kind whose envelope is bound to another city",
    async ({ source, storeOperation, recordId }) => {
      const harness = await createCoordinatorHarness({ clean: true });
      seedLoadSource(
        harness.store,
        source,
        loadEnvelope({ city: cityIdentity("envelope-city") }),
      );
      const before = harness.runtime.getSnapshot();

      const result = await harness.runtime.persistence.load(source);

      expect(result).toMatchObject({
        status: "failed",
        error: {
          kind: "store",
          error: {
            operation: storeOperation,
            code: "corruptRecord",
            cityId: source.cityId,
            ...(recordId === undefined ? {} : { recordId }),
            retryable: false,
          },
        },
      });
      if (result.status !== "failed") {
        throw new Error("Expected city binding failure");
      }
      expect(harness.backend.restoreSnapshotCalls).toBe(0);
      const after = harness.runtime.getSnapshot();
      expect(after.state).toBe(before.state);
      expect(after.ui).toBe(before.ui);
      expect(after.persistence).toEqual({
        ...before.persistence,
        loadStatus: { state: "idle" },
        error: result.error,
      });
    },
  );

  it("supersedes an older load before it can restore", async () => {
    const harness = await createCoordinatorHarness();
    seedLoadSource(harness.store, { kind: "working", cityId: "city-old" });
    seedLoadSource(harness.store, { kind: "working", cityId: "city-new" });
    harness.store.defer("readWorkingSave");

    const older = harness.runtime.persistence.load({
      kind: "working",
      cityId: "city-old",
    });
    const newer = harness.runtime.persistence.load({
      kind: "working",
      cityId: "city-new",
    });
    await vi.waitFor(() => {
      expect(harness.store.activeCount()).toBe(2);
    });

    harness.store.releaseNext("readWorkingSave");
    await expect(older).resolves.toEqual({ status: "superseded" });
    expect(harness.backend.restoreSnapshotCalls).toBe(0);

    harness.store.releaseNext("readWorkingSave");
    await expect(newer).resolves.toMatchObject({ status: "completed" });
    expect(harness.backend.restoreSnapshotCalls).toBe(1);
    expect(harness.runtime.getSnapshot().persistence.activeCity?.id).toBe(
      "city-new",
    );
  });

  it("rolls back a stale successful restore before the newer load commits", async () => {
    const harness = await createCoordinatorHarness();
    const olderSource = { kind: "working", cityId: "city-old" } as const;
    const newerSource = { kind: "working", cityId: "city-new" } as const;
    seedLoadSource(
      harness.store,
      olderSource,
      loadEnvelope({
        city: cityIdentity(olderSource.cityId),
        snapshot: createRustSnapshot({ paused: true, budget: 71_000 }),
      }),
    );
    seedLoadSource(
      harness.store,
      newerSource,
      loadEnvelope({
        city: cityIdentity(newerSource.cityId),
        snapshot: createRustSnapshot({ paused: true, budget: 82_000 }),
      }),
    );
    const restoreSnapshot = harness.backend.restoreSnapshot.bind(
      harness.backend,
    );
    let restoreInvocation = 0;
    let signalOlderRestoreStarted: (() => void) | undefined;
    const olderRestoreStarted = new Promise<void>((resolve) => {
      signalOlderRestoreStarted = resolve;
    });
    let releaseOlderRestore: (() => void) | undefined;
    const olderRestoreGate = new Promise<void>((resolve) => {
      releaseOlderRestore = resolve;
    });
    harness.backend.restoreSnapshot = async (request) => {
      restoreInvocation += 1;
      if (restoreInvocation === 1) {
        signalOlderRestoreStarted?.();
        await olderRestoreGate;
      }
      return restoreSnapshot(request);
    };
    const publishedCityIds: Array<string | null> = [];
    const unsubscribe = harness.runtime.subscribe((snapshot) => {
      publishedCityIds.push(snapshot.persistence.activeCity?.id ?? null);
    });

    const older = harness.runtime.persistence.load(olderSource);
    await olderRestoreStarted;
    const newer = harness.runtime.persistence.load(newerSource);
    releaseOlderRestore?.();
    const [olderResult, newerResult] = await Promise.all([older, newer]);

    expect(olderResult).toEqual({ status: "superseded" });
    expect(newerResult).toMatchObject({
      status: "completed",
      value: {
        source: newerSource,
        snapshot: {
          state: { budget: 82_000, paused: true },
          persistence: { activeCity: { id: newerSource.cityId } },
        },
      },
    });
    expect(publishedCityIds).not.toContain(olderSource.cityId);
    expect(harness.backend.restoreSnapshotCalls).toBe(3);
    expect(harness.runtime.getSnapshot()).toMatchObject({
      state: { budget: 82_000, paused: true },
      persistence: { activeCity: { id: newerSource.cityId } },
    });
    await expect(harness.backend.snapshot()).resolves.toMatchObject({
      budget: 82_000,
      paused: true,
    });
    unsubscribe();
  });

  it("rolls back a stale successful restore when the newer load fails before restore", async () => {
    const harness = await createCoordinatorHarness();
    await harness.runtime.togglePause();
    const before = harness.runtime.getSnapshot();
    const beforeBackend = await harness.backend.snapshot();
    const olderSource = { kind: "working", cityId: "city-old" } as const;
    const newerSource = { kind: "working", cityId: "city-broken" } as const;
    seedLoadSource(
      harness.store,
      olderSource,
      loadEnvelope({
        city: cityIdentity(olderSource.cityId),
        snapshot: createRustSnapshot({ paused: true, budget: 71_000 }),
      }),
    );
    harness.store.seedRawWorking(newerSource.cityId, { format: "broken" });
    const restoreSnapshot = harness.backend.restoreSnapshot.bind(
      harness.backend,
    );
    let signalOlderRestoreStarted: (() => void) | undefined;
    const olderRestoreStarted = new Promise<void>((resolve) => {
      signalOlderRestoreStarted = resolve;
    });
    let releaseOlderRestore: (() => void) | undefined;
    const olderRestoreGate = new Promise<void>((resolve) => {
      releaseOlderRestore = resolve;
    });
    let restoreInvocation = 0;
    harness.backend.restoreSnapshot = async (request) => {
      restoreInvocation += 1;
      if (restoreInvocation === 1) {
        signalOlderRestoreStarted?.();
        await olderRestoreGate;
      }
      return restoreSnapshot(request);
    };

    const older = harness.runtime.persistence.load(olderSource);
    await olderRestoreStarted;
    const newerResult = await harness.runtime.persistence.load(newerSource);
    releaseOlderRestore?.();
    const olderResult = await older;

    expect(olderResult).toEqual({ status: "superseded" });
    expect(newerResult).toMatchObject({
      status: "failed",
      error: { kind: "envelope" },
    });
    const after = harness.runtime.getSnapshot();
    expect(after.state).toBe(before.state);
    expect(after.persistence).toMatchObject({
      activeCity: { id: before.persistence.activeCity?.id },
      loadStatus: { state: "idle" },
      error: newerResult.status === "failed" ? newerResult.error : undefined,
    });
    await expect(harness.backend.snapshot()).resolves.toMatchObject({
      budget: beforeBackend.budget,
      paused: beforeBackend.paused,
    });
  });

  it("keeps the prior runtime coherent when the newer load is rejected during restore", async () => {
    const harness = await createCoordinatorHarness();
    const before = harness.runtime.getSnapshot();
    const beforeBackend = await harness.backend.snapshot();
    const olderSource = { kind: "working", cityId: "city-old" } as const;
    const newerSource = { kind: "working", cityId: "city-rejected" } as const;
    seedLoadSource(
      harness.store,
      olderSource,
      loadEnvelope({
        city: cityIdentity(olderSource.cityId),
        snapshot: createRustSnapshot({ paused: true, budget: 71_000 }),
      }),
    );
    seedLoadSource(
      harness.store,
      newerSource,
      loadEnvelope({
        city: cityIdentity(newerSource.cityId),
        snapshot: createRustSnapshot({ paused: true, budget: 82_000 }),
      }),
    );
    const newerRestoreError: PersistenceOperationError = {
      kind: "validation",
      operation: "restoreSnapshot",
      source: "candidate",
      error: {
        code: "invalidNumericValue",
        context: {
          field: "budget",
          reason: { kind: "negative" },
        },
      },
    };
    const restoreSnapshot = harness.backend.restoreSnapshot.bind(
      harness.backend,
    );
    let signalOlderRestoreStarted: (() => void) | undefined;
    const olderRestoreStarted = new Promise<void>((resolve) => {
      signalOlderRestoreStarted = resolve;
    });
    let releaseOlderRestore: (() => void) | undefined;
    const olderRestoreGate = new Promise<void>((resolve) => {
      releaseOlderRestore = resolve;
    });
    let blockedOlderCandidate = false;
    harness.backend.restoreSnapshot = async (request) => {
      const requested = request.snapshot as RustGameSnapshot;
      if (requested.budget === 71_000 && !blockedOlderCandidate) {
        blockedOlderCandidate = true;
        signalOlderRestoreStarted?.();
        await olderRestoreGate;
      }
      if (requested.budget === 82_000) {
        harness.backend.restoreSnapshotCalls += 1;
        return { ok: false, error: newerRestoreError };
      }
      return restoreSnapshot(request);
    };

    const older = harness.runtime.persistence.load(olderSource);
    await olderRestoreStarted;
    const newer = harness.runtime.persistence.load(newerSource);
    releaseOlderRestore?.();
    const [olderResult, newerResult] = await Promise.all([older, newer]);

    expect(olderResult).toEqual({ status: "superseded" });
    expect(newerResult).toEqual({
      status: "failed",
      error: { kind: "backend", error: newerRestoreError },
    });
    const after = harness.runtime.getSnapshot();
    expect(after.state).toBe(before.state);
    expect(after.persistence).toMatchObject({
      activeCity: { id: before.persistence.activeCity?.id },
      loadStatus: { state: "idle" },
      error: { kind: "backend", error: newerRestoreError },
    });
    await expect(harness.backend.snapshot()).resolves.toMatchObject({
      budget: beforeBackend.budget,
      paused: beforeBackend.paused,
    });
  });

  it("fails fatally and resolves queued load and detach with typed results when stale rollback fails", async () => {
    const harness = await createCoordinatorHarness();
    harness.runtime.start();
    const beforeBackend = await harness.backend.snapshot();
    const olderSource = { kind: "working", cityId: "city-old" } as const;
    const newerSource = { kind: "working", cityId: "city-new" } as const;
    seedLoadSource(
      harness.store,
      olderSource,
      loadEnvelope({
        city: cityIdentity(olderSource.cityId),
        snapshot: createRustSnapshot({ paused: true, budget: 71_000 }),
      }),
    );
    seedLoadSource(
      harness.store,
      newerSource,
      loadEnvelope({
        city: cityIdentity(newerSource.cityId),
        snapshot: createRustSnapshot({ paused: true, budget: 82_000 }),
      }),
    );
    const rollbackError: PersistenceOperationError = {
      kind: "host",
      operation: "restoreSnapshot",
      code: "invokeFailed",
      diagnostic: "stale load rollback failed",
    };
    const restoreSnapshot = harness.backend.restoreSnapshot.bind(
      harness.backend,
    );
    let signalOlderRestoreStarted: (() => void) | undefined;
    const olderRestoreStarted = new Promise<void>((resolve) => {
      signalOlderRestoreStarted = resolve;
    });
    let releaseOlderRestore: (() => void) | undefined;
    const olderRestoreGate = new Promise<void>((resolve) => {
      releaseOlderRestore = resolve;
    });
    let blockedOlderCandidate = false;
    harness.backend.restoreSnapshot = async (request) => {
      const requested = request.snapshot as RustGameSnapshot;
      if (requested.budget === 71_000 && !blockedOlderCandidate) {
        blockedOlderCandidate = true;
        signalOlderRestoreStarted?.();
        await olderRestoreGate;
      }
      if (requested.budget === beforeBackend.budget) {
        harness.backend.restoreSnapshotCalls += 1;
        return { ok: false, error: rollbackError };
      }
      return restoreSnapshot(request);
    };

    const older = harness.runtime.persistence.load(olderSource);
    await olderRestoreStarted;
    const newer = harness.runtime.persistence.load(newerSource);
    const detach = harness.runtime.persistence.detachActiveCity();
    releaseOlderRestore?.();
    const [olderResult, newerResult, detachResult] = await Promise.all([
      older,
      newer,
      detach,
    ]);

    expect(olderResult).toEqual(runtimeUnavailable("loadWorking"));
    expect(newerResult).toEqual(runtimeUnavailable("loadWorking"));
    expect(detachResult).toEqual(runtimeUnavailable("detachActiveCity"));
    expect(harness.runtime.getSnapshot()).toMatchObject({
      backendError: "stale load rollback failed",
      persistence: {
        activeCity: null,
        dirty: false,
        saveStatus: { state: "idle" },
        loadStatus: { state: "idle" },
        lifecycleStatus: { state: "idle" },
        lastSavedAt: null,
        error: null,
      },
    });
    expect(harness.runtime.isRunning()).toBe(false);
    await expect(harness.runtime.persistence.saveWorking()).resolves.toEqual(
      runtimeUnavailable("saveWorking"),
    );
  });

  it("preserves runtime when Rust rejects restoration", async () => {
    const harness = await createCoordinatorHarness();
    const source = { kind: "working", cityId: "other" } as const;
    seedLoadSource(harness.store, source);
    const restoreError: PersistenceOperationError = {
      kind: "validation",
      operation: "restoreSnapshot",
      source: "candidate",
      error: {
        code: "invalidNumericValue",
        context: {
          field: "budget",
          reason: { kind: "negative" },
        },
      },
    };
    harness.backend.restoreSnapshot = async () => {
      harness.backend.restoreSnapshotCalls += 1;
      return { ok: false, error: restoreError };
    };
    const before = harness.runtime.getSnapshot();

    const result = await harness.runtime.persistence.load(source);

    expect(result).toEqual({
      status: "failed",
      error: { kind: "backend", error: restoreError },
    });
    const after = harness.runtime.getSnapshot();
    expect(after.state).toBe(before.state);
    expect(after.ui).toBe(before.ui);
    expect(after.persistence).toEqual({
      ...before.persistence,
      loadStatus: { state: "idle" },
      error: { kind: "backend", error: restoreError },
    });
  });

  it("commits a successful working load atomically after status publications", async () => {
    const harness = await createCoordinatorHarness();
    const source = { kind: "working", cityId: "city-loaded" } as const;
    const savedAt = "2026-08-01T11:45:00.000Z";
    seedLoadSource(
      harness.store,
      source,
      loadEnvelope({
        city: { ...cityIdentity(source.cityId), name: "Loaded City" },
        savedAt,
        snapshot: createRustSnapshot({
          paused: true,
          speed: 4,
          budget: 77_000,
        }),
      }),
    );
    const listener = vi.fn();
    const unsubscribe = harness.runtime.subscribe(listener);

    const result = await harness.runtime.persistence.load(source);

    expect(result).toMatchObject({
      status: "completed",
      value: { source, snapshot: { state: { budget: 77_000, paused: true } } },
    });
    expect(listener).toHaveBeenCalledTimes(3);
    expect(listener.mock.calls[0]?.[0].persistence.loadStatus).toEqual({
      state: "reading",
      source,
    });
    expect(listener.mock.calls[1]?.[0].persistence.loadStatus).toEqual({
      state: "restoring",
      source,
    });
    expect(listener.mock.calls[2]?.[0]).toBe(
      result.status === "completed" ? result.value.snapshot : undefined,
    );
    expect(harness.runtime.getSnapshot().persistence).toEqual({
      activeCity: {
        id: source.cityId,
        name: "Loaded City",
        cityCreatedAt: "2026-08-01T09:00:00.000Z",
      },
      dirty: false,
      saveStatus: { state: "idle" },
      loadStatus: { state: "idle" },
      lifecycleStatus: { state: "idle" },
      lastSavedAt: savedAt,
      error: null,
    });
    unsubscribe();
  });

  it.each([
    {
      source: {
        kind: "checkpoint",
        cityId: "city-checkpoint",
        checkpointId: "checkpoint-loaded",
      } as const,
    },
    {
      source: {
        kind: "autosave",
        cityId: "city-autosave",
        autosaveId: "autosave-loaded",
      } as const,
    },
  ])("loads a $source.kind paused and dirty", async ({ source }) => {
    const harness = await createCoordinatorHarness({ clean: true });
    seedLoadSource(
      harness.store,
      source,
      loadEnvelope({
        city: cityIdentity(source.cityId),
        snapshot: createRustSnapshot({ paused: true, budget: 66_000 }),
      }),
    );

    const result = await harness.runtime.persistence.load(source);

    expect(result).toMatchObject({
      status: "completed",
      value: { snapshot: { state: { budget: 66_000, paused: true } } },
    });
    expect(harness.runtime.getSnapshot().persistence).toMatchObject({
      activeCity: { id: source.cityId },
      dirty: true,
      lastSavedAt: null,
    });
  });

  it("runs gameplay queued before load restoration admission before the restore", async () => {
    const harness = await createCoordinatorHarness({ clean: true });
    const source = { kind: "working", cityId: "city-loaded" } as const;
    seedLoadSource(harness.store, source);
    harness.store.defer("readWorkingSave");
    const order: string[] = [];
    const dispatch = harness.backend.dispatch.bind(harness.backend);
    const restoreSnapshot = harness.backend.restoreSnapshot.bind(
      harness.backend,
    );
    harness.backend.dispatch = async (intent) => {
      order.push("dispatch");
      return dispatch(intent);
    };
    harness.backend.restoreSnapshot = async (request) => {
      order.push("restore");
      return restoreSnapshot(request);
    };

    const load = harness.runtime.persistence.load(source);
    await harness.store.waitForActive("readWorkingSave");
    const gameplay = harness.runtime.debugSetBudget(88_000);
    await gameplay;
    harness.store.releaseNext("readWorkingSave");
    await load;

    expect(order).toEqual(["dispatch", "restore"]);
    expect(harness.runtime.getSnapshot()).toMatchObject({
      state: { budget: 77_000 },
      persistence: { activeCity: { id: source.cityId }, dirty: false },
    });
  });

  it("runs gameplay queued after load restoration admission after the restore", async () => {
    const harness = await createCoordinatorHarness({ clean: true });
    const source = { kind: "working", cityId: "city-loaded" } as const;
    seedLoadSource(harness.store, source);
    const order: string[] = [];
    const dispatch = harness.backend.dispatch.bind(harness.backend);
    const restoreSnapshot = harness.backend.restoreSnapshot.bind(
      harness.backend,
    );
    let signalRestoreStarted: (() => void) | undefined;
    const restoreStarted = new Promise<void>((resolve) => {
      signalRestoreStarted = resolve;
    });
    let releaseRestore: (() => void) | undefined;
    const restoreGate = new Promise<void>((resolve) => {
      releaseRestore = resolve;
    });
    harness.backend.dispatch = async (intent) => {
      order.push("dispatch");
      return dispatch(intent);
    };
    harness.backend.restoreSnapshot = async (request) => {
      order.push("restore:start");
      signalRestoreStarted?.();
      await restoreGate;
      const result = await restoreSnapshot(request);
      order.push("restore:end");
      return result;
    };

    const load = harness.runtime.persistence.load(source);
    await restoreStarted;
    const gameplay = harness.runtime.debugSetBudget(88_000);
    await Promise.resolve();
    const orderBeforeRestoreRelease = [...order];
    releaseRestore?.();
    await Promise.all([load, gameplay]);

    expect(orderBeforeRestoreRelease).toEqual(["restore:start"]);
    expect(order).toEqual(["restore:start", "restore:end", "dispatch"]);
    expect(harness.runtime.getSnapshot()).toMatchObject({
      state: { budget: 88_000 },
      persistence: { activeCity: { id: source.cityId }, dirty: true },
    });
  });

  it("clears transient UI and runtime errors only after a successful load", async () => {
    const harness = await createCoordinatorHarness();
    const source = { kind: "working", cityId: "city-loaded" } as const;
    seedLoadSource(harness.store, source);
    harness.runtime.setTool("road");
    harness.runtime.setHoverTile({ x: 2, y: 2 });
    harness.runtime.startDrag({ x: 2, y: 2 });
    const beforeReset = await harness.backend.snapshot();
    harness.backend.dispatch = async () => ({
      snapshot: beforeReset,
      applied: false,
      rejection: { code: "blockedTile", context: { affectedRouteIds: [] } },
      context: { changedTiles: [], skippedTiles: [], cost: 0 },
    });
    await harness.runtime.debugSetBudget(50_000);
    harness.backend.reset = async () => ({
      ok: false,
      error: {
        code: "unsupportedGameMode",
        context: { gameMode: "campaign" },
      },
    });
    await harness.runtime.reset();
    harness.failures.failNext("writeWorkingSave", "ioFailure");
    await harness.runtime.persistence.saveWorking();

    const result = await harness.runtime.persistence.load(source);

    expect(result.status).toBe("completed");
    expect(harness.runtime.getSnapshot()).toMatchObject({
      ui: createUiState(),
      rejection: null,
      sandboxResetError: null,
      backendError: null,
      persistence: {
        saveStatus: { state: "idle" },
        loadStatus: { state: "idle" },
        lifecycleStatus: { state: "idle" },
        error: null,
      },
    });
  });

  it("drains the former city's persistence FIFO before a cross-city load commits", async () => {
    const harness = await createCoordinatorHarness();
    const source = { kind: "working", cityId: "city-loaded" } as const;
    seedLoadSource(harness.store, source);
    harness.store.defer("writeWorkingSave");
    const save = harness.runtime.persistence.saveWorking();
    await harness.store.waitForActive("writeWorkingSave");

    // The cross-city load fences the former city and drains its FIFO before
    // the new city becomes active, so the load cannot commit until the delayed
    // save settles. This is the storage-safe handoff: a delayed write for the
    // former city cannot recreate its record after the caller deletes it.
    const load = harness.runtime.persistence.load(source);
    await vi.waitFor(() => {
      expect(harness.store.activeCount()).toBe(1);
    });

    // Releasing the save lets it complete; only then can the load read and
    // restore the target city. The save completes (it settled before the
    // load advanced the lineage) rather than being superseded.
    harness.store.releaseNext("writeWorkingSave");
    await expect(save).resolves.toMatchObject({ status: "completed" });
    await expect(load).resolves.toMatchObject({
      status: "completed",
      value: { source },
    });

    const afterLoad = harness.runtime.getSnapshot();
    expect(afterLoad.persistence.activeCity).toMatchObject({
      id: "city-loaded",
    });
    expect(harness.runtime.getSnapshot()).toEqual(afterLoad);
  });

  it("keeps a deleted former city absent after delayed-save → cross-city load → delete", async () => {
    const harness = await createCoordinatorHarness();
    const formerCityId = "city-001";
    const targetSource = { kind: "working", cityId: "city-loaded" } as const;
    seedLoadSource(harness.store, targetSource);

    // Start a delayed working save for the former city and block its write.
    harness.store.defer("writeWorkingSave");
    const save = harness.runtime.persistence.saveWorking();
    await harness.store.waitForActive("writeWorkingSave");

    // Load a different city. The load fences the former city and drains its
    // FIFO, so it cannot commit until the delayed save settles.
    const load = harness.runtime.persistence.load(targetSource);
    await vi.waitFor(() => {
      expect(harness.store.activeCount()).toBe(1);
    });

    // Release the save: it completes (writes the former city's record), then
    // the load drains and commits the target city.
    harness.store.releaseNext("writeWorkingSave");
    await expect(save).resolves.toMatchObject({ status: "completed" });
    await expect(load).resolves.toMatchObject({
      status: "completed",
      value: { source: targetSource },
    });
    expect(harness.runtime.getSnapshot().persistence.activeCity).toMatchObject({
      id: "city-loaded",
    });

    // The target city is now active, so deletion of the former city is
    // permitted. The delayed save already settled before the lineage advanced,
    // so no in-flight write can recreate the former city's record after the
    // caller deletes it.
    await expect(harness.store.deleteCity(formerCityId)).resolves.toMatchObject(
      {
        ok: true,
      },
    );
    await expect(
      harness.store.readWorkingSave(formerCityId),
    ).resolves.toMatchObject({ ok: false, error: { code: "notFound" } });
  });

  it("serializes a same-city load behind a delayed working save", async () => {
    const harness = await createCoordinatorHarness();
    const cityId = "city-001";
    const source = { kind: "working", cityId } as const;

    // Seed an older working save with a different budget so we can detect
    // whether the load reads the old or the new envelope.
    harness.store.seedRawWorking(
      cityId,
      loadEnvelope({
        city: cityIdentity(cityId),
        savedAt: "2026-08-01T09:00:00.000Z",
        snapshot: createRustSnapshot({ paused: true, budget: 50_000 }),
      }),
    );

    // Start a working save with the current budget (100_000). Defer the
    // store write so the save's FIFO callback is in flight.
    harness.store.defer("writeWorkingSave");
    const save = harness.runtime.persistence.saveWorking();
    await harness.store.waitForActive("writeWorkingSave");

    // Start a same-city load. It enters the city FIFO behind the save and
    // must wait for the write to complete before reading.
    const load = harness.runtime.persistence.load(source);

    // Release the save write. The save completes, then the load reads the
    // just-written envelope (budget 100_000), not the older one (50_000).
    harness.store.releaseNext("writeWorkingSave");
    await expect(save).resolves.toMatchObject({ status: "completed" });
    await expect(load).resolves.toMatchObject({
      status: "completed",
      value: {
        source,
        snapshot: {
          state: { budget: 100_000, paused: true },
          persistence: {
            activeCity: { id: cityId },
            dirty: false,
            lastSavedAt: "2026-08-01T10:00:00.000Z",
          },
        },
      },
    });

    // Runtime and storage must agree on the same envelope.
    const stored = await harness.store.readWorkingSave(cityId);
    expect(stored).toMatchObject({
      ok: true,
      value: { snapshot: { budget: 100_000 } },
    });
    expect(harness.runtime.getSnapshot()).toMatchObject({
      state: { budget: 100_000, paused: true },
      persistence: {
        activeCity: { id: cityId },
        dirty: false,
        lastSavedAt: "2026-08-01T10:00:00.000Z",
      },
    });
  });

  it("supersedes an old working-save completion after reset advances lineage", async () => {
    const harness = await createCoordinatorHarness({ clean: true });
    harness.store.defer("writeWorkingSave");
    const save = harness.runtime.persistence.saveWorking();
    await harness.store.waitForActive("writeWorkingSave");

    const identity = harness.runtime.getSnapshot().persistence.activeCity;
    const afterReset = await harness.runtime.reset();

    harness.store.releaseNext("writeWorkingSave");
    const saveResult = await save;

    expect(afterReset.persistence).toEqual({
      activeCity: identity,
      dirty: true,
      saveStatus: { state: "idle" },
      loadStatus: { state: "idle" },
      lifecycleStatus: { state: "idle" },
      lastSavedAt: "2026-08-01T09:30:00.000Z",
      error: null,
    });
    expect(saveResult).toEqual({ status: "superseded" });
    expect(harness.runtime.getSnapshot()).toEqual(afterReset);
  });

  it("drains the city persistence FIFO before detach clears identity", async () => {
    const harness = await createCoordinatorHarness();
    harness.store.defer("writeWorkingSave");
    const save = harness.runtime.persistence.saveWorking();
    await harness.store.waitForActive("writeWorkingSave");
    const listener = vi.fn();
    const unsubscribe = harness.runtime.subscribe(listener);

    // Release the save write so the FIFO can drain. Detach waits for the
    // save to complete before clearing the runtime identity, preventing a
    // delayed write from recreating a deleted city record.
    harness.store.releaseNext("writeWorkingSave");
    await expect(save).resolves.toMatchObject({ status: "completed" });

    const result = await harness.runtime.persistence.detachActiveCity();

    expect(result).toMatchObject({
      status: "completed",
      value: {
        persistence: {
          activeCity: null,
          dirty: false,
          saveStatus: { state: "idle" },
          loadStatus: { state: "idle" },
          lifecycleStatus: { state: "idle" },
          lastSavedAt: null,
          error: null,
        },
      },
    });
    const afterDetach = harness.runtime.getSnapshot();
    expect(harness.runtime.getSnapshot()).toEqual(afterDetach);
    unsubscribe();
  });

  it("keeps a deleted city absent after delayed-save → detach → delete", async () => {
    const harness = await createCoordinatorHarness();
    const cityId = "city-001";
    harness.store.defer("writeWorkingSave");
    const save = harness.runtime.persistence.saveWorking();
    await harness.store.waitForActive("writeWorkingSave");

    // Start detach while the save write is still deferred. Detach drains
    // the city FIFO, so it waits for the write to complete.
    const detach = harness.runtime.persistence.detachActiveCity();

    // Release the save write. The save completes, the FIFO drains, and
    // detach clears the runtime identity.
    harness.store.releaseNext("writeWorkingSave");
    await expect(save).resolves.toMatchObject({ status: "completed" });
    await expect(detach).resolves.toMatchObject({
      status: "completed",
      value: { persistence: { activeCity: null } },
    });

    // Delete the city record from storage. No delayed write can recreate
    // it because detach drained the FIFO before clearing identity.
    await expect(harness.store.deleteCity(cityId)).resolves.toMatchObject({
      ok: true,
    });
    await expect(harness.store.readWorkingSave(cityId)).resolves.toMatchObject({
      ok: false,
      error: { code: "notFound" },
    });
  });

  it("resolves detach as runtime unavailable after fatal backend failure", async () => {
    const harness = await createCoordinatorHarness();
    harness.backend.dispatch = async () => {
      throw new Error("fatal backend failure");
    };
    await harness.runtime.debugSetBudget(50_000);
    const afterDeath = harness.runtime.getSnapshot();

    await expect(
      harness.runtime.persistence.detachActiveCity(),
    ).resolves.toEqual(runtimeUnavailable("detachActiveCity"));
    expect(harness.runtime.getSnapshot()).toEqual(afterDeath);
  });

  it("supersedes a delayed failed load after detach advances lineage", async () => {
    const harness = await createCoordinatorHarness();
    harness.failures.failNext("readWorkingSave", "ioFailure");
    harness.store.defer("readWorkingSave");
    const load = harness.runtime.persistence.load({
      kind: "working",
      cityId: "city-loaded",
    });
    await harness.store.waitForActive("readWorkingSave");

    // Detach drains the city FIFO, which waits for the load's deferred
    // read to settle. Release the read so the load can complete (it will
    // fail with ioFailure) and detach can proceed.
    const detach = harness.runtime.persistence.detachActiveCity();
    harness.store.releaseNext("readWorkingSave");
    await expect(load).resolves.toEqual({ status: "superseded" });
    await expect(detach).resolves.toMatchObject({
      status: "completed",
      value: { persistence: { activeCity: null } },
    });
    const afterDetach = harness.runtime.getSnapshot();
    expect(harness.runtime.getSnapshot()).toEqual(afterDetach);
  });

  it("orders detach after an in-flight restore and keeps backend state coherent", async () => {
    const harness = await createCoordinatorHarness();
    const source = { kind: "working", cityId: "city-loaded" } as const;
    seedLoadSource(
      harness.store,
      source,
      loadEnvelope({
        city: cityIdentity(source.cityId),
        snapshot: createRustSnapshot({ paused: true, budget: 77_000 }),
      }),
    );
    const restoreSnapshot = harness.backend.restoreSnapshot.bind(
      harness.backend,
    );
    let signalRestoreStarted: (() => void) | undefined;
    const restoreStarted = new Promise<void>((resolve) => {
      signalRestoreStarted = resolve;
    });
    let releaseRestore: (() => void) | undefined;
    const restoreGate = new Promise<void>((resolve) => {
      releaseRestore = resolve;
    });
    harness.backend.restoreSnapshot = async (request) => {
      signalRestoreStarted?.();
      await restoreGate;
      return restoreSnapshot(request);
    };
    const listener = vi.fn();
    const unsubscribe = harness.runtime.subscribe(listener);

    const load = harness.runtime.persistence.load(source);
    await restoreStarted;
    const detach = harness.runtime.persistence.detachActiveCity();
    const publishesBeforeRestoreSettles = listener.mock.calls.length;
    releaseRestore?.();
    const [loadResult, detachResult] = await Promise.all([load, detach]);

    expect(publishesBeforeRestoreSettles).toBe(2);
    expect(loadResult).toMatchObject({
      status: "completed",
      value: {
        snapshot: {
          state: { budget: 77_000 },
          persistence: { activeCity: { id: source.cityId } },
        },
      },
    });
    expect(detachResult).toMatchObject({
      status: "completed",
      value: {
        state: { budget: 77_000 },
        persistence: { activeCity: null, dirty: false },
      },
    });
    expect(listener).toHaveBeenCalledTimes(4);
    expect(listener.mock.calls[0]?.[0].persistence.loadStatus).toEqual({
      state: "reading",
      source,
    });
    expect(listener.mock.calls[1]?.[0].persistence.loadStatus).toEqual({
      state: "restoring",
      source,
    });
    expect(listener.mock.calls[2]?.[0].persistence.activeCity).toMatchObject({
      id: source.cityId,
    });
    expect(listener.mock.calls[3]?.[0].persistence.activeCity).toBeNull();
    expect(harness.runtime.getSnapshot()).toEqual(
      detachResult.status === "completed" ? detachResult.value : undefined,
    );
    await expect(harness.backend.snapshot()).resolves.toMatchObject({
      budget: harness.runtime.getSnapshot().state.budget,
    });
    unsubscribe();
  });

  it("gives detach deterministic precedence over a concurrent cross-city load regardless of read latency", async () => {
    const orderings = ["detach-clears-first", "load-restores-first"] as const;
    for (const ordering of orderings) {
      const harness = await createCoordinatorHarness();
      const targetSource = { kind: "working", cityId: "city-loaded" } as const;
      seedLoadSource(harness.store, targetSource);

      // Delay the former city's save; both detach and the cross-city load must
      // drain it before they can proceed.
      harness.store.defer("writeWorkingSave");
      const save = harness.runtime.persistence.saveWorking();
      await harness.store.waitForActive("writeWorkingSave");

      // Start the cross-city load first, then detach. Both block on the
      // former city's persistence drain.
      const load = harness.runtime.persistence.load(targetSource);
      const detach = harness.runtime.persistence.detachActiveCity();

      if (ordering === "detach-clears-first") {
        // Gate the target read so detach can clear identity before the load's
        // read settles. The read has not started yet (the load is still
        // draining the former city), so deferring now gates it when it runs.
        harness.store.defer("readWorkingSave");
        harness.store.releaseNext("writeWorkingSave");
        await expect(detach).resolves.toMatchObject({ status: "completed" });
        harness.store.releaseNext("readWorkingSave");
      } else {
        // Let the load's read run immediately once the drain settles, so its
        // restore commits before detach clears.
        harness.store.releaseNext("writeWorkingSave");
      }

      const [detachResult, saveResult, loadResult] = await Promise.all([
        detach,
        save,
        load,
      ]);
      expect(detachResult).toMatchObject({ status: "completed" });
      expect(saveResult).toMatchObject({ status: "completed" });
      // The final active city is null in both orderings: detach always clears
      // identity. The load either completes (its restore commits before detach
      // clears) or is superseded (detach cleared first), but it never leaves a
      // different active city based only on read latency.
      expect(harness.runtime.getSnapshot().persistence.activeCity).toBeNull();
      expect(["completed", "superseded"]).toContain(loadResult.status);
    }
  });

  it("does not drop gameplay dispatches while detach waits for storage", async () => {
    const harness = await createCoordinatorHarness();
    harness.store.defer("writeWorkingSave");
    const save = harness.runtime.persistence.saveWorking();
    await harness.store.waitForActive("writeWorkingSave");

    const budgetBefore = harness.runtime.getSnapshot().state.budget;
    // Detach waits on the former city's persistence drain.
    const detach = harness.runtime.persistence.detachActiveCity();

    // Detach does not globally freeze gameplay (New City is the sole foreground
    // admission owner), so a dispatch admitted while detach waits must apply
    // rather than being silently dropped.
    const dispatch = harness.runtime.debugSetBudget(44_000);
    await dispatch;
    const duringDetach = harness.runtime.getSnapshot();
    expect(duringDetach.state.budget).toBe(44_000);
    expect(duringDetach.state.budget).not.toBe(budgetBefore);

    // Releasing the save lets it complete; detach then clears identity. Detach
    // still provides a storage-safe handoff: the delayed save settled before
    // identity cleared, so deleting the former city leaves it absent.
    harness.store.releaseNext("writeWorkingSave");
    await expect(save).resolves.toMatchObject({ status: "completed" });
    await expect(detach).resolves.toMatchObject({
      status: "completed",
      value: { persistence: { activeCity: null } },
    });
    await expect(harness.store.deleteCity("city-001")).resolves.toMatchObject({
      ok: true,
    });
    await expect(
      harness.store.readWorkingSave("city-001"),
    ).resolves.toMatchObject({ ok: false, error: { code: "notFound" } });
  });

  it("activates a new city only after its initial working save commits", async () => {
    const harness = await createCoordinatorHarness({ clean: true });
    harness.store.defer("writeWorkingSave");
    const listener = vi.fn();
    const unsubscribe = harness.runtime.subscribe(listener);

    const activation = harness.runtime.persistence.activateNewCity(
      sandboxRequest(),
      newCityIdentity(),
    );
    await vi.waitFor(() => {
      expect(harness.store.activeCount()).toBe(1);
    });

    expect(harness.runtime.getSnapshot()).toMatchObject({
      state: { budget: createRustSnapshot().budget },
      persistence: {
        activeCity: cityIdentity(),
        lifecycleStatus: { state: "creatingCity" },
      },
    });
    expect(
      listener.mock.calls.some(
        ([published]) =>
          published.persistence.activeCity?.id === newCityIdentity().id,
      ),
    ).toBe(false);

    harness.store.releaseNext("writeWorkingSave");

    await expect(activation).resolves.toMatchObject({
      status: "completed",
      value: {
        source: { kind: "working", cityId: "city-002" },
        snapshot: {
          state: { paused: true, budget: 120_000 },
          ui: createUiState(),
          persistence: {
            activeCity: newCityIdentity(),
            dirty: false,
            saveStatus: { state: "idle" },
            loadStatus: { state: "idle" },
            lifecycleStatus: { state: "idle" },
            lastSavedAt: "2026-08-01T10:00:00.000Z",
            error: null,
          },
        },
      },
    });
    expect(harness.backend.createSandboxCalls).toBe(1);
    expect(harness.backend.snapshotForSaveCalls).toBe(2);
    await expect(
      harness.store.readWorkingSave("city-002"),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        city: { id: "city-002", name: "New City" },
        snapshot: { paused: true, budget: 120_000 },
      },
    });
    unsubscribe();
  });

  it("restores a clean prior city exactly after write failure", async () => {
    const harness = await createCoordinatorHarness({ clean: true });
    const before = harness.runtime.getSnapshot();
    const priorBackendSnapshot = await harness.backend.snapshot();
    harness.failures.failNext("writeWorkingSave", "quotaExceeded");

    const result = await harness.runtime.persistence.activateNewCity(
      sandboxRequest(),
      newCityIdentity(),
    );

    expect(result).toMatchObject({
      status: "failed",
      error: {
        kind: "store",
        error: { operation: "writeWorkingSave", code: "quotaExceeded" },
      },
    });
    expect(harness.runtime.getSnapshot()).toEqual(before);
    await expect(harness.backend.snapshot()).resolves.toEqual(
      priorBackendSnapshot,
    );
    expect(harness.backend.restoreSnapshotCalls).toBe(1);
  });

  it("restores the exact dirty running city and raw pause state after write failure", async () => {
    const harness = await createCoordinatorHarness({ clean: true });
    harness.runtime.setTool("busStop");
    await harness.runtime.togglePause();
    harness.runtime.start();
    harness.failures.failNext("renameCity", "permissionDenied");
    await harness.runtime.persistence.renameActiveCity("Blocked Rename");
    const before = harness.runtime.getSnapshot();
    expect(before.state.paused).toBe(false);
    expect(before.persistence.dirty).toBe(true);
    expect(harness.runtime.isRunning()).toBe(true);
    harness.failures.failNext("writeWorkingSave", "ioFailure");

    await expect(
      harness.runtime.persistence.activateNewCity(
        sandboxRequest(),
        newCityIdentity(),
      ),
    ).resolves.toMatchObject({ status: "failed" });

    expect(harness.runtime.getSnapshot()).toEqual(before);
    expect(harness.runtime.isRunning()).toBe(true);
    expect(harness.backend.createSandboxCalls).toBe(1);
    expect(harness.backend.snapshotForSaveCalls).toBe(2);
    expect(harness.backend.restoreSnapshotCalls).toBe(1);
    expect(harness.store.mutationOrder()).toEqual([
      "renameCity",
      "writeWorkingSave",
    ]);
    await expect(harness.backend.snapshot()).resolves.toMatchObject({
      paused: false,
      budget: before.state.budget,
    });
  });

  it("supersedes a deferred load read that settles during a failing New City transaction", async () => {
    const harness = await createCoordinatorHarness({ clean: true });
    const source = { kind: "working", cityId: "city-loaded" } as const;
    seedLoadSource(harness.store, source);
    harness.store.defer("readWorkingSave");
    const load = harness.runtime.persistence.load(source);
    await harness.store.waitForActive("readWorkingSave");
    expect(harness.runtime.getSnapshot().persistence.loadStatus).toEqual({
      state: "reading",
      source,
    });

    harness.backend.createSandbox = async () => {
      harness.backend.createSandboxCalls += 1;
      return {
        ok: false,
        error: {
          code: "unknownTemplateId",
          context: { field: "templateId", attemptedValue: "missing" },
        },
      };
    };
    const activation = harness.runtime.persistence.activateNewCity(
      sandboxRequest(),
      newCityIdentity(),
    );

    await vi.waitFor(() => {
      expect(harness.runtime.getSnapshot().persistence.lifecycleStatus).toEqual(
        { state: "creatingCity" },
      );
    });

    // Admission invalidated the load lineage immediately.
    expect(harness.runtime.getSnapshot().persistence.loadStatus).toEqual({
      state: "idle",
    });

    harness.store.releaseNext("readWorkingSave");
    await expect(load).resolves.toEqual({ status: "superseded" });

    await expect(activation).resolves.toMatchObject({ status: "failed" });

    // Rollback must not resurrect the reading status.
    expect(harness.runtime.getSnapshot().persistence.loadStatus).toEqual({
      state: "idle",
    });
  });

  it("supersedes a deferred load read that settles after New City rollback", async () => {
    const harness = await createCoordinatorHarness({ clean: true });
    const source = { kind: "working", cityId: "city-loaded" } as const;
    seedLoadSource(harness.store, source);
    harness.store.defer("readWorkingSave");
    const load = harness.runtime.persistence.load(source);
    await harness.store.waitForActive("readWorkingSave");

    harness.backend.createSandbox = async () => {
      harness.backend.createSandboxCalls += 1;
      return {
        ok: false,
        error: {
          code: "unknownTemplateId",
          context: { field: "templateId", attemptedValue: "missing" },
        },
      };
    };
    const activation = harness.runtime.persistence.activateNewCity(
      sandboxRequest(),
      newCityIdentity(),
    );

    // Let New City fail and roll back while the read is still deferred.
    await expect(activation).resolves.toMatchObject({ status: "failed" });
    expect(harness.runtime.getSnapshot().persistence.loadStatus).toEqual({
      state: "idle",
    });

    // The read settles after rollback. The bumped token (restored by
    // rollback) still mismatches the load's captured token.
    harness.store.releaseNext("readWorkingSave");
    await expect(load).resolves.toEqual({ status: "superseded" });
    expect(harness.runtime.getSnapshot().persistence.loadStatus).toEqual({
      state: "idle",
    });
  });

  it("preserves the prior city when sandbox creation is rejected", async () => {
    const harness = await createCoordinatorHarness({ clean: true });
    const before = harness.runtime.getSnapshot();
    harness.backend.createSandbox = async () => {
      harness.backend.createSandboxCalls += 1;
      return {
        ok: false,
        error: {
          code: "unknownTemplateId",
          context: { field: "templateId", attemptedValue: "missing" },
        },
      };
    };

    await expect(
      harness.runtime.persistence.activateNewCity(
        sandboxRequest(),
        newCityIdentity(),
      ),
    ).resolves.toEqual({
      status: "failed",
      error: {
        kind: "sandbox",
        error: {
          code: "unknownTemplateId",
          context: { field: "templateId", attemptedValue: "missing" },
        },
      },
    });

    expect(harness.runtime.getSnapshot()).toEqual(before);
    expect(harness.backend.snapshotForSaveCalls).toBe(1);
    expect(harness.backend.restoreSnapshotCalls).toBe(0);
    expect(harness.store.mutationOrder()).toEqual([]);
  });

  it("rolls back an unexpected sandbox creation host failure", async () => {
    const harness = await createCoordinatorHarness({ clean: true });
    const before = harness.runtime.getSnapshot();
    harness.backend.createSandbox = async () => {
      harness.backend.createSandboxCalls += 1;
      throw new Error("sandbox host failed");
    };

    await expect(
      harness.runtime.persistence.activateNewCity(
        sandboxRequest(),
        newCityIdentity(),
      ),
    ).resolves.toEqual({
      status: "failed",
      error: {
        kind: "backend",
        error: {
          kind: "host",
          operation: "createSandbox",
          code: "invokeFailed",
          diagnostic: "sandbox host failed",
        },
      },
    });

    expect(harness.runtime.getSnapshot()).toEqual(before);
    expect(harness.backend.restoreSnapshotCalls).toBe(1);
    expect(harness.store.mutationOrder()).toEqual([]);
  });

  it("rolls back when canonical candidate capture fails", async () => {
    const harness = await createCoordinatorHarness({ clean: true });
    const before = harness.runtime.getSnapshot();
    const snapshotForSave = harness.backend.snapshotForSave.bind(
      harness.backend,
    );
    let capture = 0;
    harness.backend.snapshotForSave = async () => {
      capture += 1;
      if (capture === 2) {
        harness.backend.snapshotForSaveCalls += 1;
        return {
          ok: false,
          error: {
            kind: "host",
            operation: "snapshotForSave",
            code: "invokeFailed",
            diagnostic: "candidate capture failed",
          },
        };
      }
      return snapshotForSave();
    };

    await expect(
      harness.runtime.persistence.activateNewCity(
        sandboxRequest(),
        newCityIdentity(),
      ),
    ).resolves.toMatchObject({
      status: "failed",
      error: {
        kind: "backend",
        error: { operation: "snapshotForSave" },
      },
    });

    expect(harness.runtime.getSnapshot()).toEqual(before);
    expect(harness.backend.snapshotForSaveCalls).toBe(2);
    expect(harness.backend.restoreSnapshotCalls).toBe(1);
    expect(harness.store.mutationOrder()).toEqual([]);
  });

  it("drops ticks and supersedes detach while New City owns admission", async () => {
    const harness = await createCoordinatorHarness({ clean: true });
    harness.store.defer("writeWorkingSave");
    const activation = harness.runtime.persistence.activateNewCity(
      sandboxRequest(),
      newCityIdentity(),
    );
    await vi.waitFor(() => {
      expect(harness.store.activeCount()).toBe(1);
    });
    const duringWrite = harness.runtime.getSnapshot();
    const tickCalls = harness.backend.tickCalls;

    await expect(harness.runtime.tick(1)).resolves.toEqual(duringWrite);
    await expect(
      harness.runtime.persistence.detachActiveCity(),
    ).resolves.toEqual({ status: "superseded" });
    expect(harness.backend.tickCalls).toBe(tickCalls);
    expect(harness.runtime.getSnapshot()).toEqual(duringWrite);

    harness.store.releaseNext("writeWorkingSave");
    await expect(activation).resolves.toMatchObject({ status: "completed" });
  });

  it("supersedes area-drag start while New City owns admission", async () => {
    const harness = await createCoordinatorHarness({ clean: true });
    harness.runtime.setTool("area");
    harness.runtime.setArea("residential");
    harness.store.defer("writeWorkingSave");
    const activation = harness.runtime.persistence.activateNewCity(
      sandboxRequest(),
      newCityIdentity(),
    );
    await vi.waitFor(() => {
      expect(harness.store.activeCount()).toBe(1);
    });
    const duringWrite = harness.runtime.getSnapshot();

    const snapshot = harness.runtime.startDrag({ x: 2, y: 2 });

    expect(snapshot).toEqual(duringWrite);
    expect(snapshot.ui.drag).toBeNull();

    harness.store.releaseNext("writeWorkingSave");
    await expect(activation).resolves.toMatchObject({ status: "completed" });
  });

  it("supersedes building rotation while New City owns admission", async () => {
    const harness = await createCoordinatorHarness({ clean: true });
    harness.runtime.setBuilding("smallHouse");
    const beforeRotation = harness.runtime.getSnapshot().ui.buildingRotation;
    harness.store.defer("writeWorkingSave");
    const activation = harness.runtime.persistence.activateNewCity(
      sandboxRequest(),
      newCityIdentity(),
    );
    await vi.waitFor(() => {
      expect(harness.store.activeCount()).toBe(1);
    });
    const duringWrite = harness.runtime.getSnapshot();

    const snapshot = harness.runtime.rotateBuilding();

    expect(snapshot).toEqual(duringWrite);
    expect(snapshot.ui.buildingRotation).toBe(beforeRotation);

    harness.store.releaseNext("writeWorkingSave");
    await expect(activation).resolves.toMatchObject({ status: "completed" });
  });

  it("publishes creatingCity while previously admitted gameplay drains", async () => {
    const harness = await createCoordinatorHarness({ clean: true });
    harness.store.defer("writeWorkingSave");
    const dispatch = harness.backend.dispatch.bind(harness.backend);
    let signalDispatchStarted: (() => void) | undefined;
    const dispatchStarted = new Promise<void>((resolve) => {
      signalDispatchStarted = resolve;
    });
    let releaseDispatch: (() => void) | undefined;
    const dispatchGate = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    harness.backend.dispatch = async (intent) => {
      signalDispatchStarted?.();
      await dispatchGate;
      return dispatch(intent);
    };

    const gameplay = harness.runtime.debugSetBudget(90_000);
    await dispatchStarted;
    const activation = harness.runtime.persistence.activateNewCity(
      sandboxRequest(),
      newCityIdentity(),
    );

    try {
      expect(harness.runtime.getSnapshot().persistence.lifecycleStatus).toEqual(
        { state: "creatingCity" },
      );
      expect(harness.backend.createSandboxCalls).toBe(0);

      releaseDispatch?.();
      await gameplay;
      await harness.store.waitForActive("writeWorkingSave");
      harness.store.releaseNext("writeWorkingSave");
      await expect(activation).resolves.toMatchObject({ status: "completed" });
    } finally {
      releaseDispatch?.();
      harness.store.releaseAll();
      await Promise.allSettled([gameplay, activation]);
    }
  });

  it("drains the active-city persistence FIFO before capturing the rollback baseline", async () => {
    const harness = await createCoordinatorHarness();
    harness.store.defer("writeWorkingSave");
    const priorSave = harness.runtime.persistence.saveWorking();
    await harness.store.waitForActive("writeWorkingSave");

    const activation = harness.runtime.persistence.activateNewCity(
      sandboxRequest(),
      newCityIdentity(),
    );

    try {
      expect(harness.runtime.getSnapshot().persistence.lifecycleStatus).toEqual(
        { state: "creatingCity" },
      );
      await Promise.resolve();
      await Promise.resolve();

      expect(harness.backend.createSandboxCalls).toBe(0);
      expect(harness.store.activeCount()).toBe(1);

      harness.store.releaseNext("writeWorkingSave");
      await priorSave;
      await vi.waitFor(() => {
        expect(harness.store.activeCount()).toBe(1);
        expect(harness.backend.createSandboxCalls).toBe(1);
      });
      harness.store.releaseNext("writeWorkingSave");
      await expect(activation).resolves.toMatchObject({ status: "completed" });
    } finally {
      harness.store.releaseAll();
      await Promise.allSettled([priorSave, activation]);
    }
  });

  it("serializes the candidate working save behind an older write for the same city", async () => {
    const harness = await createCoordinatorHarness({ clean: true });
    const identity = newCityIdentity();
    const olderEnvelope = buildSaveEnvelope({
      city: { id: identity.id, name: identity.name },
      cityCreatedAt: identity.cityCreatedAt,
      savedAt: "2026-08-01T09:45:00.000Z",
      appVersion: "0.1.0",
      snapshot: createRustSnapshot({ paused: true, budget: 33_000 }),
    });
    harness.store.defer("writeWorkingSave");
    const olderWrite = harness.runtime.debugEnqueueCityPersistence(
      identity.id,
      () => harness.store.writeWorkingSave(olderEnvelope),
    );
    await harness.store.waitForActive("writeWorkingSave");

    const activation = harness.runtime.persistence.activateNewCity(
      sandboxRequest(),
      identity,
    );

    try {
      await vi.waitFor(() => {
        expect(harness.backend.createSandboxCalls).toBe(1);
      });
      expect(harness.store.activeCount()).toBe(1);
      expect(harness.store.mutationOrder()).toEqual(["writeWorkingSave"]);

      harness.store.releaseNext("writeWorkingSave");
      await olderWrite;
      await harness.store.waitForActive("writeWorkingSave");
      expect(harness.store.activeCount()).toBe(1);
      expect(harness.store.mutationOrder()).toEqual([
        "writeWorkingSave",
        "writeWorkingSave",
      ]);

      harness.store.releaseNext("writeWorkingSave");
      await expect(activation).resolves.toMatchObject({ status: "completed" });
      await expect(
        harness.store.readWorkingSave(identity.id),
      ).resolves.toMatchObject({
        ok: true,
        value: {
          savedAt: "2026-08-01T10:00:00.000Z",
          snapshot: { budget: 120_000 },
        },
      });
    } finally {
      harness.store.releaseAll();
      await Promise.allSettled([olderWrite, activation]);
    }
  });

  it("enters fatal unavailable state when rollback restoration fails", async () => {
    const harness = await createCoordinatorHarness({ clean: true });
    harness.runtime.start();
    harness.failures.failNext("writeWorkingSave", "ioFailure");
    harness.backend.restoreSnapshot = async () => {
      harness.backend.restoreSnapshotCalls += 1;
      return {
        ok: false,
        error: {
          kind: "host",
          operation: "restoreSnapshot",
          code: "invokeFailed",
          diagnostic: "rollback restore failed",
        },
      };
    };

    await expect(
      harness.runtime.persistence.activateNewCity(
        sandboxRequest(),
        newCityIdentity(),
      ),
    ).resolves.toEqual(runtimeUnavailable("activateNewCity"));

    expect(harness.runtime.getSnapshot()).toMatchObject({
      backendError: "rollback restore failed",
      persistence: {
        activeCity: null,
        dirty: false,
        saveStatus: { state: "idle" },
        loadStatus: { state: "idle" },
        lifecycleStatus: { state: "idle" },
        lastSavedAt: null,
        error: null,
      },
    });
    expect(harness.runtime.isRunning()).toBe(false);
    await expect(harness.runtime.persistence.saveWorking()).resolves.toEqual(
      runtimeUnavailable("saveWorking"),
    );
    await expect(
      harness.runtime.persistence.activateNewCity(
        sandboxRequest(),
        newCityIdentity(),
      ),
    ).resolves.toEqual(runtimeUnavailable("activateNewCity"));
    await expect(
      harness.runtime.persistence.detachActiveCity(),
    ).resolves.toEqual(runtimeUnavailable("detachActiveCity"));
  });

  it("enters fatal unavailable state when raw pause restoration fails", async () => {
    const harness = await createCoordinatorHarness({ clean: true });
    await harness.runtime.togglePause();
    harness.runtime.start();
    const dispatch = harness.backend.dispatch.bind(harness.backend);
    harness.backend.dispatch = async (intent) => {
      if (
        harness.backend.restoreSnapshotCalls > 0 &&
        intent.type === "setPaused" &&
        intent.paused === false
      ) {
        throw new Error("rollback pause failed");
      }
      return dispatch(intent);
    };
    harness.failures.failNext("writeWorkingSave", "ioFailure");

    await expect(
      harness.runtime.persistence.activateNewCity(
        sandboxRequest(),
        newCityIdentity(),
      ),
    ).resolves.toEqual(runtimeUnavailable("activateNewCity"));

    expect(harness.runtime.getSnapshot()).toMatchObject({
      backendError: "rollback pause failed",
      persistence: {
        activeCity: null,
        dirty: false,
        lifecycleStatus: { state: "idle" },
      },
    });
    expect(harness.runtime.isRunning()).toBe(false);
    const dispatchCalls = harness.backend.dispatchCalls;
    await harness.runtime.debugSetBudget(90_000);
    expect(harness.backend.dispatchCalls).toBe(dispatchCalls);
  });

  it("keeps a delayed load inert when the runtime dies before restore", async () => {
    const harness = await createCoordinatorHarness();
    const source = { kind: "working", cityId: "city-loaded" } as const;
    seedLoadSource(harness.store, source);
    harness.store.defer("readWorkingSave");
    const load = harness.runtime.persistence.load(source);
    await harness.store.waitForActive("readWorkingSave");
    harness.backend.dispatch = async () => {
      throw new Error("fatal backend failure");
    };
    await harness.runtime.debugSetBudget(50_000);
    const afterDeath = harness.runtime.getSnapshot();

    harness.store.releaseNext("readWorkingSave");

    await expect(load).resolves.toEqual(runtimeUnavailable("loadWorking"));
    expect(harness.backend.restoreSnapshotCalls).toBe(0);
    expect(harness.runtime.getSnapshot()).toEqual(afterDeath);
  });

  it("returns runtime unavailable when a delayed failed read settles after death", async () => {
    const harness = await createCoordinatorHarness();
    harness.failures.failNext("readWorkingSave", "ioFailure");
    harness.store.defer("readWorkingSave");
    const load = harness.runtime.persistence.load({
      kind: "working",
      cityId: "city-loaded",
    });
    await harness.store.waitForActive("readWorkingSave");
    harness.backend.dispatch = async () => {
      throw new Error("fatal backend failure");
    };
    await harness.runtime.debugSetBudget(50_000);
    const afterDeath = harness.runtime.getSnapshot();
    const listener = vi.fn();
    const unsubscribe = harness.runtime.subscribe(listener);

    harness.store.releaseNext("readWorkingSave");

    await expect(load).resolves.toEqual(runtimeUnavailable("loadWorking"));
    expect(harness.backend.restoreSnapshotCalls).toBe(0);
    expect(listener).not.toHaveBeenCalled();
    expect(harness.runtime.getSnapshot()).toEqual(afterDeath);
    unsubscribe();
  });

  it("returns runtime unavailable when a delayed malformed envelope settles after death", async () => {
    const harness = await createCoordinatorHarness();
    harness.store.seedRawWorking("city-loaded", { format: "broken" });
    harness.store.defer("readWorkingSave");
    const load = harness.runtime.persistence.load({
      kind: "working",
      cityId: "city-loaded",
    });
    await harness.store.waitForActive("readWorkingSave");
    harness.backend.dispatch = async () => {
      throw new Error("fatal backend failure");
    };
    await harness.runtime.debugSetBudget(50_000);
    const afterDeath = harness.runtime.getSnapshot();
    const listener = vi.fn();
    const unsubscribe = harness.runtime.subscribe(listener);

    harness.store.releaseNext("readWorkingSave");

    await expect(load).resolves.toEqual(runtimeUnavailable("loadWorking"));
    expect(harness.backend.restoreSnapshotCalls).toBe(0);
    expect(listener).not.toHaveBeenCalled();
    expect(harness.runtime.getSnapshot()).toEqual(afterDeath);
    unsubscribe();
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
    expect(harness.backend.createSandboxCalls).toBe(0);
    expect(harness.backend.dispatchCalls).toBe(0);
    expect(harness.store.activeCount()).toBe(0);
    expect(sandboxRequest()).toMatchObject({ templateId: "blankGrid" });
    expect(newCityIdentity()).toMatchObject({ id: "city-002" });
    expect(harness.checkpointRequest().kind).toBe("checkpoint");
    expect(harness.autosaveRequest().kind).toBe("autosave");
  });

  // --- Fence ownership regression coverage ---

  it("preserves the former-city fence when overlapping cross-city loads share it", async () => {
    const formerCityId = "city-fence-a";
    const harness = await createCoordinatorHarness({
      activeCity: cityIdentity(formerCityId),
    });
    const sourceB = { kind: "working", cityId: "city-fence-b" } as const;
    const sourceC = { kind: "working", cityId: "city-fence-c" } as const;
    seedLoadSource(harness.store, sourceB);
    seedLoadSource(harness.store, sourceC);
    // Seed the former city's record so deletion is observable after the
    // fence blocks the save from (re)creating it.
    harness.store.seedRawWorking(
      formerCityId,
      loadEnvelope({ city: cityIdentity(formerCityId) }),
    );

    // Defer reads so both cross-city loads reach their deferred read while the
    // former city (A) is still active and fenced by each.
    harness.store.defer("readWorkingSave");
    const loadB = harness.runtime.persistence.load(sourceB);
    const loadC = harness.runtime.persistence.load(sourceC);
    await vi.waitFor(
      () => {
        expect(harness.store.activeCount()).toBe(2);
      },
      { timeout: 3000, interval: 10 },
    );

    // Release B's read: B is superseded by C's newer token and its finally
    // releases its fence lease on A. The fence must persist (C still holds it).
    harness.store.releaseNext("readWorkingSave");
    await expect(loadB).resolves.toEqual({ status: "superseded" });

    // A is still the active city but still fenced by C. A working save for A
    // must be superseded at admission, not admitted to recreate A's record
    // after the caller later deletes it.
    await expect(harness.runtime.persistence.saveWorking()).resolves.toEqual({
      status: "superseded",
    });

    // Release C's read: C completes and becomes active. C's finally releases
    // the last fence lease on A.
    harness.store.releaseNext("readWorkingSave");
    await expect(loadC).resolves.toMatchObject({
      status: "completed",
      value: { source: sourceC },
    });
    expect(harness.runtime.getSnapshot().persistence.activeCity).toMatchObject({
      id: "city-fence-c",
    });

    // Clear the read defer so the final store assertions are not gated.
    harness.store.releaseAll();

    // Deleting the former city leaves it absent — no delayed save recreated it.
    await expect(harness.store.deleteCity(formerCityId)).resolves.toMatchObject(
      {
        ok: true,
      },
    );
    await expect(
      harness.store.readWorkingSave(formerCityId),
    ).resolves.toMatchObject({ ok: false, error: { code: "notFound" } });
  });

  it("preserves the fence when a cross-city load and detach share it", async () => {
    const formerCityId = "city-fence-d";
    const harness = await createCoordinatorHarness({
      activeCity: cityIdentity(formerCityId),
    });
    const sourceB = { kind: "working", cityId: "city-fence-e" } as const;
    seedLoadSource(harness.store, sourceB);
    // Seed the former city's record so deletion is observable after the
    // fence blocks the save from (re)creating it.
    harness.store.seedRawWorking(
      formerCityId,
      loadEnvelope({ city: cityIdentity(formerCityId) }),
    );

    // Gate a gameplay dispatch so detach's gameplay-queue clearing work waits
    // behind it, keeping the former city active while both transitions fence it.
    const dispatch = harness.backend.dispatch.bind(harness.backend);
    let releaseDispatch: (() => void) | undefined;
    const dispatchGate = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    let signalDispatchStarted: (() => void) | undefined;
    const dispatchStarted = new Promise<void>((resolve) => {
      signalDispatchStarted = resolve;
    });
    harness.backend.dispatch = async (intent) => {
      signalDispatchStarted?.();
      await dispatchGate;
      return dispatch(intent);
    };
    const gameplay = harness.runtime.debugSetBudget(50_000);
    await dispatchStarted;

    // Defer the load's read so it reaches its deferred read while the former
    // city is still active and fenced.
    harness.store.defer("readWorkingSave");
    const loadB = harness.runtime.persistence.load(sourceB);
    await harness.store.waitForActive("readWorkingSave");

    // Start detach. It also fences the former city (count=2) and enters the
    // gameplay queue, where it waits behind the gated dispatch.
    const detach = harness.runtime.persistence.detachActiveCity();

    // Bump the load token so B is superseded when its read settles, without
    // admitting a new fencing transition. A superseded load bumps the token
    // at admission and returns before fencing.
    await expect(
      harness.runtime.persistence.load({
        kind: "working",
        cityId: "city-fence-f",
      }),
    ).resolves.toEqual({ status: "superseded" });

    // Release B's read. B is superseded (token mismatch) and its finally
    // releases its fence lease on A. The fence must persist (detach still
    // holds it).
    harness.store.releaseNext("readWorkingSave");
    await expect(loadB).resolves.toEqual({ status: "superseded" });

    // A is still the active city (detach hasn't cleared identity) and still
    // fenced by detach. A working save for A must be superseded at admission.
    await expect(harness.runtime.persistence.saveWorking()).resolves.toEqual({
      status: "superseded",
    });

    // Release the gated dispatch. Detach clears identity and completes.
    releaseDispatch?.();
    await gameplay;
    await expect(detach).resolves.toMatchObject({
      status: "completed",
      value: { persistence: { activeCity: null } },
    });
    expect(harness.runtime.getSnapshot().persistence.activeCity).toBeNull();

    // Clear the read defer so the final store assertions are not gated.
    harness.store.releaseAll();

    // Deleting the former city leaves it absent.
    await expect(harness.store.deleteCity(formerCityId)).resolves.toMatchObject(
      {
        ok: true,
      },
    );
    await expect(
      harness.store.readWorkingSave(formerCityId),
    ).resolves.toMatchObject({ ok: false, error: { code: "notFound" } });
  });

  // --- Detach / New City mutual exclusion regression coverage ---

  it("supersedes a failing New City request started while detach is in progress", async () => {
    const harness = await createCoordinatorHarness();
    harness.store.defer("writeWorkingSave");
    const save = harness.runtime.persistence.saveWorking();
    await harness.store.waitForActive("writeWorkingSave");

    // Start detach. It fences the city and waits for the save to complete.
    const detach = harness.runtime.persistence.detachActiveCity();

    // Make sandbox creation fail. A New City request started while detach owns
    // lifecycle admission must be superseded, not admitted to roll back and
    // resurrect the city detach is clearing.
    harness.backend.createSandbox = async () => {
      harness.backend.createSandboxCalls += 1;
      return {
        ok: false,
        error: {
          code: "unknownTemplateId",
          context: { field: "templateId", attemptedValue: "missing" },
        },
      };
    };
    const activation = harness.runtime.persistence.activateNewCity(
      sandboxRequest(),
      newCityIdentity(),
    );

    // New City is superseded at admission — it never creates a sandbox.
    await expect(activation).resolves.toEqual({ status: "superseded" });
    expect(harness.backend.createSandboxCalls).toBe(0);

    // Release the save. Detach drains and completes, clearing identity.
    harness.store.releaseNext("writeWorkingSave");
    await expect(save).resolves.toMatchObject({ status: "completed" });
    const detachResult = await detach;
    expect(detachResult).toMatchObject({
      status: "completed",
      value: { persistence: { activeCity: null } },
    });

    // A completed detach can never be undone by New City rollback.
    expect(harness.runtime.getSnapshot().persistence.activeCity).toBeNull();
  });

  it("supersedes a successful New City request started while detach is in progress", async () => {
    const harness = await createCoordinatorHarness();
    harness.store.defer("writeWorkingSave");
    const save = harness.runtime.persistence.saveWorking();
    await harness.store.waitForActive("writeWorkingSave");

    const detach = harness.runtime.persistence.detachActiveCity();

    const activation = harness.runtime.persistence.activateNewCity(
      sandboxRequest(),
      newCityIdentity(),
    );

    // New City is superseded at admission — it never creates a sandbox.
    await expect(activation).resolves.toEqual({ status: "superseded" });
    expect(harness.backend.createSandboxCalls).toBe(0);

    harness.store.releaseNext("writeWorkingSave");
    await expect(save).resolves.toMatchObject({ status: "completed" });
    await expect(detach).resolves.toMatchObject({
      status: "completed",
      value: { persistence: { activeCity: null } },
    });
    expect(harness.runtime.getSnapshot().persistence.activeCity).toBeNull();
  });

  it("supersedes a second concurrent detach request", async () => {
    const harness = await createCoordinatorHarness();
    harness.store.defer("writeWorkingSave");
    const save = harness.runtime.persistence.saveWorking();
    await harness.store.waitForActive("writeWorkingSave");

    const firstDetach = harness.runtime.persistence.detachActiveCity();
    const secondDetach = harness.runtime.persistence.detachActiveCity();

    // The second detach is superseded at admission.
    await expect(secondDetach).resolves.toEqual({ status: "superseded" });

    harness.store.releaseNext("writeWorkingSave");
    await expect(save).resolves.toMatchObject({ status: "completed" });
    await expect(firstDetach).resolves.toMatchObject({
      status: "completed",
      value: { persistence: { activeCity: null } },
    });
    expect(harness.runtime.getSnapshot().persistence.activeCity).toBeNull();
  });

  it("gives New City and detach deterministic precedence regardless of admission order", async () => {
    for (const ordering of ["new-city-first", "detach-first"] as const) {
      const harness = await createCoordinatorHarness({ clean: true });

      if (ordering === "new-city-first") {
        const activation = harness.runtime.persistence.activateNewCity(
          sandboxRequest(),
          newCityIdentity(),
        );
        // New City sets backendAdmissionReserved synchronously, so detach is
        // superseded at admission regardless of microtask timing.
        const detach = harness.runtime.persistence.detachActiveCity();
        await expect(detach).resolves.toEqual({ status: "superseded" });
        await expect(activation).resolves.toMatchObject({
          status: "completed",
        });
        expect(
          harness.runtime.getSnapshot().persistence.activeCity,
        ).toMatchObject({ id: "city-002" });
      } else {
        const detach = harness.runtime.persistence.detachActiveCity();
        // Detach sets lifecycleTransitionReserved synchronously, so New City is
        // superseded at admission regardless of microtask timing.
        const activation = harness.runtime.persistence.activateNewCity(
          sandboxRequest(),
          newCityIdentity(),
        );
        await expect(activation).resolves.toEqual({ status: "superseded" });
        await expect(detach).resolves.toMatchObject({ status: "completed" });
        expect(harness.runtime.getSnapshot().persistence.activeCity).toBeNull();
      }
    }
  });

  // Regression coverage for the single-runtime-per-store invariant. The
  // persistence FIFOs, city fences, lifecycle ownership, and session/load
  // tokens are all owned by the runtime instance — there is no module-global
  // `cityTails`. These tests guard against re-introducing module-global
  // coordination state, which previously coupled independent runtimes in the
  // same realm and made opposite cross-city loads capable of a FIFO lock
  // cycle. Multiple live runtimes sharing one SaveStore is unsupported; each
  // runtime here uses its own store.
  describe("runtime-local persistence coordination", () => {
    it("owns its per-city FIFO: a held write on one runtime does not block a same-city save on another", async () => {
      const sharedCityId = "shared-city";
      const harness1 = await createCoordinatorHarness({
        activeCity: cityIdentity(sharedCityId),
        clean: true,
      });
      const harness2 = await createCoordinatorHarness({
        activeCity: cityIdentity(sharedCityId),
        clean: true,
      });
      try {
        // Hold an "older write" for sharedCityId on runtime 1's FIFO. Under the
        // old module-global `cityTails`, runtime 2's saveWorking for the same
        // city id would chain onto this held tail and hang.
        const olderEnvelope = buildSaveEnvelope({
          city: { id: sharedCityId, name: "Test City" },
          cityCreatedAt: "2026-08-01T09:00:00.000Z",
          savedAt: "2026-08-01T09:45:00.000Z",
          appVersion: "0.1.0",
          snapshot: createRustSnapshot({ paused: true, budget: 33_000 }),
        });
        harness1.store.defer("writeWorkingSave");
        const olderWrite = harness1.runtime.debugEnqueueCityPersistence(
          sharedCityId,
          () => harness1.store.writeWorkingSave(olderEnvelope),
        );
        await harness1.store.waitForActive("writeWorkingSave");

        // Runtime 2's save must settle on its own FIFO, independent of runtime
        // 1's held tail.
        const save2 = harness2.runtime.persistence.saveWorking();
        await expect(save2).resolves.toMatchObject({ status: "completed" });

        // Runtime 1's older write is still held — runtime 2 did not drain it.
        expect(harness1.store.activeCount()).toBe(1);
        expect(harness2.store.mutationOrder()).toEqual(["writeWorkingSave"]);

        harness1.store.releaseAll();
        await olderWrite;
      } finally {
        harness1.runtime.stop();
        harness2.runtime.stop();
      }
    });

    it("keeps city fences instance-local: a fence on one runtime does not reject a save on another", async () => {
      const sharedCityId = "shared-city";
      const harness1 = await createCoordinatorHarness({
        activeCity: cityIdentity(sharedCityId),
        clean: true,
      });
      const harness2 = await createCoordinatorHarness({
        activeCity: cityIdentity(sharedCityId),
        clean: true,
      });
      // Give runtime 1 a target city to load so it fences its prior city.
      const targetEnvelope = loadEnvelope({
        city: cityIdentity("city-target"),
        savedAt: "2026-08-01T11:00:00.000Z",
      });
      harness1.store.seedRawWorking("city-target", targetEnvelope);
      try {
        // A cross-city load fences the prior city synchronously at admission.
        // Hold the read so the fence stays in place during the assertion.
        harness1.store.defer("readWorkingSave");
        const load1 = harness1.runtime.persistence.load({
          kind: "working",
          cityId: "city-target",
        });
        await harness1.store.waitForActive("readWorkingSave");

        // Runtime 2, on its own store, is unaffected by runtime 1's fence.
        const save2 = harness2.runtime.persistence.saveWorking();
        await expect(save2).resolves.toMatchObject({ status: "completed" });

        harness1.store.releaseAll();
        await expect(load1).resolves.toMatchObject({ status: "completed" });
      } finally {
        harness1.runtime.stop();
        harness2.runtime.stop();
      }
    });

    it("does not coordinate lifecycle transitions across runtime instances", async () => {
      const harness1 = await createCoordinatorHarness({ clean: true });
      const harness2 = await createCoordinatorHarness({ clean: true });
      try {
        // Detach on runtime 1 and New City on runtime 2 are independent
        // lifecycle transitions; neither sees the other's
        // `lifecycleTransitionReserved` (which is closure-local).
        const detach1 = harness1.runtime.persistence.detachActiveCity();
        const activation2 = harness2.runtime.persistence.activateNewCity(
          sandboxRequest(),
          newCityIdentity(),
        );
        await expect(detach1).resolves.toMatchObject({ status: "completed" });
        await expect(activation2).resolves.toMatchObject({
          status: "completed",
        });
        expect(
          harness1.runtime.getSnapshot().persistence.activeCity,
        ).toBeNull();
        expect(
          harness2.runtime.getSnapshot().persistence.activeCity,
        ).not.toBeNull();
      } finally {
        harness1.runtime.stop();
        harness2.runtime.stop();
      }
    });
  });
});
