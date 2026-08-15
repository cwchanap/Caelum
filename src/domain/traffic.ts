import type { GameState, Point } from "./types";

export const ROAD_FLOW_CAPACITY = 4;
export const MAX_CONGESTION_MULTIPLIER = 3;

export interface TrafficFlowPoint {
  point: Point;
  flow: number;
}

function pointKey(point: Point): string {
  return `${point.x},${point.y}`;
}

export function selectTrafficFlow(state: GameState): TrafficFlowPoint[] {
  const flowByPoint = new Map<string, TrafficFlowPoint>();

  for (const trip of state.activeTrips ?? []) {
    if (
      trip.status !== "driving" ||
      trip.privateCarTrip?.path.kind !== "road"
    ) {
      continue;
    }

    const seenByTrip = new Set<string>();
    for (const step of trip.privateCarTrip.path.steps) {
      const key = pointKey(step.position);
      if (seenByTrip.has(key)) continue;
      seenByTrip.add(key);

      const existing = flowByPoint.get(key);
      if (existing === undefined) {
        flowByPoint.set(key, { point: step.position, flow: 1 });
      } else {
        existing.flow += 1;
      }
    }
  }

  const roadKeys = new Set(
    state.map.tiles
      .filter((tile) => tile.kind === "road")
      .map((tile) => pointKey(tile)),
  );

  return [...flowByPoint.values()]
    .filter((entry) => roadKeys.has(pointKey(entry.point)))
    .sort((left, right) =>
      left.point.y === right.point.y
        ? left.point.x - right.point.x
        : left.point.y - right.point.y,
    );
}
