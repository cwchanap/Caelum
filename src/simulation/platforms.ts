import type { Citizen, GameState, Platform, StopKind } from "../domain/types";

export const PLATFORM_CAPACITY = { bus: 50, metro: 300 } as const;

const PLATFORM_LABELS = ["A", "B", "C", "D", "E", "F"] as const;

function buildPlatforms(
  nodeId: string,
  count: number,
  capacity: number,
): Platform[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${nodeId}-p${index}`,
    label: PLATFORM_LABELS[index] ?? String(index),
    capacity,
    routeIds: [],
  }));
}

export function busPlatforms(nodeId: string, kind: StopKind): Platform[] {
  return buildPlatforms(
    nodeId,
    kind === "busTerminal" ? 3 : 1,
    PLATFORM_CAPACITY.bus,
  );
}

export function metroPlatforms(nodeId: string): Platform[] {
  return buildPlatforms(nodeId, 2, PLATFORM_CAPACITY.metro);
}

function positionKey(x: number, y: number): string {
  return `${x},${y}`;
}

function waitingLineId(citizen: Citizen): string | undefined {
  const leg = citizen.routePlan?.legs[citizen.currentLegIndex];
  return leg !== undefined && leg.mode !== "walk" ? leg.lineId : undefined;
}

// Map of `${posKey}|${lineId}` -> platformId across all nodes.
function platformIndex(state: GameState): Map<string, string> {
  const index = new Map<string, string>();
  const nodes = [...state.transit.stops, ...state.transit.stations];

  for (const node of nodes) {
    const posKey = positionKey(node.position.x, node.position.y);
    for (const platform of node.platforms) {
      for (const routeId of platform.routeIds) {
        index.set(`${posKey}|${routeId}`, platform.id);
      }
    }
  }

  return index;
}

// Ordered (longest-waiting first, id tiebreak) waiter ids per platform id.
export function platformWaiterIds(state: GameState): Map<string, string[]> {
  const index = platformIndex(state);
  const groups = new Map<string, Citizen[]>();

  for (const citizen of state.citizens) {
    if (citizen.status !== "waiting") {
      continue;
    }

    const lineId = waitingLineId(citizen);
    if (lineId === undefined) {
      continue;
    }

    const platformId = index.get(
      `${positionKey(citizen.position.x, citizen.position.y)}|${lineId}`,
    );
    if (platformId === undefined) {
      continue;
    }

    const group = groups.get(platformId);
    if (group === undefined) {
      groups.set(platformId, [citizen]);
    } else {
      group.push(citizen);
    }
  }

  const ordered = new Map<string, string[]>();
  for (const [platformId, citizens] of groups) {
    ordered.set(
      platformId,
      citizens
        .slice()
        .sort(
          (left, right) =>
            left.patienceRemaining - right.patienceRemaining ||
            left.id.localeCompare(right.id),
        )
        .map((citizen) => citizen.id),
    );
  }

  return ordered;
}

function platformCapacities(state: GameState): Map<string, number> {
  const capacities = new Map<string, number>();
  const nodes = [...state.transit.stops, ...state.transit.stations];

  for (const node of nodes) {
    for (const platform of node.platforms) {
      capacities.set(platform.id, platform.capacity);
    }
  }

  return capacities;
}

export function selectPlatformOccupancy(
  state: GameState,
): Map<string, { count: number; capacity: number }> {
  const capacities = platformCapacities(state);
  const waiters = platformWaiterIds(state);
  const occupancy = new Map<string, { count: number; capacity: number }>();

  for (const [platformId, capacity] of capacities) {
    occupancy.set(platformId, {
      count: waiters.get(platformId)?.length ?? 0,
      capacity,
    });
  }

  return occupancy;
}

export function onPlatformCitizenIds(state: GameState): Set<string> {
  const capacities = platformCapacities(state);
  const waiters = platformWaiterIds(state);
  const onPlatform = new Set<string>();

  for (const [platformId, ids] of waiters) {
    const capacity = capacities.get(platformId) ?? 0;
    for (const id of ids.slice(0, capacity)) {
      onPlatform.add(id);
    }
  }

  return onPlatform;
}
