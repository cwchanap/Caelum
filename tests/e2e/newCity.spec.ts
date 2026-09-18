import { expect, test } from "@playwright/test";
import { SNAPSHOT_SCHEMA_VERSION } from "../../src/domain/types";
import { clickMapTile, runtimeSnapshot, selectTool } from "./helpers";

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
        const request = indexedDB.open("caelum-city-saves-v8", 8);
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
  expect(stored!.snapshot.schemaVersion).toBe(SNAPSHOT_SCHEMA_VERSION);
});

test("creates Small Town through the real WASM New City flow", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("new-city-screen")).toBeVisible();

  await page.getByLabel("City name").fill("Small Town Smoke");
  await page.getByLabel("Template").selectOption("smallTown");
  await page.getByRole("button", { name: "Create City" }).click();
  await expect(page.getByTestId("game-canvas-host")).toBeVisible();

  const snapshot = await runtimeSnapshot(page);
  expect(snapshot.state.rules.sandbox.templateId).toBe("smallTown");
  expect(snapshot.state.paused).toBe(true);
  expect(snapshot.state.buildings).toHaveLength(6);
  expect(snapshot.state.populationCount).toBe(0);
  expect(snapshot.state.transit.stops).toEqual([]);
  expect(snapshot.state.transit.stations).toEqual([]);
  expect(snapshot.state.transit.routes).toEqual([]);
  expect(snapshot.state.transit.metroLines).toEqual([]);
  expect(snapshot.state.transit.vehicles).toEqual([]);

  await expect(page.getByTestId("game-canvas-host")).toBeVisible();
  const topbar = page.getByTestId("topbar");
  await expect(topbar).toBeVisible();
  await expect(topbar.getByText("$120,000")).toBeVisible();
  const populationReadout = topbar.locator(".readout", {
    hasText: "Population",
  });
  await expect(populationReadout.getByText("0")).toBeVisible();

  const canvas = page.locator("canvas[data-runtime-canvas='true']");
  await selectTool(page, "select");

  const beforeSelection = await runtimeSnapshot(page);
  // Authored slot-0 move-ins are due at t=0, but the paused host must not tick
  // implicitly during mount/selection; keep this premise explicit.
  expect(beforeSelection.state.paused).toBe(true);
  expect(beforeSelection.state.populationCount).toBe(0);

  await clickMapTile(canvas, { x: 21, y: 6 });
  const inspector = page.getByTestId("panel-inspect");
  await expect(inspector.getByText("Office Tower")).toBeVisible();
  await expect(inspector.getByText("Jobs 0 / 4")).toBeVisible();
  await expect(inspector.getByTestId("workplace-status")).toHaveText(
    "Unstaffed",
  );
  await expect(inspector).toContainText(
    "Standard · 07:00–09:00 starts, 17:00–19:00 returns",
  );

  await clickMapTile(canvas, { x: 15, y: 11 });
  await expect(inspector.getByText("Factory")).toBeVisible();
  await expect(inspector.getByText("Jobs 0 / 6")).toBeVisible();
  await expect(inspector.getByTestId("workplace-status")).toHaveText(
    "Unstaffed",
  );
  await expect(inspector).toContainText("Early / late ·");
});
