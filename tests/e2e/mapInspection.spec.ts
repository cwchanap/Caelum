import { expect, test, type Page } from "@playwright/test";
import { tileSize } from "../../src/render/boardTransform";
import type { MapPickSample } from "../../src/render/webgpu/pickMapTarget";
import { encodeVehicleInstances } from "../../src/render/webgpu/vehicleInstances";
import type { RuntimeSnapshot } from "../../src/runtime/types";
import {
  clickMapTile,
  clickWorldPoint,
  createDefaultCity,
  dragMapTiles,
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

function pausedVehicleSamples(snapshot: RuntimeSnapshot): MapPickSample[] {
  return encodeVehicleInstances({
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
  }).samples;
}

async function nextFrame(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      }),
  );
}

function linePathClicks(samples: MapPickSample[]): { x: number; y: number }[] {
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
  await page.getByRole("button", { name: "Save & run" }).click();

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
