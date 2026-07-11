import { expect, test } from "@playwright/test";
import type { MovementKind, RouteLegPath } from "../../src/domain/types";
import { MAP_WIDTH } from "../../src/scenario/growingSuburb";
import {
  buildItem,
  clickMapTile,
  dragMapTiles,
  openHudCategory,
  removeMapTile,
  runtimeSnapshot,
} from "./helpers";

type StampSize = "compact2x2" | "standard3x3";

function roadMovements(leg: RouteLegPath): MovementKind[] {
  return leg.currentPath?.kind === "road"
    ? leg.currentPath.steps.map((step) => step.movement)
    : [];
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
  if (size === "compact2x2") {
    await buildItem(page, "Road", "2-Lane");
    await dragMapTiles(
      page,
      canvas,
      { x: origin.x - 5, y: bottom },
      { x: right, y: bottom },
    );
  } else {
    await buildItem(page, "Road", "1-Lane One-Way");
    await dragMapTiles(
      page,
      canvas,
      { x: origin.x - 5, y: bottom },
      { x: right, y: bottom },
    );
    await buildItem(page, "Road", "1-Lane One-Way");
    await dragMapTiles(
      page,
      canvas,
      { x: right, y: origin.y },
      { x: origin.x - 5, y: origin.y },
    );
  }
  await buildItem(page, "Road", "2-Lane");
  await dragMapTiles(
    page,
    canvas,
    { x: origin.x - 5, y: origin.y - 1 },
    { x: origin.x - 5, y: bottom + 1 },
  );
}

async function createRoundaboutUTurnRoute(
  page: import("@playwright/test").Page,
  origin: { x: number; y: number },
): Promise<void> {
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
  const first = { x: origin.x - 3, y: origin.y + height - 1 };
  const second = { x: origin.x - 2, y: origin.y };
  await buildItem(page, "Bus", "Bus Stop");
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
  await openHudCategory(page, "routes");
  await page.getByRole("button", { name: "Bus Route" }).click();
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
  await openHudCategory(page, "routes");
  await page.getByRole("radio", { name: "Loop" }).check();
  await page.getByRole("button", { name: "Save route" }).click();
}

for (const fixture of [
  {
    label: "Compact Roundabout",
    size: "compact2x2",
    origin: { x: 6, y: 12 },
    footprintLength: 4,
  },
  {
    label: "Standard Roundabout",
    size: "standard3x3",
    origin: { x: 21, y: 12 },
    footprintLength: 9,
  },
] as const) {
  test(`places, routes, U-turns, and removes ${fixture.label}`, async ({
    page,
  }) => {
    await page.goto("/");
    const canvas = page.locator("canvas[data-runtime-canvas='true']");
    await seedRoundaboutApproaches(page, fixture.origin, fixture.size);
    await buildItem(page, "Road", fixture.label);
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

    await createRoundaboutUTurnRoute(page, fixture.origin);
    const routed = await runtimeSnapshot(page);
    const route = routed.state.transit.routes.at(-1);
    expect(route?.legs.flatMap(roadMovements)).toEqual(
      expect.arrayContaining([
        "roundaboutEntry",
        "roundaboutCirculation",
        "roundaboutExit",
      ]),
    );

    await removeMapTile(page, canvas, structure!.footprint[0]);
    const removed = await runtimeSnapshot(page);
    expect(
      removed.state.map.roadStructures.some(
        (candidate) => candidate.id === structure!.id,
      ),
    ).toBe(false);
    expect(
      removed.state.map.tiles.filter(
        (tile) => tile.roadStructureId === structure!.id,
      ),
    ).toHaveLength(0);
    expect(removed.state.transit.routes.at(-1)?.pathBroken).toBe(true);
  });
}
