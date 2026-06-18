import type { Locator, Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { tileSize } from "../../src/render/canvas";

export async function openHudCategory(
  page: Page,
  category: "build" | "routes" | "manage" | "data" | "brief" | "inspect",
): Promise<void> {
  await page.getByTestId(`hud-cat-${category}`).click();
}

export interface AppServer {
  server: ViteDevServer;
  url: string;
}

/**
 * Start a Vite dev server on an ephemeral port for e2e tests, and pre-warm it.
 *
 * Vite lazily pre-bundles dependencies (it logs "Forced re-optimization of
 * dependencies") and transforms modules on the first request. On a cold CI
 * runner this can take longer than Playwright's default 5s `expect` timeout, so
 * the very first `page.goto` occasionally fails its initial `game-shell`
 * assertion before the app has hydrated. Hitting the root page and the entry
 * module here forces that work to finish up front, so every browser navigation
 * — including the first — lands on a warm server.
 */
export async function startAppServer(): Promise<AppServer> {
  const server = await createServer({
    configFile: "vite.config.ts",
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  const resolved = server.resolvedUrls?.local[0];
  if (!resolved) {
    throw new Error("Vite dev server did not expose a local URL");
  }
  // The root page triggers dependency pre-bundling; the entry module primes the
  // on-demand transform cache. A failure here is non-fatal — it only means the
  // first browser load pays the warm-up cost instead.
  await Promise.all([
    fetch(resolved).then((r) => r.text()),
    fetch(new URL("/src/main.ts", resolved).toString()).then((r) => r.text()),
  ]).catch(() => {});
  return { server, url: resolved };
}

// Must match the Growing Suburb scenario map dimensions in
// src/scenario/growingSuburb.ts (width/height constants). If the scenario
// changes its map size, update these to match.
const mapWidth = 28;
const mapHeight = 18;

/**
 * Board transform mirroring `getBoardTransform` in src/render/canvas.ts, but
 * operating in CSS pixels (Playwright's `boundingBox`) rather than canvas
 * backing-store pixels. Shared by both click and drag helpers so the tile→pixel
 * mapping stays in sync.
 */
function boardTransform(box: { width: number; height: number }): {
  scale: number;
  offsetX: number;
  offsetY: number;
} {
  const scale = Math.min(
    box.width / (mapWidth * tileSize),
    box.height / (mapHeight * tileSize),
  );
  return {
    scale,
    offsetX: (box.width - mapWidth * tileSize * scale) / 2,
    offsetY: (box.height - mapHeight * tileSize * scale) / 2,
  };
}

/**
 * Exported for unit-testing against `getBoardTransform` (see
 * tests/runtime/e2eHelpers.test.ts).
 */
export function _boardTransformForTest(box: {
  width: number;
  height: number;
}): { scale: number; offsetX: number; offsetY: number } {
  return boardTransform(box);
}

/**
 * Click the centre of the given map tile on the runtime canvas. The `position`
 * is element-relative (Playwright `click`), so it does not include the canvas's
 * viewport offset.
 */
export async function clickMapTile(
  canvas: Locator,
  tile: { x: number; y: number },
): Promise<void> {
  const box = await canvas.boundingBox();
  if (box === null) {
    throw new Error("Game canvas does not have a visible bounding box");
  }

  const { scale, offsetX, offsetY } = boardTransform(box);

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
  const { scale, offsetX, offsetY } = boardTransform(box);
  // `page.mouse` uses viewport coordinates, so add the canvas's bounding-box
  // origin (box.x/box.y) on top of the element-relative board transform.
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
