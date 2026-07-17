import {
  samePoint,
  type BuildingRotation,
  type BuildingType,
  type GameMap,
  type GameState,
  type Point,
  type Tile,
} from "../domain/types";
import {
  BUILDING_CATALOG,
  getBuildingFootprint,
} from "../domain/catalog/buildings";

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

export function isBuildingOccupied(state: GameState, point: Point): boolean {
  return state.buildings.some((building) =>
    building.occupiedTiles.some((occupiedTile) =>
      samePoint(occupiedTile, point),
    ),
  );
}

export function isTransitNodeAt(state: GameState, point: Point): boolean {
  return (
    state.transit.stops.some(
      (stop) => stop.status === "present" && samePoint(stop.position, point),
    ) ||
    state.transit.stations.some(
      (station) =>
        station.status === "present" && samePoint(station.position, point),
    )
  );
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
      tile?.roadStructureId === undefined &&
      !isBuildingOccupied(state, point) &&
      !isTransitNodeAt(state, point)
    );
  });
}

export function isValidRoadPlacement(state: GameState, point: Point): boolean {
  const tile = getTile(state.map, point);
  return (
    tile?.kind === "empty" &&
    tile?.roadStructureId === undefined &&
    !isBuildingOccupied(state, point) &&
    !isTransitNodeAt(state, point)
  );
}

export function isValidTrackPlacement(state: GameState, point: Point): boolean {
  const tile = getTile(state.map, point);
  return (
    (tile?.kind === "empty" || tile?.kind === "road") &&
    tile?.hasTrack !== true &&
    tile?.roadStructureId === undefined &&
    !isBuildingOccupied(state, point) &&
    !isTransitNodeAt(state, point)
  );
}

export function isAreaPaintable(state: GameState, point: Point): boolean {
  const tile = getTile(state.map, point);
  return (
    tile?.kind === "empty" &&
    tile?.hasTrack !== true &&
    tile?.roadStructureId === undefined &&
    !isBuildingOccupied(state, point) &&
    !isTransitNodeAt(state, point)
  );
}
