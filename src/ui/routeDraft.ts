import type {
  GameState,
  GameplayRejection,
  Point,
  ServicePattern,
  Station,
  Stop,
  TransitMode,
} from "../domain/types";
import type { RoutePreviewResponse } from "../runtime/backend/types";
import type { UiState } from "./uiState";

export interface RouteDraft {
  instanceId: number;
  source:
    | { kind: "create" }
    | { kind: "edit"; routeId: string; expectedRevision: number };
  mode: TransitMode;
  pattern: ServicePattern;
  waypointIds: string[];
  selectedIndex: number | null;
  interaction: "append" | "insertAfter" | "replace";
  generation: number;
  previewPending: boolean;
  preview: RoutePreviewResponse | null;
}

export interface RouteDraftClickResult {
  draft: RouteDraft;
  rejection: GameplayRejection | null;
}

function samePoint(left: Point, right: Point): boolean {
  return left.x === right.x && left.y === right.y;
}

export function resolveStopAtTile(
  state: GameState,
  point: Point,
): Stop | undefined {
  const exactStop = state.transit.stops.find((candidate) =>
    samePoint(candidate.position, point),
  );
  if (exactStop !== undefined) return exactStop;

  const building = state.buildings.find(
    (candidate) =>
      (candidate.type === "busStop" || candidate.type === "busTerminal") &&
      candidate.transitNodeId !== undefined &&
      candidate.occupiedTiles.some((tile) => samePoint(tile, point)),
  );
  return building?.transitNodeId === undefined
    ? undefined
    : state.transit.stops.find((stop) => stop.id === building.transitNodeId);
}

export function resolveStationAtTile(
  state: GameState,
  point: Point,
): Station | undefined {
  const exactStation = state.transit.stations.find((candidate) =>
    samePoint(candidate.position, point),
  );
  if (exactStation !== undefined) return exactStation;

  const building = state.buildings.find(
    (candidate) =>
      candidate.type === "metroStation" &&
      candidate.transitNodeId !== undefined &&
      candidate.occupiedTiles.some((tile) => samePoint(tile, point)),
  );
  return building?.transitNodeId === undefined
    ? undefined
    : state.transit.stations.find(
        (station) => station.id === building.transitNodeId,
      );
}

export function createDraft(mode: TransitMode, instanceId: number): RouteDraft {
  return {
    instanceId,
    source: { kind: "create" },
    mode,
    pattern: "loop",
    waypointIds: [],
    selectedIndex: null,
    interaction: "append",
    generation: 0,
    previewPending: false,
    preview: null,
  };
}

function changed(
  draft: RouteDraft,
  waypointIds: string[],
  patch: Partial<
    Pick<RouteDraft, "pattern" | "selectedIndex" | "interaction">
  > = {},
): RouteDraft {
  return {
    ...draft,
    ...patch,
    waypointIds,
    generation: draft.generation + 1,
    previewPending: true,
    preview: null,
  };
}

export function appendWaypoint(
  draft: RouteDraft,
  waypointId: string,
): RouteDraft {
  return changed(draft, [...draft.waypointIds, waypointId]);
}

export function removeWaypoint(draft: RouteDraft, index: number): RouteDraft {
  if (index < 0 || index >= draft.waypointIds.length) return draft;
  return changed(
    draft,
    draft.waypointIds.filter((_, candidate) => candidate !== index),
    {
      selectedIndex: draft.selectedIndex === index ? null : draft.selectedIndex,
    },
  );
}

function nodeMatchesMode(node: Stop | Station, mode: TransitMode): boolean {
  if (mode === "walk") return false;
  return mode === "bus" ? "kind" in node : !("kind" in node);
}

export function applyRouteNodeClick(
  draft: RouteDraft,
  node: Stop | Station,
): RouteDraftClickResult {
  if (!nodeMatchesMode(node, draft.mode)) {
    return {
      draft,
      rejection: {
        code: "incompatibleRouteNode",
        context: { nodeId: node.id, affectedRouteIds: [] },
      },
    };
  }
  return {
    draft: appendWaypoint(draft, node.id),
    rejection: null,
  };
}

export function cancelDraftRoute(ui: UiState): UiState {
  if (ui.routeDraft === null && ui.routePreviewError === null) return ui;
  return { ...ui, routeDraft: null, routePreviewError: null };
}
