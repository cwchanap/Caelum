import {
  createMemoryCitySaveStore,
  createMemoryCitySaveStoreFailureControls,
} from "../../../src/persistence/memoryCitySaveStore";
import { defineCitySaveStoreContract } from "./citySaveStoreContract";

defineCitySaveStoreContract("MemoryCitySaveStore", () => {
  const failures = createMemoryCitySaveStoreFailureControls();
  const store = createMemoryCitySaveStore({ failures });
  return {
    store,
    failNext: (operation, code) => failures.failNext(operation, code),
  };
});
