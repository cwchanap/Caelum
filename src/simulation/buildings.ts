import type {
  BuildingRotation,
  BuildingType,
  Point,
} from "../domain/types";

export type BuildingEffect =
  | "busStop"
  | "busTerminal"
  | "metroStation"
  | "housing";

export interface BuildingDefinition {
  type: BuildingType;
  label: string;
  width: number;
  height: number;
  cost: number;
  effect: BuildingEffect;
  citizenCount?: number;
}

export const BUILDING_CATALOG: Record<BuildingType, BuildingDefinition> = {
  busStop: {
    type: "busStop",
    label: "Bus Stop",
    width: 1,
    height: 1,
    cost: 2_000,
    effect: "busStop",
  },
  busTerminal: {
    type: "busTerminal",
    label: "Bus Terminal",
    width: 3,
    height: 2,
    cost: 12_000,
    effect: "busTerminal",
  },
  metroStation: {
    type: "metroStation",
    label: "Metro Station",
    width: 1,
    height: 1,
    cost: 25_000,
    effect: "metroStation",
  },
  smallHouse: {
    type: "smallHouse",
    label: "Small House",
    width: 2,
    height: 1,
    cost: 4_000,
    effect: "housing",
    citizenCount: 4,
  },
  largeHouse: {
    type: "largeHouse",
    label: "Large House",
    width: 3,
    height: 2,
    cost: 10_000,
    effect: "housing",
    citizenCount: 10,
  },
};

export function getRotatedFootprintSize(
  type: BuildingType,
  rotation: BuildingRotation,
): { width: number; height: number } {
  const definition = BUILDING_CATALOG[type];
  return rotation === 90 || rotation === 270
    ? { width: definition.height, height: definition.width }
    : { width: definition.width, height: definition.height };
}

export function getBuildingFootprint(
  type: BuildingType,
  origin: Point,
  rotation: BuildingRotation,
): Point[] {
  const size = getRotatedFootprintSize(type, rotation);
  const points: Point[] = [];

  for (let y = 0; y < size.height; y += 1) {
    for (let x = 0; x < size.width; x += 1) {
      points.push({ x: origin.x + x, y: origin.y + y });
    }
  }

  return points;
}
