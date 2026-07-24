import { expect, test } from "@playwright/test";
import type { MovementKind, RouteLegPath } from "../../src/domain/types";
import { tileSize } from "../../src/render/canvas";
import { colors } from "../../src/render/colors";
import {
  buildItem,
  clickMapTile,
  debugSetBudget,
  dragMapTiles,
  openHudCategory,
  rebuildRoadTile,
  removeMapTile,
  runtimeSnapshot,
} from "./helpers";

const TURN_ROUTE_STOPS = [
  { x: 7, y: 3 },
  { x: 9, y: 5 },
] as const;
const EXTRA_TURN_STOP = { x: 12, y: 3 } as const;
const DAMAGE_ROUTE_STOPS = [
  { x: 4, y: 3 },
  { x: 12, y: 3 },
] as const;
const SIMPLE_ROUTE_STOPS = [
  { x: 3, y: 3 },
  { x: 7, y: 3 },
  { x: 11, y: 3 },
] as const;
const DRAFT_ROUTE_STOPS = SIMPLE_ROUTE_STOPS.slice(0, 2);
const PRIMARY_ROAD_TILE = { x: 8, y: 4 } as const;
const ALTERNATE_ROAD_TILE = { x: 8, y: 6 } as const;

interface CanvasFillRectRecord {
  x: number;
  y: number;
  width: number;
  height: number;
  fillStyle: string;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const fillRects: CanvasFillRectRecord[] = [];
    const originalFillRect = CanvasRenderingContext2D.prototype.fillRect;
    Object.defineProperty(window, "__caelumCanvasTrace", {
      configurable: true,
      value: { fillRects },
    });
    CanvasRenderingContext2D.prototype.fillRect = function (
      x,
      y,
      width,
      height,
    ) {
      fillRects.push({
        x,
        y,
        width,
        height,
        fillStyle: String(this.fillStyle),
      });
      return originalFillRect.call(this, x, y, width, height);
    };
  });
});

function roadMovements(leg: RouteLegPath): MovementKind[] {
  return leg.currentPath?.kind === "road"
    ? leg.currentPath.steps.map((step) => step.movement)
    : [];
}

async function expectRoadsideStopAnchors(
  page: import("@playwright/test").Page,
  positions: readonly { x: number; y: number }[],
): Promise<void> {
  await expect
    .poll(async () => {
      const snapshot = await runtimeSnapshot(page);
      return positions.map((position) => {
        const stop = snapshot.state.transit.stops.find(
          (candidate) =>
            candidate.status === "present" &&
            candidate.position.x === position.x &&
            candidate.position.y === position.y,
        );
        const anchorTile = snapshot.state.map.tiles.find(
          (tile) => tile.x === stop?.position.x && tile.y === stop?.position.y,
        );
        const accessTile = snapshot.state.map.tiles.find(
          (tile) =>
            tile.x === stop?.roadAccess?.roadPoint.x &&
            tile.y === stop?.roadAccess?.roadPoint.y,
        );
        return {
          position: stop?.position ?? null,
          anchorKind: anchorTile?.kind ?? null,
          accessKind: accessTile?.kind ?? null,
        };
      });
    })
    .toEqual(
      positions.map((position) => ({
        position,
        anchorKind: "empty",
        accessKind: "road",
      })),
    );

  const snapshot = await runtimeSnapshot(page);
  const anchors = positions.map((position) => {
    const stop = snapshot.state.transit.stops.find(
      (candidate) =>
        candidate.status === "present" &&
        candidate.position.x === position.x &&
        candidate.position.y === position.y,
    );
    if (stop?.roadAccess === undefined) {
      throw new Error(
        `Missing road access for stop at ${position.x},${position.y}`,
      );
    }
    return {
      passenger: stop.position,
      road: stop.roadAccess.roadPoint,
    };
  });

  await page.evaluate(() => {
    const trace = (
      window as unknown as {
        __caelumCanvasTrace?: { fillRects: CanvasFillRectRecord[] };
      }
    ).__caelumCanvasTrace;
    if (trace === undefined) {
      throw new Error("Canvas render trace is unavailable");
    }
    trace.fillRects.length = 0;
    const runtime = (
      window as unknown as {
        __caelumRuntime?: {
          setHoverTile: (point: { x: number; y: number } | null) => void;
        };
      }
    ).__caelumRuntime;
    runtime?.setHoverTile({ x: 0, y: 0 });
    runtime?.setHoverTile(null);
  });

  await expect
    .poll(async () =>
      page.evaluate(
        ({ anchors, busColor, size }) => {
          const trace = (
            window as unknown as {
              __caelumCanvasTrace?: { fillRects: CanvasFillRectRecord[] };
            }
          ).__caelumCanvasTrace;
          if (trace === undefined) {
            throw new Error("Canvas render trace is unavailable");
          }
          const stopMarkers = trace.fillRects.filter(
            (rect) =>
              rect.fillStyle === busColor &&
              rect.width === 10 &&
              rect.height === 10,
          );
          const markerAt = (point: { x: number; y: number }) =>
            stopMarkers.some(
              (rect) =>
                rect.x === point.x * size + 11 &&
                rect.y === point.y * size + 11,
            );
          return {
            passengerMarkers: anchors.every(({ passenger }) =>
              markerAt(passenger),
            ),
            roadMarkers: anchors.some(({ road }) => markerAt(road)),
          };
        },
        { anchors, busColor: colors.bus, size: tileSize },
      ),
    )
    .toEqual({ passengerMarkers: true, roadMarkers: false });
}

async function waitForRoutePreview(
  page: import("@playwright/test").Page,
  waypointCount: number,
): Promise<number> {
  await expect
    .poll(async () => {
      const draft = (await runtimeSnapshot(page)).ui.routeDraft;
      return {
        waypointCount: draft?.waypointIds.length ?? -1,
        pending: draft?.previewPending ?? true,
        previewMatchesDraft:
          draft?.preview?.generation === draft?.generation &&
          draft?.preview !== null,
      };
    })
    .toEqual({
      waypointCount,
      pending: false,
      previewMatchesDraft: true,
    });
  return (await runtimeSnapshot(page)).ui.routeDraft!.generation;
}

async function seedRouteWithPrimaryAndAlternateRoad(
  page: import("@playwright/test").Page,
): Promise<void> {
  const canvas = page.locator("canvas[data-runtime-canvas='true']");
  await buildItem(page, "Road", "1-Lane");
  await dragMapTiles(page, canvas, { x: 3, y: 4 }, { x: 13, y: 4 });
  await buildItem(page, "Road", "1-Lane");
  await dragMapTiles(page, canvas, { x: 3, y: 6 }, { x: 13, y: 6 });
  await buildItem(page, "Road", "1-Lane");
  await dragMapTiles(page, canvas, { x: 3, y: 4 }, { x: 3, y: 6 });
  await buildItem(page, "Road", "1-Lane");
  await dragMapTiles(page, canvas, { x: 13, y: 4 }, { x: 13, y: 6 });
  await buildItem(page, "Bus", "Bus Stop");
  for (const stop of DAMAGE_ROUTE_STOPS) {
    await clickMapTile(canvas, stop);
  }
  await expectRoadsideStopAnchors(page, DAMAGE_ROUTE_STOPS);
}

async function createDamageRoute(
  page: import("@playwright/test").Page,
): Promise<void> {
  const canvas = page.locator("canvas[data-runtime-canvas='true']");
  await openHudCategory(page, "routes");
  await page.getByRole("button", { name: "Bus Route" }).click();
  for (const stop of DAMAGE_ROUTE_STOPS) {
    await clickMapTile(canvas, stop);
  }
  await openHudCategory(page, "routes");
  await page.getByRole("radio", { name: "Loop" }).check();
  await page.getByRole("button", { name: "Save route" }).click();
}

async function newestBusRoute(page: import("@playwright/test").Page) {
  const snapshot = await runtimeSnapshot(page);
  return snapshot.state.transit.routes.at(-1)!;
}

/** Poll the runtime snapshot until the newest bus route satisfies `predicate`.
 *  Save-route dispatches and map-mutation intents are async; reading the
 *  route immediately after a click can race the runtime commit. Returns the
 *  route that matched so callers can make follow-up assertions. */
async function pollNewestBusRoute(
  page: import("@playwright/test").Page,
  predicate: (route: {
    id: string;
    pathBroken: boolean;
    legs: RouteLegPath[];
    stopIds: string[];
  }) => boolean,
): Promise<NonNullable<Awaited<ReturnType<typeof newestBusRoute>>>> {
  await expect
    .poll(async () => {
      const snapshot = await runtimeSnapshot(page);
      const route = snapshot.state.transit.routes.at(-1);
      if (!route) return false;
      return predicate(route);
    })
    .toBe(true);
  return newestBusRoute(page);
}

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

  // Lay a two-way road and place three roadside bus stops beside it.
  await buildItem(page, "Road", "1-Lane");
  await dragMapTiles(page, canvas, { x: 3, y: 4 }, { x: 11, y: 4 });

  await buildItem(page, "Bus", "Bus Stop");
  for (const stop of SIMPLE_ROUTE_STOPS) {
    await clickMapTile(canvas, stop);
  }
  await expectRoadsideStopAnchors(page, SIMPLE_ROUTE_STOPS);

  // Draft a route: add three stops, remove the middle one, then finish.
  await openHudCategory(page, "routes");
  await page.getByRole("button", { name: "Bus Route" }).click();
  for (const stop of SIMPLE_ROUTE_STOPS) {
    await clickMapTile(canvas, stop);
  }
  // Selecting the Bus Route tool auto-hides the drawer; reopen it to manage
  // the in-progress draft (stop list + finish/cancel actions).
  await openHudCategory(page, "routes");
  await expect(page.getByTestId("route-draft")).toBeVisible();
  await page.getByTestId("route-waypoint-1").click();
  await page
    .getByTestId("route-draft")
    .getByRole("button", { name: "Remove" })
    .click();
  await page.getByRole("button", { name: "Save route" }).click();

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

test("undoes and redoes a roadside route draft while preview is pending", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const harness = {
      deferRoutePreviews: true,
      releaseRoutePreviews: undefined as (() => void) | undefined,
    };
    Object.defineProperty(window, "__caelumE2E", {
      configurable: true,
      value: harness,
    });
  });
  await page.goto("/");
  await expect(page.getByTestId("game-shell")).toBeVisible();
  const canvas = page.locator("canvas[data-runtime-canvas='true']");
  await expect(canvas).toBeVisible();

  await buildItem(page, "Road", "1-Lane");
  await dragMapTiles(page, canvas, { x: 3, y: 4 }, { x: 11, y: 4 });
  await buildItem(page, "Bus", "Bus Stop");
  for (const stop of DRAFT_ROUTE_STOPS) {
    await clickMapTile(canvas, stop);
  }
  await expectRoadsideStopAnchors(page, DRAFT_ROUTE_STOPS);

  await openHudCategory(page, "routes");
  await page.getByRole("button", { name: "Bus Route" }).click();
  for (const stop of DRAFT_ROUTE_STOPS) {
    await clickMapTile(canvas, stop);
  }
  await openHudCategory(page, "routes");
  const draft = page.getByTestId("route-draft");
  const previewStatus = page.getByTestId("route-preview-status");
  const save = page.locator("button.route-save");
  await expect(draft).toBeVisible();
  await expect
    .poll(async () => {
      const current = (await runtimeSnapshot(page)).ui.routeDraft;
      return {
        waypointCount: current?.waypointIds.length ?? -1,
        previewPending: current?.previewPending ?? false,
      };
    })
    .toEqual({ waypointCount: 2, previewPending: true });
  await expect(save).toBeDisabled();
  await page.evaluate(() => {
    const harness = (
      window as unknown as {
        __caelumE2E?: { releaseRoutePreviews?: () => void };
      }
    ).__caelumE2E;
    if (harness?.releaseRoutePreviews === undefined) {
      throw new Error("Deferred route-preview harness is unavailable");
    }
    harness.releaseRoutePreviews();
  });
  const firstPreviewGeneration = await waitForRoutePreview(page, 2);
  await expect(previewStatus).toHaveText(/connected/i);
  await expect(save).toBeEnabled();

  // The canvas context-menu handler is the browser-facing undo affordance.
  await canvas.click({ button: "right", position: { x: 20, y: 20 } });
  await expect(save).toBeDisabled();
  const undonePreviewGeneration = await waitForRoutePreview(page, 1);
  expect(undonePreviewGeneration).toBeGreaterThan(firstPreviewGeneration);
  await expect(page.getByTestId("route-waypoint-1")).toHaveCount(0);

  await clickMapTile(canvas, DRAFT_ROUTE_STOPS[1]);
  const readdedPreviewGeneration = await waitForRoutePreview(page, 2);
  expect(readdedPreviewGeneration).toBeGreaterThan(undonePreviewGeneration);
  await expect(previewStatus).toHaveText(/connected/i);
  await expect(save).toBeEnabled();

  const undoShortcut = (await page.evaluate(() => navigator.platform)).includes(
    "Mac",
  )
    ? "Meta+Z"
    : "Control+Z";
  await page.keyboard.press(undoShortcut);
  await expect(save).toBeDisabled();
  const keyboardUndoGeneration = await waitForRoutePreview(page, 1);
  expect(keyboardUndoGeneration).toBeGreaterThan(readdedPreviewGeneration);
  await expect(page.getByTestId("route-waypoint-1")).toHaveCount(0);

  const redo = page.getByRole("button", { name: "Redo" });
  await expect(redo).toBeEnabled();
  await redo.click();
  const redoGeneration = await waitForRoutePreview(page, 2);
  expect(redoGeneration).toBeGreaterThan(keyboardUndoGeneration);
  await expect(previewStatus).toHaveText(/connected/i);
  await expect(save).toBeEnabled();
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
  await page.getByRole("button", { name: "Save route" }).click();

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

  // Road + three roadside bus stops beside it.
  await buildItem(page, "Road", "1-Lane");
  await dragMapTiles(page, canvas, { x: 3, y: 4 }, { x: 11, y: 4 });

  await buildItem(page, "Bus", "Bus Stop");
  for (const stop of SIMPLE_ROUTE_STOPS) {
    await clickMapTile(canvas, stop);
  }
  await expectRoadsideStopAnchors(page, SIMPLE_ROUTE_STOPS);

  // Draft + finish a route over all three stops.
  await openHudCategory(page, "routes");
  await page.getByRole("button", { name: "Bus Route" }).click();
  for (const stop of SIMPLE_ROUTE_STOPS) {
    await clickMapTile(canvas, stop);
  }
  await openHudCategory(page, "routes");
  await expect(page.getByTestId("route-draft")).toBeVisible();
  await page.getByRole("button", { name: "Save route" }).click();

  // The route must appear AND the core must have assigned a vehicle to it.
  // This is the regression guard for the dropped `assignVehicle` step: without
  // it the route would have `vehicleIds: []` forever and transit could never
  // move a single citizen.
  await openHudCategory(page, "manage");
  await expect(page.getByTestId("route-name-route-001")).toBeVisible();

  // Poll for the vehicle assignment — the Save-route dispatch is async and
  // the runtime commit may lag the DOM appearance of the route name.
  await expect
    .poll(async () => {
      const transit = await readRuntimeTransit(page);
      return (
        transit.vehicles.length >= 1 &&
        transit.vehicles[0].lineId === "route-001" &&
        transit.vehicles[0].mode === "bus" &&
        (transit.routes.find((r) => r.id === "route-001")?.vehicleIds.length ??
          0) >= 1
      );
    })
    .toBe(true);
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

test("turns between paired roads and edits the committed route", async ({
  page,
}) => {
  await page.goto("/");
  const canvas = page.locator("canvas[data-runtime-canvas='true']");
  await buildItem(page, "Road", "1-Lane");
  await dragMapTiles(page, canvas, { x: 3, y: 4 }, { x: 13, y: 4 });
  await buildItem(page, "Road", "1-Lane");
  await dragMapTiles(page, canvas, { x: 8, y: 2 }, { x: 8, y: 10 });
  await buildItem(page, "Bus", "Bus Stop");
  for (const stop of [...TURN_ROUTE_STOPS, EXTRA_TURN_STOP]) {
    await clickMapTile(canvas, stop);
  }
  await expectRoadsideStopAnchors(page, [...TURN_ROUTE_STOPS, EXTRA_TURN_STOP]);
  await openHudCategory(page, "routes");
  await page.getByRole("button", { name: "Bus Route" }).click();
  for (const stop of TURN_ROUTE_STOPS) {
    await clickMapTile(canvas, stop);
  }
  await expect
    .poll(async () => {
      const draft = (await runtimeSnapshot(page)).ui.routeDraft;
      return {
        pending: draft?.previewPending ?? true,
        rejection: draft?.preview?.rejection?.code ?? null,
      };
    })
    .toEqual({ pending: false, rejection: null });
  await openHudCategory(page, "routes");
  await page.getByRole("radio", { name: "Loop" }).check();
  await page.getByRole("button", { name: "Save route" }).click();

  // Poll until the route is committed — the Save dispatch is async.
  await expect
    .poll(async () => {
      const routes = (await runtimeSnapshot(page)).state.transit.routes;
      return routes.length > 0;
    })
    .toBe(true);

  await openHudCategory(page, "manage");
  await page.getByRole("button", { name: /Edit Bus 1/ }).click();
  await page.getByTestId("route-waypoint-0").click();
  await page.getByRole("button", { name: "Insert after" }).click();
  await clickMapTile(canvas, EXTRA_TURN_STOP);
  await expect(page.getByTestId("route-preview-status")).toHaveText(
    /connected/i,
  );
  await page.getByRole("button", { name: "Save route" }).click();

  // Poll until the committed route has the extra waypoint and turn movements
  // — the Save dispatch is async and the runtime commit may lag the click.
  await expect
    .poll(async () => {
      const route = (await runtimeSnapshot(page)).state.transit.routes.at(-1);
      if (!route) return false;
      return (
        route.stopIds.length === TURN_ROUTE_STOPS.length + 1 &&
        route.legs
          .flatMap(roadMovements)
          .some((movement) => ["leftTurn", "rightTurn"].includes(movement))
      );
    })
    .toBe(true);
  const route = (await runtimeSnapshot(page)).state.transit.routes.at(-1)!;
  expect(route.stopIds).toHaveLength(TURN_ROUTE_STOPS.length + 1);
  expect(
    route.legs
      .flatMap(roadMovements)
      .some((movement) => ["leftTurn", "rightTurn"].includes(movement)),
  ).toBe(true);
});

test("rebuilds an exact-anchor missing station and repairs its routes", async ({
  page,
}) => {
  await page.goto("/");
  const canvas = page.locator("canvas[data-runtime-canvas='true']");
  const first = { x: 16, y: 2 };
  const second = { x: 20, y: 2 };
  await buildItem(page, "Rail", "Track");
  await dragMapTiles(page, canvas, first, second);
  await buildItem(page, "Metro", "Metro Station");
  await clickMapTile(canvas, first);
  await clickMapTile(canvas, second);
  await openHudCategory(page, "routes");
  await page.getByRole("button", { name: "Metro Line" }).click();
  await clickMapTile(canvas, first);
  await clickMapTile(canvas, second);
  await openHudCategory(page, "routes");
  await page.getByRole("button", { name: "Save route" }).click();
  // Poll until the metro line is committed — the Save dispatch is async.
  await expect
    .poll(async () => {
      const lines = (await runtimeSnapshot(page)).state.transit.metroLines;
      return lines.length > 0;
    })
    .toBe(true);
  const line = (await runtimeSnapshot(page)).state.transit.metroLines.at(-1)!;

  await page.getByTestId("hud-tool-remove").click();
  await clickMapTile(canvas, first);
  await openHudCategory(page, "manage");
  await expect(page.getByText(/Missing Metro Station/)).toHaveCount(2);
  await expect(page.getByTestId("route-status-" + line.id)).toHaveText(
    "Broken",
  );

  // Top up the budget: 2 stations (50k) + 1 metro vehicle (50k) + track
  // exhausted most of the 120k starting budget, leaving <25k — not enough
  // for the 25k station rebuild.
  await debugSetBudget(page, 120_000);

  await buildItem(page, "Metro", "Metro Station");
  await clickMapTile(canvas, first);
  await openHudCategory(page, "manage");
  await expect(page.getByTestId("route-status-" + line.id)).toHaveText(
    "Running",
  );
});

test("reroutes when possible, then preserves a dotted last-valid leg until repair", async ({
  page,
}) => {
  await page.goto("/");
  const canvas = page.locator("canvas[data-runtime-canvas='true']");
  await seedRouteWithPrimaryAndAlternateRoad(page);
  await createDamageRoute(page);
  // Poll until the route is committed — Save dispatch is async.
  const before = await pollNewestBusRoute(page, (r) =>
    r.legs.every((leg) => leg.currentPath !== null),
  );

  await removeMapTile(page, canvas, PRIMARY_ROAD_TILE);
  // Poll until the route reroutes to a different path (not just still the
  // original — the remove dispatch and path re-evaluation are async).
  const rerouted = await pollNewestBusRoute(
    page,
    (r) =>
      r.pathBroken === false &&
      r.legs[0].currentPath !== null &&
      JSON.stringify(r.legs[0].currentPath) !==
        JSON.stringify(before.legs[0].currentPath),
  );
  expect(rerouted.pathBroken).toBe(false);
  expect(rerouted.legs[0].currentPath).not.toEqual(before.legs[0].currentPath);

  await removeMapTile(page, canvas, ALTERNATE_ROAD_TILE);
  // Poll until both roads are damaged and the route is broken with no path.
  const broken = await pollNewestBusRoute(
    page,
    (r) => r.pathBroken === true && r.legs[0].currentPath === null,
  );
  expect(broken.pathBroken).toBe(true);
  expect(broken.legs[0].currentPath).toBeNull();
  expect(broken.legs[0].lastValidPath).toEqual(rerouted.legs[0].lastValidPath);
  await openHudCategory(page, "manage");
  await expect(page.getByTestId("route-status-" + broken.id)).toHaveText(
    "Broken",
  );
  await rebuildRoadTile(page, canvas, ALTERNATE_ROAD_TILE);
  await openHudCategory(page, "manage");
  await expect(page.getByTestId("route-status-" + broken.id)).toHaveText(
    "Running",
  );
});
