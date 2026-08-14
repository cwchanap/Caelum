import type { AreaKind, BuildingRotation, BuildingType, Point } from "../types";

export type BuildingEffect =
  | "busStop"
  | "busTerminal"
  | "metroStation"
  | "housing"
  | "destination";

export interface BuildingDefinition {
  type: BuildingType;
  label: string;
  width: number;
  height: number;
  cost: number;
  effect: BuildingEffect;
  allowedArea?: AreaKind;
  residentCapacity: number;
  jobCapacity: number;
}

export const BUILDING_CATALOG: Record<BuildingType, BuildingDefinition> = {
  busStop: {
    type: "busStop",
    label: "Bus Stop",
    width: 1,
    height: 1,
    cost: 2_000,
    effect: "busStop",
    residentCapacity: 0,
    jobCapacity: 0,
  },
  busTerminal: {
    type: "busTerminal",
    label: "Bus Terminal",
    width: 3,
    height: 2,
    cost: 12_000,
    effect: "busTerminal",
    residentCapacity: 0,
    jobCapacity: 0,
  },
  metroStation: {
    type: "metroStation",
    label: "Metro Station",
    width: 1,
    height: 1,
    cost: 25_000,
    effect: "metroStation",
    residentCapacity: 0,
    jobCapacity: 0,
  },
  smallHouse: {
    type: "smallHouse",
    label: "Small House",
    width: 2,
    height: 1,
    cost: 4_000,
    effect: "housing",
    allowedArea: "residential",
    residentCapacity: 4,
    jobCapacity: 0,
  },
  largeHouse: {
    type: "largeHouse",
    label: "Large House",
    width: 3,
    height: 2,
    cost: 10_000,
    effect: "housing",
    allowedArea: "residential",
    residentCapacity: 10,
    jobCapacity: 0,
  },
  supermarket: {
    type: "supermarket",
    label: "Supermarket",
    width: 2,
    height: 2,
    cost: 8_000,
    effect: "destination",
    allowedArea: "commercial",
    residentCapacity: 0,
    jobCapacity: 4,
  },
  cinema: {
    type: "cinema",
    label: "Cinema",
    width: 3,
    height: 2,
    cost: 14_000,
    effect: "destination",
    allowedArea: "commercial",
    residentCapacity: 0,
    jobCapacity: 6,
  },
  factory: {
    type: "factory",
    label: "Factory",
    width: 3,
    height: 2,
    cost: 16_000,
    effect: "destination",
    allowedArea: "industrial",
    residentCapacity: 0,
    jobCapacity: 6,
  },
  warehouse: {
    type: "warehouse",
    label: "Warehouse",
    width: 3,
    height: 2,
    cost: 12_000,
    effect: "destination",
    allowedArea: "industrial",
    residentCapacity: 0,
    jobCapacity: 6,
  },
  officeTower: {
    type: "officeTower",
    label: "Office Tower",
    width: 2,
    height: 2,
    cost: 18_000,
    effect: "destination",
    allowedArea: "office",
    residentCapacity: 0,
    jobCapacity: 4,
  },
  businessPark: {
    type: "businessPark",
    label: "Business Park",
    width: 3,
    height: 2,
    cost: 15_000,
    effect: "destination",
    allowedArea: "office",
    residentCapacity: 0,
    jobCapacity: 6,
  },
  clinic: {
    type: "clinic",
    label: "Clinic",
    width: 2,
    height: 2,
    cost: 12_000,
    effect: "destination",
    allowedArea: "civic",
    residentCapacity: 0,
    jobCapacity: 4,
  },
  school: {
    type: "school",
    label: "School",
    width: 3,
    height: 2,
    cost: 18_000,
    effect: "destination",
    allowedArea: "civic",
    residentCapacity: 0,
    jobCapacity: 6,
  },
  parkPlaza: {
    type: "parkPlaza",
    label: "Park Plaza",
    width: 2,
    height: 2,
    cost: 6_000,
    effect: "destination",
    allowedArea: "park",
    residentCapacity: 0,
    jobCapacity: 4,
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
