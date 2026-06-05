import type { GameState } from "../domain/types";
import { BUILDING_CATALOG } from "../simulation/buildings";
import { selectPlatformOccupancy } from "../simulation/platforms";
import { COSTS } from "../simulation/transit";
import { resolveNodeAtTile } from "../ui/actions";
import type { UiState } from "../ui/uiState";
import type {
  ShellInspectorState,
  ShellPlatform,
  ShellRouteDraftState,
  ShellRouteListState,
  ShellState,
} from "./types";

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

export function formatBudget(budget: number): string {
  return `$${budget.toLocaleString()}`;
}

export function formatTime(seconds: number): string {
  const total = Math.floor(seconds);
  const mins = Math.floor(total / 60);
  const secs = total % 60;

  return `T+${pad2(mins)}:${pad2(secs)}`;
}

export function formatObjective(state: GameState): string {
  return `Hold late trips below ${Math.round(state.scenario.objectives.maxLateRatio * 100)}%, unserved below ${Math.round(
    state.scenario.objectives.maxUnservedRatio * 100,
  )}%, average wait under ${state.scenario.objectives.maxAverageWait}s.`;
}

export function formatActiveTool(ui: UiState): string {
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
): ShellRouteDraftState | null {
  const isBus = ui.activeTool === "busRoute";
  const isMetro = ui.activeTool === "metroLine";
  if (!isBus && !isMetro) {
    return null;
  }
  const ids = isBus ? ui.draftStopIds : ui.draftStationIds;
  if (ids.length === 0) {
    return null;
  }
  const vehicleCost = isBus ? COSTS.bus : COSTS.metro;
  const distinct = new Set(ids).size;
  const affordable = state.budget >= vehicleCost;
  const canFinish = distinct >= 2 && affordable;
  const finishHint =
    distinct < 2
      ? "Add another stop"
      : affordable
        ? "Ready"
        : `Need ${formatBudget(vehicleCost)}`;

  return {
    mode: isBus ? "bus" : "metro",
    stops: ids.map((id, index) => {
      const { label, coord } = stopLabel(state, id);
      return { index, label, coord };
    }),
    distinctCount: distinct,
    vehicleCost,
    canFinish,
    finishHint,
  };
}

function buildRouteList(state: GameState, ui: UiState): ShellRouteListState {
  const buses: ShellRouteListState = state.transit.routes.map((route) => ({
    id: route.id,
    name: route.name,
    color: route.color,
    mode: "bus",
    stopCount: route.stopIds.length,
    active: route.active,
    selected: ui.selectedRouteId === route.id,
  }));
  const metros: ShellRouteListState = state.transit.metroLines.map((line) => ({
    id: line.id,
    name: line.name,
    color: line.color,
    mode: "metro",
    stopCount: line.stationIds.length,
    active: line.active,
    selected: ui.selectedRouteId === line.id,
  }));
  return [...buses, ...metros];
}

export function selectShellState(state: GameState, ui: UiState): ShellState {
  return {
    topbar: {
      budget: formatBudget(state.budget),
      signalState: state.paused ? "Hold" : "Live",
      time: formatTime(state.time),
      population: `${state.citizens.length}`,
      late: `${state.metrics.lateTrips}`,
      unserved: `${state.metrics.unservedTrips}`,
      avgWait: `${Math.floor(state.metrics.averageWaitSeconds)}s`,
    },
    controlTower: {
      title: state.scenario.name,
      status: state.metrics.state.toUpperCase(),
      objective: formatObjective(state),
      lossNote: state.metrics.lossReason ?? "Within tolerances. Hold the line.",
      nextGrowth:
        state.scenario.growthWaves.find((wave) => !wave.applied)?.message ??
        "All growth waves resolved.",
      selectedId: ui.selectedId ?? "—",
      activeTool: formatActiveTool(ui),
      controlTowerOpen: ui.controlTowerOpen,
    },
    inspector: buildInspector(state, ui),
    routeDraft: buildRouteDraft(state, ui),
    routes: buildRouteList(state, ui),
  };
}
