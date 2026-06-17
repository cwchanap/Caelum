import type {
  BuildingRotation,
  BuildingType,
  Overlay,
  Point,
  RoadPreset,
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

/** Tools that drive placement via a press-drag gesture rather than a click. */
export type DragTool = "road" | "track" | "remove";

/** An in-progress road/track/remove drag. Atomic by construction — `tool`,
 *  `start`, and `current` are always present together, so the illegal states a
 *  three-field model allows (a start with no current tile, or a drag lingering
 *  after switching to a non-drag tool) are unrepresentable. Consumers collapse
 *  to a single `drag === null` check. */
export interface DragGesture {
  tool: DragTool;
  start: Point;
  current: Point;
}

export interface UiState {
  activeTool: Tool;
  /** Road build style for the road tool's drag gesture. */
  roadPreset: RoadPreset;
  /** In-progress drag gesture, or null when idle. */
  drag: DragGesture | null;
  activeOverlay: Overlay | null;
  selectedId: string | null;
  selectedNodeKind: "stop" | "station" | null;
  selectedBuilding: BuildingType | null;
  buildingRotation: BuildingRotation;
  /** Cursor tile while idle (badge / hover highlight / building preview). */
  hoverTile: Point | null;
  draftStopIds: string[];
  draftStationIds: string[];
  /** Tile path per consecutive draft pair; paths[i] connects ids[i] -> ids[i+1].
   *  Invariant: paths.length === max(0, ids.length - 1). */
  draftStopPaths: Point[][];
  draftStationPaths: Point[][];
  selectedRouteId: string | null;
  activeHudCategory: HudCategory | null;
}

export function createUiState(): UiState {
  return {
    activeTool: "inspect",
    roadPreset: "twoWay",
    drag: null,
    activeOverlay: null,
    selectedId: null,
    selectedNodeKind: null,
    selectedBuilding: null,
    buildingRotation: 0,
    hoverTile: null,
    draftStopIds: [],
    draftStationIds: [],
    draftStopPaths: [],
    draftStationPaths: [],
    selectedRouteId: null,
    activeHudCategory: "brief",
  };
}
