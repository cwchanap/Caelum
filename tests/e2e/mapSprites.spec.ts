import { expect, test } from "@playwright/test";
import { tileSize } from "../../src/render/boardTransform";
import {
  sampleFrameTransform,
  sampleTilePixels,
  settleLayout,
  type PixelProbe,
} from "./helpers";
import {
  expectRotatedLargeHouseFootprint,
  shadowedGrassRgb,
} from "./spriteFootprint";
import {
  buildTransitSpriteScene,
  expectFitBadgePixels,
  expectTransitSpriteScene,
} from "./transitSpriteScene";
import {
  expectMixedCorridorCuePixels,
  expectSharedCuePixels,
} from "./transitCues";

test("all six shipped transit sprites decode to nonempty 192px art and white masks", async ({
  page,
}) => {
  await page.goto("/");
  const assets = await page.evaluate(async () => {
    const names = [
      "bus-stop",
      "bus-stop-ring",
      "metro-station",
      "metro-station-ring",
      "track-straight",
      "track-corner",
    ];
    return Promise.all(
      names.map(async (name) => {
        const image = new Image();
        image.src = `/src/assets/sunny-diorama/markers/${name}.webp`;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);
        const data = context.getImageData(
          0,
          0,
          canvas.width,
          canvas.height,
        ).data;
        let opaque = 0;
        let transparent = 0;
        let nonWhite = 0;
        const colors = new Set<string>();
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] === 0) transparent += 1;
          if (data[i + 3]! >= 250) {
            opaque += 1;
            colors.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
            if (data[i] !== 255 || data[i + 1] !== 255 || data[i + 2] !== 255)
              nonWhite += 1;
          }
        }
        return {
          name,
          width: image.naturalWidth,
          height: image.naturalHeight,
          opaque,
          transparent,
          colors: colors.size,
          nonWhite,
          rimSamples: [
            [167, 96],
            [170, 96],
            [146, 146],
            [157, 157],
            [160, 160],
          ].map(([x, y]) => data[(y! * canvas.width + x!) * 4 + 3]),
        };
      }),
    );
  });
  for (const asset of assets) {
    expect([asset.width, asset.height], asset.name).toEqual([192, 192]);
    expect(asset.opaque, asset.name).toBeGreaterThan(100);
    expect(asset.transparent, asset.name).toBeGreaterThan(100);
    if (asset.name.endsWith("-ring"))
      expect(asset.nonWhite, asset.name).toBe(0);
    else expect(asset.colors, asset.name).toBeGreaterThan(2);
  }
  expect(
    assets.find((asset) => asset.name === "bus-stop-ring")!.rimSamples,
  ).toEqual([255, 0, 250, 0, 0]);
  expect(
    assets.find((asset) => asset.name === "metro-station-ring")!.rimSamples,
  ).toEqual([255, 0, 0, 255, 0]);
});

test("transit art joins rails and colors physical badges on WebGPU", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await expectTransitSpriteScene(page, "webgpu");
});

test("shared transit cue colors stay visible on WebGPU", async ({ page }) => {
  test.setTimeout(240_000);
  await expectSharedCuePixels(page, "webgpu");
});

test("mixed-corridor transit cue colors stay visible on WebGPU", async ({
  page,
}) => {
  test.setTimeout(150_000);
  await expectMixedCorridorCuePixels(page, "webgpu");
});

test("transit Fit badge structure holds at DPR 2", async ({ browser }) => {
  test.setTimeout(180_000);
  const context = await browser.newContext({
    baseURL: "http://127.0.0.1:5281",
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  try {
    await buildTransitSpriteScene(page, "webgpu");
    await page.setViewportSize({ width: 1440, height: 900 });
    await settleLayout(page);
    await page.getByTestId("map-zoom-fit").click();
    await settleLayout(page);
    const fit = await sampleFrameTransform(page);
    expect(fit).not.toBeNull();
    expect(fit!.dpr).toBeCloseTo(2, 5);
    const fitTileCssPx = fit!.scale * tileSize;
    expect(fitTileCssPx).toBeGreaterThan(13.5);
    expect(fitTileCssPx).toBeLessThan(14);
    await expectFitBadgePixels(page, fitTileCssPx);
  } finally {
    await context.close();
  }
});

test("rotated largeHouse sprite stays in its 2x3 footprint with transparent insets", async ({
  page,
}) => {
  // Renderer-neutral footprint oracle (placement, zoom, opaque/transparent
  // known-color probes) is shared with the Canvas2D fallback spec; the proof
  // below this point is GPU-only: it replicates the atlas mip-1 pass and the
  // premultiplied-alpha texel composite, which Canvas2D never computes.
  await expectRotatedLargeHouseFootprint(page);

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
  const candidates: {
    du: number;
    dv: number;
    error: number;
    matched: number;
  }[] = [];
  for (const du of [-2, 0, 2]) {
    for (const dv of [-2, 0, 2]) {
      let error = 0;
      let matched = 0;
      opaquePixels.forEach((pixel, index) => {
        const sample = opaqueSamples[index]!;
        const mip = mipAt(pixel.texelU + du, pixel.texelV + dv);
        if (mip[3]! < 250) return;
        matched += 1;
        for (let channel = 0; channel < 3; channel += 1) {
          error += Math.abs(sample![channel]! - mip[channel]!);
        }
      });
      candidates.push({ du, dv, error, matched });
    }
  }
  // Rank by per-matched-pixel residual: skipped texels (shifted sample lands
  // on alpha < 250) must not count as zero-error matches or a wrong offset
  // can win on uncounted zeros. Software Vulkan quantizes the filtered texel
  // ~±1/channel above hardware — a correctly aligned winner reads ~3/pixel
  // on CI vs ~1.5 on a real GPU — while a misaligned offset scores ~30+.
  const residual = (candidate: (typeof candidates)[number]) =>
    candidate.matched === 0 ? Infinity : candidate.error / candidate.matched;
  candidates.sort((a, b) => residual(a) - residual(b));
  expect(
    residual(candidates[0]!),
    "opaque calibration residual per pixel",
  ).toBeLessThan(8);
  // The best offset must win decisively, not by noise.
  expect(residual(candidates[1]!) - residual(candidates[0]!)).toBeGreaterThan(
    3,
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
