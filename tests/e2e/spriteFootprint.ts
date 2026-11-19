import { expect, type Page } from "@playwright/test";
import { maxZoom } from "../../src/render/boardTransform";
import {
  clickMapTile,
  createDefaultCity,
  dragMapTiles,
  runtimeSnapshot,
  sampleTilePixels,
  selectBuildLeaf,
  settleLayout,
  type PixelProbe,
} from "./helpers";

/** Deterministic expectations for flat grass fills, mirroring the private
 *  hash and shades in src/render/webgpu/mapBatch.ts. The pixel oracle needs
 *  exact ground colors under/around a sprite; recomputing the fill here keeps
 *  that independent of render internals. */
function tileHash(x: number, y: number, salt: number): number {
  let h =
    (Math.imul(x, 0x27d4eb2d) ^
      Math.imul(y, 0x165667b1) ^
      Math.imul(salt + 1, 0x9e3779b9)) >>>
    0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = (h ^ (h >>> 13)) >>> 0;
  return h / 4294967296;
}

const GRASS_SHADES = [0.96, 0.985, 1.01, 1.035] as const;
const EMPTY_FILL = [195, 217, 154] as const; // colors.empty #c3d99a
const BUILDING_SHADOW = [74, 56, 34, 0.25] as const;

export function grassRgb(tile: {
  x: number;
  y: number;
}): [number, number, number] {
  const shade =
    GRASS_SHADES[
      Math.floor(tileHash(tile.x, tile.y, 0) * GRASS_SHADES.length) %
        GRASS_SHADES.length
    ];
  return [EMPTY_FILL[0] * shade, EMPTY_FILL[1] * shade, EMPTY_FILL[2] * shade];
}

/** One sprite-building footprint shadow at rgba(74,56,34,0.25) over grass. */
export function shadowedGrassRgb(tile: {
  x: number;
  y: number;
}): [number, number, number] {
  const grass = grassRgb(tile);
  const [r, g, b, alpha] = BUILDING_SHADOW;
  return [
    grass[0] * (1 - alpha) + r * alpha,
    grass[1] * (1 - alpha) + g * alpha,
    grass[2] * (1 - alpha) + b * alpha,
  ];
}

/**
 * Renderer-neutral rotated-sprite footprint oracle (HPA-1144): places a
 * 90°-rotated largeHouse on a freshly zoned 2x3 Small Town lot, zooms to the
 * camera clamp and asserts the known-color footprint probes — opaque
 * terracotta at every occupied tile center, pure grass just outside every
 * rotated footprint edge, and the transparent sprite insets showing the
 * underlying shadowed ground. Runs identically on the WebGPU renderer and the
 * Canvas2D fallback; the GPU-only mip calibration and premultiplied-alpha
 * band proof stay in mapSprites.spec.ts.
 */
export async function expectRotatedLargeHouseFootprint(
  page: Page,
): Promise<void> {
  await createDefaultCity(page, "Sprite Pixel Smoke", "smallTown");
  const canvas = page.locator("canvas[data-runtime-canvas='true']");

  // largeHouse is a residential building, so paint the residential lot it
  // needs first: exactly the 2x3 tiles the rotated footprint will occupy.
  await selectBuildLeaf(page, "zones", "residential");
  await dragMapTiles(page, canvas, { x: 4, y: 13 }, { x: 5, y: 15 });

  // Arm a native 3x2 building and rotate it one quarter turn: the occupied
  // footprint becomes 2 wide x 3 tall.
  await selectBuildLeaf(page, "buildings", "largeHouse");
  await page.keyboard.press("r");
  expect((await runtimeSnapshot(page)).ui.buildingRotation).toBe(90);
  await clickMapTile(canvas, { x: 4, y: 13 });

  const placed = await runtimeSnapshot(page);
  const building = placed.state.buildings.find(
    (candidate) => candidate.type === "largeHouse",
  );
  expect(building).toBeDefined();
  expect(building!.rotation).toBe(90);
  expect(building!.origin).toEqual({ x: 4, y: 13 });
  expect(
    new Set(building!.occupiedTiles.map((tile) => `${tile.x},${tile.y}`)),
  ).toEqual(new Set(["4,13", "5,13", "4,14", "5,14", "4,15", "5,15"]));

  // Park the pointer over the top HUD: the canvas receives pointerleave and
  // no hover/ghost strokes overlay the probe area.
  await page.mouse.move(2, 2);

  // Zoom in until the camera clamp: 96 CSS px per tile, the detail view.
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
  await settleLayout(page);
  // Center the max-zoom view on the footprint (tile center x 5, y 14.5);
  // the camera clamp keeps every probe inside the viewport.
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
    runtime?.adjustCamera?.({ kind: "centerOn", point: { x: 5, y: 14.5 } });
  });
  await settleLayout(page);
  const snapshot = await runtimeSnapshot(page);
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  const expectedMaxZoom = maxZoom(
    { width: box!.width, height: box!.height },
    {
      width: snapshot.state.map.width,
      height: snapshot.state.map.height,
    },
  );
  expect(snapshot.camera?.zoom).toBeCloseTo(expectedMaxZoom, 9);

  // World-pixel geometry of the placed footprint: x 128..192, y 416..512.
  // The sprite keeps a 13-texels transparent border (~2.2 world px); the
  // inset probes sit in that band and must show the shadowed ground beneath.
  // Interior tile centers are deep inside the opaque roof art. The probes
  // just outside the footprint prove nothing leaks past the rotated extents;
  // all probe tiles were chosen tree-free and away from roads, areas and the
  // +3/+3 shadow edges.
  const probes: PixelProbe[] = [
    // Opaque interior: the six occupied tile centers.
    { tile: { x: 4, y: 13 }, dx: 0, dy: 0 },
    { tile: { x: 5, y: 13 }, dx: 0, dy: 0 },
    { tile: { x: 4, y: 14 }, dx: 0, dy: 0 },
    { tile: { x: 5, y: 14 }, dx: 0, dy: 0 },
    { tile: { x: 4, y: 15 }, dx: 0, dy: 0 },
    { tile: { x: 5, y: 15 }, dx: 0, dy: 0 },
    // Ground just outside each footprint edge.
    { tile: { x: 3, y: 14 }, dx: 8, dy: 0 }, // west of the quad
    { tile: { x: 6, y: 14 }, dx: -8, dy: 0 }, // east of the quad
    { tile: { x: 4, y: 12 }, dx: 10, dy: 8 }, // north of the quad
    { tile: { x: 4, y: 16 }, dx: 10, dy: -8 }, // south of the quad
    // Transparent sprite insets over the shadowed ground, bottom band.
    { tile: { x: 5, y: 15 }, dx: -10, dy: 14.9 },
    { tile: { x: 5, y: 15 }, dx: -6, dy: 14.9 },
  ];
  const samples = await sampleTilePixels(page, probes);
  expect(samples).toHaveLength(probes.length);

  const near = (
    sample: [number, number, number] | null,
    rgb: readonly number[],
    tolerance = 8,
  ) =>
    sample !== null &&
    Math.abs(sample[0] - rgb[0]) <= tolerance &&
    Math.abs(sample[1] - rgb[1]) <= tolerance &&
    Math.abs(sample[2] - rgb[2]) <= tolerance;

  // (b) Opaque extent: terracotta roof (~rgb(197,85,61)) at every occupied
  // tile center, and pure grass just outside every edge — the drawn sprite
  // matches the expected 2x3 footprint, not the native 3x2.
  const inside = samples.slice(0, 6);
  for (const sample of inside) {
    expect(sample).not.toBeNull();
    expect(sample![0] - sample![1]).toBeGreaterThan(60);
  }
  const outsideGrounds: Array<[number, number, number]> = [
    grassRgb({ x: 3, y: 14 }),
    grassRgb({ x: 6, y: 14 }),
    grassRgb({ x: 4, y: 12 }),
    grassRgb({ x: 4, y: 16 }),
  ];
  outsideGrounds.forEach((ground, index) => {
    expect(near(samples[6 + index], ground)).toBe(true);
  });

  // (a) Premultiplied-alpha proof: the known transparent sprite inset shows
  // the underlying shadowed grass, not a dark or tinted halo, and both inset
  // probes read identically from the same flat region.
  const insetGround = shadowedGrassRgb({ x: 5, y: 15 });
  expect(near(samples[10], insetGround)).toBe(true);
  expect(near(samples[11], insetGround)).toBe(true);
  const firstInset = samples[10]!;
  const secondInset = samples[11]!;
  expect(
    near(secondInset, [...firstInset] as [number, number, number], 4),
  ).toBe(true);
}
