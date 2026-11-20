import type { GameState, Point } from "../../src/domain/types";
import {
  addTestBusRoute,
  addTestBusStop,
  addTestMetroLine,
  addTestMetroStation,
  assignTestVehicle,
  createTestGameState,
  createTestMap,
  placeTestBuilding,
} from "./gameState";
import { pointsOnRow, withAreas, withRoads, withTracks } from "./mapFixtures";
import { MAP_SIZES } from "../../src/scenario/sandbox";

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

export type RenderScaleMapSize = "small" | "large";

export interface RenderScaleOptions {
  mapSize?: RenderScaleMapSize;
}

/** Deterministic large-board road grid: four verticals crossing three
 *  horizontals, forming city blocks across the 84x54 map. Transit keeps its
 *  own small backbone row (ROAD_ROW), so these carry no stops and stay
 *  intentionally disconnected from it. */
const GRID_VERTICAL_XS = [20, 40, 60, 81];
const GRID_HORIZONTAL_YS = [20, 36, 52];

function largeGridRoadPoints(): Point[] {
  const points: Point[] = [];
  for (const x of GRID_VERTICAL_XS) {
    for (let y = 2; y <= 52; y += 1) points.push({ x, y });
  }
  for (const y of GRID_HORIZONTAL_YS) {
    for (let x = 2; x <= 81; x += 1) points.push({ x, y });
  }
  return points;
}

/** Small houses on the block edge above each horizontal grid road, stepping
 *  every 8 tiles and skipping vertical-road columns (footprints are 2 wide). */
function largeGridHouseOrigins(): Point[] {
  const origins: Point[] = [];
  for (const y of GRID_HORIZONTAL_YS) {
    for (let x = 5; x <= 78; x += 8) {
      if (GRID_VERTICAL_XS.some((road) => road === x || road === x + 1)) {
        continue;
      }
      origins.push({ x, y: y - 1 });
    }
  }
  return origins;
}

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
 *
 * With `{ mapSize: "large" }` that single construction path builds the same
 * transit backbone on the full 84x54 large board plus a deterministic road
 * grid and block-edge houses, so the thousands of remaining empty tiles render
 * as deterministic hash-placed trees — quantifying the large map's structural
 * rendering cost.
 */
export function buildRenderScaleState(
  vehicleCount: number,
  options: RenderScaleOptions = {},
): GameState {
  const large = options.mapSize === "large";
  const base = large
    ? {
        ...createTestGameState({
          budget: 1_000_000,
          rules: {
            economyPreset: "standard",
            sandbox: {
              templateId: "crossroads",
              mapSize: "large",
              startingCapital: 120_000,
              demandMultiplier: 1,
            },
          },
        }),
        map: createTestMap(MAP_SIZES.large.width, MAP_SIZES.large.height),
      }
    : createTestGameState();
  let state = withAreas(base, "residential", pointsOnRow(2, 4, 11));
  // One withRoads call over the union so shared tiles keep reciprocal
  // connections across backbone and grid roads.
  state = withRoads(
    state,
    large ? [...ROAD_ROW, ...largeGridRoadPoints()] : ROAD_ROW,
  );
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
  if (large) {
    for (const origin of largeGridHouseOrigins()) {
      state = placeTestBuilding(state, "smallHouse", origin, 0);
    }
  }
  state = withPresentationRows(state);
  return withScaledFleet(state, vehicleCount);
}
