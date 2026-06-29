import type {
  GameState,
  Point,
  Station,
  Stop,
  TransitMode,
} from "../domain/types";
import { findTilePath } from "../simulation/network";
import type { UiState } from "./uiState";

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

export function resolveStationAtTile(
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

export function tilePathExists(
  state: GameState,
  from: Point,
  to: Point,
  mode: Extract<TransitMode, "bus" | "metro">,
): boolean {
  return findTilePath(state.map, from, to, mode) !== null;
}

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

export function appendDraftStop(
  state: GameState,
  ui: UiState,
  stop: Stop,
): UiState {
  return appendDraftNode(state, ui, stop, "bus");
}

export function appendDraftStation(
  state: GameState,
  ui: UiState,
  station: Station,
): UiState {
  return appendDraftNode(state, ui, station, "metro");
}

export function removeDraftNode(
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

export function finishDraftRoute(
  state: GameState,
  ui: UiState,
): { state: GameState; ui: UiState } {
  return { state, ui };
}
