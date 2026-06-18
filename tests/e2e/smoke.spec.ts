import { expect, test } from "@playwright/test";
import type { ViteDevServer } from "vite";
import {
  clickMapTile,
  dragMapTiles,
  openHudCategory,
  startAppServer,
} from "./helpers";

let server: ViteDevServer;
let appUrl: string;

test.beforeAll(async () => {
  ({ server, url: appUrl } = await startAppServer());
});

test.afterAll(async () => {
  await server.close();
});

test("loads the svelte shell and supports active building placement", async ({
  page,
}) => {
  await page.goto(appUrl);

  await expect(page.getByTestId("game-shell")).toBeVisible();
  const topbar = page.getByTestId("topbar");
  const populationReadout = topbar.locator(".readout", {
    hasText: "Population",
  });
  await expect(topbar).toBeVisible();
  await expect(topbar.getByText("$120,000")).toBeVisible();
  await expect(populationReadout.getByText("36")).toBeVisible();
  await expect(page.getByText("Growing Suburb")).toBeVisible();

  await expect(page.getByTestId("game-canvas-host")).toBeVisible();
  const canvas = page.locator("canvas[data-runtime-canvas='true']");
  await expect(canvas).toBeVisible();

  await openHudCategory(page, "build");
  await page.getByRole("button", { name: "Small House" }).click();
  await clickMapTile(canvas, { x: 0, y: 1 });

  await expect(topbar.getByText("$116,000")).toBeVisible();
  await expect(populationReadout.getByText("40")).toBeVisible();

  // Build a road line by dragging (road tool drag, two-way preset by default).
  await openHudCategory(page, "build");
  await page.getByRole("button", { name: "Road", exact: true }).click();
  await dragMapTiles(page, canvas, { x: 0, y: 0 }, { x: 3, y: 0 });
  // Four road tiles at $100 each: 116,000 - 400 = 115,600.
  await expect(topbar.getByText("$115,600")).toBeVisible();

  // Select a building, then rotate it with the hotkey (drawer is auto-hidden).
  await openHudCategory(page, "build");
  await page.getByRole("button", { name: "Bus Terminal" }).click();
  await page.keyboard.press("r");
  await expect(page.getByTestId("hud-tool-chip")).toHaveText("BUS TERMINAL 90");
});
