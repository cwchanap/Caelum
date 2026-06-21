import { entityId, nextEntityId } from "../domain/ids";
import type {
  BuildingRotation,
  BuildingType,
  Citizen,
  GameState,
  PlacedBuilding,
  Point,
} from "../domain/types";
import { BUILDING_CATALOG } from "./buildingCatalog";
import { destinationPoints } from "./buildingSelectors";
import { getTile } from "./map";
import { busPlatforms, metroPlatforms } from "./platforms";

// Re-export so existing consumers can keep importing the catalog and its
// types from buildings.ts. The definitions live in buildingCatalog.ts to
// break the buildings.ts <-> buildingSelectors.ts <-> map.ts import cycle
// (buildingSelectors.ts needs BUILDING_CATALOG but buildings.ts needs
// destinationPoints from buildingSelectors.ts).
export {
  BUILDING_CATALOG,
  type BuildingDefinition,
  type BuildingEffect,
} from "./buildingCatalog";

export function getRotatedFootprintSize(
  type: BuildingType,
  rotation: BuildingRotation,
): { width: number; height: number } {
  const definition = BUILDING_CATALOG[type];
  return rotation === 90 || rotation === 270
    ? { width: definition.height, height: definition.width }
    : { width: definition.width, height: definition.height };
}

export function getBuildingFootprint(
  type: BuildingType,
  origin: Point,
  rotation: BuildingRotation,
): Point[] {
  const size = getRotatedFootprintSize(type, rotation);
  const points: Point[] = [];

  for (let y = 0; y < size.height; y += 1) {
    for (let x = 0; x < size.width; x += 1) {
      points.push({ x: origin.x + x, y: origin.y + y });
    }
  }

  return points;
}

function samePoint(left: Point, right: Point): boolean {
  return left.x === right.x && left.y === right.y;
}

function clonePoint(point: Point): Point {
  return { x: point.x, y: point.y };
}

function createHousingCitizens(
  state: GameState,
  occupiedTiles: Point[],
  citizenCount: number,
): Citizen[] {
  const destinations = destinationPoints(state);
  const fallbackHome = occupiedTiles[0] ?? { x: 0, y: 0 };

  return Array.from({ length: citizenCount }, (_, index) => {
    const home = occupiedTiles[index % occupiedTiles.length] ?? fallbackHome;
    // Explicit empty-destination check: with no destination buildings yet,
    // `index % 0` is NaN and the lookup silently falls back to `home`, which
    // then scores a phantom "arrived" trip (zero-length walk). This keeps the
    // long-standing home-fallback semantics (see buildings.test.ts) while
    // making the empty case deliberate rather than an accident of NaN-indexing.
    const destination =
      destinations.length === 0
        ? home
        : destinations[index % destinations.length];

    return {
      id: entityId("citizen", state.citizens.length + index + 1),
      home: clonePoint(home),
      destination: clonePoint(destination),
      position: clonePoint(home),
      status: "idle",
      patienceRemaining: 240,
      deadline: state.time + 900,
      routePlan: null,
      currentLegIndex: 0,
    };
  });
}

export function canPlaceBuilding(
  state: GameState,
  type: BuildingType,
  origin: Point,
  rotation: BuildingRotation,
): boolean {
  const definition = BUILDING_CATALOG[type];
  const footprint = getBuildingFootprint(type, origin, rotation);

  return footprint.every((point) => {
    const tile = getTile(state.map, point);
    const buildingOccupied = state.buildings.some((building) =>
      building.occupiedTiles.some((occupiedTile) =>
        samePoint(occupiedTile, point),
      ),
    );
    const stopOccupied = state.transit.stops.some((stop) =>
      samePoint(stop.position, point),
    );
    const stationOccupied = state.transit.stations.some((station) =>
      samePoint(station.position, point),
    );
    // No building may sit on track, except the Metro Station building whose
    // (1x1) tile must have track — mirroring the station tool rule which
    // allows road + track crossings (isValidMetroStationPlacement).
    const kindOk =
      type === "metroStation"
        ? tile?.kind === "empty" || tile?.kind === "road"
        : tile?.kind === "empty";

    const trackOk =
      type === "metroStation"
        ? tile?.hasTrack === true
        : tile?.hasTrack !== true;
    const areaOk =
      definition.allowedArea === undefined ||
      tile?.area === definition.allowedArea;

    return (
      kindOk &&
      trackOk &&
      areaOk &&
      !buildingOccupied &&
      !stopOccupied &&
      !stationOccupied
    );
  });
}

export function placeBuilding(
  state: GameState,
  type: BuildingType,
  origin: Point,
  rotation: BuildingRotation,
): GameState {
  const definition = BUILDING_CATALOG[type];

  if (
    state.budget < definition.cost ||
    !canPlaceBuilding(state, type, origin, rotation)
  ) {
    return state;
  }

  const occupiedTiles = getBuildingFootprint(type, origin, rotation);
  const buildingId = nextEntityId(
    "building",
    state.buildings.map((building) => building.id),
  );
  let transit = state.transit;
  let citizens = state.citizens;
  let transitNodeId: string | undefined;

  if (definition.effect === "busStop" || definition.effect === "busTerminal") {
    transitNodeId = nextEntityId(
      "stop",
      state.transit.stops.map((stop) => stop.id),
    );
    transit = {
      ...transit,
      stops: [
        ...transit.stops,
        {
          id: transitNodeId,
          kind: definition.effect,
          position: clonePoint(origin),
          platforms: busPlatforms(transitNodeId, definition.effect),
        },
      ],
    };
  }

  if (definition.effect === "metroStation") {
    transitNodeId = nextEntityId(
      "station",
      state.transit.stations.map((station) => station.id),
    );
    transit = {
      ...transit,
      stations: [
        ...transit.stations,
        {
          id: transitNodeId,
          position: clonePoint(origin),
          platforms: metroPlatforms(transitNodeId),
        },
      ],
    };
  }

  if (definition.effect === "housing") {
    citizens = [
      ...citizens,
      ...createHousingCitizens(
        state,
        occupiedTiles,
        definition.citizenCount ?? 0,
      ),
    ];
  }

  const building: PlacedBuilding = {
    id: buildingId,
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
    citizens,
  };
}
