import { expect, test } from "@playwright/test";
import type { MovementKind, RouteLegPath } from "../../src/domain/types";
import { tileSize } from "../../src/render/canvas";
import { colors } from "../../src/render/colors";
import {
  selectBuildLeaf,
  clickMapTile,
  createDefaultCity,
  debugSetBudget,
  dragMapTiles,
  openCommandDestination,
  rebuildRoadTile,
  removeMapTile,
  runtimeSnapshot,
  selectTool,
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
const FARTHER_ROUTE_STOP = { x: 19, y: 12 } as const;
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
  await selectBuildLeaf(page, "roads", "road-twoWay");
  await dragMapTiles(page, canvas, { x: 3, y: 4 }, { x: 13, y: 4 });
  await selectBuildLeaf(page, "roads", "road-twoWay");
  await dragMapTiles(page, canvas, { x: 3, y: 6 }, { x: 13, y: 6 });
  await selectBuildLeaf(page, "roads", "road-twoWay");
  await dragMapTiles(page, canvas, { x: 3, y: 4 }, { x: 3, y: 6 });
  await selectBuildLeaf(page, "roads", "road-twoWay");
  await dragMapTiles(page, canvas, { x: 13, y: 4 }, { x: 13, y: 6 });
  await selectBuildLeaf(page, "transit", "busStop");
  for (const stop of DAMAGE_ROUTE_STOPS) {
    await clickMapTile(canvas, stop);
  }
  await expectRoadsideStopAnchors(page, DAMAGE_ROUTE_STOPS);
}

async function createDamageRoute(
  page: import("@playwright/test").Page,
): Promise<void> {
  const canvas = page.locator("canvas[data-runtime-canvas='true']");
  await openCommandDestination(page, "lines");
  await page.getByRole("button", { name: "New Bus" }).click();
  for (const stop of DAMAGE_ROUTE_STOPS) {
    await clickMapTile(canvas, stop);
  }
  await openCommandDestination(page, "lines");
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
// finishing a bus route or Metro line leaves deployment explicit in the core.
async function readRuntimeTransit(
  page: import("@playwright/test").Page,
): Promise<{
  vehicles: { id: string; lineId: string; mode: string }[];
  routes: { id: string; vehicleIds: string[] }[];
  metroLines: { id: string; vehicleIds: string[] }[];
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
                metroLines: { id: string; vehicleIds: string[] }[];
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
    return {
      vehicles: transit.vehicles,
      routes: transit.routes,
      metroLines: transit.metroLines,
    };
  });
}

test("create, manage, and delete a bus route", async ({ page }) => {
  await createDefaultCity(page);
  await expect(page.getByTestId("game-shell")).toBeVisible();
  const canvas = page.locator("canvas[data-runtime-canvas='true']");
  await expect(canvas).toBeVisible();

  // Lay a two-way road and place three roadside bus stops beside it.
  await selectBuildLeaf(page, "roads", "road-twoWay");
  await dragMapTiles(page, canvas, { x: 3, y: 4 }, { x: 11, y: 4 });

  await selectBuildLeaf(page, "transit", "busStop");
  for (const stop of SIMPLE_ROUTE_STOPS) {
    await clickMapTile(canvas, stop);
  }
  await expectRoadsideStopAnchors(page, SIMPLE_ROUTE_STOPS);

  // Draft a route: add three stops, remove the middle one, then finish.
  await openCommandDestination(page, "lines");
  await page.getByRole("button", { name: "New Bus" }).click();
  for (const stop of SIMPLE_ROUTE_STOPS) {
    await clickMapTile(canvas, stop);
  }
  await expect(page.getByTestId("route-draft")).toBeVisible();
  await page.getByTestId("route-waypoint-1").click();
  await page
    .getByTestId("route-draft")
    .getByRole("button", { name: "Remove" })
    .click();
  await page.getByRole("button", { name: "Save route" }).click();

  // The route now appears in the management panel.
  await openCommandDestination(page, "lines");
  await expect(page.getByTestId("panel-lines")).toBeVisible();
  await expect(page.getByTestId("route-name-route-001")).toBeVisible();
  await openCommandDestination(page, "data");
  const metrics = page.getByTestId("panel-data").getByRole("region", {
    name: "Metrics",
  });
  const avgWaitReadout = metrics
    .getByText("Avg Wait")
    .locator("xpath=following-sibling::dd[1]");
  const unservedReadout = metrics
    .getByText("Unserved")
    .locator("xpath=following-sibling::dd[1]");
  const lateReadout = metrics
    .getByText("Late")
    .locator("xpath=following-sibling::dd[1]");
  await expect(avgWaitReadout).toHaveText(/^\d+s$/);
  await expect(unservedReadout).toHaveText(/^\d+$/);
  await expect(lateReadout).toHaveText(/^\d+$/);
  await openCommandDestination(page, "lines");

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
  await createDefaultCity(page);
  await expect(page.getByTestId("game-shell")).toBeVisible();
  const canvas = page.locator("canvas[data-runtime-canvas='true']");
  await expect(canvas).toBeVisible();

  await selectBuildLeaf(page, "roads", "road-twoWay");
  await dragMapTiles(page, canvas, { x: 3, y: 4 }, { x: 11, y: 4 });
  await selectBuildLeaf(page, "transit", "busStop");
  for (const stop of DRAFT_ROUTE_STOPS) {
    await clickMapTile(canvas, stop);
  }
  await expectRoadsideStopAnchors(page, DRAFT_ROUTE_STOPS);

  await openCommandDestination(page, "lines");
  await page.getByRole("button", { name: "New Bus" }).click();
  for (const stop of DRAFT_ROUTE_STOPS) {
    await clickMapTile(canvas, stop);
  }
  await openCommandDestination(page, "lines");
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
  await createDefaultCity(page);
  await expect(page.getByTestId("game-shell")).toBeVisible();
  const canvas = page.locator("canvas[data-runtime-canvas='true']");
  await expect(canvas).toBeVisible();

  // Lay a 5-tile track run on empty ground.
  await selectBuildLeaf(page, "transit", "track");
  for (let x = 8; x <= 12; x += 1) {
    await clickMapTile(canvas, { x, y: 2 });
  }

  // Stations on the track ends (Metro Station building requires track).
  await selectBuildLeaf(page, "transit", "metroStation");
  await clickMapTile(canvas, { x: 8, y: 2 });
  await clickMapTile(canvas, { x: 12, y: 2 });

  // Connect them with a metro line.
  await openCommandDestination(page, "lines");
  await page.getByRole("button", { name: "New Metro" }).click();
  await clickMapTile(canvas, { x: 8, y: 2 });
  await clickMapTile(canvas, { x: 12, y: 2 });
  await expect(page.getByTestId("route-draft")).toBeVisible();
  await page.getByRole("button", { name: "Save route" }).click();

  await openCommandDestination(page, "lines");
  await expect(page.getByTestId("panel-lines")).toBeVisible();
  await expect(page.getByTestId("route-name-metro-001")).toBeVisible();
});

test("finishing a bus route leaves the fleet unassigned", async ({ page }) => {
  await createDefaultCity(page);
  await expect(page.getByTestId("game-shell")).toBeVisible();
  const canvas = page.locator("canvas[data-runtime-canvas='true']");
  await expect(canvas).toBeVisible();

  // Road + three roadside bus stops beside it.
  await selectBuildLeaf(page, "roads", "road-twoWay");
  await dragMapTiles(page, canvas, { x: 3, y: 4 }, { x: 11, y: 4 });

  await selectBuildLeaf(page, "transit", "busStop");
  for (const stop of SIMPLE_ROUTE_STOPS) {
    await clickMapTile(canvas, stop);
  }
  await expectRoadsideStopAnchors(page, SIMPLE_ROUTE_STOPS);

  // Draft + finish a route over all three stops.
  await openCommandDestination(page, "lines");
  await page.getByRole("button", { name: "New Bus" }).click();
  for (const stop of SIMPLE_ROUTE_STOPS) {
    await clickMapTile(canvas, stop);
  }
  await openCommandDestination(page, "lines");
  await expect(page.getByTestId("route-draft")).toBeVisible();
  await page.getByRole("button", { name: "Save route" }).click();

  // Route creation is intentionally fleet-free. Poll for the async runtime
  // commit, then assert no bus vehicle was implicitly created.
  await openCommandDestination(page, "lines");
  await expect(page.getByTestId("route-name-route-001")).toBeVisible();
  await expect
    .poll(async () => {
      const transit = await readRuntimeTransit(page);
      const route = transit.routes.find(
        (candidate) => candidate.id === "route-001",
      );
      return route !== undefined && route.vehicleIds.length === 0;
    })
    .toBe(true);
  const transit = await readRuntimeTransit(page);
  expect(transit.vehicles).toEqual([]);
  expect(
    transit.routes.find((route) => route.id === "route-001")?.vehicleIds,
  ).toEqual([]);
});

test("starts a bus service and recovers fleet after a route edit", async ({
  page,
}) => {
  await createDefaultCity(page);
  await expect(page.getByTestId("game-shell")).toBeVisible();
  const canvas = page.locator("canvas[data-runtime-canvas='true']");
  await expect(canvas).toBeVisible();

  // A long connected road with a branch to a farther existing stop.
  await selectBuildLeaf(page, "roads", "road-twoWay");
  await dragMapTiles(page, canvas, { x: 3, y: 4 }, { x: 20, y: 4 });
  await selectBuildLeaf(page, "roads", "road-twoWay");
  await dragMapTiles(page, canvas, { x: 20, y: 4 }, { x: 20, y: 13 });
  await selectBuildLeaf(page, "transit", "busStop");
  for (const stop of [...SIMPLE_ROUTE_STOPS, FARTHER_ROUTE_STOP]) {
    await clickMapTile(canvas, stop);
  }
  await expectRoadsideStopAnchors(page, [
    ...SIMPLE_ROUTE_STOPS,
    FARTHER_ROUTE_STOP,
  ]);

  // Draft + finish a route over all three stops (fleet-free creation).
  await openCommandDestination(page, "lines");
  await page.getByRole("button", { name: "New Bus" }).click();
  for (const stop of SIMPLE_ROUTE_STOPS) {
    await clickMapTile(canvas, stop);
  }
  await openCommandDestination(page, "lines");
  await expect(page.getByTestId("route-draft")).toBeVisible();
  await page.getByRole("button", { name: "Save route" }).click();
  await openCommandDestination(page, "lines");
  await expect(page.getByTestId("route-name-route-001")).toBeVisible();

  // Saved routes are fleet-free: status reads No fleet and no vehicles exist.
  await expect(page.getByTestId("route-status-route-001")).toHaveText(
    "No fleet",
  );
  await expect
    .poll(async () => {
      const transit = await readRuntimeTransit(page);
      const route = transit.routes.find(
        (candidate) => candidate.id === "route-001",
      );
      return route !== undefined && route.vehicleIds.length === 0;
    })
    .toBe(true);
  expect((await readRuntimeTransit(page)).vehicles).toEqual([]);

  // Set a whole-minute target headway; Rust derives the required fleet.
  const service = page.getByTestId("route-service-route-001");
  await expect(
    service.getByText("Target").locator("xpath=following-sibling::span[1]"),
  ).toHaveText("—");
  await page.getByTestId("route-headway-route-001").fill("1");
  await page.getByTestId("route-headway-set-route-001").click();
  await expect
    .poll(async () => {
      const route = (await runtimeSnapshot(page)).state.transit.routes.find(
        (candidate) => candidate.id === "route-001",
      );
      return (
        route?.targetHeadwaySeconds === 60 &&
        route?.serviceMetrics?.requiredFleet != null
      );
    })
    .toBe(true);
  await expect(service).toContainText("1.0 min");

  // Required N is the Rust-derived row value (informational estimate). The
  // Deploy button does not promise a specific count: on Tauri a tick in flight
  // when the click queues can change road flow before deploy_bus_fleet
  // recomputes required_fleet, so the purchased count is whatever Rust derives
  // at execution time. Assert the deployed count equals the post-deploy
  // assignedFleet / Fleet readout rather than the pre-click Required readout.
  const requiredReadout = service
    .getByText("Required")
    .locator("xpath=following-sibling::span[1]");
  let requiredText = "";
  await expect
    .poll(async () => {
      requiredText = ((await requiredReadout.textContent()) ?? "")
        .replace(/\s+/g, " ")
        .trim();
      return requiredText;
    })
    .toMatch(/^\d+ bus(?:es)?$/);
  const requiredFleet = Number(requiredText.match(/^(\d+) bus(?:es)?$/)![1]);
  expect(requiredFleet).toBeGreaterThan(0);
  const persisted = (await runtimeSnapshot(page)).state.transit.routes.find(
    (candidate) => candidate.id === "route-001",
  )!;
  expect(persisted.serviceMetrics?.requiredFleet).toBe(requiredFleet);
  const deploy = page.getByRole("button", { name: "Deploy fleet" });
  await expect(deploy).toBeVisible();

  // Deploying places a non-empty bus fleet; the count is Rust's execution-time
  // derivation, not the pre-click Required readout.
  await deploy.click();
  let deployedFleet = 0;
  await expect
    .poll(async () => {
      const transit = await readRuntimeTransit(page);
      const route = transit.routes.find(
        (candidate) => candidate.id === "route-001",
      );
      if (route === undefined) return false;
      deployedFleet = route.vehicleIds.length;
      return deployedFleet > 0;
    })
    .toBe(true);
  const deployed = await readRuntimeTransit(page);
  expect(
    deployed.routes.find((route) => route.id === "route-001")?.vehicleIds,
  ).toHaveLength(deployedFleet);
  expect(deployed.vehicles).toHaveLength(deployedFleet);
  expect(deployed.vehicles.every((vehicle) => vehicle.mode === "bus")).toBe(
    true,
  );
  const postDeploySnapshot = await runtimeSnapshot(page);
  const postDeployRoute = postDeploySnapshot.state.transit.routes.find(
    (route) => route.id === "route-001",
  );
  const postDeployRequired = postDeployRoute?.serviceMetrics?.requiredFleet;
  if (postDeployRequired === null || postDeployRequired === undefined) {
    throw new Error("Post-deploy Rust required fleet is missing");
  }

  // Post-deployment UI shows Target/Nominal/Fleet with the set/derived values and no setup controls.
  await expect(
    service.getByText("Target").locator("xpath=following-sibling::span[1]"),
  ).toHaveText("1.0 min");
  await expect(
    service.getByText("Nominal").locator("xpath=following-sibling::span[1]"),
  ).toHaveText(/^\d+\.\d min$/);
  await expect(
    service.getByText("Fleet").locator("xpath=following-sibling::span[1]"),
  ).toHaveText(`${deployedFleet} / ${postDeployRequired} required`);
  await expect(service.getByText("Required", { exact: true })).toHaveCount(0);
  await expect(service.getByText("No fleet")).toHaveCount(0);
  await expect(page.getByTestId("route-headway-route-001")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Set", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /Deploy/, exact: true }),
  ).toHaveCount(0);

  const deployedSnapshot = await runtimeSnapshot(page);
  const deployedRoute = deployedSnapshot.state.transit.routes.find(
    (route) => route.id === "route-001",
  );
  if (deployedRoute === undefined) {
    throw new Error("Deployed bus route is missing from the runtime snapshot");
  }
  const fartherStop = deployedSnapshot.state.transit.stops.find(
    (stop) =>
      stop.status === "present" &&
      stop.position.x === FARTHER_ROUTE_STOP.x &&
      stop.position.y === FARTHER_ROUTE_STOP.y,
  );
  if (fartherStop === undefined) {
    throw new Error("Farther bus stop is missing from the runtime snapshot");
  }
  const initialRouteRevision = deployedRoute.revision;
  const initialBudget = deployedSnapshot.state.budget;
  const initialAssigned = deployedRoute.vehicleIds.length;
  expect(initialAssigned).toBeGreaterThan(0);

  // Resume before editing so the live Rust metrics can publish a top-up offer.
  await page.getByRole("button", { name: "Resume" }).click();

  await page.getByRole("button", { name: /Edit Bus 1/ }).click();
  await page.getByTestId("route-waypoint-2").click();
  await page.getByRole("button", { name: "Insert after" }).click();
  await clickMapTile(canvas, FARTHER_ROUTE_STOP);
  await expect(page.getByTestId("route-preview-status")).toHaveText(
    /connected/i,
  );
  await page.getByRole("button", { name: "Save route" }).click();

  // Save dispatch is asynchronous. First prove the runtime committed the
  // edited route, including its farther stop, before reading service metrics.
  await expect
    .poll(async () => {
      const route = (await runtimeSnapshot(page)).state.transit.routes.find(
        (candidate) => candidate.id === deployedRoute.id,
      );
      return (
        route !== undefined &&
        route.revision > initialRouteRevision &&
        route.stopIds.includes(fartherStop.id)
      );
    })
    .toBe(true);

  // Let the Rust snapshot establish a real post-edit shortfall. The test does
  // not reproduce the required-fleet calculation or assume its size.
  await expect
    .poll(async () => {
      const route = (await runtimeSnapshot(page)).state.transit.routes.find(
        (candidate) => candidate.id === "route-001",
      );
      const required = route?.serviceMetrics?.requiredFleet;
      return (
        route !== undefined &&
        required !== null &&
        required !== undefined &&
        required > route.vehicleIds.length
      );
    })
    .toBe(true);

  const postEditSnapshot = await runtimeSnapshot(page);
  const postEditRoute = postEditSnapshot.state.transit.routes.find(
    (route) => route.id === "route-001",
  );
  if (postEditRoute === undefined || postEditRoute.serviceMetrics === null) {
    throw new Error("Post-edit service metrics are missing from the runtime");
  }
  const postEditAssigned = postEditRoute.vehicleIds.length;
  const postEditRequired = postEditRoute.serviceMetrics.requiredFleet;
  const postEditNominal = postEditRoute.serviceMetrics.nominalHeadwaySeconds;
  const nextVehicleCost = postEditRoute.serviceMetrics.nextVehicleCost ?? null;
  const postEditBudget = postEditSnapshot.state.budget;
  expect(postEditAssigned).toBe(initialAssigned);
  expect(postEditBudget).toBe(initialBudget);
  expect(postEditRequired).not.toBeNull();
  expect(postEditRequired).toBeGreaterThan(postEditAssigned);
  expect(postEditNominal).not.toBeNull();
  expect(nextVehicleCost).not.toBeNull();
  if (postEditNominal === null || nextVehicleCost === null) {
    throw new Error("Rust did not publish a complete top-up offer");
  }

  const addVehicleButton = page.getByTestId(
    `route-add-vehicle-${postEditRoute.id}`,
  );
  await expect(addVehicleButton).toBeVisible();
  await addVehicleButton.click();

  await expect
    .poll(async () => {
      const snapshot = await runtimeSnapshot(page);
      const route = snapshot.state.transit.routes.find(
        (candidate) => candidate.id === postEditRoute.id,
      );
      const nominal = route?.serviceMetrics?.nominalHeadwaySeconds ?? null;
      return (
        route !== undefined &&
        route.vehicleIds.length === postEditAssigned + 1 &&
        snapshot.state.budget === postEditBudget - nextVehicleCost &&
        nominal !== null &&
        nominal < postEditNominal
      );
    })
    .toBe(true);
  const postAddSnapshot = await runtimeSnapshot(page);
  const postAddRoute = postAddSnapshot.state.transit.routes.find(
    (route) => route.id === postEditRoute.id,
  );
  if (postAddRoute === undefined || postAddRoute.serviceMetrics === null) {
    throw new Error("Post-add service metrics are missing from the runtime");
  }
  expect(postAddRoute.vehicleIds.length).toBe(postEditAssigned + 1);
  expect(postAddSnapshot.state.budget).toBe(postEditBudget - nextVehicleCost);
  expect(postAddRoute.serviceMetrics.nominalHeadwaySeconds).toBeLessThan(
    postEditNominal,
  );
  const postAddNextVehicleCost =
    postAddRoute.serviceMetrics.nextVehicleCost ?? null;
  await openCommandDestination(page, "lines");
  if (postAddNextVehicleCost === null) {
    await expect(addVehicleButton).toHaveCount(0);
  } else {
    await expect(addVehicleButton).toBeVisible();
  }

  const timeReadout = page.getByTestId("topbar").locator(".readout", {
    hasText: "Time",
  });
  await expect
    .poll(
      async () =>
        (await timeReadout.locator(".readout-value").textContent())?.trim() ??
        "",
    )
    .toMatch(/^Day 1 (?!00:00$)\d{2}:\d{2}$/);
});

test("turns between paired roads and edits the committed route", async ({
  page,
}) => {
  await createDefaultCity(page);
  const canvas = page.locator("canvas[data-runtime-canvas='true']");
  await selectBuildLeaf(page, "roads", "road-twoWay");
  await dragMapTiles(page, canvas, { x: 3, y: 4 }, { x: 13, y: 4 });
  await selectBuildLeaf(page, "roads", "road-twoWay");
  await dragMapTiles(page, canvas, { x: 8, y: 2 }, { x: 8, y: 10 });
  await selectBuildLeaf(page, "transit", "busStop");
  for (const stop of [...TURN_ROUTE_STOPS, EXTRA_TURN_STOP]) {
    await clickMapTile(canvas, stop);
  }
  await expectRoadsideStopAnchors(page, [...TURN_ROUTE_STOPS, EXTRA_TURN_STOP]);
  await openCommandDestination(page, "lines");
  await page.getByRole("button", { name: "New Bus" }).click();
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
  await openCommandDestination(page, "lines");
  await page.getByRole("radio", { name: "Loop" }).check();
  await page.getByRole("button", { name: "Save route" }).click();

  // Poll until the route is committed — the Save dispatch is async.
  await expect
    .poll(async () => {
      const routes = (await runtimeSnapshot(page)).state.transit.routes;
      return routes.length > 0;
    })
    .toBe(true);

  await openCommandDestination(page, "lines");
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
  await createDefaultCity(page);
  const canvas = page.locator("canvas[data-runtime-canvas='true']");
  const first = { x: 16, y: 2 };
  const second = { x: 20, y: 2 };
  await selectBuildLeaf(page, "transit", "track");
  await dragMapTiles(page, canvas, first, second);
  await selectBuildLeaf(page, "transit", "metroStation");
  await clickMapTile(canvas, first);
  await clickMapTile(canvas, second);
  await openCommandDestination(page, "lines");
  await page.getByRole("button", { name: "New Metro" }).click();
  await clickMapTile(canvas, first);
  await clickMapTile(canvas, second);
  await openCommandDestination(page, "lines");
  await page.getByRole("button", { name: "Save route" }).click();
  // Poll until the metro line is committed — the Save dispatch is async.
  await expect
    .poll(async () => {
      const lines = (await runtimeSnapshot(page)).state.transit.metroLines;
      return lines.length > 0;
    })
    .toBe(true);
  const line = (await runtimeSnapshot(page)).state.transit.metroLines.at(-1)!;

  await selectTool(page, "demolish");
  await clickMapTile(canvas, first);
  await openCommandDestination(page, "lines");
  await expect(page.getByText(/Missing Metro Station/)).toHaveCount(2);
  await expect(page.getByTestId("route-status-" + line.id)).toHaveText(
    "Broken",
  );

  // Top up the budget for the station rebuild; creating the Metro line no
  // longer spends METRO_COST, so only the two stations and track consumed the
  // starting budget.
  await debugSetBudget(page, 120_000);

  await selectBuildLeaf(page, "transit", "metroStation");
  await clickMapTile(canvas, first);
  await openCommandDestination(page, "lines");
  await expect(page.getByTestId("route-status-" + line.id)).toHaveText(
    "No fleet",
  );
});

test("starts a Metro service by setting a target headway and deploying the fleet", async ({
  page,
}) => {
  await createDefaultCity(page);
  await expect(page.getByTestId("game-shell")).toBeVisible();
  const canvas = page.locator("canvas[data-runtime-canvas='true']");

  // Lay the same short connected track used by the Metro route flow.
  await selectBuildLeaf(page, "transit", "track");
  for (let x = 8; x <= 12; x += 1) {
    await clickMapTile(canvas, { x, y: 2 });
  }

  // Place stations at both ends of the track.
  await selectBuildLeaf(page, "transit", "metroStation");
  await clickMapTile(canvas, { x: 8, y: 2 });
  await clickMapTile(canvas, { x: 12, y: 2 });

  // Create and save the Metro line without buying a fleet.
  await openCommandDestination(page, "lines");
  await page.getByRole("button", { name: "New Metro" }).click();
  await clickMapTile(canvas, { x: 8, y: 2 });
  await clickMapTile(canvas, { x: 12, y: 2 });
  await expect(page.getByTestId("route-draft")).toBeVisible();
  await page.getByRole("button", { name: "Save route" }).click();
  await openCommandDestination(page, "lines");

  await expect
    .poll(async () => (await runtimeSnapshot(page)).state.transit.metroLines)
    .not.toHaveLength(0);
  const lineId = (await runtimeSnapshot(page)).state.transit.metroLines.at(
    -1,
  )!.id;
  await expect(page.getByTestId(`route-name-${lineId}`)).toBeVisible();
  await expect(page.getByTestId(`route-status-${lineId}`)).toHaveText(
    "No fleet",
  );
  await expect
    .poll(async () => {
      const line = (await readRuntimeTransit(page)).metroLines.find(
        (candidate) => candidate.id === lineId,
      );
      return line?.vehicleIds ?? null;
    })
    .toEqual([]);

  // Set a whole-minute target; the panel displays Rust's required fleet and cost.
  const service = page.getByTestId(`route-service-${lineId}`);
  await page.getByTestId(`route-headway-${lineId}`).fill("6");
  await page.getByTestId(`route-headway-set-${lineId}`).click();
  await expect(
    service.getByText("Target").locator("xpath=following-sibling::span[1]"),
  ).toHaveText("6.0 min");
  await expect(
    service.getByText("Required").locator("xpath=following-sibling::span[1]"),
  ).toHaveText("1 train");
  await expect(
    service
      .getByText("Est. deploy cost")
      .locator("xpath=following-sibling::span[1]"),
  ).toHaveText("$50,000");

  // Provision the purchase explicitly before deploying the initial train.
  await debugSetBudget(page, 500_000);
  await page.getByTestId(`route-deploy-${lineId}`).click();

  let vehicleIds: string[] = [];
  await expect
    .poll(async () => {
      const line = (await readRuntimeTransit(page)).metroLines.find(
        (candidate) => candidate.id === lineId,
      );
      vehicleIds = line?.vehicleIds ?? [];
      return vehicleIds.length > 0;
    })
    .toBe(true);
  expect(vehicleIds).not.toEqual([]);

  // Deployment switches the row to Target/Nominal/Fleet and removes setup controls.
  await expect(
    service.getByText("Target").locator("xpath=following-sibling::span[1]"),
  ).toHaveText("6.0 min");
  await expect(
    service.getByText("Nominal").locator("xpath=following-sibling::span[1]"),
  ).toHaveText(/^\d+\.\d min$/);
  const postDeploySnapshot = await runtimeSnapshot(page);
  const postDeployLine = postDeploySnapshot.state.transit.metroLines.find(
    (line) => line.id === lineId,
  );
  const postDeployRequired = postDeployLine?.serviceMetrics?.requiredFleet;
  if (postDeployRequired === null || postDeployRequired === undefined) {
    throw new Error("Post-deploy Rust required fleet is missing");
  }
  await expect(
    service.getByText("Fleet").locator("xpath=following-sibling::span[1]"),
  ).toHaveText(`${vehicleIds.length} / ${postDeployRequired} required`);
  await expect(service.getByText("Required", { exact: true })).toHaveCount(0);
  await expect(service.getByText("Est. deploy cost")).toHaveCount(0);
  await expect(page.getByTestId(`route-headway-${lineId}`)).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Set", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByTestId(`route-deploy-${lineId}`)).toHaveCount(0);

  // Resume the paused sim and confirm the clock advances.
  await page.getByRole("button", { name: "Resume" }).click();
  const timeReadout = page.getByTestId("topbar").locator(".readout", {
    hasText: "Time",
  });
  await expect
    .poll(
      async () =>
        (await timeReadout.locator(".readout-value").textContent())?.trim() ??
        "",
    )
    .toMatch(/^Day 1 (?!00:00$)\d{2}:\d{2}$/);
});

test("reroutes when possible, then preserves a dotted last-valid leg until repair", async ({
  page,
}) => {
  await createDefaultCity(page);
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
  await openCommandDestination(page, "lines");
  await expect(page.getByTestId("route-status-" + broken.id)).toHaveText(
    "Broken",
  );
  await rebuildRoadTile(page, canvas, ALTERNATE_ROAD_TILE);
  await openCommandDestination(page, "lines");
  // The route is connected again, but a bus route is fleet-free until the
  // player deploys: the status reads No fleet rather than Running.
  await expect(page.getByTestId("route-status-" + broken.id)).toHaveText(
    "No fleet",
  );
});
