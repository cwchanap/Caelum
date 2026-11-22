import { expect, test } from "@playwright/test";
import type { MovementKind, RouteLegPath } from "../../src/domain/types";
import { formatBudget } from "../../src/runtime/runtimeSelectors";
import {
  selectBuildLeaf,
  clickMapTile,
  createDefaultCity,
  debugSetBudget,
  dragMapTiles,
  hoverMapTile,
  mapBoardScale,
  mapTileViewportPoint,
  openCommandDestination,
  rebuildRoadTile,
  removeMapTile,
  runtimeSnapshot,
  selectTool,
  settleLayout,
} from "./helpers";
import { expectRoadsideStopAnchors } from "./stopAnchors";

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
const OCCLUSION_ROUTE_STOPS = [
  { x: 3, y: 3 },
  { x: 7, y: 3 },
  { x: 11, y: 3 },
  { x: 15, y: 3 },
  { x: 19, y: 3 },
] as const;
const OCCLUSION_COVERED_STOP = { x: 21, y: 5 } as const;
const PRIMARY_ROAD_TILE = { x: 8, y: 4 } as const;
const ALTERNATE_ROAD_TILE = { x: 8, y: 6 } as const;
// The default Crossroads' built-in west arm: y=8 is westbound, y=9 eastbound,
// and the x=0 two-way cap joins them. Stops sit on opposite sides of the arm.
const CROSSROADS_ARM_STOPS = [
  { x: 5, y: 7 },
  { x: 5, y: 10 },
] as const;
// Both stops access the same westbound lane; the one-way test also removes
// the x=0 cap so the eastbound first leg cannot loop around the arm.
const CROSSROADS_ONE_WAY_STOPS = [
  { x: 5, y: 7 },
  { x: 10, y: 7 },
] as const;

function roadMovements(leg: RouteLegPath): MovementKind[] {
  return leg.currentPath?.kind === "road"
    ? leg.currentPath.steps.map((step) => step.movement)
    : [];
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
  await page.getByRole("button", { name: /^Save & run/ }).click();
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
  await page.getByTestId("route-waypoint-remove-1").click();

  await waitForRoutePreview(page, 2);
  const fleetQuote = (await runtimeSnapshot(page)).ui.routeDraft?.preview
    ?.initialFleet?.cost;
  expect(fleetQuote).toBeGreaterThan(0);
  const saveAndRun = page.getByRole("button", {
    name: `Save & run · ${formatBudget(fleetQuote!)}`,
    exact: true,
  });
  await expect(saveAndRun).toBeVisible();
  await saveAndRun.click();

  // The route now appears in the management panel.
  await openCommandDestination(page, "lines");
  await expect(page.getByTestId("panel-lines")).toBeVisible();
  await expect(page.getByTestId("route-name-route-001")).toBeVisible();
  await openCommandDestination(page, "data");
  const metrics = page.getByTestId("panel-data").getByRole("region", {
    name: "Metrics",
  });
  await expect(
    metrics.getByRole("button", {
      name: /Avg Wait \d+s.*show Crowding overlay/,
    }),
  ).toBeVisible();
  await expect(
    metrics.getByRole("button", {
      name: /Unserved \d+.*show Coverage overlay/,
    }),
  ).toBeVisible();
  await expect(
    metrics.getByRole("button", {
      name: /Late \d+.*show Traffic overlay/,
    }),
  ).toBeVisible();
  await openCommandDestination(page, "lines");

  // Toggle inactive, then delete (two clicks for confirm).
  await page.getByTestId("route-toggle-route-001").click();
  await page.getByTestId("route-delete-route-001").click();
  await page.getByTestId("route-delete-route-001").click();
  await expect(page.getByTestId("route-name-route-001")).toHaveCount(0);
});

test("runs a first Crossroads loop on the built-in arm caps", async ({
  page,
}, testInfo) => {
  await createDefaultCity(page, "Crossroads First Line");
  const canvas = page.locator("canvas[data-runtime-canvas='true']");
  await expect(canvas).toBeVisible();

  // No road is built: the default arm lanes and their new x=0 cap are the
  // whole fixture. The stops sit on opposite sides of the west arm.
  await selectBuildLeaf(page, "transit", "busStop");
  for (const stop of CROSSROADS_ARM_STOPS) {
    await clickMapTile(canvas, stop);
  }
  await openCommandDestination(page, "lines");
  await page.getByRole("button", { name: "New Bus" }).click();
  for (const stop of CROSSROADS_ARM_STOPS) {
    await clickMapTile(canvas, stop);
  }
  await openCommandDestination(page, "lines");
  await page.getByRole("radio", { name: "Loop" }).check();

  // A two-stop Loop has both service legs; both must connect over the cap.
  await waitForRoutePreview(page, 2);
  await expect
    .poll(async () => {
      const draft = (await runtimeSnapshot(page)).ui.routeDraft;
      return draft?.preview?.legs.map((leg) => leg.status) ?? null;
    })
    .toEqual(["connected", "connected"]);
  await expect(page.getByTestId("route-preview-status")).toHaveText(
    "Connected",
  );
  await expect(page.getByTestId("route-preview-failures")).toHaveCount(0);
  await page.getByRole("button", { name: /^Save & run/ }).click();

  await openCommandDestination(page, "lines");
  await expect(page.getByTestId("route-name-route-001")).toBeVisible();
  await expect(page.getByTestId("route-status-route-001")).toHaveText(
    "Running",
  );
  await expect
    .poll(async () => {
      const transit = await readRuntimeTransit(page);
      const route = transit.routes.find(
        (candidate) => candidate.id === "route-001",
      );
      return route?.vehicleIds.length ?? 0;
    })
    .toBeGreaterThan(0);

  // The deployed buses actually operate: resuming changes their itinerary
  // progress over the arm and its cap.
  const vehicleProgress = async () =>
    (await runtimeSnapshot(page)).state.transit.vehicles.map(
      (vehicle) =>
        `${vehicle.id}:${vehicle.itineraryIndex}:${vehicle.pathStepIndex}:${vehicle.stepProgress}`,
    );
  const initialProgress = await vehicleProgress();
  await page.getByRole("button", { name: "Resume" }).click();
  await expect
    .poll(vehicleProgress, { timeout: 15_000 })
    .not.toEqual(initialProgress);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await page.screenshot({
    path: testInfo.outputPath("crossroads-first-loop.png"),
  });
});

test("names the one-way fix when a Crossroads loop loses an end cap", async ({
  page,
}, testInfo) => {
  await createDefaultCity(page, "Crossroads One Way");
  const canvas = page.locator("canvas[data-runtime-canvas='true']");

  // Two roadside stops share the built-in westbound lane. The default x=0
  // two-way cap normally closes this loop; removing its y=8 tile leaves only
  // the one-way lanes, which the editor must identify and explain.
  await selectBuildLeaf(page, "transit", "busStop");
  for (const stop of CROSSROADS_ONE_WAY_STOPS) {
    await clickMapTile(canvas, stop);
  }
  await removeMapTile(page, canvas, { x: 0, y: 8 });

  await openCommandDestination(page, "lines");
  await page.getByRole("button", { name: "New Bus" }).click();
  for (const stop of CROSSROADS_ONE_WAY_STOPS) {
    await clickMapTile(canvas, stop);
  }
  await openCommandDestination(page, "lines");
  await page.getByRole("radio", { name: "Loop" }).check();
  await expect(page.getByTestId("route-preview-failures")).toContainText(
    "One-way roads block this leg. Add a turnaround, a roundabout or a two-way road.",
  );
  await expect(page.locator(".route-failure")).toHaveCount(1);
  await expect(page.getByTestId("route-preview-status")).toHaveText(
    /cannot connect/,
  );
  await expect(page.locator("button.route-save")).toBeDisabled();
  await page.screenshot({
    path: testInfo.outputPath("crossroads-one-way-warning.png"),
  });
});

test("proves route drafting can reach a stop beneath the Lines panel", async ({
  page,
}) => {
  await createDefaultCity(page, "Route Occlusion", "blankGrid");
  const canvas = page.locator("canvas[data-runtime-canvas='true']");
  await expect(canvas).toBeVisible();

  await selectBuildLeaf(page, "roads", "road-twoWay");
  await dragMapTiles(page, canvas, { x: 2, y: 4 }, { x: 21, y: 4 });
  await selectBuildLeaf(page, "transit", "busStop");
  const stops = [...OCCLUSION_ROUTE_STOPS, OCCLUSION_COVERED_STOP];
  for (const stop of stops) {
    await clickMapTile(canvas, stop);
  }
  await expectRoadsideStopAnchors(page, stops);

  await openCommandDestination(page, "lines");
  await page.getByRole("button", { name: "New Bus" }).click();
  await expect(page.getByTestId("command-panel")).toBeVisible();
  // HPA-977 passive resize keeps the drawn map where it was, so the dock now
  // covers the covered stop's viewport position. An explicit Fit reframes the
  // whole map into the docked stage, exposing it for drafting again.
  await page.getByTestId("map-zoom-fit").click();
  await expect
    .poll(async () => (await runtimeSnapshot(page)).camera)
    .toBeNull();

  const waypointCount = async () =>
    (await runtimeSnapshot(page)).ui.routeDraft?.waypointIds.length ?? 0;

  await clickMapTile(canvas, OCCLUSION_ROUTE_STOPS[0]);
  await expect.poll(waypointCount).toBe(1);

  // This stop sits where the old centred Lines panel covered the map. It must
  // stay clickable with the Lines dock still open.
  await clickMapTile(canvas, OCCLUSION_COVERED_STOP);
  await expect.poll(waypointCount).toBe(2);

  await expect(page.getByTestId("route-draft")).toBeVisible();
  await expect(page.getByTestId("route-waypoint-0")).toBeVisible();
  await expect(page.getByTestId("route-waypoint-1")).toBeVisible();
});

const ROUTE_PATH_DOCK_STOPS = [
  { x: 3, y: 3 },
  { x: 11, y: 3 },
] as const;

test("a route-path click that opens Lines keeps the map still at Fit and zoomed", async ({
  page,
}) => {
  await createDefaultCity(page, "Route Path Dock", "blankGrid");
  const canvas = page.locator("canvas[data-runtime-canvas='true']");
  const dock = page.getByTestId("workspace-dock");
  await expect(canvas).toBeVisible();

  // Pausing up front keeps every later commit intent-driven and parks the
  // deployed fleet at its spawn cursor for the whole test. A restored city
  // may already be paused, so only click when the Pause label is showing.
  const pause = page.getByRole("button", { name: "Pause", exact: true });
  if (await pause.isVisible()) await pause.click();
  await expect
    .poll(async () => (await runtimeSnapshot(page)).state.paused)
    .toBe(true);

  await selectBuildLeaf(page, "roads", "road-twoWay");
  await dragMapTiles(page, canvas, { x: 3, y: 4 }, { x: 20, y: 4 });
  await selectBuildLeaf(page, "transit", "busStop");
  for (const stop of ROUTE_PATH_DOCK_STOPS) {
    await clickMapTile(canvas, stop);
  }

  await openCommandDestination(page, "lines");
  await page.getByRole("button", { name: "New Bus" }).click();
  for (const stop of ROUTE_PATH_DOCK_STOPS) {
    await clickMapTile(canvas, stop);
  }
  await openCommandDestination(page, "lines");
  await page.getByRole("button", { name: /^Save & run/ }).click();
  await expect
    .poll(async () => {
      const route = (await runtimeSnapshot(page)).state.transit.routes.find(
        (candidate) => candidate.id === "route-001",
      );
      return route?.vehicleIds.length ?? 0;
    })
    .toBeGreaterThan(0);
  await page.getByRole("button", { name: "Close Lines" }).click();
  await expect(dock).toHaveCount(0);
  await settleLayout(page);

  // Pick a route-path tile no parked bus occupies or is driving into, so
  // the Inspect click resolves the line rather than a vehicle.
  const snapshot = await runtimeSnapshot(page);
  const route = snapshot.state.transit.routes.find(
    (candidate) => candidate.id === "route-001",
  );
  if (route === undefined) {
    throw new Error("Committed route is missing from the runtime snapshot");
  }
  const taken = new Set<string>();
  for (const vehicle of snapshot.state.transit.vehicles) {
    const steps: readonly { position: { x: number; y: number } }[] | undefined =
      route.legs[vehicle.itineraryIndex % route.legs.length]?.currentPath
        ?.steps;
    if (steps === undefined) continue;
    for (const index of [vehicle.pathStepIndex, vehicle.pathStepIndex + 1]) {
      const step = steps[index];
      if (step !== undefined) {
        taken.add(`${step.position.x},${step.position.y}`);
      }
    }
  }
  const pathPositions: { x: number; y: number }[] = [];
  for (const leg of route.legs) {
    for (const step of leg.currentPath?.steps ?? []) {
      pathPositions.push(step.position);
    }
  }
  const pathTile = pathPositions.find(
    (position) =>
      position.x >= 5 &&
      position.x <= 10 &&
      !taken.has(`${position.x},${position.y}`),
  );
  if (pathTile === undefined) {
    throw new Error("No vehicle-free route-path tile between the stops");
  }
  await selectTool(page, "select");

  // At Fit, clicking the route path opens the Lines dock and the map keeps
  // its rendered position through the dock opening.
  const fitBefore = await mapTileViewportPoint(canvas, pathTile);
  const fitScaleBefore = await mapBoardScale(canvas);
  await clickMapTile(canvas, pathTile);
  await expect(dock).toBeVisible();
  await expect(page.getByTestId("panel-lines")).toBeVisible();
  // The camera rebases when the resize is observed; wait for the drawn box
  // to settle so the measurement is not taken mid-resize.
  await settleLayout(page);
  const fitAfter = await mapTileViewportPoint(canvas, pathTile);
  expect(fitAfter.x, "route-path dock open: tile keeps viewport x").toBeCloseTo(
    fitBefore.x,
    0,
  );
  expect(fitAfter.y, "route-path dock open: tile keeps viewport y").toBeCloseTo(
    fitBefore.y,
    0,
  );
  expect(
    await mapBoardScale(canvas),
    "route-path dock open keeps the drawn CSS scale",
  ).toBeCloseTo(fitScaleBefore, 6);
  await expect
    .poll(async () => {
      await hoverMapTile(canvas, pathTile);
      return (await runtimeSnapshot(page)).ui.hoverTile;
    })
    .toEqual(pathTile);

  // Zoomed, the same route-path click must keep the view still too.
  await page.getByRole("button", { name: "Close Lines" }).click();
  await expect(dock).toHaveCount(0);
  await settleLayout(page);
  await page.getByTestId("map-zoom-in").click();
  await page.getByTestId("map-zoom-in").click();
  await expect
    .poll(async () => (await runtimeSnapshot(page)).camera?.zoom ?? 1)
    .toBeGreaterThan(1);
  const zoomedBefore = await mapTileViewportPoint(canvas, pathTile);
  const zoomedScaleBefore = await mapBoardScale(canvas);
  await clickMapTile(canvas, pathTile);
  await expect(page.getByTestId("panel-lines")).toBeVisible();
  await settleLayout(page);
  const zoomedAfter = await mapTileViewportPoint(canvas, pathTile);
  expect(
    zoomedAfter.x,
    "zoomed route-path dock open: tile keeps viewport x",
  ).toBeCloseTo(zoomedBefore.x, 0);
  expect(
    zoomedAfter.y,
    "zoomed route-path dock open: tile keeps viewport y",
  ).toBeCloseTo(zoomedBefore.y, 0);
  expect(
    await mapBoardScale(canvas),
    "zoomed route-path dock open keeps the drawn CSS scale",
  ).toBeCloseTo(zoomedScaleBefore, 6);
  await expect
    .poll(async () => {
      await hoverMapTile(canvas, pathTile);
      return (await runtimeSnapshot(page)).ui.hoverTile;
    })
    .toEqual(pathTile);
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
  await canvas.click({ button: "right", position: { x: 640, y: 400 } });
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
  await page.getByRole("button", { name: /^Save & run/ }).click();

  await openCommandDestination(page, "lines");
  await expect(page.getByTestId("panel-lines")).toBeVisible();
  await expect(page.getByTestId("route-name-metro-001")).toBeVisible();
  await expect
    .poll(async () => {
      const line = (await readRuntimeTransit(page)).metroLines.find(
        (candidate) => candidate.id === "metro-001",
      );
      return line?.vehicleIds.length ?? 0;
    })
    .toBeGreaterThan(0);
});

test("finishing a bus route starts its initial fleet", async ({ page }) => {
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
  await waitForRoutePreview(page, SIMPLE_ROUTE_STOPS.length);

  // An affordable Standard draft quotes the whole pre-save fleet picture.
  await expect(page.getByTestId("route-after-save-fleet")).toHaveText(
    /\d+ vehicles/,
  );
  await expect(page.getByTestId("route-after-save-running")).toHaveText(
    /\$[\d,]+\/day/,
  );
  await expect(
    page.getByRole("button", { name: /^Save & run · \$/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: /^Save & run/ }).click();

  // Save & run commits the route before the initial fleet dispatch. Poll the
  // live Rust-derived transit state until both commits are observable.
  await openCommandDestination(page, "lines");
  await expect(page.getByTestId("route-name-route-001")).toBeVisible();
  await expect
    .poll(async () => {
      const transit = await readRuntimeTransit(page);
      const route = transit.routes.find(
        (candidate) => candidate.id === "route-001",
      );
      return route?.vehicleIds.length ?? 0;
    })
    .toBeGreaterThan(0);
  const transit = await readRuntimeTransit(page);
  expect(transit.routes).toHaveLength(1);
  const route = transit.routes.find(
    (candidate) => candidate.id === "route-001",
  );
  expect(route?.vehicleIds.length).toBeGreaterThan(0);
  expect(transit.vehicles).toHaveLength(route!.vehicleIds.length);
  expect(transit.vehicles.every((vehicle) => vehicle.mode === "bus")).toBe(
    true,
  );
});

async function draftTwoStopBusRoute(
  page: import("@playwright/test").Page,
): Promise<number> {
  const canvas = page.locator("canvas[data-runtime-canvas='true']");
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
  await expect(page.getByTestId("route-draft")).toBeVisible();
  await waitForRoutePreview(page, DRAFT_ROUTE_STOPS.length);
  const quote = (await runtimeSnapshot(page)).ui.routeDraft?.preview
    ?.initialFleet?.cost;
  if (quote === undefined || quote === null || quote <= 0) {
    throw new Error("Rust did not quote an initial fleet for the draft");
  }
  return quote;
}

async function createCityWithEconomy(
  page: import("@playwright/test").Page,
  name: string,
  economyLabel: "Standard" | "Creative",
): Promise<void> {
  await page.goto("/");
  const newCityScreen = page.getByTestId("new-city-screen");
  const libraryNewCityButton = page
    .getByTestId("city-library-screen")
    .getByRole("button", { name: "New City", exact: true });
  await expect(newCityScreen.or(libraryNewCityButton)).toBeVisible();
  if (await libraryNewCityButton.isVisible()) {
    await libraryNewCityButton.click();
  }
  await expect(newCityScreen).toBeVisible();
  await page.getByLabel("City name").fill(name);
  await page
    .getByRole("radio", { name: new RegExp(`^${economyLabel}`) })
    .check();
  await page.getByRole("radio", { name: "Crossroads" }).check();
  await page.getByRole("button", { name: "Create City" }).click();
  await expect(page.getByTestId("game-canvas-host")).toBeVisible();
  await expect(
    page.locator("canvas[data-runtime-canvas='true']"),
  ).toBeVisible();
}

test("operates the route editor with the keyboard", async ({ page }) => {
  await createDefaultCity(page, "Keyboard Drafting");
  await expect(page.getByTestId("game-shell")).toBeVisible();
  const canvas = page.locator("canvas[data-runtime-canvas='true']");

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
  await waitForRoutePreview(page, DRAFT_ROUTE_STOPS.length);

  // Actual native radio-group arrow navigation on the segmented control:
  // the focused radio moves selection and fires the pattern change.
  const loop = page.getByRole("radio", { name: "Loop" });
  const shuttle = page.getByRole("radio", { name: "Shuttle" });
  await loop.focus();
  await expect(loop).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(shuttle).toBeChecked();
  await expect(loop).not.toBeChecked();
  expect((await runtimeSnapshot(page)).ui.routeDraft?.pattern).toBe("shuttle");
  await page.keyboard.press("ArrowLeft");
  await expect(loop).toBeChecked();
  expect((await runtimeSnapshot(page)).ui.routeDraft?.pattern).toBe("loop");

  // Save is keyboard-operable through the ordinary focused-button path.
  const save = page.getByRole("button", { name: /^Save & run/ });
  await save.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("route-name-route-001")).toBeVisible();

  // Escape cancels an edit draft exactly like the Cancel button.
  await page.getByRole("button", { name: "Edit route Bus 1" }).click();
  await expect(page.getByTestId("route-draft")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("route-draft")).toHaveCount(0);

  // Draft undo/redo keyboard shortcuts keep working on a fresh draft.
  await openCommandDestination(page, "lines");
  await page.getByRole("button", { name: "New Bus" }).click();
  for (const stop of DRAFT_ROUTE_STOPS) {
    await clickMapTile(canvas, stop);
  }
  await waitForRoutePreview(page, DRAFT_ROUTE_STOPS.length);
  const mac = (await page.evaluate(() => navigator.platform)).includes("Mac");
  const undoShortcut = mac ? "Meta+Z" : "Control+Z";
  // Shift must precede Z: Playwright presses chord keys in order, so
  // "Control+Z+Shift" would fire the Z keydown before Shift is held and
  // repeat the undo instead of redoing.
  const redoShortcut = mac ? "Meta+Shift+Z" : "Control+Shift+Z";
  await page.keyboard.press(undoShortcut);
  await waitForRoutePreview(page, 1);
  await page.keyboard.press(redoShortcut);
  await waitForRoutePreview(page, DRAFT_ROUTE_STOPS.length);
});

test("warns before save when the fleet is unaffordable and recovers without fleet", async ({
  page,
}) => {
  await createDefaultCity(page, "Low Money Lines");
  await expect(page.getByTestId("game-shell")).toBeVisible();

  const quote = await draftTwoStopBusRoute(page);

  // Undercut the quoted fleet price before any click: the editor must show
  // the low-money summary and the Save-without-fleet affordance first.
  await debugSetBudget(page, quote - 1);
  await expect(page.getByTestId("route-after-save-fleet")).toHaveText(
    "None yet",
  );
  await expect(page.getByTestId("route-after-save-running")).toHaveText(
    "$0/day",
  );
  await expect(page.getByTestId("route-shortfall-reason")).toContainText(
    `Needs ${formatBudget(quote)}`,
  );
  await expect(
    page.getByRole("button", { name: "Save without fleet" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Save without fleet" }).click();

  // The line exists, is selected, and has no fleet — without a redundant
  // toast repeating the warning the editor already showed.
  await expect(page.getByTestId("route-name-route-001")).toBeVisible();
  await expect(page.getByTestId("action-feedback")).toHaveCount(0);
  await expect(page.getByText("Saved without fleet")).toHaveCount(0);
  const saved = await readRuntimeTransit(page);
  expect(
    saved.routes.find((route) => route.id === "route-001")?.vehicleIds ?? [],
  ).toEqual([]);

  // An ordinary (non-save-path) shortage on a later manual Deploy surfaces
  // the plain rejection toast; the save-path fallback has its own test below.
  await debugSetBudget(page, 0);
  await page.getByTestId("route-deploy-route-001").click();
  await expect(page.getByTestId("action-feedback")).toContainText(
    /Needs .+; only \$0 is available\./,
  );

  // Replenish the budget and deploy the fleet through the Lines card.
  await debugSetBudget(page, 200_000);
  await page.getByTestId("route-deploy-route-001").click();
  await expect
    .poll(
      async () =>
        (await readRuntimeTransit(page)).routes.find(
          (route) => route.id === "route-001",
        )?.vehicleIds.length ?? 0,
    )
    .toBeGreaterThan(0);
});

test("tags a save-path late shortage when the budget drains before deployment", async ({
  page,
}) => {
  await createDefaultCity(page, "Late Shortage Save");
  await expect(page.getByTestId("game-shell")).toBeVisible();

  const quote = await draftTwoStopBusRoute(page);

  // Deterministic lateness on the real Save → create → deployment path: the
  // Save click reads the budget synchronously (still full, no known
  // shortage) while the serialized save authorizes the deployment against
  // the live budget afterwards. The budget change and the save enqueue on
  // the same FIFO gameplay queue, so issuing both in one browser turn
  // guarantees the deployment executes against the drained budget — no
  // timing race.
  await page.evaluate(() => {
    const runtime = (
      window as unknown as {
        __caelumRuntime?: {
          debugSetBudget?: (budget: number) => Promise<unknown>;
          saveRouteDraft?: () => Promise<unknown>;
        };
      }
    ).__caelumRuntime;
    if (
      runtime?.debugSetBudget === undefined ||
      runtime.saveRouteDraft === undefined
    ) {
      throw new Error(
        "debugSetBudget/saveRouteDraft unavailable on window.__caelumRuntime",
      );
    }
    void runtime.debugSetBudget(0);
    void runtime.saveRouteDraft();
  });

  // The save created the line, its deployment hit the drained budget, and
  // the shortage is tagged as the savedWithoutFleet recovery fallback.
  await expect(page.getByTestId("route-name-route-001")).toBeVisible();
  await expect(page.getByTestId("action-feedback")).toContainText(
    `Saved without fleet: Needs ${formatBudget(quote)}; only $0 is available.`,
  );
  const lateSaved = await readRuntimeTransit(page);
  expect(
    lateSaved.routes.find((route) => route.id === "route-001")?.vehicleIds ??
      [],
  ).toEqual([]);

  // Replenish the budget and deploy the fleet from the Lines card.
  await debugSetBudget(page, 200_000);
  await page.getByTestId("route-deploy-route-001").click();
  await expect
    .poll(
      async () =>
        (await readRuntimeTransit(page)).routes.find(
          (route) => route.id === "route-001",
        )?.vehicleIds.length ?? 0,
    )
    .toBeGreaterThan(0);
});

test("creative sandbox prices the fleet nominally and never warns", async ({
  page,
}) => {
  await createCityWithEconomy(page, "Creative Lines", "Creative");
  await expect(page.getByTestId("game-shell")).toBeVisible();

  await debugSetBudget(page, 0);
  const quote = await draftTwoStopBusRoute(page);

  // Creative shows the nominal projection even at zero budget: no shortfall,
  // no Save-without-fleet relabel.
  await expect(page.getByTestId("route-after-save-fleet")).toHaveText(
    /\d+ vehicles/,
  );
  await expect(page.getByTestId("route-after-save-running")).toHaveText(
    /\$[\d,]+\/day/,
  );
  await expect(page.getByTestId("route-shortfall-reason")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: `Save & run · ${formatBudget(quote)}` }),
  ).toBeVisible();

  await page
    .getByRole("button", { name: `Save & run · ${formatBudget(quote)}` })
    .click();

  await expect(page.getByTestId("route-name-route-001")).toBeVisible();
  await expect(page.getByTestId("action-feedback")).toHaveCount(0);
  await expect
    .poll(
      async () =>
        (await readRuntimeTransit(page)).routes.find(
          (route) => route.id === "route-001",
        )?.vehicleIds.length ?? 0,
    )
    .toBeGreaterThan(0);
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

  // Save & run starts a bus service over all three stops.
  await openCommandDestination(page, "lines");
  await page.getByRole("button", { name: "New Bus" }).click();
  for (const stop of SIMPLE_ROUTE_STOPS) {
    await clickMapTile(canvas, stop);
  }
  await openCommandDestination(page, "lines");
  await expect(page.getByTestId("route-draft")).toBeVisible();
  await page.getByRole("button", { name: /^Save & run/ }).click();
  await openCommandDestination(page, "lines");
  await expect(page.getByTestId("route-name-route-001")).toBeVisible();

  // Save & run can publish the route before assigning its initial fleet.
  await expect
    .poll(async () => {
      const transit = await readRuntimeTransit(page);
      const route = transit.routes.find(
        (candidate) => candidate.id === "route-001",
      );
      return route?.vehicleIds.length ?? 0;
    })
    .toBeGreaterThan(0);
  const initialTransit = await readRuntimeTransit(page);
  const initialRoute = initialTransit.routes.find(
    (candidate) => candidate.id === "route-001",
  );
  expect(initialRoute?.vehicleIds.length).toBeGreaterThan(0);
  expect(initialTransit.vehicles).toHaveLength(initialRoute!.vehicleIds.length);
  await expect(page.getByTestId("route-status-route-001")).toHaveText(
    "Running",
  );

  // Edit the already-running service's whole-minute target headway.
  const service = page.getByTestId("route-service-route-001");
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
  // The single target editor reflects the applied whole-minute target.
  await expect(page.getByTestId("route-headway-route-001")).toHaveValue("1");
  await expect(service).toContainText("Fleet");

  // Save & run already deployed the initial fleet. Changing the target does
  // not issue another DeployInitialFleet for this now-running route.
  const deployedFleet = initialRoute!.vehicleIds.length;
  await expect
    .poll(async () => {
      const transit = await readRuntimeTransit(page);
      const route = transit.routes.find(
        (candidate) => candidate.id === "route-001",
      );
      return route?.vehicleIds.length ?? 0;
    })
    .toBe(deployedFleet);
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

  // Running-service UI keeps the single target editor and shows the live
  // Every interval with separate Fleet/Recommended values; setup deploy
  // controls stay absent.
  await expect(page.getByTestId("route-headway-route-001")).toHaveValue("1");
  await expect(
    service.getByText("Every").locator("xpath=following-sibling::span[1]"),
  ).toHaveText(/^\d+\.\d min$/);
  await expect(
    service.getByText("Fleet").locator("xpath=following-sibling::span[1]"),
  ).toHaveText(String(deployedFleet));
  await expect(
    service
      .getByText("Recommended")
      .locator("xpath=following-sibling::span[1]"),
  ).toHaveText(new RegExp(`^${postDeployRequired} bus(?:es)?$`));
  await expect(service.getByText("No fleet")).toHaveCount(0);
  await expect(page.getByTestId("route-headway-route-001")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Set", exact: true }),
  ).toBeVisible();
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

  // Resume so the unpaused simulation keeps live metrics and service state
  // refreshed through the edits and the paid top-up below.
  await page.getByRole("button", { name: "Resume" }).click();

  await page.getByRole("button", { name: "Edit route Bus 1" }).click();
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

test("tunes a Save & run bus service from its line summary", async ({
  page,
}) => {
  await createDefaultCity(page);
  await expect(page.getByTestId("game-shell")).toBeVisible();
  const canvas = page.locator("canvas[data-runtime-canvas='true']");
  await expect(canvas).toBeVisible();

  // Road + three roadside bus stops beside it (same fixtures as above).
  await selectBuildLeaf(page, "roads", "road-twoWay");
  await dragMapTiles(page, canvas, { x: 3, y: 4 }, { x: 11, y: 4 });
  await selectBuildLeaf(page, "transit", "busStop");
  for (const stop of SIMPLE_ROUTE_STOPS) {
    await clickMapTile(canvas, stop);
  }
  await expectRoadsideStopAnchors(page, SIMPLE_ROUTE_STOPS);

  // Save & run starts the bus service with its default target headway.
  await openCommandDestination(page, "lines");
  await page.getByRole("button", { name: "New Bus" }).click();
  for (const stop of SIMPLE_ROUTE_STOPS) {
    await clickMapTile(canvas, stop);
  }
  await openCommandDestination(page, "lines");
  await page.getByRole("button", { name: /^Save & run/ }).click();
  await openCommandDestination(page, "lines");
  await expect(page.getByTestId("route-name-route-001")).toBeVisible();
  await expect
    .poll(async () => {
      const route = (await runtimeSnapshot(page)).state.transit.routes.find(
        (candidate) => candidate.id === "route-001",
      );
      return route?.vehicleIds.length ?? 0;
    })
    .toBeGreaterThan(0);

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
  // Leave geometry edit mode so no later interaction can add waypoints.
  await selectTool(page, "select");

  // The accepted Save selects and highlights the new line's row without
  // opening the geometry editor.
  await expect
    .poll(async () => (await runtimeSnapshot(page)).ui.selectedRouteId)
    .toBe("route-001");
  await expect(page.getByTestId("route-draft")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Select Bus 1" }),
  ).toHaveAttribute("aria-pressed", "true");

  // Record the deployed baseline from Rust before retargeting.
  const baselineSnapshot = await runtimeSnapshot(page);
  const baselineRoute = baselineSnapshot.state.transit.routes.find(
    (candidate) => candidate.id === "route-001",
  );
  if (baselineRoute === undefined || baselineRoute.serviceMetrics === null) {
    throw new Error("Deployed bus route is missing from the runtime snapshot");
  }
  const baselineAssigned = baselineRoute.vehicleIds.length;
  const originalVehicleIds = [...baselineRoute.vehicleIds];
  const baselineBudget = baselineSnapshot.state.budget;
  const baselineNominal =
    baselineRoute.serviceMetrics.nominalHeadwaySeconds ?? null;
  const baselineDailyCost = baselineRoute.serviceMetrics.dailyOperatingCost;
  expect(baselineAssigned).toBeGreaterThan(0);
  expect(baselineNominal).not.toBeNull();

  // Retarget the deployed service to a longer headway. Rust's required fleet
  // is monotone in the target, so 4 minutes cannot exceed the fleet that was
  // deployed at 1 minute — read the post-dispatch snapshot rather than
  // recomputing the recommendation in the browser.
  await page.getByTestId("route-headway-route-001").fill("4");
  await page.getByTestId("route-headway-set-route-001").click();
  await expect
    .poll(async () => {
      const route = (await runtimeSnapshot(page)).state.transit.routes.find(
        (candidate) => candidate.id === "route-001",
      );
      return (
        route?.targetHeadwaySeconds === 240 &&
        route?.serviceMetrics?.requiredFleet != null
      );
    })
    .toBe(true);
  const retargetedSnapshot = await runtimeSnapshot(page);
  const retargetedRoute = retargetedSnapshot.state.transit.routes.find(
    (candidate) => candidate.id === "route-001",
  );
  if (
    retargetedRoute === undefined ||
    retargetedRoute.serviceMetrics === null ||
    retargetedRoute.serviceMetrics.requiredFleet === null
  ) {
    throw new Error("Retargeted service metrics are missing from the runtime");
  }
  const retargetedRequired = retargetedRoute.serviceMetrics.requiredFleet;
  expect(baselineAssigned).toBeGreaterThanOrEqual(retargetedRequired);

  // At or above the recommendation the Add offer persists at Rust's price.
  const nextVehicleCost =
    retargetedRoute.serviceMetrics.nextVehicleCost ?? null;
  expect(nextVehicleCost).not.toBeNull();
  if (nextVehicleCost === null) {
    throw new Error("Rust did not publish an Add price for the deployed fleet");
  }
  // The journey must stay paused (design step 2): no sim time passes, so the
  // added vehicle cannot board riders before it is retired.
  expect((await runtimeSnapshot(page)).state.paused).toBe(true);
  const addBus = page.getByTestId("route-add-vehicle-route-001");
  await expect(addBus).toBeVisible();

  // Add exactly one vehicle: fleet +1, originals remain, Standard budget
  // drops by the recorded price.
  await addBus.click();
  await expect
    .poll(async () => {
      const snapshot = await runtimeSnapshot(page);
      const route = snapshot.state.transit.routes.find(
        (candidate) => candidate.id === "route-001",
      );
      return (
        route !== undefined &&
        route.vehicleIds.length === baselineAssigned + 1 &&
        snapshot.state.budget === baselineBudget - nextVehicleCost
      );
    })
    .toBe(true);
  const postAddSnapshot = await runtimeSnapshot(page);
  const postAddRoute = postAddSnapshot.state.transit.routes.find(
    (candidate) => candidate.id === "route-001",
  );
  if (postAddRoute === undefined || postAddRoute.serviceMetrics === null) {
    throw new Error("Post-add service metrics are missing from the runtime");
  }
  expect(postAddRoute.vehicleIds.length).toBe(baselineAssigned + 1);
  for (const vehicleId of originalVehicleIds) {
    expect(postAddRoute.vehicleIds).toContain(vehicleId);
  }
  expect(postAddSnapshot.state.budget).toBe(baselineBudget - nextVehicleCost);

  // The deployed block refreshes from the same Rust projection: interval
  // shortens with the larger fleet, daily cost grows with it.
  const postAddMetrics = postAddRoute.serviceMetrics;
  const postAddNominal = postAddMetrics.nominalHeadwaySeconds ?? null;
  expect(postAddNominal).not.toBeNull();
  if (postAddNominal === null) {
    throw new Error("Post-add nominal headway is missing from the runtime");
  }
  expect(postAddNominal).toBeLessThan(baselineNominal!);
  expect(postAddMetrics.dailyOperatingCost).toBeGreaterThan(baselineDailyCost);
  const service = page.getByTestId("route-service-route-001");
  await expect(
    service.getByText("Every").locator("xpath=following-sibling::span[1]"),
  ).toHaveText(`${(postAddNominal / 60).toFixed(1)} min`);
  await expect(
    service.getByText("Fleet").locator("xpath=following-sibling::span[1]"),
  ).toHaveText(String(postAddRoute.vehicleIds.length));
  await expect(
    service
      .getByText("Recommended")
      .locator("xpath=following-sibling::span[1]"),
  ).toHaveText(new RegExp(`^${retargetedRequired} bus(?:es)?$`));
  await expect(
    service.getByText("Daily cost").locator("xpath=following-sibling::span[1]"),
  ).toHaveText(formatBudget(postAddMetrics.dailyOperatingCost));

  // No sim time has elapsed, so Rust reports no waiters: the wait rows stay
  // absent rather than fabricating a benchmark number.
  expect(postAddMetrics.longestWaitSeconds ?? null).toBeNull();
  expect(postAddMetrics.waitingAtRiskCount ?? 0).toBe(0);
  await expect(service.getByText("Longest wait")).toHaveCount(0);
  await expect(page.getByTestId("route-health-route-001")).toHaveCount(0);

  const addedVehicleId = postAddRoute.vehicleIds.find(
    (vehicleId) => !originalVehicleIds.includes(vehicleId),
  );
  if (addedVehicleId === undefined) {
    throw new Error("Post-add route is missing the newly added vehicle id");
  }
  expect(postAddRoute.serviceMetrics.canRetireVehicle).toBe(true);
  await page
    .getByRole("button", { name: "Retire bus on Bus 1 · no refund" })
    .click();
  await expect
    .poll(async () => {
      const route = (await runtimeSnapshot(page)).state.transit.routes.find(
        (candidate) => candidate.id === "route-001",
      );
      return route?.vehicleIds.length ?? -1;
    })
    .toBe(baselineAssigned);
  const postRetireSnapshot = await runtimeSnapshot(page);
  const postRetireRoute = postRetireSnapshot.state.transit.routes.find(
    (candidate) => candidate.id === "route-001",
  );
  if (
    postRetireRoute === undefined ||
    postRetireRoute.serviceMetrics === null
  ) {
    throw new Error("Post-retire service metrics are missing from the runtime");
  }
  expect(postRetireRoute.serviceMetrics.dailyOperatingCost).toBe(
    baselineDailyCost,
  );
  expect(postRetireSnapshot.state.budget).toBe(
    baselineBudget - nextVehicleCost,
  );
  for (const vehicleId of originalVehicleIds) {
    expect(postRetireRoute.vehicleIds).toContain(vehicleId);
  }
  expect(postRetireRoute.vehicleIds).not.toContain(addedVehicleId);

  // The whole journey ran without ever entering geometry edit mode.
  const finalSnapshot = await runtimeSnapshot(page);
  expect(finalSnapshot.ui.routeDraft).toBeNull();
  expect(finalSnapshot.ui.selectedRouteId).toBe("route-001");
  await expect(page.getByTestId("route-draft")).toHaveCount(0);
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
  await page.getByRole("button", { name: /^Save & run/ }).click();

  // Poll until the route is committed — the Save dispatch is async.
  await expect
    .poll(async () => {
      const routes = (await runtimeSnapshot(page)).state.transit.routes;
      return routes.length > 0;
    })
    .toBe(true);

  await openCommandDestination(page, "lines");
  await page.getByRole("button", { name: "Edit route Bus 1" }).click();
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
  await page.getByRole("button", { name: /^Save & run/ }).click();
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
    "Running",
  );
});

test("starts a Metro service with Save & run and tunes its target headway", async ({
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

  // Fund and start the Metro service from its new route draft.
  await debugSetBudget(page, 500_000);
  await openCommandDestination(page, "lines");
  await page.getByRole("button", { name: "New Metro" }).click();
  await clickMapTile(canvas, { x: 8, y: 2 });
  await clickMapTile(canvas, { x: 12, y: 2 });
  await expect(page.getByTestId("route-draft")).toBeVisible();
  await page.getByRole("button", { name: /^Save & run/ }).click();
  await openCommandDestination(page, "lines");

  await expect
    .poll(async () => (await runtimeSnapshot(page)).state.transit.metroLines)
    .not.toHaveLength(0);
  const lineId = (await runtimeSnapshot(page)).state.transit.metroLines.at(
    -1,
  )!.id;
  await expect(page.getByTestId(`route-name-${lineId}`)).toBeVisible();
  await expect
    .poll(async () => {
      const line = (await readRuntimeTransit(page)).metroLines.find(
        (candidate) => candidate.id === lineId,
      );
      return line?.vehicleIds.length ?? 0;
    })
    .toBeGreaterThan(0);
  const startedLine = (
    await runtimeSnapshot(page)
  ).state.transit.metroLines.find((line) => line.id === lineId);
  expect(startedLine?.vehicleIds.length).toBeGreaterThan(0);
  await expect(page.getByTestId(`route-status-${lineId}`)).toHaveText(
    "Running",
  );

  // Set a whole-minute target; the panel displays Rust's service metrics.
  const service = page.getByTestId(`route-service-${lineId}`);
  await page.getByTestId(`route-headway-${lineId}`).fill("6");
  await page.getByTestId(`route-headway-set-${lineId}`).click();
  // The saved running line shows the actual target in its single editor and
  // the live interval, with separate Fleet/Recommended; setup deploy controls
  // stay absent.
  await expect(page.getByTestId(`route-headway-${lineId}`)).toHaveValue("6");
  await expect(
    service.getByText("Every").locator("xpath=following-sibling::span[1]"),
  ).toHaveText(/^\d+\.\d min$/);
  await expect(
    service
      .getByText("Recommended")
      .locator("xpath=following-sibling::span[1]"),
  ).toHaveText("1 train");
  const updatedSnapshot = await runtimeSnapshot(page);
  const updatedLine = updatedSnapshot.state.transit.metroLines.find(
    (line) => line.id === lineId,
  );
  const requiredFleet = updatedLine?.serviceMetrics?.requiredFleet;
  if (requiredFleet === null || requiredFleet === undefined) {
    throw new Error(
      "Rust required fleet is missing for the running Metro line",
    );
  }
  const vehicleIds = updatedLine?.vehicleIds ?? [];
  expect(vehicleIds.length).toBeGreaterThan(0);
  await expect(
    service.getByText("Fleet").locator("xpath=following-sibling::span[1]"),
  ).toHaveText(String(vehicleIds.length));
  await expect(
    service
      .getByText("Recommended")
      .locator("xpath=following-sibling::span[1]"),
  ).toHaveText(new RegExp(`^${requiredFleet} trains?$`));
  await expect(service.getByText("Est. deploy cost")).toHaveCount(0);
  await expect(page.getByTestId(`route-headway-${lineId}`)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Set", exact: true }),
  ).toBeVisible();
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

test("navigates from a selected stop to its serving line and back", async ({
  page,
}) => {
  await createDefaultCity(page);
  await expect(page.getByTestId("game-shell")).toBeVisible();
  const canvas = page.locator("canvas[data-runtime-canvas='true']");
  await expect(canvas).toBeVisible();

  // Road + three roadside bus stops, then one route serving them.
  await selectBuildLeaf(page, "roads", "road-twoWay");
  await dragMapTiles(page, canvas, { x: 3, y: 4 }, { x: 11, y: 4 });
  await selectBuildLeaf(page, "transit", "busStop");
  for (const stop of SIMPLE_ROUTE_STOPS) {
    await clickMapTile(canvas, stop);
  }
  await expectRoadsideStopAnchors(page, SIMPLE_ROUTE_STOPS);

  await openCommandDestination(page, "lines");
  await page.getByRole("button", { name: "New Bus" }).click();
  for (const stop of SIMPLE_ROUTE_STOPS) {
    await clickMapTile(canvas, stop);
  }
  await openCommandDestination(page, "lines");
  await page.getByRole("button", { name: /^Save & run/ }).click();

  // The Save dispatch is asynchronous; wait for the committed route and the
  // cleared draft before leaving geometry mode.
  await expect
    .poll(async () => {
      const snapshot = await runtimeSnapshot(page);
      return {
        routes: snapshot.state.transit.routes.length,
        draftClosed: snapshot.ui.routeDraft === null,
      };
    })
    .toEqual({ routes: 1, draftClosed: true });

  // Saving leaves the Lines panel open; close it so the stop inspector can
  // render, then select the served stop with the ordinary Inspect tool.
  await page.getByRole("button", { name: "Close Lines" }).click();
  await expect(page.getByTestId("command-panel")).toHaveCount(0);
  await settleLayout(page);
  await selectTool(page, "select");
  await clickMapTile(canvas, SIMPLE_ROUTE_STOPS[0]);
  await expect(page.getByTestId("panel-inspect")).toBeVisible();

  const selected = await runtimeSnapshot(page);
  expect(selected.ui.selectedId).toBe(
    `${SIMPLE_ROUTE_STOPS[0].x},${SIMPLE_ROUTE_STOPS[0].y}`,
  );
  const stop = selected.state.transit.stops.find(
    (candidate) =>
      candidate.status === "present" &&
      candidate.position.x === SIMPLE_ROUTE_STOPS[0].x &&
      candidate.position.y === SIMPLE_ROUTE_STOPS[0].y,
  );
  if (stop === undefined || stop.platforms.length !== 1) {
    throw new Error("Selected stop is missing from the runtime snapshot");
  }
  const platformId = stop.platforms[0]!.id;
  const servingRoute = selected.state.transit.routes.find((route) =>
    route.stopIds.includes(stop.id),
  );
  if (servingRoute === undefined) {
    throw new Error("No committed route serves the selected stop");
  }

  await expect(page.getByTestId(`platform-queue-${platformId}`)).toHaveText(
    /^Queue \d+\/\d+$/,
  );
  // No simulation time has elapsed, so the serving line's wait row reads zero.
  await expect(page.getByTestId(`route-wait-${servingRoute.id}`)).toHaveText(
    "0 waiting · No current wait",
  );

  // The serving-line chip opens Lines on the same route with no draft.
  await page.getByTestId(`open-service-${servingRoute.id}`).click();
  await expect(page.getByTestId("panel-lines")).toBeVisible();
  await expect
    .poll(async () => {
      const ui = (await runtimeSnapshot(page)).ui;
      return {
        destination: ui.activeCommandDestination,
        selectedRouteId: ui.selectedRouteId,
        draftClosed: ui.routeDraft === null,
      };
    })
    .toEqual({
      destination: "lines",
      selectedRouteId: servingRoute.id,
      draftClosed: true,
    });
  await expect(
    page.getByRole("button", { name: `Select ${servingRoute.name}` }),
  ).toHaveAttribute("aria-pressed", "true");

  // Closing Lines returns to the same stop inspector.
  await page.getByRole("button", { name: "Close Lines" }).click();
  await expect(page.getByTestId("panel-inspect")).toBeVisible();
  const returned = await runtimeSnapshot(page);
  expect(returned.ui.selectedId).toBe(
    `${SIMPLE_ROUTE_STOPS[0].x},${SIMPLE_ROUTE_STOPS[0].y}`,
  );
  expect(returned.ui.selectedNodeKind).toBe("stop");
  expect(returned.ui.activeCommandDestination).toBeNull();
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
  // Restoring the alternate road leaves the already-running service in place.
  await expect(page.getByTestId("route-status-" + broken.id)).toHaveText(
    "Running",
  );
});
