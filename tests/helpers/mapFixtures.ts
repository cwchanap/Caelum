import type {
  AreaKind,
  GameState,
  Point,
  RoadDirection,
} from "../../src/domain/types";

function pointKey(point: Point): string {
  return `${point.x},${point.y}`;
}

export function pointsOnRow(y: number, fromX: number, toX: number): Point[] {
  return Array.from({ length: toX - fromX + 1 }, (_, index) => ({
    x: fromX + index,
    y,
  }));
}

export function pointsOnColumn(x: number, fromY: number, toY: number): Point[] {
  return Array.from({ length: toY - fromY + 1 }, (_, index) => ({
    x,
    y: fromY + index,
  }));
}

export function withRoads(state: GameState, points: Point[]): GameState {
  const keys = new Set(points.map(pointKey));
  return {
    ...state,
    map: {
      ...state.map,
      tiles: state.map.tiles.map((tile) => {
        if (!keys.has(pointKey(tile))) {
          return tile;
        }
        const { oneWay: _oneWay, ...rest } = tile;
        return { ...rest, kind: "road" as const };
      }),
    },
  };
}

export function withTracks(state: GameState, points: Point[]): GameState {
  const keys = new Set(points.map(pointKey));
  return {
    ...state,
    map: {
      ...state.map,
      tiles: state.map.tiles.map((tile) =>
        keys.has(pointKey(tile)) ? { ...tile, hasTrack: true } : tile,
      ),
    },
  };
}

export function withAreas(
  state: GameState,
  area: AreaKind,
  points: Point[],
): GameState {
  const keys = new Set(points.map(pointKey));
  return {
    ...state,
    map: {
      ...state.map,
      tiles: state.map.tiles.map((tile) =>
        keys.has(pointKey(tile)) ? { ...tile, area } : tile,
      ),
    },
  };
}

export function withOneWayRoads(
  state: GameState,
  entries: Array<Point & { oneWay: RoadDirection }>,
): GameState {
  const oneWayByKey = new Map(
    entries.map((entry) => [pointKey(entry), entry.oneWay]),
  );
  return {
    ...state,
    map: {
      ...state.map,
      tiles: state.map.tiles.map((tile) => {
        const oneWay = oneWayByKey.get(pointKey(tile));
        return oneWay === undefined
          ? tile
          : { ...tile, kind: "road" as const, oneWay };
      }),
    },
  };
}
