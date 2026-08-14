import { expect, test } from "@playwright/test";
import { runtimeSnapshot } from "./helpers";

interface StoredCityRecord {
  city: { id: string; name: string };
  snapshot: { budget: number; schemaVersion: number };
}

test("creates a default city through real WASM and IndexedDB", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("new-city-screen")).toBeVisible();

  const before = await runtimeSnapshot(page);
  expect(before.persistence.activeCity).toBeNull();
  const rustDefaults = {
    budget: before.state.budget,
    startingCapital: before.state.rules.sandbox.startingCapital,
    demandMultiplier: before.state.rules.sandbox.demandMultiplier,
  };

  const cityName = "IndexedDB Smoke";
  await page.getByLabel("City name").fill(cityName);
  await page.getByRole("button", { name: "Create City" }).click();
  await expect(page.getByTestId("game-canvas-host")).toBeVisible();

  const after = await runtimeSnapshot(page);
  expect(after.persistence.activeCity).toMatchObject({ name: cityName });
  expect(after.persistence.busy).toBe(false);
  expect(after.persistence.dirty).toBe(false);
  expect(after.state.paused).toBe(true);
  expect({
    budget: after.state.budget,
    startingCapital: after.state.rules.sandbox.startingCapital,
    demandMultiplier: after.state.rules.sandbox.demandMultiplier,
  }).toEqual(rustDefaults);

  const cityId = after.persistence.activeCity!.id;
  const stored = await page.evaluate(
    async ({ cityId, cityName }) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("caelum-city-saves-v1", 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const records = await new Promise<StoredCityRecord[]>(
        (resolve, reject) => {
          const transaction = database.transaction("cities", "readonly");
          const request = transaction.objectStore("cities").getAll();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        },
      );
      database.close();
      return (
        records.find(
          (record) =>
            record?.city?.id === cityId && record?.city?.name === cityName,
        ) ?? null
      );
    },
    { cityId, cityName },
  );

  expect(stored).not.toBeNull();
  expect(stored!).toMatchObject({ city: { id: cityId, name: cityName } });
  expect(stored!.snapshot.budget).toBe(after.state.budget);
  expect(stored!.snapshot.schemaVersion).toBe(after.state.schemaVersion);
});
