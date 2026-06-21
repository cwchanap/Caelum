import type { GameState, Point } from "../domain/types";

export function samePoint(left: Point, right: Point): boolean {
  return left.x === right.x && left.y === right.y;
}

/** True if any placed building footprint covers `point`. */
export function isBuildingOccupied(state: GameState, point: Point): boolean {
  return state.buildings.some((building) =>
    building.occupiedTiles.some((occupiedTile) =>
      samePoint(occupiedTile, point),
    ),
  );
}

/** True if a bus stop or metro station sits on `point`. */
export function isTransitNodeAt(state: GameState, point: Point): boolean {
  return (
    state.transit.stops.some((stop) => samePoint(stop.position, point)) ||
    state.transit.stations.some((station) => samePoint(station.position, point))
  );
}
