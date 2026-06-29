import { expect, test } from "@playwright/test";
import { clickMapTile, dragMapTiles, openHudCategory } from "./helpers";

test("create, manage, and delete a bus route", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("game-shell")).toBeVisible();
  const topbar = page.getByTestId("topbar");
  const canvas = page.locator("canvas[data-runtime-canvas='true']");
  await expect(canvas).toBeVisible();

  // Lay a two-way road and place three bus stops beside it.
  await openHudCategory(page, "build");
  await page.getByRole("button", { name: "Road", exact: true }).click();
  await dragMapTiles(page, canvas, { x: 3, y: 6 }, { x: 11, y: 6 });

  await openHudCategory(page, "build");
  await page.getByRole("button", { name: "Bus Stop" }).click();
  await clickMapTile(canvas, { x: 3, y: 5 });
  await clickMapTile(canvas, { x: 7, y: 5 });
  await clickMapTile(canvas, { x: 11, y: 5 });

  // Draft a route: add three stops, remove the middle one, then finish.
  await openHudCategory(page, "routes");
  await page.getByRole("button", { name: "Bus Route" }).click();
  await clickMapTile(canvas, { x: 3, y: 5 });
  await clickMapTile(canvas, { x: 7, y: 5 });
  await clickMapTile(canvas, { x: 11, y: 5 });
  // Selecting the Bus Route tool auto-hides the drawer; reopen it to manage
  // the in-progress draft (stop list + finish/cancel actions).
  await openHudCategory(page, "routes");
  await expect(page.getByTestId("route-draft")).toBeVisible();
  await page.getByTestId("remove-draft-stop-1").click();
  await page.getByRole("button", { name: /finish route/i }).click();

  // The route now appears in the management panel.
  await openHudCategory(page, "manage");
  await expect(page.getByTestId("routes-panel")).toBeVisible();
  await expect(page.getByTestId("route-name-route-001")).toBeVisible();
  const avgWaitReadout = topbar.locator(".readout", { hasText: "Avg Wait" });
  const unservedReadout = topbar.locator(".readout", { hasText: "Unserved" });
  const lateReadout = topbar.locator(".readout", { hasText: "Late" });
  await expect(avgWaitReadout.locator(".readout-value")).toHaveText(/^\d+s$/);
  await expect(unservedReadout.locator(".readout-value")).toHaveText(/^\d+$/);
  await expect(lateReadout.locator(".readout-value")).toHaveText(/^\d+$/);

  // Toggle inactive, then delete (two clicks for confirm).
  await page.getByTestId("route-toggle-route-001").click();
  await page.getByTestId("route-delete-route-001").click();
  await page.getByTestId("route-delete-route-001").click();
  await expect(page.getByTestId("route-name-route-001")).toHaveCount(0);
});

test("create a metro line on laid track", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("game-shell")).toBeVisible();
  const canvas = page.locator("canvas[data-runtime-canvas='true']");
  await expect(canvas).toBeVisible();

  // Lay a 5-tile track run on empty ground.
  await openHudCategory(page, "build");
  await page.locator("[data-tool='track']").click();
  for (let x = 8; x <= 12; x += 1) {
    await clickMapTile(canvas, { x, y: 2 });
  }

  // Stations on the track ends (Metro Station building requires track).
  // The track tool auto-hides the build drawer; reopen it to reach buildings.
  await openHudCategory(page, "build");
  await page.getByRole("button", { name: "Metro Station" }).click();
  await clickMapTile(canvas, { x: 8, y: 2 });
  await clickMapTile(canvas, { x: 12, y: 2 });

  // Connect them with a metro line.
  await openHudCategory(page, "routes");
  await page.getByRole("button", { name: "Metro Line" }).click();
  await clickMapTile(canvas, { x: 8, y: 2 });
  await clickMapTile(canvas, { x: 12, y: 2 });
  // The Metro Line tool auto-hides the drawer; reopen it to finish the draft.
  await openHudCategory(page, "routes");
  await expect(page.getByTestId("route-draft")).toBeVisible();
  await page.getByRole("button", { name: /finish route/i }).click();

  await openHudCategory(page, "manage");
  await expect(page.getByTestId("routes-panel")).toBeVisible();
  await expect(page.getByTestId("route-name-metro-001")).toBeVisible();
});
