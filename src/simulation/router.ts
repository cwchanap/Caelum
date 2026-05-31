import type {
  GameState,
  Point,
  RouteLeg,
  RoutePlan,
  Station,
  Stop,
} from "../domain/types";

interface TransitService {
  mode: "bus" | "metro";
  lineId: string;
  anchors: Point[];
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

function busSeconds(from: Point, to: Point): number {
  return 90 + manhattanDistance(from, to) * 12;
}

function metroSeconds(from: Point, to: Point): number {
  return 120 + manhattanDistance(from, to) * 7;
}

function transitSeconds(mode: "bus" | "metro", from: Point, to: Point): number {
  return mode === "bus" ? busSeconds(from, to) : metroSeconds(from, to);
}

function nearestByPosition<T extends Stop | Station>(
  points: T[],
  target: Point,
): T | null {
  let nearest: T | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;

  for (const point of points) {
    const distance = manhattanDistance(point.position, target);

    if (distance < nearestDistance) {
      nearest = point;
      nearestDistance = distance;
    }
  }

  return nearest;
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
    if (!route.active) continue;
    const anchors = route.stopIds
      .map(
        (stopId) =>
          state.transit.stops.find((stop) => stop.id === stopId)?.position,
      )
      .filter((point): point is Point => point !== undefined)
      .map(clonePoint);

    if (anchors.length >= 2) {
      services.push({ mode: "bus", lineId: route.id, anchors });
    }
  }

  for (const line of state.transit.metroLines) {
    if (!line.active) continue;
    const anchors = line.stationIds
      .map(
        (stationId) =>
          state.transit.stations.find((station) => station.id === stationId)
            ?.position,
      )
      .filter((point): point is Point => point !== undefined)
      .map(clonePoint);

    if (anchors.length >= 2) {
      services.push({ mode: "metro", lineId: line.id, anchors });
    }
  }

  return services;
}

function nearestAnchor(anchors: Point[], target: Point): Point | null {
  let nearest: Point | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;

  for (const anchor of anchors) {
    const distance = manhattanDistance(anchor, target);

    if (distance < nearestDistance) {
      nearest = anchor;
      nearestDistance = distance;
    }
  }

  return nearest === null ? null : clonePoint(nearest);
}

function bestTransferPair(
  first: TransitService,
  second: TransitService,
): { first: Point; second: Point } | null {
  let best: { first: Point; second: Point; distance: number } | null = null;

  for (const firstAnchor of first.anchors) {
    for (const secondAnchor of second.anchors) {
      const distance = manhattanDistance(firstAnchor, secondAnchor);

      if (best === null || distance < best.distance) {
        best = { first: firstAnchor, second: secondAnchor, distance };
      }
    }
  }

  return best === null
    ? null
    : { first: clonePoint(best.first), second: clonePoint(best.second) };
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

  for (const route of state.transit.routes) {
    if (!route.active) {
      continue;
    }

    const routeStops = route.stopIds
      .map((stopId) => state.transit.stops.find((stop) => stop.id === stopId))
      .filter((stop): stop is Stop => stop !== undefined);
    const originStop = nearestByPosition(routeStops, origin);
    const destinationStop = nearestByPosition(routeStops, destination);

    if (
      originStop === null ||
      destinationStop === null ||
      originStop.id === destinationStop.id
    ) {
      continue;
    }

    candidates.push({
      legs: [
        walkLeg(origin, originStop.position),
        transitLeg(
          "bus",
          originStop.position,
          destinationStop.position,
          route.id,
        ),
        walkLeg(destinationStop.position, destination),
      ],
      estimatedSeconds:
        walkSeconds(origin, originStop.position) +
        busSeconds(originStop.position, destinationStop.position) +
        walkSeconds(destinationStop.position, destination),
    });
  }

  for (const line of state.transit.metroLines) {
    if (!line.active) {
      continue;
    }

    const lineStations = line.stationIds
      .map((stationId) =>
        state.transit.stations.find((station) => station.id === stationId),
      )
      .filter((station): station is Station => station !== undefined);
    const originStation = nearestByPosition(lineStations, origin);
    const destinationStation = nearestByPosition(lineStations, destination);

    if (
      originStation === null ||
      destinationStation === null ||
      originStation.id === destinationStation.id
    ) {
      continue;
    }

    candidates.push({
      legs: [
        walkLeg(origin, originStation.position),
        transitLeg(
          "metro",
          originStation.position,
          destinationStation.position,
          line.id,
        ),
        walkLeg(destinationStation.position, destination),
      ],
      estimatedSeconds:
        walkSeconds(origin, originStation.position) +
        metroSeconds(originStation.position, destinationStation.position) +
        walkSeconds(destinationStation.position, destination),
    });
  }

  const services = activeServices(state);

  for (const first of services) {
    for (const second of services) {
      if (first.lineId === second.lineId) {
        continue;
      }

      const firstStart = nearestAnchor(first.anchors, origin);
      const secondEnd = nearestAnchor(second.anchors, destination);
      const transfer = bestTransferPair(first, second);

      if (firstStart === null || secondEnd === null || transfer === null) {
        continue;
      }

      candidates.push({
        legs: [
          walkLeg(origin, firstStart),
          transitLeg(first.mode, firstStart, transfer.first, first.lineId),
          walkLeg(transfer.first, transfer.second),
          transitLeg(second.mode, transfer.second, secondEnd, second.lineId),
          walkLeg(secondEnd, destination),
        ],
        estimatedSeconds:
          walkSeconds(origin, firstStart) +
          transitSeconds(first.mode, firstStart, transfer.first) +
          walkSeconds(transfer.first, transfer.second) +
          transitSeconds(second.mode, transfer.second, secondEnd) +
          walkSeconds(secondEnd, destination),
      });
    }
  }

  return bestCandidate(candidates);
}
