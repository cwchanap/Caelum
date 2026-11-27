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
import busStopUrl from "../../assets/sunny-diorama/markers/bus-stop.webp";
import busStopRingUrl from "../../assets/sunny-diorama/markers/bus-stop-ring.webp";
import metroStationUrl from "../../assets/sunny-diorama/markers/metro-station.webp";
import metroStationRingUrl from "../../assets/sunny-diorama/markers/metro-station-ring.webp";
import trackStraightUrl from "../../assets/sunny-diorama/markers/track-straight.webp";
import trackCornerUrl from "../../assets/sunny-diorama/markers/track-corner.webp";
import {
  BUILDING_SPRITE_TYPES,
  SPRITE_ATLAS_HEIGHT,
  SPRITE_ATLAS_WIDTH,
  SPRITE_LAYER_COUNT,
  SPRITE_MIP_LEVEL_COUNT,
  SPRITE_TEXELS_PER_TILE,
  TRANSIT_SPRITE_LAYERS,
  TRANSIT_SPRITE_TYPES,
  type SpriteBuildingType,
  type TransitSpriteType,
  TREE_SPRITE_COUNT,
} from "./spriteLayers";

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
export const TREE_SPRITE_URLS = [
  tree01Url,
  tree02Url,
  tree03Url,
] as const satisfies { readonly length: typeof TREE_SPRITE_COUNT };

export const TRANSIT_SPRITE_URLS = {
  busStop: busStopUrl,
  busStopRing: busStopRingUrl,
  metroStation: metroStationUrl,
  metroStationRing: metroStationRingUrl,
  trackStraight: trackStraightUrl,
  trackCorner: trackCornerUrl,
} as const satisfies Record<TransitSpriteType, string>;

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
  ...BUILDING_SPRITE_TYPES.map((type) => ({
    name: type,
    url: BUILDING_SPRITE_URLS[type],
    width: BUILDING_CATALOG[type].width * SPRITE_TEXELS_PER_TILE,
    height: BUILDING_CATALOG[type].height * SPRITE_TEXELS_PER_TILE,
  })),
  ...TRANSIT_SPRITE_TYPES.map((name) => ({
    name,
    url: TRANSIT_SPRITE_URLS[name],
    width: SPRITE_TEXELS_PER_TILE,
    height: SPRITE_TEXELS_PER_TILE,
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
 * Decodes all shipped sprites and validates their dimensions (one
 * texel per footprint tile, 192x192 trees), returning them in the stable
 * layer order (trees, buildings in catalog order, then transit art). Throws on any
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
 * transparent 576x384 layer per sprite, eight CPU mips generated through one
 * fixed-size 2D canvas (never resized — resizing resets image smoothing).
 * Each mip uploads its source-sized top-left crop, with one extruded gutter
 * texel at the straight rail's east edge. Synchronous: decoding happened in
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
        const railGutter =
          layer === TRANSIT_SPRITE_LAYERS.trackStraight ? 1 : 0;
        if (railGutter) {
          // Linear sampling must not blend a rail's opaque end with padding.
          context.drawImage(
            canvas,
            width - 1,
            0,
            1,
            height,
            width,
            0,
            1,
            height,
          );
        }
        device.queue.copyExternalImageToTexture(
          { source: canvas },
          {
            texture,
            mipLevel: level,
            origin: { z: layer },
            colorSpace: "srgb",
            premultipliedAlpha: true,
          },
          { width: width + railGutter, height },
        );
      }
    });
  } catch (error) {
    texture.destroy();
    throw error;
  }

  return texture;
}
