import type { GameState, Point, Station, Stop } from "../domain/types";
import { isPresentTransitNode } from "../runtime/snapshotView";
import {
  applyRouteNodeClick,
  cancelDraftRoute,
  removeWaypoint,
  resolveStationAtTile,
  resolveStopAtTile,
  selectWaypoint,
} from "./routeDraft";
import type { UiState } from "./uiState";

export type ResolvedNode =
  | { kind: "stop"; node: Stop }
  | { kind: "station"; node: Station };

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
    return {
      state,
      ui:
        result.draft === ui.routeDraft &&
        result.rejection === ui.routePreviewError
          ? ui
          : {
              ...ui,
              routeDraft: result.draft,
              routePreviewError: result.rejection,
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
          activeHudCategory:
            ui.activeHudCategory === "inspect" ? null : ui.activeHudCategory,
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
        activeHudCategory: "inspect",
      },
    };
  }

  return { state, ui };
}

export function removeDraftNode(
  _state: GameState,
  ui: UiState,
  index: number,
): UiState {
  if (ui.routeDraft === null) return ui;
  const selected = selectWaypoint(
    ui.routeDraft,
    index,
    ui.routeDraft.interaction,
  );
  const routeDraft = removeWaypoint(selected);
  return routeDraft === ui.routeDraft
    ? ui
    : { ...ui, routeDraft, routePreviewError: null };
}

export { cancelDraftRoute, resolveStationAtTile, resolveStopAtTile };
