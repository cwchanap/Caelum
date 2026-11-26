import { expect, type Page } from "@playwright/test";
import { tileSize } from "../../src/render/boardTransform";
import {
  clickMapTile,
  createDefaultCity,
  dragMapTiles,
  openCommandDestination,
  runtimeSnapshot,
  sampleFrameTransform,
  sampleTilePixels,
  selectBuildLeaf,
  selectTool,
  settleLayout,
  type PixelProbe,
} from "./helpers";
import { expectRoadsideStopAnchors } from "./stopAnchors";
import { grassRgb } from "./spriteFootprint";

const stops = [
  { x: 7, y: 9 },
  { x: 11, y: 9 },
] as const;
const stations = [
  { x: 7, y: 6 },
  { x: 10, y: 6 },
] as const;

function closeToColor(
  sample: [number, number, number] | null,
  color: readonly number[],
  tolerance: number,
): boolean {
  return (
    sample !== null &&
    color.every((value, index) => Math.abs(sample[index]! - value) <= tolerance)
  );
}

const redRim = ([r, g, b]: [number, number, number]) => r - Math.max(g, b) > 35;
const blueRim = ([r, g, b]: [number, number, number]) =>
  b - Math.max(r, g) > 25;
const creamFace = ([r, g, b]: [number, number, number]) =>
  r > 200 && g > 190 && b > 150 && r >= g - 15;
const darkGlyph = ([r, g, b]: [number, number, number]) =>
  r < 170 && g < 160 && b < 150;

interface DeviceCrop {
  width: number;
  height: number;
  dpr: number;
  samples: Array<[number, number, number] | null>;
}

interface PixelBounds {
  count: number;
  width: number;
  height: number;
}

function pixelBounds(
  crop: DeviceCrop,
  matches: (sample: [number, number, number]) => boolean,
  centerRadius?: number,
): PixelBounds {
  const center = (crop.width - 1) / 2;
  let count = 0;
  let minX = crop.width;
  let maxX = -1;
  let minY = crop.height;
  let maxY = -1;
  for (let y = 0; y < crop.height; y += 1) {
    for (let x = 0; x < crop.width; x += 1) {
      if (
        centerRadius !== undefined &&
        (Math.abs(x - center) > centerRadius ||
          Math.abs(y - center) > centerRadius)
      ) {
        continue;
      }
      const sample = crop.samples[y * crop.width + x];
      if (sample == null || !matches(sample)) continue;
      count += 1;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  return {
    count,
    width: count === 0 ? 0 : maxX - minX + 1,
    height: count === 0 ? 0 : maxY - minY + 1,
  };
}

/** Samples one device-pixel-aligned crop around a tile center through the
 *  same capture oracle as point probes, so Fit-scale assertions measure the
 *  pixels the renderer actually produced rather than the artwork file. */
async function sampleBadgeDeviceCrop(
  page: Page,
  tile: { x: number; y: number },
  radiusCssPx: number,
): Promise<DeviceCrop> {
  const transform = await sampleFrameTransform(page);
  if (transform === null) throw new Error("No capturable frame transform");
  const radiusDevicePx = Math.ceil(radiusCssPx * transform.dpr);
  const centerWorld = {
    x: (tile.x + 0.5) * tileSize,
    y: (tile.y + 0.5) * tileSize,
  };
  const centerDevice = {
    x: (transform.offsetX + centerWorld.x * transform.scale) * transform.dpr,
    y: (transform.offsetY + centerWorld.y * transform.scale) * transform.dpr,
  };
  const left = Math.round(centerDevice.x) - radiusDevicePx;
  const top = Math.round(centerDevice.y) - radiusDevicePx;
  const width = radiusDevicePx * 2 + 1;
  const probes: PixelProbe[] = [];
  for (let py = 0; py < width; py += 1) {
    for (let px = 0; px < width; px += 1) {
      const worldX =
        ((left + px) / transform.dpr - transform.offsetX) / transform.scale;
      const worldY =
        ((top + py) / transform.dpr - transform.offsetY) / transform.scale;
      probes.push({
        tile,
        dx: worldX - centerWorld.x,
        dy: worldY - centerWorld.y,
      });
    }
  }
  return {
    width,
    height: width,
    dpr: transform.dpr,
    samples: await sampleTilePixels(page, probes),
  };
}

function cssBounds(bounds: PixelBounds, dpr: number): PixelBounds {
  return {
    count: bounds.count / (dpr * dpr),
    width: bounds.width / dpr,
    height: bounds.height / dpr,
  };
}

function cropSampleAtCss(
  crop: DeviceCrop,
  xCss: number,
  yCss: number,
): [number, number, number] | null {
  const center = (crop.width - 1) / 2;
  const x = Math.round(center + xCss * crop.dpr);
  const y = Math.round(center + yCss * crop.dpr);
  if (x < 0 || x >= crop.width || y < 0 || y >= crop.height) return null;
  return crop.samples[y * crop.width + x] ?? null;
}

function luminance(sample: [number, number, number]): number {
  return (sample[0] + sample[1] + sample[2]) / 3;
}

function texelLuminance(
  crop: DeviceCrop,
  tileCssPx: number,
  texelX: number,
  texelY: number,
): number {
  const xCss = ((texelX - 96) / 192) * tileCssPx;
  const yCss = ((texelY - 96) / 192) * tileCssPx;
  const sample = cropSampleAtCss(crop, xCss, yCss);
  if (sample === null) {
    throw new Error(`missing badge texel probe ${texelX},${texelY}`);
  }
  return luminance(sample);
}

function texelRegionExtreme(
  crop: DeviceCrop,
  tileCssPx: number,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  extreme: "light" | "dark",
): number {
  let best = extreme === "light" ? -Infinity : Infinity;
  for (let x = x0; x <= x1; x += 4) {
    for (let y = y0; y <= y1; y += 4) {
      const value = texelLuminance(crop, tileCssPx, x, y);
      best =
        extreme === "light" ? Math.max(best, value) : Math.min(best, value);
    }
  }
  return best;
}

function expectBusGlyphPattern(crop: DeviceCrop, tileCssPx: number): void {
  const light = (x0: number, x1: number, y0: number, y1: number) =>
    texelRegionExtreme(crop, tileCssPx, x0, x1, y0, y1, "light");
  const dark = (x0: number, x1: number, y0: number, y1: number) =>
    texelRegionExtreme(crop, tileCssPx, x0, x1, y0, y1, "dark");
  const windshield = light(82, 110, 74, 90);
  const upperFrame = (dark(56, 68, 70, 86) + dark(124, 136, 70, 86)) / 2;
  const body = dark(60, 132, 94, 106);
  const lowerGap = light(90, 102, 116, 123);
  const wheels = (dark(66, 78, 112, 122) + dark(114, 126, 112, 122)) / 2;
  const values = { windshield, upperFrame, body, lowerGap, wheels };
  expect(
    windshield - upperFrame > 40,
    `bus windshield/frame contrast: ${JSON.stringify(values)}`,
  ).toBe(true);
  expect(
    windshield - body > 80,
    `bus windshield/body contrast: ${JSON.stringify(values)}`,
  ).toBe(true);
  expect(
    lowerGap - wheels > 20,
    `bus wheel-gap contrast: ${JSON.stringify(values)}`,
  ).toBe(true);
}

interface DeviceAxes {
  dpr: number;
  horizontal: Array<[number, number, number] | null>;
  vertical: Array<[number, number, number] | null>;
}

/** Samples the center row and column at device-pixel spacing in one capture. */
async function sampleBadgeDeviceAxes(
  page: Page,
  tile: { x: number; y: number },
  radiusCssPx: number,
): Promise<DeviceAxes> {
  const transform = await sampleFrameTransform(page);
  if (transform === null) throw new Error("No capturable frame transform");
  const radiusDevicePx = Math.ceil(radiusCssPx * transform.dpr);
  const centerWorld = {
    x: (tile.x + 0.5) * tileSize,
    y: (tile.y + 0.5) * tileSize,
  };
  const centerDevice = {
    x: (transform.offsetX + centerWorld.x * transform.scale) * transform.dpr,
    y: (transform.offsetY + centerWorld.y * transform.scale) * transform.dpr,
  };
  const centerX = Math.round(centerDevice.x);
  const centerY = Math.round(centerDevice.y);
  const width = radiusDevicePx * 2 + 1;
  const probeAt = (deviceX: number, deviceY: number): PixelProbe => {
    const worldX =
      (deviceX / transform.dpr - transform.offsetX) / transform.scale;
    const worldY =
      (deviceY / transform.dpr - transform.offsetY) / transform.scale;
    return {
      tile,
      dx: worldX - centerWorld.x,
      dy: worldY - centerWorld.y,
    };
  };
  const probes: PixelProbe[] = [];
  for (let step = -radiusDevicePx; step <= radiusDevicePx; step += 1) {
    probes.push(probeAt(centerX + step, centerY));
  }
  for (let step = -radiusDevicePx; step <= radiusDevicePx; step += 1) {
    probes.push(probeAt(centerX, centerY + step));
  }
  const samples = await sampleTilePixels(page, probes);
  return {
    dpr: transform.dpr,
    horizontal: samples.slice(0, width),
    vertical: samples.slice(width),
  };
}

function axisSpanCss(
  axis: Array<[number, number, number] | null>,
  matches: (sample: [number, number, number]) => boolean,
  dpr: number,
): number {
  let first = -1;
  let last = -1;
  axis.forEach((sample, index) => {
    if (sample === null || !matches(sample)) return;
    if (first === -1) first = index;
    last = index;
  });
  return first === -1 ? 0 : (last - first + 1) / dpr;
}

function expectMetroGlyphPattern(crop: DeviceCrop, tileCssPx: number): void {
  const light = (x0: number, x1: number, y0: number, y1: number) =>
    texelRegionExtreme(crop, tileCssPx, x0, x1, y0, y1, "light");
  const dark = (x0: number, x1: number, y0: number, y1: number) =>
    texelRegionExtreme(crop, tileCssPx, x0, x1, y0, y1, "dark");
  const topNotch = light(90, 102, 62, 76);
  const topStems = (dark(58, 76, 62, 80) + dark(116, 134, 62, 80)) / 2;
  const centerValley = dark(88, 104, 100, 120);
  const bottomCenter = light(90, 102, 122, 134);
  const bottomStems = (dark(58, 76, 116, 132) + dark(116, 134, 116, 132)) / 2;
  const values = {
    topNotch,
    topStems,
    centerValley,
    bottomCenter,
    bottomStems,
  };
  expect(
    topNotch - topStems > 60,
    `metro top notch/stem contrast: ${JSON.stringify(values)}`,
  ).toBe(true);
  expect(
    topNotch - centerValley > 80,
    `metro notch/valley contrast: ${JSON.stringify(values)}`,
  ).toBe(true);
  expect(
    bottomCenter - bottomStems > 40,
    `metro bottom notch/stem contrast: ${JSON.stringify(values)}`,
  ).toBe(true);
}

async function expectMetroBadge(
  page: Page,
  rim: readonly number[],
  tolerance: number,
  tile: { x: number; y: number } = stations[0],
): Promise<void> {
  const texel = tileSize / 192;
  const pixels = await sampleTilePixels(page, [
    // Face texel (48,96), inside the cream field away from the M glyph.
    { tile, dx: -48 * texel, dy: 0 },
    // Mask texels (96,30) and (96,162) lie beyond the horizontal 8px stroke.
    { tile, dx: 0, dy: -66 * texel },
    { tile, dx: 0, dy: 66 * texel },
  ]);
  expect(
    closeToColor(pixels[0]!, [255, 248, 238], tolerance),
    `metro face: ${pixels[0]}`,
  ).toBe(true);
  for (const [index, pixel] of pixels.slice(1).entries()) {
    expect(
      closeToColor(pixel, rim, tolerance),
      `metro rim perpendicular probe ${index}: ${pixel}`,
    ).toBe(true);
  }
}

/** Real UI construction shared by the full interaction regression and the
 *  focused DPR-2 badge oracle. */
export async function buildTransitSpriteScene(
  page: Page,
  renderer: "webgpu" | "canvas2d",
) {
  await createDefaultCity(
    page,
    `Transit ${renderer}`,
    "blankGrid",
    renderer,
    "large",
  );
  const canvas = page.locator("canvas[data-runtime-canvas='true']");
  await expect(canvas).toHaveAttribute("data-renderer", renderer);

  await selectBuildLeaf(page, "roads", "road-twoWay");
  await dragMapTiles(page, canvas, { x: 6, y: 10 }, { x: 12, y: 10 });
  await selectBuildLeaf(page, "transit", "busStop");
  for (const stop of stops) await clickMapTile(canvas, stop);

  await selectBuildLeaf(page, "transit", "track");
  await dragMapTiles(page, canvas, { x: 7, y: 6 }, { x: 11, y: 6 });
  await dragMapTiles(page, canvas, { x: 9, y: 5 }, { x: 9, y: 6 });
  await dragMapTiles(page, canvas, { x: 11, y: 6 }, { x: 11, y: 7 });
  await selectBuildLeaf(page, "transit", "metroStation");
  for (const station of stations) await clickMapTile(canvas, station);
  await selectTool(page, "select");
  await expect
    .poll(async () => {
      const { state } = await runtimeSnapshot(page);
      return [
        [7, 6],
        [8, 6],
        [9, 6],
        [10, 6],
        [11, 6],
        [9, 5],
        [11, 7],
      ].every(
        ([x, y]) =>
          state.map.tiles.find((tile) => tile.x === x && tile.y === y)
            ?.hasTrack === true,
      );
    })
    .toBe(true);
  return canvas;
}

/** Assert the actual rendered bus/metro badge structure at the reference
 *  Large Fit already selected in the page. */
export async function expectFitBadgePixels(
  page: Page,
  fitTileCssPx: number,
): Promise<void> {
  const busCrop = await sampleBadgeDeviceCrop(page, stops[0], 6.5);
  const metroCrop = await sampleBadgeDeviceCrop(page, stations[0], 6.5);
  const busRimBounds = cssBounds(pixelBounds(busCrop, redRim), busCrop.dpr);
  const metroRimBounds = cssBounds(
    pixelBounds(metroCrop, blueRim),
    metroCrop.dpr,
  );
  const busFaceBounds = cssBounds(pixelBounds(busCrop, creamFace), busCrop.dpr);
  const metroFaceBounds = cssBounds(
    pixelBounds(metroCrop, creamFace),
    metroCrop.dpr,
  );
  const busGlyphBounds = cssBounds(
    pixelBounds(busCrop, darkGlyph, 3 * busCrop.dpr),
    busCrop.dpr,
  );
  const metroGlyphBounds = cssBounds(
    pixelBounds(metroCrop, darkGlyph, 3 * metroCrop.dpr),
    metroCrop.dpr,
  );
  for (const [label, bounds] of [
    ["bus", busRimBounds],
    ["metro", metroRimBounds],
  ] as const) {
    expect(
      bounds.width >= 8 && bounds.height >= 8,
      `Fit ${label} rim CSS bounds: ${JSON.stringify(bounds)}`,
    ).toBe(true);
    expect(
      bounds.width / bounds.height > 0.8 && bounds.width / bounds.height < 1.25,
      `Fit ${label} rim aspect: ${JSON.stringify(bounds)}`,
    ).toBe(true);
  }
  for (const [label, bounds] of [
    ["bus", busFaceBounds],
    ["metro", metroFaceBounds],
  ] as const) {
    expect(
      bounds.count >= 4 && bounds.width >= 3 && bounds.height >= 4,
      `Fit ${label} face CSS bounds: ${JSON.stringify(bounds)}`,
    ).toBe(true);
  }
  for (const [label, bounds] of [
    ["bus", busGlyphBounds],
    ["metro", metroGlyphBounds],
  ] as const) {
    expect(
      bounds.count >= 4,
      `Fit ${label} glyph CSS center: ${JSON.stringify(bounds)}`,
    ).toBe(true);
  }
  expectBusGlyphPattern(busCrop, fitTileCssPx);
  expectMetroGlyphPattern(metroCrop, fitTileCssPx);
}

/** Real UI construction, with the same independent pixel probes in both renderers. */
export async function expectTransitSpriteScene(
  page: Page,
  renderer: "webgpu" | "canvas2d",
): Promise<void> {
  const canvas = await buildTransitSpriteScene(page, renderer);

  // Opaque ballast at the edge of the real 192px straight/corner assets.
  const seamProbes: PixelProbe[] = [
    { tile: { x: 8, y: 6 }, dx: 15, dy: 0 },
    { tile: { x: 9, y: 6 }, dx: -15, dy: 0 },
    { tile: { x: 10, y: 6 }, dx: 15, dy: 0 },
    { tile: { x: 11, y: 6 }, dx: -15, dy: 0 },
    { tile: { x: 11, y: 6 }, dx: 0, dy: 15 },
    { tile: { x: 11, y: 7 }, dx: 0, dy: -15 },
    // The south side of the endpoint has no neighbor and no rail.
    { tile: { x: 11, y: 7 }, dx: 0, dy: 13 },
  ];
  const checkSeams = async (): Promise<void> => {
    const pixels = await sampleTilePixels(page, seamProbes);
    for (let i = 0; i < 6; i += 1) {
      expect(
        closeToColor(pixels[i]!, [222, 198, 163], 60),
        `rail edge ${i}: ${pixels[i]}`,
      ).toBe(true);
    }
    expect(
      closeToColor(pixels[6]!, grassRgb({ x: 11, y: 7 }), 12),
      `no phantom rail: ${pixels[6]}`,
    ).toBe(true);
  };
  // Keep the original default-viewport Fit seam oracle before the larger
  // reference viewport resize below.
  await checkSeams();
  // HPA-979's legibility contract uses the 1440×900 Large-map Fit
  // (~13.7 CSS px/tile), not the smaller default Playwright viewport. Apply it
  // only for this measurement so the long interaction flow keeps the cheaper
  // original canvas size.
  const originalViewport = page.viewportSize();
  await page.setViewportSize({ width: 1440, height: 900 });
  await settleLayout(page);
  await page.getByTestId("map-zoom-fit").click();
  await settleLayout(page);
  const fit = await sampleFrameTransform(page);
  await checkSeams();
  const fitTileCssPx = fit!.scale * tileSize;
  expect(fitTileCssPx).toBeGreaterThan(13.5);
  expect(fitTileCssPx).toBeLessThan(14);
  await expectFitBadgePixels(page, fitTileCssPx);
  if (originalViewport !== null) {
    await page.setViewportSize(originalViewport);
    await settleLayout(page);
  }
  await page.evaluate(() => {
    const runtime = (
      window as unknown as {
        __caelumRuntime: {
          adjustCamera(
            action:
              | { kind: "zoomIn" }
              | { kind: "centerOn"; point: { x: number; y: number } },
          ): unknown;
        };
      }
    ).__caelumRuntime;
    for (let i = 0; i < 24; i += 1) runtime.adjustCamera({ kind: "zoomIn" });
    runtime.adjustCamera({ kind: "centerOn", point: { x: 9.5, y: 8 } });
  });
  await settleLayout(page);
  const transform = await sampleFrameTransform(page);
  expect(transform!.scale * 32).toBeCloseTo(96, 1);
  await checkSeams();

  // Max zoom alone does not prove badge scale: measure both tinted rim axes.
  // The opaque rim diameter is 144 of 192 source texels (72 CSS px), with the
  // antialiased alpha bbox reaching 75 CSS px.
  for (const [label, tile, matches] of [
    ["bus", stops[0], redRim],
    ["metro", stations[0], blueRim],
  ] as const) {
    const axes = await sampleBadgeDeviceAxes(page, tile, 40);
    const width = axisSpanCss(axes.horizontal, matches, axes.dpr);
    const height = axisSpanCss(axes.vertical, matches, axes.dpr);
    for (const [axis, measured] of [
      ["width", width],
      ["height", height],
    ] as const) {
      expect(
        measured >= 72 && measured <= 76,
        `max-zoom ${label} rim ${axis}: ${measured} CSS px`,
      ).toBe(true);
    }
    expect(
      Math.abs(width - height) <= 2,
      `max-zoom ${label} rim axes: ${width}x${height} CSS px`,
    ).toBe(true);
  }
  // The quad ends exactly at the tile boundary. One world pixel beyond it,
  // neighboring empty tiles still show flat grass rather than rim bleed.
  const adjacentClear = await sampleTilePixels(page, [
    { tile: { x: 6, y: 9 }, dx: 15, dy: 0 },
    { tile: { x: 8, y: 9 }, dx: -15, dy: 0 },
    { tile: { x: 7, y: 5 }, dx: 0, dy: 15 },
    { tile: { x: 7, y: 7 }, dx: 0, dy: -15 },
  ]);
  const adjacentTiles = [
    { x: 6, y: 9 },
    { x: 8, y: 9 },
    { x: 7, y: 5 },
    { x: 7, y: 7 },
  ];
  for (const [index, pixel] of adjacentClear.entries()) {
    expect(
      closeToColor(pixel, grassRgb(adjacentTiles[index]!), 12),
      `adjacent badge tile ${index}: ${pixel}`,
    ).toBe(true);
  }

  // Place the join at N+0.6 device pixels so pixel N's center lies 0.1px
  // inside the straight's east edge, where linear filtering sees its gutter.
  const edgeDevice =
    (transform!.offsetX + 9 * 32 * transform!.scale) * transform!.dpr;
  const camera = (await runtimeSnapshot(page)).camera!;
  const shift =
    (edgeDevice - (Math.floor(edgeDevice) + 0.6)) /
    (32 * transform!.scale * transform!.dpr);
  await page.evaluate(
    (center) => {
      const runtime = (
        window as unknown as {
          __caelumRuntime: {
            adjustCamera(action: {
              kind: "centerOn";
              point: { x: number; y: number };
            }): unknown;
          };
        }
      ).__caelumRuntime;
      runtime.adjustCamera({ kind: "centerOn", point: center });
    },
    { x: camera.center.x + shift, y: camera.center.y },
  );
  await settleLayout(page);
  const fractional = (await sampleFrameTransform(page))!;
  const edge =
    (fractional.offsetX + 9 * 32 * fractional.scale) * fractional.dpr;
  expect(edge - Math.floor(edge)).toBeCloseTo(0.6, 2);
  const leftWorld =
    (Math.floor(edge) / fractional.dpr - fractional.offsetX) / fractional.scale;
  const joinPixels = await sampleTilePixels(
    page,
    [-1, 0, 1, 2].map((step) => ({
      tile: { x: 8, y: 6 },
      dx: leftWorld - 8.5 * 32 + step / (fractional.scale * fractional.dpr),
      dy: 0,
    })),
  );
  for (const [index, pixel] of joinPixels.entries()) {
    expect(
      closeToColor(pixel, [222, 198, 163], 4),
      `fractional join ${index}: ${pixel}`,
    ).toBe(true);
  }

  // Tile (11,7) hashes to a tree centered at approximately (+2,+1.4),
  // with a +3/+3 shadow. Track suppresses both across their old footprint.
  const obstructionPixels = await sampleTilePixels(page, [
    { tile: { x: 11, y: 7 }, dx: 2, dy: 6 },
    { tile: { x: 11, y: 7 }, dx: 5, dy: 7 },
  ]);
  for (const pixel of obstructionPixels) {
    expect(
      closeToColor(pixel, grassRgb({ x: 11, y: 7 }), 12),
      `no tree or shadow: ${pixel}`,
    ).toBe(true);
  }

  // The rotated west-half endpoint uses source texel x≈16 (brown sleeper),
  // not texel x≈32 from squeezing the full straight image into half a tile.
  const [half] = await sampleTilePixels(page, [
    { tile: { x: 11, y: 7 }, dx: 0, dy: -13.33 },
  ]);
  expect(
    closeToColor(half!, [154, 123, 94], 35),
    `half rail sleeper: ${half}`,
  ).toBe(true);
  expect(closeToColor(half!, [222, 198, 163], 30)).toBe(false);

  await expectMetroBadge(page, [40, 103, 178], 35);
  await expectRoadsideStopAnchors(page, stops);

  await openCommandDestination(page, "lines");
  await page.getByRole("button", { name: "New Bus" }).click();
  const [beforeHandle] = await sampleTilePixels(page, [
    { tile: stops[0], dx: 0, dy: 0 },
  ]);
  for (const stop of stops) await clickMapTile(canvas, stop);
  await expect(page.getByTestId("route-draft")).toBeVisible();
  const [activeHandle] = await sampleTilePixels(page, [
    { tile: stops[0], dx: 0, dy: 0 },
  ]);
  expect(closeToColor(beforeHandle!, [255, 252, 243], 35)).toBe(false);
  expect(
    closeToColor(activeHandle!, [255, 252, 243], 35),
    `rendered draft handle: ${activeHandle}`,
  ).toBe(true);
  await page.getByRole("button", { name: /^Save & run/ }).click();
  await openCommandDestination(page, "lines");
  await expect(page.getByTestId("route-item-route-001")).toBeVisible();
  const route = (await runtimeSnapshot(page)).state.transit.routes[0]!;
  const selectRoute = page.getByRole("button", {
    name: `Select ${route.name}`,
  });
  if ((await selectRoute.getAttribute("aria-pressed")) !== "true")
    await selectRoute.click();
  await expect
    .poll(async () => (await runtimeSnapshot(page)).ui.selectedRouteId)
    .toBe(route.id);
  await expectRoadsideStopAnchors(page, stops, route.color);
  await page.getByTestId(`route-color-${route.id}-#2e9e5b`).click();
  await expect
    .poll(
      async () => (await runtimeSnapshot(page)).state.transit.routes[0]?.color,
    )
    .toBe("#2e9e5b");
  await expectRoadsideStopAnchors(page, stops, "#2e9e5b");

  await page.getByRole("button", { name: "New Metro" }).click();
  for (const station of stations) await clickMapTile(canvas, station);
  await expect(page.getByTestId("route-draft")).toBeVisible();
  await page.getByRole("button", { name: /^Save & run/ }).click();
  await openCommandDestination(page, "lines");
  const metro = (await runtimeSnapshot(page)).state.transit.metroLines[0]!;
  const selectMetro = page.getByRole("button", {
    name: `Select ${metro.name}`,
  });
  if ((await selectMetro.getAttribute("aria-pressed")) !== "true")
    await selectMetro.click();
  await page.getByTestId(`route-color-${metro.id}-#2e9e5b`).click();
  await expect
    .poll(
      async () =>
        (await runtimeSnapshot(page)).state.transit.metroLines[0]?.color,
    )
    .toBe("#2e9e5b");
  // The paused initial train occupies the first station.
  await expectMetroBadge(page, [46, 158, 91], 35, stations[1]);
}
