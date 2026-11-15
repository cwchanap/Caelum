import { expect, test } from "@playwright/test";
import { maxZoom, tileSize } from "../../src/render/boardTransform";
import {
  clickMapTile,
  createDefaultCity,
  dragMapTiles,
  runtimeSnapshot,
  sampleFrameTransform,
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

function grassRgb(tile: { x: number; y: number }): [number, number, number] {
  const shade =
    GRASS_SHADES[
      Math.floor(tileHash(tile.x, tile.y, 0) * GRASS_SHADES.length) %
        GRASS_SHADES.length
    ];
  return [EMPTY_FILL[0] * shade, EMPTY_FILL[1] * shade, EMPTY_FILL[2] * shade];
}

/** One sprite-building footprint shadow at rgba(74,56,34,0.25) over grass. */
function shadowedGrassRgb(tile: {
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

test("rotated largeHouse sprite stays in its 2x3 footprint with transparent insets", async ({
  page,
}) => {
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

  // (c) Premultiplied-alpha proof on a partially transparent sample: a fully
  // transparent inset (a) proves nothing leaks through, an opaque interior
  // (b) proves the extents — only a partially transparent texel exercises
  // the blend itself, against the exact expected composite.
  const transform = await sampleFrameTransform(page);
  expect(transform).not.toBeNull();

  // Sprite-world ↔ art-texel mapping for the 90° rotation (world offsets
  // from the footprint center, matching the shader projection and the
  // known-opaque tile centers): texel_u = 288 + 6·dy, texel_v = 192 − 6·dx.
  const center = { x: 5 * tileSize, y: 14.5 * tileSize };
  const texelsPerWorldPx = 192 / tileSize;
  // Proven ground under the band: shadowed grass of tiles (4,15)/(5,15),
  // inside the +3/+3 footprint shadow. Tree-canopy shadows cannot reach it:
  // surrounding tree-capable tiles' shadows stop at x ≤ 129 or ≥ 197 and
  // y ≤ 481 or ≥ 517, so the band below is clean.
  const worldBounds = { minX: 140, maxX: 191.5, minY: 490, maxY: 510 };

  // Max zoom (scale 3) still minifies the art: it ships 6 texels per world
  // px, so the sampler reads mip 1, and the capture grid lands exactly on
  // mip-1 texel centers (texel coordinates quantize to odd integers). Each
  // capture pixel therefore shows exactly one filtered mip-1 texel.
  interface BandPixel {
    sampleWorld: { x: number; y: number };
    texelU: number;
    texelV: number;
  }
  const bandPixels = new Map<string, BandPixel>();
  for (let uc = 444.5; uc <= 562.5; uc += 1) {
    for (let vc = 1.5; vc <= 309.5; vc += 1) {
      const world = {
        x: center.x + (192 - vc) / texelsPerWorldPx,
        y: center.y + (uc - 288) / texelsPerWorldPx,
      };
      if (
        world.x < worldBounds.minX ||
        world.x > worldBounds.maxX ||
        world.y < worldBounds.minY ||
        world.y > worldBounds.maxY
      ) {
        continue;
      }
      // The GPU shades the capture pixel containing this point; compute the
      // exact sample location (pixel center) and its texel coordinates.
      const px = Math.round(
        (transform!.offsetX + world.x * transform!.scale) * transform!.dpr,
      );
      const py = Math.round(
        (transform!.offsetY + world.y * transform!.scale) * transform!.dpr,
      );
      const sampleWorld = {
        x:
          ((px + 0.5) / transform!.dpr - transform!.offsetX) / transform!.scale,
        y:
          ((py + 0.5) / transform!.dpr - transform!.offsetY) / transform!.scale,
      };
      // The grid quantizes texel coordinates to exact integers; round off
      // the float residue before the mip lookup.
      const texelU = Math.round(
        288 + (sampleWorld.y - center.y) * texelsPerWorldPx,
      );
      const texelV = Math.round(
        192 - (sampleWorld.x - center.x) * texelsPerWorldPx,
      );
      bandPixels.set(`${px},${py}`, { sampleWorld, texelU, texelV });
    }
  }
  expect(bandPixels.size).toBeGreaterThan(0);

  // Replicate spriteAtlas.ts's mip-1 pass (one 2D-canvas draw at half size,
  // high-quality smoothing, same HTMLImageElement decode) so the expected
  // color is the very filtered texel the GPU samples.
  const mipData: { width: number; height: number; data: number[] } =
    await page.evaluate(async () => {
      const image = new Image();
      image.src = "/src/assets/sunny-diorama/buildings/largeHouse.webp";
      await image.decode();
      const canvas = new OffscreenCanvas(
        image.naturalWidth >> 1,
        image.naturalHeight >> 1,
      );
      const context = canvas.getContext("2d");
      if (context === null) throw new Error("2D context unavailable");
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const image1 = context.getImageData(0, 0, canvas.width, canvas.height);
      return {
        width: image1.width,
        height: image1.height,
        data: Array.from(image1.data),
      };
    });
  const mipAt = (texelU: number, texelV: number): number[] => {
    const index = ((texelV >> 1) * mipData.width + (texelU >> 1)) * 4;
    return [
      mipData.data[index]!,
      mipData.data[index + 1]!,
      mipData.data[index + 2]!,
      mipData.data[index + 3]!,
    ];
  };

  const bandList = [...bandPixels.values()];
  const probeFor = (pixel: BandPixel): PixelProbe => {
    const tile = {
      x: Math.floor(pixel.sampleWorld.x / tileSize),
      y: Math.floor(pixel.sampleWorld.y / tileSize),
    };
    return {
      tile,
      dx: pixel.sampleWorld.x - (tile.x + 0.5) * tileSize,
      dy: pixel.sampleWorld.y - (tile.y + 0.5) * tileSize,
    };
  };

  // The derived texel origin carries a constant ±2-texel offset in the
  // rotated quad. Calibrate it over near-opaque band pixels only: an opaque
  // texel composites as plain rgb (alpha ≈ 1), so this pins the position
  // mapping without involving the premultiplied claim.
  const opaquePixels = bandList.filter(
    (pixel) => mipAt(pixel.texelU, pixel.texelV)[3]! >= 250,
  );
  expect(opaquePixels.length).toBeGreaterThan(20);
  const opaqueSamples = await sampleTilePixels(
    page,
    opaquePixels.map(probeFor),
  );
  const candidates: { du: number; dv: number; error: number }[] = [];
  for (const du of [-2, 0, 2]) {
    for (const dv of [-2, 0, 2]) {
      let error = 0;
      opaquePixels.forEach((pixel, index) => {
        const sample = opaqueSamples[index]!;
        const mip = mipAt(pixel.texelU + du, pixel.texelV + dv);
        if (mip[3]! < 250) return;
        for (let channel = 0; channel < 3; channel += 1) {
          error += Math.abs(sample![channel]! - mip[channel]!);
        }
      });
      candidates.push({ du, dv, error });
    }
  }
  candidates.sort((a, b) => a.error - b.error);
  expect(
    candidates[0]!.error / opaquePixels.length,
    "opaque calibration residual per pixel",
  ).toBeLessThan(2);
  // The best offset must win decisively, not by noise.
  expect(candidates[1]!.error - candidates[0]!.error).toBeGreaterThan(
    3 * opaquePixels.length,
  );
  const { du, dv } = candidates[0]!;

  // Now the premultiplied-alpha proof. Pick the band pixel whose calibrated
  // mip texel is most substantially partially transparent; the known texel
  // (straight rgb and alpha straight from the shipped art, filtered exactly
  // like the loader's mip pass) composited over the known shadowed ground
  // must equal the rendered pixel. A straight-alpha upload would add
  // unmultiplied art rgb (≈ rgb·(1−a)) and double-multiplied alpha would
  // scale the composite by a — both far beyond the tolerance.
  let chosen: { pixel: BandPixel; mip: number[]; alpha: number } | null = null;
  for (const pixel of bandList) {
    const mip = mipAt(pixel.texelU + du, pixel.texelV + dv);
    const alpha = mip[3]! / 255;
    if (alpha <= 0.3 || alpha >= 0.95) continue;
    if (
      chosen === null ||
      Math.abs(alpha - 0.6) < Math.abs(chosen.alpha - 0.6)
    ) {
      chosen = { pixel, mip, alpha };
    }
  }
  expect(
    chosen,
    "partially transparent mip texel in the sprite's bottom band",
  ).not.toBeNull();
  expect(chosen!.alpha).toBeGreaterThan(0.3);
  expect(chosen!.alpha).toBeLessThan(0.95);

  const groundTile = {
    x: Math.floor(chosen!.pixel.sampleWorld.x / tileSize),
    y: Math.floor(chosen!.pixel.sampleWorld.y / tileSize),
  };
  const ground = shadowedGrassRgb(groundTile);
  const texelAlpha = chosen!.mip[3]! / 255;
  const expectedComposite: [number, number, number] = [
    chosen!.mip[0]! * texelAlpha + ground[0] * (1 - texelAlpha),
    chosen!.mip[1]! * texelAlpha + ground[1] * (1 - texelAlpha),
    chosen!.mip[2]! * texelAlpha + ground[2] * (1 - texelAlpha),
  ];
  const partialProbe = probeFor(chosen!.pixel);
  const partialSamples = await sampleTilePixels(page, [partialProbe]);
  const partial = partialSamples[0];
  expect(partial).not.toBeNull();
  for (let channel = 0; channel < 3; channel += 1) {
    expect(
      Math.abs(partial![channel] - expectedComposite[channel]),
      `premultiplied composite channel ${channel} at +${partialProbe.dx.toFixed(2)}/+${partialProbe.dy.toFixed(2)}`,
    ).toBeLessThanOrEqual(4);
  }
});
