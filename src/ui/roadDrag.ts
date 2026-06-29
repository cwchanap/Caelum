import type {
  GameMap,
  GameState,
  Point,
  RoadDirection,
  Tile,
} from "../domain/types";
import { COSTS } from "../domain/catalog/transit";
import type { UiState } from "./uiState";

function samePoint(left: Point, right: Point): boolean {
  return left.x === right.x && left.y === right.y;
}

function getTile(map: GameMap, point: Point): Tile | null {
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

function isBuildingOccupied(state: GameState, point: Point): boolean {
  return state.buildings.some((building) =>
    building.occupiedTiles.some((occupiedTile) =>
      samePoint(occupiedTile, point),
    ),
  );
}

function isTransitNodeAt(state: GameState, point: Point): boolean {
  return (
    state.transit.stops.some((stop) => samePoint(stop.position, point)) ||
    state.transit.stations.some((station) => samePoint(station.position, point))
  );
}

function isValidRoadPlacement(state: GameState, point: Point): boolean {
  const tile = getTile(state.map, point);
  return (
    tile?.kind === "empty" &&
    !isBuildingOccupied(state, point) &&
    !isTransitNodeAt(state, point)
  );
}

function isValidTrackPlacement(state: GameState, point: Point): boolean {
  const tile = getTile(state.map, point);
  return (
    (tile?.kind === "empty" || tile?.kind === "road") &&
    tile?.hasTrack !== true &&
    !isBuildingOccupied(state, point) &&
    !isTransitNodeAt(state, point)
  );
}

/** Inclusive straight tile line from `start`, locked to the dominant axis.
 *  Ties (|dx| === |dy|) lock horizontal. start === end yields [start]. */
export function axisLockedLine(start: Point, end: Point): Point[] {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const horizontal = Math.abs(dx) >= Math.abs(dy);
  const length = horizontal ? Math.abs(dx) : Math.abs(dy);
  const stepX = horizontal ? Math.sign(dx) : 0;
  const stepY = horizontal ? 0 : Math.sign(dy);
  const line: Point[] = [];
  for (let i = 0; i <= length; i += 1) {
    line.push({ x: start.x + stepX * i, y: start.y + stepY * i });
  }
  return line;
}

/** Drag-axis travel direction from the first two tiles (null if < 2 tiles). */
export function lineDirection(line: Point[]): RoadDirection | null {
  if (line.length < 2) {
    return null;
  }
  const dx = line[1].x - line[0].x;
  const dy = line[1].y - line[0].y;
  if (dx > 0) return "east";
  if (dx < 0) return "west";
  if (dy > 0) return "south";
  return "north";
}

const REVERSE_OF: Record<RoadDirection, RoadDirection> = {
  north: "south",
  east: "west",
  south: "north",
  west: "east",
};

export function oppositeDirection(direction: RoadDirection): RoadDirection {
  return REVERSE_OF[direction];
}

const LEFT_OF: Record<RoadDirection, Point> = {
  north: { x: -1, y: 0 },
  east: { x: 0, y: -1 },
  south: { x: 1, y: 0 },
  west: { x: 0, y: 1 },
};

export function reverseLanePoints(line: Point[]): Point[] {
  const forward = lineDirection(line);
  if (forward === null) {
    return [];
  }
  const offset = LEFT_OF[forward];
  return line.map((point) => ({
    x: point.x + offset.x,
    y: point.y + offset.y,
  }));
}

export interface DragPreviewTile {
  point: Point;
  buildable: boolean;
}

export function planDragPreview(
  state: GameState,
  ui: UiState,
  line: Point[],
): DragPreviewTile[] {
  const tiles: DragPreviewTile[] = [];
  if (line.length === 0) {
    return tiles;
  }

  let budget = state.budget;
  const tryAfford = (cost: number, placeable: boolean): boolean => {
    if (!placeable || budget < cost) {
      return false;
    }
    budget -= cost;
    return true;
  };

  if (ui.activeTool === "track") {
    for (const point of line) {
      tiles.push({
        point,
        buildable: tryAfford(COSTS.track, isValidTrackPlacement(state, point)),
      });
    }
    return tiles;
  }

  if (ui.activeTool !== "road") {
    return tiles;
  }

  for (const point of line) {
    const existing = getTile(state.map, point);
    const buildable =
      existing?.kind === "road"
        ? true
        : tryAfford(COSTS.road, isValidRoadPlacement(state, point));
    tiles.push({ point, buildable });
  }

  if (ui.roadPreset === "dualBidirectional") {
    for (const point of reverseLanePoints(line)) {
      const existing = getTile(state.map, point);
      tiles.push({
        point,
        buildable:
          existing?.kind === "empty" &&
          tryAfford(COSTS.road, isValidRoadPlacement(state, point)),
      });
    }
  }

  return tiles;
}
