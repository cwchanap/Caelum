import type { GameState, Point, RouteLeg, RoutePlan } from "../domain/types";
import { TILES_PER_SECOND } from "./transit";

interface TransitService {
  mode: "bus" | "metro";
  lineId: string;
  anchors: Point[];
  segments: Point[][];
}

function manhattanDistance(from: Point, to: Point): number {
  return Math.abs(from.x - to.x) + Math.abs(from.y - to.y);
}

function clonePoint(point: Point): Point {
  return { x: point.x, y: point.y };
}

function walkLeg(from: Point, to: Point): RouteLeg {
  return { mode: "walk", from: clonePoint(from), to: clonePoint(to) };
}

function transitLeg(
  mode: "bus" | "metro",
  from: Point,
  to: Point,
  lineId: string,
): RouteLeg {
  return { mode, from: clonePoint(from), to: clonePoint(to), lineId };
}

function walkSeconds(from: Point, to: Point): number {
  return manhattanDistance(from, to) * 20;
}

/**
 * Number of forward steps a vehicle travels along the loop's stored
 * segments to get from anchor `fromIndex` to anchor `toIndex`. Segment `i`
 * is the path from anchor `i` to anchor `(i + 1) % count` (the last segment
 * closes the loop), and a segment with `n` tile positions takes `n - 1`
 * steps; an unexpectedly degenerate segment still counts as at least one
 * step so a ride is never free.
 *
 * Callers must pass valid indexes into `segments` when it is non-empty
 * (activeServices guarantees anchors.length === segments.length), else the
 * forward walk would never terminate.
 */
function rideSteps(
  segments: Point[][],
  fromIndex: number,
  toIndex: number,
): number {
  const count = segments.length;
  if (count === 0 || fromIndex === toIndex) {
    return 0;
  }

  let steps = 0;
  let index = fromIndex;
  while (index !== toIndex) {
    steps += Math.max(1, segments[index].length - 1);
    index = (index + 1) % count;
  }

  return steps;
}

function rideSeconds(mode: "bus" | "metro", steps: number): number {
  return (mode === "bus" ? 90 : 120) + steps / TILES_PER_SECOND[mode];
}

function bestCandidate(candidates: RoutePlan[]): RoutePlan | null {
  let best: RoutePlan | null = null;

  for (const candidate of candidates) {
    if (best === null || candidate.estimatedSeconds < best.estimatedSeconds) {
      best = candidate;
    }
  }

  return best;
}

function isInsideMap(state: GameState, point: Point): boolean {
  if (
    !Number.isFinite(point.x) ||
    !Number.isFinite(point.y) ||
    !Number.isInteger(point.x) ||
    !Number.isInteger(point.y)
  ) {
    return false;
  }

  return (
    point.x >= 0 &&
    point.x < state.map.width &&
    point.y >= 0 &&
    point.y < state.map.height
  );
}

function activeServices(state: GameState): TransitService[] {
  const services: TransitService[] = [];

  for (const route of state.transit.routes) {
    if (!route.active || route.pathBroken) continue;
    const anchors = route.stopIds
      .map(
        (stopId) =>
          state.transit.stops.find((stop) => stop.id === stopId)?.position,
      )
      .filter((point): point is Point => point !== undefined)
      .map(clonePoint);

    // A dangling stopId would desync anchor indexes from segment indexes.
    if (anchors.length >= 2 && anchors.length === route.stopIds.length) {
      services.push({
        mode: "bus",
        lineId: route.id,
        anchors,
        segments: route.segments,
      });
    }
  }

  for (const line of state.transit.metroLines) {
    if (!line.active || line.pathBroken) continue;
    const anchors = line.stationIds
      .map(
        (stationId) =>
          state.transit.stations.find((station) => station.id === stationId)
            ?.position,
      )
      .filter((point): point is Point => point !== undefined)
      .map(clonePoint);

    if (anchors.length >= 2 && anchors.length === line.stationIds.length) {
      services.push({
        mode: "metro",
        lineId: line.id,
        anchors,
        segments: line.segments,
      });
    }
  }

  return services;
}

/** Index of the anchor nearest to `target`; -1 when `anchors` is empty. */
function nearestAnchorIndex(anchors: Point[], target: Point): number {
  let nearestIndex = -1;
  let nearestDistance = Number.POSITIVE_INFINITY;

  for (let index = 0; index < anchors.length; index += 1) {
    const distance = manhattanDistance(anchors[index], target);

    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = index;
    }
  }

  return nearestIndex;
}

function bestTransferIndexes(
  first: TransitService,
  second: TransitService,
): { first: number; second: number } | null {
  let best: { first: number; second: number; distance: number } | null = null;

  for (let firstIndex = 0; firstIndex < first.anchors.length; firstIndex += 1) {
    for (
      let secondIndex = 0;
      secondIndex < second.anchors.length;
      secondIndex += 1
    ) {
      const distance = manhattanDistance(
        first.anchors[firstIndex],
        second.anchors[secondIndex],
      );

      if (best === null || distance < best.distance) {
        best = { first: firstIndex, second: secondIndex, distance };
      }
    }
  }

  return best === null ? null : { first: best.first, second: best.second };
}

export function findRoutePlan(
  state: GameState,
  origin: Point,
  destination: Point,
): RoutePlan | null {
  if (!isInsideMap(state, origin) || !isInsideMap(state, destination)) {
    return null;
  }

  const candidates: RoutePlan[] = [
    {
      legs: [walkLeg(origin, destination)],
      estimatedSeconds: walkSeconds(origin, destination),
    },
  ];

  const services = activeServices(state);

  for (const service of services) {
    let originIndex = -1;
    let destinationIndex = -1;
    let originDistance = Number.POSITIVE_INFINITY;
    let destinationDistance = Number.POSITIVE_INFINITY;

    for (let index = 0; index < service.anchors.length; index += 1) {
      const anchor = service.anchors[index];
      const fromOrigin = manhattanDistance(anchor, origin);
      const toDestination = manhattanDistance(anchor, destination);
      if (fromOrigin < originDistance) {
        originDistance = fromOrigin;
        originIndex = index;
      }
      if (toDestination < destinationDistance) {
        destinationDistance = toDestination;
        destinationIndex = index;
      }
    }

    if (originIndex === -1 || originIndex === destinationIndex) {
      continue;
    }

    const boardAt = service.anchors[originIndex];
    const alightAt = service.anchors[destinationIndex];
    const steps = rideSteps(service.segments, originIndex, destinationIndex);

    candidates.push({
      legs: [
        walkLeg(origin, boardAt),
        transitLeg(service.mode, boardAt, alightAt, service.lineId),
        walkLeg(alightAt, destination),
      ],
      estimatedSeconds:
        walkSeconds(origin, boardAt) +
        rideSeconds(service.mode, steps) +
        walkSeconds(alightAt, destination),
    });
  }

  for (const first of services) {
    for (const second of services) {
      if (first.lineId === second.lineId) {
        continue;
      }

      const firstStartIndex = nearestAnchorIndex(first.anchors, origin);
      const secondEndIndex = nearestAnchorIndex(second.anchors, destination);
      const transfer = bestTransferIndexes(first, second);

      if (
        firstStartIndex === -1 ||
        secondEndIndex === -1 ||
        transfer === null
      ) {
        continue;
      }

      const firstStart = first.anchors[firstStartIndex];
      const secondEnd = second.anchors[secondEndIndex];
      const transferFirst = first.anchors[transfer.first];
      const transferSecond = second.anchors[transfer.second];

      const firstSteps = rideSteps(
        first.segments,
        firstStartIndex,
        transfer.first,
      );
      const secondSteps = rideSteps(
        second.segments,
        transfer.second,
        secondEndIndex,
      );

      candidates.push({
        legs: [
          walkLeg(origin, firstStart),
          transitLeg(first.mode, firstStart, transferFirst, first.lineId),
          walkLeg(transferFirst, transferSecond),
          transitLeg(second.mode, transferSecond, secondEnd, second.lineId),
          walkLeg(secondEnd, destination),
        ],
        estimatedSeconds:
          walkSeconds(origin, firstStart) +
          rideSeconds(first.mode, firstSteps) +
          walkSeconds(transferFirst, transferSecond) +
          rideSeconds(second.mode, secondSteps) +
          walkSeconds(secondEnd, destination),
      });
    }
  }

  return bestCandidate(candidates);
}
