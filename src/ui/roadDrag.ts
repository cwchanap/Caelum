import type { GameState, Point, RoadDirection } from "../domain/types";
import { getTile, setTileOneWay } from "../simulation/map";
import { layRoad, layTrack } from "../simulation/transit";
import type { UiState } from "./uiState";

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
function lineDirection(line: Point[]): RoadDirection | null {
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
    const direction =
      ui.roadPreset === "oneWay" ? (lineDirection(line) ?? undefined) : undefined;
    return line.reduce((acc, point) => layLane(acc, point, direction), state);
  }
  return state;
}
