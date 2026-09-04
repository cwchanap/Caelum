import { describe, expect, it, vi } from "vitest";
import type {
  CitySaveStore,
  CitySummary,
} from "../../src/persistence/citySaveStore";
import {
  createMemoryCitySaveStore,
  createMemoryCitySaveStoreFailureControls,
} from "../../src/persistence/memoryCitySaveStore";
import type {
  GameBackend,
  PresentationUpdate,
  RestoreResult,
  RustGameSnapshot,
} from "../../src/runtime/backend/types";
import type { SnapshotError } from "../../src/runtime/backend/persistenceContract";
import { createGameRuntime } from "../../src/runtime/createGameRuntime";
import {
  createPresentationUpdate,
  createRustSnapshot,
  previewBackendStubs,
} from "../fixtures/rustSnapshot";
import { createDelayedCitySaveStore } from "./delayedCitySaveStore";
import { record, seed } from "../fixtures/citySave";

const ACTIVE_CITY: CitySummary = {
  id: "city-001",
  name: "Test City",
  createdAt: "2026-08-08T09:00:00.000Z",
  savedAt: "2026-08-08T09:30:00.000Z",
};

const OTHER_CITY: CitySummary = {
  id: "city-002",
  name: "Other City",
  createdAt: "2026-08-08T08:00:00.000Z",
  savedAt: "2026-08-08T09:45:00.000Z",
};

const LOADED_CITY: CitySummary = {
  id: "city-loaded",
  name: "Loaded City",
  createdAt: "2026-08-08T07:00:00.000Z",
  savedAt: "2026-08-08T09:15:00.000Z",
};

interface TestBackend extends GameBackend {
  setRestoreOutcome(
    outcome:
      | { ok: true; update: PresentationUpdate }
      | { ok: false; error: SnapshotError }
      | Error
      | null,
  ): void;
}

function backend(initial = createRustSnapshot({ paused: true })): TestBackend {
  const stubs = previewBackendStubs();
  let current = initial;
  let restoreOutcome:
    | Awaited<ReturnType<GameBackend["restoreSnapshot"]>>
    | Error
    | null = null;
  const dispatchResult = (applied: boolean) => ({
    update: createPresentationUpdate(current, applied),
    applied,
    rejection: null,
  });

  return {
    ...stubs,
    setRestoreOutcome(outcome) {
      restoreOutcome = outcome;
    },
    async dispatch(intent) {
      const before = current;
      if (intent.type === "setBudget") {
        current = { ...current, budget: intent.budget };
      }
      return dispatchResult(current !== before);
    },
    async tick() {
      return dispatchResult(false);
    },
    async reset() {
      current = createRustSnapshot({ paused: true });
      return { ok: true, update: createPresentationUpdate(current) };
    },
    async snapshotForSave() {
      return { ok: true, snapshot: { ...current, paused: true } };
    },
    async restoreSnapshot(snapshot): Promise<RestoreResult> {
      if (restoreOutcome instanceof Error) throw restoreOutcome;
      if (restoreOutcome !== null) return restoreOutcome;
      current = snapshot as RustGameSnapshot;
      return { ok: true, update: createPresentationUpdate(current) };
    },
  };
}

async function runtimeWithStore(
  saveStore: CitySaveStore,
  options: {
    backend?: TestBackend;
    initialCity?: CitySummary | null;
  } = {},
) {
  return createGameRuntime({
    backend: options.backend ?? backend(),
    saveStore,
    initialCity:
      options.initialCity === undefined ? ACTIVE_CITY : options.initialCity,
    now: () => "2026-08-08T10:00:00.000Z",
    createCityId: () => "city-new",
  });
}

describe("runtime working-save integration", () => {
  it("lists empty and populated city libraries through the runtime", async () => {
    const emptyStore = createMemoryCitySaveStore();
    const emptyRuntime = await runtimeWithStore(emptyStore);

    await expect(emptyRuntime.persistence.listCities()).resolves.toEqual({
      ok: true,
      value: [],
    });

    const populatedStore = createMemoryCitySaveStore();
    await seed(populatedStore, record(ACTIVE_CITY));
    await seed(populatedStore, record(OTHER_CITY));
    const populatedRuntime = await runtimeWithStore(populatedStore);

    await expect(populatedRuntime.persistence.listCities()).resolves.toEqual({
      ok: true,
      value: [OTHER_CITY, ACTIVE_CITY],
    });
  });

  it("blocks road preview admission while Save is busy", async () => {
    const baseStore = createMemoryCitySaveStore();
    await seed(baseStore, record(ACTIVE_CITY));
    const saveStore = createDelayedCitySaveStore(baseStore);
    saveStore.defer("updateCity");
    const targetBackend = backend();
    const previewSpy = vi.spyOn(targetBackend, "previewRoadMutation");
    const runtime = await runtimeWithStore(saveStore, {
      backend: targetBackend,
    });

    const save = runtime.persistence.save();
    await saveStore.waitForActive("updateCity");

    expect(runtime.getSnapshot().persistence.busy).toBe(true);
    runtime.previewRoadMutation({ type: "layRoad", point: { x: 1, y: 1 } });

    expect(previewSpy).not.toHaveBeenCalled();
    expect(runtime.getSnapshot().ui.roadMutationPreview).toBeNull();

    saveStore.releaseNext("updateCity");
    await save;
  });

  it("saves a dirty active city and clears dirty only after the update", async () => {
    const store = createMemoryCitySaveStore();
    await seed(store, record(ACTIVE_CITY));
    const runtime = await runtimeWithStore(store);

    await runtime.debugSetBudget(90_000);
    expect(runtime.getSnapshot().persistence.dirty).toBe(true);

    await expect(runtime.persistence.save()).resolves.toMatchObject({
      ok: true,
      value: { id: ACTIVE_CITY.id, savedAt: "2026-08-08T10:00:00.000Z" },
    });
    expect(runtime.getSnapshot().persistence.dirty).toBe(false);
  });

  it("keeps a city dirty after a failed save", async () => {
    const failures = createMemoryCitySaveStoreFailureControls();
    const store = createMemoryCitySaveStore({ failures });
    await seed(store, record(ACTIVE_CITY));
    const runtime = await runtimeWithStore(store);
    await runtime.debugSetBudget(90_000);
    failures.failNext("updateCity", "failed");

    await expect(runtime.persistence.save()).resolves.toMatchObject({
      ok: false,
      error: { kind: "store", error: { operation: "updateCity" } },
    });
    expect(runtime.getSnapshot().persistence.dirty).toBe(true);
  });

  it("loads a stored city and leaves the active city intact on definite restore failure", async () => {
    const store = createMemoryCitySaveStore();
    const loadedSnapshot = createRustSnapshot({ paused: true, budget: 77_000 });
    await seed(store, record(LOADED_CITY, loadedSnapshot));
    const targetBackend = backend();
    const runtime = await runtimeWithStore(store, { backend: targetBackend });

    await expect(runtime.persistence.load(LOADED_CITY.id)).resolves.toEqual({
      ok: true,
      value: LOADED_CITY,
    });
    expect(runtime.getSnapshot()).toMatchObject({
      state: { budget: 77_000 },
      persistence: { activeCity: LOADED_CITY, dirty: false },
    });

    targetBackend.setRestoreOutcome({
      ok: false,
      error: { code: "invalidSnapshot" },
    });
    await expect(runtime.persistence.load(LOADED_CITY.id)).resolves.toEqual({
      ok: false,
      error: { kind: "backend", error: { code: "invalidSnapshot" } },
    });
    expect(runtime.getSnapshot().persistence.activeCity).toEqual(LOADED_CITY);
  });

  it("clears active identity after a thrown load restore and will not save the old city", async () => {
    const store = createMemoryCitySaveStore();
    await seed(store, record(ACTIVE_CITY));
    await seed(store, record(LOADED_CITY));
    const targetBackend = backend();
    const updateSpy = vi.spyOn(store, "updateCity");
    const runtime = await runtimeWithStore(store, { backend: targetBackend });
    targetBackend.setRestoreOutcome(new Error("restore response was lost"));

    await expect(runtime.persistence.load(LOADED_CITY.id)).resolves.toEqual({
      ok: false,
      error: {
        kind: "backend",
        error: { code: "hostFailure", diagnostic: "restore response was lost" },
      },
    });
    expect(runtime.getSnapshot().persistence.activeCity).toBeNull();

    await expect(runtime.persistence.save()).resolves.toEqual({
      ok: false,
      error: { kind: "noActiveCity" },
    });
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("creates and activates a city storage-first", async () => {
    const store = createMemoryCitySaveStore();
    await seed(store, record(ACTIVE_CITY));
    const runtime = await runtimeWithStore(store);

    await expect(
      runtime.persistence.createCity({
        name: "New City",
        economyPreset: "standard",
        templateId: "crossroads",
      }),
    ).resolves.toEqual({
      ok: true,
      value: {
        id: "city-new",
        name: "New City",
        createdAt: "2026-08-08T10:00:00.000Z",
        savedAt: "2026-08-08T10:00:00.000Z",
      },
    });
    expect(runtime.getSnapshot().persistence.activeCity).toMatchObject({
      id: "city-new",
      name: "New City",
    });
    await expect(store.readCity("city-new")).resolves.toMatchObject({
      ok: true,
    });
  });

  it("keeps the current city after a create conflict or definite activation failure", async () => {
    const conflictStore = createMemoryCitySaveStore();
    await seed(conflictStore, record(ACTIVE_CITY));
    await seed(
      conflictStore,
      record({
        id: "city-new",
        name: "Existing City",
        createdAt: "2026-08-08T08:00:00.000Z",
        savedAt: "2026-08-08T08:30:00.000Z",
      }),
    );
    const conflictRuntime = await runtimeWithStore(conflictStore);

    await expect(
      conflictRuntime.persistence.createCity({
        name: "New City",
        economyPreset: "standard",
        templateId: "crossroads",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        kind: "store",
        error: { operation: "createCity", code: "conflict" },
      },
    });
    expect(conflictRuntime.getSnapshot().persistence.activeCity).toEqual(
      ACTIVE_CITY,
    );

    const activationStore = createMemoryCitySaveStore();
    await seed(activationStore, record(ACTIVE_CITY));
    const targetBackend = backend();
    targetBackend.setRestoreOutcome({
      ok: false,
      error: { code: "invalidSnapshot" },
    });
    const activationRuntime = await runtimeWithStore(activationStore, {
      backend: targetBackend,
    });

    await expect(
      activationRuntime.persistence.createCity({
        name: "New City",
        economyPreset: "standard",
        templateId: "crossroads",
      }),
    ).resolves.toEqual({
      ok: false,
      error: { kind: "backend", error: { code: "invalidSnapshot" } },
    });
    expect(activationRuntime.getSnapshot().persistence.activeCity).toEqual(
      ACTIVE_CITY,
    );
    await expect(activationStore.readCity("city-new")).resolves.toMatchObject({
      ok: true,
    });
  });

  it("retains a newly created record but clears active identity after a thrown activation", async () => {
    const store = createMemoryCitySaveStore();
    await seed(store, record(ACTIVE_CITY));
    const targetBackend = backend();
    targetBackend.setRestoreOutcome(new Error("new city restore was lost"));
    const runtime = await runtimeWithStore(store, { backend: targetBackend });

    await expect(
      runtime.persistence.createCity({
        name: "New City",
        economyPreset: "standard",
        templateId: "crossroads",
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        kind: "backend",
        error: { code: "hostFailure", diagnostic: "new city restore was lost" },
      },
    });
    await expect(store.readCity("city-new")).resolves.toMatchObject({
      ok: true,
    });
    expect(runtime.getSnapshot().persistence.activeCity).toBeNull();
  });

  it("renames active and inactive cities without coupling their identities", async () => {
    const store = createMemoryCitySaveStore();
    await seed(store, record(ACTIVE_CITY));
    await seed(store, record(OTHER_CITY));
    const runtime = await runtimeWithStore(store);

    await expect(
      runtime.persistence.renameCity(ACTIVE_CITY.id, "Renamed City"),
    ).resolves.toMatchObject({ ok: true, value: { name: "Renamed City" } });
    await expect(
      runtime.persistence.renameCity(OTHER_CITY.id, "Changed Other"),
    ).resolves.toMatchObject({ ok: true, value: { name: "Changed Other" } });
    expect(runtime.getSnapshot().persistence.activeCity).toMatchObject({
      id: ACTIVE_CITY.id,
      name: "Renamed City",
    });
  });

  it("deletes inactive and active cities with the active identity updated only for the latter", async () => {
    const store = createMemoryCitySaveStore();
    await seed(store, record(ACTIVE_CITY));
    await seed(store, record(OTHER_CITY));
    const runtime = await runtimeWithStore(store);

    await expect(
      runtime.persistence.deleteCity(OTHER_CITY.id),
    ).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    expect(runtime.getSnapshot().persistence.activeCity).toEqual(ACTIVE_CITY);

    await expect(
      runtime.persistence.deleteCity(ACTIVE_CITY.id),
    ).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    expect(runtime.getSnapshot().persistence.activeCity).toBeNull();
  });

  it("reports busy for a duplicate mutating action", async () => {
    const delegate = createMemoryCitySaveStore();
    await seed(delegate, record(ACTIVE_CITY));
    const store = createDelayedCitySaveStore(delegate);
    store.defer("updateCity");
    const runtime = await runtimeWithStore(store);

    const save = runtime.persistence.save();
    await store.waitForActive("updateCity");

    await expect(
      runtime.persistence.renameCity(ACTIVE_CITY.id, "Later"),
    ).resolves.toEqual({ ok: false, error: { kind: "busy" } });

    store.releaseNext("updateCity");
    await save;
  });

  it("does not publish after synchronous disposal while a load settles", async () => {
    const delegate = createMemoryCitySaveStore();
    await seed(delegate, record(LOADED_CITY));
    const store = createDelayedCitySaveStore(delegate);
    store.defer("readCity");
    const runtime = await runtimeWithStore(store);
    const listener = vi.fn();
    runtime.subscribe(listener);

    const load = runtime.persistence.load(LOADED_CITY.id);
    await store.waitForActive("readCity");
    listener.mockClear();
    runtime.dispose();
    store.releaseNext("readCity");

    await expect(load).resolves.toEqual({
      ok: false,
      error: { kind: "unavailable" },
    });
    expect(listener).not.toHaveBeenCalled();
  });
});
