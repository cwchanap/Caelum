import type { Point } from "../../domain/types";
import { tileSize } from "../boardTransform";

/** A drawn world-pixel point a map click can pick: post-cull output of the
 *  frame's vehicle sampling pass. `id` is the presented vehicle id. */
export interface MapPickSample {
  id: string;
  point: Point;
}

/** Geometry candidate under a map click; the WebGPU host resolves it from
 *  drawn samples and the runtime decides what it selects or builds.
 *  `lineId` stays null until line geometry joins the candidate. */
export interface MapPick {
  vehicleId: string | null;
  lineId: string | null;
}

/** Nearest drawn sample within half a tile of `point`, ordered by squared
 *  distance then id so a pixel-exact tie resolves deterministically. */
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
