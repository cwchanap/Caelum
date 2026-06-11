import type { GameState, Point, Station, Stop } from "../domain/types";
import { findTilePath } from "../simulation/network";
import { placeBuilding } from "../simulation/buildings";
import {
  addBusRoute,
  addBusStop,
  addMetroLine,
  addMetroStation,
  assignVehicle,
  COSTS,
  deleteRoute,
  distinctValidStationCount,
  distinctValidStopCount,
  layRoad,
  layTrack,
  removeInfrastructureAtTile,
} from "../simulation/transit";
import type { UiState } from "./uiState";

function samePoint(left: Point, right: Point): boolean {
  return left.x === right.x && left.y === right.y;
}

function resolveStopAtTile(state: GameState, point: Point): Stop | undefined {
  const exactStop = state.transit.stops.find((candidate) =>
    samePoint(candidate.position, point),
  );

  if (exactStop !== undefined) {
    return exactStop;
  }

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

export type ResolvedNode =
  | { kind: "stop"; node: Stop }
  | { kind: "station"; node: Station };

function resolveStationAtTile(
  state: GameState,
  point: Point,
): Station | undefined {
  const exactStation = state.transit.stations.find((candidate) =>
    samePoint(candidate.position, point),
  );
  if (exactStation !== undefined) {
    return exactStation;
  }

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

export function resolveNodesAtTile(
  state: GameState,
  point: Point,
): ResolvedNode[] {
  const nodes: ResolvedNode[] = [];
  const stop = resolveStopAtTile(state, point);
  if (stop !== undefined) {
    nodes.push({ kind: "stop", node: stop });
  }
  const station = resolveStationAtTile(state, point);
  if (station !== undefined) {
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

function removeAtTile(state: GameState, point: Point): GameState {
  const removedBuilding = state.buildings.find((building) =>
    building.occupiedTiles.some((tile) => samePoint(tile, point)),
  );
  const removedStopIds = new Set<string>();
  const removedStationIds = new Set<string>();

  if (
    removedBuilding?.transitNodeId !== undefined &&
    (removedBuilding.type === "busStop" ||
      removedBuilding.type === "busTerminal")
  ) {
    removedStopIds.add(removedBuilding.transitNodeId);
  }

  if (
    removedBuilding?.transitNodeId !== undefined &&
    removedBuilding.type === "metroStation"
  ) {
    removedStationIds.add(removedBuilding.transitNodeId);
  }

  if (removedBuilding === undefined) {
    state.transit.stops
      .filter((stop) => samePoint(stop.position, point))
      .forEach((stop) => removedStopIds.add(stop.id));
    state.transit.stations
      .filter((station) => samePoint(station.position, point))
      .forEach((station) => removedStationIds.add(station.id));
  }

  const removedRouteIds = new Set(
    state.transit.routes
      .filter((route) =>
        route.stopIds.some((stopId) => removedStopIds.has(stopId)),
      )
      .map((route) => route.id),
  );
  const removedMetroLineIds = new Set(
    state.transit.metroLines
      .filter((metroLine) =>
        metroLine.stationIds.some((stationId) =>
          removedStationIds.has(stationId),
        ),
      )
      .map((metroLine) => metroLine.id),
  );

  if (
    removedBuilding === undefined &&
    removedStopIds.size === 0 &&
    removedStationIds.size === 0
  ) {
    // Bare tile: bulldoze track, then road (two clicks on a crossing).
    return removeInfrastructureAtTile(state, point);
  }

  // Remove the node(s) first.
  let next: GameState = {
    ...state,
    buildings:
      removedBuilding === undefined
        ? state.buildings
        : state.buildings.filter(
            (building) => building.id !== removedBuilding.id,
          ),
    transit: {
      ...state.transit,
      stops: state.transit.stops.filter((stop) => !removedStopIds.has(stop.id)),
      stations: state.transit.stations.filter(
        (station) => !removedStationIds.has(station.id),
      ),
    },
  };

  // Then delete every dependent route/line via the shared helper, which also
  // strips platform assignments and removes vehicles.
  for (const routeId of removedRouteIds) {
    next = deleteRoute(next, routeId);
  }
  for (const lineId of removedMetroLineIds) {
    next = deleteRoute(next, lineId);
  }

  return next;
}

export function finishDraftRoute(
  state: GameState,
  ui: UiState,
): { state: GameState; ui: UiState } {
  if (ui.activeTool === "busRoute") {
    if (
      distinctValidStopCount(state, ui.draftStopIds) < 2 ||
      state.budget < COSTS.bus
    ) {
      return { state, ui };
    }
    const withRoute = addBusRoute(state, ui.draftStopIds);
    const routeId = withRoute.transit.routes.at(-1)?.id;
    const next =
      routeId === undefined
        ? withRoute
        : assignVehicle(withRoute, "bus", routeId);
    return {
      state: next,
      ui: { ...ui, draftStopIds: [], draftStopPaths: [] },
    };
  }

  if (ui.activeTool === "metroLine") {
    if (
      distinctValidStationCount(state, ui.draftStationIds) < 2 ||
      state.budget < COSTS.metro
    ) {
      return { state, ui };
    }
    const withLine = addMetroLine(state, ui.draftStationIds);
    const lineId = withLine.transit.metroLines.at(-1)?.id;
    const next =
      lineId === undefined
        ? withLine
        : assignVehicle(withLine, "metro", lineId);
    return {
      state: next,
      ui: { ...ui, draftStationIds: [], draftStationPaths: [] },
    };
  }

  return { state, ui };
}

export function removeDraftStop(
  state: GameState,
  ui: UiState,
  index: number,
): UiState {
  const isMetro = ui.activeTool === "metroLine";
  const isBus = ui.activeTool === "busRoute";
  if (!isMetro && !isBus) {
    return ui;
  }

  const ids = isMetro ? ui.draftStationIds : ui.draftStopIds;
  const paths = isMetro ? ui.draftStationPaths : ui.draftStopPaths;
  if (index < 0 || index >= ids.length) {
    return ui;
  }

  let nextPaths: Point[][];
  if (index === 0) {
    nextPaths = paths.slice(1);
  } else if (index === ids.length - 1) {
    nextPaths = paths.slice(0, -1);
  } else {
    // Interior removal merges two legs; reject if the merged pair no longer
    // connects, so the draft invariant "every consecutive pair has a path"
    // always holds (the player can still cancel the whole draft).
    const nodes: Array<Stop | Station> = isMetro
      ? state.transit.stations
      : state.transit.stops;
    const before = nodes.find((node) => node.id === ids[index - 1]);
    const after = nodes.find((node) => node.id === ids[index + 1]);
    const merged =
      before === undefined || after === undefined
        ? null
        : findTilePath(
            state.map,
            before.position,
            after.position,
            isMetro ? "metro" : "bus",
          );
    if (merged === null) {
      return ui;
    }
    nextPaths = [
      ...paths.slice(0, index - 1),
      merged,
      ...paths.slice(index + 1),
    ];
  }

  const nextIds = ids.filter((_, i) => i !== index);
  return isMetro
    ? { ...ui, draftStationIds: nextIds, draftStationPaths: nextPaths }
    : { ...ui, draftStopIds: nextIds, draftStopPaths: nextPaths };
}

// Shared by the busRoute/metroLine click branches in handleTileClick: appends
// `node` to the in-progress draft, computing the connecting path from the
// previous draft node. Mirrors removeDraftStop's mode discriminator. Returns
// the same `ui` reference (no-op) when the node repeats the last one or no
// path connects it to the previous node, so callers can detect "no change".
function appendDraftNode(
  state: GameState,
  ui: UiState,
  node: Stop | Station,
  mode: "bus" | "metro",
): UiState {
  const isMetro = mode === "metro";
  const ids = isMetro ? ui.draftStationIds : ui.draftStopIds;
  if (ids.at(-1) === node.id) {
    return ui;
  }

  const previousId = ids.at(-1);
  if (previousId === undefined) {
    return isMetro
      ? { ...ui, draftStationIds: [node.id] }
      : { ...ui, draftStopIds: [node.id] };
  }

  const nodes: Array<Stop | Station> = isMetro
    ? state.transit.stations
    : state.transit.stops;
  const previous = nodes.find((n) => n.id === previousId);
  const path =
    previous === undefined
      ? null
      : findTilePath(state.map, previous.position, node.position, mode);
  if (path === null) {
    return ui;
  }

  return isMetro
    ? {
        ...ui,
        draftStationIds: [...ids, node.id],
        draftStationPaths: [...ui.draftStationPaths, path],
      }
    : {
        ...ui,
        draftStopIds: [...ids, node.id],
        draftStopPaths: [...ui.draftStopPaths, path],
      };
}

export function cancelDraftRoute(ui: UiState): UiState {
  if (ui.draftStopIds.length === 0 && ui.draftStationIds.length === 0) {
    return ui;
  }
  return {
    ...ui,
    draftStopIds: [],
    draftStationIds: [],
    draftStopPaths: [],
    draftStationPaths: [],
  };
}

export function handleTileClick(
  state: GameState,
  ui: UiState,
  point: Point,
): { state: GameState; ui: UiState } {
  if (ui.selectedBuilding !== null) {
    return {
      state: placeBuilding(
        state,
        ui.selectedBuilding,
        point,
        ui.buildingRotation,
      ),
      ui,
    };
  }

  if (ui.activeTool === "busStop") {
    return { state: addBusStop(state, point), ui };
  }

  if (ui.activeTool === "metroStation") {
    return { state: addMetroStation(state, point), ui };
  }

  if (ui.activeTool === "road") {
    return { state: layRoad(state, point), ui };
  }

  if (ui.activeTool === "track") {
    return { state: layTrack(state, point), ui };
  }

  if (ui.activeTool === "busRoute") {
    const stop = resolveStopAtTile(state, point);
    if (stop === undefined) {
      return { state, ui };
    }
    const nextUi = appendDraftNode(state, ui, stop, "bus");
    return { state, ui: nextUi };
  }

  if (ui.activeTool === "metroLine") {
    const station = resolveStationAtTile(state, point);
    if (station === undefined) {
      return { state, ui };
    }
    const nextUi = appendDraftNode(state, ui, station, "metro");
    return { state, ui: nextUi };
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

  if (ui.activeTool === "remove") {
    const nextState = removeAtTile(state, point);
    // removeAtTile may cascade-delete the route the player has selected (e.g.
    // bulldozing a stop the route depends on). Clear the stale id so the UI
    // does not hold a selection that no longer points at anything; otherwise
    // selectors only mask the miss via live-id matching.
    const selectedSurvived =
      ui.selectedRouteId === null ||
      nextState.transit.routes.some((r) => r.id === ui.selectedRouteId) ||
      nextState.transit.metroLines.some((l) => l.id === ui.selectedRouteId);
    // Bulldozing clears the inspected selection. If the inspect drawer was
    // open, close it too — otherwise the drawer stays open titled "Inspect"
    // with an empty body and no chip to toggle it closed (the inspector is
    // gone because selectedId is null). Mirrors the empty-tile inspect path
    // above (see the `ui.activeTool === "inspect"` empty-nodes branch).
    const nextHudCategory =
      ui.activeHudCategory === "inspect" ? null : ui.activeHudCategory;
    const nextUi = selectedSurvived
      ? {
          ...ui,
          draftStopIds: [],
          draftStationIds: [],
          draftStopPaths: [],
          draftStationPaths: [],
          selectedId: null,
          activeHudCategory: nextHudCategory,
        }
      : {
          ...ui,
          draftStopIds: [],
          draftStationIds: [],
          draftStopPaths: [],
          draftStationPaths: [],
          selectedId: null,
          selectedRouteId: null,
          activeHudCategory: nextHudCategory,
        };
    return { state: nextState, ui: nextUi };
  }

  return { state, ui };
}
