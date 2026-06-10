import { entityId } from "../domain/ids";
import type {
  Citizen,
  GameMap,
  GameState,
  Point,
  Tile,
  TileKind,
} from "../domain/types";

function samePoint(left: Point, right: Point): boolean {
  return left.x === right.x && left.y === right.y;
}

function clonePoint(point: Point): Point {
  return { x: point.x, y: point.y };
}

function isBuildingOccupied(state: GameState, point: Point): boolean {
  return state.buildings.some((building) =>
    building.occupiedTiles.some((occupiedTile) =>
      samePoint(occupiedTile, point),
    ),
  );
}

function destinationTiles(map: GameMap): Tile[] {
  return map.tiles
    .filter((tile) => tile.kind === "jobs" || tile.kind === "civic")
    .sort((left, right) => {
      if (left.districtId === "anchor" && right.districtId !== "anchor")
        return -1;
      if (right.districtId === "anchor" && left.districtId !== "anchor")
        return 1;
      return 0;
    });
}

export function getTile(map: GameMap, point: Point): Tile | null {
  if (
    point.x < 0 ||
    point.x >= map.width ||
    point.y < 0 ||
    point.y >= map.height
  ) {
    return null;
  }

  return map.tiles.find((tile) => samePoint(tile, point)) ?? null;
}

export function isValidBusStopPlacement(
  state: GameState,
  point: Point,
): boolean {
  const tile = getTile(state.map, point);
  const occupied =
    isBuildingOccupied(state, point) ||
    state.transit.stops.some((stop) => samePoint(stop.position, point));

  return tile?.kind === "road" && !occupied;
}

export function isValidMetroStationPlacement(
  state: GameState,
  point: Point,
): boolean {
  const tile = getTile(state.map, point);
  const occupied =
    isBuildingOccupied(state, point) ||
    state.transit.stations.some((station) =>
      samePoint(station.position, point),
    );

  return (tile?.kind === "road" || tile?.kind === "empty") && !occupied;
}

export function isValidCivicAnchorPlacement(
  state: GameState,
  point: Point,
): boolean {
  return getTile(state.map, point)?.kind === "empty";
}

function isTransitNodeAt(state: GameState, point: Point): boolean {
  return (
    state.transit.stops.some((stop) => samePoint(stop.position, point)) ||
    state.transit.stations.some((station) => samePoint(station.position, point))
  );
}

export function isValidRoadPlacement(state: GameState, point: Point): boolean {
  const tile = getTile(state.map, point);
  return (
    tile?.kind === "empty" &&
    !isBuildingOccupied(state, point) &&
    !isTransitNodeAt(state, point)
  );
}

export function isValidTrackPlacement(state: GameState, point: Point): boolean {
  const tile = getTile(state.map, point);
  return (
    (tile?.kind === "empty" || tile?.kind === "road") &&
    tile?.hasTrack !== true &&
    !isBuildingOccupied(state, point) &&
    !isTransitNodeAt(state, point)
  );
}

export function setTileKind(
  map: GameMap,
  point: Point,
  kind: TileKind,
): GameMap {
  return {
    ...map,
    tiles: map.tiles.map((tile) =>
      samePoint(tile, point) ? { ...tile, kind } : tile,
    ),
  };
}

export function setTileTrack(
  map: GameMap,
  point: Point,
  hasTrack: boolean,
): GameMap {
  return {
    ...map,
    tiles: map.tiles.map((tile) =>
      samePoint(tile, point) ? { ...tile, hasTrack } : tile,
    ),
  };
}

export function applyDueGrowthWaves(state: GameState): GameState {
  const dueWaves = state.scenario.growthWaves.filter(
    (wave) => !wave.applied && wave.triggerTime <= state.time,
  );

  if (dueWaves.length === 0) {
    return state;
  }

  const waveTilesById = new Map(
    dueWaves.flatMap((wave) =>
      wave.tiles.map((tile) => [tile.id, tile] as const),
    ),
  );
  const nextMap: GameMap = {
    ...state.map,
    tiles: state.map.tiles.map((tile) => {
      const waveTile = waveTilesById.get(tile.id);
      // A wave tile only converts while still bare empty ground: tiles the
      // player has already built road/track on stay as the player left them.
      const blocked = tile.kind !== "empty" || tile.hasTrack === true;
      return waveTile === undefined || blocked
        ? { ...tile }
        : { ...tile, kind: waveTile.kind, districtId: waveTile.districtId };
    }),
  };
  const destinations = destinationTiles(nextMap);
  const newCitizens: Citizen[] = [];

  for (const wave of dueWaves) {
    for (const tile of wave.tiles) {
      const preWaveTile = getTile(state.map, { x: tile.x, y: tile.y });
      const blocked =
        preWaveTile === null ||
        preWaveTile.kind !== "empty" ||
        preWaveTile.hasTrack === true;
      if (blocked || isBuildingOccupied(state, { x: tile.x, y: tile.y })) {
        continue;
      }

      for (let index = 0; index < tile.createsCitizens; index += 1) {
        const home = { x: tile.x, y: tile.y };
        const destination =
          destinations[newCitizens.length % destinations.length] ?? home;

        newCitizens.push({
          id: entityId(
            "citizen",
            state.citizens.length + newCitizens.length + 1,
          ),
          home: clonePoint(home),
          destination: clonePoint(destination),
          position: clonePoint(home),
          status: "idle",
          patienceRemaining: 240,
          deadline: state.time + 900,
          routePlan: null,
          currentLegIndex: 0,
        });
      }
    }
  }

  return {
    ...state,
    map: nextMap,
    scenario: {
      ...state.scenario,
      growthWaves: state.scenario.growthWaves.map((wave) =>
        dueWaves.some((dueWave) => dueWave.id === wave.id)
          ? { ...wave, applied: true }
          : wave,
      ),
    },
    citizens: [...state.citizens, ...newCitizens],
  };
}
