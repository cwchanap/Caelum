import type { BuildingType, RoadPreset } from "../types";
import { BUILDING_CATALOG } from "./buildings";

export type BuildCategoryId =
  | "road"
  | "rail"
  | "bus"
  | "metro"
  | "residential"
  | "commercial"
  | "industrial"
  | "office"
  | "civic"
  | "park";

/** What committing a Build leaf does. Roads carry a preset; track and buildings
 *  do not. The panel dispatches these to the matching runtime setter. */
export type BuildItemAction =
  | { kind: "road"; roadPreset: RoadPreset }
  | { kind: "track" }
  | { kind: "building"; building: BuildingType };

export interface BuildMenuItem {
  /** Stable id, unique within a category (used as the render key + data attr). */
  id: string;
  label: string;
  action: BuildItemAction;
}

export interface BuildMenuCategory {
  id: BuildCategoryId;
  label: string;
  items: BuildMenuItem[];
}

function buildingItem(building: BuildingType): BuildMenuItem {
  return {
    id: building,
    label: BUILDING_CATALOG[building].label,
    action: { kind: "building", building },
  };
}

export const BUILD_MENU: BuildMenuCategory[] = [
  {
    id: "road",
    label: "Road",
    items: [
      {
        id: "road-twoWay",
        label: "1-Lane",
        action: { kind: "road", roadPreset: "twoWay" },
      },
      {
        id: "road-oneWay",
        label: "1-Lane One-Way",
        action: { kind: "road", roadPreset: "oneWay" },
      },
      {
        id: "road-dual",
        label: "2-Lane",
        action: { kind: "road", roadPreset: "dualBidirectional" },
      },
    ],
  },
  {
    id: "rail",
    label: "Rail",
    items: [{ id: "track", label: "Track", action: { kind: "track" } }],
  },
  {
    id: "bus",
    label: "Bus",
    items: [buildingItem("busStop"), buildingItem("busTerminal")],
  },
  { id: "metro", label: "Metro", items: [buildingItem("metroStation")] },
  {
    id: "residential",
    label: "Residential",
    items: [buildingItem("smallHouse"), buildingItem("largeHouse")],
  },
  {
    id: "commercial",
    label: "Commercial",
    items: [buildingItem("supermarket"), buildingItem("cinema")],
  },
  {
    id: "industrial",
    label: "Industrial",
    items: [buildingItem("factory"), buildingItem("warehouse")],
  },
  {
    id: "office",
    label: "Office",
    items: [buildingItem("officeTower"), buildingItem("businessPark")],
  },
  {
    id: "civic",
    label: "Civic",
    items: [buildingItem("clinic"), buildingItem("school")],
  },
  { id: "park", label: "Park", items: [buildingItem("parkPlaza")] },
];

export function findBuildCategory(
  id: BuildCategoryId | null,
): BuildMenuCategory | null {
  return id === null ? null : (BUILD_MENU.find((c) => c.id === id) ?? null);
}
