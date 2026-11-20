import { expect, test, type Page } from "@playwright/test";
import {
  clickMapTile,
  createDefaultCity,
  dragMapTiles,
  openCommandDestination,
  runtimeSnapshot,
  sampleTilePixels,
  selectBuildLeaf,
  settleLayout,
  type PixelProbe,
} from "./helpers";
import { expectRoadsideStopAnchors } from "./stopAnchors";
import { expectRotatedLargeHouseFootprint } from "./spriteFootprint";

// colors.road #5f6d75 — the exact opaque road tile fill (tileFillColor in
// mapBatch.ts), recomputed here to keep the oracle independent of render
// internals, like the grass fills in spriteFootprint.ts.
const ROAD_FILL = [95, 109, 117] as const;
// colors.empty #c3d99a — the Canvas2D clear color and empty grass base.
const CLEAR_RGB = [195, 217, 154] as const;

const STROKE_Y = 12;
const STROKE_XS = [6, 7, 8, 9, 10] as const;

/** Hide WebGPU before any page script runs so the production startup probe
 *  (probeWebGpuCapability in createGameHost.ts) finds no capability and
 *  selects the Canvas2D fallback. There is no production renderer override:
 *  the test only removes the API the probe is defined to detect, and every
 *  selection below is the shipping code path. addInitScript re-applies the
 *  hiding across the City Library reload in this spec. */
async function hideWebGpu(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "gpu", {
      configurable: true,
      get: () => undefined,
    });
  });
}

async function roadTileKinds(page: Page): Promise<Array<string | null>> {
  const snapshot = await runtimeSnapshot(page);
  return STROKE_XS.map(
    (x) =>
      snapshot.state.map.tiles.find(
        (tile) => tile.x === x && tile.y === STROKE_Y,
      )?.kind ?? null,
  );
}

/** Read the live capture and prove it is not a blank/clear frame: some
 *  sampled device pixel must differ from the renderer's clear color. */
async function expectNonblankCapture(page: Page): Promise<void> {
  const shot = await page.evaluate(async () => {
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
    return runtime.debugCaptureFrame();
  });
  expect(shot).not.toBeNull();
  expect(shot!.width).toBeGreaterThan(0);
  expect(shot!.height).toBeGreaterThan(0);
  const pixelCount = shot!.width * shot!.height;
  const stride = Math.max(1, Math.floor(pixelCount / 4096));
  let differsFromClear = false;
  for (let pixel = 0; pixel < pixelCount; pixel += stride) {
    const index = pixel * 4;
    if (
      shot!.pixels[index] !== CLEAR_RGB[0] ||
      shot!.pixels[index + 1] !== CLEAR_RGB[1] ||
      shot!.pixels[index + 2] !== CLEAR_RGB[2]
    ) {
      differsFromClear = true;
      break;
    }
  }
  expect(differsFromClear, "capture contains non-clear pixels").toBe(true);
}

// The road tile fill quad is triangles a-b-c then b-d-c (rect in
// primitives.ts), so its two triangles share the top-right → bottom-left
// diagonal. Points on that shared edge must read the exact road fill: with
// seam-safe same-RGBA run filling the diagonal is path interior, while
// per-triangle Canvas2D antialiasing dips below full coverage at the device
// pixels the diagonal crosses (which ones depends on the fit transform, so
// the probe sweeps the whole diagonal densely — one capture covers all
// points). The sweep skips |dy| ≤ 3 (centerline band ±2 plus AA margin);
// the remaining points clear the centerline, curbs and tile-boundary grid
// lines by ≥ 1.2 world px. The last probe sits off the diagonal as an
// interior control.
const SEAM_PROBES: PixelProbe[] = [];
for (let t = 0.16; t <= 0.8401; t += 0.01) {
  const dy = 32 * t - 16;
  if (Math.abs(dy) <= 3) continue;
  SEAM_PROBES.push({
    tile: { x: 8, y: STROKE_Y },
    dx: -dy,
    dy,
  });
}
SEAM_PROBES.push({ tile: { x: 8, y: STROKE_Y }, dx: 6.4, dy: 6.4 });

async function expectRoadFillAtProbes(page: Page): Promise<void> {
  const samples = await sampleTilePixels(page, SEAM_PROBES);
  expect(samples).toHaveLength(SEAM_PROBES.length);
  samples.forEach((sample, index) => {
    expect(sample, `seam probe ${index}`).not.toBeNull();
    for (let channel = 0; channel < 3; channel += 1) {
      expect(
        Math.abs(sample![channel] - ROAD_FILL[channel]),
        `seam probe ${index} channel ${channel}`,
      ).toBeLessThanOrEqual(8);
    }
  });
}

test("Canvas2D fallback drives real WASM gameplay: mutation, seam, stop markers, remount, resize", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await hideWebGpu(page);
  await createDefaultCity(page, "Fallback Smoke", "blankGrid");

  // Startup selection picked the Canvas2D fallback and the shell is healthy.
  const canvas = page.locator("canvas[data-runtime-canvas='true']");
  await expect(canvas).toHaveAttribute("data-renderer", "canvas2d");
  await expect(page.getByTestId("game-shell")).toBeVisible();
  await expect(page.locator(".shell-error")).toHaveCount(0);

  // One Rust-backed construction mutation: a five-tile two-way road stroke
  // dispatched through the WASM backend into caelum-core and back.
  const before = await runtimeSnapshot(page);
  await selectBuildLeaf(page, "roads", "road-twoWay");
  await dragMapTiles(
    page,
    canvas,
    { x: 6, y: STROKE_Y },
    { x: 10, y: STROKE_Y },
  );
  await expect
    .poll(async () => roadTileKinds(page), { timeout: 15_000 })
    .toEqual(["road", "road", "road", "road", "road"]);
  const after = await runtimeSnapshot(page);
  expect(after.state.budget).toBeLessThan(before.state.budget);

  // The captured fallback frame is nonblank and the road fill reads exactly —
  // including on the shared quad diagonal, where per-triangle antialiasing
  // would show a seam.
  await expectNonblankCapture(page);
  await expectRoadFillAtProbes(page);

  // Known-color roadside stop marker oracle, extracted from routes.spec.ts
  // and reused verbatim under the fallback (no cloned routes flow: the
  // markers render from the stops alone). Zoom to the camera clamp first:
  // the oracle's rim probes sit ~1 world px inside the marker's outer edge,
  // which Canvas2D path antialiasing can graze at fit zoom — at the 96 CSS
  // px/tile clamp they clear the antialiased band by ≥3 device px. WebGPU
  // has no path antialiasing and passes at any zoom.
  await selectBuildLeaf(page, "transit", "busStop");
  for (let step = 0; step < 24; step += 1) {
    await page.evaluate(() => {
      const runtime = (
        window as unknown as {
          __caelumRuntime?: {
            adjustCamera?: (action: { kind: "zoomIn" }) => unknown;
          };
        }
      ).__caelumRuntime;
      runtime?.adjustCamera?.({ kind: "zoomIn" });
    });
  }
  await page.evaluate(() => {
    const runtime = (
      window as unknown as {
        __caelumRuntime?: {
          adjustCamera?: (action: {
            kind: "centerOn";
            point: { x: number; y: number };
          }) => unknown;
        };
      }
    ).__caelumRuntime;
    runtime?.adjustCamera?.({ kind: "centerOn", point: { x: 8.5, y: 11.5 } });
  });
  await settleLayout(page);
  await clickMapTile(canvas, { x: 7, y: 11 });
  await clickMapTile(canvas, { x: 9, y: 11 });
  await expectRoadsideStopAnchors(page, [
    { x: 7, y: 11 },
    { x: 9, y: 11 },
  ]);

  // Same-document remount round trip: New City → Cancel swaps the shell
  // screens, detaching the gameplay canvas and remounting a replacement
  // canvas on the SAME runtime instance and its already-selected fallback
  // renderer (createGameRuntime runs once per document — no reload). Mark
  // the live runtime and the outgoing canvas first; the marks must survive.
  const remounted = page.locator("canvas[data-runtime-canvas='true']");
  await page.evaluate(() => {
    const runtime = (
      window as unknown as { __caelumRuntime?: { remountProbe?: string } }
    ).__caelumRuntime;
    if (runtime === undefined) {
      throw new Error("__caelumRuntime is unavailable");
    }
    runtime.remountProbe = "same-document";
    const outgoing = document.querySelector(
      "canvas[data-runtime-canvas='true']",
    );
    if (outgoing === null) throw new Error("no mounted gameplay canvas");
    outgoing.setAttribute("data-remount-probe", "outgoing");
  });
  await openCommandDestination(page, "city");
  await page
    .getByTestId("panel-city")
    .getByRole("button", { name: "New City" })
    .click();
  const newCity = page.getByTestId("new-city-screen");
  await expect(newCity).toBeVisible();
  await newCity.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByTestId("game-canvas-host")).toBeVisible();

  // The mounted canvas is a replacement element, still the Canvas2D
  // fallback, on the same runtime instance — and it genuinely renders: the
  // road stroke reads back through real pixels, not a reload.
  await expect(remounted).not.toHaveAttribute("data-remount-probe", "outgoing");
  await expect(remounted).toHaveAttribute("data-renderer", "canvas2d");
  const remountProbe = await page.evaluate(
    () =>
      (window as unknown as { __caelumRuntime?: { remountProbe?: string } })
        .__caelumRuntime?.remountProbe,
  );
  expect(remountProbe).toBe("same-document");
  await expectNonblankCapture(page);
  await expectRoadFillAtProbes(page);

  // Reload persistence check: save, leave through the City Library, come
  // back in a fresh document; the fallback renderer and saved city return.
  await openCommandDestination(page, "city");
  const cityPanel = page.getByTestId("panel-city");
  await cityPanel.getByRole("button", { name: "Save Now" }).click();
  await expect(cityPanel.getByTestId("city-save-status")).toHaveAttribute(
    "data-dirty",
    "false",
  );

  await page.reload();
  const library = page.getByTestId("city-library-screen");
  await expect(library).toBeVisible();
  await library
    .getByRole("button", { name: "Continue Fallback Smoke" })
    .click();
  await expect(page.getByTestId("game-canvas-host")).toBeVisible();

  const restored = page.locator("canvas[data-runtime-canvas='true']");
  await expect(restored).toHaveAttribute("data-renderer", "canvas2d");
  await expect
    .poll(async () => roadTileKinds(page), { timeout: 15_000 })
    .toEqual(["road", "road", "road", "road", "road"]);
  await expectNonblankCapture(page);

  // Resize the backing store (Canvas2D resets all context state on resize)
  // and recapture: the renderer must repaint the restored city correctly at
  // the new size.
  await page.setViewportSize({ width: 1100, height: 720 });
  await settleLayout(page);
  await expect(restored).toHaveAttribute("data-renderer", "canvas2d");
  await expectNonblankCapture(page);
  await expectRoadFillAtProbes(page);
});

test("reused rotated largeHouse footprint oracle passes on the Canvas2D fallback", async ({
  page,
}) => {
  await hideWebGpu(page);
  // The renderer-neutral oracle from mapSprites.spec.ts: opaque terracotta
  // inside every occupied tile center, pure grass outside every rotated
  // footprint edge, transparent sprite insets over shadowed ground.
  await expectRotatedLargeHouseFootprint(page);
  const canvas = page.locator("canvas[data-runtime-canvas='true']");
  await expect(canvas).toHaveAttribute("data-renderer", "canvas2d");
  await expect(page.locator(".shell-error")).toHaveCount(0);
});
