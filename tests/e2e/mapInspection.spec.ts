import { expect, test, type Page } from "@playwright/test";
import type { Point } from "../../src/domain/types";
import { tileSize } from "../../src/render/boardTransform";
import {
  pickMapTarget,
  type MapPickSample,
} from "../../src/render/webgpu/pickMapTarget";
import { presentationPath } from "../../src/render/webgpu/transitBatch";
import { encodeVehicleInstances } from "../../src/render/webgpu/vehicleInstances";
import type { RuntimeSnapshot } from "../../src/runtime/types";
import { resolveNodesAtTile } from "../../src/ui/actions";
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

function linePathClicks(
  snapshot: RuntimeSnapshot,
  samples: MapPickSample[],
  lineId: string,
): { x: number; y: number }[] {
  const line =
    snapshot.state.transit.routes.find((route) => route.id === lineId) ??
    snapshot.state.transit.metroLines.find((route) => route.id === lineId);
  if (line === undefined) return [];
  const nodeTiles = [
    ...snapshot.state.transit.stops,
    ...snapshot.state.transit.stations,
  ]
    .filter((node) => node.status === "present")
    .map((node) => node.position);
  const stepTiles: Point[] = [];
  for (const leg of line.legs) {
    const path = presentationPath(leg);
    if (path === null) continue;
    for (const step of path.steps) {
      if (
        !stepTiles.some(
          (tile) => tile.x === step.position.x && tile.y === step.position.y,
        )
      ) {
        stepTiles.push(step.position);
      }
    }
  }
  const clickInTile = (tile: Point): { x: number; y: number } | null => {
    for (const dx of [0, -8, 8]) {
      for (const dy of [0, -8, 8]) {
        const world = {
          x: (tile.x + 0.5) * tileSize + dx,
          y: (tile.y + 0.5) * tileSize + dy,
        };
        const pick = pickMapTarget(samples, snapshot.state, world, tile);
        if (pick?.lineId === lineId && pick.vehicleId === null) {
          return world;
        }
      }
    }
    return null;
  };
  const eligible = (awayFromStops: boolean): { x: number; y: number }[] =>
    stepTiles.flatMap((tile) => {
      if (resolveNodesAtTile(snapshot.state, tile).length > 0) return [];
      if (
        awayFromStops &&
        nodeTiles.some(
          (node) =>
            Math.max(Math.abs(node.x - tile.x), Math.abs(node.y - tile.y)) <= 1,
        )
      ) {
        return [];
      }
      const world = clickInTile(tile);
      return world === null ? [] : [world];
    });
  const away = eligible(true);
  return away.length > 0 ? away : eligible(false);
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
  const candidates = linePathClicks(presented, samples, route.id);
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
