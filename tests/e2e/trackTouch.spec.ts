import { expect, test } from "@playwright/test";
import { HUD_INSET } from "../../src/render/boardTransform";
import {
  createDefaultCity,
  drainGameplayQueue,
  mapTileViewportPoint,
  runtimeSnapshot,
  selectBuildLeaf,
  settleLayout,
} from "./helpers";

test.use({ hasTouch: true });

test("keeps the two-tile track cue after a touch tap with no preceding hover", async ({
  page,
}) => {
  await createDefaultCity(page);
  const canvas = page.locator("canvas[data-runtime-canvas='true']");
  await expect(canvas).toBeVisible();
  await selectBuildLeaf(page, "transit", "track");

  // Zoom and pan to the bottom of the map: the old map-row-zero fallback is
  // far outside the clipped overlay here, while the tapped tile stays visible.
  await page.evaluate(() => {
    const runtime = (
      window as unknown as {
        __caelumRuntime?: {
          adjustCamera: (action: {
            kind: "centerOn";
            point: { x: number; y: number };
          }) => unknown;
        };
      }
    ).__caelumRuntime;
    if (runtime === undefined) {
      throw new Error("window.__caelumRuntime is unavailable");
    }
    runtime.adjustCamera({ kind: "centerOn", point: { x: 14, y: 17 } });
  });
  await settleLayout(page);
  const zoomed = await runtimeSnapshot(page);
  expect(zoomed.camera?.zoom ?? 1).toBeGreaterThan(1);

  const badge = page.locator('.map-text-item[data-kind="cursorBadge"]');
  const readout = page.getByTestId("map-text-cursor-readout");
  await expect(badge).toContainText("Drag at least two tiles");
  await expect(readout).toHaveText("Track, Drag at least two tiles");

  const before = await runtimeSnapshot(page);
  expect(before.camera).not.toBeNull();
  const tile = {
    x: Math.floor(before.camera!.center.x),
    y: Math.floor(before.camera!.center.y),
  };
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

  const badgeBox = await badge.boundingBox();
  const canvasBox = await canvas.boundingBox();
  expect(badgeBox).not.toBeNull();
  expect(canvasBox).not.toBeNull();
  expect(badgeBox!.x).toBeGreaterThanOrEqual(canvasBox!.x);
  expect(badgeBox!.x + badgeBox!.width).toBeLessThanOrEqual(
    canvasBox!.x + canvasBox!.width + 1,
  );
  expect(badgeBox!.y).toBeGreaterThanOrEqual(canvasBox!.y + HUD_INSET.top - 1);
  expect(badgeBox!.y + badgeBox!.height).toBeLessThanOrEqual(
    canvasBox!.y + canvasBox!.height - HUD_INSET.bottom + 1,
  );
});
