import type { Point } from "../../domain/types";
import { tileSize } from "../boardTransform";

export interface MapPickSample {
  id: string;
  point: Point;
}

export interface MapPick {
  vehicleId: string | null;
  lineId: string | null;
}

export function pickMapTarget(
  samples: readonly MapPickSample[],
  point: Point,
): MapPick | null {
  const maxDistanceSq = (tileSize / 2) * (tileSize / 2);
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
  return best === null ? null : { vehicleId: best.id, lineId: null };
}
