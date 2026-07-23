import type {
  AreaKind,
  BuildingRotation,
  BuildingType,
  Overlay,
  Point,
  RoadPreset,
  RoundaboutSize,
  Tool,
} from "../domain/types";
import type { BuildCategoryId } from "../domain/catalog/buildMenu";
import type { RoadMutationPreviewResponse } from "../runtime/backend/types";
import type { RouteDraft, RouteDraftError } from "./routeDraft";

export type RouteDraftCheckpoint = Pick<
  RouteDraft,
  | "waypointIds"
  | "pattern"
  | "selectedIndex"
  | "interaction"
  | "mode"
  | "source"
>;

export interface RouteDraftHistory {
  past: RouteDraftCheckpoint[];
  future: RouteDraftCheckpoint[];
}

export type RouteDraftNotice = {
  kind: "alreadyOnRoute";
  waypointId: string;
};

// The five categories with a permanent chip in the bottom bar.
export type PrimaryHudCategory =
  | "build"
  | "area"
  | "routes"
  | "manage"
  | "data"
  | "brief";

// "inspect" is auto-opened by clicking a map node and has no permanent chip,
// so it is legibly the odd one out of the primary set.
export type HudCategory = PrimaryHudCategory | "inspect";

/** Tools that drive placement via a press-drag gesture rather than a click. */
export type DragTool = "road" | "track" | "remove" | "area";

/** An in-progress road/track/remove/area drag. Atomic by construction —
 *  `tool`, `start`, and `current` are always present together (and the `area`
 *  variant additionally carries its `area: AreaKind`), so the illegal states
 *  a three-field model allows (a start with no current tile, an area drag
 *  without an area kind, or a drag lingering after switching to a non-drag
 *  tool) are unrepresentable. Consumers collapse to a single `drag === null`
 *  check. */
export type DragGesture =
  | {
      tool: "road" | "track" | "remove";
      start: Point;
      current: Point;
    }
  | {
      tool: "area";
      area: AreaKind;
      start: Point;
      current: Point;
    };

export interface UiState {
  activeTool: Tool;
  /** Road build style for the road tool's drag gesture. */
  roadPreset: RoadPreset;
  /** Fixed authoritative stamp requested by the click-only roundabout tool. */
  roundaboutSize: RoundaboutSize;
  /** In-progress drag gesture, or null when idle. */
  drag: DragGesture | null;
  activeOverlay: Overlay | null;
  selectedId: string | null;
  selectedNodeKind: "stop" | "station" | null;
  selectedBuilding: BuildingType | null;
  selectedArea: AreaKind | null;
  /** Open Build drill-down category, or null when showing the category root. */
  buildCategory: BuildCategoryId | null;
  buildingRotation: BuildingRotation;
  /** Cursor tile while idle (badge / hover highlight / building preview). */
  hoverTile: Point | null;
  routeDraft: RouteDraft | null;
  routeDraftHistory: RouteDraftHistory;
  routeDraftNotice: RouteDraftNotice | null;
  routePreviewError: RouteDraftError | null;
  /** Recoverable host failure for the current route preview request. */
  routePreviewHostError: string | null;
  roadPreviewGeneration: number;
  roadMutationPreview: RoadMutationPreviewResponse | null;
  /** Recoverable host failure for the current road preview request. */
  roadMutationPreviewError: string | null;
  selectedRouteId: string | null;
  routeFailureFocus: { routeId: string; legIndex: number } | null;
  activeHudCategory: HudCategory | null;
}

export function createUiState(): UiState {
  return {
    activeTool: "inspect",
    roadPreset: "twoWay",
    roundaboutSize: "compact2x2",
    drag: null,
    activeOverlay: null,
    selectedId: null,
    selectedNodeKind: null,
    selectedBuilding: null,
    selectedArea: null,
    buildCategory: null,
    buildingRotation: 0,
    hoverTile: null,
    routeDraft: null,
    routeDraftHistory: { past: [], future: [] },
    routeDraftNotice: null,
    routePreviewError: null,
    routePreviewHostError: null,
    roadPreviewGeneration: 0,
    roadMutationPreview: null,
    roadMutationPreviewError: null,
    selectedRouteId: null,
    routeFailureFocus: null,
    activeHudCategory: "brief",
  };
}
