import { describe, expect, it } from "vitest";
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
  RustGameSnapshot,
  SandboxCreationRequest,
  SandboxCreationResult,
} from "../../src/runtime/backend/types";
import type { SnapshotResult } from "../../src/runtime/backend/persistenceContract";
import {
  createWorkingSaveRuntime,
  type WorkingSaveRuntime,
} from "../../src/runtime/workingSaveRuntime";
import { createDelayedCitySaveStore } from "./delayedCitySaveStore";
import {
  createRustSnapshot,
  previewBackendStubs,
} from "../fixtures/rustSnapshot";
import { record, seed } from "../fixtures/citySave";

const ACTIVE_CITY: CitySummary = {
  id: "city-active",
  name: "Active City",
  createdAt: "2026-08-08T09:00:00.000Z",
  savedAt: "2026-08-08T10:00:00.000Z",
};

const NEXT_SAVED_AT = "2026-08-08T12:00:00.000Z";

const NEW_CITY_REQUEST = {
  name: "New City",
  economyPreset: "standard",
  templateId: "blankGrid",
} as const;

function backendStub(): GameBackend {
  const snapshot = createRustSnapshot({ paused: true });
  return {
    ...previewBackendStubs(),
    async snapshot() {
      return snapshot;
    },
    async dispatch() {
      return { snapshot, applied: false, rejection: null };
    },
    async tick() {
      return { snapshot, applied: false, rejection: null };
    },
    async reset() {
      return { ok: true, snapshot };
    },
  };
}

function createRuntime(
  initialCity: CitySummary | null = ACTIVE_CITY,
  saveStore: CitySaveStore | null = createMemoryCitySaveStore(),
) {
  return createWorkingSaveRuntime({
    backend: backendStub(),
    ...(saveStore === null ? {} : { saveStore }),
    initialCity,
    now: () => "2026-08-08T12:00:00.000Z",
    createCityId: () => "city-new",
    awaitGameplayIdle: async () => undefined,
    installRestoredGameplay: () => undefined,
    publish: () => undefined,
    isRuntimeDead: () => false,
  });
}

interface TestBackend extends GameBackend {
  calls: string[];
  sandboxRequests: SandboxCreationRequest[];
  setSnapshotForSaveOutcome(outcome: SnapshotResult | Error | null): void;
  setRestoreOutcome(outcome: SnapshotResult | Error | null): void;
  setSandboxOutcome(outcome: SandboxCreationResult | Error | null): void;
}

function createTestBackend(
  initial: RustGameSnapshot = createRustSnapshot({ paused: true }),
  events?: string[],
): TestBackend {
  const base = previewBackendStubs();
  let current = initial;
  let snapshotForSaveOutcome: SnapshotResult | Error | null = null;
  let restoreOutcome: SnapshotResult | Error | null = null;
  let sandboxOutcome: SandboxCreationResult | Error | null = null;
  const calls: string[] = [];
  const sandboxRequests: SandboxCreationRequest[] = [];

  return {
    ...base,
    calls,
    sandboxRequests,
    setSnapshotForSaveOutcome(outcome) {
      snapshotForSaveOutcome = outcome;
    },
    setRestoreOutcome(outcome) {
      restoreOutcome = outcome;
    },
    setSandboxOutcome(outcome) {
      sandboxOutcome = outcome;
    },
    async snapshot() {
      return current;
    },
    async snapshotForSave() {
      calls.push("snapshotForSave");
      events?.push("snapshotForSave");
      if (snapshotForSaveOutcome instanceof Error) throw snapshotForSaveOutcome;
      return snapshotForSaveOutcome ?? { ok: true, snapshot: current };
    },
    async buildSandboxSnapshot(request: SandboxCreationRequest) {
      calls.push("buildSandboxSnapshot");
      events?.push("buildSandboxSnapshot");
      sandboxRequests.push(request);
      if (sandboxOutcome instanceof Error) throw sandboxOutcome;
      return (
        sandboxOutcome ?? {
          ok: true,
          snapshot: createRustSnapshot({ budget: request.startingCapital }),
        }
      );
    },
    async restoreSnapshot(snapshot: unknown) {
      calls.push("restoreSnapshot");
      events?.push("restoreSnapshot");
      if (restoreOutcome instanceof Error) throw restoreOutcome;
      if (restoreOutcome !== null) {
        if (restoreOutcome.ok) current = restoreOutcome.snapshot;
        return restoreOutcome;
      }
      current = snapshot as RustGameSnapshot;
      return { ok: true, snapshot: current };
    },
    async dispatch() {
      return { snapshot: current, applied: false, rejection: null };
    },
    async tick() {
      return { snapshot: current, applied: false, rejection: null };
    },
    async reset() {
      return { ok: true, snapshot: current };
    },
  };
}

interface RuntimeFixture {
  runtime: WorkingSaveRuntime;
  backend: TestBackend;
  saveStore: CitySaveStore | undefined;
  events: string[];
  readonly publications: number;
  readonly installedSnapshot: RustGameSnapshot | null;
  killRuntime(): void;
  failNextInstall(error: Error): void;
}

function createRuntimeFixture(
  options: {
    backend?: TestBackend;
    initialCity?: CitySummary | null;
    saveStore?: CitySaveStore | null;
    now?: () => string;
    createCityId?: () => string;
    awaitGameplayIdle?: () => Promise<void>;
    events?: string[];
  } = {},
): RuntimeFixture {
  const events = options.events ?? [];
  const backend = options.backend ?? createTestBackend(undefined, events);
  const initialCity =
    options.initialCity === undefined ? ACTIVE_CITY : options.initialCity;
  const saveStore =
    options.saveStore === undefined
      ? createMemoryCitySaveStore()
      : options.saveStore;
  let publications = 0;
  let installedSnapshot: RustGameSnapshot | null = null;
  let runtimeDead = false;
  let installError: Error | null = null;
  const runtime = createWorkingSaveRuntime({
    backend,
    ...(saveStore === null ? {} : { saveStore }),
    initialCity,
    now: options.now ?? (() => NEXT_SAVED_AT),
    createCityId: options.createCityId ?? (() => "city-new"),
    awaitGameplayIdle:
      options.awaitGameplayIdle ??
      (async () => {
        events.push("awaitGameplayIdle");
      }),
    installRestoredGameplay(snapshot) {
      if (installError) {
        const error = installError;
        installError = null;
        throw error;
      }
      installedSnapshot = snapshot;
      events.push("installRestoredGameplay");
    },
    publish() {
      publications += 1;
    },
    isRuntimeDead: () => runtimeDead,
  });

  return {
    runtime,
    backend,
    saveStore: saveStore ?? undefined,
    events,
    get publications() {
      return publications;
    },
    get installedSnapshot() {
      return installedSnapshot;
    },
    killRuntime() {
      runtimeDead = true;
    },
    failNextInstall(error: Error) {
      installError = error;
    },
  };
}

describe("working save runtime state", () => {
  it("starts clean for the supplied active city", () => {
    const runtime = createRuntime();

    expect(runtime.getView()).toEqual({
      activeCity: ACTIVE_CITY,
      busy: false,
      dirty: false,
      error: null,
    });

    runtime.markDirty();

    expect(runtime.getView().dirty).toBe(true);
  });

  it("does not mark an anonymous runtime dirty", () => {
    const runtime = createRuntime(null);

    runtime.markDirty();

    expect(runtime.getView().dirty).toBe(false);
  });
});

describe("working save runtime city lists", () => {
  it("lists an empty city library", async () => {
    const runtime = createRuntime();

    await expect(runtime.controller.listCities()).resolves.toEqual({
      ok: true,
      value: [],
    });
  });

  it("lists populated city summaries", async () => {
    const store = createMemoryCitySaveStore();
    const otherCity: CitySummary = {
      id: "city-other",
      name: "Other City",
      createdAt: "2026-08-08T08:00:00.000Z",
      savedAt: "2026-08-08T11:00:00.000Z",
    };
    await seed(store, record(ACTIVE_CITY));
    await seed(store, record(otherCity));
    const runtime = createRuntime(ACTIVE_CITY, store);

    await expect(runtime.controller.listCities()).resolves.toEqual({
      ok: true,
      value: [otherCity, ACTIVE_CITY],
    });
  });

  it("returns a store failure from city listing", async () => {
    const failures = createMemoryCitySaveStoreFailureControls();
    const runtime = createRuntime(
      ACTIVE_CITY,
      createMemoryCitySaveStore({ failures }),
    );
    failures.failNext("listCities", "failed");

    await expect(runtime.controller.listCities()).resolves.toMatchObject({
      ok: false,
      error: { kind: "store", error: { operation: "listCities" } },
    });
  });

  it("maps a throwing city listing adapter to a store failure", async () => {
    const delegate = createMemoryCitySaveStore();
    const store: CitySaveStore = {
      ...delegate,
      async listCities() {
        throw new Error("list failed unexpectedly");
      },
    };
    const runtime = createRuntime(ACTIVE_CITY, store);

    await expect(runtime.controller.listCities()).resolves.toEqual({
      ok: false,
      error: {
        kind: "store",
        error: {
          operation: "listCities",
          code: "failed",
          diagnostic: "list failed unexpectedly",
        },
      },
    });
  });

  it("reports unavailable when no city store is configured", async () => {
    const runtime = createRuntime(ACTIVE_CITY, null);

    await expect(runtime.controller.listCities()).resolves.toEqual({
      ok: false,
      error: { kind: "unavailable" },
    });
  });

  it("keeps an already-started successful city read after disposal", async () => {
    const delegate = createMemoryCitySaveStore();
    await seed(delegate, record(ACTIVE_CITY));
    const delayed = createDelayedCitySaveStore(delegate);
    delayed.defer("listCities");
    let listCalls = 0;
    const store: CitySaveStore = {
      ...delayed,
      listCities() {
        listCalls += 1;
        return delayed.listCities();
      },
    };
    const runtime = createRuntime(ACTIVE_CITY, store);

    const listing = runtime.controller.listCities();
    await Promise.resolve();
    expect(listCalls).toBe(1);

    await delayed.waitForActive("listCities");
    runtime.dispose();
    delayed.releaseNext("listCities");

    await expect(listing).resolves.toEqual({
      ok: true,
      value: [ACTIVE_CITY],
    });
  });
});

describe("working save runtime saves", () => {
  it("saves the active city snapshot and marks it clean", async () => {
    const fixture = createRuntimeFixture();
    await seed(fixture.saveStore!, record(ACTIVE_CITY));
    fixture.runtime.markDirty();

    const result = await fixture.runtime.controller.save();

    expect(result).toMatchObject({ ok: true, value: { id: ACTIVE_CITY.id } });
    expect(fixture.runtime.getView().dirty).toBe(false);
    expect(fixture.runtime.getView().activeCity?.savedAt).toBe(NEXT_SAVED_AT);
    expect(fixture.backend.calls).toEqual(["snapshotForSave"]);
  });

  it("keeps the active city dirty when its update fails", async () => {
    const failures = createMemoryCitySaveStoreFailureControls();
    const delegate = createMemoryCitySaveStore({ failures });
    await seed(delegate, record(ACTIVE_CITY));
    let readCalls = 0;
    let createCalls = 0;
    const store: CitySaveStore = {
      ...delegate,
      readCity(id) {
        readCalls += 1;
        return delegate.readCity(id);
      },
      createCity(value) {
        createCalls += 1;
        return delegate.createCity(value);
      },
    };
    const fixture = createRuntimeFixture({ saveStore: store });
    fixture.runtime.markDirty();
    failures.failNext("updateCity", "failed");

    await expect(fixture.runtime.controller.save()).resolves.toMatchObject({
      ok: false,
      error: { kind: "store", error: { operation: "updateCity" } },
    });
    expect(fixture.runtime.getView().activeCity).toEqual(ACTIVE_CITY);
    expect(fixture.runtime.getView().dirty).toBe(true);
    expect(readCalls).toBe(0);
    expect(createCalls).toBe(0);
  });

  it("does not create a missing active-city record when update returns not found", async () => {
    const delegate = createMemoryCitySaveStore();
    let createCalls = 0;
    const store: CitySaveStore = {
      ...delegate,
      createCity(value) {
        createCalls += 1;
        return delegate.createCity(value);
      },
    };
    const fixture = createRuntimeFixture({ saveStore: store });
    fixture.runtime.markDirty();

    await expect(fixture.runtime.controller.save()).resolves.toMatchObject({
      ok: false,
      error: {
        kind: "store",
        error: { operation: "updateCity", code: "notFound" },
      },
    });
    expect(createCalls).toBe(0);
    expect(fixture.runtime.getView().dirty).toBe(true);
  });

  it("maps a thrown gameplay-idle wait to host failure and releases busy", async () => {
    const fixture = createRuntimeFixture({
      awaitGameplayIdle: async () => {
        throw new Error("gameplay did not settle");
      },
    });
    await seed(fixture.saveStore!, record(ACTIVE_CITY));

    await expect(fixture.runtime.controller.save()).resolves.toEqual({
      ok: false,
      error: {
        kind: "backend",
        error: {
          code: "hostFailure",
          diagnostic: "gameplay did not settle",
        },
      },
    });
    expect(fixture.runtime.isBusy()).toBe(false);
    expect(fixture.runtime.getView().error).toEqual({
      kind: "backend",
      error: {
        code: "hostFailure",
        diagnostic: "gameplay did not settle",
      },
    });
  });

  it("keeps the city dirty when saving returns a backend snapshot failure", async () => {
    const fixture = createRuntimeFixture();
    await seed(fixture.saveStore!, record(ACTIVE_CITY));
    fixture.runtime.markDirty();
    fixture.backend.setSnapshotForSaveOutcome({
      ok: false,
      error: { code: "invalidSnapshot" },
    });

    await expect(fixture.runtime.controller.save()).resolves.toEqual({
      ok: false,
      error: { kind: "backend", error: { code: "invalidSnapshot" } },
    });
    expect(fixture.runtime.getView().dirty).toBe(true);
  });

  it("returns no-active-city without writing when no city is active", async () => {
    const fixture = createRuntimeFixture({ initialCity: null });
    let updates = 0;
    const store: CitySaveStore = {
      ...fixture.saveStore!,
      updateCity(id, update) {
        updates += 1;
        return fixture.saveStore!.updateCity(id, update);
      },
    };
    const runtime = createRuntimeFixture({
      initialCity: null,
      saveStore: store,
    }).runtime;

    await expect(runtime.controller.save()).resolves.toEqual({
      ok: false,
      error: { kind: "noActiveCity" },
    });
    expect(updates).toBe(0);
  });

  it("returns unavailable when saving without a configured store", async () => {
    const fixture = createRuntimeFixture({ saveStore: null });

    await expect(fixture.runtime.controller.save()).resolves.toEqual({
      ok: false,
      error: { kind: "unavailable" },
    });
  });

  it("returns noActiveCity when both active city and store are absent", async () => {
    const fixture = createRuntimeFixture({
      initialCity: null,
      saveStore: null,
    });

    await expect(fixture.runtime.controller.save()).resolves.toEqual({
      ok: false,
      error: { kind: "noActiveCity" },
    });
  });

  it("allows city listing while a save is waiting for its store update", async () => {
    const delegate = createMemoryCitySaveStore();
    await seed(delegate, record(ACTIVE_CITY));
    const delayed = createDelayedCitySaveStore(delegate);
    delayed.defer("updateCity");
    const fixture = createRuntimeFixture({ saveStore: delayed });

    const saving = fixture.runtime.controller.save();
    expect(fixture.runtime.getView().busy).toBe(true);
    await delayed.waitForActive("updateCity");

    await expect(fixture.runtime.controller.listCities()).resolves.toEqual({
      ok: true,
      value: [ACTIVE_CITY],
    });

    delayed.releaseNext("updateCity");
    await saving;
  });

  it("rejects overlapping mutations while a save is busy", async () => {
    const delegate = createMemoryCitySaveStore();
    await seed(delegate, record(ACTIVE_CITY));
    const delayed = createDelayedCitySaveStore(delegate);
    delayed.defer("updateCity");
    const fixture = createRuntimeFixture({ saveStore: delayed });

    const saving = fixture.runtime.controller.save();
    expect(fixture.runtime.getView().busy).toBe(true);
    await delayed.waitForActive("updateCity");

    await expect(
      fixture.runtime.controller.renameCity(ACTIVE_CITY.id, "Other"),
    ).resolves.toEqual({
      ok: false,
      error: { kind: "busy" },
    });

    delayed.releaseNext("updateCity");
    await saving;
  });

  it("suppresses final publication after synchronous disposal", async () => {
    const delegate = createMemoryCitySaveStore();
    await seed(delegate, record(ACTIVE_CITY));
    const delayed = createDelayedCitySaveStore(delegate);
    delayed.defer("updateCity");
    const fixture = createRuntimeFixture({ saveStore: delayed });

    const saving = fixture.runtime.controller.save();
    expect(fixture.runtime.getView().busy).toBe(true);
    await delayed.waitForActive("updateCity");
    const publicationsBeforeDispose = fixture.publications;

    fixture.runtime.dispose();
    expect(fixture.publications).toBe(publicationsBeforeDispose);

    delayed.releaseNext("updateCity");
    await saving;
    expect(fixture.publications).toBe(publicationsBeforeDispose);
  });
});

describe("working save runtime loads", () => {
  it("installs a stored snapshot and makes its city active and clean", async () => {
    const loadedCity: CitySummary = {
      id: "city-loaded",
      name: "Loaded City",
      createdAt: "2026-08-08T08:00:00.000Z",
      savedAt: "2026-08-08T11:30:00.000Z",
    };
    const loadedSnapshot = createRustSnapshot({ budget: 321_000 });
    const fixture = createRuntimeFixture();
    await seed(fixture.saveStore!, record(loadedCity, loadedSnapshot));

    await expect(
      fixture.runtime.controller.load(loadedCity.id),
    ).resolves.toEqual({
      ok: true,
      value: loadedCity,
    });
    expect(fixture.installedSnapshot).toEqual(loadedSnapshot);
    expect(fixture.runtime.getView().activeCity).toEqual(loadedCity);
    expect(fixture.runtime.getView().dirty).toBe(false);
  });

  it("returns a read failure without changing the active city", async () => {
    const failures = createMemoryCitySaveStoreFailureControls();
    const store = createMemoryCitySaveStore({ failures });
    const fixture = createRuntimeFixture({ saveStore: store });
    failures.failNext("readCity", "failed");

    await expect(
      fixture.runtime.controller.load("city-missing"),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        kind: "store",
        error: { operation: "readCity", cityId: "city-missing" },
      },
    });
    expect(fixture.runtime.getView().activeCity).toEqual(ACTIVE_CITY);
    expect(fixture.runtime.getView().dirty).toBe(false);
  });

  it("preserves the active identity for a returned restore rejection", async () => {
    const loadedCity: CitySummary = {
      id: "city-loaded",
      name: "Loaded City",
      createdAt: "2026-08-08T08:00:00.000Z",
      savedAt: "2026-08-08T11:30:00.000Z",
    };
    const fixture = createRuntimeFixture();
    await seed(fixture.saveStore!, record(loadedCity));
    fixture.backend.setRestoreOutcome({
      ok: false,
      error: { code: "invalidSnapshot" },
    });

    await expect(
      fixture.runtime.controller.load(loadedCity.id),
    ).resolves.toEqual({
      ok: false,
      error: { kind: "backend", error: { code: "invalidSnapshot" } },
    });
    expect(fixture.runtime.getView().activeCity).toEqual(ACTIVE_CITY);
    expect(fixture.runtime.getView().dirty).toBe(false);
    expect(fixture.installedSnapshot).toBeNull();
  });

  it("detaches after a thrown ambiguous restore and prevents a later save", async () => {
    const loadedCity: CitySummary = {
      id: "city-loaded",
      name: "Loaded City",
      createdAt: "2026-08-08T08:00:00.000Z",
      savedAt: "2026-08-08T11:30:00.000Z",
    };
    const delegate = createMemoryCitySaveStore();
    await seed(delegate, record(loadedCity));
    let updates = 0;
    const store: CitySaveStore = {
      ...delegate,
      updateCity(id, update) {
        updates += 1;
        return delegate.updateCity(id, update);
      },
    };
    const fixture = createRuntimeFixture({ saveStore: store });
    fixture.backend.setRestoreOutcome(new Error("restore response was lost"));

    await expect(
      fixture.runtime.controller.load(loadedCity.id),
    ).resolves.toEqual({
      ok: false,
      error: {
        kind: "backend",
        error: {
          code: "hostFailure",
          diagnostic: "restore response was lost",
        },
      },
    });
    expect(fixture.runtime.getView().activeCity).toBeNull();
    expect(fixture.runtime.getView().dirty).toBe(false);

    await expect(fixture.runtime.controller.save()).resolves.toEqual({
      ok: false,
      error: { kind: "noActiveCity" },
    });
    expect(updates).toBe(0);
  });

  it("returns unavailable when loading without a configured store", async () => {
    const fixture = createRuntimeFixture({ saveStore: null });

    await expect(fixture.runtime.controller.load("city-any")).resolves.toEqual({
      ok: false,
      error: { kind: "unavailable" },
    });
  });

  it("detaches after a thrown install and prevents a later save", async () => {
    const loadedCity: CitySummary = {
      id: "city-loaded",
      name: "Loaded City",
      createdAt: "2026-08-08T08:00:00.000Z",
      savedAt: "2026-08-08T11:30:00.000Z",
    };
    const delegate = createMemoryCitySaveStore();
    await seed(delegate, record(loadedCity));
    let updates = 0;
    const store: CitySaveStore = {
      ...delegate,
      updateCity(id, update) {
        updates += 1;
        return delegate.updateCity(id, update);
      },
    };
    const fixture = createRuntimeFixture({ saveStore: store });
    fixture.failNextInstall(new Error("install was lost"));

    await expect(
      fixture.runtime.controller.load(loadedCity.id),
    ).resolves.toEqual({
      ok: false,
      error: {
        kind: "backend",
        error: {
          code: "hostFailure",
          diagnostic: "install was lost",
        },
      },
    });
    expect(fixture.runtime.getView().activeCity).toBeNull();
    expect(fixture.runtime.getView().dirty).toBe(false);

    await expect(fixture.runtime.controller.save()).resolves.toEqual({
      ok: false,
      error: { kind: "noActiveCity" },
    });
    expect(updates).toBe(0);
  });

  it("does not restore after disposal when a read resolves late", async () => {
    const loadedCity: CitySummary = {
      id: "city-loaded",
      name: "Loaded City",
      createdAt: "2026-08-08T08:00:00.000Z",
      savedAt: "2026-08-08T11:30:00.000Z",
    };
    const loadedSnapshot = createRustSnapshot({ budget: 321_000 });
    const delegate = createMemoryCitySaveStore();
    await seed(delegate, record(loadedCity, loadedSnapshot));
    const delayed = createDelayedCitySaveStore(delegate);
    delayed.defer("readCity");
    const fixture = createRuntimeFixture({ saveStore: delayed });

    const loading = fixture.runtime.controller.load(loadedCity.id);
    await delayed.waitForActive("readCity");
    const publicationsBeforeDispose = fixture.publications;

    fixture.runtime.dispose();
    delayed.releaseNext("readCity");

    await expect(loading).resolves.toEqual({
      ok: false,
      error: { kind: "unavailable" },
    });
    expect(fixture.backend.calls).not.toContain("restoreSnapshot");
    expect(fixture.installedSnapshot).toBeNull();
    expect(fixture.publications).toBe(publicationsBeforeDispose);
  });
});

describe("working save runtime new cities", () => {
  it("builds, stores, restores, and installs a new city in order", async () => {
    const events: string[] = [];
    const delegate = createMemoryCitySaveStore();
    const store: CitySaveStore = {
      ...delegate,
      createCity(value) {
        events.push("createCity");
        return delegate.createCity(value);
      },
    };
    const fixture = createRuntimeFixture({ saveStore: store, events });

    await expect(
      fixture.runtime.controller.createCity(NEW_CITY_REQUEST),
    ).resolves.toEqual({
      ok: true,
      value: {
        id: "city-new",
        name: "New City",
        createdAt: NEXT_SAVED_AT,
        savedAt: NEXT_SAVED_AT,
      },
    });
    expect(events.filter((event) => event !== "awaitGameplayIdle")).toEqual([
      "buildSandboxSnapshot",
      "createCity",
      "restoreSnapshot",
      "installRestoredGameplay",
    ]);
    await expect(delegate.readCity("city-new")).resolves.toMatchObject({
      ok: true,
      value: {
        city: { id: "city-new", name: "New City", createdAt: NEXT_SAVED_AT },
        savedAt: NEXT_SAVED_AT,
      },
    });
  });

  it("translates player New City choices to the current hidden settings", async () => {
    const fixture = createRuntimeFixture({ initialCity: null });

    await fixture.runtime.controller.createCity({
      name: "Creative Grid",
      economyPreset: "creative",
      templateId: "blankGrid",
    });

    expect(fixture.backend.sandboxRequests).toEqual([
      {
        templateId: "blankGrid",
        economyPreset: "creative",
        startingCapital: 120_000,
        demandMultiplier: 1,
      },
    ]);
  });

  it("returns a sandbox candidate failure without creating a city", async () => {
    const backend = createTestBackend();
    backend.setSandboxOutcome({
      ok: false,
      error: {
        code: "unknownTemplateId",
        context: { templateId: NEW_CITY_REQUEST.templateId },
      },
    });
    const fixture = createRuntimeFixture({ backend });

    await expect(
      fixture.runtime.controller.createCity(NEW_CITY_REQUEST),
    ).resolves.toMatchObject({
      ok: false,
      error: { kind: "sandbox", error: { code: "unknownTemplateId" } },
    });
    await expect(
      fixture.saveStore!.readCity("city-new"),
    ).resolves.toMatchObject({
      ok: false,
      error: { operation: "readCity", code: "notFound", cityId: "city-new" },
    });
    expect(fixture.runtime.getView().activeCity).toEqual(ACTIVE_CITY);
  });

  it("returns a create conflict without replacing the active city", async () => {
    const store = createMemoryCitySaveStore();
    await seed(
      store,
      record({
        id: "city-new",
        name: "Existing City",
        createdAt: "2026-08-08T07:00:00.000Z",
        savedAt: "2026-08-08T08:00:00.000Z",
      }),
    );
    const fixture = createRuntimeFixture({ saveStore: store });

    await expect(
      fixture.runtime.controller.createCity(NEW_CITY_REQUEST),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        kind: "store",
        error: {
          operation: "createCity",
          code: "conflict",
          cityId: "city-new",
        },
      },
    });
    expect(fixture.runtime.getView().activeCity).toEqual(ACTIVE_CITY);
    expect(fixture.backend.calls).toEqual(["buildSandboxSnapshot"]);
  });

  it("returns a definite create failure without creating a city", async () => {
    const failures = createMemoryCitySaveStoreFailureControls();
    const store = createMemoryCitySaveStore({ failures });
    const fixture = createRuntimeFixture({ saveStore: store });
    failures.failNext("createCity", "failed");

    await expect(
      fixture.runtime.controller.createCity(NEW_CITY_REQUEST),
    ).resolves.toMatchObject({
      ok: false,
      error: { kind: "store", error: { operation: "createCity" } },
    });
    await expect(store.readCity("city-new")).resolves.toMatchObject({
      ok: false,
      error: { operation: "readCity", code: "notFound", cityId: "city-new" },
    });
  });

  it("keeps the prior active city after a returned new-city activation failure", async () => {
    const fixture = createRuntimeFixture();
    fixture.backend.setRestoreOutcome({
      ok: false,
      error: { code: "invalidSnapshot" },
    });

    await expect(
      fixture.runtime.controller.createCity(NEW_CITY_REQUEST),
    ).resolves.toEqual({
      ok: false,
      error: { kind: "backend", error: { code: "invalidSnapshot" } },
    });
    await expect(
      fixture.saveStore!.readCity("city-new"),
    ).resolves.toMatchObject({
      ok: true,
    });
    expect(fixture.runtime.getView().activeCity).toEqual(ACTIVE_CITY);
    expect(fixture.runtime.getView().dirty).toBe(false);
    expect(fixture.installedSnapshot).toBeNull();
  });

  it("keeps the created record but detaches after a thrown new-city activation", async () => {
    const fixture = createRuntimeFixture();
    fixture.backend.setRestoreOutcome(new Error("new city restore was lost"));

    await expect(
      fixture.runtime.controller.createCity(NEW_CITY_REQUEST),
    ).resolves.toEqual({
      ok: false,
      error: {
        kind: "backend",
        error: {
          code: "hostFailure",
          diagnostic: "new city restore was lost",
        },
      },
    });
    await expect(
      fixture.saveStore!.readCity("city-new"),
    ).resolves.toMatchObject({
      ok: true,
    });
    expect(fixture.runtime.getView().activeCity).toBeNull();
    expect(fixture.runtime.getView().dirty).toBe(false);
    await expect(fixture.runtime.controller.save()).resolves.toEqual({
      ok: false,
      error: { kind: "noActiveCity" },
    });
  });

  it("keeps the created record but detaches after a thrown new-city install", async () => {
    const fixture = createRuntimeFixture();
    fixture.failNextInstall(new Error("new city install was lost"));

    await expect(
      fixture.runtime.controller.createCity(NEW_CITY_REQUEST),
    ).resolves.toEqual({
      ok: false,
      error: {
        kind: "backend",
        error: {
          code: "hostFailure",
          diagnostic: "new city install was lost",
        },
      },
    });
    await expect(
      fixture.saveStore!.readCity("city-new"),
    ).resolves.toMatchObject({
      ok: true,
    });
    expect(fixture.runtime.getView().activeCity).toBeNull();
    expect(fixture.runtime.getView().dirty).toBe(false);
    await expect(fixture.runtime.controller.save()).resolves.toEqual({
      ok: false,
      error: { kind: "noActiveCity" },
    });
  });
});

describe("working save runtime drain-race guard", () => {
  // The App checks persistence.dirty before calling Create/Load, but an
  // already-admitted gameplay operation can apply during the awaitGameplayIdle
  // drain inside runExclusive and mark the active city dirty after that check
  // passed. The runtime refuses the replacement so unsaved changes are not
  // silently discarded.
  it("refuses load after the gameplay drain marks the active city dirty", async () => {
    const loadedCity: CitySummary = {
      id: "city-loaded",
      name: "Loaded City",
      createdAt: "2026-08-08T08:00:00.000Z",
      savedAt: "2026-08-08T11:30:00.000Z",
    };
    const fixture = createRuntimeFixture({
      awaitGameplayIdle: async () => {
        fixture.runtime.markDirty();
      },
    });
    await seed(fixture.saveStore!, record(loadedCity));

    await expect(
      fixture.runtime.controller.load(loadedCity.id),
    ).resolves.toEqual({
      ok: false,
      error: { kind: "unsavedChanges" },
    });
    expect(fixture.runtime.getView().activeCity).toEqual(ACTIVE_CITY);
    expect(fixture.runtime.getView().dirty).toBe(true);
    expect(fixture.installedSnapshot).toBeNull();
  });

  it("refuses createCity after the gameplay drain marks the active city dirty", async () => {
    const fixture = createRuntimeFixture({
      awaitGameplayIdle: async () => {
        fixture.runtime.markDirty();
      },
    });

    await expect(
      fixture.runtime.controller.createCity(NEW_CITY_REQUEST),
    ).resolves.toEqual({
      ok: false,
      error: { kind: "unsavedChanges" },
    });
    expect(fixture.runtime.getView().activeCity).toEqual(ACTIVE_CITY);
    expect(fixture.runtime.getView().dirty).toBe(true);
    expect(fixture.installedSnapshot).toBeNull();
    expect(fixture.backend.calls).not.toContain("buildSandboxSnapshot");
  });
});

describe("working save runtime city library mutations", () => {
  it("replaces the active city summary after renaming it without changing dirty", async () => {
    const fixture = createRuntimeFixture();
    await seed(fixture.saveStore!, record(ACTIVE_CITY));
    fixture.runtime.markDirty();

    await expect(
      fixture.runtime.controller.renameCity(ACTIVE_CITY.id, "Renamed City"),
    ).resolves.toEqual({
      ok: true,
      value: { ...ACTIVE_CITY, name: "Renamed City" },
    });
    expect(fixture.runtime.getView().activeCity).toEqual({
      ...ACTIVE_CITY,
      name: "Renamed City",
    });
    expect(fixture.runtime.getView().dirty).toBe(true);
  });

  it("renames an inactive city without changing the active city or dirty state", async () => {
    const inactiveCity: CitySummary = {
      id: "city-inactive",
      name: "Inactive City",
      createdAt: "2026-08-08T08:00:00.000Z",
      savedAt: "2026-08-08T09:00:00.000Z",
    };
    const fixture = createRuntimeFixture();
    await seed(fixture.saveStore!, record(ACTIVE_CITY));
    await seed(fixture.saveStore!, record(inactiveCity));
    fixture.runtime.markDirty();

    await expect(
      fixture.runtime.controller.renameCity(inactiveCity.id, "Changed City"),
    ).resolves.toEqual({
      ok: true,
      value: { ...inactiveCity, name: "Changed City" },
    });
    expect(fixture.runtime.getView().activeCity).toEqual(ACTIVE_CITY);
    expect(fixture.runtime.getView().dirty).toBe(true);
    await expect(
      fixture.saveStore!.readCity(inactiveCity.id),
    ).resolves.toMatchObject({
      ok: true,
      value: { city: { name: "Changed City" } },
    });
  });

  it("keeps active identity and dirty state when renaming it fails", async () => {
    const failures = createMemoryCitySaveStoreFailureControls();
    const store = createMemoryCitySaveStore({ failures });
    await seed(store, record(ACTIVE_CITY));
    const fixture = createRuntimeFixture({ saveStore: store });
    fixture.runtime.markDirty();
    failures.failNext("renameCity", "failed");

    await expect(
      fixture.runtime.controller.renameCity(ACTIVE_CITY.id, "Renamed City"),
    ).resolves.toMatchObject({
      ok: false,
      error: { kind: "store", error: { operation: "renameCity" } },
    });
    expect(fixture.runtime.getView().activeCity).toEqual(ACTIVE_CITY);
    expect(fixture.runtime.getView().dirty).toBe(true);
  });

  it("deletes an inactive city without changing the active city or dirty state", async () => {
    const inactiveCity: CitySummary = {
      id: "city-inactive",
      name: "Inactive City",
      createdAt: "2026-08-08T08:00:00.000Z",
      savedAt: "2026-08-08T09:00:00.000Z",
    };
    const fixture = createRuntimeFixture();
    await seed(fixture.saveStore!, record(ACTIVE_CITY));
    await seed(fixture.saveStore!, record(inactiveCity));
    fixture.runtime.markDirty();

    await expect(
      fixture.runtime.controller.deleteCity(inactiveCity.id),
    ).resolves.toEqual({ ok: true, value: undefined });
    expect(fixture.runtime.getView().activeCity).toEqual(ACTIVE_CITY);
    expect(fixture.runtime.getView().dirty).toBe(true);
  });

  it("clears an active city only after its deletion succeeds", async () => {
    const fixture = createRuntimeFixture();
    await seed(fixture.saveStore!, record(ACTIVE_CITY));
    fixture.runtime.markDirty();

    await expect(
      fixture.runtime.controller.deleteCity(ACTIVE_CITY.id),
    ).resolves.toEqual({ ok: true, value: undefined });
    expect(fixture.runtime.getView().activeCity).toBeNull();
    expect(fixture.runtime.getView().dirty).toBe(false);
    expect(fixture.backend.calls).toEqual([]);
  });

  it("keeps an active city and dirty state when deletion fails", async () => {
    const failures = createMemoryCitySaveStoreFailureControls();
    const store = createMemoryCitySaveStore({ failures });
    await seed(store, record(ACTIVE_CITY));
    const fixture = createRuntimeFixture({ saveStore: store });
    fixture.runtime.markDirty();
    failures.failNext("deleteCity", "failed");

    await expect(
      fixture.runtime.controller.deleteCity(ACTIVE_CITY.id),
    ).resolves.toMatchObject({
      ok: false,
      error: { kind: "store", error: { operation: "deleteCity" } },
    });
    expect(fixture.runtime.getView().activeCity).toEqual(ACTIVE_CITY);
    expect(fixture.runtime.getView().dirty).toBe(true);
  });
});
