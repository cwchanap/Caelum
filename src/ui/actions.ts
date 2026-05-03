import type { GameState, Point } from "../domain/types";
import { isValidCivicAnchorPlacement } from "../simulation/map";
import { addBusRoute, addBusStop, addMetroLine, addMetroStation, assignVehicle } from "../simulation/transit";
import type { UiState } from "./uiState";

const CIVIC_ANCHOR_COST = 12_000;

function samePoint(left: Point, right: Point): boolean {
  return left.x === right.x && left.y === right.y;
}

function addCivicAnchor(state: GameState, point: Point): GameState {
  if (state.budget < CIVIC_ANCHOR_COST || !isValidCivicAnchorPlacement(state, point)) {
    return state;
  }

  return {
    ...state,
    budget: state.budget - CIVIC_ANCHOR_COST,
    map: {
      ...state.map,
      tiles: state.map.tiles.map((tile) => (samePoint(tile, point) ? { ...tile, kind: "civic" } : tile))
    }
  };
}

export function handleTileClick(state: GameState, ui: UiState, point: Point): { state: GameState; ui: UiState } {
  if (ui.activeTool === "busStop") {
    return { state: addBusStop(state, point), ui };
  }

  if (ui.activeTool === "metroStation") {
    return { state: addMetroStation(state, point), ui };
  }

  if (ui.activeTool === "civicAnchor") {
    return { state: addCivicAnchor(state, point), ui };
  }

  if (ui.activeTool === "busRoute") {
    const stop = state.transit.stops.find((candidate) => samePoint(candidate.position, point));

    if (stop === undefined) {
      return { state, ui };
    }

    const draftStopIds = [...ui.draftStopIds, stop.id];

    if (draftStopIds.length >= 2) {
      const withRoute = addBusRoute(state, draftStopIds);
      const routeId = withRoute.transit.routes.at(-1)?.id;

      return {
        state: routeId === undefined ? withRoute : assignVehicle(withRoute, "bus", routeId),
        ui: { ...ui, draftStopIds: [] }
      };
    }

    return { state, ui: { ...ui, draftStopIds } };
  }

  if (ui.activeTool === "metroLine") {
    const station = state.transit.stations.find((candidate) => samePoint(candidate.position, point));

    if (station === undefined) {
      return { state, ui };
    }

    const draftStationIds = [...ui.draftStationIds, station.id];

    if (draftStationIds.length >= 2) {
      const withLine = addMetroLine(state, draftStationIds);
      const lineId = withLine.transit.metroLines.at(-1)?.id;

      return {
        state: lineId === undefined ? withLine : assignVehicle(withLine, "metro", lineId),
        ui: { ...ui, draftStationIds: [] }
      };
    }

    return { state, ui: { ...ui, draftStationIds } };
  }

  if (ui.activeTool === "inspect") {
    return { state, ui: { ...ui, selectedId: `${point.x},${point.y}` } };
  }

  return { state, ui };
}
