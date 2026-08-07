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

describe("MemoryCitySaveStore failure injection", () => {
  it("returns a failed listCities result with no cityId", async () => {
    const failures = createMemoryCitySaveStoreFailureControls();
    const store = createMemoryCitySaveStore({ failures });
    failures.failNext("listCities", "failed");

    const result = await store.listCities();
    expect(result).toMatchObject({
      ok: false,
      error: {
        operation: "listCities",
        code: "failed",
        diagnostic: "listCities failed",
      },
    });
    // A listCities failure carries no cityId (the operation is not per-city).
    if (result.ok) throw new Error("expected failure");
    expect(result.error.cityId).toBeUndefined();
  });
});
