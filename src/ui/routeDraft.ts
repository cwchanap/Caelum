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

export type RouteDraftInteractionOperation =
  | "selectWaypoint"
  | "removeWaypoint"
  | "moveWaypoint";

export interface RouteDraftInteractionError {
  code: "invalidRouteDraftInteraction";
  context: {
    operation: RouteDraftInteractionOperation;
    waypointIndex: number | null;
    delta?: -1 | 1;
  };
}

export type RouteDraftError = GameplayRejection | RouteDraftInteractionError;

type SaveableRouteDraft = RouteDraft & {
  mode: Exclude<TransitMode, "walk">;
  preview: RoutePreviewResponse;
};

export function canSaveRouteDraft(
  draft: RouteDraft,
): draft is SaveableRouteDraft {
  const preview = draft.preview;
  return (
    draft.mode !== "walk" &&
    preview !== null &&
    preview.generation === draft.generation &&
    preview.rejection === null &&
    preview.legs.length > 0 &&
    (draft.source.kind === "edit" ||
      preview.legs.every((leg) => leg.status === "connected")) &&
    preview.affordable
  );
}

function samePoint(left: Point, right: Point): boolean {
  return left.x === right.x && left.y === right.y;
}

export function resolveStopAtTile(
  state: GameState,
  point: Point,
): Stop | undefined {
  const exactStop = state.transit.stops.find(
    (candidate) =>
      candidate.status === "present" && samePoint(candidate.position, point),
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
    : state.transit.stops.find(
        (stop) =>
          stop.id === building.transitNodeId && stop.status === "present",
      );
}

export function resolveStationAtTile(
  state: GameState,
  point: Point,
): Station | undefined {
  const exactStation = state.transit.stations.find(
    (candidate) =>
      candidate.status === "present" && samePoint(candidate.position, point),
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
        (station) =>
          station.id === building.transitNodeId && station.status === "present",
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

export function editDraft(
  input: {
    routeId: string;
    expectedRevision: number;
    mode: TransitMode;
    pattern: ServicePattern;
    waypointIds: string[];
  },
  instanceId: number,
): RouteDraft {
  return {
    instanceId,
    source: {
      kind: "edit",
      routeId: input.routeId,
      expectedRevision: input.expectedRevision,
    },
    mode: input.mode,
    pattern: input.pattern,
    waypointIds: [...input.waypointIds],
    selectedIndex: null,
    interaction: "append",
    generation: 0,
    previewPending: true,
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

export function selectWaypoint(
  draft: RouteDraft,
  index: number | null,
  interaction: RouteDraft["interaction"],
): RouteDraft {
  if (index !== null && (index < 0 || index >= draft.waypointIds.length)) {
    return draft;
  }
  return { ...draft, selectedIndex: index, interaction };
}

export function applyNodeClick(draft: RouteDraft, nodeId: string): RouteDraft {
  const index = draft.selectedIndex;
  if (index === null || draft.interaction === "append") {
    return changed(draft, [...draft.waypointIds, nodeId]);
  }
  if (index < 0 || index >= draft.waypointIds.length) {
    return draft;
  }
  if (draft.interaction === "insertAfter") {
    const waypointIds = [...draft.waypointIds];
    waypointIds.splice(index + 1, 0, nodeId);
    return changed(draft, waypointIds, { selectedIndex: index + 1 });
  }
  const waypointIds = [...draft.waypointIds];
  waypointIds[index] = nodeId;
  return changed(draft, waypointIds, { selectedIndex: index });
}

export function removeWaypoint(draft: RouteDraft): RouteDraft {
  const index = draft.selectedIndex;
  if (index === null || index < 0 || index >= draft.waypointIds.length) {
    return draft;
  }
  const waypointIds = draft.waypointIds.filter(
    (_, candidate) => candidate !== index,
  );
  return changed(draft, waypointIds, {
    selectedIndex:
      waypointIds.length === 0 ? null : Math.min(index, waypointIds.length - 1),
  });
}

export function moveWaypoint(draft: RouteDraft, delta: -1 | 1): RouteDraft {
  const index = draft.selectedIndex;
  const target = index === null ? -1 : index + delta;
  if (
    index === null ||
    index < 0 ||
    target < 0 ||
    target >= draft.waypointIds.length
  ) {
    return draft;
  }
  const waypointIds = [...draft.waypointIds];
  [waypointIds[index], waypointIds[target]] = [
    waypointIds[target],
    waypointIds[index],
  ];
  return changed(draft, waypointIds, { selectedIndex: target });
}

export function reverseRoute(draft: RouteDraft): RouteDraft {
  if (draft.waypointIds.length < 2) return draft;
  const waypointIds =
    draft.pattern === "loop"
      ? [draft.waypointIds[0], ...draft.waypointIds.slice(1).reverse()]
      : [...draft.waypointIds].reverse();
  return changed(draft, waypointIds, { selectedIndex: null });
}

export function setPattern(
  draft: RouteDraft,
  pattern: ServicePattern,
): RouteDraft {
  return pattern === draft.pattern
    ? draft
    : changed(draft, draft.waypointIds, { pattern });
}

function nodeMatchesMode(node: Stop | Station, mode: TransitMode): boolean {
  if (mode === "walk") return false;
  return mode === "bus" ? "kind" in node : !("kind" in node);
}

export function applyRouteNodeClick(
  draft: RouteDraft,
  node: Stop | Station,
): RouteDraftClickResult {
  if (node.status !== "present") {
    return {
      draft,
      rejection: {
        code: "missingRouteNode",
        context: { nodeId: node.id, affectedRouteIds: [] },
      },
    };
  }
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
    draft: applyNodeClick(draft, node.id),
    rejection: null,
  };
}

export function cancelDraftRoute(ui: UiState): UiState {
  if (ui.routeDraft === null && ui.routePreviewError === null) return ui;
  return {
    ...ui,
    routeDraft: null,
    routePreviewError: null,
    routePreviewHostError: null,
  };
}
