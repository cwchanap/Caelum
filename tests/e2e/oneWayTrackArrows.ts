import { expect, type Page } from "@playwright/test";
import {
  centerAtMaxZoom,
  createDefaultCity,
  dragMapTiles,
  runtimeSnapshot,
  sampleTilePixels,
  selectBuildLeaf,
  selectTool,
} from "./helpers";

// colors.oneWayArrow #e8eef0, recomputed here so the oracle stays independent
// of render internals; the rail art under it is brown/tan, never near-white.
const ONE_WAY_ARROW = [232, 238, 240] as const;
const ROAD_Y = 9;
const ROAD_XS = [11, 12, 13] as const;
const CENTER_TILE = { x: 12, y: ROAD_Y } as const;

/** Builds the review regression scene once and samples the arrow shaft in the
 *  middle tile: three eastbound one-way roads, then a straight three-tile
 *  track over them. The direction cue must paint over the opaque rail art. */
export async function expectOneWayArrowVisibleThroughTrack(
  page: Page,
  renderer: "webgpu" | "canvas2d",
): Promise<void> {
  await createDefaultCity(
    page,
    `One-way track ${renderer}`,
    "blankGrid",
    renderer,
  );
  const canvas = page.locator("canvas[data-runtime-canvas='true']");

  await selectBuildLeaf(page, "roads", "road-oneWay");
  await dragMapTiles(
    page,
    canvas,
    { x: ROAD_XS[0], y: ROAD_Y },
    { x: ROAD_XS[2], y: ROAD_Y },
  );
  await expect
    .poll(
      async () =>
        (await runtimeSnapshot(page)).state.map.tiles.find(
          (tile) => tile.x === CENTER_TILE.x && tile.y === CENTER_TILE.y,
        )?.oneWay ?? null,
      { timeout: 15_000 },
    )
    .toBe("east");

  await selectBuildLeaf(page, "transit", "track");
  await dragMapTiles(
    page,
    canvas,
    { x: ROAD_XS[0], y: ROAD_Y },
    { x: ROAD_XS[2], y: ROAD_Y },
  );
  await expect
    .poll(
      async () =>
        (await runtimeSnapshot(page)).state.map.tiles.find(
          (tile) => tile.x === CENTER_TILE.x && tile.y === CENTER_TILE.y,
        )?.hasTrack ?? false,
      { timeout: 15_000 },
    )
    .toBe(true);

  await selectTool(page, "select");
  await centerAtMaxZoom(page, {
    x: CENTER_TILE.x + 0.5,
    y: CENTER_TILE.y + 0.5,
  });
  // Leave no hover highlight over the measured tile.
  await page.mouse.move(1, 1);

  const probes = [-5, -2, 0, 2, 5].map((dx) => ({
    tile: CENTER_TILE,
    dx,
    dy: 0,
  }));
  const samples = await sampleTilePixels(page, probes);
  expect(samples).toHaveLength(probes.length);
  samples.forEach((sample, index) => {
    expect(sample, `arrow shaft probe ${index}`).not.toBeNull();
    for (let channel = 0; channel < 3; channel += 1) {
      expect(
        Math.abs(sample![channel]! - ONE_WAY_ARROW[channel]!),
        `arrow shaft probe ${index} channel ${channel}`,
      ).toBeLessThanOrEqual(10);
    }
  });
}
