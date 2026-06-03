import { nextEntityId } from "../domain/ids";
import type {
  Citizen,
  GameState,
  Point,
  Route,
  MetroLine,
  Stop,
  StopKind,
  Vehicle,
} from "../domain/types";
import { isValidBusStopPlacement, isValidMetroStationPlacement } from "./map";
import { busPlatforms, metroPlatforms } from "./platforms";

const COSTS = {
  busStop: 2_000,
  metroStation: 25_000,
  bus: 8_000,
  metro: 50_000,
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

function distinctValidStationCount(
  state: GameState,
  stationIds: string[],
): number {
  const existingStationIds = new Set(
    state.transit.stations.map((station) => station.id),
  );

  return new Set(
    stationIds.filter((stationId) => existingStationIds.has(stationId)),
  ).size;
}

function samePoint(left: Point, right: Point): boolean {
  return left.x === right.x && left.y === right.y;
}

function entityNumberFromId(prefix: string, id: string): number {
  const match = new RegExp(`^${prefix}-(\\d+)$`).exec(id);
  return match === null ? 1 : Number(match[1]);
}

export function stopCoverageRadius(stop: Stop): number {
  return stop.kind === "busTerminal" ? 4 : 2;
}

function assignedLinePositions(
  state: GameState,
  vehicle: Vehicle,
): Point[] | null {
  if (vehicle.mode === "bus") {
    const route: Route | undefined = state.transit.routes.find(
      (candidate) => candidate.id === vehicle.lineId,
    );
    const stopById = new Map(
      state.transit.stops.map((stop) => [stop.id, stop.position]),
    );
    const positions = route?.stopIds.map((stopId) => stopById.get(stopId));

    return route !== undefined &&
      route.active &&
      positions !== undefined &&
      positions.every((position) => position !== undefined)
      ? positions.map((position) => clonePoint(position))
      : null;
  }

  const metroLine: MetroLine | undefined = state.transit.metroLines.find(
    (candidate) => candidate.id === vehicle.lineId,
  );
  const stationById = new Map(
    state.transit.stations.map((station) => [station.id, station.position]),
  );
  const positions = metroLine?.stationIds.map((stationId) =>
    stationById.get(stationId),
  );

  return metroLine !== undefined &&
    metroLine.active &&
    positions !== undefined &&
    positions.every((position) => position !== undefined)
    ? positions.map((position) => clonePoint(position))
    : null;
}

function uniquePassengerIds(passengerIds: string[]): string[] {
  return Array.from(new Set(passengerIds));
}

function citizenCanBoard(
  citizen: Citizen,
  vehicle: Vehicle,
  currentPosition: Point,
  occupiedPassengerIds: Set<string>,
): boolean {
  if (citizen.status !== "waiting" || occupiedPassengerIds.has(citizen.id)) {
    return false;
  }

  const leg = citizen.routePlan?.legs[citizen.currentLegIndex];
  return (
    leg !== undefined &&
    leg.mode === vehicle.mode &&
    leg.lineId === vehicle.lineId &&
    samePoint(citizen.position, currentPosition)
  );
}

function boardVehicle(
  citizens: Citizen[],
  vehicle: Vehicle,
  currentPosition: Point,
  occupiedPassengerIds: Set<string>,
): { citizens: Citizen[]; vehicle: Vehicle } {
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

    if (
      citizenCanBoard(citizen, vehicle, currentPosition, occupiedPassengerIds)
    ) {
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
      boardingCitizenIdSet.has(citizen.id)
        ? { ...citizen, status: "riding" }
        : citizen,
    ),
    vehicle: {
      ...vehicle,
      passengerIds: [...passengerIds, ...boardingCitizenIds],
    },
  };
}

function disembarkVehicle(
  citizens: Citizen[],
  vehicle: Vehicle,
  reachedPosition: Point,
  stopCount: number,
): { citizens: Citizen[]; vehicle: Vehicle } {
  const passengerIds = uniquePassengerIds(vehicle.passengerIds);
  const disembarkingPassengerIds = new Set(
    citizens
      .filter((citizen) => {
        if (!passengerIds.includes(citizen.id)) {
          return false;
        }

        const leg = citizen.routePlan?.legs[citizen.currentLegIndex];
        return (
          leg !== undefined &&
          leg.mode === vehicle.mode &&
          leg.lineId === vehicle.lineId &&
          samePoint(leg.to, reachedPosition)
        );
      })
      .map((citizen) => citizen.id),
  );

  return {
    citizens: citizens.map((citizen) =>
      disembarkingPassengerIds.has(citizen.id)
        ? {
            ...citizen,
            position: clonePoint(reachedPosition),
            status: "walking",
            currentLegIndex: citizen.currentLegIndex + 1,
          }
        : citizen,
    ),
    vehicle: {
      ...vehicle,
      passengerIds: passengerIds.filter(
        (passengerId) => !disembarkingPassengerIds.has(passengerId),
      ),
      segmentIndex: (vehicle.segmentIndex + 1) % stopCount,
      progress: vehicle.progress % 1,
    },
  };
}

export function addBusStop(
  state: GameState,
  point: Point,
  kind: StopKind = "busStop",
): GameState {
  if (
    !canAfford(state, COSTS.busStop) ||
    !isValidBusStopPlacement(state, point)
  ) {
    return state;
  }

  const stopId = nextEntityId(
    "stop",
    state.transit.stops.map((stop) => stop.id),
  );

  return {
    ...state,
    budget: state.budget - COSTS.busStop,
    transit: {
      ...state.transit,
      stops: [
        ...state.transit.stops,
        {
          id: stopId,
          kind,
          position: clonePoint(point),
          platforms: busPlatforms(stopId, kind),
        },
      ],
    },
  };
}

export function addMetroStation(state: GameState, point: Point): GameState {
  if (
    !canAfford(state, COSTS.metroStation) ||
    !isValidMetroStationPlacement(state, point)
  ) {
    return state;
  }

  const stationId = nextEntityId(
    "station",
    state.transit.stations.map((station) => station.id),
  );

  return {
    ...state,
    budget: state.budget - COSTS.metroStation,
    transit: {
      ...state.transit,
      stations: [
        ...state.transit.stations,
        {
          id: stationId,
          position: clonePoint(point),
          platforms: metroPlatforms(stationId),
        },
      ],
    },
  };
}

export function addBusRoute(state: GameState, stopIds: string[]): GameState {
  const routeId = nextEntityId(
    "route",
    state.transit.routes.map((route) => route.id),
  );
  const routeNumber = entityNumberFromId("route", routeId);

  return {
    ...state,
    transit: {
      ...state.transit,
      routes: [
        ...state.transit.routes,
        {
          id: routeId,
          name: `Bus ${routeNumber}`,
          color: "#e04f39",
          stopIds: [...stopIds],
          vehicleIds: [],
          active: distinctValidStopCount(state, stopIds) >= 2,
        },
      ],
    },
  };
}

export function addMetroLine(
  state: GameState,
  stationIds: string[],
): GameState {
  const lineId = nextEntityId(
    "metro",
    state.transit.metroLines.map((line) => line.id),
  );
  const lineNumber = entityNumberFromId("metro", lineId);

  return {
    ...state,
    transit: {
      ...state.transit,
      metroLines: [
        ...state.transit.metroLines,
        {
          id: lineId,
          name: `Metro ${lineNumber}`,
          color: "#2867b2",
          stationIds: [...stationIds],
          vehicleIds: [],
          active: distinctValidStationCount(state, stationIds) >= 2,
        },
      ],
    },
  };
}

export function assignVehicle(
  state: GameState,
  mode: "bus" | "metro",
  lineId: string,
): GameState {
  const cost = COSTS[mode];

  if (!canAfford(state, cost)) {
    return state;
  }

  const vehicle: Vehicle = {
    id: nextEntityId(
      "vehicle",
      state.transit.vehicles.map((vehicle) => vehicle.id),
    ),
    mode,
    lineId,
    capacity: mode === "bus" ? 18 : 90,
    passengerIds: [],
    segmentIndex: 0,
    progress: 0,
  };

  if (mode === "bus") {
    const route = state.transit.routes.find(
      (candidate) => candidate.id === lineId,
    );

    if (route === undefined || !route.active) {
      return state;
    }

    return {
      ...state,
      budget: state.budget - cost,
      transit: {
        ...state.transit,
        routes: state.transit.routes.map((candidate) =>
          candidate.id === lineId
            ? {
                ...candidate,
                vehicleIds: [...candidate.vehicleIds, vehicle.id],
              }
            : candidate,
        ),
        vehicles: [...state.transit.vehicles, vehicle],
      },
    };
  }

  const metroLine = state.transit.metroLines.find(
    (candidate) => candidate.id === lineId,
  );

  if (metroLine === undefined || !metroLine.active) {
    return state;
  }

  return {
    ...state,
    budget: state.budget - cost,
    transit: {
      ...state.transit,
      metroLines: state.transit.metroLines.map((candidate) =>
        candidate.id === lineId
          ? { ...candidate, vehicleIds: [...candidate.vehicleIds, vehicle.id] }
          : candidate,
      ),
      vehicles: [...state.transit.vehicles, vehicle],
    },
  };
}

export function tickVehicles(
  state: GameState,
  deltaSeconds: number,
): GameState {
  let citizens = state.citizens;
  const occupiedPassengerIds = new Set(
    state.transit.vehicles.flatMap((vehicle) =>
      uniquePassengerIds(vehicle.passengerIds),
    ),
  );
  let changed = false;

  const vehicles = state.transit.vehicles.map((vehicle) => {
    const linePositions = assignedLinePositions(state, vehicle);

    if (linePositions === null || linePositions.length < 2) {
      return vehicle;
    }

    const currentPosition =
      linePositions[vehicle.segmentIndex % linePositions.length];
    const boarded =
      vehicle.progress === 0
        ? boardVehicle(citizens, vehicle, currentPosition, occupiedPassengerIds)
        : { citizens, vehicle };
    citizens = boarded.citizens;

    const speed = vehicle.mode === "bus" ? 0.08 : 0.14;
    const progress = boarded.vehicle.progress + speed * deltaSeconds;

    if (progress < 1) {
      const nextVehicle = { ...boarded.vehicle, progress };
      changed = changed || nextVehicle !== vehicle;
      return nextVehicle;
    }

    const reachedPosition =
      linePositions[(vehicle.segmentIndex + 1) % linePositions.length];
    const disembarked = disembarkVehicle(
      citizens,
      { ...boarded.vehicle, progress },
      reachedPosition,
      linePositions.length,
    );
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
      vehicles,
    },
  };
}
