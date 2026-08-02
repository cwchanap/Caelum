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

    const result = await harness.runtime.persistence.load({
      kind: "working",
      cityId: "other",
    });

    expect(result).toEqual({
      status: "failed",
      error: { kind: "envelope", error: { code: "corruptHeader" } },
    });
    expect(harness.backend.restoreSnapshotCalls).toBe(0);
    expect(harness.runtime.getSnapshot()).toEqual(before);
  });

  it("preserves runtime and dirty bookkeeping on a store read failure", async () => {
    const harness = await createCoordinatorHarness();
    harness.failures.failNext("readWorkingSave", "ioFailure");
    const before = harness.runtime.getSnapshot();

    const result = await harness.runtime.persistence.load({
      kind: "working",
      cityId: "other",
    });

    expect(result).toMatchObject({
      status: "failed",
      error: {
        kind: "store",
        error: { operation: "readWorkingSave", code: "ioFailure" },
      },
    });
    expect(harness.backend.restoreSnapshotCalls).toBe(0);
    expect(harness.runtime.getSnapshot()).toEqual(before);
  });

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
    expect(harness.store.activeCount()).toBe(2);

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
    expect(harness.runtime.getSnapshot()).toEqual(before);
  });

  it("commits a successful working load once, paused and clean", async () => {
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
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(
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

  it("supersedes an old working-save completion after load advances lineage", async () => {
    const harness = await createCoordinatorHarness();
    const source = { kind: "working", cityId: "city-loaded" } as const;
    seedLoadSource(harness.store, source);
    harness.store.defer("writeWorkingSave");
    const save = harness.runtime.persistence.saveWorking();
    await harness.store.waitForActive("writeWorkingSave");

    await expect(
      harness.runtime.persistence.load(source),
    ).resolves.toMatchObject({ status: "completed" });
    const afterLoad = harness.runtime.getSnapshot();
    harness.store.releaseNext("writeWorkingSave");

    await expect(save).resolves.toEqual({ status: "superseded" });
    expect(harness.runtime.getSnapshot()).toEqual(afterLoad);
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

  it("detaches once and leaves stale persistence completions inert", async () => {
    const harness = await createCoordinatorHarness();
    harness.store.defer("writeWorkingSave");
    const save = harness.runtime.persistence.saveWorking();
    await harness.store.waitForActive("writeWorkingSave");
    const listener = vi.fn();
    const unsubscribe = harness.runtime.subscribe(listener);

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
    expect(listener).toHaveBeenCalledTimes(1);
    const afterDetach = harness.runtime.getSnapshot();
    harness.store.releaseNext("writeWorkingSave");
    await expect(save).resolves.toEqual({ status: "superseded" });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(harness.runtime.getSnapshot()).toEqual(afterDetach);
    unsubscribe();
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

    await harness.runtime.persistence.detachActiveCity();
    const afterDetach = harness.runtime.getSnapshot();
    harness.store.releaseNext("readWorkingSave");

    await expect(load).resolves.toEqual({ status: "superseded" });
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

    expect(publishesBeforeRestoreSettles).toBe(0);
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
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener.mock.calls[0]?.[0].persistence.activeCity).toMatchObject({
      id: source.cityId,
    });
    expect(listener.mock.calls[1]?.[0].persistence.activeCity).toBeNull();
    expect(harness.runtime.getSnapshot()).toEqual(
      detachResult.status === "completed" ? detachResult.value : undefined,
    );
    await expect(harness.backend.snapshot()).resolves.toMatchObject({
      budget: harness.runtime.getSnapshot().state.budget,
    });
    unsubscribe();
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
    expect(harness.store.activeCount()).toBe(0);
    expect(sandboxRequest()).toMatchObject({ templateId: "blankGrid" });
    expect(newCityIdentity()).toMatchObject({ id: "city-002" });
    expect(harness.checkpointRequest().kind).toBe("checkpoint");
    expect(harness.autosaveRequest().kind).toBe("autosave");
  });
});
