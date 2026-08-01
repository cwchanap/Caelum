import {
  createMemorySaveStore,
  createMemorySaveStoreFailureControls,
} from "../../../src/persistence/memorySaveStore";
import { defineSaveStoreContract } from "./saveStoreContract";

defineSaveStoreContract(
  "MemorySaveStore",
  () => {
    const failures = createMemorySaveStoreFailureControls();
    const store = createMemorySaveStore({ failures });
    return {
      store,
      failNext: (operation, code) => failures.failNext(operation, code),
      seedRawWorking: (cityId, value) => store.seedRawWorking(cityId, value),
      seedRawCheckpoint: (seed) => store.seedRawCheckpoint(seed),
      seedRawAutosave: (seed) => store.seedRawAutosave(seed),
    };
  },
  {
    injectedStorageFailures: true,
    rawGenerationRecords: true,
    reopenPersistence: false,
  },
);
