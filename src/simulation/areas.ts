import type { AreaKind, GameState, Point } from "../domain/types";
import { getTile } from "./map";

export const AREA_KINDS = [
  "residential",
  "commercial",
  "industrial",
  "office",
  "civic",
  "park",
] as const satisfies AreaKind[];

export const AREA_LABELS: Record<AreaKind, string> = {
  residential: "Residential",
  commercial: "Commercial",
  industrial: "Industrial",
  office: "Office",
  civic: "Civic",
  park: "Park",
};

export interface AreaPreviewTile {
  point: Point;
  paintable: boolean;
}

function samePoint(left: Point, right: Point): boolean {
  return left.x === right.x && left.y === right.y;
}

function isBuildingOccupied(state: GameState, point: Point): boolean {
  return state.buildings.some((building) =>
    building.occupiedTiles.some((tile) => samePoint(tile, point)),
  );
}

function isTransitNodeAt(state: GameState, point: Point): boolean {
  return (
    state.transit.stops.some((stop) => samePoint(stop.position, point)) ||
    state.transit.stations.some((station) => samePoint(station.position, point))
  );
}

export function rectanglePoints(start: Point, end: Point): Point[] {
  const minX = Math.min(start.x, end.x);
  const maxX = Math.max(start.x, end.x);
  const minY = Math.min(start.y, end.y);
  const maxY = Math.max(start.y, end.y);
  const points: Point[] = [];

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      points.push({ x, y });
    }
  }

  return points;
}

export function isAreaPaintable(state: GameState, point: Point): boolean {
  const tile = getTile(state.map, point);
  return (
    tile?.kind === "empty" &&
    tile.hasTrack !== true &&
    !isBuildingOccupied(state, point) &&
    !isTransitNodeAt(state, point)
  );
}

export function planAreaPaintPreview(
  state: GameState,
  area: AreaKind,
  start: Point,
  end: Point,
): AreaPreviewTile[] {
  void area;
  return rectanglePoints(start, end).map((point) => ({
    point,
    paintable: isAreaPaintable(state, point),
  }));
}

export function paintAreaRectangle(
  state: GameState,
  area: AreaKind,
  start: Point,
  end: Point,
): GameState {
  const paintableKeys = new Set(
    rectanglePoints(start, end)
      .filter((point) => isAreaPaintable(state, point))
      .map((point) => `${point.x},${point.y}`),
  );

  if (paintableKeys.size === 0) {
    return state;
  }

  return {
    ...state,
    map: {
      ...state.map,
      tiles: state.map.tiles.map((tile) =>
        paintableKeys.has(`${tile.x},${tile.y}`) ? { ...tile, area } : tile,
      ),
    },
  };
}
