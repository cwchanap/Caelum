import type {
  SaveStore,
  SaveStoreOperation,
  StorageIdentity,
} from "../../src/persistence/saveStore";

export interface DelayedSaveStore extends SaveStore {
  defer(operation: SaveStoreOperation): void;
  waitForActive(operation: SaveStoreOperation): Promise<void>;
  releaseNext(operation: SaveStoreOperation): void;
  releaseAll(): void;
  activeCount(): number;
  mutationOrder(): SaveStoreOperation[];
}

interface DeferredGate {
  release(): void;
}

const MUTATION_OPERATIONS = new Set<SaveStoreOperation>([
  "writeWorkingSave",
  "createWorkingSave",
  "renameCity",
  "duplicateCity",
  "deleteCity",
  "restoreWorkingSaveRaw",
  "writeCheckpoint",
  "renameCheckpoint",
  "deleteCheckpoint",
  "writeAutosave",
  "deleteAutosave",
]);

export function createDelayedSaveStore(delegate: SaveStore): DelayedSaveStore {
  const deferredOperations = new Set<SaveStoreOperation>();
  const activeGates = new Map<SaveStoreOperation, DeferredGate[]>();
  const activeWaiters = new Map<SaveStoreOperation, Array<() => void>>();
  const mutations: SaveStoreOperation[] = [];
  // Forward the delegate's storage identity so two DelayedSaveStore wrappers
  // around the same underlying store share one persistence coordinator.
  const storageIdentity: StorageIdentity | undefined = delegate.storageIdentity;

  const beforeDelegate = (
    operation: SaveStoreOperation,
  ): Promise<void> | undefined => {
    if (MUTATION_OPERATIONS.has(operation)) mutations.push(operation);
    if (!deferredOperations.has(operation)) return undefined;

    return new Promise<void>((resolve) => {
      const gates = activeGates.get(operation) ?? [];
      gates.push({ release: resolve });
      activeGates.set(operation, gates);

      const waiters = activeWaiters.get(operation) ?? [];
      activeWaiters.delete(operation);
      for (const notify of waiters) notify();
    });
  };

  const delegateAfterGate = <T>(
    operation: SaveStoreOperation,
    callDelegate: () => Promise<T>,
  ): Promise<T> => {
    const gate = beforeDelegate(operation);
    return gate === undefined ? callDelegate() : gate.then(callDelegate);
  };

  const store: DelayedSaveStore = {
    ...(storageIdentity !== undefined ? { storageIdentity } : {}),
    defer(operation) {
      deferredOperations.add(operation);
    },
    waitForActive(operation) {
      if ((activeGates.get(operation)?.length ?? 0) > 0) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        const waiters = activeWaiters.get(operation) ?? [];
        waiters.push(resolve);
        activeWaiters.set(operation, waiters);
      });
    },
    releaseNext(operation) {
      const gates = activeGates.get(operation);
      const gate = gates?.shift();
      if (gate === undefined) {
        throw new Error(`No active ${operation} operation to release`);
      }
      if (gates?.length === 0) activeGates.delete(operation);
      gate.release();
    },
    releaseAll() {
      deferredOperations.clear();
      for (const gates of activeGates.values()) {
        for (const gate of gates) gate.release();
      }
      activeGates.clear();
    },
    activeCount() {
      let count = 0;
      for (const gates of activeGates.values()) count += gates.length;
      return count;
    },
    mutationOrder() {
      return [...mutations];
    },
    listCities() {
      return delegateAfterGate("listCities", () => delegate.listCities());
    },
    readWorkingSave(cityId) {
      return delegateAfterGate("readWorkingSave", () =>
        delegate.readWorkingSave(cityId),
      );
    },
    writeWorkingSave(envelope) {
      return delegateAfterGate("writeWorkingSave", () =>
        delegate.writeWorkingSave(envelope),
      );
    },
    createWorkingSave(envelope) {
      return delegateAfterGate("createWorkingSave", () =>
        delegate.createWorkingSave(envelope),
      );
    },
    renameCity(cityId, name) {
      return delegateAfterGate("renameCity", () =>
        delegate.renameCity(cityId, name),
      );
    },
    duplicateCity(sourceCityId, identity) {
      return delegateAfterGate("duplicateCity", () =>
        delegate.duplicateCity(sourceCityId, identity),
      );
    },
    deleteCity(cityId) {
      return delegateAfterGate("deleteCity", () => delegate.deleteCity(cityId));
    },
    restoreWorkingSaveRaw(cityId, value) {
      return delegateAfterGate("restoreWorkingSaveRaw", () =>
        delegate.restoreWorkingSaveRaw(cityId, value),
      );
    },
    listCheckpoints(cityId) {
      return delegateAfterGate("listCheckpoints", () =>
        delegate.listCheckpoints(cityId),
      );
    },
    readCheckpoint(cityId, checkpointId) {
      return delegateAfterGate("readCheckpoint", () =>
        delegate.readCheckpoint(cityId, checkpointId),
      );
    },
    writeCheckpoint(input) {
      return delegateAfterGate("writeCheckpoint", () =>
        delegate.writeCheckpoint(input),
      );
    },
    renameCheckpoint(cityId, checkpointId, name) {
      return delegateAfterGate("renameCheckpoint", () =>
        delegate.renameCheckpoint(cityId, checkpointId, name),
      );
    },
    deleteCheckpoint(cityId, checkpointId) {
      return delegateAfterGate("deleteCheckpoint", () =>
        delegate.deleteCheckpoint(cityId, checkpointId),
      );
    },
    listAutosaves(cityId) {
      return delegateAfterGate("listAutosaves", () =>
        delegate.listAutosaves(cityId),
      );
    },
    readAutosave(cityId, autosaveId) {
      return delegateAfterGate("readAutosave", () =>
        delegate.readAutosave(cityId, autosaveId),
      );
    },
    writeAutosave(input) {
      return delegateAfterGate("writeAutosave", () =>
        delegate.writeAutosave(input),
      );
    },
    deleteAutosave(cityId, autosaveId) {
      return delegateAfterGate("deleteAutosave", () =>
        delegate.deleteAutosave(cityId, autosaveId),
      );
    },
  };

  return store;
}
