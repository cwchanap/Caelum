import { nextEntityId } from "../domain/ids";
import type {
  Citizen,
  GameMap,
  GameState,
  Platform,
  Point,
  Route,
  MetroLine,
  Stop,
  StopKind,
  Vehicle,
} from "../domain/types";
import { isValidBusStopPlacement, isValidMetroStationPlacement } from "./map";
import { computeRouteSegments, hasBrokenSegment } from "./network";
import {
  busPlatforms,
  metroPlatforms,
  onPlatformCitizenIds,
  platformWaiterIds,
} from "./platforms";

export const COSTS = {
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

export function distinctValidStopCount(
  state: GameState,
  stopIds: string[],
): number {
  const existingStopIds = new Set(state.transit.stops.map((stop) => stop.id));

  return new Set(stopIds.filter((stopId) => existingStopIds.has(stopId))).size;
}

export function distinctValidStationCount(
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

function positionKey(x: number, y: number): string {
  return `${x},${y}`;
}

function assignRouteToLeastLoaded<
  T extends { id: string; platforms: Platform[] },
>(nodes: T[], nodeIds: string[], routeId: string): T[] {
  const targetIds = new Set(nodeIds);

  return nodes.map((node) => {
    if (!targetIds.has(node.id) || node.platforms.length === 0) {
      return node;
    }

    let bestIndex = 0;
    for (let index = 1; index < node.platforms.length; index += 1) {
      if (
        node.platforms[index].routeIds.length <
        node.platforms[bestIndex].routeIds.length
      ) {
        bestIndex = index;
      }
    }

    return {
      ...node,
      platforms: node.platforms.map((platform, index) =>
        index === bestIndex
          ? { ...platform, routeIds: [...platform.routeIds, routeId] }
          : platform,
      ),
    };
  });
}

function reassignWithinNode<T extends { id: string; platforms: Platform[] }>(
  nodes: T[],
  nodeId: string,
  routeId: string,
  platformId: string,
): T[] | null {
  const node = nodes.find((candidate) => candidate.id === nodeId);
  if (node === undefined) {
    return null;
  }

  const target = node.platforms.find((platform) => platform.id === platformId);
  const holdsRoute = node.platforms.some((platform) =>
    platform.routeIds.includes(routeId),
  );
  if (
    target === undefined ||
    !holdsRoute ||
    target.routeIds.includes(routeId)
  ) {
    return null;
  }

  return nodes.map((candidate) =>
    candidate.id !== nodeId
      ? candidate
      : {
          ...candidate,
          platforms: candidate.platforms.map((platform) => {
            if (platform.id === platformId) {
              return { ...platform, routeIds: [...platform.routeIds, routeId] };
            }
            return platform.routeIds.includes(routeId)
              ? {
                  ...platform,
                  routeIds: platform.routeIds.filter((id) => id !== routeId),
                }
              : platform;
          }),
        },
  );
}

export function assignRouteToPlatform(
  state: GameState,
  nodeId: string,
  routeId: string,
  platformId: string,
): GameState {
  const stops = reassignWithinNode(
    state.transit.stops,
    nodeId,
    routeId,
    platformId,
  );
  if (stops !== null) {
    return { ...state, transit: { ...state.transit, stops } };
  }

  const stations = reassignWithinNode(
    state.transit.stations,
    nodeId,
    routeId,
    platformId,
  );
  if (stations !== null) {
    return { ...state, transit: { ...state.transit, stations } };
  }

  return state;
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
      !route.pathBroken &&
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
    !metroLine.pathBroken &&
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
  onPlatform: Set<string>,
): boolean {
  if (
    citizen.status !== "waiting" ||
    occupiedPassengerIds.has(citizen.id) ||
    !onPlatform.has(citizen.id)
  ) {
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
  onPlatform: Set<string>,
  waiterOrder: readonly string[],
): { citizens: Citizen[]; vehicle: Vehicle } {
  const passengerIds = uniquePassengerIds(vehicle.passengerIds);
  const availableSeats = Math.max(0, vehicle.capacity - passengerIds.length);

  if (availableSeats === 0) {
    return { citizens, vehicle: { ...vehicle, passengerIds } };
  }

  const citizenById = new Map(citizens.map((c) => [c.id, c]));
  const boardingCitizenIds: string[] = [];

  for (const citizenId of waiterOrder) {
    if (boardingCitizenIds.length >= availableSeats) {
      break;
    }

    const citizen = citizenById.get(citizenId);
    if (citizen === undefined) {
      continue;
    }

    if (
      citizenCanBoard(
        citizen,
        vehicle,
        currentPosition,
        occupiedPassengerIds,
        onPlatform,
      )
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

/**
 * Resolve a line's stop/station ids to positions and compute its tile-path
 * segments in one place. Returns an empty `positions`/`segments` pair when
 * any id no longer maps to a node (the line stays inactive/broken).
 */
function resolveLineSegments(
  map: GameMap,
  ids: string[],
  positionById: Map<string, Point>,
  mode: "bus" | "metro",
): { positions: Point[]; segments: Point[][] } {
  const positions = ids
    .map((id) => positionById.get(id))
    .filter((position): position is Point => position !== undefined)
    .map(clonePoint);
  const segments =
    positions.length === ids.length
      ? computeRouteSegments(map, positions, mode)
      : [];

  return { positions, segments };
}

export function addBusRoute(state: GameState, stopIds: string[]): GameState {
  const routeId = nextEntityId(
    "route",
    state.transit.routes.map((route) => route.id),
  );
  const routeNumber = entityNumberFromId("route", routeId);
  const distinctStopIds = Array.from(new Set(stopIds));
  const active = distinctValidStopCount(state, stopIds) >= 2;

  const stopPositionById = new Map(
    state.transit.stops.map((stop) => [stop.id, stop.position]),
  );
  const { segments } = resolveLineSegments(
    state.map,
    stopIds,
    stopPositionById,
    "bus",
  );

  return {
    ...state,
    transit: {
      ...state.transit,
      stops: active
        ? assignRouteToLeastLoaded(
            state.transit.stops,
            distinctStopIds,
            routeId,
          )
        : state.transit.stops,
      routes: [
        ...state.transit.routes,
        {
          id: routeId,
          name: `Bus ${routeNumber}`,
          color: "#e04f39",
          stopIds: [...stopIds],
          vehicleIds: [],
          active,
          segments,
          pathBroken: hasBrokenSegment(segments),
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
  const distinctStationIds = Array.from(new Set(stationIds));
  const active = distinctValidStationCount(state, stationIds) >= 2;

  const stationPositionById = new Map(
    state.transit.stations.map((station) => [station.id, station.position]),
  );
  const { segments } = resolveLineSegments(
    state.map,
    stationIds,
    stationPositionById,
    "metro",
  );

  return {
    ...state,
    transit: {
      ...state.transit,
      stations: active
        ? assignRouteToLeastLoaded(
            state.transit.stations,
            distinctStationIds,
            lineId,
          )
        : state.transit.stations,
      metroLines: [
        ...state.transit.metroLines,
        {
          id: lineId,
          name: `Metro ${lineNumber}`,
          color: "#2867b2",
          stationIds: [...stationIds],
          vehicleIds: [],
          active,
          segments,
          pathBroken: hasBrokenSegment(segments),
        },
      ],
    },
  };
}

function stripRouteFromPlatforms<
  T extends { platforms: { routeIds: string[] }[] },
>(nodes: T[], routeId: string): T[] {
  let anyChanged = false;
  const mapped = nodes.map((node) => {
    let changed = false;
    const platforms = node.platforms.map((platform) => {
      if (!platform.routeIds.includes(routeId)) {
        return platform;
      }
      changed = true;
      return {
        ...platform,
        routeIds: platform.routeIds.filter((id) => id !== routeId),
      };
    });
    if (changed) {
      anyChanged = true;
      return { ...node, platforms };
    }
    return node;
  });
  return anyChanged ? mapped : nodes;
}

function planReferencesLine(
  routePlan: Citizen["routePlan"],
  lineId: string,
): boolean {
  if (routePlan === null) {
    return false;
  }
  return routePlan.legs.some(
    (leg) => leg.mode !== "walk" && leg.lineId === lineId,
  );
}

function invalidatePlansForLine(
  citizens: Citizen[],
  lineId: string,
): Citizen[] {
  let anyChanged = false;
  const mapped = citizens.map((citizen) => {
    if (!planReferencesLine(citizen.routePlan, lineId)) {
      return citizen;
    }
    anyChanged = true;
    // Drop the stale plan and return the citizen to idle so tickCitizen
    // replans from scratch on the next tick. Riding citizens whose vehicle
    // vanished are already covered by tickCitizen's vehicle-presence check,
    // but resetting them here keeps the post-delete state consistent
    // regardless of tick order.
    return {
      ...citizen,
      status: "idle" as const,
      routePlan: null,
      currentLegIndex: 0,
    };
  });
  return anyChanged ? mapped : citizens;
}

/**
 * Refresh segments/pathBroken on every route and metro line against the
 * current map. On the transition into broken, vehicles park at their current
 * segment's starting stop with no passengers, and every citizen whose plan
 * references the line replans (riders are repositioned to the parked stop
 * via `invalidatePlansForLine`). Call after any road/track change. Always
 * returns a new state; only call when the map actually changed.
 */
export function recomputeRoutePaths(state: GameState): GameState {
  const stopPositionById = new Map(
    state.transit.stops.map((stop) => [stop.id, stop.position]),
  );
  const stationPositionById = new Map(
    state.transit.stations.map((station) => [station.id, station.position]),
  );

  let citizens = state.citizens;
  let vehicles = state.transit.vehicles;

  const refreshLine = <T extends Route | MetroLine>(
    line: T,
    nodeIds: string[],
    positionById: Map<string, Point>,
    mode: "bus" | "metro",
  ): T => {
    const { positions, segments } = resolveLineSegments(
      state.map,
      nodeIds,
      positionById,
      mode,
    );
    const pathBroken = hasBrokenSegment(segments);

    if (pathBroken && !line.pathBroken) {
      const parkedPositionByCitizenId = new Map<string, Point>();
      vehicles = vehicles.map((vehicle) => {
        if (vehicle.lineId !== line.id) {
          return vehicle;
        }
        const parkedAt =
          positions.length === 0
            ? undefined
            : positions[vehicle.segmentIndex % positions.length];
        if (parkedAt !== undefined) {
          for (const passengerId of vehicle.passengerIds) {
            parkedPositionByCitizenId.set(passengerId, parkedAt);
          }
        }
        return { ...vehicle, passengerIds: [], progress: 0 };
      });
      citizens = invalidatePlansForLine(citizens, line.id).map((citizen) => {
        const parkedAt = parkedPositionByCitizenId.get(citizen.id);
        return parkedAt === undefined
          ? citizen
          : { ...citizen, position: clonePoint(parkedAt) };
      });
    }

    return { ...line, segments, pathBroken };
  };

  const routes = state.transit.routes.map((route) =>
    refreshLine(route, route.stopIds, stopPositionById, "bus"),
  );
  const metroLines = state.transit.metroLines.map((line) =>
    refreshLine(line, line.stationIds, stationPositionById, "metro"),
  );

  return {
    ...state,
    citizens,
    transit: { ...state.transit, routes, metroLines, vehicles },
  };
}

export function deleteRoute(state: GameState, routeId: string): GameState {
  const isRoute = state.transit.routes.some((r) => r.id === routeId);
  const isLine = state.transit.metroLines.some((l) => l.id === routeId);
  if (!isRoute && !isLine) {
    return state;
  }

  return {
    ...state,
    transit: {
      ...state.transit,
      stops: isRoute
        ? stripRouteFromPlatforms(state.transit.stops, routeId)
        : state.transit.stops,
      stations: isLine
        ? stripRouteFromPlatforms(state.transit.stations, routeId)
        : state.transit.stations,
      routes: isRoute
        ? state.transit.routes.filter((r) => r.id !== routeId)
        : state.transit.routes,
      metroLines: isLine
        ? state.transit.metroLines.filter((l) => l.id !== routeId)
        : state.transit.metroLines,
      vehicles: state.transit.vehicles.filter((v) => v.lineId !== routeId),
    },
    citizens: invalidatePlansForLine(state.citizens, routeId),
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

    if (route === undefined || !route.active || route.pathBroken) {
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

  if (metroLine === undefined || !metroLine.active || metroLine.pathBroken) {
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

function autoName(kind: "bus" | "metro", id: string): string {
  return kind === "bus"
    ? `Bus ${entityNumberFromId("route", id)}`
    : `Metro ${entityNumberFromId("metro", id)}`;
}

export function renameRoute(
  state: GameState,
  routeId: string,
  name: string,
): GameState {
  const trimmed = name.trim();

  const route = state.transit.routes.find((r) => r.id === routeId);
  if (route !== undefined) {
    const finalName = trimmed === "" ? autoName("bus", routeId) : trimmed;
    if (route.name === finalName) {
      return state;
    }
    return {
      ...state,
      transit: {
        ...state.transit,
        routes: state.transit.routes.map((r) =>
          r.id === routeId ? { ...r, name: finalName } : r,
        ),
      },
    };
  }

  const line = state.transit.metroLines.find((l) => l.id === routeId);
  if (line !== undefined) {
    const finalName = trimmed === "" ? autoName("metro", routeId) : trimmed;
    if (line.name === finalName) {
      return state;
    }
    return {
      ...state,
      transit: {
        ...state.transit,
        metroLines: state.transit.metroLines.map((l) =>
          l.id === routeId ? { ...l, name: finalName } : l,
        ),
      },
    };
  }

  // Unreachable in normal flow: the controller always has a live route in
  // hand by the time it calls rename. Surface the miss so a stale-id bug
  // (e.g. a route deleted while its rename input is focused) is discoverable
  // instead of silently dropping the typed name.
  console.warn("renameRoute: unknown routeId", routeId);
  return state;
}

export function setRouteColor(
  state: GameState,
  routeId: string,
  color: string,
): GameState {
  const route = state.transit.routes.find((r) => r.id === routeId);
  if (route !== undefined) {
    if (route.color === color) {
      return state;
    }
    return {
      ...state,
      transit: {
        ...state.transit,
        routes: state.transit.routes.map((r) =>
          r.id === routeId ? { ...r, color } : r,
        ),
      },
    };
  }
  const line = state.transit.metroLines.find((l) => l.id === routeId);
  if (line !== undefined) {
    if (line.color === color) {
      return state;
    }
    return {
      ...state,
      transit: {
        ...state.transit,
        metroLines: state.transit.metroLines.map((l) =>
          l.id === routeId ? { ...l, color } : l,
        ),
      },
    };
  }
  // See renameRoute: surface stale-id so the no-op is observable.
  console.warn("setRouteColor: unknown routeId", routeId);
  return state;
}

export function setRouteActive(
  state: GameState,
  routeId: string,
  active: boolean,
): GameState {
  const route = state.transit.routes.find((r) => r.id === routeId);
  if (route !== undefined) {
    if (route.active === active) {
      return state;
    }
    return {
      ...state,
      transit: {
        ...state.transit,
        routes: state.transit.routes.map((r) =>
          r.id === routeId ? { ...r, active } : r,
        ),
      },
    };
  }
  const line = state.transit.metroLines.find((l) => l.id === routeId);
  if (line !== undefined) {
    if (line.active === active) {
      return state;
    }
    return {
      ...state,
      transit: {
        ...state.transit,
        metroLines: state.transit.metroLines.map((l) =>
          l.id === routeId ? { ...l, active } : l,
        ),
      },
    };
  }
  return state;
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
  // Computed once from tick-start state so the cap is enforced
  // independently of vehicle iteration order (deterministic).
  const onPlatform = onPlatformCitizenIds(state);
  const waiterIdsByPlatform = platformWaiterIds(state);
  let changed = false;

  // Build a lookup: `${posKey}|${lineId}` → ordered citizen ids
  // (concatenation of all platform waiter lists at that position for that line).
  const nodes = [...state.transit.stops, ...state.transit.stations];
  const waiterOrderLookup = new Map<string, string[]>();
  for (const node of nodes) {
    const posKey = positionKey(node.position.x, node.position.y);
    for (const platform of node.platforms) {
      for (const routeId of platform.routeIds) {
        const key = `${posKey}|${routeId}`;
        const existing = waiterOrderLookup.get(key);
        const ids = waiterIdsByPlatform.get(platform.id) ?? [];
        if (existing === undefined) {
          waiterOrderLookup.set(key, [...ids]);
        } else {
          existing.push(...ids);
        }
      }
    }
  }

  const vehicles = state.transit.vehicles.map((vehicle) => {
    const linePositions = assignedLinePositions(state, vehicle);

    if (linePositions === null || linePositions.length < 2) {
      return vehicle;
    }

    const currentPosition =
      linePositions[vehicle.segmentIndex % linePositions.length];
    const waiterOrder =
      waiterOrderLookup.get(
        `${positionKey(currentPosition.x, currentPosition.y)}|${vehicle.lineId}`,
      ) ?? [];
    const boarded =
      vehicle.progress === 0
        ? boardVehicle(
            citizens,
            vehicle,
            currentPosition,
            occupiedPassengerIds,
            onPlatform,
            waiterOrder,
          )
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
