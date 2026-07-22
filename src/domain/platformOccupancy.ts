// Shared read-only platform-occupancy selectors. Both the canvas overlay
// renderer (`src/render/overlayRenderer.ts`) and the shell selectors
// (`src/runtime/runtimeSelectors.ts`) derive waiting/crowding from
// `state.activeTrips` against the transit platforms. Centralizing the
// calculation here keeps the two call sites from drifting — a previous copy in
// each module duplicated the `waitingLineId` / position-route indexing logic.
import type { ActiveTrip, GameState } from "./types";

export function positionKey(x: number, y: number): string {
  return `${x},${y}`;
}

/**
 * The transit line a waiting trip is queued for, or `undefined` when the
 * current leg is a walk (walk legs carry no line id and never occupy a
 * platform).
 */
export function waitingLineId(entity: ActiveTrip): string | undefined {
  const leg = entity.routePlan?.legs[entity.currentLegIndex];
  return leg !== undefined && leg.mode !== "walk" ? leg.lineId : undefined;
}

/**
 * Per-platform waiting occupancy derived from `state.activeTrips`. Each entry
 * is keyed by platform id and reports the count of trips currently waiting on
 * that platform alongside the platform's capacity. Sims/active trips are the
 * live data the Rust snapshot publishes, so this is the sole source of truth
 * for crowding overlays and inspector occupancy.
 */
export function selectPlatformOccupancy(
  state: GameState,
): Map<string, { count: number; capacity: number }> {
  const occupancy = new Map<string, { count: number; capacity: number }>();
  const platformByPositionAndRoute = new Map<string, string>();
  const nodes = [...state.transit.stops, ...state.transit.stations].filter(
    (node) => node.status === "present",
  );

  for (const node of nodes) {
    const posKey = positionKey(node.position.x, node.position.y);
    for (const platform of node.platforms) {
      occupancy.set(platform.id, { count: 0, capacity: platform.capacity });
      for (const routeId of platform.routeIds) {
        platformByPositionAndRoute.set(`${posKey}|${routeId}`, platform.id);
      }
    }
  }

  for (const entity of state.activeTrips ?? []) {
    if (entity.status !== "waiting") {
      continue;
    }
    const lineId = waitingLineId(entity);
    if (lineId === undefined) {
      continue;
    }
    const platformId = platformByPositionAndRoute.get(
      `${positionKey(entity.position.x, entity.position.y)}|${lineId}`,
    );
    const entry =
      platformId === undefined ? undefined : occupancy.get(platformId);
    if (entry !== undefined) {
      entry.count += 1;
    }
  }

  return occupancy;
}
