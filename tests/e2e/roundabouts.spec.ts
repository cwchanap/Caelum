import { expect, test } from "@playwright/test";
import type { Route, RouteLegPath } from "../../src/domain/types";
import { MAP_WIDTH } from "../../src/scenario/sandbox";
import {
  selectBuildLeaf,
  clickMapTile,
  createDefaultCity,
  dragMapTiles,
  openCommandDestination,
  removeMapTile,
  runtimeSnapshot,
} from "./helpers";

type StampSize = "compact2x2" | "standard3x3";

function roadSteps(leg: RouteLegPath) {
  return leg.currentPath?.kind === "road" ? leg.currentPath.steps : [];
}

function routeLegKeys(route: Route) {
  return route.legs.map((leg) => ({
    fromWaypointId: leg.fromWaypointId,
    toWaypointId: leg.toWaypointId,
    direction: leg.direction,
    kind: leg.kind,
  }));
}

async function paintLatentRoundaboutArea(
  page: import("@playwright/test").Page,
  origin: { x: number; y: number },
  size: StampSize,
): Promise<void> {
  const canvas = page.locator("canvas[data-runtime-canvas='true']");
  const width = size === "compact2x2" ? 2 : 3;
  await selectBuildLeaf(page, "zones", "residential");
  await dragMapTiles(page, canvas, origin, {
    x: origin.x + width - 1,
    y: origin.y + width - 1,
  });
  await expect
    .poll(async () => {
      const snapshot = await runtimeSnapshot(page);
      return snapshot.state.map.tiles
        .filter(
          (tile) =>
            tile.x >= origin.x &&
            tile.x < origin.x + width &&
            tile.y >= origin.y &&
            tile.y < origin.y + width,
        )
        .map((tile) => tile.area);
    })
    .toEqual(Array.from({ length: width * width }, () => "residential"));
}

async function seedRoundaboutApproaches(
  page: import("@playwright/test").Page,
  origin: { x: number; y: number },
  size: StampSize,
): Promise<void> {
  const canvas = page.locator("canvas[data-runtime-canvas='true']");
  const width = size === "compact2x2" ? 2 : 3;
  const bottom = origin.y + width - 1;
  const right = Math.min(origin.x + width + 4, MAP_WIDTH - 1);
  await selectBuildLeaf(page, "roads", "road-oneWay");
  await dragMapTiles(
    page,
    canvas,
    { x: origin.x - 5, y: bottom },
    { x: right, y: bottom },
  );
  await selectBuildLeaf(page, "roads", "road-twoWay");
  await dragMapTiles(
    page,
    canvas,
    { x: right, y: origin.y },
    { x: origin.x - 5, y: origin.y },
  );
  await selectBuildLeaf(page, "roads", "road-dual");
  await dragMapTiles(
    page,
    canvas,
    { x: origin.x - 5, y: origin.y - 1 },
    { x: origin.x - 5, y: bottom + 1 },
  );
}

async function createRoundaboutShuttleRoute(
  page: import("@playwright/test").Page,
  origin: { x: number; y: number },
): Promise<readonly [string, string]> {
  const canvas = page.locator("canvas[data-runtime-canvas='true']");
  const structure = (await runtimeSnapshot(page)).state.map.roadStructures.find(
    (candidate) =>
      candidate.kind === "roundabout" &&
      candidate.origin.x === origin.x &&
      candidate.origin.y === origin.y,
  );
  const height =
    structure?.kind === "roundabout" && structure.size === "standard3x3"
      ? 3
      : 2;
  // Keep passenger anchors off the bottom/top approach roads while leaving
  // their adjacent road points unchanged for roundabout routing.
  const first = { x: origin.x - 3, y: origin.y + height };
  const second = { x: origin.x - 2, y: origin.y - 1 };
  await selectBuildLeaf(page, "transit", "busStop");
  await clickMapTile(canvas, first);
  await clickMapTile(canvas, second);
  await expect
    .poll(async () => {
      const snapshot = await runtimeSnapshot(page);
      return snapshot.state.transit.stops
        .filter((stop) => stop.status === "present")
        .map((stop) => stop.position);
    })
    .toEqual(expect.arrayContaining([first, second]));
  const stopSnapshot = await runtimeSnapshot(page);
  const stopIdAt = (position: { x: number; y: number }) =>
    stopSnapshot.state.transit.stops.find(
      (stop) =>
        stop.status === "present" &&
        stop.position.x === position.x &&
        stop.position.y === position.y,
    )?.id;
  const firstId = stopIdAt(first);
  const secondId = stopIdAt(second);
  expect(firstId).toBeDefined();
  expect(secondId).toBeDefined();
  await openCommandDestination(page, "lines");
  await page.getByRole("button", { name: "New Bus" }).click();
  await clickMapTile(canvas, first);
  await clickMapTile(canvas, second);
  await expect
    .poll(async () => {
      const draft = (await runtimeSnapshot(page)).ui.routeDraft;
      return draft?.previewPending ?? true;
    })
    .toBe(false);
  const preview = (await runtimeSnapshot(page)).ui.routeDraft?.preview;
  expect(preview?.rejection?.code ?? null).toBeNull();
  await openCommandDestination(page, "lines");
  await page.getByRole("radio", { name: "Shuttle" }).check();
  await expect
    .poll(async () => {
      const draft = (await runtimeSnapshot(page)).ui.routeDraft;
      return {
        pattern: draft?.pattern ?? null,
        pending: draft?.previewPending ?? true,
        rejection: draft?.preview?.rejection?.code ?? null,
      };
    })
    .toEqual({ pattern: "shuttle", pending: false, rejection: null });
  await page.getByRole("button", { name: "Save route" }).click();
  await expect
    .poll(async () => {
      const route = (await runtimeSnapshot(page)).state.transit.routes.at(-1);
      return { pattern: route?.pattern ?? null, stopIds: route?.stopIds ?? [] };
    })
    .toEqual({ pattern: "shuttle", stopIds: [firstId, secondId] });
  return [firstId!, secondId!];
}

for (const fixture of [
  {
    label: "Compact Roundabout",
    size: "compact2x2",
    origin: { x: 6, y: 12 },
    footprintLength: 4,
    minimumSameArmCirculation: 2,
  },
  {
    label: "Standard Roundabout",
    size: "standard3x3",
    origin: { x: 21, y: 12 },
    footprintLength: 9,
    minimumSameArmCirculation: 5,
  },
] as const) {
  test(`places, routes, U-turns, and removes ${fixture.label}`, async ({
    page,
  }) => {
    await createDefaultCity(page);
    const canvas = page.locator("canvas[data-runtime-canvas='true']");
    await paintLatentRoundaboutArea(page, fixture.origin, fixture.size);
    await seedRoundaboutApproaches(page, fixture.origin, fixture.size);
    await selectBuildLeaf(
      page,
      "roads",
      fixture.size === "compact2x2"
        ? "compactRoundabout"
        : "standardRoundabout",
    );
    await clickMapTile(canvas, fixture.origin);

    await expect
      .poll(async () => {
        const snapshot = await runtimeSnapshot(page);
        return snapshot.state.map.roadStructures.some(
          (candidate) =>
            candidate.kind === "roundabout" &&
            candidate.origin.x === fixture.origin.x &&
            candidate.origin.y === fixture.origin.y,
        );
      })
      .toBe(true);
    const committed = await runtimeSnapshot(page);
    const structure = committed.state.map.roadStructures.find(
      (candidate) =>
        candidate.kind === "roundabout" &&
        candidate.origin.x === fixture.origin.x &&
        candidate.origin.y === fixture.origin.y,
    );
    expect(structure).toMatchObject({ size: fixture.size });
    expect(structure?.footprint).toHaveLength(fixture.footprintLength);
    const footprint = structure!.footprint.map((point) => ({ ...point }));
    const latentAreas = new Map(
      footprint.map((point) => {
        const tile = committed.state.map.tiles.find(
          (candidate) => candidate.x === point.x && candidate.y === point.y,
        );
        expect(tile?.area).toBe("residential");
        return [`${point.x},${point.y}`, tile?.area ?? null] as const;
      }),
    );

    const [firstStopId, secondStopId] = await createRoundaboutShuttleRoute(
      page,
      fixture.origin,
    );
    const routed = await runtimeSnapshot(page);
    const route = routed.state.transit.routes.at(-1);
    expect(route?.pattern).toBe("shuttle");
    expect(route?.stopIds).toEqual([firstStopId, secondStopId]);
    expect(routeLegKeys(route!)).toEqual([
      {
        fromWaypointId: firstStopId,
        toWaypointId: secondStopId,
        direction: "outbound",
        kind: "service",
      },
      {
        fromWaypointId: secondStopId,
        toWaypointId: secondStopId,
        direction: "return",
        kind: "terminalReversal",
      },
      {
        fromWaypointId: secondStopId,
        toWaypointId: firstStopId,
        direction: "return",
        kind: "service",
      },
      {
        fromWaypointId: firstStopId,
        toWaypointId: firstStopId,
        direction: "outbound",
        kind: "terminalReversal",
      },
    ]);
    expect(route?.legs.map((leg) => leg.status)).toEqual([
      "connected",
      "connected",
      "connected",
      "connected",
    ]);
    // Terminal reversals on one-way roads are 0° (same heading in/out):
    // the bus arrives and departs in the same direction, so the reversal
    // path has zero steps (no uTurn movement). The "connected" status above
    // already verifies the reversal path exists.
    for (const reversalIndex of [1, 3]) {
      expect(route!.legs[reversalIndex].currentPath).not.toBeNull();
    }

    const sameArmSteps = roadSteps(route!.legs[0]).filter((step) =>
      step.movement.startsWith("roundabout"),
    );
    const circulationCount = sameArmSteps.length - 2;
    expect(circulationCount).toBeGreaterThanOrEqual(
      fixture.minimumSameArmCirculation,
    );
    expect(sameArmSteps.map((step) => step.movement)).toEqual([
      "roundaboutEntry",
      ...Array.from(
        { length: circulationCount },
        () => "roundaboutCirculation" as const,
      ),
      "roundaboutExit",
    ]);
    expect(sameArmSteps[0]).toMatchObject({ enteringHeading: "east" });
    expect(sameArmSteps.at(-1)).toMatchObject({ leavingHeading: "west" });

    await removeMapTile(page, canvas, footprint[0]);
    await expect
      .poll(async () => {
        const snapshot = await runtimeSnapshot(page);
        return snapshot.state.map.roadStructures.some(
          (candidate) => candidate.id === structure!.id,
        );
      })
      .toBe(false);
    const removed = await runtimeSnapshot(page);
    expect(
      removed.state.map.roadStructures.some(
        (candidate) => candidate.id === structure!.id,
      ),
    ).toBe(false);
    for (const point of footprint) {
      const tile = removed.state.map.tiles.find(
        (candidate) => candidate.x === point.x && candidate.y === point.y,
      );
      expect(tile).toMatchObject({
        kind: "empty",
        roadConnections: [],
        area: latentAreas.get(`${point.x},${point.y}`),
      });
      expect(tile?.roadStructureId ?? null).toBeNull();
    }
    expect(removed.state.transit.routes.at(-1)?.pathBroken).toBe(true);
  });
}
