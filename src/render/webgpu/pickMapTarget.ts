import type { GameState, Point } from "../../domain/types";
import { tileSize } from "../boardTransform";
import { pointAt } from "../pathGeometry";
import {
  buildCorridorGroups,
  presentationForRoute,
  presentationPath,
  renderableLines,
} from "./transitBatch";

export interface MapPickSample {
  id: string;
  point: Point;
}

export interface MapPick {
  vehicleId: string | null;
  lineId: string | null;
}

const PICK_RADIUS = tileSize / 2;
const LINE_STEP_SAMPLES = 8;

interface LinePickCandidate {
  lineId: string;
  tiles: Point[];
  points: Point[];
}

function center(point: Point): Point {
  return {
    x: point.x * tileSize + tileSize / 2,
    y: point.y * tileSize + tileSize / 2,
  };
}

function linePickCandidates(state: GameState): LinePickCandidate[] {
  const lines = renderableLines(state);
  const corridors = buildCorridorGroups(lines);
  const candidates: LinePickCandidate[] = [];
  for (const line of lines) {
    const tiles: Point[] = [];
    const points: Point[] = [];
    for (const leg of line.legs) {
      const path = presentationPath(leg);
      if (path === null) continue;
      for (const step of path.steps) {
        if (
          !tiles.some(
            (entry) =>
              entry.x === step.position.x && entry.y === step.position.y,
          )
        ) {
          tiles.push(step.position);
        }
        const presented = presentationForRoute(
          step.geometry,
          line.id,
          corridors,
        ).geometry;
        for (let index = 0; index <= LINE_STEP_SAMPLES; index += 1) {
          points.push(center(pointAt(presented, index / LINE_STEP_SAMPLES)));
        }
      }
    }
    candidates.push({ lineId: line.id, tiles, points });
  }
  return candidates;
}

export function pickMapTarget(
  samples: readonly MapPickSample[],
  state: GameState | null,
  point: Point,
  tile: Point,
): MapPick | null {
  const maxDistanceSq = PICK_RADIUS * PICK_RADIUS;
  let best: MapPickSample | null = null;
  let bestDistanceSq = 0;
  for (const sample of samples) {
    const dx = sample.point.x - point.x;
    const dy = sample.point.y - point.y;
    const distanceSq = dx * dx + dy * dy;
    if (distanceSq > maxDistanceSq) continue;
    if (
      best === null ||
      distanceSq < bestDistanceSq ||
      (distanceSq === bestDistanceSq && sample.id < best.id)
    ) {
      best = sample;
      bestDistanceSq = distanceSq;
    }
  }
  let bestLineId: string | null = null;
  let bestLineDistanceSq = 0;
  if (state !== null) {
    for (const line of linePickCandidates(state)) {
      if (
        !line.tiles.some((entry) => entry.x === tile.x && entry.y === tile.y)
      ) {
        continue;
      }
      for (const sample of line.points) {
        const dx = sample.x - point.x;
        const dy = sample.y - point.y;
        const distanceSq = dx * dx + dy * dy;
        if (distanceSq > maxDistanceSq) continue;
        if (
          bestLineId === null ||
          distanceSq < bestLineDistanceSq ||
          (distanceSq === bestLineDistanceSq && line.lineId < bestLineId)
        ) {
          bestLineId = line.lineId;
          bestLineDistanceSq = distanceSq;
        }
      }
    }
  }
  if (best === null && bestLineId === null) {
    return null;
  }
  return { vehicleId: best?.id ?? null, lineId: bestLineId };
}
