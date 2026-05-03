import type { GameState, Point } from "../domain/types";
import { isValidCivicAnchorPlacement } from "../simulation/map";
import { addBusRoute, addBusStop, addMetroLine, addMetroStation, assignVehicle } from "../simulation/transit";
import type { UiState } from "./uiState";

const CIVIC_ANCHOR_COST = 12_000;
const BUS_VEHICLE_COST = 8_000;
const METRO_VEHICLE_COST = 50_000;

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

function removeAtTile(state: GameState, point: Point): GameState {
  const removedStopIds = new Set(state.transit.stops.filter((stop) => samePoint(stop.position, point)).map((stop) => stop.id));
  const removedStationIds = new Set(
    state.transit.stations.filter((station) => samePoint(station.position, point)).map((station) => station.id)
  );
  const removedRouteIds = new Set(
    state.transit.routes.filter((route) => route.stopIds.some((stopId) => removedStopIds.has(stopId))).map((route) => route.id)
  );
  const removedMetroLineIds = new Set(
    state.transit.metroLines
      .filter((metroLine) => metroLine.stationIds.some((stationId) => removedStationIds.has(stationId)))
      .map((metroLine) => metroLine.id)
  );
  const removesCivicAnchor = state.map.tiles.some((tile) => samePoint(tile, point) && tile.kind === "civic");

  if (removedStopIds.size === 0 && removedStationIds.size === 0 && !removesCivicAnchor) {
    return state;
  }

  return {
    ...state,
    map: removesCivicAnchor
      ? {
          ...state.map,
          tiles: state.map.tiles.map((tile) => (samePoint(tile, point) && tile.kind === "civic" ? { ...tile, kind: "empty" } : tile))
        }
      : state.map,
    transit: {
      ...state.transit,
      stops: state.transit.stops.filter((stop) => !removedStopIds.has(stop.id)),
      stations: state.transit.stations.filter((station) => !removedStationIds.has(station.id)),
      routes: state.transit.routes.filter((route) => !removedRouteIds.has(route.id)),
      metroLines: state.transit.metroLines.filter((metroLine) => !removedMetroLineIds.has(metroLine.id)),
      vehicles: state.transit.vehicles.filter(
        (vehicle) => !removedRouteIds.has(vehicle.lineId) && !removedMetroLineIds.has(vehicle.lineId)
      )
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
      if (state.budget < BUS_VEHICLE_COST) {
        return { state, ui };
      }

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
      if (state.budget < METRO_VEHICLE_COST) {
        return { state, ui };
      }

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

  if (ui.activeTool === "remove") {
    return {
      state: removeAtTile(state, point),
      ui: { ...ui, draftStopIds: [], draftStationIds: [], selectedId: null }
    };
  }

  return { state, ui };
}
