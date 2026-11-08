import { expect, test, type Page } from "@playwright/test";
import { HUD_INSET, maxZoom, tileSize } from "../../src/render/boardTransform";
import { VEHICLE_INSTANCE_FLOATS } from "../../src/render/webgpu/renderer";
import { encodeVehicleInstances } from "../../src/render/webgpu/vehicleInstances";
import type { Point } from "../../src/domain/types";
import type { RuntimeSnapshot } from "../../src/runtime/types";
import {
  clickMapTile,
  clickWorldPoint,
  createDefaultCity,
  dragMapTiles,
  mapTileViewportPoint,
  mapWorldViewportPoint,
  openCommandDestination,
  runtimeSnapshot,
  selectBuildLeaf,
} from "./helpers";

const ROUTE_STOPS = [
  { x: 3, y: 3 },
  { x: 7, y: 3 },
  { x: 11, y: 3 },
] as const;

const LINE_PATH_TILES = [
  { x: 5, y: 4 },
  { x: 9, y: 4 },
] as const;

/** Post-cull drawn samples in the {id, point} shape the click picker reads
 *  back out of the frame's instance buffer. */
function pausedVehicleSamples(
  snapshot: RuntimeSnapshot,
): { id: string; point: Point }[] {
  const { instances, vehicleIds } = encodeVehicleInstances({
    previous: null,
    latest: snapshot.state,
    ui: snapshot.ui,
    alpha: 1,
    paused: true,
    viewport: {
      minX: -tileSize,
      minY: -tileSize,
      maxX: (snapshot.state.map.width + 1) * tileSize,
      maxY: (snapshot.state.map.height + 1) * tileSize,
    },
  });
  return vehicleIds.map((id, index) => ({
    id,
    point: {
      x: instances[index * VEHICLE_INSTANCE_FLOATS]!,
      y: instances[index * VEHICLE_INSTANCE_FLOATS + 1]!,
    },
  }));
}

async function nextFrame(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      }),
  );
}

function linePathClicks(
  samples: { id: string; point: Point }[],
): { x: number; y: number }[] {
  return LINE_PATH_TILES.flatMap((tile) => {
    const world = {
      x: (tile.x + 0.5) * tileSize,
      y: (tile.y + 0.5) * tileSize,
    };
    const vehicleCovered = samples.some(
      (sample) =>
        (sample.point.x - world.x) ** 2 + (sample.point.y - world.y) ** 2 <=
        (tileSize / 2) ** 2,
    );
    return vehicleCovered ? [] : [world];
  });
}

test("selects a displayed vehicle and opens Lines from its path", async ({
  page,
}) => {
  await createDefaultCity(page);
  await expect(page.getByTestId("game-shell")).toBeVisible();
  const canvas = page.locator("canvas[data-runtime-canvas='true']");
  await expect(canvas).toBeVisible();

  await selectBuildLeaf(page, "roads", "road-twoWay");
  await dragMapTiles(page, canvas, { x: 3, y: 4 }, { x: 11, y: 4 });

  await selectBuildLeaf(page, "transit", "busStop");
  for (const stop of ROUTE_STOPS) {
    await clickMapTile(canvas, stop);
  }
  await expect
    .poll(async () => {
      const { state } = await runtimeSnapshot(page);
      return ROUTE_STOPS.every((position) =>
        state.transit.stops.some(
          (stop) =>
            stop.status === "present" &&
            stop.position.x === position.x &&
            stop.position.y === position.y,
        ),
      );
    })
    .toBe(true);

  await openCommandDestination(page, "lines");
  await page.getByRole("button", { name: "New Bus" }).click();
  for (const stop of ROUTE_STOPS) {
    await clickMapTile(canvas, stop);
  }
  await openCommandDestination(page, "lines");
  await expect(page.getByTestId("route-draft")).toBeVisible();
  await page.getByRole("button", { name: /^Save & run/ }).click();

  await expect
    .poll(
      async () => (await runtimeSnapshot(page)).state.transit.vehicles.length,
    )
    .toBeGreaterThan(0);

  const deployed = await runtimeSnapshot(page);
  const route = deployed.state.transit.routes.at(0);
  if (route === undefined) {
    throw new Error("Saved route is missing from the runtime snapshot");
  }
  const linesList = page.getByTestId("panel-lines");
  const selectRoute = linesList.getByRole("button", {
    name: `Select ${route.name}`,
  });
  await expect(selectRoute).toHaveAttribute("aria-pressed", "false");

  await page.getByRole("button", { name: "Close Lines" }).click();
  await expect(page.getByTestId("command-panel")).toHaveCount(0);

  const pauseButton = page.getByRole("button", { name: "Pause", exact: true });
  if ((await pauseButton.count()) > 0) {
    await pauseButton.click();
  }
  await expect(
    page.getByRole("button", { name: "Resume", exact: true }),
  ).toBeVisible();

  const presented = await runtimeSnapshot(page);
  const samples = pausedVehicleSamples(presented);
  const sample = samples.at(0);
  const vehicle = presented.state.transit.vehicles.find(
    (candidate) => candidate.id === sample?.id,
  );
  if (
    sample === undefined ||
    vehicle === undefined ||
    vehicle.lineId !== route.id
  ) {
    throw new Error("Displayed bus is missing or not on the saved route");
  }

  await nextFrame(page);
  await clickWorldPoint(canvas, sample.point);

  const inspector = page.getByTestId("panel-inspect");
  const vehiclePanel = inspector.getByTestId("vehicle-panel");
  await expect(vehiclePanel).toBeVisible();
  await expect(vehiclePanel).toContainText(route.name);
  await expect(vehiclePanel.getByTestId("vehicle-load")).toHaveText(
    `0 / ${vehicle.capacity}`,
  );

  const inspectBox = await inspector.boundingBox();
  const candidates = linePathClicks(samples);
  let clicked = false;
  for (const world of candidates) {
    const viewport = await mapWorldViewportPoint(canvas, world);
    const covered =
      inspectBox !== null &&
      viewport.x >= inspectBox.x &&
      viewport.x <= inspectBox.x + inspectBox.width &&
      viewport.y >= inspectBox.y &&
      viewport.y <= inspectBox.y + inspectBox.height;
    if (covered) continue;
    await clickWorldPoint(canvas, world);
    clicked = true;
    break;
  }
  expect(clicked, "expected an uncovered line-path click point").toBe(true);

  await expect(page.getByTestId("command-panel")).toHaveAttribute(
    "data-command-panel",
    "lines",
  );
  await expect(linesList).toBeVisible();
  await expect(selectRoute).toHaveAttribute("aria-pressed", "true");
});

test("reaches the bottom-right and top-left edge tiles at maximum zoom", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await createDefaultCity(page);
  const canvas = page.locator("canvas[data-runtime-canvas='true']");
  await expect(canvas).toBeVisible();
  const canvasBox = await canvas.boundingBox();
  expect(canvasBox).not.toBeNull();

  // Arm a single-tile build so a corner click has an observable effect.
  await selectBuildLeaf(page, "roads", "road-twoWay");

  // Zoom to maximum through the on-canvas control.
  for (let step = 0; step < 12; step += 1) {
    await page.getByTestId("map-zoom-in").click();
  }
  const { state, camera } = await runtimeSnapshot(page);
  expect(camera).not.toBeNull();
  expect(camera!.zoom, "camera reaches the maximum zoom").toBeCloseTo(
    maxZoom({ width: canvasBox!.width, height: canvasBox!.height }, state.map),
    6,
  );

  const centerOn = (point: Point) =>
    page.evaluate((target) => {
      const runtime = (
        window as unknown as {
          __caelumRuntime?: {
            adjustCamera: (action: {
              kind: "centerOn";
              point: Point;
            }) => unknown;
          };
        }
      ).__caelumRuntime;
      if (!runtime) {
        throw new Error("window.__caelumRuntime is unavailable");
      }
      runtime.adjustCamera({ kind: "centerOn", point: target });
    }, point);

  const tileAt = async (point: { x: number; y: number }) =>
    (await runtimeSnapshot(page)).state.map.tiles.find(
      (tile) => tile.x === point.x && tile.y === point.y,
    );

  // Pan to each map corner and click its edge tile: the safe-rect clamp must
  // keep the tile clear of both HUD bands so the click still lands.
  const corners = [
    { x: state.map.width - 1, y: state.map.height - 1 },
    { x: 0, y: 0 },
  ] as const;
  for (const corner of corners) {
    await centerOn(corner);
    const point = await mapTileViewportPoint(canvas, corner);
    expect(point.x).toBeGreaterThanOrEqual(0);
    expect(point.x).toBeLessThanOrEqual(canvasBox!.width);
    expect(point.y).toBeGreaterThanOrEqual(HUD_INSET.top);
    expect(point.y).toBeLessThanOrEqual(canvasBox!.height - HUD_INSET.bottom);

    await clickMapTile(canvas, corner);
    await expect.poll(async () => (await tileAt(corner))?.kind).toBe("road");
  }
});
