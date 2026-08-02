import { expect, it } from "vitest";
import {
  createMemorySaveStore,
  createMemorySaveStoreFailureControls,
} from "../../../src/persistence/memorySaveStore";
import { defineSaveStoreContract } from "./saveStoreContract";
import { makeEnvelope } from "./fixtures";
import { expectOk } from "./storeTestUtils";

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
    rawWorkingRecords: true,
    reopenPersistence: false,
  },
);

it("operates without failure controls", async () => {
  const store = createMemorySaveStore();
  await expectOk(store.writeWorkingSave(makeEnvelope()));
  expect(await expectOk(store.readWorkingSave("city-1"))).toMatchObject({
    city: { id: "city-1", name: "Test City" },
  });
});
