import { expect, test } from "@playwright/test";
import {
  clickMapTile,
  createDefaultCity,
  dragMapTiles,
  openCommandDestination,
  selectBuildLeaf,
} from "./helpers";

test("Save Now persists changed gameplay through reload and Continue", async ({
  page,
}) => {
  await createDefaultCity(page, "Reload Junction");

  const topbar = page.getByTestId("topbar");
  await expect(topbar.getByText("$120,000")).toBeVisible();

  const canvas = page.locator("canvas[data-runtime-canvas='true']");
  await selectBuildLeaf(page, "zones", "residential");
  await dragMapTiles(page, canvas, { x: 1, y: 1 }, { x: 2, y: 1 });

  await selectBuildLeaf(page, "buildings", "smallHouse");
  await clickMapTile(canvas, { x: 1, y: 1 });
  await expect(topbar.getByText("$116,000")).toBeVisible();

  await openCommandDestination(page, "city");
  const cityPanel = page.getByTestId("panel-city");
  const saveStatus = cityPanel.getByTestId("city-save-status");
  await expect(saveStatus).toHaveAttribute("data-dirty", "true");

  await cityPanel.getByRole("button", { name: "Save Now" }).click();
  await expect(saveStatus).toHaveAttribute("data-dirty", "false");

  await page.reload();

  await expect(page.getByTestId("city-library-screen")).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Rename Reload Junction" }),
  ).toHaveValue("Reload Junction");
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByTestId("game-canvas-host")).toBeVisible();
  await expect(page.getByTestId("topbar").getByText("$116,000")).toBeVisible();

  await openCommandDestination(page, "city");
  await expect(page.getByTestId("active-city-name")).toHaveText(
    "Reload Junction",
  );
});
