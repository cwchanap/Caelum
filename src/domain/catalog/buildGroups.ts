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
  action: BuildItemAction;
}

export interface BuildMenuSection {
  id: string;
  label: string | null;
  items: BuildMenuItem[];
}

export interface BuildMenuGroup {
  id: BuildGroup;
  label: string;
  sections: BuildMenuSection[];
}

const buildingItem = (building: BuildingType): BuildMenuItem => ({
  id: building,
  label: BUILDING_CATALOG[building].label,
  action: { kind: "building", building },
});

const areaSections: BuildMenuSection[] = AREA_KINDS.map((area) => ({
  id: area,
  label: AREA_LABELS[area],
  items: Object.values(BUILDING_CATALOG)
    .filter((definition) => definition.allowedArea === area)
    .map((definition) => buildingItem(definition.type)),
}));

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
          {
            id: "compactRoundabout",
            label: "Compact Roundabout",
            action: { kind: "roundabout", size: "compact2x2" },
          },
          {
            id: "standardRoundabout",
            label: "Standard Roundabout",
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
          { id: "track", label: "Track", action: { kind: "track" } },
          {
            id: "busStop",
            label: "Bus Stop",
            action: { kind: "tool", tool: "busStop" },
          },
          buildingItem("busTerminal"),
          {
            id: "metroStation",
            label: "Metro Station",
            action: { kind: "tool", tool: "metroStation" },
          },
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
          action: { kind: "area" as const, area },
        })),
      },
    ],
  },
  { id: "buildings", label: "Buildings", sections: areaSections },
];

export function findBuildGroup(id: BuildGroup | null): BuildMenuGroup | null {
  return id === null
    ? null
    : (BUILD_GROUPS.find((group) => group.id === id) ?? null);
}
