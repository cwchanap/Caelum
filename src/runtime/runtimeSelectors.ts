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
import { selectPlatformOccupancy } from "../domain/platformOccupancy";
import { resolveNodeAtTile } from "../ui/actions";
import { canSaveRouteDraft } from "../ui/routeDraft";
import { pad2 } from "../format";
import {
  rejectionMessage,
  routeFailureGuidance,
  warningMessage,
} from "./rejectionMessages";
import type { UiState } from "../ui/uiState";
import type {
  ShellHudState,
  ShellInspectorState,
  ShellPlatform,
  RouteFailureRow,
  RouteEditorView,
  RouteServiceStatus,
  RoadMutationPreviewView,
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

const budgetFormat = new Intl.NumberFormat("en-US");

export function formatBudget(budget: number): string {
  return `$${budgetFormat.format(budget)}`;
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
  if ((stop ?? station)?.status === "missing") {
    if (station !== undefined) return "Missing Metro Station";
    return stop?.kind === "busTerminal"
      ? "Missing Bus Terminal"
      : "Missing Bus Stop";
  }
  return `${stop === undefined ? "Station" : "Stop"} ${alphabeticOrdinal(ordinal)}`;
}

function routeDraftPreviewMessage(
  state: GameState,
  ui: UiState,
): { status: RouteEditorView["previewStatus"]; message: string | null } {
  const draft = ui.routeDraft;
  if (draft === null) return { status: "empty", message: null };
  const localError = ui.routePreviewError;
  // `invalidRouteDraftInteraction` is a transient UI hint (e.g. "select a
  // waypoint to remove"), not a preview rejection. Determine the real
  // preview status first, then override only the message so the status
  // never contradicts an enabled Save button.
  const interactionMessage =
    localError?.code === "invalidRouteDraftInteraction"
      ? localError.context.operation === "removeWaypoint"
        ? "Select a waypoint to remove."
        : localError.context.operation === "moveWaypoint"
          ? "That waypoint cannot move farther."
          : "That waypoint is no longer available."
      : null;

  if (draft.previewPending) {
    return { status: "empty", message: "Checking route…" };
  }
  if (ui.routePreviewHostError !== null) {
    return { status: "rejected", message: ui.routePreviewHostError };
  }
  const preview = draft.preview;
  if (preview === null || preview.legs.length === 0) {
    if (
      localError !== null &&
      localError.code !== "invalidRouteDraftInteraction"
    ) {
      const message =
        localError.code === "routeChangedWhileEditing"
          ? "Saved route changed. Reload the latest revision."
          : localError.code === "incompatibleRouteNode"
            ? "Choose a stop or station that matches this route."
            : localError.code === "missingRouteNode"
              ? "That route node is missing."
              : "Route preview was rejected.";
      return { status: "rejected", message };
    }
    return {
      status: "empty",
      message: interactionMessage ?? "Add at least two waypoints.",
    };
  }
  const rejectedLeg = preview.legs.find((leg) => leg.status !== "connected");
  if (rejectedLeg !== undefined) {
    const from = waypointLabel(state, rejectedLeg.fromWaypointId);
    const to = waypointLabel(state, rejectedLeg.toWaypointId);
    return {
      status: "broken",
      message:
        rejectedLeg.status === "missingNode"
          ? `${from} → ${to} includes a missing waypoint.`
          : `${from} → ${to} cannot connect.`,
    };
  }
  if (
    preview.rejection !== null ||
    (localError !== null && localError.code !== "invalidRouteDraftInteraction")
  ) {
    return { status: "rejected", message: "Route preview was rejected." };
  }
  if (!preview.affordable) {
    return {
      status: "rejected",
      message: `Need ${formatBudget(preview.initialVehicleCost)}.`,
    };
  }
  return { status: "connected", message: interactionMessage ?? "Connected" };
}

export function selectRouteEditorView(
  state: GameState,
  ui: UiState,
  rejection: GameplayRejection | null,
): RouteEditorView | null {
  const draft = ui.routeDraft;
  if (draft === null) return null;
  const routeId = draft.source.kind === "edit" ? draft.source.routeId : null;
  const staleRejection =
    draft.source.kind === "edit" &&
    rejection?.code === "routeChangedWhileEditing" &&
    rejection.context.routeId === draft.source.routeId
      ? rejection
      : null;
  // The routeChangedWhileEditing error can surface either as a global
  // rejection (failed Save) or as a local preview error (detected during
  // preview re-evaluation). In both cases the user needs a Reload button.
  const localStaleError =
    routeId !== null &&
    ui.routePreviewError?.code === "routeChangedWhileEditing" &&
    ui.routePreviewError.context.routeId === routeId
      ? ui.routePreviewError
      : null;
  const preview =
    staleRejection === null
      ? routeDraftPreviewMessage(state, ui)
      : {
          status: "rejected" as const,
          message: rejectionMessage(staleRejection),
        };
  const title =
    routeId === null
      ? draft.mode === "metro"
        ? "New Metro Line"
        : "New Bus Route"
      : `Editing ${routeNameAndColor(state, routeId).name}`;
  return {
    source: draft.source.kind,
    title,
    mode: draft.mode,
    pattern: draft.pattern,
    waypoints: draft.waypointIds.map((id, index) => {
      const node =
        state.transit.stops.find((candidate) => candidate.id === id) ??
        state.transit.stations.find((candidate) => candidate.id === id);
      return {
        id,
        index,
        label: waypointLabel(state, id),
        status: node?.status ?? "missing",
        selected: draft.selectedIndex === index,
      };
    }),
    selectedIndex: draft.selectedIndex,
    interaction: draft.interaction,
    previewPending: draft.previewPending,
    previewStatus: preview.status,
    previewMessage: preview.message,
    previewWarnings: draft.preview?.warnings.map(warningMessage) ?? [],
    failures: routeFailures(
      state,
      draft.pattern,
      draft.waypointIds,
      draft.preview?.legs ?? [],
    ),
    canSave:
      staleRejection === null &&
      (ui.routePreviewError === null ||
        ui.routePreviewError.code === "invalidRouteDraftInteraction") &&
      ui.routePreviewHostError === null &&
      canSaveRouteDraft(draft),
    canReload: staleRejection !== null || localStaleError !== null,
    canUndo: ui.routeDraftHistory.past.length > 0,
    canRedo: ui.routeDraftHistory.future.length > 0,
    notice: ui.routeDraftNotice,
  };
}

function routeFailures(
  state: GameState,
  pattern: Route["pattern"],
  waypointIds: string[],
  legs: RouteLegPath[],
): RouteFailureRow[] {
  return legs.flatMap((leg, legIndex) => {
    if (leg.status === "connected") return [];

    const reason: RouteFailureRow["reason"] =
      leg.status === "missingNode"
        ? "missingNode"
        : (leg.failureReason ?? "networkDisconnected");
    const isLoopClosing =
      pattern === "loop" && leg.toWaypointId === waypointIds[0];
    return [
      {
        legIndex,
        fromWaypointId: leg.fromWaypointId,
        toWaypointId: leg.toWaypointId,
        fromLabel: waypointLabel(state, leg.fromWaypointId),
        toLabel: waypointLabel(state, leg.toWaypointId),
        reason,
        legKind: leg.kind,
        isLoopClosing,
        guidance: routeFailureGuidance(reason, {
          isLoopClosing,
          legKind: leg.kind,
        }),
        missingNodeKind:
          reason === "missingNode"
            ? missingNodeKindForLeg(state, leg)
            : undefined,
      },
    ];
  });
}

function missingNodeKindForLeg(
  state: GameState,
  leg: RouteLegPath,
): "stop" | "station" {
  const fromStation = state.transit.stations.find(
    (node) => node.id === leg.fromWaypointId,
  );
  const toStation = state.transit.stations.find(
    (node) => node.id === leg.toWaypointId,
  );
  if (fromStation?.status === "missing" || toStation?.status === "missing") {
    return "station";
  }
  return "stop";
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
    failures: routeFailures(
      state,
      route.pattern,
      "stopIds" in route ? route.stopIds : route.stationIds,
      route.legs,
    ),
  };
}

export function buildRoadMutationPreview(
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
    skippedTiles: preview.skippedTiles,
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
    routeDraft: selectRouteEditorView(state, ui, rejection),
    routes: buildRouteList(state, ui),
    roadMutationPreview: buildRoadMutationPreview(state, ui),
  };
}
