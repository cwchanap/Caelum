import type { BuildingType } from "../../domain/types";

/** Building types with a structural sprite; transit nodes use marker layers. */
export type SpriteBuildingType = Exclude<
  BuildingType,
  "busStop" | "metroStation"
>;

export const SPRITE_TEXELS_PER_TILE = 192;
export const SPRITE_ATLAS_WIDTH = 576;
export const SPRITE_ATLAS_HEIGHT = 384;
// Eight mips cover 192px sprites down to one texel.
export const SPRITE_MIP_LEVEL_COUNT = 8;
export const TREE_SPRITE_LAYER_BASE = 0;
export const TREE_SPRITE_COUNT = 3;

/** Stable layer IDs are independent of catalog and asset-record ordering. */
export const BUILDING_SPRITE_LAYERS: Record<SpriteBuildingType, number> = {
  busTerminal: 3,
  smallHouse: 4,
  largeHouse: 5,
  supermarket: 6,
  cinema: 7,
  factory: 8,
  warehouse: 9,
  officeTower: 10,
  businessPark: 11,
  clinic: 12,
  school: 13,
  parkPlaza: 14,
};

/** The loader indexes its URLs in layer order, not URL-record order. */
export const BUILDING_SPRITE_TYPES = (
  Object.entries(BUILDING_SPRITE_LAYERS) as [SpriteBuildingType, number][]
)
  .sort(([, a], [, b]) => a - b)
  .map(([type]) => type);

export const TRANSIT_SPRITE_TYPES = [
  "busStop",
  "busStopRing",
  "metroStation",
  "metroStationRing",
  "trackStraight",
  "trackCorner",
] as const;
export type TransitSpriteType = (typeof TRANSIT_SPRITE_TYPES)[number];

export const SPRITE_LAYER_COUNT =
  TREE_SPRITE_COUNT +
  BUILDING_SPRITE_TYPES.length +
  TRANSIT_SPRITE_TYPES.length;

/** Resolves a [0, 1) hash fraction to a tree layer index in the atlas. */
export function treeSpriteLayer(fraction: number): number {
  const index = Math.min(
    TREE_SPRITE_COUNT - 1,
    Math.max(0, Math.floor(fraction * TREE_SPRITE_COUNT)),
  );
  return TREE_SPRITE_LAYER_BASE + index;
}

export const TRANSIT_SPRITE_LAYERS = Object.fromEntries(
  TRANSIT_SPRITE_TYPES.map((type, index) => [
    type,
    TREE_SPRITE_COUNT + BUILDING_SPRITE_TYPES.length + index,
  ]),
) as Record<TransitSpriteType, number>;

/** The sprite layer of a sprite-bearing building, or undefined for transit nodes. */
export function spriteLayerFor(type: BuildingType): number | undefined {
  return (BUILDING_SPRITE_LAYERS as Record<string, number | undefined>)[type];
}
