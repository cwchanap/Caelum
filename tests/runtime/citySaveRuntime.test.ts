import { describe, expect, it, vi } from "vitest";
import {
  createMemoryCitySaveStore,
  createMemoryCitySaveStoreFailureControls,
} from "../../src/persistence/memoryCitySaveStore";
import type {
  CitySaveRecord,
  CitySaveStore,
  CitySaveStoreOperation,
} from "../../src/persistence/citySaveStore";
import type {
  DispatchResult,
  GameBackend,
  RustGameSnapshot,
} from "../../src/runtime/backend/types";
import { createGameRuntime } from "../../src/runtime/createGameRuntime";
import {
  createRustSnapshot,
  previewBackendStubs,
} from "../fixtures/rustSnapshot";
import { createDelayedCitySaveStore } from "./delayedCitySaveStore";

const ACTIVE_CITY = {
  id: "city-001",
  name: "Test City",
  createdAt: "2026-08-01T09:00:00.000Z",
};

const NEW_CITY = {
  id: "city-002",
  name: "New City",
  createdAt: "2026-08-01T10:00:00.000Z",
};

function record(
  city = ACTIVE_CITY,
  snapshot: RustGameSnapshot = createRustSnapshot({ paused: true }),
): CitySaveRecord {
  return {
    city,
    savedAt: "2026-08-01T09:30:00.000Z",
    snapshot,
  };
}

function backend(
  initial = createRustSnapshot({ paused: true }),
): GameBackend & {
  getBackendSnapshot(): RustGameSnapshot;
  failRestoreWith(error: unknown): void;
} {
  let current = initial;
  let restoreFailure: unknown = null;
  const base = previewBackendStubs();
  const result = (
    snapshot: RustGameSnapshot,
    applied: boolean,
  ): DispatchResult => ({
    snapshot,
    applied,
    rejection: null,
  });

  return {
    ...base,
    getBackendSnapshot: () => current,
    failRestoreWith(error) {
      restoreFailure = error;
    },
    async snapshot() {
      return current;
    },
    async dispatch(intent) {
      const before = current;
      if (intent.type === "setBudget")
        current = { ...current, budget: intent.budget };
      if (intent.type === "setPaused")
        current = { ...current, paused: intent.paused };
      return result(current, current !== before);
    },
    async tick() {
      return result(current, false);
    },
    async reset() {
      current = createRustSnapshot({ paused: true });
      return { ok: true, snapshot: current };
    },
    async buildSandboxSnapshot(request) {
      return base.buildSandboxSnapshot(request);
    },
    async snapshotForSave() {
      return { ok: true, snapshot: { ...current, paused: true } };
    },
    async restoreSnapshot(snapshot) {
      if (restoreFailure !== null) {
        const error = restoreFailure;
        restoreFailure = null;
        if (error instanceof Error) throw error;
        return { ok: false, error } as never;
      }
      current = snapshot as RustGameSnapshot;
      return { ok: true, snapshot: current };
    },
  };
}

async function runtimeWithStore(
  saveStore: CitySaveStore,
  options: {
    initialCity?: typeof ACTIVE_CITY | null;
    lastSavedAt?: string | null;
    backend?: ReturnType<typeof backend>;
    now?: () => string;
  } = {},
) {
  return createGameRuntime({
    backend: options.backend ?? backend(),
    saveStore,
    initialCity:
      options.initialCity === undefined ? ACTIVE_CITY : options.initialCity,
    lastSavedAt:
      options.lastSavedAt === undefined
        ? "2026-08-01T09:30:00.000Z"
        : options.lastSavedAt,
    now: options.now ?? (() => "2026-08-01T10:00:00.000Z"),
  });
}

// A runtime constructed with no CitySaveStore: every persistence mutation and
// load must report a clean `store` failure instead of crashing or silently
// no-op'ing. `now` is optional so the no-clock path can be exercised too.
async function runtimeWithoutStore(options: { now?: () => string } = {}) {
  return createGameRuntime({
    backend: backend(),
    initialCity: ACTIVE_CITY,
    lastSavedAt: "2026-08-01T09:30:00.000Z",
    ...(options.now ? { now: options.now } : {}),
  });
}

// A runtime with a store but no save-clock (`now`). saveWorking and
// activateNewCity both require a clock to stamp `savedAt`.
async function runtimeWithoutClock(saveStore: CitySaveStore) {
  return createGameRuntime({
    backend: backend(),
    saveStore,
    initialCity: ACTIVE_CITY,
    lastSavedAt: "2026-08-01T09:30:00.000Z",
  });
}

// Wraps a delegate store so the next call to `throwOn` rejects with an Error,
// exercising the runtime's catch-and-report path for a throwing adapter. All
// other operations delegate unchanged.
function throwingCitySaveStore(
  throwOn: CitySaveStoreOperation,
  delegate: CitySaveStore = createMemoryCitySaveStore(),
): CitySaveStore {
  const throwFor = (op: CitySaveStoreOperation): void => {
    if (op === throwOn) throw new Error(`${op} threw`);
  };
  return {
    listCities: async () => {
      throwFor("listCities");
      return delegate.listCities();
    },
    readCity: async (id) => {
      throwFor("readCity");
      return delegate.readCity(id);
    },
    createCity: async (rec) => {
      throwFor("createCity");
      return delegate.createCity(rec);
    },
    updateCity: async (id, update) => {
      throwFor("updateCity");
      return delegate.updateCity(id, update);
    },
    renameCity: async (id, name) => {
      throwFor("renameCity");
      return delegate.renameCity(id, name);
    },
    deleteCity: async (id) => {
      throwFor("deleteCity");
      return delegate.deleteCity(id);
    },
  };
}

// A backend whose `restoreSnapshot` always throws, used to drive the
// rollback-coherence path where both the load restore and the rollback restore
// fail.
function backendWithAlwaysFailingRestore(): ReturnType<typeof backend> {
  const b = backend();
  Object.assign(b, {
    restoreSnapshot: async () => {
      throw new Error("restoreSnapshot always throws");
    },
  });
  return b;
}

const SANDBOX_REQUEST = {
  templateId: "blankGrid",
  economyPreset: "standard",
  startingCapital: 120_000,
  demandMultiplier: 1,
  moveInRate: "paused",
} as const;

describe("runtime city save store cutover", () => {
  it("saves an existing city with updateCity", async () => {
    const saveStore = createMemoryCitySaveStore();
    await saveStore.createCity(record());
    const createSpy = vi.spyOn(saveStore, "createCity");
    const updateSpy = vi.spyOn(saveStore, "updateCity");
    const runtime = await runtimeWithStore(saveStore);

    await runtime.debugSetBudget(90_000);
    const result = await runtime.persistence.saveWorking();

    expect(result).toMatchObject({ status: "completed" });
    expect(updateSpy).toHaveBeenCalledWith(
      ACTIVE_CITY.id,
      expect.objectContaining({ savedAt: "2026-08-01T10:00:00.000Z" }),
    );
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("does not create a missing city during Save Now", async () => {
    const saveStore = createMemoryCitySaveStore();
    const createSpy = vi.spyOn(saveStore, "createCity");
    const runtime = await runtimeWithStore(saveStore);

    const result = await runtime.persistence.saveWorking();

    expect(result).toMatchObject({
      status: "failed",
      error: {
        kind: "store",
        error: { operation: "updateCity", code: "notFound" },
      },
    });
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("preserves dirty state and storage after failed Save", async () => {
    const failures = createMemoryCitySaveStoreFailureControls();
    const saveStore = createMemoryCitySaveStore({ failures });
    await saveStore.createCity(record());
    const runtime = await runtimeWithStore(saveStore);
    await runtime.debugSetBudget(90_000);
    failures.failNext("updateCity", "failed");

    await expect(runtime.persistence.saveWorking()).resolves.toMatchObject({
      status: "failed",
      error: {
        kind: "store",
        error: { operation: "updateCity", code: "failed" },
      },
    });
    expect(runtime.getSnapshot().persistence.dirty).toBe(true);
    expect(await saveStore.readCity(ACTIVE_CITY.id)).toMatchObject({
      ok: true,
      value: { savedAt: "2026-08-01T09:30:00.000Z" },
    });
  });

  it("loads snapshot and publishes record identity and savedAt", async () => {
    const saveStore = createMemoryCitySaveStore();
    const loaded = record(
      {
        id: "city-loaded",
        name: "Loaded City",
        createdAt: "2026-08-01T08:00:00.000Z",
      },
      createRustSnapshot({ paused: true, budget: 77_000 }),
    );
    await saveStore.createCity(loaded);
    const runtime = await runtimeWithStore(saveStore);

    const result = await runtime.persistence.load(loaded.city.id);

    expect(result).toMatchObject({
      status: "completed",
      value: { cityId: loaded.city.id },
    });
    expect(runtime.getSnapshot()).toMatchObject({
      state: { budget: 77_000 },
      persistence: {
        activeCity: loaded.city,
        lastSavedAt: loaded.savedAt,
        dirty: false,
      },
    });
  });

  it("preserves current runtime after failed read", async () => {
    const failures = createMemoryCitySaveStoreFailureControls();
    const saveStore = createMemoryCitySaveStore({ failures });
    await saveStore.createCity(record());
    const runtime = await runtimeWithStore(saveStore);
    const before = runtime.getSnapshot();
    failures.failNext("readCity", "failed");

    await expect(
      runtime.persistence.load("city-missing"),
    ).resolves.toMatchObject({
      status: "failed",
      error: {
        kind: "store",
        error: { operation: "readCity", code: "failed" },
      },
    });
    const after = runtime.getSnapshot();
    expect(after.state).toBe(before.state);
    expect(after.ui).toBe(before.ui);
    expect(after.persistence.activeCity).toEqual(before.persistence.activeCity);
  });

  it("preserves current runtime after failed restore", async () => {
    const saveStore = createMemoryCitySaveStore();
    const loaded = record(
      {
        id: "city-loaded",
        name: "Loaded City",
        createdAt: "2026-08-01T08:00:00.000Z",
      },
      createRustSnapshot({ paused: true, budget: 77_000 }),
    );
    await saveStore.createCity(loaded);
    const targetBackend = backend();
    targetBackend.failRestoreWith({
      kind: "validation",
      operation: "restoreSnapshot",
    });
    const runtime = await runtimeWithStore(saveStore, {
      backend: targetBackend,
    });
    const before = runtime.getSnapshot();

    await expect(
      runtime.persistence.load(loaded.city.id),
    ).resolves.toMatchObject({
      status: "failed",
      error: { kind: "backend" },
    });
    expect(runtime.getSnapshot().state).toBe(before.state);
    expect(runtime.getSnapshot().persistence.activeCity).toEqual(
      before.persistence.activeCity,
    );
  });

  it("renames only active city metadata", async () => {
    const saveStore = createMemoryCitySaveStore();
    await saveStore.createCity(record());
    const renameSpy = vi.spyOn(saveStore, "renameCity");
    const runtime = await runtimeWithStore(saveStore);
    const beforeState = runtime.getSnapshot().state;

    await expect(
      runtime.persistence.renameActiveCity("Renamed City"),
    ).resolves.toMatchObject({
      status: "completed",
      value: { summary: { id: ACTIVE_CITY.id, name: "Renamed City" } },
    });
    expect(renameSpy).toHaveBeenCalledWith(ACTIVE_CITY.id, "Renamed City");
    expect(runtime.getSnapshot().persistence.activeCity).toMatchObject({
      id: ACTIVE_CITY.id,
      name: "Renamed City",
    });
    expect(runtime.getSnapshot().state).toBe(beforeState);
  });

  it("creates and activates a new city", async () => {
    const saveStore = createMemoryCitySaveStore();
    await saveStore.createCity(record());
    const runtime = await runtimeWithStore(saveStore);

    const result = await runtime.persistence.activateNewCity(
      {
        templateId: "blankGrid",
        economyPreset: "standard",
        startingCapital: 120_000,
        demandMultiplier: 1,
        moveInRate: "paused",
      },
      NEW_CITY,
    );

    expect(result).toMatchObject({
      status: "completed",
      value: { cityId: NEW_CITY.id },
    });
    expect(runtime.getSnapshot().persistence.activeCity).toEqual(NEW_CITY);
    expect(await saveStore.readCity(NEW_CITY.id)).toMatchObject({
      ok: true,
      value: { city: NEW_CITY },
    });
  });

  it("rolls back after create conflict", async () => {
    const saveStore = createMemoryCitySaveStore();
    await saveStore.createCity(record());
    await saveStore.createCity(record(NEW_CITY));
    const targetBackend = backend();
    const runtime = await runtimeWithStore(saveStore, {
      backend: targetBackend,
    });
    const before = runtime.getSnapshot();

    const result = await runtime.persistence.activateNewCity(
      {
        templateId: "blankGrid",
        economyPreset: "standard",
        startingCapital: 120_000,
        demandMultiplier: 1,
        moveInRate: "paused",
      },
      NEW_CITY,
    );

    expect(result).toMatchObject({
      status: "failed",
      error: {
        kind: "store",
        error: { operation: "createCity", code: "conflict" },
      },
    });
    expect(runtime.getSnapshot().persistence.activeCity).toEqual(
      before.persistence.activeCity,
    );
    expect(targetBackend.getBackendSnapshot()).toMatchObject({
      budget: before.state.budget,
      paused: before.state.paused,
      map: before.state.map,
      transit: before.state.transit,
    });
  });

  it("rolls back after definite create failure", async () => {
    const failures = createMemoryCitySaveStoreFailureControls();
    const saveStore = createMemoryCitySaveStore({ failures });
    await saveStore.createCity(record());
    const runtime = await runtimeWithStore(saveStore);
    const before = runtime.getSnapshot();
    failures.failNext("createCity", "failed");

    await expect(
      runtime.persistence.activateNewCity(
        {
          templateId: "blankGrid",
          economyPreset: "standard",
          startingCapital: 120_000,
          demandMultiplier: 1,
          moveInRate: "paused",
        },
        NEW_CITY,
      ),
    ).resolves.toMatchObject({
      status: "failed",
      error: {
        kind: "store",
        error: { operation: "createCity", code: "failed" },
      },
    });
    expect(runtime.getSnapshot().persistence.activeCity).toEqual(
      before.persistence.activeCity,
    );
  });

  it("keeps a city record when activation completes after disposal", async () => {
    const saveStore = createMemoryCitySaveStore();
    await saveStore.createCity(record());
    const delayed = createDelayedCitySaveStore(saveStore);
    delayed.defer("createCity");
    const runtime = await runtimeWithStore(delayed);
    const activation = runtime.persistence.activateNewCity(
      {
        templateId: "blankGrid",
        economyPreset: "standard",
        startingCapital: 120_000,
        demandMultiplier: 1,
        moveInRate: "paused",
      },
      NEW_CITY,
    );
    await delayed.waitForActive("createCity");
    const dispose = runtime.dispose();
    delayed.releaseNext("createCity");

    await expect(activation).resolves.toMatchObject({
      status: "failed",
      error: { kind: "precondition", error: { code: "runtimeUnavailable" } },
    });
    await expect(dispose).resolves.toBeUndefined();
    await expect(saveStore.readCity(NEW_CITY.id)).resolves.toMatchObject({
      ok: true,
      value: { city: NEW_CITY },
    });
  });
});

describe("runtime persistence error and cleanup paths", () => {
  describe("no CitySaveStore configured", () => {
    it("saveWorking reports a store failure with a no-store diagnostic", async () => {
      const runtime = await runtimeWithoutStore();

      await expect(runtime.persistence.saveWorking()).resolves.toMatchObject({
        status: "failed",
        error: {
          kind: "store",
          error: {
            operation: "updateCity",
            code: "failed",
            diagnostic: "No CitySaveStore is configured",
          },
        },
      });
    });

    it("load reports a readCity store failure", async () => {
      const runtime = await runtimeWithoutStore();

      await expect(runtime.persistence.load("city-1")).resolves.toMatchObject({
        status: "failed",
        error: {
          kind: "store",
          error: { operation: "readCity", code: "failed" },
        },
      });
    });

    it("activateNewCity reports a createCity store failure", async () => {
      const runtime = await runtimeWithoutStore();

      await expect(
        runtime.persistence.activateNewCity(SANDBOX_REQUEST, NEW_CITY),
      ).resolves.toMatchObject({
        status: "failed",
        error: {
          kind: "store",
          error: { operation: "createCity", code: "failed" },
        },
      });
    });

    it("renameActiveCity reports a renameCity store failure", async () => {
      const runtime = await runtimeWithoutStore();

      await expect(
        runtime.persistence.renameActiveCity("Renamed"),
      ).resolves.toMatchObject({
        status: "failed",
        error: {
          kind: "store",
          error: { operation: "renameCity", code: "failed" },
        },
      });
    });
  });

  describe("no save clock configured", () => {
    it("saveWorking reports a store failure with a no-clock diagnostic", async () => {
      const saveStore = createMemoryCitySaveStore();
      await saveStore.createCity(record());
      const runtime = await runtimeWithoutClock(saveStore);

      await expect(runtime.persistence.saveWorking()).resolves.toMatchObject({
        status: "failed",
        error: {
          kind: "store",
          error: {
            operation: "updateCity",
            code: "failed",
            cityId: ACTIVE_CITY.id,
            diagnostic: "Save clock is not configured",
          },
        },
      });
    });

    it("activateNewCity reports a store failure with a no-clock diagnostic", async () => {
      const saveStore = createMemoryCitySaveStore();
      await saveStore.createCity(record());
      const runtime = await runtimeWithoutClock(saveStore);

      await expect(
        runtime.persistence.activateNewCity(SANDBOX_REQUEST, NEW_CITY),
      ).resolves.toMatchObject({
        status: "failed",
        error: {
          kind: "store",
          error: {
            operation: "createCity",
            code: "failed",
            cityId: NEW_CITY.id,
            diagnostic: "Save clock is not configured",
          },
        },
      });
    });
  });

  describe("a throwing store adapter", () => {
    it("saveWorking reports an updateCity failure when updateCity rejects", async () => {
      const saveStore = throwingCitySaveStore("updateCity");
      await saveStore.createCity(record());
      const runtime = await runtimeWithStore(saveStore);

      await expect(runtime.persistence.saveWorking()).resolves.toMatchObject({
        status: "failed",
        error: {
          kind: "store",
          error: { operation: "updateCity", code: "failed" },
        },
      });
    });

    it("renameActiveCity reports a renameCity failure when renameCity rejects", async () => {
      const saveStore = throwingCitySaveStore("renameCity");
      await saveStore.createCity(record());
      const runtime = await runtimeWithStore(saveStore);

      await expect(
        runtime.persistence.renameActiveCity("Renamed"),
      ).resolves.toMatchObject({
        status: "failed",
        error: {
          kind: "store",
          error: { operation: "renameCity", code: "failed" },
        },
      });
    });

    it("load reports a readCity failure when readCity rejects", async () => {
      const saveStore = throwingCitySaveStore("readCity");
      await saveStore.createCity(record());
      const runtime = await runtimeWithStore(saveStore);

      await expect(
        runtime.persistence.load(ACTIVE_CITY.id),
      ).resolves.toMatchObject({
        status: "failed",
        error: {
          kind: "store",
          error: { operation: "readCity", code: "failed" },
        },
      });
    });

    it("activateNewCity rolls back when createCity rejects", async () => {
      const base = createMemoryCitySaveStore();
      await base.createCity(record());
      const saveStore = throwingCitySaveStore("createCity", base);
      const runtime = await runtimeWithStore(saveStore);
      const before = runtime.getSnapshot();

      await expect(
        runtime.persistence.activateNewCity(SANDBOX_REQUEST, NEW_CITY),
      ).resolves.toMatchObject({
        status: "failed",
        error: {
          kind: "store",
          error: { operation: "createCity", code: "failed" },
        },
      });
      // The prior active city is restored.
      expect(runtime.getSnapshot().persistence.activeCity).toEqual(
        before.persistence.activeCity,
      );
    });
  });

  describe("a throwing save clock", () => {
    it("saveWorking reports a store failure when now() rejects", async () => {
      const saveStore = createMemoryCitySaveStore();
      await saveStore.createCity(record());
      const runtime = await runtimeWithStore(saveStore, {
        now: () => {
          throw new Error("clock threw");
        },
      });

      await expect(runtime.persistence.saveWorking()).resolves.toMatchObject({
        status: "failed",
        error: {
          kind: "store",
          error: {
            operation: "updateCity",
            code: "failed",
            diagnostic: "clock threw",
          },
        },
      });
    });

    it("activateNewCity rolls back when now() rejects", async () => {
      const saveStore = createMemoryCitySaveStore();
      await saveStore.createCity(record());
      const runtime = await runtimeWithStore(saveStore, {
        now: () => {
          throw new Error("clock threw");
        },
      });
      const before = runtime.getSnapshot();

      await expect(
        runtime.persistence.activateNewCity(SANDBOX_REQUEST, NEW_CITY),
      ).resolves.toMatchObject({
        status: "failed",
        error: {
          kind: "store",
          error: {
            operation: "createCity",
            code: "failed",
            diagnostic: "clock threw",
          },
        },
      });
      expect(runtime.getSnapshot().persistence.activeCity).toEqual(
        before.persistence.activeCity,
      );
    });
  });

  describe("disposal and dead-runtime paths", () => {
    it("a second dispose awaits the drain and resolves", async () => {
      const saveStore = createMemoryCitySaveStore();
      await saveStore.createCity(record());
      const runtime = await runtimeWithStore(saveStore);

      await runtime.dispose();
      // A second dispose hits the already-dead branch and still resolves.
      await expect(runtime.dispose()).resolves.toBeUndefined();
    });

    it("load after dispose reports runtimeUnavailable", async () => {
      const saveStore = createMemoryCitySaveStore();
      await saveStore.createCity(record());
      const runtime = await runtimeWithStore(saveStore);

      await runtime.dispose();

      await expect(
        runtime.persistence.load(ACTIVE_CITY.id),
      ).resolves.toMatchObject({
        status: "failed",
        error: {
          kind: "precondition",
          error: { code: "runtimeUnavailable", operation: "loadCity" },
        },
      });
    });

    it("load resolves runtimeUnavailable when disposal completes during the read", async () => {
      const saveStore = createMemoryCitySaveStore();
      await saveStore.createCity(record());
      const delayed = createDelayedCitySaveStore(saveStore);
      delayed.defer("readCity");
      const runtime = await runtimeWithStore(delayed);

      const loadPromise = runtime.persistence.load(ACTIVE_CITY.id);
      await delayed.waitForActive("readCity");
      const disposePromise = runtime.dispose();
      delayed.releaseNext("readCity");

      await expect(loadPromise).resolves.toMatchObject({
        status: "failed",
        error: {
          kind: "precondition",
          error: { code: "runtimeUnavailable", operation: "loadCity" },
        },
      });
      await disposePromise;
    });
  });

  describe("load rollback coherence", () => {
    it("goes terminal when the load restore and the rollback restore both throw", async () => {
      const saveStore = createMemoryCitySaveStore();
      await saveStore.createCity(record());
      const runtime = await runtimeWithStore(saveStore, {
        backend: backendWithAlwaysFailingRestore(),
      });

      await expect(
        runtime.persistence.load(ACTIVE_CITY.id),
      ).resolves.toMatchObject({
        status: "failed",
        error: {
          kind: "precondition",
          error: { code: "runtimeUnavailable", operation: "loadCity" },
        },
      });
      // The runtime is terminal after a fatal rollback-coherence failure.
      expect(runtime.getSnapshot().backendError).not.toBe(null);
    });
  });
});
