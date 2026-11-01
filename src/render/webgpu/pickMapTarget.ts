import type { GameState, Point } from "../../domain/types";
import type { MapPick } from "../../ui/mapPick";
import { tileCenter, tileSize } from "../boardTransform";
import { pointAt } from "../pathGeometry";
import { VEHICLE_INSTANCE_FLOATS } from "./renderer";
import {
  corridorsFor,
  presentationForRoute,
  presentationPath,
  renderableLines,
} from "./transitBatch";

/**
 * The drawn frame's pick inputs: post-cull vehicle ids in instance order with
 * their world-space instance buffer (vehicle i's center sits at
 * `positions[i * VEHICLE_INSTANCE_FLOATS]`), plus the state the frame was
 * drawn from. No per-vehicle objects are allocated to make a click possible.
 */
export interface MapPickTargets {
  vehicleIds: readonly string[];
  positions: Float32Array;
  state: GameState;
}

const PICK_RADIUS = tileSize / 2;
const LINE_STEP_SAMPLES = 8;

/**
 * Click-only nearest-hit resolution over the last drawn frame. Vehicles are
 * gated to the clicked tile — same limit as line step positions — so a bus on
 * a neighboring road tile (shared-corridor lane or mid-turn) cannot steal a
 * click meant for a building. Lines are gated to a presented step on the
 * clicked tile; only eligible lines pay the per-step sampling cost.
 */
export function pickMapTarget(
  targets: MapPickTargets | null,
  point: Point,
  tile: Point,
): MapPick | null {
  if (targets === null) {
    return null;
  }
  const maxDistanceSq = PICK_RADIUS * PICK_RADIUS;
  let bestId: string | null = null;
  let bestDistanceSq = 0;
  for (let i = 0; i < targets.vehicleIds.length; i += 1) {
    const x = targets.positions[i * VEHICLE_INSTANCE_FLOATS];
    const y = targets.positions[i * VEHICLE_INSTANCE_FLOATS + 1];
    if (
      x === undefined ||
      y === undefined ||
      Math.floor(x / tileSize) !== tile.x ||
      Math.floor(y / tileSize) !== tile.y
    ) {
      continue;
    }
    const dx = x - point.x;
    const dy = y - point.y;
    const distanceSq = dx * dx + dy * dy;
    if (distanceSq > maxDistanceSq) continue;
    const id = targets.vehicleIds[i];
    if (
      id !== undefined &&
      (bestId === null ||
        distanceSq < bestDistanceSq ||
        (distanceSq === bestDistanceSq && id < bestId))
    ) {
      bestId = id;
      bestDistanceSq = distanceSq;
    }
  }
  let bestLineId: string | null = null;
  let bestLineDistanceSq = 0;
  const corridors = corridorsFor(targets.state);
  for (const line of renderableLines(targets.state)) {
    const onTile = line.legs.some((leg) =>
      presentationPath(leg)?.steps.some(
        (step) => step.position.x === tile.x && step.position.y === tile.y,
      ),
    );
    if (!onTile) continue;
    for (const leg of line.legs) {
      const path = presentationPath(leg);
      if (path === null) continue;
      for (const step of path.steps) {
        const presented = presentationForRoute(
          step.geometry,
          line.id,
          corridors,
        ).geometry;
        for (let index = 0; index <= LINE_STEP_SAMPLES; index += 1) {
          const sample = tileCenter(
            pointAt(presented, index / LINE_STEP_SAMPLES),
          );
          const dx = sample.x - point.x;
          const dy = sample.y - point.y;
          const distanceSq = dx * dx + dy * dy;
          if (distanceSq > maxDistanceSq) continue;
          if (
            bestLineId === null ||
            distanceSq < bestLineDistanceSq ||
            (distanceSq === bestLineDistanceSq && line.id < bestLineId)
          ) {
            bestLineId = line.id;
            bestLineDistanceSq = distanceSq;
          }
        }
      }
    }
  }
  if (bestId === null && bestLineId === null) {
    return null;
  }
  return { vehicleId: bestId, lineId: bestLineId };
}
