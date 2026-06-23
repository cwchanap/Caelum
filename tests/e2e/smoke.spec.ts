import { expect, test } from "@playwright/test";
import {
  clickMapTile,
  dragMapTiles,
  openHudCategory,
} from "./helpers";

test("loads the svelte shell and supports area painting and zoned buildings", async ({
  page,
}) => {
  await page.goto("/");

  await expect(page.getByTestId("game-shell")).toBeVisible();
  const topbar = page.getByTestId("topbar");
  const populationReadout = topbar.locator(".readout", {
    hasText: "Population",
  });
  await expect(topbar).toBeVisible();
  await expect(topbar.getByText("$120,000")).toBeVisible();
  await expect(populationReadout.getByText("0")).toBeVisible();
  await expect(page.getByText("Growing Suburb")).toBeVisible();

  await expect(page.getByTestId("game-canvas-host")).toBeVisible();
  const canvas = page.locator("canvas[data-runtime-canvas='true']");
  await expect(canvas).toBeVisible();

  await openHudCategory(page, "build");
  await page.getByRole("button", { name: "Residential" }).click();
  await dragMapTiles(page, canvas, { x: 1, y: 1 }, { x: 3, y: 2 });

  await openHudCategory(page, "build");
  await page.getByRole("button", { name: "Commercial" }).click();
  await dragMapTiles(page, canvas, { x: 5, y: 1 }, { x: 7, y: 3 });

  await openHudCategory(page, "build");
  await page.getByRole("button", { name: "Supermarket" }).click();
  await clickMapTile(canvas, { x: 5, y: 1 });
  await expect(topbar.getByText("$112,000")).toBeVisible();

  await openHudCategory(page, "build");
  await page.getByRole("button", { name: "Small House" }).click();
  await clickMapTile(canvas, { x: 1, y: 1 });

  await expect(topbar.getByText("$108,000")).toBeVisible();
  await expect(populationReadout.getByText("4")).toBeVisible();

  await openHudCategory(page, "build");
  await page.getByRole("button", { name: "Road", exact: true }).click();
  await dragMapTiles(page, canvas, { x: 1, y: 0 }, { x: 3, y: 0 });
  await expect(topbar.getByText("$107,700")).toBeVisible();

  await openHudCategory(page, "build");
  await page.getByRole("button", { name: "Bus Terminal" }).click();
  await page.keyboard.press("r");
  await expect(page.getByTestId("hud-tool-chip")).toHaveText("BUS TERMINAL 90");
});
