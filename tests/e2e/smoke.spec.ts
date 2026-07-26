import { expect, test } from "@playwright/test";
import {
  buildItem,
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
  const clockReadout = topbar.locator(".readout", {
    hasText: "Clock",
  });
  const populationReadout = topbar.locator(".readout", {
    hasText: "Population",
  });
  await expect(topbar).toBeVisible();
  await expect(topbar.getByText("$120,000")).toBeVisible();
  await expect(clockReadout.getByText("Day 1 00:00")).toBeVisible();
  await expect(populationReadout.getByText("0")).toBeVisible();
  await expect(page.getByText("Standard Sandbox")).toBeVisible();
  await expect(page.getByText("Template · Crossroads")).toBeVisible();

  await expect(page.getByTestId("game-canvas-host")).toBeVisible();
  const canvas = page.locator("canvas[data-runtime-canvas='true']");
  await expect(canvas).toBeVisible();

  await openHudCategory(page, "area");
  await page.getByRole("button", { name: "Residential" }).click();
  await dragMapTiles(page, canvas, { x: 1, y: 1 }, { x: 3, y: 2 });

  await openHudCategory(page, "area");
  await page.getByRole("button", { name: "Commercial" }).click();
  await dragMapTiles(page, canvas, { x: 5, y: 1 }, { x: 7, y: 3 });

  await buildItem(page, "Commercial", "Supermarket");
  await clickMapTile(canvas, { x: 5, y: 1 });
  await expect(topbar.getByText("$112,000")).toBeVisible();

  await buildItem(page, "Residential", "Small House");
  await clickMapTile(canvas, { x: 1, y: 1 });

  await expect(topbar.getByText("$108,000")).toBeVisible();
  await expect(populationReadout.getByText("4")).toBeVisible();

  await buildItem(page, "Road", "1-Lane");
  await dragMapTiles(page, canvas, { x: 1, y: 0 }, { x: 3, y: 0 });
  await expect(topbar.getByText("$107,700")).toBeVisible();

  await buildItem(page, "Bus", "Bus Terminal");
  await page.keyboard.press("r");
  await expect(page.getByTestId("hud-tool-chip")).toHaveText("BUS TERMINAL 90");

  await page.getByRole("button", { name: "Resume" }).click();
  const clockValue = clockReadout.locator(".readout-value");
  // Poll for a real advance: the value must match the clock format AND must not
  // be the initial "Day 1 00:00" (the `(?!00:00$)` lookahead). Without the
  // lookahead an empty/transient text or the initial value could satisfy a
  // loose `.not.toBe`, false-passing the test.
  await expect
    .poll(async () => (await clockValue.textContent())?.trim() ?? "")
    .toMatch(/^Day 1 (?!00:00$)\d{2}:\d{2}$/);
  await expect(clockValue).toHaveText(/^Day 1 \d{2}:\d{2}$/);
});
