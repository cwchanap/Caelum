import type {
  CitySaveStore,
  CitySaveStoreOperation,
} from "../../src/persistence/citySaveStore";

export interface DelayedCitySaveStore extends CitySaveStore {
  defer(operation: CitySaveStoreOperation): void;
  waitForActive(operation: CitySaveStoreOperation): Promise<void>;
  releaseNext(operation: CitySaveStoreOperation): void;
  releaseAll(): void;
  activeCount(): number;
  mutationOrder(): CitySaveStoreOperation[];
}

interface DeferredGate {
  release(): void;
}

const MUTATION_OPERATIONS = new Set<CitySaveStoreOperation>([
  "createCity",
  "updateCity",
  "renameCity",
  "deleteCity",
]);

export function createDelayedCitySaveStore(
  delegate: CitySaveStore,
): DelayedCitySaveStore {
  const deferredOperations = new Set<CitySaveStoreOperation>();
  const activeGates = new Map<CitySaveStoreOperation, DeferredGate[]>();
  const activeWaiters = new Map<CitySaveStoreOperation, Array<() => void>>();
  const mutations: CitySaveStoreOperation[] = [];

  const beforeDelegate = (
    operation: CitySaveStoreOperation,
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
    operation: CitySaveStoreOperation,
    callDelegate: () => Promise<T>,
  ): Promise<T> => {
    const gate = beforeDelegate(operation);
    return gate === undefined ? callDelegate() : gate.then(callDelegate);
  };

  return {
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
    readCity(id) {
      return delegateAfterGate("readCity", () => delegate.readCity(id));
    },
    createCity(record) {
      return delegateAfterGate("createCity", () => delegate.createCity(record));
    },
    updateCity(id, update) {
      return delegateAfterGate("updateCity", () =>
        delegate.updateCity(id, update),
      );
    },
    renameCity(id, name) {
      return delegateAfterGate("renameCity", () =>
        delegate.renameCity(id, name),
      );
    },
    deleteCity(id) {
      return delegateAfterGate("deleteCity", () => delegate.deleteCity(id));
    },
  };
}
