import { expect, test } from "@playwright/test";
import {
  createDefaultCity,
  drainGameplayQueue,
  mapTileViewportPoint,
  runtimeSnapshot,
  selectBuildLeaf,
} from "./helpers";

test.use({ hasTouch: true });

test("keeps the two-tile track cue after a touch tap with no preceding hover", async ({
  page,
}) => {
  await createDefaultCity(page);
  const canvas = page.locator("canvas[data-runtime-canvas='true']");
  await expect(canvas).toBeVisible();
  await selectBuildLeaf(page, "transit", "track");

  const badge = page.locator('.map-text-item[data-kind="cursorBadge"]');
  const readout = page.getByTestId("map-text-cursor-readout");
  await expect(badge).toContainText("Drag at least two tiles");
  await expect(readout).toHaveText("Track, Drag at least two tiles");

  const tile = { x: 10, y: 4 } as const;
  const before = await runtimeSnapshot(page);
  expect(before.ui.hoverTile).toBeNull();
  const point = await mapTileViewportPoint(canvas, tile);
  await page.touchscreen.tap(point.x, point.y);
  await drainGameplayQueue(page);

  const after = await runtimeSnapshot(page);
  expect(after.state.budget).toBe(before.state.budget);
  expect(
    after.state.map.tiles.find(
      (candidate) => candidate.x === tile.x && candidate.y === tile.y,
    )?.hasTrack ?? false,
  ).toBe(false);
  await expect(badge).toContainText("Drag at least two tiles");
  await expect(readout).toHaveText("Track, Drag at least two tiles");
});
