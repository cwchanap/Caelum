import type {
  CitySaveStore,
  CitySaveStoreError,
  CitySaveStoreOperation,
  CitySaveStoreResult,
  CitySummary,
} from "../persistence/citySaveStore";
import type {
  GameBackend,
  RustGameSnapshot,
  SandboxCreationError,
  SandboxCreationRequest,
  SandboxHostError,
  SnapshotError,
} from "./backend";

export interface RuntimePersistenceView {
  activeCity: CitySummary | null;
  busy: boolean;
  dirty: boolean;
  error: WorkingSaveError | null;
}

export interface NewCityRequest {
  name: string;
  sandbox: SandboxCreationRequest;
}

export type WorkingSaveError =
  | { kind: "busy" }
  | { kind: "unavailable" }
  | { kind: "noActiveCity" }
  | { kind: "store"; error: CitySaveStoreError }
  | { kind: "backend"; error: SnapshotError | SandboxHostError }
  | { kind: "sandbox"; error: SandboxCreationError };

export type WorkingSaveResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: WorkingSaveError };

export interface RuntimePersistenceController {
  listCities(): Promise<WorkingSaveResult<CitySummary[]>>;
  save(): Promise<WorkingSaveResult<CitySummary>>;
  load(cityId: string): Promise<WorkingSaveResult<CitySummary>>;
  createCity(request: NewCityRequest): Promise<WorkingSaveResult<CitySummary>>;
  renameCity(
    cityId: string,
    name: string,
  ): Promise<WorkingSaveResult<CitySummary>>;
  deleteCity(cityId: string): Promise<WorkingSaveResult<void>>;
}

export interface WorkingSaveRuntimeHost {
  backend: GameBackend;
  saveStore?: CitySaveStore;
  initialCity: CitySummary | null;
  now: () => string;
  createCityId: () => string;
  awaitGameplayIdle: () => Promise<void>;
  installRestoredGameplay: (snapshot: RustGameSnapshot) => void;
  publish: () => void;
  isRuntimeDead: () => boolean;
}

export interface WorkingSaveRuntime {
  controller: RuntimePersistenceController;
  getView(): RuntimePersistenceView;
  isBusy(): boolean;
  markDirty(): void;
  dispose(): void;
}

export function createWorkingSaveRuntime(
  host: WorkingSaveRuntimeHost,
): WorkingSaveRuntime {
  let activeCity = host.initialCity;
  let busy = false;
  let dirty = false;
  let error: WorkingSaveError | null = null;
  let disposed = false;

  const isLive = (): boolean => !disposed && !host.isRuntimeDead();

  const publishIfLive = (): void => {
    if (isLive()) host.publish();
  };

  const dispose = (): void => {
    disposed = true;
  };

  const callStore = async <T>(
    operation: CitySaveStoreOperation,
    cityId: string | undefined,
    call: () => Promise<CitySaveStoreResult<T>>,
  ): Promise<WorkingSaveResult<T>> => {
    try {
      const result = await call();
      return result.ok
        ? { ok: true, value: result.value }
        : { ok: false, error: { kind: "store", error: result.error } };
    } catch (thrown: unknown) {
      return {
        ok: false,
        error: {
          kind: "store",
          error: {
            operation,
            code: "failed",
            ...(cityId === undefined ? {} : { cityId }),
            diagnostic:
              thrown instanceof Error ? thrown.message : String(thrown),
          },
        },
      };
    }
  };

  const backendHostFailure = (thrown: unknown): WorkingSaveError => ({
    kind: "backend",
    error: {
      code: "hostFailure",
      diagnostic: thrown instanceof Error ? thrown.message : String(thrown),
    },
  });

  const runExclusive = async <T>(
    work: () => Promise<WorkingSaveResult<T>>,
  ): Promise<WorkingSaveResult<T>> => {
    if (!isLive()) return { ok: false, error: { kind: "unavailable" } };
    if (busy) return { ok: false, error: { kind: "busy" } };

    busy = true;
    error = null;
    publishIfLive();

    try {
      await host.awaitGameplayIdle();
      if (!isLive()) return { ok: false, error: { kind: "unavailable" } };

      const result = await work();
      if (isLive()) {
        error = result.ok ? null : result.error;
      }
      return result;
    } catch (thrown: unknown) {
      const result: WorkingSaveResult<T> = isLive()
        ? { ok: false, error: backendHostFailure(thrown) }
        : { ok: false, error: { kind: "unavailable" } };
      if (isLive() && !result.ok) error = result.error;
      return result;
    } finally {
      busy = false;
      publishIfLive();
    }
  };

  const listCities = async (): Promise<WorkingSaveResult<CitySummary[]>> => {
    if (!isLive() || host.saveStore === undefined) {
      return { ok: false, error: { kind: "unavailable" } };
    }

    return callStore("listCities", undefined, () =>
      host.saveStore!.listCities(),
    );
  };

  const save = (): Promise<WorkingSaveResult<CitySummary>> =>
    runExclusive(async () => {
      const saveStore = host.saveStore;
      const city = activeCity;
      if (saveStore === undefined) {
        return { ok: false, error: { kind: "unavailable" } };
      }
      if (city === null) {
        return { ok: false, error: { kind: "noActiveCity" } };
      }

      const captured = await host.backend.snapshotForSave();
      if (!captured.ok) {
        return { ok: false, error: { kind: "backend", error: captured.error } };
      }

      const savedAt = host.now();
      const saved = await callStore("updateCity", city.id, () =>
        saveStore.updateCity(city.id, { savedAt, snapshot: captured.snapshot }),
      );
      if (!saved.ok) return saved;
      if (!isLive()) {
        return { ok: false, error: { kind: "unavailable" } };
      }

      activeCity = saved.value;
      dirty = false;
      return saved;
    });

  const load = (cityId: string): Promise<WorkingSaveResult<CitySummary>> =>
    runExclusive(async () => {
      const saveStore = host.saveStore;
      if (saveStore === undefined) {
        return { ok: false, error: { kind: "unavailable" } };
      }

      const stored = await callStore("readCity", cityId, () =>
        saveStore.readCity(cityId),
      );
      if (!stored.ok) return stored;

      let restored: Awaited<ReturnType<GameBackend["restoreSnapshot"]>>;
      try {
        restored = await host.backend.restoreSnapshot(stored.value.snapshot);
      } catch (thrown: unknown) {
        if (isLive()) {
          activeCity = null;
          dirty = false;
        }
        return { ok: false, error: backendHostFailure(thrown) };
      }

      if (!restored.ok) {
        return { ok: false, error: { kind: "backend", error: restored.error } };
      }
      if (!isLive()) {
        return { ok: false, error: { kind: "unavailable" } };
      }

      host.installRestoredGameplay(restored.snapshot);
      activeCity = { ...stored.value.city, savedAt: stored.value.savedAt };
      dirty = false;
      return { ok: true, value: activeCity };
    });

  const createCity = (
    request: NewCityRequest,
  ): Promise<WorkingSaveResult<CitySummary>> =>
    runExclusive(async () => {
      const saveStore = host.saveStore;
      if (saveStore === undefined) {
        return { ok: false, error: { kind: "unavailable" } };
      }

      const candidate = await host.backend.buildSandboxSnapshot(
        request.sandbox,
      );
      if (!candidate.ok) {
        return {
          ok: false,
          error: { kind: "sandbox", error: candidate.error },
        };
      }

      const createdAt = host.now();
      const cityId = host.createCityId();
      const created = await callStore("createCity", cityId, () =>
        saveStore.createCity({
          city: { id: cityId, name: request.name, createdAt },
          savedAt: createdAt,
          snapshot: candidate.snapshot,
        }),
      );
      if (!created.ok) return created;

      let restored: Awaited<ReturnType<GameBackend["restoreSnapshot"]>>;
      try {
        restored = await host.backend.restoreSnapshot(candidate.snapshot);
      } catch (thrown: unknown) {
        if (isLive()) {
          activeCity = null;
          dirty = false;
        }
        return { ok: false, error: backendHostFailure(thrown) };
      }

      if (!restored.ok) {
        return { ok: false, error: { kind: "backend", error: restored.error } };
      }
      if (!isLive()) {
        return { ok: false, error: { kind: "unavailable" } };
      }

      host.installRestoredGameplay(restored.snapshot);
      activeCity = created.value;
      dirty = false;
      return created;
    });

  const renameCity = (
    cityId: string,
    name: string,
  ): Promise<WorkingSaveResult<CitySummary>> =>
    runExclusive(async () => {
      const saveStore = host.saveStore;
      if (saveStore === undefined) {
        return { ok: false, error: { kind: "unavailable" } };
      }

      const renamed = await callStore("renameCity", cityId, () =>
        saveStore.renameCity(cityId, name),
      );
      if (!renamed.ok) return renamed;
      if (!isLive()) {
        return { ok: false, error: { kind: "unavailable" } };
      }

      if (activeCity?.id === cityId) activeCity = renamed.value;
      return renamed;
    });

  const deleteCity = (cityId: string): Promise<WorkingSaveResult<void>> =>
    runExclusive(async () => {
      const saveStore = host.saveStore;
      if (saveStore === undefined) {
        return { ok: false, error: { kind: "unavailable" } };
      }

      const deleted = await callStore("deleteCity", cityId, () =>
        saveStore.deleteCity(cityId),
      );
      if (!deleted.ok) return deleted;
      if (!isLive()) {
        return { ok: false, error: { kind: "unavailable" } };
      }

      if (activeCity?.id === cityId) {
        activeCity = null;
        dirty = false;
      }
      return deleted;
    });

  const controller: RuntimePersistenceController = {
    listCities,
    save,
    load,
    createCity,
    renameCity,
    deleteCity,
  };

  return {
    controller,
    getView: () => ({ activeCity, busy, dirty, error }),
    isBusy: () => busy,
    markDirty: () => {
      if (activeCity !== null) dirty = true;
    },
    dispose,
  };
}
