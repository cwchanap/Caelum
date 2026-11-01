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

interface LinePickStep {
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

function linePickSteps(state: GameState): LinePickStep[] {
  const lines = renderableLines(state);
  const corridors = buildCorridorGroups(lines);
  const steps: LinePickStep[] = [];
  for (const line of lines) {
    for (const leg of line.legs) {
      const path = presentationPath(leg);
      if (path === null) continue;
      for (const step of path.steps) {
        const presented = presentationForRoute(
          step.geometry,
          line.id,
          corridors,
        ).geometry;
        const tiles = [step.position];
        const points: Point[] = [];
        for (let index = 0; index <= LINE_STEP_SAMPLES; index += 1) {
          const point = center(pointAt(presented, index / LINE_STEP_SAMPLES));
          points.push(point);
          const stepTile = {
            x: Math.floor(point.x / tileSize),
            y: Math.floor(point.y / tileSize),
          };
          if (
            !tiles.some(
              (entry) => entry.x === stepTile.x && entry.y === stepTile.y,
            )
          ) {
            tiles.push(stepTile);
          }
        }
        steps.push({ lineId: line.id, tiles, points });
      }
    }
  }
  return steps;
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
    for (const step of linePickSteps(state)) {
      if (
        !step.tiles.some((entry) => entry.x === tile.x && entry.y === tile.y)
      ) {
        continue;
      }
      for (const sample of step.points) {
        const dx = sample.x - point.x;
        const dy = sample.y - point.y;
        const distanceSq = dx * dx + dy * dy;
        if (distanceSq > maxDistanceSq) continue;
        if (
          bestLineId === null ||
          distanceSq < bestLineDistanceSq ||
          (distanceSq === bestLineDistanceSq && step.lineId < bestLineId)
        ) {
          bestLineId = step.lineId;
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
