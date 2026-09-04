import type { GameState, Point, Station, Stop } from "../domain/types";
import { isPresentTransitNode } from "../runtime/presentationView";
import {
  applyRouteNodeClick,
  cancelDraftRoute,
  isTransientRouteClickError,
  resolveStationAtTile,
  resolveStopAtTile,
  type RouteDraft,
} from "./routeDraft";
import type { UiState } from "./uiState";

export type ResolvedNode =
  | { kind: "stop"; node: Stop }
  | { kind: "station"; node: Station };

export function draftHandleIndexAtPoint(
  draft: RouteDraft,
  state: GameState,
  point: Point,
): number | null {
  const index = draft.waypointIds.findIndex((id) => {
    const node =
      state.transit.stops.find((candidate) => candidate.id === id) ??
      state.transit.stations.find((candidate) => candidate.id === id);
    return node?.position.x === point.x && node?.position.y === point.y;
  });
  return index >= 0 ? index : null;
}

export function resolveNodesAtTile(
  state: GameState,
  point: Point,
): ResolvedNode[] {
  const nodes: ResolvedNode[] = [];
  const stop = resolveStopAtTile(state, point);
  if (stop !== undefined && isPresentTransitNode(stop)) {
    nodes.push({ kind: "stop", node: stop });
  }
  const station = resolveStationAtTile(state, point);
  if (station !== undefined && isPresentTransitNode(station)) {
    nodes.push({ kind: "station", node: station });
  }
  return nodes;
}

export function resolveNodeAtTile(
  state: GameState,
  point: Point,
  preferredKind?: "stop" | "station",
): ResolvedNode | null {
  if (preferredKind === "station") {
    const station = resolveStationAtTile(state, point);
    if (station !== undefined) {
      return { kind: "station", node: station };
    }
    const stop = resolveStopAtTile(state, point);
    if (stop !== undefined) {
      return { kind: "stop", node: stop };
    }
    return null;
  }

  const stop = resolveStopAtTile(state, point);
  if (stop !== undefined) {
    return { kind: "stop", node: stop };
  }

  const station = resolveStationAtTile(state, point);
  if (station !== undefined) {
    return { kind: "station", node: station };
  }

  return null;
}

export function applyUiTileClick(
  state: GameState,
  ui: UiState,
  point: Point,
): { state: GameState; ui: UiState } {
  if (
    (ui.activeTool === "busRoute" || ui.activeTool === "metroLine") &&
    ui.routeDraft !== null
  ) {
    const preferredKind =
      ui.routeDraft.mode === "bus" ? ("stop" as const) : ("station" as const);
    const resolved = resolveNodeAtTile(state, point, preferredKind);
    if (resolved === null) return { state, ui };
    const result = applyRouteNodeClick(ui.routeDraft, resolved.node);
    const routeDraftNotice = result.notice ?? null;
    // Generation-stable selection updates preserve persistent preview/host
    // rejections (matching `commitRouteDraft`): a selection-only click does
    // not request a new preview, so wiping a persistent error would leave the
    // editor without the original failure or a retry. A new interaction
    // rejection (e.g. `incompatibleRouteNode`) still replaces the preview
    // error, and a successful selection clears a stale transient click error
    // (`invalidRouteDraftInteraction`, `incompatibleRouteNode`,
    // `missingRouteNode`); persistent errors like
    // `routeChangedWhileEditing` survive.
    const generationStable =
      result.draft.generation === ui.routeDraft.generation;
    const routePreviewError = generationStable
      ? (result.rejection ??
        (isTransientRouteClickError(ui.routePreviewError)
          ? null
          : ui.routePreviewError))
      : result.rejection;
    const routePreviewHostError = generationStable
      ? ui.routePreviewHostError
      : null;
    return {
      state,
      ui:
        result.draft === ui.routeDraft &&
        routePreviewError === ui.routePreviewError &&
        routePreviewHostError === ui.routePreviewHostError &&
        routeDraftNotice === ui.routeDraftNotice
          ? ui
          : {
              ...ui,
              routeDraft: result.draft,
              routeDraftNotice,
              routePreviewError,
              routePreviewHostError,
            },
    };
  }

  if (ui.activeTool === "inspect") {
    const nodes = resolveNodesAtTile(state, point);
    if (nodes.length === 0) {
      return {
        state,
        ui: {
          ...ui,
          selectedId: `${point.x},${point.y}`,
          selectedNodeKind: null,
        },
      };
    }

    const isSameTile = ui.selectedId === `${point.x},${point.y}`;
    let selectedNodeKind: "stop" | "station";
    if (isSameTile && nodes.length > 1) {
      const otherNode = nodes.find((n) => n.kind !== ui.selectedNodeKind);
      selectedNodeKind = otherNode?.kind ?? nodes[0].kind;
    } else {
      selectedNodeKind = nodes[0].kind;
    }

    return {
      state,
      ui: {
        ...ui,
        selectedId: `${point.x},${point.y}`,
        selectedNodeKind,
      },
    };
  }

  return { state, ui };
}

export { cancelDraftRoute, resolveStationAtTile, resolveStopAtTile };
