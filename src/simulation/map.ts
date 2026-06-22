import { entityId } from "../domain/ids";
import type {
  Citizen,
  GameMap,
  GameState,
  Point,
  RoadDirection,
  Tile,
  TileKind,
} from "../domain/types";
import { destinationPoints } from "./buildingSelectors";
import { isBuildingOccupied, isTransitNodeAt, samePoint } from "./tileQueries";

function clonePoint(point: Point): Point {
  return { x: point.x, y: point.y };
}

/** A growth wave only claims tiles that are still bare, *unzoned* empty ground.
 *  `area` is a persistent claim layer (see the `Tile.area` invariant in
 *  domain/types.ts): it survives kind transitions and is only honored by the
 *  renderer on `empty` tiles, so a zoned tile keeps `kind === "empty"`. Without
 *  the `area === undefined` check here, a later wave (or the same wave after a
 *  player rezones) would overwrite an existing zoning and spawn citizens on an
 *  already-claimed tile — losing the "first claim wins" semantic the old
 *  district-kind behavior had. (Player-driven rezoning in areas.ts deliberately
 *  does NOT use this gate, so players can still rezone their own tiles.) */
function isBareGround(tile: Tile): boolean {
  return tile.kind === "empty" && tile.hasTrack !== true && tile.area === undefined;
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

  return tile?.kind === "road" && tile.hasTrack !== true && !occupied;
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

  return (
    (tile?.kind === "road" || tile?.kind === "empty") &&
    tile?.hasTrack === true &&
    !occupied
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
    tiles: map.tiles.map((tile) => {
      if (!samePoint(tile, point)) {
        return tile;
      }
      if (kind === "road") {
        return { ...tile, kind };
      }
      // oneWay is only meaningful on roads, so strip it on non-road kinds.
      // `area` is intentionally retained across kind transitions: it is a
      // separate zoning layer, not a property of the physical tile kind, and
      // the renderer only honors it on `kind === "empty"` tiles. See the
      // Tile type invariant in domain/types.ts.
      const { oneWay: _oneWay, ...rest } = tile;
      return { ...rest, kind };
    }),
  };
}

export function setTileOneWay(
  map: GameMap,
  point: Point,
  oneWay: RoadDirection | undefined,
): GameMap {
  return {
    ...map,
    tiles: map.tiles.map((tile) => {
      if (!samePoint(tile, point) || tile.kind !== "road") {
        return tile;
      }
      if (oneWay === undefined) {
        const { oneWay: _oneWay, ...rest } = tile;
        return rest;
      }
      return { ...tile, oneWay };
    }),
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
      // Growth waves zone the `area` layer; the physical kind is untouched
      // (empty ground remains empty until the player builds on it).
      return waveTile === undefined || !isBareGround(tile)
        ? { ...tile }
        : { ...tile, area: waveTile.area };
    }),
  };
  const destinations = destinationPoints(state);
  const newCitizens: Citizen[] = [];

  for (const wave of dueWaves) {
    for (const tile of wave.tiles) {
      const preWaveTile = getTile(state.map, { x: tile.x, y: tile.y });
      const blocked = preWaveTile === null || !isBareGround(preWaveTile);
      if (blocked || isBuildingOccupied(state, { x: tile.x, y: tile.y })) {
        continue;
      }

      for (let index = 0; index < tile.createsCitizens; index += 1) {
        const home = { x: tile.x, y: tile.y };
        // See `createHousingCitizens` in buildings.ts: an empty destinations
        // array would NaN-index and silently fall back to home, scoring a
        // phantom trip. Explicit check preserves the fallback semantics
        // without relying on NaN lookup behavior.
        const destination =
          destinations.length === 0
            ? home
            : destinations[newCitizens.length % destinations.length];

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
