import type { Locator, Page } from "@playwright/test";
import { tileSize } from "../../src/render/canvas";

export async function openHudCategory(
  page: Page,
  category: "build" | "routes" | "manage" | "data" | "brief" | "inspect",
): Promise<void> {
  await page.getByTestId(`hud-cat-${category}`).click();
}

// Must match the Growing Suburb scenario map dimensions in
// src/scenario/growingSuburb.ts (width/height constants). If the scenario
// changes its map size, update these to match.
const mapWidth = 28;
const mapHeight = 18;

/**
 * Click the centre of the given map tile on the runtime canvas. The transform
 * math mirrors `getBoardTransform` in src/render/canvas.ts but operates in CSS
 * pixels (Playwright's `boundingBox`) rather than canvas backing-store pixels.
 */
export async function clickMapTile(
  canvas: Locator,
  tile: { x: number; y: number },
): Promise<void> {
  const box = await canvas.boundingBox();
  if (box === null) {
    throw new Error("Game canvas does not have a visible bounding box");
  }

  const scale = Math.min(
    box.width / (mapWidth * tileSize),
    box.height / (mapHeight * tileSize),
  );
  const offsetX = (box.width - mapWidth * tileSize * scale) / 2;
  const offsetY = (box.height - mapHeight * tileSize * scale) / 2;

  await canvas.click({
    position: {
      x: offsetX + (tile.x + 0.5) * tileSize * scale,
      y: offsetY + (tile.y + 0.5) * tileSize * scale,
    },
  });
}

/** Press-drag from one map tile to another on the runtime canvas. */
export async function dragMapTiles(
  page: Page,
  canvas: Locator,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  const box = await canvas.boundingBox();
  if (box === null) {
    throw new Error("Game canvas does not have a visible bounding box");
  }
  const scale = Math.min(
    box.width / (mapWidth * tileSize),
    box.height / (mapHeight * tileSize),
  );
  const offsetX = (box.width - mapWidth * tileSize * scale) / 2;
  const offsetY = (box.height - mapHeight * tileSize * scale) / 2;
  const at = (tile: { x: number; y: number }) => ({
    x: box.x + offsetX + (tile.x + 0.5) * tileSize * scale,
    y: box.y + offsetY + (tile.y + 0.5) * tileSize * scale,
  });
  const start = at(from);
  const end = at(to);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 8 });
  await page.mouse.up();
}
