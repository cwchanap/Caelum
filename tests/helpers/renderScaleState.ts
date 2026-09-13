import type { GameState } from "../../src/domain/types";
import {
  addTestBusRoute,
  addTestBusStop,
  addTestMetroLine,
  addTestMetroStation,
  assignTestVehicle,
  createTestGameState,
  placeTestBuilding,
} from "./gameState";
import { pointsOnRow, withAreas, withRoads, withTracks } from "./mapFixtures";

const ROAD_ROW = pointsOnRow(4, 2, 12);
const TRACK_ROW = pointsOnRow(9, 3, 13);
const BUS_STOP_TILES = [
  { x: 3, y: 4 },
  { x: 8, y: 4 },
  { x: 11, y: 4 },
];
const STATION_TILES = [
  { x: 4, y: 9 },
  { x: 12, y: 9 },
];

/** Spread the synthetic fleet along its authored paths so the fixture
 *  exercises per-vehicle path sampling instead of stacking every vehicle at
 *  one terminus. */
function distributeAlongPaths(state: GameState): GameState {
  const lineById = new Map(
    [...state.transit.routes, ...state.transit.metroLines].map((line) => [
      line.id,
      line,
    ]),
  );
  return {
    ...state,
    transit: {
      ...state.transit,
      vehicles: state.transit.vehicles.map((vehicle, index) => {
        const line = lineById.get(vehicle.lineId);
        const leg =
          line?.legs[index % Math.max(1, line.legs.length)] ?? undefined;
        const stepCount = Math.max(1, leg?.currentPath?.steps.length ?? 1);
        return {
          ...vehicle,
          itineraryIndex: index % Math.max(1, line?.legs.length ?? 1),
          pathStepIndex: index % stepCount,
          stepProgress: ((index % 6) + 1) / 8,
        };
      }),
    },
  };
}

function withScaledFleet(state: GameState, vehicleCount: number): GameState {
  const busRoute = state.transit.routes[0];
  const metroLine = state.transit.metroLines[0];
  if (busRoute === undefined || metroLine === undefined) {
    throw new Error(
      "render scale fixture requires one bus route and one metro line",
    );
  }
  let next = state;
  for (let index = 0; index < vehicleCount; index += 1) {
    next =
      index % 2 === 0
        ? assignTestVehicle(next, "bus", busRoute.id)
        : assignTestVehicle(next, "metro", metroLine.id);
  }
  return distributeAlongPaths(next);
}

/** Demand destinations, traffic densities, and platform crowding derived from
 *  the placed buildings and transit nodes so every presentation row is
 *  non-empty. */
function withPresentationRows(state: GameState): GameState {
  return {
    ...state,
    demandFlow: state.buildings.map((building, index) => ({
      point: building.origin,
      count: (index % 3) + 1,
    })),
    trafficFlow: ROAD_ROW.map((point, index) => ({
      point,
      flow: (index % 12) + 1,
    })),
    platformOccupancy: [
      ...state.transit.stops,
      ...state.transit.stations,
    ].flatMap((node) =>
      node.platforms.map((platform, index) => ({
        platformId: platform.id,
        count: (index % 3) + 1,
        capacity: platform.capacity,
      })),
    ),
  };
}

/**
 * Renderer-only scale fixture: a small authored city (road row, track row,
 * zoning, buildings, one connected bus route and metro line) plus a synthetic
 * transit fleet of exactly `vehicleCount` vehicles composed from repeated
 * transit rows. This is a render stress proxy — no Rust simulation actors are
 * created.
 */
export function buildRenderScaleState(vehicleCount: number): GameState {
  let state = withAreas(
    createTestGameState(),
    "residential",
    pointsOnRow(2, 4, 11),
  );
  state = withRoads(state, ROAD_ROW);
  state = withTracks(state, TRACK_ROW);
  for (const tile of BUS_STOP_TILES) {
    state = addTestBusStop(state, tile);
  }
  for (const tile of STATION_TILES) {
    state = addTestMetroStation(state, tile);
  }
  state = addTestBusRoute(
    state,
    state.transit.stops.map((stop) => stop.id),
  );
  state = addTestMetroLine(
    state,
    state.transit.stations.map((station) => station.id),
  );
  state = placeTestBuilding(state, "busTerminal", { x: 16, y: 4 }, 90);
  state = placeTestBuilding(state, "smallHouse", { x: 5, y: 2 }, 0);
  state = placeTestBuilding(state, "smallHouse", { x: 8, y: 2 }, 0);
  state = withPresentationRows(state);
  return withScaledFleet(state, vehicleCount);
}
