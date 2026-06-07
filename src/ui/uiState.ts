import type {
  BuildingRotation,
  BuildingType,
  Overlay,
  Point,
  Tool,
} from "../domain/types";

export type HudCategory =
  | "build"
  | "routes"
  | "manage"
  | "data"
  | "brief"
  | "inspect";

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
