import { describe, expect, it, vi } from "vitest";
import {
  createMemoryCitySaveStore,
  createMemoryCitySaveStoreFailureControls,
} from "../../src/persistence/memoryCitySaveStore";
import type {
  CitySaveRecord,
  CitySaveStore,
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
    context: { changedTiles: [], skippedTiles: [], cost: 0 },
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
    async createSandbox(request) {
      const created = await base.createSandbox(request);
      if (created.ok) current = created.snapshot;
      return created;
    },
    async snapshotForSave() {
      return { ok: true, snapshot: { ...current, paused: true } };
    },
    async restoreSnapshot(request) {
      if (restoreFailure !== null) {
        const error = restoreFailure;
        restoreFailure = null;
        if (error instanceof Error) throw error;
        return { ok: false, error } as never;
      }
      current = request.snapshot as RustGameSnapshot;
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

  it("does not publish a create that completes after disposal", async () => {
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
      ok: false,
      error: { code: "notFound" },
    });
  });

  it("releases disposal when late-create cleanup fails", async () => {
    const failures = createMemoryCitySaveStoreFailureControls();
    const saveStore = createMemoryCitySaveStore({ failures });
    await saveStore.createCity(record());
    const delayed = createDelayedCitySaveStore(saveStore);
    delayed.defer("createCity");
    delayed.defer("deleteCity");
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
    await delayed.waitForActive("deleteCity");

    failures.failNext("deleteCity", "failed");
    delayed.releaseNext("deleteCity");

    await expect(activation).resolves.toMatchObject({
      status: "failed",
      error: { kind: "store", error: { operation: "deleteCity" } },
    });
    await expect(dispose).resolves.toBeUndefined();
  });
});
