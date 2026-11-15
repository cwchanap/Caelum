import { expect, test } from "@playwright/test";
import {
  clickMapTile,
  createDefaultCity,
  dragMapTiles,
  openCommandDestination,
  runtimeSnapshot,
  selectBuildLeaf,
} from "./helpers";

test("a very long unbroken city name ellipsizes inside the Continue button", async ({
  page,
}) => {
  await createDefaultCity(page, "A".repeat(80));
  await page.reload();

  const library = page.getByTestId("city-library-screen");
  await expect(library).toBeVisible();
  const card = library.locator(".city-library-card");
  const continueButton = library.getByRole("button", { name: /Continue/ });
  await expect(continueButton).toBeVisible();

  // The button stays inside the card and clips the unbroken name instead of
  // overflowing it.
  const cardBox = await card.boundingBox();
  const buttonBox = await continueButton.boundingBox();
  expect(cardBox).not.toBeNull();
  expect(buttonBox).not.toBeNull();
  expect(buttonBox!.x).toBeGreaterThanOrEqual(cardBox!.x);
  expect(buttonBox!.x + buttonBox!.width).toBeLessThanOrEqual(
    cardBox!.x + cardBox!.width + 1,
  );
  expect(
    await continueButton.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    ),
  ).toBe(true);
});

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

  const library = page.getByTestId("city-library-screen");
  await expect(library).toBeVisible();

  // Illustrated key art and live brand on the library screen.
  await expect(library).toHaveCSS("background-image", /city-library\.webp/);
  await expect(library.getByText("Caelum", { exact: true })).toBeVisible();
  await expect(library.locator("img[src*='app-icon']")).toBeVisible();

  await expect(
    page.getByRole("textbox", { name: "Rename Browser Smoke A" }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Rename Browser Smoke B" }),
  ).toBeVisible();

  // Every row shows a colored initial avatar and its saved timestamp. City
  // names live only in the rename textbox's accessible name, never as row
  // text, so rows must be selected by that descendant textbox.
  const rowA = page.locator("[data-testid^='city-row-']").filter({
    has: page.getByRole("textbox", {
      name: "Rename Browser Smoke A",
      exact: true,
    }),
  });
  const rowB = page.locator("[data-testid^='city-row-']").filter({
    has: page.getByRole("textbox", {
      name: "Rename Browser Smoke B",
      exact: true,
    }),
  });
  const rowAId = await rowA.getAttribute("data-testid");
  expect(rowAId).toMatch(/^city-row-/);
  const avatarA = page.getByTestId(rowAId!).getByTestId("city-avatar");
  await expect(avatarA).toHaveText("B");
  await expect(rowB.getByTestId("city-avatar")).toHaveText("B");
  await expect(rowA.locator("time")).toBeVisible();
  await expect(rowB.locator("time")).toBeVisible();

  // Renaming updates the initial, but the avatar color stays derived from
  // the stable city id, not the editable name.
  const colorBeforeRename = await avatarA.evaluate(
    (element) => element.style.backgroundColor,
  );
  expect(colorBeforeRename).not.toBe("");
  const renameA = page.getByRole("textbox", { name: "Rename Browser Smoke A" });
  await renameA.fill("Zephyr Smoke");
  await renameA.press("Enter");
  await expect(avatarA).toHaveText("Z");
  expect(
    await avatarA.evaluate((element) => element.style.backgroundColor),
  ).toBe(colorBeforeRename);

  // Continue names the actual newest saved city; the two saved cities keep
  // distinct names so a hard-coded label cannot pass.
  await page.getByRole("button", { name: "Continue Browser Smoke B" }).click();
  await openCommandDestination(page, "city");
  await expect(page.getByTestId("active-city-name")).toHaveText(
    "Browser Smoke B",
  );

  await page.getByRole("button", { name: "Load Zephyr Smoke" }).click();
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
      activeCity: "Zephyr Smoke",
      busy: false,
      activeCommandDestination: null,
    });
  await openCommandDestination(page, "city");
  await expect(page.getByTestId("active-city-name")).toHaveText("Zephyr Smoke");

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

  // Confirmed two-click Delete removes the other saved city from the list.
  await openCommandDestination(page, "city");
  const rowBPanel = page.locator("[data-testid^='city-row-']").filter({
    has: page.getByRole("textbox", {
      name: "Rename Browser Smoke B",
      exact: true,
    }),
  });
  const deleteB = rowBPanel.getByRole("button", { name: "Delete" });
  await deleteB.click();
  await expect(deleteB).toHaveText("Delete?");
  await deleteB.click();
  await expect(rowBPanel).toHaveCount(0);
});
