import {
  createMemorySaveStore,
  createMemorySaveStoreFailureControls,
} from "../../../src/persistence/memorySaveStore";
import { defineSaveStoreContract } from "./saveStoreContract";

defineSaveStoreContract("MemorySaveStore", () => {
  const failures = createMemorySaveStoreFailureControls();
  const store = createMemorySaveStore({ failures });
  return {
    store,
    failNext: (operation, code) => failures.failNext(operation, code),
    seedRawWorking: (cityId, value) => store.seedRawWorking(cityId, value),
  };
});
