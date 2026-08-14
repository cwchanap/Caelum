import { expect, test } from "@playwright/test";
import {
  selectBuildLeaf,
  clickMapTile,
  createDefaultCity,
  dragMapTiles,
  openCommandDestination,
  selectTool,
} from "./helpers";

test("loads the svelte shell and supports area painting and zoned buildings", async ({
  page,
}) => {
  await createDefaultCity(page);

  await expect(page.getByTestId("game-shell")).toBeVisible();
  const topbar = page.getByTestId("topbar");
  const timeReadout = topbar.locator(".readout", {
    hasText: "Time",
  });
  const populationReadout = topbar.locator(".readout", {
    hasText: "Population",
  });
  await expect(topbar).toBeVisible();
  await expect(topbar.getByText("$120,000")).toBeVisible();
  await expect(timeReadout.getByText("Day 1 00:00")).toBeVisible();
  await expect(populationReadout.getByText("0")).toBeVisible();
  await openCommandDestination(page, "city");
  const city = page.getByTestId("panel-city");
  await expect(city.getByText("Standard Sandbox")).toBeVisible();
  await expect(city.getByText("Crossroads")).toBeVisible();

  await expect(page.getByTestId("game-canvas-host")).toBeVisible();
  const canvas = page.locator("canvas[data-runtime-canvas='true']");
  await expect(canvas).toBeVisible();

  await selectBuildLeaf(page, "zones", "residential");
  await dragMapTiles(page, canvas, { x: 1, y: 1 }, { x: 3, y: 2 });

  await selectBuildLeaf(page, "zones", "commercial");
  await dragMapTiles(page, canvas, { x: 5, y: 1 }, { x: 7, y: 3 });

  await selectBuildLeaf(page, "buildings", "supermarket");
  await clickMapTile(canvas, { x: 5, y: 1 });
  await expect(topbar.getByText("$112,000")).toBeVisible();

  await selectBuildLeaf(page, "buildings", "smallHouse");
  await clickMapTile(canvas, { x: 1, y: 1 });

  await expect(topbar.getByText("$108,000")).toBeVisible();
  await expect(populationReadout.getByText("0")).toBeVisible();

  await selectTool(page, "select");
  await clickMapTile(canvas, { x: 5, y: 1 });
  const inspector = page.getByTestId("panel-inspect");
  await expect(inspector.getByTestId("building-panel")).toBeVisible();
  await expect(inspector.getByText("Jobs 0 / 4")).toBeVisible();

  await clickMapTile(canvas, { x: 1, y: 1 });
  await expect(inspector.getByText("Residents 0 / 4")).toBeVisible();

  await selectBuildLeaf(page, "roads", "road-twoWay");
  await dragMapTiles(page, canvas, { x: 1, y: 0 }, { x: 3, y: 0 });
  await expect(topbar.getByText("$107,700")).toBeVisible();

  await selectBuildLeaf(page, "transit", "busTerminal");
  await page.keyboard.press("r");
  await expect(
    page
      .getByTestId("command-active-mode")
      .locator(".command-shelf__mode-value"),
  ).toHaveText("BUS TERMINAL 90");

  await page.getByRole("button", { name: "Resume" }).click();
  const populationValue = populationReadout.locator(".readout-value");
  await expect
    .poll(async () => (await populationValue.textContent())?.trim() ?? "")
    .toBe("1");
  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByRole("button", { name: "Resume" })).toBeVisible();

  await selectTool(page, "select");
  await clickMapTile(canvas, { x: 1, y: 1 });
  await expect(inspector.getByText("Residents 1 / 4")).toBeVisible();
  await clickMapTile(canvas, { x: 5, y: 1 });
  await expect(inspector.getByText("Jobs 1 / 4")).toBeVisible();

  await page.getByRole("button", { name: "Resume" }).click();
  const clockValue = timeReadout.locator(".readout-value");
  // Poll for a real advance: the value must match the clock format AND must not
  // be the initial "Day 1 00:00" (the `(?!00:00$)` lookahead). Without the
  // lookahead an empty/transient text or the initial value could satisfy a
  // loose `.not.toBe`, false-passing the test.
  await expect
    .poll(async () => (await clockValue.textContent())?.trim() ?? "")
    .toMatch(/^Day 1 (?!00:00$)\d{2}:\d{2}$/);
  await expect(clockValue).toHaveText(/^Day 1 \d{2}:\d{2}$/);
});
