import type {
  UntrustedSaveValue,
  WritableSaveEnvelope,
} from "../persistence/envelope";
import type { SaveEnvelopeError } from "../persistence/envelopeInspection";
import type {
  CitySummary,
  SaveStore,
  SaveStoreError,
  SaveStoreResult,
  StorageIdentity,
} from "../persistence/saveStore";
import type { RuntimeSnapshot } from "./types";
import type {
  PersistenceOperationError,
  SandboxCreationError,
  SandboxCreationRequest,
} from "./backend";

export type PersistenceCoordinatorOperation =
  | "saveWorking"
  | "renameActiveCity"
  | "createCheckpoint"
  | "createAutosave"
  | "loadWorking"
  | "loadCheckpoint"
  | "loadAutosave"
  | "activateNewCity"
  | "detachActiveCity";

export type NoActiveCityOperation =
  | "saveWorking"
  | "renameActiveCity"
  | "createCheckpoint"
  | "createAutosave";

export type PersistenceCoordinatorPreconditionError =
  | { code: "noActiveCity"; operation: NoActiveCityOperation }
  | { code: "activeCityDeleteRequiresTransition"; cityId: string }
  | { code: "runtimeUnavailable"; operation: PersistenceCoordinatorOperation };

export type PersistenceCoordinatorBackendError =
  | PersistenceOperationError
  | {
      kind: "host";
      operation: "createSandbox";
      code: "invokeFailed";
      diagnostic: string;
    };

export type PersistenceCoordinatorError =
  | { kind: "store"; error: SaveStoreError }
  | { kind: "envelope"; error: SaveEnvelopeError }
  | { kind: "backend"; error: PersistenceCoordinatorBackendError }
  | { kind: "sandbox"; error: SandboxCreationError }
  | {
      kind: "precondition";
      error: PersistenceCoordinatorPreconditionError;
    };

export type PersistenceOperationResult<T> =
  | { status: "completed"; value: T }
  | { status: "failed"; error: PersistenceCoordinatorError }
  | { status: "superseded" };

export interface SaveWorkingValue {
  summary: CitySummary;
  savedAt: string;
}

export interface RenameActiveCityValue {
  summary: CitySummary;
}

export type LoadSource =
  | { kind: "working"; cityId: string }
  | { kind: "checkpoint"; cityId: string; checkpointId: string }
  | { kind: "autosave"; cityId: string; autosaveId: string };

export interface LoadSourceRead {
  coordinatorOperation: "loadWorking" | "loadCheckpoint" | "loadAutosave";
  storeOperation: "readWorkingSave" | "readCheckpoint" | "readAutosave";
  read(store: SaveStore): Promise<SaveStoreResult<UntrustedSaveValue>>;
}

export function readForLoadSource(source: LoadSource): LoadSourceRead {
  switch (source.kind) {
    case "working":
      return {
        coordinatorOperation: "loadWorking",
        storeOperation: "readWorkingSave",
        read: (store) => store.readWorkingSave(source.cityId),
      };
    case "checkpoint":
      return {
        coordinatorOperation: "loadCheckpoint",
        storeOperation: "readCheckpoint",
        read: (store) =>
          store.readCheckpoint(source.cityId, source.checkpointId),
      };
    case "autosave":
      return {
        coordinatorOperation: "loadAutosave",
        storeOperation: "readAutosave",
        read: (store) => store.readAutosave(source.cityId, source.autosaveId),
      };
  }
}

export interface LoadCityValue {
  snapshot: RuntimeSnapshot;
  source: LoadSource;
}

export interface GenerationWriteValue<TSummary> {
  summary: TSummary;
}

export type GenerationWriteKind = "checkpoint" | "autosave";
export type GameplayWriteKind = "working" | GenerationWriteKind;

export interface ActiveCityIdentity {
  id: string;
  name: string;
  cityCreatedAt: string;
}

export type NewCityIdentity = ActiveCityIdentity;

export interface GameplayWriteRequest<TSummary> {
  kind: GenerationWriteKind;
  write(capture: {
    city: ActiveCityIdentity;
    envelope: WritableSaveEnvelope;
  }): Promise<SaveStoreResult<TSummary>>;
}

export type RuntimeSaveStatus =
  | { state: "idle" }
  | {
      state: "queued" | "capturing" | "writing";
      kind: GameplayWriteKind;
      cityId: string;
    };

export type RuntimeLoadStatus =
  | { state: "idle" }
  | { state: "reading" | "restoring"; source: LoadSource };

export type RuntimeLifecycleStatus =
  | { state: "idle" }
  | { state: "creatingCity" | "rollingBack" };

export interface RuntimePersistenceView {
  activeCity: ActiveCityIdentity | null;
  dirty: boolean;
  saveStatus: RuntimeSaveStatus;
  loadStatus: RuntimeLoadStatus;
  lifecycleStatus: RuntimeLifecycleStatus;
  lastSavedAt: string | null;
  error: PersistenceCoordinatorError | null;
}

export interface RuntimePersistenceController {
  saveWorking(): Promise<PersistenceOperationResult<SaveWorkingValue>>;
  renameActiveCity(
    name: string,
  ): Promise<PersistenceOperationResult<RenameActiveCityValue>>;
  load(source: LoadSource): Promise<PersistenceOperationResult<LoadCityValue>>;
  detachActiveCity(): Promise<PersistenceOperationResult<RuntimeSnapshot>>;
  activateNewCity(
    request: SandboxCreationRequest,
    identity: NewCityIdentity,
  ): Promise<PersistenceOperationResult<LoadCityValue>>;
  runGameplayWrite<TSummary>(
    request: GameplayWriteRequest<TSummary>,
  ): Promise<PersistenceOperationResult<GenerationWriteValue<TSummary>>>;
}

// Per-city persistence FIFO. Each `createGameRuntime` instance owns its own
// queue set via `createCityPersistenceQueues`; there is NO module-global
// `cityTails`. This is the single-runtime-per-store invariant: one runtime
// owns one `SaveStore`, and its queues, fences, lifecycle ownership, and
// session/load tokens are all closure-local. A second live runtime in the
// same realm MUST use a separate store — sharing one store across runtimes is
// unsupported and would let their independent queues/fences interleave writes
// at the storage layer. Keeping the FIFO instance-local (not module-global)
// is what prevents the cross-city-load lock cycle: a cross-city load that
// awaits the former city's drain while holding the target city's FIFO cannot
// deadlock, because no other runtime can hold the former city's FIFO.
export interface CityPersistenceQueues {
  enqueue<T>(cityId: string, work: () => Promise<T>): Promise<T>;
  drain(cityId: string): Promise<void>;
}

export function createCityPersistenceQueues(): CityPersistenceQueues {
  const cityTails = new Map<string, Promise<void>>();
  return {
    enqueue<T>(cityId: string, work: () => Promise<T>): Promise<T> {
      const previous = cityTails.get(cityId) ?? Promise.resolve();
      const run = previous.then(work, work);
      const tail = run.then(
        () => undefined,
        () => undefined,
      );
      cityTails.set(cityId, tail);
      return run.finally(() => {
        if (cityTails.get(cityId) === tail) cityTails.delete(cityId);
      });
    },
    drain(cityId: string): Promise<void> {
      return cityTails.get(cityId) ?? Promise.resolve();
    },
  };
}

// ---------------------------------------------------------------------------
// Shared persistence coordinator — ownership model for durable storage
// ---------------------------------------------------------------------------
//
// A `SharedPersistenceCoordinator` is keyed by `StorageIdentity` (not adapter
// object identity) and owns the per-city FIFO tails, reference-counted city
// fences, and an exclusive ownership lease. It persists across runtime
// lifetimes so that a replacement runtime against the same durable storage
// cannot race an old runtime's pending writes.
//
// The lease is exclusive: only one runtime may hold it at a time.
// `createGameRuntime` acquires the lease before the runtime becomes usable
// and releases it after all pending persistence work has drained (on fatal
// backend failure or explicit `dispose()`). A second `createGameRuntime`
// against the same storage identity waits for the lease to be released,
// which waits for the old runtime's pending writes to drain. This prevents
// the late-write race: by the time the replacement runtime can issue any
// operation (including city deletion), the old runtime's writes have
// settled.
//
// Because the lease is exclusive, the coordinator's FIFOs and fences are
// only ever accessed by one runtime at a time. The cross-city-load deadlock
// argument is unchanged from the instance-local model: within a single
// lease, no other runtime can hold the former city's FIFO while a
// cross-city load awaits it.
//
// If an uncancellable store operation never settles, `drainAll()` never
// resolves, the lease is never released, and the replacement runtime's
// `createGameRuntime` never resolves. This is the defined behavior: safe
// rebootstrap cannot proceed until pending storage I/O settles.
//
// When a `SaveStore` does not expose `storageIdentity`, the coordinator
// falls back to object identity via a `WeakMap`. This is safe for
// single-adapter usage but does not protect against two adapter objects
// targeting the same durable database.

export interface SharedPersistenceCoordinator {
  enqueue<T>(cityId: string, work: () => Promise<T>): Promise<T>;
  drain(cityId: string): Promise<void>;
  drainAll(): Promise<void>;
  acquireCityFence(cityId: string): void;
  releaseCityFence(cityId: string): void;
  isCityFenced(cityId: string): boolean;
  acquireLease(): Promise<void>;
  releaseLease(): void;
}

export function createSharedPersistenceCoordinator(): SharedPersistenceCoordinator {
  const cityTails = new Map<string, Promise<void>>();
  const fencedCities = new Map<string, number>();
  let outstanding = 0;
  let idleResolvers: Array<() => void> = [];
  let leaseHolder = false;
  const leaseQueue: Array<() => void> = [];

  const trackStart = (): void => {
    outstanding += 1;
  };
  const trackEnd = (): void => {
    outstanding -= 1;
    if (outstanding === 0) {
      const resolvers = idleResolvers;
      idleResolvers = [];
      for (const resolve of resolvers) resolve();
    }
  };

  return {
    enqueue<T>(cityId: string, work: () => Promise<T>): Promise<T> {
      const previous = cityTails.get(cityId) ?? Promise.resolve();
      trackStart();
      const run = previous.then(work, work);
      const tail = run.then(
        () => undefined,
        () => undefined,
      );
      cityTails.set(cityId, tail);
      return run.finally(() => {
        if (cityTails.get(cityId) === tail) cityTails.delete(cityId);
        trackEnd();
      });
    },
    drain(cityId: string): Promise<void> {
      return cityTails.get(cityId) ?? Promise.resolve();
    },
    drainAll(): Promise<void> {
      if (outstanding === 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        idleResolvers.push(resolve);
      });
    },
    acquireCityFence(cityId: string): void {
      fencedCities.set(cityId, (fencedCities.get(cityId) ?? 0) + 1);
    },
    releaseCityFence(cityId: string): void {
      const next = (fencedCities.get(cityId) ?? 0) - 1;
      if (next <= 0) fencedCities.delete(cityId);
      else fencedCities.set(cityId, next);
    },
    isCityFenced(cityId: string): boolean {
      return fencedCities.has(cityId);
    },
    acquireLease(): Promise<void> {
      if (!leaseHolder) {
        leaseHolder = true;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        leaseQueue.push(() => {
          leaseHolder = true;
          resolve();
        });
      });
    },
    releaseLease(): void {
      const next = leaseQueue.shift();
      if (next === undefined) {
        leaseHolder = false;
      } else {
        next();
      }
    },
  };
}

// Module-level registry of shared coordinators keyed by storage identity.
// This is NOT the old module-global `cityTails`: it maps a stable storage
// identity to a coordinator that is only ever used by one runtime at a time
// (exclusive lease). Different storage identities get different
// coordinators, so runtimes on different stores never interfere.
const coordinatorRegistry = new Map<
  StorageIdentity,
  SharedPersistenceCoordinator
>();

const objectIdentityCoordinators = new WeakMap<
  SaveStore,
  SharedPersistenceCoordinator
>();

/**
 * Resolve the shared persistence coordinator for a `SaveStore`.
 *
 * If the store exposes `storageIdentity`, the coordinator is looked up or
 * created in the module-level registry keyed by that identity. Two adapter
 * objects targeting the same durable database (and thus exposing the same
 * identity) share one coordinator.
 *
 * If the store does not expose `storageIdentity`, the coordinator is looked
 * up or created in a `WeakMap` keyed by the store object itself. This is
 * safe for single-adapter usage but does not protect against two adapter
 * objects targeting the same durable database.
 */
export function resolvePersistenceCoordinator(
  store: SaveStore,
): SharedPersistenceCoordinator {
  if (store.storageIdentity !== undefined) {
    let coordinator = coordinatorRegistry.get(store.storageIdentity);
    if (coordinator === undefined) {
      coordinator = createSharedPersistenceCoordinator();
      coordinatorRegistry.set(store.storageIdentity, coordinator);
    }
    return coordinator;
  }
  let coordinator = objectIdentityCoordinators.get(store);
  if (coordinator === undefined) {
    coordinator = createSharedPersistenceCoordinator();
    objectIdentityCoordinators.set(store, coordinator);
  }
  return coordinator;
}

/**
 * Test-only: reset the module-level coordinator registry. Production code
 * never calls this. Tests use it to isolate coordinator state between test
 * cases so that storage identities from one test do not leak into another.
 */
export function resetPersistenceCoordinatorRegistry(): void {
  coordinatorRegistry.clear();
}

export function resolveWorkingSaveCompletion(input: {
  currentCityId: string | null;
  currentSessionToken: number;
  persistedRevision: number;
  capturedCityId: string;
  capturedSessionToken: number;
  capturedRevision: number;
}):
  | { status: "current"; persistedRevision: number }
  | { status: "superseded" } {
  const session = resolvePersistenceSessionCompletion(input);
  if (session.status === "superseded") {
    return { status: "superseded" };
  }
  return {
    status: "current",
    persistedRevision: Math.max(
      input.persistedRevision,
      input.capturedRevision,
    ),
  };
}

export function resolvePersistenceSessionCompletion(input: {
  currentCityId: string | null;
  currentSessionToken: number;
  capturedCityId: string;
  capturedSessionToken: number;
}): { status: "current" } | { status: "superseded" } {
  return input.currentCityId === input.capturedCityId &&
    input.currentSessionToken === input.capturedSessionToken
    ? { status: "current" }
    : { status: "superseded" };
}

function preconditionFailure(
  error: PersistenceCoordinatorPreconditionError,
): PersistenceOperationResult<never> {
  return { status: "failed", error: { kind: "precondition", error } };
}

export function noActiveCity(
  operation: NoActiveCityOperation,
): PersistenceOperationResult<never> {
  return preconditionFailure({ code: "noActiveCity", operation });
}

export function activeCityDeleteRequiresTransition(
  cityId: string,
): PersistenceOperationResult<never> {
  return preconditionFailure({
    code: "activeCityDeleteRequiresTransition",
    cityId,
  });
}

export function guardActiveCityDelete(
  activeCity: ActiveCityIdentity | null,
  cityId: string,
): PersistenceOperationResult<never> | null {
  return activeCity?.id === cityId
    ? activeCityDeleteRequiresTransition(cityId)
    : null;
}

export function runtimeUnavailable(
  operation: PersistenceCoordinatorOperation,
): PersistenceOperationResult<never> {
  return preconditionFailure({ code: "runtimeUnavailable", operation });
}
