import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  RoadMutationPreviewResponse,
  RustGameSnapshot,
} from "../../src/runtime/backend/types";
import type { SnapshotError } from "../../src/runtime/backend/persistenceContract";
import { createGameRuntime } from "../../src/runtime/createGameRuntime";
import { createFakeGameHost, lastFakeHost } from "../helpers/gameHost";
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
    createHost: createFakeGameHost,
    backend: options.backend ?? backend(),
    saveStore,
    initialCity:
      options.initialCity === undefined ? ACTIVE_CITY : options.initialCity,
    now: () => "2026-08-08T10:00:00.000Z",
    createCityId: () => "city-new",
  });
}

const AUTOSAVE_MS = 60_000;

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

async function advanceAutosave(): Promise<void> {
  await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
  await flushPromises();
}

async function seededRuntime() {
  const store = createMemoryCitySaveStore();
  await seed(store, record(ACTIVE_CITY));
  const updateCity = vi.spyOn(store, "updateCity");
  const runtime = await runtimeWithStore(store);
  return { store, updateCity, runtime };
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
    // A successful restore is a structural acceptance: the scene revision
    // advanced exactly once through acceptPresentationUpdate.
    expect(lastFakeHost()!.context.getSceneRevision()).toBe(2);

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

  it("keeps the camera through UI resets and fits the map again on load", async () => {
    const store = createMemoryCitySaveStore();
    await seed(store, record(LOADED_CITY));
    const runtime = await runtimeWithStore(store);
    const host = lastFakeHost()!;
    const zoomed = { zoom: 2, center: { x: 5, y: 5 } };

    runtime.adjustCamera({ kind: "zoomIn" });
    expect(host.adjustCamera).toHaveBeenCalledWith({ kind: "zoomIn" });
    host.context.onCameraChange(zoomed);
    expect(runtime.getSnapshot().camera).toEqual(zoomed);

    runtime.resetUi();
    runtime.handleEscape();
    expect(runtime.getSnapshot().camera).toEqual(zoomed);

    await runtime.persistence.load(LOADED_CITY.id);
    expect(runtime.getSnapshot().camera).toBeNull();
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
        mapSize: "small",
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
        mapSize: "small",
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
        mapSize: "small",
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
        mapSize: "small",
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

describe("runtime autosave", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("saves an eligible dirty city once after 60 seconds", async () => {
    const { store, updateCity, runtime } = await seededRuntime();
    await runtime.debugSetBudget(90_000);
    expect(runtime.getSnapshot().persistence.dirty).toBe(true);

    runtime.start();
    await advanceAutosave();

    expect(updateCity).toHaveBeenCalledTimes(1);
    expect(updateCity).toHaveBeenCalledWith(ACTIVE_CITY.id, {
      savedAt: "2026-08-08T10:00:00.000Z",
      snapshot: expect.objectContaining({ paused: true }),
    });
    expect(runtime.getSnapshot().persistence).toMatchObject({
      dirty: false,
      busy: false,
      save: "idle",
    });
    await expect(store.readCity(ACTIVE_CITY.id)).resolves.toMatchObject({
      ok: true,
      value: { savedAt: "2026-08-08T10:00:00.000Z" },
    });
    runtime.dispose();
  });

  it("keeps dirty and failed status when the timer-driven save update fails, then retries", async () => {
    const failures = createMemoryCitySaveStoreFailureControls();
    const store = createMemoryCitySaveStore({ failures });
    await seed(store, record(ACTIVE_CITY));
    const updateCity = vi.spyOn(store, "updateCity");
    const runtime = await runtimeWithStore(store);
    await runtime.debugSetBudget(90_000);
    failures.failNext("updateCity", "failed");

    runtime.start();
    await advanceAutosave();

    expect(updateCity).toHaveBeenCalledTimes(1);
    expect(runtime.getSnapshot().persistence).toMatchObject({
      busy: false,
      save: "failed",
      dirty: true,
      error: null,
    });

    // The failed attempt left the city dirty, so the next interval retries.
    await advanceAutosave();
    expect(updateCity).toHaveBeenCalledTimes(2);
    expect(runtime.getSnapshot().persistence).toMatchObject({
      busy: false,
      save: "idle",
      dirty: false,
    });
    runtime.dispose();
  });

  it("keeps dirty and failed status when the timer-driven save throws", async () => {
    const targetBackend: TestBackend = {
      ...backend(),
      async snapshotForSave() {
        throw new Error("snapshot response was lost");
      },
    };
    const store = createMemoryCitySaveStore();
    await seed(store, record(ACTIVE_CITY));
    const updateCity = vi.spyOn(store, "updateCity");
    const runtime = await runtimeWithStore(store, { backend: targetBackend });
    await runtime.debugSetBudget(90_000);

    runtime.start();
    await advanceAutosave();

    expect(updateCity).not.toHaveBeenCalled();
    expect(runtime.getSnapshot().persistence).toMatchObject({
      busy: false,
      save: "failed",
      dirty: true,
      error: null,
    });
    runtime.dispose();
  });

  it("skips the tick when the city is clean or no city is active", async () => {
    const { updateCity, runtime } = await seededRuntime();
    runtime.start();
    await advanceAutosave();
    expect(updateCity).not.toHaveBeenCalled();
    runtime.dispose();

    const anonymousStore = createMemoryCitySaveStore();
    const anonymousUpdate = vi.spyOn(anonymousStore, "updateCity");
    const anonymous = await runtimeWithStore(anonymousStore, {
      initialCity: null,
    });
    anonymous.start();
    await advanceAutosave();
    expect(anonymousUpdate).not.toHaveBeenCalled();
    anonymous.dispose();
  });

  it("skips the tick while a save owns the busy gate", async () => {
    const delegate = createMemoryCitySaveStore();
    await seed(delegate, record(ACTIVE_CITY));
    const store = createDelayedCitySaveStore(delegate);
    store.defer("updateCity");
    const updateCity = vi.spyOn(delegate, "updateCity");
    const runtime = await runtimeWithStore(store);
    await runtime.debugSetBudget(90_000);

    runtime.start();
    await advanceAutosave();
    await store.waitForActive("updateCity");
    expect(store.activeCount()).toBe(1);
    expect(runtime.getSnapshot().persistence).toMatchObject({
      busy: true,
      save: "saving",
    });

    await advanceAutosave();
    expect(store.activeCount()).toBe(1);

    store.releaseNext("updateCity");
    await flushPromises();
    expect(updateCity).toHaveBeenCalledTimes(1);
    expect(runtime.getSnapshot().persistence).toMatchObject({
      busy: false,
      save: "idle",
      dirty: false,
    });
    runtime.dispose();
  });

  it("skips the tick while a route draft is open", async () => {
    const { updateCity, runtime } = await seededRuntime();
    await runtime.debugSetBudget(90_000);
    runtime.setTool("busRoute");
    expect(runtime.getSnapshot().ui.routeDraft).not.toBeNull();

    runtime.start();
    await advanceAutosave();
    await advanceAutosave();
    expect(updateCity).not.toHaveBeenCalled();
    expect(runtime.getSnapshot().ui.routeDraft).not.toBeNull();

    runtime.handleEscape();
    expect(runtime.getSnapshot().ui.routeDraft).toBeNull();
    await advanceAutosave();
    expect(updateCity).toHaveBeenCalledTimes(1);
    runtime.dispose();
  });

  it("does not start a save during a road gesture that still commits", async () => {
    const targetBackend = backend();
    const dispatch = vi.spyOn(targetBackend, "dispatch");
    const store = createMemoryCitySaveStore();
    await seed(store, record(ACTIVE_CITY));
    const updateCity = vi.spyOn(store, "updateCity");
    const runtime = await runtimeWithStore(store, { backend: targetBackend });
    await runtime.debugSetBudget(90_000);

    runtime.setTool("road");
    runtime.startDrag({ x: 1, y: 1 });
    runtime.setDragCurrent({ x: 2, y: 1 });
    expect(runtime.getSnapshot().ui.drag).not.toBeNull();

    runtime.start();
    await advanceAutosave();
    expect(updateCity).not.toHaveBeenCalled();
    expect(runtime.getSnapshot().ui.drag).not.toBeNull();

    await runtime.commitDrag();
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "layRoadLine" }),
    );
    expect(runtime.getSnapshot().ui.drag).toBeNull();

    await advanceAutosave();
    expect(updateCity).toHaveBeenCalledTimes(1);
    runtime.dispose();
  });

  it("skips the tick while a road mutation preview is in flight", async () => {
    const base = backend();
    let settle: (() => void) | null = null;
    const targetBackend: TestBackend = {
      ...base,
      previewRoadMutation(request) {
        return new Promise<RoadMutationPreviewResponse>((resolve) => {
          settle = () =>
            resolve({
              generation: request.generation,
              changedTiles: [],
              authoredTiles: [],
              generatedStructures: [],
              cost: 0,
              skippedTiles: [],
              routeImpacts: [],
              warnings: [],
              rejection: null,
            });
        });
      },
    };
    const store = createMemoryCitySaveStore();
    await seed(store, record(ACTIVE_CITY));
    const updateCity = vi.spyOn(store, "updateCity");
    const runtime = await runtimeWithStore(store, { backend: targetBackend });
    await runtime.debugSetBudget(90_000);

    runtime.previewRoadMutation({ type: "layRoad", point: { x: 1, y: 1 } });
    runtime.start();
    await advanceAutosave();
    expect(updateCity).not.toHaveBeenCalled();

    settle!();
    await flushPromises();
    await advanceAutosave();
    expect(updateCity).toHaveBeenCalledTimes(1);
    runtime.dispose();
  });

  it("keeps one interval across repeated start calls", async () => {
    const { updateCity, runtime } = await seededRuntime();
    await runtime.debugSetBudget(90_000);

    runtime.start();
    runtime.start();
    expect(vi.getTimerCount()).toBe(1);
    await advanceAutosave();
    expect(updateCity).toHaveBeenCalledTimes(1);

    await runtime.debugSetBudget(80_000);
    runtime.start();
    await advanceAutosave();
    expect(updateCity).toHaveBeenCalledTimes(2);
    runtime.dispose();
  });

  it("clears the interval on stop, dispose, and a fatal backend failure", async () => {
    const stopped = await seededRuntime();
    await stopped.runtime.debugSetBudget(90_000);
    stopped.runtime.start();
    stopped.runtime.stop();
    await advanceAutosave();
    expect(stopped.updateCity).not.toHaveBeenCalled();
    stopped.runtime.dispose();

    const disposed = await seededRuntime();
    await disposed.runtime.debugSetBudget(90_000);
    disposed.runtime.start();
    disposed.runtime.dispose();
    await advanceAutosave();
    expect(disposed.updateCity).not.toHaveBeenCalled();

    const fatal = await seededRuntime();
    await fatal.runtime.debugSetBudget(90_000);
    fatal.runtime.start();
    lastFakeHost()!.context.onFatalError(new Error("gpu device lost"));
    await advanceAutosave();
    expect(fatal.updateCity).not.toHaveBeenCalled();
    expect(fatal.runtime.getSnapshot().backendError).toBe("gpu device lost");
  });

  it("reinstalls exactly one interval after stop and restart", async () => {
    const { updateCity, runtime } = await seededRuntime();
    await runtime.debugSetBudget(90_000);

    runtime.start();
    runtime.stop();
    expect(vi.getTimerCount()).toBe(0);

    runtime.start();
    expect(vi.getTimerCount()).toBe(1);
    await advanceAutosave();
    expect(updateCity).toHaveBeenCalledTimes(1);
    runtime.dispose();
  });
});
