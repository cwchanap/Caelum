import type {
  SaveStore,
  SaveStoreOperation,
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
  "renameCity",
  "duplicateCity",
  "deleteCity",
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

  const beforeDelegate = (operation: SaveStoreOperation): Promise<void> => {
    if (MUTATION_OPERATIONS.has(operation)) mutations.push(operation);
    if (!deferredOperations.has(operation)) return Promise.resolve();

    return new Promise<void>((resolve) => {
      const gates = activeGates.get(operation) ?? [];
      gates.push({ release: resolve });
      activeGates.set(operation, gates);

      const waiters = activeWaiters.get(operation) ?? [];
      activeWaiters.delete(operation);
      for (const notify of waiters) notify();
    });
  };

  const store: DelayedSaveStore = {
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
    async listCities() {
      await beforeDelegate("listCities");
      return delegate.listCities();
    },
    async readWorkingSave(cityId) {
      await beforeDelegate("readWorkingSave");
      return delegate.readWorkingSave(cityId);
    },
    async writeWorkingSave(envelope) {
      await beforeDelegate("writeWorkingSave");
      return delegate.writeWorkingSave(envelope);
    },
    async renameCity(cityId, name) {
      await beforeDelegate("renameCity");
      return delegate.renameCity(cityId, name);
    },
    async duplicateCity(sourceCityId, identity) {
      await beforeDelegate("duplicateCity");
      return delegate.duplicateCity(sourceCityId, identity);
    },
    async deleteCity(cityId) {
      await beforeDelegate("deleteCity");
      return delegate.deleteCity(cityId);
    },
    async listCheckpoints(cityId) {
      await beforeDelegate("listCheckpoints");
      return delegate.listCheckpoints(cityId);
    },
    async readCheckpoint(cityId, checkpointId) {
      await beforeDelegate("readCheckpoint");
      return delegate.readCheckpoint(cityId, checkpointId);
    },
    async writeCheckpoint(input) {
      await beforeDelegate("writeCheckpoint");
      return delegate.writeCheckpoint(input);
    },
    async renameCheckpoint(cityId, checkpointId, name) {
      await beforeDelegate("renameCheckpoint");
      return delegate.renameCheckpoint(cityId, checkpointId, name);
    },
    async deleteCheckpoint(cityId, checkpointId) {
      await beforeDelegate("deleteCheckpoint");
      return delegate.deleteCheckpoint(cityId, checkpointId);
    },
    async listAutosaves(cityId) {
      await beforeDelegate("listAutosaves");
      return delegate.listAutosaves(cityId);
    },
    async readAutosave(cityId, autosaveId) {
      await beforeDelegate("readAutosave");
      return delegate.readAutosave(cityId, autosaveId);
    },
    async writeAutosave(input) {
      await beforeDelegate("writeAutosave");
      return delegate.writeAutosave(input);
    },
    async deleteAutosave(cityId, autosaveId) {
      await beforeDelegate("deleteAutosave");
      return delegate.deleteAutosave(cityId, autosaveId);
    },
  };

  return store;
}
