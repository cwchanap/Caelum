import { entityId } from "../domain/ids";
import type { Citizen, GameState, Point, Route, MetroLine, Vehicle } from "../domain/types";
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

function assignedStopCount(state: GameState, vehicle: Vehicle): number | null {
  if (vehicle.mode === "bus") {
    const route: Route | undefined = state.transit.routes.find((candidate) => candidate.id === vehicle.lineId);
    return route !== undefined && route.active ? route.stopIds.length : null;
  }

  const metroLine: MetroLine | undefined = state.transit.metroLines.find((candidate) => candidate.id === vehicle.lineId);
  return metroLine !== undefined && metroLine.active ? metroLine.stationIds.length : null;
}

function uniquePassengerIds(passengerIds: string[]): string[] {
  return Array.from(new Set(passengerIds));
}

function citizenCanBoard(citizen: Citizen, vehicle: Vehicle, occupiedPassengerIds: Set<string>): boolean {
  if (citizen.status !== "waiting" || occupiedPassengerIds.has(citizen.id)) {
    return false;
  }

  const leg = citizen.routePlan?.legs[citizen.currentLegIndex];
  return leg !== undefined && leg.mode === vehicle.mode && leg.lineId === vehicle.lineId;
}

function boardVehicle(citizens: Citizen[], vehicle: Vehicle, occupiedPassengerIds: Set<string>): { citizens: Citizen[]; vehicle: Vehicle } {
  const passengerIds = uniquePassengerIds(vehicle.passengerIds);
  const availableSeats = Math.max(0, vehicle.capacity - passengerIds.length);

  if (availableSeats === 0) {
    return { citizens, vehicle: { ...vehicle, passengerIds } };
  }

  const boardingCitizenIds: string[] = [];

  for (const citizen of citizens) {
    if (boardingCitizenIds.length >= availableSeats) {
      break;
    }

    if (citizenCanBoard(citizen, vehicle, occupiedPassengerIds)) {
      boardingCitizenIds.push(citizen.id);
      occupiedPassengerIds.add(citizen.id);
    }
  }

  if (boardingCitizenIds.length === 0) {
    return { citizens, vehicle: { ...vehicle, passengerIds } };
  }

  const boardingCitizenIdSet = new Set(boardingCitizenIds);

  return {
    citizens: citizens.map((citizen) =>
      boardingCitizenIdSet.has(citizen.id) ? { ...citizen, status: "riding" } : citizen
    ),
    vehicle: {
      ...vehicle,
      passengerIds: [...passengerIds, ...boardingCitizenIds]
    }
  };
}

function disembarkVehicle(citizens: Citizen[], vehicle: Vehicle, stopCount: number): { citizens: Citizen[]; vehicle: Vehicle } {
  const passengerIds = uniquePassengerIds(vehicle.passengerIds);
  const passengerIdSet = new Set(passengerIds);

  return {
    citizens: citizens.map((citizen) =>
      passengerIdSet.has(citizen.id)
        ? { ...citizen, status: "walking", currentLegIndex: citizen.currentLegIndex + 1 }
        : citizen
    ),
    vehicle: {
      ...vehicle,
      passengerIds: [],
      segmentIndex: (vehicle.segmentIndex + 1) % stopCount,
      progress: vehicle.progress % 1
    }
  };
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

export function tickVehicles(state: GameState, deltaSeconds: number): GameState {
  let citizens = state.citizens;
  const occupiedPassengerIds = new Set(state.transit.vehicles.flatMap((vehicle) => uniquePassengerIds(vehicle.passengerIds)));
  let changed = false;

  const vehicles = state.transit.vehicles.map((vehicle) => {
    const stopCount = assignedStopCount(state, vehicle);

    if (stopCount === null || stopCount < 2) {
      return vehicle;
    }

    const boarded = boardVehicle(citizens, vehicle, occupiedPassengerIds);
    citizens = boarded.citizens;

    const speed = vehicle.mode === "bus" ? 0.08 : 0.14;
    const progress = boarded.vehicle.progress + speed * deltaSeconds;

    if (progress < 1) {
      const nextVehicle = { ...boarded.vehicle, progress };
      changed = changed || nextVehicle !== vehicle;
      return nextVehicle;
    }

    const disembarked = disembarkVehicle(citizens, { ...boarded.vehicle, progress }, stopCount);
    citizens = disembarked.citizens;
    changed = true;
    return disembarked.vehicle;
  });

  if (!changed && citizens === state.citizens) {
    return state;
  }

  return {
    ...state,
    citizens,
    transit: {
      ...state.transit,
      vehicles
    }
  };
}
