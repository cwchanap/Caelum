import { expect, test } from "@playwright/test";
import {
  clickMapTile,
  createDefaultCity,
  dragMapTiles,
  openCommandDestination,
  runtimeSnapshot,
  selectBuildLeaf,
} from "./helpers";

test("Save Now persists changed gameplay through reload and Continue", async ({
  page,
}) => {
  await createDefaultCity(page, "Browser Smoke A");

  const topbar = page.getByTestId("topbar");
  const canvas = page.locator("canvas[data-runtime-canvas='true']");

  await selectBuildLeaf(page, "zones", "residential");
  await dragMapTiles(page, canvas, { x: 5, y: 1 }, { x: 6, y: 1 });

  await selectBuildLeaf(page, "buildings", "smallHouse");
  await clickMapTile(canvas, { x: 5, y: 1 });
  await expect(topbar.getByText("$116,000")).toBeVisible();

  await selectBuildLeaf(page, "roads", "road-twoWay");
  await dragMapTiles(page, canvas, { x: 1, y: 1 }, { x: 3, y: 1 });
  await expect(topbar.getByText("$115,700")).toBeVisible();

  const timeReadout = topbar.locator(".readout", { hasText: "Time" });
  const clockValue = timeReadout.locator(".readout-value");

  await page.getByRole("button", { name: "Resume" }).click();
  await expect
    .poll(async () => (await clockValue.textContent())?.trim() ?? "")
    .toMatch(/^Day 1 (?!00:00$)\d{2}:\d{2}$/);

  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByRole("button", { name: "Resume" })).toBeVisible();

  const beforeSave = (await runtimeSnapshot(page)).state;
  const savedTime = beforeSave.time;
  expect(savedTime).toBeGreaterThan(0);
  expect(beforeSave.budget).toBe(115_700);

  await openCommandDestination(page, "city");
  const cityPanel = page.getByTestId("panel-city");

  await cityPanel.getByRole("button", { name: "Save Now" }).click();
  await expect(cityPanel.getByTestId("city-save-status")).toHaveAttribute(
    "data-dirty",
    "false",
  );

  await cityPanel.getByRole("button", { name: "New City" }).click();
  await page.getByLabel("City name").fill("Browser Smoke B");
  await page.getByRole("button", { name: "Create City" }).click();
  await expect(page.getByTestId("game-canvas-host")).toBeVisible();
  await openCommandDestination(page, "city");
  await expect(page.getByTestId("active-city-name")).toHaveText(
    "Browser Smoke B",
  );

  await page.reload();

  await expect(page.getByTestId("city-library-screen")).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Rename Browser Smoke A" }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Rename Browser Smoke B" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Continue" }).click();
  await openCommandDestination(page, "city");
  await expect(page.getByTestId("active-city-name")).toHaveText(
    "Browser Smoke B",
  );

  await page.getByRole("button", { name: "Load Browser Smoke A" }).click();
  await expect
    .poll(async () => {
      const current = await runtimeSnapshot(page);
      return {
        activeCity: current.persistence.activeCity?.name ?? null,
        busy: current.persistence.busy,
        activeCommandDestination: current.ui.activeCommandDestination,
      };
    })
    .toEqual({
      activeCity: "Browser Smoke A",
      busy: false,
      activeCommandDestination: null,
    });
  await openCommandDestination(page, "city");
  await expect(page.getByTestId("active-city-name")).toHaveText(
    "Browser Smoke A",
  );

  const restoredA = (await runtimeSnapshot(page)).state;
  const tileAt = (x: number, y: number) =>
    restoredA.map.tiles.find((tile) => tile.x === x && tile.y === y);

  expect(tileAt(1, 1)?.kind).toBe("road");
  expect(tileAt(2, 1)?.kind).toBe("road");
  expect(tileAt(3, 1)?.kind).toBe("road");
  expect([...(tileAt(2, 1)?.roadConnections ?? [])].sort()).toEqual([
    "east",
    "west",
  ]);

  expect(tileAt(5, 1)?.area).toBe("residential");
  expect(
    restoredA.buildings.some(
      (building) =>
        building.type === "smallHouse" &&
        building.origin.x === 5 &&
        building.origin.y === 1,
    ),
  ).toBe(true);

  expect(restoredA.budget).toBe(115_700);
  expect(restoredA.time).toBe(savedTime);

  await selectBuildLeaf(page, "roads", "road-twoWay");
  await dragMapTiles(page, canvas, { x: 1, y: 2 }, { x: 3, y: 2 });
  await expect(page.getByTestId("topbar").getByText("$115,400")).toBeVisible();

  const continued = (await runtimeSnapshot(page)).state;
  const continuedTileAt = (x: number, y: number) =>
    continued.map.tiles.find((tile) => tile.x === x && tile.y === y);
  expect(continuedTileAt(1, 1)?.roadConnections).toContain("south");
  expect(continuedTileAt(1, 2)?.roadConnections).toContain("north");
});
