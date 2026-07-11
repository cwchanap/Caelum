import { entityId, tileId } from "../../src/domain/ids";
import {
  BUILDING_CATALOG,
  getBuildingFootprint,
} from "../../src/domain/catalog/buildings";
import type {
  BuildingRotation,
  BuildingType,
  GameMap,
  GameState,
  MetroLine,
  PlacedBuilding,
  Point,
  Route,
  Station,
  Stop,
  StopKind,
  Vehicle,
} from "../../src/domain/types";
import { normalizeRustSnapshot } from "../../src/runtime/snapshotView";
import { findTilePath } from "../../src/ui/tilePath";
import { ROUTE_COLOR_PALETTE } from "../../src/ui/routePalette";
import { createRustSnapshot } from "../fixtures/rustSnapshot";

function clonePoint(point: Point): Point {
  return { x: point.x, y: point.y };
}

function createEmptyMap(width = 28, height = 18): GameMap {
  const tiles: GameMap["tiles"] = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      tiles.push({
        id: tileId(x, y),
        x,
        y,
        kind: "empty",
        roadConnections: [],
      });
    }
  }
  return { width, height, tiles, roadStructures: [] };
}

function busPlatforms(id: string, kind: StopKind) {
  const count = kind === "busTerminal" ? 3 : 1;
  const capacity = kind === "busTerminal" ? 80 : 50;
  return Array.from({ length: count }, (_, index) => ({
    id: `${id}-p${index}`,
    label: String.fromCharCode("A".charCodeAt(0) + index),
    capacity,
    routeIds: [],
  }));
}

function metroPlatforms(id: string) {
  return [
    { id: `${id}-p0`, label: "A", capacity: 300, routeIds: [] },
    { id: `${id}-p1`, label: "B", capacity: 300, routeIds: [] },
  ];
}

function nextId(prefix: string, count: number): string {
  return entityId(prefix, count + 1);
}

function assignRouteToLeastLoaded<
  T extends { id: string; platforms: Stop["platforms"] },
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

function routeSegments(
  map: GameMap,
  positions: Point[],
  mode: "bus" | "metro",
): Point[][] {
  if (positions.length < 2) {
    return [];
  }
  return positions.map((from, index) => {
    const to = positions[(index + 1) % positions.length];
    return findTilePath(map, from, to, mode) ?? [];
  });
}

export function createTestGameState(
  overrides: Partial<GameState> = {},
): GameState {
  const base = normalizeRustSnapshot(
    createRustSnapshot({
      map: createEmptyMap(),
    }),
  );
  return {
    ...base,
    ...overrides,
    metrics:
      overrides.metrics === undefined
        ? base.metrics
        : { ...base.metrics, ...overrides.metrics },
    transit:
      overrides.transit === undefined
        ? base.transit
        : { ...base.transit, ...overrides.transit },
    scenario:
      overrides.scenario === undefined
        ? base.scenario
        : { ...base.scenario, ...overrides.scenario },
  };
}

export function addTestBusStop(
  state: GameState,
  position: Point,
  kind: StopKind = "busStop",
): GameState {
  const id = nextId("stop", state.transit.stops.length);
  const stop: Stop = {
    id,
    kind,
    position: clonePoint(position),
    platforms: busPlatforms(id, kind),
  };
  return {
    ...state,
    transit: {
      ...state.transit,
      stops: [...state.transit.stops, stop],
    },
  };
}

export function addTestMetroStation(
  state: GameState,
  position: Point,
): GameState {
  const id = nextId("station", state.transit.stations.length);
  const station: Station = {
    id,
    position: clonePoint(position),
    platforms: metroPlatforms(id),
  };
  return {
    ...state,
    transit: {
      ...state.transit,
      stations: [...state.transit.stations, station],
    },
  };
}

export function addTestBusRoute(
  state: GameState,
  stopIds: string[],
): GameState {
  const id = nextId("route", state.transit.routes.length);
  const stopById = new Map(
    state.transit.stops.map((stop) => [stop.id, stop.position]),
  );
  const positions = stopIds.flatMap((stopId) => {
    const position = stopById.get(stopId);
    return position === undefined ? [] : [position];
  });
  const segments = routeSegments(state.map, positions, "bus");
  const route: Route = {
    id,
    name: `Bus ${state.transit.routes.length + 1}`,
    color:
      ROUTE_COLOR_PALETTE[
        state.transit.routes.length % ROUTE_COLOR_PALETTE.length
      ],
    stopIds,
    vehicleIds: [],
    active: true,
    segments,
    pathBroken: segments.some((segment) => segment.length === 0),
  };
  return {
    ...state,
    transit: {
      ...state.transit,
      stops: assignRouteToLeastLoaded(state.transit.stops, stopIds, id),
      routes: [...state.transit.routes, route],
    },
  };
}

export function addTestMetroLine(
  state: GameState,
  stationIds: string[],
): GameState {
  const id = nextId("metro", state.transit.metroLines.length);
  const stationById = new Map(
    state.transit.stations.map((station) => [station.id, station.position]),
  );
  const positions = stationIds.flatMap((stationId) => {
    const position = stationById.get(stationId);
    return position === undefined ? [] : [position];
  });
  const segments = routeSegments(state.map, positions, "metro");
  const line: MetroLine = {
    id,
    name: `Metro ${state.transit.metroLines.length + 1}`,
    color:
      ROUTE_COLOR_PALETTE[
        (state.transit.metroLines.length + 1) % ROUTE_COLOR_PALETTE.length
      ],
    stationIds,
    vehicleIds: [],
    active: true,
    segments,
    pathBroken: segments.some((segment) => segment.length === 0),
  };
  return {
    ...state,
    transit: {
      ...state.transit,
      stations: assignRouteToLeastLoaded(
        state.transit.stations,
        stationIds,
        id,
      ),
      metroLines: [...state.transit.metroLines, line],
    },
  };
}

export function assignTestVehicle(
  state: GameState,
  mode: "bus" | "metro",
  lineId: string,
): GameState {
  const id = nextId("vehicle", state.transit.vehicles.length);
  const vehicle: Vehicle = {
    id,
    mode,
    lineId,
    capacity: mode === "bus" ? 30 : 120,
    passengerIds: [],
    segmentIndex: 0,
    progress: 0,
  };
  const transit =
    mode === "bus"
      ? {
          ...state.transit,
          vehicles: [...state.transit.vehicles, vehicle],
          routes: state.transit.routes.map((route) =>
            route.id === lineId
              ? { ...route, vehicleIds: [...route.vehicleIds, id] }
              : route,
          ),
        }
      : {
          ...state.transit,
          vehicles: [...state.transit.vehicles, vehicle],
          metroLines: state.transit.metroLines.map((line) =>
            line.id === lineId
              ? { ...line, vehicleIds: [...line.vehicleIds, id] }
              : line,
          ),
        };

  return { ...state, transit };
}

export function removeTestInfrastructureAtTile(
  state: GameState,
  point: Point,
): GameState {
  const nextMap: GameMap = {
    ...state.map,
    tiles: state.map.tiles.map((tile) => {
      if (tile.x !== point.x || tile.y !== point.y) {
        return tile;
      }
      const {
        oneWay: _oneWay,
        roadStructureId: _roadStructureId,
        ...rest
      } = tile;
      return {
        ...rest,
        kind: "empty" as const,
        hasTrack: false,
        roadConnections: [],
      };
    }),
  };
  const routeById = new Map(
    state.transit.routes.map((route) => [route.id, route]),
  );
  const lineById = new Map(
    state.transit.metroLines.map((line) => [line.id, line]),
  );

  let nextState: GameState = { ...state, map: nextMap };
  nextState = {
    ...nextState,
    transit: {
      ...nextState.transit,
      routes: nextState.transit.routes.map((route) => {
        const stopById = new Map(
          nextState.transit.stops.map((stop) => [stop.id, stop.position]),
        );
        const positions = route.stopIds.flatMap((stopId) => {
          const position = stopById.get(stopId);
          return position === undefined ? [] : [position];
        });
        const segments = routeSegments(nextMap, positions, "bus");
        return {
          ...(routeById.get(route.id) ?? route),
          segments,
          pathBroken: segments.some((segment) => segment.length === 0),
        };
      }),
      metroLines: nextState.transit.metroLines.map((line) => {
        const stationById = new Map(
          nextState.transit.stations.map((station) => [
            station.id,
            station.position,
          ]),
        );
        const positions = line.stationIds.flatMap((stationId) => {
          const position = stationById.get(stationId);
          return position === undefined ? [] : [position];
        });
        const segments = routeSegments(nextMap, positions, "metro");
        return {
          ...(lineById.get(line.id) ?? line),
          segments,
          pathBroken: segments.some((segment) => segment.length === 0),
        };
      }),
    },
  };
  return nextState;
}

export function placeTestBuilding(
  state: GameState,
  type: BuildingType,
  origin: Point,
  rotation: BuildingRotation,
): GameState {
  const definition = BUILDING_CATALOG[type];
  const id = nextId("building", state.buildings.length);
  const occupiedTiles = getBuildingFootprint(type, origin, rotation);
  let transit = state.transit;
  let transitNodeId: string | undefined;

  if (definition.effect === "busStop" || definition.effect === "busTerminal") {
    const stopId = nextId("stop", state.transit.stops.length);
    transitNodeId = stopId;
    transit = {
      ...transit,
      stops: [
        ...transit.stops,
        {
          id: stopId,
          kind: definition.effect,
          position: clonePoint(origin),
          platforms: busPlatforms(stopId, definition.effect),
        },
      ],
    };
  }

  if (definition.effect === "metroStation") {
    const stationId = nextId("station", state.transit.stations.length);
    transitNodeId = stationId;
    transit = {
      ...transit,
      stations: [
        ...transit.stations,
        {
          id: stationId,
          position: clonePoint(origin),
          platforms: metroPlatforms(stationId),
        },
      ],
    };
  }

  const building: PlacedBuilding = {
    id,
    type,
    origin: clonePoint(origin),
    rotation,
    occupiedTiles: occupiedTiles.map(clonePoint),
    ...(transitNodeId === undefined ? {} : { transitNodeId }),
  };

  return {
    ...state,
    budget: state.budget - definition.cost,
    buildings: [...state.buildings, building],
    transit,
  };
}
