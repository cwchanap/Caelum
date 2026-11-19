import type { BuildingType } from "../../domain/types";
import { BUILDING_CATALOG } from "../../domain/catalog/buildings";
import tree01Url from "../../assets/sunny-diorama/trees/tree-01.webp";
import tree02Url from "../../assets/sunny-diorama/trees/tree-02.webp";
import tree03Url from "../../assets/sunny-diorama/trees/tree-03.webp";
import busTerminalUrl from "../../assets/sunny-diorama/buildings/busTerminal.webp";
import smallHouseUrl from "../../assets/sunny-diorama/buildings/smallHouse.webp";
import largeHouseUrl from "../../assets/sunny-diorama/buildings/largeHouse.webp";
import supermarketUrl from "../../assets/sunny-diorama/buildings/supermarket.webp";
import cinemaUrl from "../../assets/sunny-diorama/buildings/cinema.webp";
import factoryUrl from "../../assets/sunny-diorama/buildings/factory.webp";
import warehouseUrl from "../../assets/sunny-diorama/buildings/warehouse.webp";
import officeTowerUrl from "../../assets/sunny-diorama/buildings/officeTower.webp";
import businessParkUrl from "../../assets/sunny-diorama/buildings/businessPark.webp";
import clinicUrl from "../../assets/sunny-diorama/buildings/clinic.webp";
import schoolUrl from "../../assets/sunny-diorama/buildings/school.webp";
import parkPlazaUrl from "../../assets/sunny-diorama/buildings/parkPlaza.webp";

/** Building types with a sprite; busStop/metroStation keep their procedural
 *  transitBatch markers and never get a texture layer or instance. */
export type SpriteBuildingType = Exclude<
  BuildingType,
  "busStop" | "metroStation"
>;

/** Vite asset URLs; the record keys are type-checked against BuildingType so
 *  adding a sprite-bearing building cannot forget its WebP. */
export const BUILDING_SPRITE_URLS: Record<SpriteBuildingType, string> = {
  busTerminal: busTerminalUrl,
  smallHouse: smallHouseUrl,
  largeHouse: largeHouseUrl,
  supermarket: supermarketUrl,
  cinema: cinemaUrl,
  factory: factoryUrl,
  warehouse: warehouseUrl,
  officeTower: officeTowerUrl,
  businessPark: businessParkUrl,
  clinic: clinicUrl,
  school: schoolUrl,
  parkPlaza: parkPlazaUrl,
};

/** Stable tree-variant order; layers 0-2 of the atlas array. */
export const TREE_SPRITE_URLS = [tree01Url, tree02Url, tree03Url] as const;

export const SPRITE_TEXELS_PER_TILE = 192;
export const SPRITE_ATLAS_WIDTH = 576;
export const SPRITE_ATLAS_HEIGHT = 384;
// 8 mip levels cover 192x192 trees down to 1x1 texel (level 7), preventing
// aliasing when Fit-scale on large maps shrinks trees below 12 px.
export const SPRITE_MIP_LEVEL_COUNT = 8;
export const TREE_SPRITE_LAYER_BASE = 0;
export const SPRITE_LAYER_COUNT =
  TREE_SPRITE_URLS.length + Object.keys(BUILDING_SPRITE_URLS).length;

/** Resolves a [0, 1) hash fraction to a tree layer index in the atlas. */
export function treeSpriteLayer(fraction: number): number {
  const index = Math.min(
    TREE_SPRITE_URLS.length - 1,
    Math.max(0, Math.floor(fraction * TREE_SPRITE_URLS.length)),
  );
  return TREE_SPRITE_LAYER_BASE + index;
}

/** Stable 15-layer order: tree variants first, then buildings in catalog
 *  order (the Record literal above mirrors BUILDING_CATALOG's key order). */
export const BUILDING_SPRITE_LAYERS = Object.fromEntries(
  Object.keys(BUILDING_SPRITE_URLS).map((type, index) => [
    type,
    TREE_SPRITE_URLS.length + index,
  ]),
) as Record<SpriteBuildingType, number>;

/** The sprite layer of a sprite-bearing building type, or undefined for
 *  busStop/metroStation (which keep only their procedural markers). */
export function spriteLayerFor(type: BuildingType): number | undefined {
  return (BUILDING_SPRITE_LAYERS as Record<string, number | undefined>)[type];
}

interface SpriteLayerSource {
  name: string;
  url: string;
  width: number;
  height: number;
}

const SPRITE_LAYER_SOURCES: readonly SpriteLayerSource[] = [
  ...TREE_SPRITE_URLS.map((url, index) => ({
    name: `tree-0${index + 1}`,
    url,
    width: SPRITE_TEXELS_PER_TILE,
    height: SPRITE_TEXELS_PER_TILE,
  })),
  ...(
    Object.entries(BUILDING_SPRITE_URLS) as [SpriteBuildingType, string][]
  ).map(([type, url]) => ({
    name: type,
    url,
    width: BUILDING_CATALOG[type].width * SPRITE_TEXELS_PER_TILE,
    height: BUILDING_CATALOG[type].height * SPRITE_TEXELS_PER_TILE,
  })),
];

// GPUTextureUsage.TEXTURE_BINDING | COPY_DST | RENDER_ATTACHMENT. @webgpu/types
// is ambient types only, so numeric flags are used (matching renderer.ts) to
// stay Node/jsdom-safe without runtime GPUTextureUsage globals.
const SPRITE_TEXTURE_USAGE = 0x04 | 0x02 | 0x10;

async function decodeSpriteImage(
  source: SpriteLayerSource,
): Promise<HTMLImageElement> {
  const image = new Image();
  image.src = source.url;
  try {
    await image.decode();
  } catch (error) {
    // A raw decode rejection (DOMException) names no asset; wrap it so a bad
    // shipped file is identifiable at startup.
    throw new Error(
      `sprite "${source.name}" failed to decode: ${String(error)}`,
      { cause: error },
    );
  }
  const expectedWidth = source.width;
  const expectedHeight = source.height;
  if (
    image.naturalWidth !== expectedWidth ||
    image.naturalHeight !== expectedHeight
  ) {
    throw new Error(
      `sprite "${source.name}" expected ${expectedWidth}x${expectedHeight}, ` +
        `got ${image.naturalWidth}x${image.naturalHeight}`,
    );
  }
  return image;
}

/**
 * Decodes all fifteen shipped sprites and validates their dimensions (one
 * texel per footprint tile, 192x192 trees), returning them in the stable
 * 15-layer order (trees, then buildings in catalog order). Throws on any
 * bad load, so callers fail startup loudly instead of drawing a broken
 * atlas. The Canvas2D fallback consumes the same validated images directly.
 */
export async function loadSpriteImages(): Promise<readonly HTMLImageElement[]> {
  return Promise.all(
    SPRITE_LAYER_SOURCES.map((source) => decodeSpriteImage(source)),
  );
}

/**
 * Uploads the already-decoded, dimension-validated images from
 * `loadSpriteImages()` into a single layered `texture_2d_array`: one
 * transparent 576x384 layer per sprite, five CPU mips generated through one
 * fixed-size 2D canvas (never resized — resizing resets image smoothing).
 * Each mip uploads only its source-sized top-left crop; the rest of every
 * layer stays transparent. Synchronous: decoding happened in
 * `loadSpriteImages()`. Destroys the partially created texture and
 * rethrows on any upload failure, so callers fail startup loudly instead
 * of drawing a broken atlas.
 */
export function createSpriteAtlasTexture(
  device: GPUDevice,
  images: readonly HTMLImageElement[],
): GPUTexture {
  const canvas = document.createElement("canvas");
  canvas.width = SPRITE_ATLAS_WIDTH;
  canvas.height = SPRITE_ATLAS_HEIGHT;
  const context = canvas.getContext("2d");
  if (context === null) {
    throw new Error("sprite atlas upload requires a 2d canvas context");
  }
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";

  const texture = device.createTexture({
    size: [SPRITE_ATLAS_WIDTH, SPRITE_ATLAS_HEIGHT, SPRITE_LAYER_COUNT],
    format: "rgba8unorm",
    dimension: "2d",
    textureBindingViewDimension: "2d-array",
    mipLevelCount: SPRITE_MIP_LEVEL_COUNT,
    usage: SPRITE_TEXTURE_USAGE,
  });

  try {
    SPRITE_LAYER_SOURCES.forEach((source, layer) => {
      const image = images[layer]!;
      for (let level = 0; level < SPRITE_MIP_LEVEL_COUNT; level += 1) {
        const width = Math.max(1, source.width >> level);
        const height = Math.max(1, source.height >> level);
        context.clearRect(0, 0, SPRITE_ATLAS_WIDTH, SPRITE_ATLAS_HEIGHT);
        context.drawImage(image, 0, 0, width, height);
        device.queue.copyExternalImageToTexture(
          { source: canvas },
          {
            texture,
            mipLevel: level,
            origin: { z: layer },
            colorSpace: "srgb",
            premultipliedAlpha: true,
          },
          { width, height },
        );
      }
    });
  } catch (error) {
    texture.destroy();
    throw error;
  }

  return texture;
}
