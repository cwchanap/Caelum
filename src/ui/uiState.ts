import type {
  BuildingRotation,
  BuildingType,
  Overlay,
  Point,
  Tool,
} from "../domain/types";

// The five categories with a permanent chip in the bottom bar.
export type PrimaryHudCategory =
  | "build"
  | "routes"
  | "manage"
  | "data"
  | "brief";

// "inspect" is auto-opened by clicking a map node and has no permanent chip,
// so it is legibly the odd one out of the primary set.
export type HudCategory = PrimaryHudCategory | "inspect";

export interface UiState {
  activeTool: Tool;
  activeOverlay: Overlay | null;
  selectedId: string | null;
  selectedNodeKind: "stop" | "station" | null;
  selectedBuilding: BuildingType | null;
  buildingRotation: BuildingRotation;
  hoverTile: Point | null;
  draftStopIds: string[];
  draftStationIds: string[];
  selectedRouteId: string | null;
  activeHudCategory: HudCategory | null;
}

export function createUiState(): UiState {
  return {
    activeTool: "inspect",
    activeOverlay: null,
    selectedId: null,
    selectedNodeKind: null,
    selectedBuilding: null,
    buildingRotation: 0,
    hoverTile: null,
    draftStopIds: [],
    draftStationIds: [],
    selectedRouteId: null,
    activeHudCategory: "brief",
  };
}
