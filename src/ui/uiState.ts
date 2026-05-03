import type { Overlay, Point, Tool } from "../domain/types";

export interface UiState {
  activeTool: Tool;
  activeOverlay: Overlay | null;
  selectedId: string | null;
  hoverTile: Point | null;
  draftStopIds: string[];
  draftStationIds: string[];
}

export function createUiState(): UiState {
  return {
    activeTool: "inspect",
    activeOverlay: null,
    selectedId: null,
    hoverTile: null,
    draftStopIds: [],
    draftStationIds: []
  };
}
