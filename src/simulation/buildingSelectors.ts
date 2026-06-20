import type { BuildingType, GameState, Point } from "../domain/types";

const DESTINATION_BUILDING_TYPES: ReadonlySet<BuildingType> = new Set([
  "supermarket",
  "cinema",
  "factory",
  "warehouse",
  "officeTower",
  "businessPark",
  "clinic",
  "school",
  "parkPlaza",
]);

function clonePoint(point: Point): Point {
  return { x: point.x, y: point.y };
}

export function destinationPoints(state: GameState): Point[] {
  return state.buildings
    .filter((building) => DESTINATION_BUILDING_TYPES.has(building.type))
    .flatMap((building) => building.occupiedTiles.map(clonePoint));
}
