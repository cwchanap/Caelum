import type { GameBackend, RuntimeIdentity } from "./backend/types";

// ---------------------------------------------------------------------------
// Backend ownership coordinator — serializes runtime lifetimes by engine
// identity
// ---------------------------------------------------------------------------
//
// The persistence coordinator serializes runtime lifetimes by durable storage
// identity, but a mutable backend engine is a separate ownership domain:
//
// - a runtime may have no `SaveStore` (no persistence lease at all);
// - two stores may address one Tauri engine; and
// - separate `createTauriBackend()` facade objects still address the same
//   process-global `Mutex<GameEngine>` in the Rust host.
//
// The Tauri backend is process-global: every facade invokes commands against
// one engine. A replacement runtime that calls `backend.snapshot()` before
// the old runtime's backend operations (`dispatch`, `tick`,
// `restoreSnapshot`, `createSandbox`) have settled can observe a stale or
// mid-mutation snapshot. The persistence lease alone cannot prevent this
// because the cases above have no shared persistence coordinator (or a
// different one per store).
//
// `BackendOwnershipCoordinator` provides a simple exclusive lock keyed by
// `RuntimeIdentity`. `createGameRuntime` acquires ownership before the
// initial `backend.snapshot()` and releases it only after all old backend
// work (`gameplayQueue.drain()`) and persistence work (`lease.drainAll()`)
// have settled. This guarantees that by the time a replacement runtime can
// read the backend, the old runtime's backend operations have drained.
//
// Lock acquisition order is deterministic: backend ownership is acquired
// BEFORE the persistence lease, and released AFTER the persistence lease.
// This prevents lock cycles because no other runtime can hold the backend
// ownership while the old runtime holds it, and the persistence lease is
// always acquired and released in the same order.
//
// If `backend.runtimeIdentity` is omitted (e.g. a WASM backend whose engine
// is instance-local), the coordinator falls back to object identity via a
// `WeakMap`. This is safe for single-facade usage: two runtimes that share
// one backend object share one coordinator, while two runtimes with separate
// backend objects (and therefore separate engines) get separate coordinators.

/**
 * Handle representing exclusive ownership of a mutable backend engine.
 * Released through {@link BackendOwnership.release}.
 */
export interface BackendOwnership {
  /** Release ownership, transferring to the next waiter (if any). */
  release(): void;
}

export interface BackendOwnershipCoordinator {
  /**
   * Acquire exclusive ownership. Resolves when no other runtime holds
   * ownership of the same backend engine. If an uncancellable backend
   * operation never settles and the previous owner never releases, this
   * never resolves — safe rebootstrap cannot proceed.
   */
  acquire(): Promise<BackendOwnership>;
}

export function createBackendOwnershipCoordinator(): BackendOwnershipCoordinator {
  let held = false;
  const waitQueue: Array<() => void> = [];

  const releaseImpl = (): void => {
    const next = waitQueue.shift();
    if (next === undefined) {
      held = false;
    } else {
      next();
    }
  };

  return {
    acquire(): Promise<BackendOwnership> {
      if (!held) {
        held = true;
        return Promise.resolve({ release: releaseImpl });
      }
      return new Promise<BackendOwnership>((resolve) => {
        waitQueue.push(() => {
          held = true;
          resolve({ release: releaseImpl });
        });
      });
    },
  };
}

// Module-level registry of backend ownership coordinators keyed by
// `RuntimeIdentity`. This is NOT module-global state in the gameplay sense —
// it maps a stable engine identity to a coordinator that is only ever used by
// one runtime at a time (exclusive ownership). Different engine identities
// get different coordinators, so runtimes on different backends never
// interfere.
const backendOwnershipRegistry = new Map<
  RuntimeIdentity,
  BackendOwnershipCoordinator
>();

const objectIdentityBackendOwnership = new WeakMap<
  GameBackend,
  BackendOwnershipCoordinator
>();

/**
 * Resolve the backend ownership coordinator for a `GameBackend`.
 *
 * If the backend exposes `runtimeIdentity`, the coordinator is looked up or
 * created in the module-level registry keyed by that identity. Two facade
 * objects addressing the same engine (e.g. two `createTauriBackend()` calls
 * against one process-global Rust engine) share one coordinator.
 *
 * If the backend does not expose `runtimeIdentity`, the coordinator is looked
 * up or created in a `WeakMap` keyed by the backend object itself. This is
 * safe for single-facade usage (e.g. a WASM backend whose engine is
 * instance-local) but does not protect against two facade objects addressing
 * the same engine without a shared identity.
 */
export function resolveBackendOwnershipCoordinator(
  backend: GameBackend,
): BackendOwnershipCoordinator {
  if (backend.runtimeIdentity !== undefined) {
    let coordinator = backendOwnershipRegistry.get(backend.runtimeIdentity);
    if (coordinator === undefined) {
      coordinator = createBackendOwnershipCoordinator();
      backendOwnershipRegistry.set(backend.runtimeIdentity, coordinator);
    }
    return coordinator;
  }
  let coordinator = objectIdentityBackendOwnership.get(backend);
  if (coordinator === undefined) {
    coordinator = createBackendOwnershipCoordinator();
    objectIdentityBackendOwnership.set(backend, coordinator);
  }
  return coordinator;
}

/**
 * Test-only: reset the module-level backend ownership registry. Production
 * code never calls this. Tests use it to isolate coordinator state between
 * test cases so that runtime identities from one test do not leak into
 * another. The object-identity `WeakMap` needs no reset — entries are
 * garbage-collected when the backend object is collected.
 */
export function resetBackendOwnershipRegistry(): void {
  backendOwnershipRegistry.clear();
}
