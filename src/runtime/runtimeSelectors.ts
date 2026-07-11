import type {
  GameState,
  GameplayRejection,
  MetroLine,
  Overlay,
  Route,
  RouteLegPath,
} from "../domain/types";
import { AREA_LABELS } from "../domain/catalog/areas";
import { BUILDING_CATALOG } from "../domain/catalog/buildings";
import { COSTS } from "../domain/catalog/transit";
import { selectPlatformOccupancy } from "../domain/platformOccupancy";
import { resolveNodeAtTile } from "../ui/actions";
import { pad2 } from "../format";
import type { UiState } from "../ui/uiState";
import type {
  ShellHudState,
  ShellInspectorState,
  ShellPlatform,
  RouteFailureRow,
  RouteServiceStatus,
  RoadMutationPreviewView,
  ShellRouteDraftState,
  ShellRouteListItem,
  ShellRouteListState,
  ShellState,
} from "./types";

const OVERLAY_LABELS: Record<Overlay, string> = {
  coverage: "Coverage",
  crowding: "Crowding",
  demand: "Demand",
  lateness: "Lateness",
  growth: "Growth",
};

export function formatBudget(budget: number): string {
  return `$${budget.toLocaleString()}`;
}

function formatSnapshotClock(state: GameState): string {
  const hours = Math.floor(state.clockMinutes / 60) % 24;
  const minutes = state.clockMinutes % 60;
  return `Day ${state.day + 1} ${pad2(hours)}:${pad2(minutes)}`;
}

export function formatObjective(state: GameState): string {
  return `Hold late trips below ${Math.round(state.scenario.objectives.maxLateRatio * 100)}%, unserved below ${Math.round(
    state.scenario.objectives.maxUnservedRatio * 100,
  )}%, average wait under ${state.scenario.objectives.maxAverageWait}s.`;
}

export function formatActiveTool(ui: UiState): string {
  if (ui.selectedArea !== null) {
    return `AREA ${AREA_LABELS[ui.selectedArea].toUpperCase()}`;
  }

  if (ui.selectedBuilding !== null) {
    return `${BUILDING_CATALOG[ui.selectedBuilding].label.toUpperCase()} ${ui.buildingRotation}`;
  }

  return ui.activeTool.toUpperCase();
}

function parseSelectedPoint(selectedId: string | null): {
  x: number;
  y: number;
} | null {
  if (selectedId === null) {
    return null;
  }
  const match = /^(-?\d+),(-?\d+)$/.exec(selectedId);
  return match === null ? null : { x: Number(match[1]), y: Number(match[2]) };
}

function nodeLabel(state: GameState, nodeId: string): string {
  const stop = state.transit.stops.find((candidate) => candidate.id === nodeId);
  if (stop !== undefined) {
    return stop.kind === "busTerminal" ? "Bus Terminal" : "Bus Stop";
  }
  return "Metro Station";
}

function routeNameAndColor(
  state: GameState,
  routeId: string,
): { name: string; color: string } {
  const route = state.transit.routes.find((r) => r.id === routeId);
  if (route !== undefined) {
    return { name: route.name, color: route.color };
  }
  const line = state.transit.metroLines.find((l) => l.id === routeId);
  return line !== undefined
    ? { name: line.name, color: line.color }
    : { name: routeId, color: "#888888" };
}

function buildInspector(
  state: GameState,
  ui: UiState,
): ShellInspectorState | null {
  const point = parseSelectedPoint(ui.selectedId);
  if (point === null) {
    return null;
  }

  const resolved = resolveNodeAtTile(
    state,
    point,
    ui.selectedNodeKind ?? undefined,
  );
  if (resolved === null) {
    return null;
  }

  const node = resolved.node;
  const occupancy = selectPlatformOccupancy(state);

  const platforms: ShellPlatform[] = node.platforms.map((platform) => ({
    id: platform.id,
    label: platform.label,
    occupancy: occupancy.get(platform.id)?.count ?? 0,
    capacity: platform.capacity,
    routes: platform.routeIds.map((routeId) => {
      const { name, color } = routeNameAndColor(state, routeId);
      return {
        id: routeId,
        name,
        color,
        moveTargets: node.platforms
          .filter((other) => other.id !== platform.id)
          .map((other) => ({ platformId: other.id, label: other.label })),
      };
    }),
  }));

  return {
    nodeId: node.id,
    nodeLabel: nodeLabel(state, node.id),
    canReassign: node.platforms.length > 1,
    platforms,
  };
}

function stopLabel(
  state: GameState,
  stopId: string,
): { label: string; coord: string } {
  const stop = state.transit.stops.find((s) => s.id === stopId);
  if (stop !== undefined) {
    return {
      label: stop.kind === "busTerminal" ? "Bus Terminal" : "Bus Stop",
      coord: `(${stop.position.x},${stop.position.y})`,
    };
  }
  const station = state.transit.stations.find((s) => s.id === stopId);
  if (station !== undefined) {
    return {
      label: "Metro Station",
      coord: `(${station.position.x},${station.position.y})`,
    };
  }
  return { label: stopId, coord: "" };
}

function buildRouteDraft(
  state: GameState,
  ui: UiState,
  rejection: GameplayRejection | null,
): ShellRouteDraftState | null {
  const draft = ui.routeDraft;
  if (draft === null || draft.waypointIds.length === 0) return null;
  const ids = draft.waypointIds;
  const vehicleCost =
    draft.preview?.initialVehicleCost ??
    (draft.mode === "bus" ? COSTS.bus : COSTS.metro);
  const distinct = new Set(ids).size;
  const preview = draft.preview;
  const canFinish =
    preview !== null &&
    preview.generation === draft.generation &&
    preview.rejection === null &&
    preview.legs.length > 0 &&
    (draft.source.kind === "edit" ||
      preview.legs.every((leg) => leg.status === "connected")) &&
    preview.affordable;
  const finishHint = draft.previewPending
    ? "Checking route…"
    : preview === null || preview.legs.length === 0
      ? "Add another stop"
      : preview.rejection !== null ||
          (draft.source.kind === "create" &&
            preview.legs.some((leg) => leg.status !== "connected"))
        ? "Route cannot connect"
        : preview.affordable
          ? "Ready"
          : `Need ${formatBudget(vehicleCost)}`;

  return {
    mode: draft.mode === "metro" ? "metro" : "bus",
    stops: ids.map((id, index) => {
      const { label, coord } = stopLabel(state, id);
      return { index, label, coord };
    }),
    distinctCount: distinct,
    vehicleCost,
    canFinish,
    finishHint,
    canReload:
      draft.source.kind === "edit" &&
      rejection?.code === "routeChangedWhileEditing" &&
      (rejection.context.routeId === undefined ||
        rejection.context.routeId === draft.source.routeId),
  };
}

function buildRouteList(state: GameState, ui: UiState): ShellRouteListState {
  const buses: ShellRouteListItem[] = state.transit.routes.map((route) =>
    selectRouteRow(state, route, "bus", ui.selectedRouteId === route.id),
  );
  const metros: ShellRouteListItem[] = state.transit.metroLines.map((line) =>
    selectRouteRow(state, line, "metro", ui.selectedRouteId === line.id),
  );
  return [...buses, ...metros];
}

function routeServiceStatus(route: Route | MetroLine): RouteServiceStatus {
  return route.pathBroken
    ? { primary: "broken", pausedAfterRepair: !route.active }
    : route.active
      ? { primary: "running", pausedAfterRepair: false }
      : { primary: "paused", pausedAfterRepair: false };
}

function alphabeticOrdinal(value: number): string {
  let remainder = Math.max(1, value);
  let label = "";
  while (remainder > 0) {
    remainder -= 1;
    label = String.fromCharCode(65 + (remainder % 26)) + label;
    remainder = Math.floor(remainder / 26);
  }
  return label;
}

function waypointLabel(state: GameState, waypointId: string): string {
  const stop = state.transit.stops.find((node) => node.id === waypointId);
  const station = state.transit.stations.find((node) => node.id === waypointId);
  if (stop === undefined && station === undefined) {
    return waypointId;
  }
  const collection =
    stop === undefined ? state.transit.stations : state.transit.stops;
  const fallbackOrdinal =
    collection.findIndex((node) => node.id === waypointId) + 1;
  const numericSuffix = /-(\d+)$/.exec(waypointId)?.[1];
  const ordinal =
    numericSuffix === undefined ? fallbackOrdinal : Number(numericSuffix);
  return `${stop === undefined ? "Station" : "Stop"} ${alphabeticOrdinal(ordinal)}`;
}

function routeFailures(
  state: GameState,
  legs: RouteLegPath[],
): RouteFailureRow[] {
  return legs.flatMap((leg, legIndex) =>
    leg.status === "connected"
      ? []
      : [
          {
            legIndex,
            fromWaypointId: leg.fromWaypointId,
            toWaypointId: leg.toWaypointId,
            fromLabel: waypointLabel(state, leg.fromWaypointId),
            toLabel: waypointLabel(state, leg.toWaypointId),
            reason: leg.status,
          },
        ],
  );
}

function selectRouteRow(
  state: GameState,
  route: Route | MetroLine,
  mode: "bus" | "metro",
  selected: boolean,
): ShellRouteListItem {
  return {
    id: route.id,
    name: route.name,
    color: route.color,
    mode,
    stopCount:
      "stopIds" in route ? route.stopIds.length : route.stationIds.length,
    active: route.active,
    selected,
    status: routeServiceStatus(route),
    failures: routeFailures(state, route.legs),
  };
}

function buildRoadMutationPreview(
  state: GameState,
  ui: UiState,
): RoadMutationPreviewView | null {
  const preview = ui.roadMutationPreview;
  if (preview === null || preview.generation !== ui.roadPreviewGeneration) {
    return null;
  }
  return {
    generation: preview.generation,
    changedTiles: preview.changedTiles,
    authoredTiles: preview.authoredTiles,
    generatedStructures: preview.generatedStructures,
    cost: preview.cost,
    costLabel: formatBudget(preview.cost),
    routeImpacts: preview.routeImpacts.map((impact) => ({
      ...impact,
      routeName: routeNameAndColor(state, impact.routeId).name,
    })),
    rejection: preview.rejection,
  };
}

export function selectShellState(
  state: GameState,
  ui: UiState,
  rejection: GameplayRejection | null = null,
): ShellState {
  const inspector = buildInspector(state, ui);
  const draftActive = ui.routeDraft !== null;
  // Single derivation of the active-tool label — bound to both the HUD chip
  // and the Brief panel so the two can never drift apart.
  const activeToolLabel = formatActiveTool(ui);

  const hud: ShellHudState = {
    activeCategory: ui.activeHudCategory,
    activeToolChip: activeToolLabel,
    canCancel:
      draftActive ||
      ui.activeTool !== "inspect" ||
      ui.selectedBuilding !== null ||
      ui.selectedArea !== null ||
      ui.activeOverlay !== null ||
      ui.selectedRouteId !== null,
    buildCategory: ui.buildCategory,
    inspectToolActive:
      ui.activeTool === "inspect" &&
      ui.selectedBuilding === null &&
      ui.selectedArea === null,
    removeToolActive: ui.activeTool === "remove",
    badges: {
      routeDraftActive: draftActive,
      routeCount: state.transit.routes.length + state.transit.metroLines.length,
      activeOverlayLabel:
        ui.activeOverlay === null ? null : OVERLAY_LABELS[ui.activeOverlay],
      inspectActive: inspector !== null,
    },
  };

  return {
    topbar: {
      budget: formatBudget(state.budget),
      signalState: state.paused ? "Hold" : "Live",
      time: formatSnapshotClock(state),
      population: `${state.sims?.length ?? 0}`,
      late: `${state.metrics.lateTrips}`,
      unserved: `${state.metrics.unservedTrips}`,
      avgWait: `${Math.floor(state.metrics.averageWaitSeconds)}s`,
    },
    brief: {
      title: state.scenario.name,
      status: state.metrics.state.toUpperCase(),
      objective: formatObjective(state),
      lossNote: state.metrics.lossReason ?? "Within tolerances. Hold the line.",
      nextGrowth:
        state.scenario.growthWaves.find((wave) => !wave.applied)?.message ??
        "Sandbox: paint areas to grow.",
      selectedId: ui.selectedId ?? "—",
      activeTool: activeToolLabel,
    },
    hud,
    inspector,
    routeDraft: buildRouteDraft(state, ui, rejection),
    routes: buildRouteList(state, ui),
    roadMutationPreview: buildRoadMutationPreview(state, ui),
  };
}
