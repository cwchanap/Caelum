import { expect, type Locator, type Page } from "@playwright/test";
import { tileSize } from "../../src/render/boardTransform";
import { MAP_HEIGHT, MAP_WIDTH } from "../../src/scenario/sandbox";
import type { RuntimeSnapshot } from "../../src/runtime/types";
import type { SandboxTemplateId } from "../../src/domain/types";
import type { BuildGroup } from "../../src/domain/catalog/buildGroups";
import type { CommandDestination } from "../../src/ui/uiState";

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

export async function createDefaultCity(
  page: Page,
  name = "E2E City",
  templateId: SandboxTemplateId = "crossroads",
): Promise<void> {
  await page.goto("/");
  const newCityScreen = page.getByTestId("new-city-screen");
  const libraryNewCityButton = page
    .getByTestId("city-library-screen")
    .getByRole("button", { name: "New City", exact: true });
  await expect(newCityScreen.or(libraryNewCityButton)).toBeVisible();
  if (await libraryNewCityButton.isVisible()) {
    await libraryNewCityButton.click();
  }
  await expect(newCityScreen).toBeVisible();
  await page.getByLabel("City name").fill(name);
  await page.getByLabel("Template").selectOption(templateId);
  await page.getByRole("button", { name: "Create City" }).click();
  await expect(page.getByTestId("game-canvas-host")).toBeVisible();
}

export async function openCommandDestination(
  page: Page,
  destination: CommandDestination,
): Promise<void> {
  const trigger = page.getByTestId(`command-destination-${destination}`);
  const expanded = await trigger.getAttribute("aria-expanded");
  // Active route drafts keep Lines enabled so it can collapse/reopen. Other
  // command destinations remain aria-disabled; fail fast when one of those is
  // closed instead of clicking a known no-op and waiting for aria-expanded.
  if (
    expanded !== "true" &&
    (await trigger.getAttribute("aria-disabled")) === "true"
  ) {
    throw new Error(
      `Command destination "${destination}" is disabled (aria-disabled="true") and closed; resolve the active route draft before opening it.`,
    );
  }
  if (expanded !== "true") {
    await trigger.click();
  }
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("command-panel")).toHaveAttribute(
    "data-command-panel",
    destination,
  );
}

export async function selectBuildLeaf(
  page: Page,
  group: BuildGroup,
  item: string,
): Promise<void> {
  await openCommandDestination(page, "build");
  const back = page.getByTestId("build-back");
  if (await back.isVisible()) await back.click();
  await page.getByTestId(`build-group-${group}`).click();
  await page.getByTestId(`build-item-${item}`).click();
  await expect(page.getByTestId("command-panel")).toHaveCount(0);
}

export async function selectTool(
  page: Page,
  tool: "select" | "demolish",
): Promise<void> {
  const trigger = page.getByTestId(`command-tool-${tool}`);
  if ((await trigger.getAttribute("aria-pressed")) !== "true") {
    await trigger.click();
  }
  await expect(trigger).toHaveAttribute("aria-pressed", "true");
}

// Shared sandbox dimensions keep the e2e board transform aligned with both
// canonical Rust-owned templates without duplicating map geometry constants.
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

export async function mapTileViewportPoint(
  canvas: Locator,
  tile: { x: number; y: number },
): Promise<{ x: number; y: number }> {
  const box = await canvas.boundingBox();
  if (box === null) {
    throw new Error("Game canvas does not have a visible bounding box");
  }
  const { scale, offsetX, offsetY } = boardTransform(box);
  return {
    x: box.x + offsetX + (tile.x + 0.5) * tileSize * scale,
    y: box.y + offsetY + (tile.y + 0.5) * tileSize * scale,
  };
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
  const point = await mapTileViewportPoint(canvas, tile);
  const box = await canvas.boundingBox();
  if (box === null) {
    throw new Error("Game canvas does not have a visible bounding box");
  }

  await canvas.click({
    position: { x: point.x - box.x, y: point.y - box.y },
  });
}

export async function hoverMapTile(
  canvas: Locator,
  tile: { x: number; y: number },
): Promise<void> {
  const point = await mapTileViewportPoint(canvas, tile);
  const box = await canvas.boundingBox();
  if (box === null) {
    throw new Error("Game canvas does not have a visible bounding box");
  }

  await canvas.hover({
    position: { x: point.x - box.x, y: point.y - box.y },
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
  // browser to fully process handlers. Yield one animation frame so the
  // runtime's commitDrag (pointerup → paint/render) settles before the next
  // action — especially on slower CI runners.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      }),
  );
}

export async function removeMapTile(
  page: Page,
  canvas: Locator,
  tile: { x: number; y: number },
): Promise<void> {
  await selectTool(page, "demolish");
  await clickMapTile(canvas, tile);
}

export async function rebuildRoadTile(
  page: Page,
  canvas: Locator,
  tile: { x: number; y: number },
): Promise<void> {
  await selectBuildLeaf(page, "roads", "road-twoWay");
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

export interface PixelProbe {
  tile: { x: number; y: number };
  /** World-pixel offsets from the tile center. */
  dx: number;
  dy: number;
}

/**
 * Samples RGB triples from the presented gameplay canvas (WebGPU path) at
 * world-space points expressed as tile + world-pixel offsets. One drawImage
 * readback covers every probe; off-board probes return null.
 */
export async function sampleTilePixels(
  page: Page,
  probes: PixelProbe[],
): Promise<Array<[number, number, number] | null>> {
  // page.evaluate cannot capture Node-scope imports, so pass board constants
  // in explicitly.
  const boardWidth = MAP_WIDTH * tileSize;
  const boardHeight = MAP_HEIGHT * tileSize;
  return page.evaluate(
    async ({ points, size, width, height }) => {
      const canvas = document.querySelector(
        "canvas[data-runtime-canvas='true']",
      );
      if (!(canvas instanceof HTMLCanvasElement)) {
        throw new Error("Runtime canvas is unavailable");
      }
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        return points.map(() => null);
      }
      // The WebGPU drawing buffer is cleared after present, so drawImage from
      // the canvas itself reads blank; its PNG encoding still carries the
      // presented frame.
      const framePng = new Image();
      const decoded = new Promise<void>((resolve, reject) => {
        framePng.onload = () => resolve();
        framePng.onerror = () => reject(new Error("canvas PNG decode failed"));
      });
      framePng.src = canvas.toDataURL();
      await decoded;
      const probe = document.createElement("canvas");
      probe.width = canvas.width;
      probe.height = canvas.height;
      const ctx = probe.getContext("2d");
      if (ctx === null) {
        throw new Error("2D probe context is unavailable");
      }
      ctx.drawImage(framePng, 0, 0);
      const image = ctx.getImageData(0, 0, probe.width, probe.height);
      const scale = Math.min(rect.width / width, rect.height / height);
      const offsetX = (rect.width - width * scale) / 2;
      const offsetY = (rect.height - height * scale) / 2;
      const dpr = canvas.width / rect.width;
      return points.map(({ tile, dx, dy }) => {
        const cssX = offsetX + ((tile.x + 0.5) * size + dx) * scale;
        const cssY = offsetY + ((tile.y + 0.5) * size + dy) * scale;
        const px = Math.round(cssX * dpr);
        const py = Math.round(cssY * dpr);
        if (px < 0 || py < 0 || px >= probe.width || py >= probe.height) {
          return null;
        }
        const index = (py * probe.width + px) * 4;
        return [
          image.data[index],
          image.data[index + 1],
          image.data[index + 2],
        ] as [number, number, number];
      });
    },
    { points: probes, size: tileSize, width: boardWidth, height: boardHeight },
  );
}
