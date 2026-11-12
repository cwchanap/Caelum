import type {
  AreaKind,
  BuildingType,
  RoadPreset,
  RoundaboutSize,
  Tool,
} from "../types";
import { AREA_KINDS, AREA_LABELS } from "./areas";
import { BUILDING_CATALOG } from "./buildings";

export type BuildGroup = "roads" | "transit" | "zones" | "buildings";

export type BuildItemAction =
  | { kind: "road"; roadPreset: RoadPreset }
  | { kind: "roundabout"; size: RoundaboutSize }
  | { kind: "track" }
  | { kind: "tool"; tool: Extract<Tool, "busStop" | "metroStation"> }
  | { kind: "area"; area: AreaKind }
  | { kind: "building"; building: BuildingType };

export interface BuildMenuItem {
  id: string;
  label: string;
  description: string;
  /** Display-only nominal hint; Rust and the cursor preview stay authoritative. */
  cost: BuildItemCost;
  action: BuildItemAction;
}

export type BuildItemCost =
  | { amount: number; unit: "each" | "perTile" }
  | "free";

export interface BuildMenuSection {
  id: string;
  label: string | null;
  items: BuildMenuItem[];
}

export interface BuildMenuGroup {
  id: BuildGroup;
  label: string;
  sections: BuildMenuSection[];
  hint?: string;
}

const buildingDescriptions: Record<BuildingType, string> = {
  busStop: "Buses pick up and drop off passengers here.",
  busTerminal: "Bus interchange with room for several routes.",
  metroStation: "Metro platform served by running track lines.",
  smallHouse: "Compact starter home.",
  largeHouse: "Family home with room to grow.",
  supermarket: "Neighbourhood shop.",
  cinema: "Entertainment venue.",
  factory: "Industrial workplace with early and late shifts.",
  warehouse: "Freight depot.",
  officeTower: "Downtown office tower.",
  businessPark: "Low-rise office park.",
  clinic: "Civic health centre.",
  school: "Civic school.",
  parkPlaza: "Green public plaza.",
};

const buildingCost = (building: BuildingType): BuildItemCost => ({
  amount: BUILDING_CATALOG[building].cost,
  unit: "each",
});

const buildingItem = (building: BuildingType): BuildMenuItem => ({
  id: building,
  label: BUILDING_CATALOG[building].label,
  description: buildingDescriptions[building],
  cost: buildingCost(building),
  action: { kind: "building", building },
});

const transitBuildingItem = (
  tool: Extract<Tool, "busStop" | "metroStation">,
): BuildMenuItem => ({
  id: tool,
  label: BUILDING_CATALOG[tool].label,
  description: buildingDescriptions[tool],
  cost: buildingCost(tool),
  action: { kind: "tool", tool },
});

const areaSections: BuildMenuSection[] = AREA_KINDS.map((area) => ({
  id: area,
  label: AREA_LABELS[area],
  items: Object.values(BUILDING_CATALOG)
    .filter((definition) => definition.allowedArea === area)
    .map((definition) => buildingItem(definition.type)),
}));

const zoneDescriptions: Record<AreaKind, string> = {
  residential: "Homes grow here once a running line serves the land.",
  commercial: "Shops and supermarkets grow on served land.",
  industrial: "Factories and warehouses grow on served land.",
  office: "Offices grow on served land.",
  civic: "Clinics and schools grow on served land.",
  park: "Park land; park plazas build here.",
};

export const BUILD_GROUPS: BuildMenuGroup[] = [
  {
    id: "roads",
    label: "Roads",
    sections: [
      {
        id: "roads",
        label: null,
        items: [
          {
            id: "road-twoWay",
            label: "1-Lane",
            description: "Two-way street with one lane each way.",
            cost: { amount: 100, unit: "perTile" },
            action: { kind: "road", roadPreset: "twoWay" },
          },
          {
            id: "road-oneWay",
            label: "1-Lane One-Way",
            description: "One-way street; traffic follows the drag direction.",
            cost: { amount: 100, unit: "perTile" },
            action: { kind: "road", roadPreset: "oneWay" },
          },
          {
            id: "road-dual",
            label: "2-Lane",
            description:
              "Divided road; up to $200 per stroke tile when both lanes need building.",
            cost: { amount: 200, unit: "perTile" },
            action: { kind: "road", roadPreset: "dualBidirectional" },
          },
          {
            id: "compactRoundabout",
            label: "Compact Roundabout",
            description: "Compact 2 × 2 roundabout for tight junctions.",
            cost: { amount: 1_000, unit: "each" },
            action: { kind: "roundabout", size: "compact2x2" },
          },
          {
            id: "standardRoundabout",
            label: "Standard Roundabout",
            description: "Standard 3 × 3 roundabout for busier crossings.",
            cost: { amount: 2_000, unit: "each" },
            action: { kind: "roundabout", size: "standard3x3" },
          },
        ],
      },
    ],
  },
  {
    id: "transit",
    label: "Transit",
    sections: [
      {
        id: "transit",
        label: null,
        items: [
          {
            id: "track",
            label: "Track",
            description: "Metro track tile; trains follow the drawn path.",
            cost: { amount: 500, unit: "perTile" },
            action: { kind: "track" },
          },
          transitBuildingItem("busStop"),
          buildingItem("busTerminal"),
          transitBuildingItem("metroStation"),
        ],
      },
    ],
  },
  {
    id: "zones",
    label: "Zones",
    sections: [
      {
        id: "zones",
        label: null,
        items: AREA_KINDS.map((area) => ({
          id: area,
          label: AREA_LABELS[area],
          description: zoneDescriptions[area],
          cost: "free" as const,
          action: { kind: "area" as const, area },
        })),
      },
    ],
    hint: "Residential, commercial, office and industrial land near a stop or station on a running line builds up on its own every six hours. Homes grow while there are spare jobs, and workplaces while there are spare workers.",
  },
  { id: "buildings", label: "Buildings", sections: areaSections },
];

export function findBuildGroup(id: BuildGroup | null): BuildMenuGroup | null {
  return id === null
    ? null
    : (BUILD_GROUPS.find((group) => group.id === id) ?? null);
}
