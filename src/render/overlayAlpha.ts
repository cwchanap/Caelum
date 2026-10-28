/** Overlay strength scales shared by the WebGPU overlay batch and the legend
 *  catalog, so legend chips always match what the map paints. Kept in a leaf
 *  module: overlayBatch imports runtimeSelectors, which imports the catalog —
 *  a shared module avoids a cycle. */

/** Crowding fill strengths: >50% platform load paints mid, ≥100% paints full. */
export const CROWDING_HALF_ALPHA = 0.6;
export const CROWDING_FULL_ALPHA = 1;

/** Repeated demand saturates: each additional destination multiplies the
 *  remaining opacity, so stacks darken smoothly instead of overdrawing. */
export function demandAlpha(count: number): number {
  return 1 - Math.pow(1 - 0.24, count);
}

/** Presentation flow is derived in Rust against the same road-capacity model. */
export const ROAD_FLOW_CAPACITY = 4;
export const MAX_CONGESTION_MULTIPLIER = 3;

export function trafficAlpha(flow: number): number {
  return Math.min(flow / (ROAD_FLOW_CAPACITY * MAX_CONGESTION_MULTIPLIER), 1);
}
