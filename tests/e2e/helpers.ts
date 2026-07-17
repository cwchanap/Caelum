import { expect, type Locator, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { tileSize } from "../../src/render/canvas";
import { MAP_HEIGHT, MAP_WIDTH } from "../../src/scenario/growingSuburb";
import type { RuntimeSnapshot } from "../../src/runtime/types";

export async function runtimeSnapshot(page: Page): Promise<RuntimeSnapshot> {
  return page.evaluate(() => {
    const runtime = (
      window as unknown as {
        __caelumRuntime?: { getSnapshot: () => RuntimeSnapshot };
      }
    ).__caelumRuntime;
    if (!runtime) {
      throw new Error("window.__caelumRuntime is unavailable");
    }
    return runtime.getSnapshot();
  });
}

export async function openHudCategory(
  page: Page,
  category:
    | "build"
    | "area"
    | "routes"
    | "manage"
    | "data"
    | "brief"
    | "inspect",
): Promise<void> {
  const trigger = page.getByTestId(`hud-cat-${category}`);
  if ((await trigger.getAttribute("aria-pressed")) !== "true") {
    await trigger.click();
  }
  await expect(trigger).toHaveAttribute("aria-pressed", "true");
}

/**
 * Open the Build drawer, drill into a category, then select an item —
 * mirroring the category → item drill-down (BuildPanel.svelte).
 *
 * `hud-cat-build` is a toggle, so this helper must not click it when the
 * Build drawer is already open (that would close it). It also returns to the
 * Build root first if a previous call left it drilled into a sub-category,
 * so the category buttons are always reachable regardless of prior state.
 */
export async function buildItem(
  page: Page,
  category: string,
  item: string,
): Promise<void> {
  const back = page.getByTestId("build-back");
  if (await back.isVisible()) {
    await back.click();
  }
  const buildCat = page.getByTestId("hud-cat-build");
  if ((await buildCat.getAttribute("aria-pressed")) !== "true") {
    await buildCat.click();
  }
  await page.getByRole("button", { name: category, exact: true }).click();
  await page.getByRole("button", { name: item, exact: true }).click();
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

// Authoritative dimensions imported from the Growing Suburb scenario, so the
// e2e board transform tracks the actual map size without silent drift.
const mapWidth = MAP_WIDTH;
const mapHeight = MAP_HEIGHT;

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
  // `page.mouse` methods dispatch low-level events without waiting for the
  // browser to fully process handlers. A single animation-frame pause gives
  // the runtime's commitDrag (pointerup → paint/render) a chance to settle
  // before the test proceeds, preventing the next action from racing with
  // the drag commit — especially on slower CI runners.
  await page.waitForTimeout(0);
}

export async function removeMapTile(
  page: Page,
  canvas: Locator,
  tile: { x: number; y: number },
): Promise<void> {
  const remove = page.getByTestId("hud-tool-remove");
  if ((await remove.getAttribute("aria-pressed")) !== "true") {
    await remove.click();
  }
  await expect(remove).toHaveAttribute("aria-pressed", "true");
  await clickMapTile(canvas, tile);
}

export async function rebuildRoadTile(
  page: Page,
  canvas: Locator,
  tile: { x: number; y: number },
): Promise<void> {
  await buildItem(page, "Road", "1-Lane");
  await clickMapTile(canvas, tile);
}

/**
 * Set the budget to a specific amount via the debug SetBudget intent.
 * Used by e2e tests that need to top up the budget when the normal
 * gameplay flow would exhaust it (e.g. metro tombstone rebuild after
 * 2 stations + 1 vehicle = 100k of 120k starting budget).
 */
export async function debugSetBudget(
  page: Page,
  budget: number,
): Promise<void> {
  await page.evaluate((amount) => {
    const runtime = (
      window as unknown as {
        __caelumRuntime?: {
          debugSetBudget?: (budget: number) => Promise<unknown>;
        };
      }
    ).__caelumRuntime;
    if (runtime?.debugSetBudget === undefined) {
      throw new Error(
        "debugSetBudget is unavailable on window.__caelumRuntime",
      );
    }
    return runtime.debugSetBudget(amount);
  }, budget);
}
