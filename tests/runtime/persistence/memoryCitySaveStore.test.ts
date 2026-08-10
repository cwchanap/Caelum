import {
  createMemoryCitySaveStore,
  createMemoryCitySaveStoreFailureControls,
} from "../../../src/persistence/memoryCitySaveStore";
import {
  defineCitySaveStoreContract,
  expectCitySaveStoreOk,
  makeCitySaveRecord,
} from "./citySaveStoreContract";

defineCitySaveStoreContract("MemoryCitySaveStore", () =>
  createMemoryCitySaveStore(),
);

describe("MemoryCitySaveStore failure injection", () => {
  it("does not commit an injected create failure", async () => {
    const failures = createMemoryCitySaveStoreFailureControls();
    const store = createMemoryCitySaveStore({ failures });
    failures.failNext("createCity", "failed");

    expect(
      await store.createCity(makeCitySaveRecord("city-1", "First")),
    ).toMatchObject({
      ok: false,
      error: { operation: "createCity", code: "failed", cityId: "city-1" },
    });
    expect(await store.readCity("city-1")).toMatchObject({
      ok: false,
      error: { operation: "readCity", code: "notFound", cityId: "city-1" },
    });
  });

  it("preserves the prior record after an injected update failure", async () => {
    const failures = createMemoryCitySaveStoreFailureControls();
    const store = createMemoryCitySaveStore({ failures });
    const original = makeCitySaveRecord("city-1", "First");
    await expectCitySaveStoreOk(store.createCity(original));
    failures.failNext("updateCity", "failed");

    expect(
      await store.updateCity("city-1", {
        savedAt: "2026-08-02T11:00:00.000Z",
        snapshot: { budget: 90_000 },
      }),
    ).toMatchObject({
      ok: false,
      error: { operation: "updateCity", code: "failed", cityId: "city-1" },
    });
    expect(await expectCitySaveStoreOk(store.readCity("city-1"))).toEqual(
      original,
    );
  });

  it("preserves the prior record after an injected rename failure", async () => {
    const failures = createMemoryCitySaveStoreFailureControls();
    const store = createMemoryCitySaveStore({ failures });
    const original = makeCitySaveRecord("city-1", "Original");
    await expectCitySaveStoreOk(store.createCity(original));
    failures.failNext("renameCity", "failed");

    expect(await store.renameCity("city-1", "Renamed")).toMatchObject({
      ok: false,
      error: { operation: "renameCity", code: "failed", cityId: "city-1" },
    });
    expect(await expectCitySaveStoreOk(store.readCity("city-1"))).toEqual(
      original,
    );
  });

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
