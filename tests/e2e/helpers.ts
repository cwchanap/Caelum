import { expect, type Locator, type Page } from "@playwright/test";
import {
  getBoardTransform,
  tileSize,
  type BoardTransform,
  type Camera,
} from "../../src/render/boardTransform";
import type { RuntimeSnapshot } from "../../src/runtime/types";
import type { SandboxTemplateId } from "../../src/domain/types";
import { SANDBOX_TEMPLATE_LABELS } from "../../src/domain/catalog/sandboxTemplates";
import type { BuildGroup } from "../../src/domain/catalog/buildGroups";
import type { CommandDestination } from "../../src/ui/uiState";
export interface DecodedPng {
  width: number;
  height: number;
  /** RGBA bytes, 4 per pixel, row-major. */
  data: Uint8Array;
}

/** Decode a real painted browser screenshot into RGBA pixels so tests can
 *  assert on observable output. pngjs ships inside playwright-core's
 *  bundled utils, so this adds no new dependency — but it is a private
 *  export, so it is imported lazily inside the only two pixel-checking
 *  callers instead of eagerly breaking spec discovery for every suite. */
export async function decodePng(buffer: Uint8Array): Promise<DecodedPng> {
  const { PNG } = await import("playwright-core/lib/utilsBundle");
  const png = PNG.sync.read(buffer);
  return { width: png.width, height: png.height, data: png.data };
}

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

interface IdbPutFailureHarness {
  armed: boolean;
}

/**
 * Install (but do not arm) a test-only interception of IndexedDB `put` calls.
 * Playwright arms it through `armOneShotCitySaveFailure`; the first armed
 * `put` into the city store throws a DOMException, then disarms itself so the
 * retry uses the untouched real store method. `addInitScript` must run before
 * navigation so the live browser bundle never needs a failure hook.
 */
export async function installOneShotCitySaveFailure(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const harness = { armed: false };
    Object.defineProperty(window, "__caelumE2EIdbPutFailure", {
      configurable: true,
      value: harness,
    });
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (
      this: IDBObjectStore,
      value: unknown,
      key?: IDBValidKey,
    ) {
      if (harness.armed && this.name === "cities") {
        harness.armed = false;
        throw new DOMException(
          "Test-only IndexedDB put failure",
          "UnknownError",
        );
      }
      return originalPut.call(this, value, key);
    };
  });
}

/** Arm the installed interception for exactly the next city-store put. */
export async function armOneShotCitySaveFailure(page: Page): Promise<void> {
  await page.evaluate(() => {
    const harness = (
      window as unknown as { __caelumE2EIdbPutFailure?: IdbPutFailureHarness }
    ).__caelumE2EIdbPutFailure;
    if (harness === undefined) {
      throw new Error(
        "installOneShotCitySaveFailure must run before navigation",
      );
    }
    harness.armed = true;
  });
}

export async function createDefaultCity(
  page: Page,
  name = "E2E City",
  templateId: SandboxTemplateId = "crossroads",
  expectedRenderer: "webgpu" | "canvas2d" = "webgpu",
  mapSize: "small" | "large" = "small",
): Promise<void> {
  await page.goto("/");
  const newCityScreen = page.getByTestId("new-city-screen");
  const libraryNewCityButton = page
    .getByTestId("city-library-screen")
    .getByRole("button", { name: /^New City/ });
  await expect(newCityScreen.or(libraryNewCityButton)).toBeVisible();
  if (await libraryNewCityButton.isVisible()) {
    await libraryNewCityButton.click();
  }
  await expect(newCityScreen).toBeVisible();
  await page.getByLabel("City name").fill(name);
  await page
    .getByRole("radio", { name: SANDBOX_TEMPLATE_LABELS[templateId] })
    .check();
  if (mapSize === "large") {
    await page.getByRole("radio", { name: "Large 84×54" }).check();
  }
  await page.getByRole("button", { name: "Create City" }).click();
  await expect(page.getByTestId("game-canvas-host")).toBeVisible();
  await expect(
    page.locator("canvas[data-runtime-canvas='true']"),
  ).toHaveAttribute("data-renderer", expectedRenderer);
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
  await settleLayout(page);
}

/** Let the render host observe a stage resize before map geometry is measured. */
export async function settleLayout(page: Page): Promise<void> {
  // The render loop pins the canvas to the observed host size inside
  // drawFrame; a queued resize lands on some later frame, so fixed rAF waits
  // can measure a box the next drawFrame is about to replace. Wait until the
  // pinned canvas box matches the live host box — i.e. the drawn transform
  // pointer events resolve against is the one measured below.
  await page.waitForFunction(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(
      "canvas[data-runtime-canvas='true']",
    );
    const host = canvas?.parentElement;
    if (canvas == null || host == null) return true;
    const canvasBox = canvas.getBoundingClientRect();
    const hostBox = host.getBoundingClientRect();
    return (
      Math.abs(canvasBox.width - hostBox.width) < 1 &&
      Math.abs(canvasBox.height - hostBox.height) < 1
    );
  });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
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
  await settleLayout(page);
}

export async function selectTool(
  page: Page,
  tool: "select" | "demolish",
): Promise<void> {
  const trigger = page.getByTestId(`command-tool-${tool}`);
  if ((await trigger.getAttribute("aria-pressed")) !== "true") {
    await trigger.click();
    await expect(trigger).toHaveAttribute("aria-pressed", "true");
    await settleLayout(page);
  }
}

/** The live map size and camera, read from the runtime (not the whole
 *  snapshot, which is large on bigger maps). */
async function boardView(
  page: Page,
): Promise<{ map: { width: number; height: number }; camera: Camera | null }> {
  return page.evaluate(() => {
    const runtime = (
      window as unknown as {
        __caelumRuntime?: { getSnapshot: () => RuntimeSnapshot };
      }
    ).__caelumRuntime;
    if (!runtime) {
      throw new Error("window.__caelumRuntime is unavailable");
    }
    const snapshot = runtime.getSnapshot();
    return {
      map: {
        width: snapshot.state.map.width,
        height: snapshot.state.map.height,
      },
      camera: snapshot.camera,
    };
  });
}

/** The expected CSS board transform computed from this canvas box, the
 *  current map size, and the snapshot camera (not read back from the
 *  renderer). */
async function boardTransform(
  page: Page,
  box: { width: number; height: number },
): Promise<BoardTransform> {
  const view = await boardView(page);
  return getBoardTransform(box, view.map, view.camera);
}

export async function mapTileViewportPoint(
  canvas: Locator,
  tile: { x: number; y: number },
): Promise<{ x: number; y: number }> {
  const box = await canvas.boundingBox();
  if (box === null) {
    throw new Error("Game canvas does not have a visible bounding box");
  }
  const { scale, offsetX, offsetY } = await boardTransform(canvas.page(), box);
  return {
    x: box.x + offsetX + (tile.x + 0.5) * tileSize * scale,
    y: box.y + offsetY + (tile.y + 0.5) * tileSize * scale,
  };
}

export async function mapWorldViewportPoint(
  canvas: Locator,
  world: { x: number; y: number },
): Promise<{ x: number; y: number }> {
  const box = await canvas.boundingBox();
  if (box === null) {
    throw new Error("Game canvas does not have a visible bounding box");
  }
  const { scale, offsetX, offsetY } = await boardTransform(canvas.page(), box);
  return {
    x: box.x + offsetX + world.x * scale,
    y: box.y + offsetY + world.y * scale,
  };
}

/** The expected CSS scale computed from the current canvas box and the runtime
 *  snapshot's map and camera (not read back from the renderer). A single map
 *  point can stay put under an anchored zoom, so position checks prove scale
 *  stability only alongside this. */
export async function mapBoardScale(canvas: Locator): Promise<number> {
  const box = await canvas.boundingBox();
  if (box === null) {
    throw new Error("Game canvas does not have a visible bounding box");
  }
  return (await boardTransform(canvas.page(), box)).scale;
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

export async function clickWorldPoint(
  canvas: Locator,
  world: { x: number; y: number },
): Promise<void> {
  const point = await mapWorldViewportPoint(canvas, world);
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
  const { scale, offsetX, offsetY } = await boardTransform(page, box);
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

export async function drainGameplayQueue(page: Page): Promise<void> {
  await page.evaluate(() => {
    const runtime = (
      window as unknown as {
        __caelumRuntime?: { tick: (delta: number) => Promise<unknown> };
      }
    ).__caelumRuntime;
    if (!runtime) {
      throw new Error("window.__caelumRuntime is unavailable");
    }
    return runtime.tick(0);
  });
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

export interface SampleFrameTransform {
  scale: number;
  offsetX: number;
  offsetY: number;
  /** Capture device pixels per CSS pixel (debugCaptureFrame / canvas rect). */
  dpr: number;
}

/** The exact world→CSS transform and capture density sampleTilePixels uses,
 *  for tests that need to compute expectations at capture-pixel precision
 *  (e.g. filtered sprite-texel composites). Returns null without a canvas
 *  or a frame, mirroring sampleTilePixels' null probes. */
export async function sampleFrameTransform(
  page: Page,
): Promise<SampleFrameTransform | null> {
  const box = await page
    .locator("canvas[data-runtime-canvas='true']")
    .boundingBox();
  if (box === null) return null;
  const view = await boardView(page);
  const { scale, offsetX, offsetY } = getBoardTransform(
    box,
    view.map,
    view.camera,
  );
  const rectWidth = await page.evaluate(() => {
    const canvas = document.querySelector("canvas[data-runtime-canvas='true']");
    return canvas instanceof HTMLCanvasElement
      ? canvas.getBoundingClientRect().width
      : 0;
  });
  const shot = await page.evaluate(async () => {
    const runtime = (
      window as unknown as {
        __caelumRuntime?: {
          debugCaptureFrame?: () => Promise<{
            width: number;
          } | null>;
        };
      }
    ).__caelumRuntime;
    return runtime?.debugCaptureFrame === undefined
      ? null
      : runtime.debugCaptureFrame();
  });
  if (rectWidth === 0 || shot === null || shot.width === 0) return null;
  return { scale, offsetX, offsetY, dpr: shot.width / rectWidth };
}

/**
 * Samples RGB triples from the rendered gameplay frame at world-space points
 * expressed as tile + world-pixel offsets. One capture covers every probe;
 * off-board probes return null.
 *
 * The capture comes from `RuntimeTestSeam.debugCaptureFrame`: the host
 * re-renders the current frame into an offscreen target and reads it back via
 * copyTextureToBuffer. Canvas-side readbacks (toDataURL, drawImage,
 * screenshots) cannot be used for this — under software-Vulkan CI Chromium a
 * WebGPU canvas never reaches the compositor, so they only ever read blank.
 */
export async function sampleTilePixels(
  page: Page,
  probes: PixelProbe[],
): Promise<Array<[number, number, number] | null>> {
  // page.evaluate cannot capture Node-scope imports, so resolve the board
  // transform here and pass it in.
  const box = await page
    .locator("canvas[data-runtime-canvas='true']")
    .boundingBox();
  if (box === null) {
    return probes.map(() => null);
  }
  const view = await boardView(page);
  const { scale, offsetX, offsetY } = getBoardTransform(
    box,
    view.map,
    view.camera,
  );
  const width = view.map.width * tileSize;
  const height = view.map.height * tileSize;
  return page.evaluate(
    async ({ points, size, width, height, scale, offsetX, offsetY }) => {
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
      const runtime = (
        window as unknown as {
          __caelumRuntime?: {
            debugCaptureFrame?: () => Promise<{
              width: number;
              height: number;
              pixels: Uint8ClampedArray;
            } | null>;
          };
        }
      ).__caelumRuntime;
      if (runtime?.debugCaptureFrame === undefined) {
        throw new Error(
          "debugCaptureFrame is unavailable on window.__caelumRuntime",
        );
      }
      const shot = await runtime.debugCaptureFrame();
      if (shot === null || shot.width === 0 || shot.height === 0) {
        return points.map(() => null);
      }
      const dpr = shot.width / rect.width;
      return points.map(({ tile, dx, dy }) => {
        const worldX = (tile.x + 0.5) * size + dx;
        const worldY = (tile.y + 0.5) * size + dy;
        if (worldX < 0 || worldY < 0 || worldX >= width || worldY >= height) {
          return null;
        }
        const cssX = offsetX + worldX * scale;
        const cssY = offsetY + worldY * scale;
        const px = Math.round(cssX * dpr);
        const py = Math.round(cssY * dpr);
        if (px < 0 || py < 0 || px >= shot.width || py >= shot.height) {
          return null;
        }
        const index = (py * shot.width + px) * 4;
        return [
          shot.pixels[index],
          shot.pixels[index + 1],
          shot.pixels[index + 2],
        ] as [number, number, number];
      });
    },
    { points: probes, size: tileSize, width, height, scale, offsetX, offsetY },
  );
}
