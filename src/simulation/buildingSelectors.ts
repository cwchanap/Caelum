import type { GameState, Point } from "../domain/types";
import { BUILDING_CATALOG } from "./buildingCatalog";

function clonePoint(point: Point): Point {
  return { x: point.x, y: point.y };
}

export function destinationPoints(state: GameState): Point[] {
  return state.buildings
    .filter(
      (building) => BUILDING_CATALOG[building.type].effect === "destination",
    )
    .flatMap((building) => building.occupiedTiles.map(clonePoint));
}
