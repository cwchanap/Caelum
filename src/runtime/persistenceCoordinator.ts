import type {
  CitySummary,
  CitySaveStoreError,
} from "../persistence/citySaveStore";
import type { RuntimeSnapshot } from "./types";
import type {
  PersistenceOperationError,
  SandboxCreationError,
  SandboxCreationRequest,
} from "./backend";

export type PersistenceCoordinatorOperation =
  | "saveWorking"
  | "renameActiveCity"
  | "loadCity"
  | "activateNewCity"
  | "detachActiveCity";

export type NoActiveCityOperation = "saveWorking" | "renameActiveCity";

export type PersistenceCoordinatorPreconditionError =
  | { code: "noActiveCity"; operation: NoActiveCityOperation }
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
  | { kind: "store"; error: CitySaveStoreError }
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

export interface LoadCityValue {
  snapshot: RuntimeSnapshot;
  cityId: string;
}

export interface ActiveCityIdentity {
  id: string;
  name: string;
  createdAt: string;
}

export type NewCityIdentity = ActiveCityIdentity;

export type RuntimeSaveStatus =
  | { state: "idle" }
  | {
      state: "queued" | "capturing" | "writing";
      kind: "working";
      cityId: string;
    };

export type RuntimeLoadStatus =
  | { state: "idle" }
  | { state: "reading" | "restoring"; cityId: string };

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
  load(cityId: string): Promise<PersistenceOperationResult<LoadCityValue>>;
  detachActiveCity(): Promise<PersistenceOperationResult<RuntimeSnapshot>>;
  activateNewCity(
    request: SandboxCreationRequest,
    identity: NewCityIdentity,
  ): Promise<PersistenceOperationResult<LoadCityValue>>;
}

// Per-city persistence FIFO. In the runtime, FIFO tails live on the
// coordinator's lease and are reached through `PersistenceLease.enqueue`/
// `drain`; `createCityPersistenceQueues` below is a test-only standalone
// implementation of the same FIFO semantics. There is NO module-global
// `cityTails`. Queues, fences, lifecycle ownership, and session/load tokens
// are all closure-local to each runtime's coordinator. Keeping the FIFO
// instance-local prevents the cross-city-load lock cycle: a cross-city load
// that awaits the former city's drain while holding the target city's FIFO
// cannot deadlock because no other runtime can hold the former city's FIFO.
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
// Shared persistence coordinator — capability-based ownership model
// ---------------------------------------------------------------------------
//
// A `SharedPersistenceCoordinator` owns the per-city FIFO tails,
// reference-counted city fences, and an exclusive ownership lease. Each
// runtime constructs its own coordinator; coordination is per-runtime and is
// not shared across stores or runtime lifetimes.
//
// The lease is exclusive and capability-based: `acquireLease()` returns a
// `PersistenceLease` handle that is the sole channel through which a runtime
// may enqueue city FIFO work, acquire fences, or register foreground
// lifecycle operations. The coordinator tracks an `outstanding` counter per
// lease that includes both enqueued FIFO work and admitted foreground
// operations (e.g. `activateNewCity`, `detachActiveCity`). `drainAll()` on a
// lease waits for that lease's `outstanding` to reach zero, so disposal
// waits for already-admitted foreground workflows — not only their eventual
// store writes.
//
// When disposal begins, the lease is atomically marked closing via
// `beginClosing()`. After closing:
//   - `enqueue` rejects (the work is never executed);
//   - `admitForeground` returns false (the foreground workflow must bail
//     out, not proceed to a store write);
//   - `acquireCityFence` is rejected (no new fence mutations).
// Already-admitted foreground operations and already-enqueued FIFO work
// continue to drain. `releaseCityFence` and `isCityFenced` remain callable
// on a closing lease so cleanup (finally blocks) can release fences
// previously acquired while the lease was open.
//
// Within a single coordinator, ownership transfers only when `drainAll()`
// resolves (all outstanding work for this lease has settled) and `release()`
// is called. This guarantees the central lease invariant: after a successor
// lease is acquired on the same coordinator, the predecessor lease is closed
// and cannot submit any new coordinator work, mutate shared fences, or
// publish successful results.
//
// If an uncancellable store or backend operation never settles,
// `drainAll()` never resolves and the lease is never released until that
// operation settles.

/**
 * Error thrown when an operation is attempted on a closed lease. This is a
 * defense-in-depth invariant violation: correct runtime code checks `dead`
 * before calling `enqueue` or `admitForeground`, so this error should never
 * be reached in production. It exists so that a missed `dead` check fails
 * loudly instead of silently executing work after ownership transfer.
 */
export class PersistenceLeaseClosedError extends Error {
  constructor(operation: string) {
    super(`Persistence lease is closed: ${operation}`);
    this.name = "PersistenceLeaseClosedError";
  }
}

export interface PersistenceLease {
  /** Whether this lease has been marked closing. Once true, no new work may
   *  be admitted through this lease. */
  readonly isClosed: boolean;
  /** Enqueue work into the per-city FIFO. Rejects if the lease is closed. */
  enqueue<T>(cityId: string, work: () => Promise<T>): Promise<T>;
  /** Await the tail of a city's FIFO. Always callable (draining existing
   *  work is safe on a closing lease). */
  drain(cityId: string): Promise<void>;
  /** Wait for all outstanding work (enqueued + foreground) on this lease.
   *  Always callable. */
  drainAll(): Promise<void>;
  /** Acquire a reference-counted city fence. Throws if the lease is closed
   *  (no new fence mutations after disposal begins). */
  acquireCityFence(cityId: string): void;
  /** Release a city fence. Always callable (cleanup in finally blocks). */
  releaseCityFence(cityId: string): void;
  /** Check if a city is fenced. Always callable. */
  isCityFenced(cityId: string): boolean;
  /** Register a foreground lifecycle operation (e.g. activateNewCity,
   *  detachActiveCity) as outstanding so `drainAll` waits for it. Returns
   *  true if admitted, false if the lease is closing/closed. The caller
   *  must call `releaseForeground` exactly once in its final cleanup. */
  admitForeground(): boolean;
  /** Unregister a foreground lifecycle operation. Always callable (cleanup
   *  in finally blocks). */
  releaseForeground(): void;
  /** Atomically mark the lease as closing. No new work may be admitted
   *  through this lease after this call. Idempotent. */
  beginClosing(): void;
  /** Release the lease, transferring ownership to the next waiter in the
   *  coordinator's lease queue. Must only be called after `drainAll` has
   *  resolved. */
  release(): void;
}

export interface SharedPersistenceCoordinator {
  acquireLease(): Promise<PersistenceLease>;
}

export function createSharedPersistenceCoordinator(): SharedPersistenceCoordinator {
  // Shared state across lease lifetimes: city FIFO tails and fences persist
  // so a replacement lease sees the same durable-storage coordination state.
  const cityTails = new Map<string, Promise<void>>();
  const fencedCities = new Map<string, number>();
  let leaseHolder = false;
  const leaseQueue: Array<(lease: PersistenceLease) => void> = [];

  const createLease = (): PersistenceLease => {
    // Per-lease outstanding counter: tracks both enqueued FIFO work and
    // admitted foreground operations. `drainAll` waits for this to reach
    // zero, so disposal waits for foreground workflows that have not yet
    // reached their store enqueue.
    let outstanding = 0;
    let closed = false;
    let released = false;
    let idleResolvers: Array<() => void> = [];

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

    const lease: PersistenceLease = {
      get isClosed(): boolean {
        return closed;
      },
      enqueue<T>(cityId: string, work: () => Promise<T>): Promise<T> {
        if (closed) {
          return Promise.reject(new PersistenceLeaseClosedError("enqueue"));
        }
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
        if (closed) {
          throw new PersistenceLeaseClosedError("acquireCityFence");
        }
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
      admitForeground(): boolean {
        if (closed) return false;
        trackStart();
        return true;
      },
      releaseForeground(): void {
        trackEnd();
      },
      beginClosing(): void {
        closed = true;
      },
      release(): void {
        if (released) return;
        released = true;
        const next = leaseQueue.shift();
        if (next === undefined) {
          leaseHolder = false;
        } else {
          // Hand off a FRESH open capability. The released lease has been
          // marked closing by `beginClosing()`; passing it on would give
          // the next owner a closed lease whose `enqueue`/`acquireCityFence`
          // reject and whose further handoffs would keep circulating the
          // same closed capability. Each ownership generation must receive
          // its own distinct open lease.
          next(createLease());
        }
      },
    };
    return lease;
  };

  return {
    acquireLease(): Promise<PersistenceLease> {
      if (!leaseHolder) {
        leaseHolder = true;
        return Promise.resolve(createLease());
      }
      return new Promise<PersistenceLease>((resolve) => {
        leaseQueue.push((lease) => {
          leaseHolder = true;
          resolve(lease);
        });
      });
    },
  };
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

export function runtimeUnavailable(
  operation: PersistenceCoordinatorOperation,
): PersistenceOperationResult<never> {
  return preconditionFailure({ code: "runtimeUnavailable", operation });
}
