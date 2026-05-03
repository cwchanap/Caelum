import { entityId } from "../domain/ids";
import type { GameState, Point, Vehicle } from "../domain/types";
import { isValidBusStopPlacement, isValidMetroStationPlacement } from "./map";

const COSTS = {
  busStop: 2_000,
  metroStation: 25_000,
  bus: 8_000,
  metro: 50_000
} as const;

function canAfford(state: GameState, cost: number): boolean {
  return state.budget >= cost;
}

function clonePoint(point: Point): Point {
  return { x: point.x, y: point.y };
}

function distinctValidStopCount(state: GameState, stopIds: string[]): number {
  const existingStopIds = new Set(state.transit.stops.map((stop) => stop.id));

  return new Set(stopIds.filter((stopId) => existingStopIds.has(stopId))).size;
}

function distinctValidStationCount(state: GameState, stationIds: string[]): number {
  const existingStationIds = new Set(state.transit.stations.map((station) => station.id));

  return new Set(stationIds.filter((stationId) => existingStationIds.has(stationId))).size;
}

export function addBusStop(state: GameState, point: Point): GameState {
  if (!canAfford(state, COSTS.busStop) || !isValidBusStopPlacement(state, point)) {
    return state;
  }

  return {
    ...state,
    budget: state.budget - COSTS.busStop,
    transit: {
      ...state.transit,
      stops: [
        ...state.transit.stops,
        {
          id: entityId("stop", state.transit.stops.length + 1),
          position: clonePoint(point),
          queueCitizenIds: []
        }
      ]
    }
  };
}

export function addMetroStation(state: GameState, point: Point): GameState {
  if (!canAfford(state, COSTS.metroStation) || !isValidMetroStationPlacement(state, point)) {
    return state;
  }

  return {
    ...state,
    budget: state.budget - COSTS.metroStation,
    transit: {
      ...state.transit,
      stations: [
        ...state.transit.stations,
        {
          id: entityId("station", state.transit.stations.length + 1),
          position: clonePoint(point),
          queueCitizenIds: []
        }
      ]
    }
  };
}

export function addBusRoute(state: GameState, stopIds: string[]): GameState {
  const routeNumber = state.transit.routes.length + 1;

  return {
    ...state,
    transit: {
      ...state.transit,
      routes: [
        ...state.transit.routes,
        {
          id: entityId("route", routeNumber),
          name: `Bus ${routeNumber}`,
          color: "#e04f39",
          stopIds: [...stopIds],
          vehicleIds: [],
          active: distinctValidStopCount(state, stopIds) >= 2
        }
      ]
    }
  };
}

export function addMetroLine(state: GameState, stationIds: string[]): GameState {
  const lineNumber = state.transit.metroLines.length + 1;

  return {
    ...state,
    transit: {
      ...state.transit,
      metroLines: [
        ...state.transit.metroLines,
        {
          id: entityId("metro", lineNumber),
          name: `Metro ${lineNumber}`,
          color: "#2867b2",
          stationIds: [...stationIds],
          vehicleIds: [],
          active: distinctValidStationCount(state, stationIds) >= 2
        }
      ]
    }
  };
}

export function assignVehicle(state: GameState, mode: "bus" | "metro", lineId: string): GameState {
  const cost = COSTS[mode];

  if (!canAfford(state, cost)) {
    return state;
  }

  const vehicle: Vehicle = {
    id: entityId("vehicle", state.transit.vehicles.length + 1),
    mode,
    lineId,
    capacity: mode === "bus" ? 18 : 90,
    passengerIds: [],
    segmentIndex: 0,
    progress: 0
  };

  if (mode === "bus") {
    const route = state.transit.routes.find((candidate) => candidate.id === lineId);

    if (route === undefined || !route.active) {
      return state;
    }

    return {
      ...state,
      budget: state.budget - cost,
      transit: {
        ...state.transit,
        routes: state.transit.routes.map((candidate) =>
          candidate.id === lineId ? { ...candidate, vehicleIds: [...candidate.vehicleIds, vehicle.id] } : candidate
        ),
        vehicles: [...state.transit.vehicles, vehicle]
      }
    };
  }

  const metroLine = state.transit.metroLines.find((candidate) => candidate.id === lineId);

  if (metroLine === undefined || !metroLine.active) {
    return state;
  }

  return {
    ...state,
    budget: state.budget - cost,
    transit: {
      ...state.transit,
      metroLines: state.transit.metroLines.map((candidate) =>
        candidate.id === lineId ? { ...candidate, vehicleIds: [...candidate.vehicleIds, vehicle.id] } : candidate
      ),
      vehicles: [...state.transit.vehicles, vehicle]
    }
  };
}
