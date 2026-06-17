import type { GameState, Point, RoadDirection } from "../domain/types";
import {
  getTile,
  isValidRoadPlacement,
  isValidTrackPlacement,
  setTileOneWay,
} from "../simulation/map";
import {
  COSTS,
  layRoad,
  layTrack,
  recomputeRoutePaths,
} from "../simulation/transit";
import type { UiState } from "./uiState";

/** Compile-time exhaustiveness check for closed unions. */
function assertNever(value: never): never {
  throw new Error(`Unhandled value: ${JSON.stringify(value)}`);
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

/** Lay/keep a road at `point` and set its direction (undefined = two-way).
 *  Existing roads are redirected (free); empty tiles are laid (charged);
 *  off-map / occupied / unaffordable tiles are skipped (no-op). */
function layLane(
  state: GameState,
  point: Point,
  direction: RoadDirection | undefined,
): GameState {
  const existing = getTile(state.map, point);
  const withRoad = existing?.kind === "road" ? state : layRoad(state, point);
  if (getTile(withRoad.map, point)?.kind !== "road") {
    return withRoad;
  }
  return { ...withRoad, map: setTileOneWay(withRoad.map, point, direction) };
}

const REVERSE_OF: Record<RoadDirection, RoadDirection> = {
  north: "south",
  east: "west",
  south: "north",
  west: "east",
};

/** The direction opposing `direction` (north↔south, east↔west). Shared by the
 *  gesture (reverse-lane commit) and the drag preview (opposing arrows). */
export function oppositeDirection(direction: RoadDirection): RoadDirection {
  return REVERSE_OF[direction];
}

/** Unit offset to the left of travel (right-hand-traffic 2nd-lane placement). */
const LEFT_OF: Record<RoadDirection, Point> = {
  north: { x: -1, y: 0 },
  east: { x: 0, y: -1 },
  south: { x: 1, y: 0 },
  west: { x: 0, y: 1 },
};

/** The reverse-lane tiles for a dual-lane drag (left-of-travel offset of every
 *  tile in `line`). Empty when the line has no axis. Shared by the gesture and
 *  the drag preview so both agree on the 2-lane footprint. */
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

/** Lay a *new* reverse lane only on an empty, placeable tile — never hijacks an
 *  existing road and never runs off the map. */
function layReverseLane(
  state: GameState,
  point: Point,
  direction: RoadDirection,
): GameState {
  if (getTile(state.map, point)?.kind !== "empty") {
    return state;
  }
  const withRoad = layRoad(state, point);
  if (getTile(withRoad.map, point)?.kind !== "road") {
    return withRoad;
  }
  return { ...withRoad, map: setTileOneWay(withRoad.map, point, direction) };
}

function applyDualLane(state: GameState, line: Point[]): GameState {
  const forward = lineDirection(line);
  if (forward === null) {
    return line.reduce((acc, point) => layLane(acc, point, undefined), state);
  }
  const reverse = oppositeDirection(forward);
  const withForward = line.reduce(
    (acc, point) => layLane(acc, point, forward),
    state,
  );
  return reverseLanePoints(line).reduce(
    (acc, point) => layReverseLane(acc, point, reverse),
    withForward,
  );
}

/** Apply a >=2-tile road/track drag line. Routes by tool + road preset and
 *  composes existing pure helpers. Single-tile taps and the remove tool are
 *  handled by the runtime via the legacy click path, not here. */
export function applyDragGesture(
  state: GameState,
  ui: UiState,
  line: Point[],
): GameState {
  if (line.length === 0) {
    return state;
  }
  if (ui.activeTool === "track") {
    return line.reduce((acc, point) => layTrack(acc, point), state);
  }
  if (ui.activeTool === "road") {
    // Exhaustive over RoadPreset so a future preset is a compile error here
    // instead of silently falling through to two-way.
    switch (ui.roadPreset) {
      case "dualBidirectional":
        return recomputeRoutePaths(applyDualLane(state, line));
      case "oneWay": {
        const direction = lineDirection(line) ?? undefined;
        return recomputeRoutePaths(
          line.reduce((acc, point) => layLane(acc, point, direction), state),
        );
      }
      case "twoWay":
        return recomputeRoutePaths(
          line.reduce((acc, point) => layLane(acc, point, undefined), state),
        );
      default:
        return assertNever(ui.roadPreset);
    }
  }
  return state;
}

export interface DragPreviewTile {
  point: Point;
  /** Whether commit would actually lay infrastructure on this tile. */
  buildable: boolean;
}

/** Per-tile buildability of a road/track drag footprint, mirroring
 *  applyDragGesture's commit semantics so the preview can't tint green where
 *  nothing will land:
 *  - forward lane: an existing road is a free redirect (always buildable); an
 *    empty tile needs valid placement + remaining budget.
 *  - reverse lane (dual only): only an empty, placeable, affordable tile is
 *    laid (matches layReverseLane).
 *  Budget is consumed in commit order (forward tiles, then reverse tiles) so a
 *    mid-drag shortfall shows up as invalid tiles rather than a silent trunc.
 *  The remove tool returns [] — the renderer tints the whole line red. */
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
    return tiles; // remove/other: renderer handles the tint directly.
  }

  // Forward lane: existing roads redirect for free; empty tiles are charged.
  for (const point of line) {
    const existing = getTile(state.map, point);
    const buildable =
      existing?.kind === "road"
        ? true
        : tryAfford(COSTS.road, isValidRoadPlacement(state, point));
    tiles.push({ point, buildable });
  }

  // Reverse lane (dual only), laid after the forward lane in commit order.
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
