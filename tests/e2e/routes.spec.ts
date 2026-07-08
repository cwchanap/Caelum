import { expect, test } from "@playwright/test";
import {
  buildItem,
  clickMapTile,
  dragMapTiles,
  openHudCategory,
} from "./helpers";

// Read the live Rust-derived transit state exposed on `window` in dev mode.
// `src/main.ts` only assigns `window.__caelumRuntime` under
// `import.meta.env.DEV`, so this helper depends on the Playwright webServer
// running the Vite dev server (`bun run dev` in `playwright.config.ts`).
// Used to assert gameplay facts the DOM does not surface — here, that
// finishing a route actually assigned a vehicle in the core.
async function readRuntimeTransit(
  page: import("@playwright/test").Page,
): Promise<{
  vehicles: { id: string; lineId: string; mode: string }[];
  routes: { id: string; vehicleIds: string[] }[];
}> {
  return page.evaluate(() => {
    const runtime = (
      window as unknown as {
        __caelumRuntime?: {
          getSnapshot: () => {
            state: {
              transit: {
                vehicles: { id: string; lineId: string; mode: string }[];
                routes: { id: string; vehicleIds: string[] }[];
              };
            };
          };
        };
      }
    ).__caelumRuntime;
    if (!runtime) {
      throw new Error(
        "window.__caelumRuntime is not exposed — e2e must run against the Vite dev server " +
          "(playwright.config.ts webServer.command === 'bun run dev') because " +
          "src/main.ts only assigns the hook under import.meta.env.DEV",
      );
    }
    const transit = runtime.getSnapshot().state.transit;
    return { vehicles: transit.vehicles, routes: transit.routes };
  });
}

test("create, manage, and delete a bus route", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("game-shell")).toBeVisible();
  const topbar = page.getByTestId("topbar");
  const canvas = page.locator("canvas[data-runtime-canvas='true']");
  await expect(canvas).toBeVisible();

  // Lay a two-way road and place three bus stops beside it.
  await buildItem(page, "Road", "1-Lane");
  await dragMapTiles(page, canvas, { x: 3, y: 6 }, { x: 11, y: 6 });

  await buildItem(page, "Bus", "Bus Stop");
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
  await buildItem(page, "Rail", "Track");
  for (let x = 8; x <= 12; x += 1) {
    await clickMapTile(canvas, { x, y: 2 });
  }

  // Stations on the track ends (Metro Station building requires track).
  await buildItem(page, "Metro", "Metro Station");
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

test("finishing a bus route assigns a vehicle and runs live transit", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("game-shell")).toBeVisible();
  const topbar = page.getByTestId("topbar");
  const canvas = page.locator("canvas[data-runtime-canvas='true']");
  await expect(canvas).toBeVisible();

  // Road + three bus stops beside it.
  await buildItem(page, "Road", "1-Lane");
  await dragMapTiles(page, canvas, { x: 3, y: 6 }, { x: 11, y: 6 });

  await buildItem(page, "Bus", "Bus Stop");
  await clickMapTile(canvas, { x: 3, y: 5 });
  await clickMapTile(canvas, { x: 7, y: 5 });
  await clickMapTile(canvas, { x: 11, y: 5 });

  // Draft + finish a route over all three stops.
  await openHudCategory(page, "routes");
  await page.getByRole("button", { name: "Bus Route" }).click();
  await clickMapTile(canvas, { x: 3, y: 5 });
  await clickMapTile(canvas, { x: 7, y: 5 });
  await clickMapTile(canvas, { x: 11, y: 5 });
  await openHudCategory(page, "routes");
  await expect(page.getByTestId("route-draft")).toBeVisible();
  await page.getByRole("button", { name: /finish route/i }).click();

  // The route must appear AND the core must have assigned a vehicle to it.
  // This is the regression guard for the dropped `assignVehicle` step: without
  // it the route would have `vehicleIds: []` forever and transit could never
  // move a single citizen.
  await openHudCategory(page, "manage");
  await expect(page.getByTestId("route-name-route-001")).toBeVisible();

  const transit = await readRuntimeTransit(page);
  expect(transit.vehicles).toHaveLength(1);
  expect(transit.vehicles[0].lineId).toBe("route-001");
  expect(transit.vehicles[0].mode).toBe("bus");
  const route = transit.routes.find((r) => r.id === "route-001");
  expect(route?.vehicleIds).toHaveLength(1);

  // Unpause into a live tick and confirm the clock advances — the vehicle is
  // now part of the running simulation, not a dead route-creation artifact.
  await page.getByRole("button", { name: "Resume" }).click();
  const clockValue = topbar
    .locator(".readout", { hasText: "Clock" })
    .locator(".readout-value");
  await expect
    .poll(async () => (await clockValue.textContent())?.trim() ?? "")
    .toMatch(/^Day 1 (?!00:00$)\d{2}:\d{2}$/);
});
