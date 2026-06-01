import type {
  BuildingRotation,
  BuildingType,
  Overlay,
  Point,
  Tool,
} from "../domain/types";

export interface UiState {
  activeTool: Tool;
  activeOverlay: Overlay | null;
  selectedId: string | null;
  selectedBuilding: BuildingType | null;
  buildingRotation: BuildingRotation;
  hoverTile: Point | null;
  draftStopIds: string[];
  draftStationIds: string[];
  controlTowerOpen: boolean;
}

export function createUiState(): UiState {
  return {
    activeTool: "inspect",
    activeOverlay: null,
    selectedId: null,
    selectedBuilding: null,
    buildingRotation: 0,
    hoverTile: null,
    draftStopIds: [],
    draftStationIds: [],
    controlTowerOpen: true,
  };
}
