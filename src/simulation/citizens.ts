import type {
  Citizen,
  CitizenStatus,
  GameState,
  Metrics,
  Point,
  RoutePlan,
  TripOutcome,
} from "../domain/types";
import { findRoutePlan } from "./router";

const terminalStatuses = new Set<CitizenStatus>([
  "arrived",
  "late",
  "unserved",
]);

function clonePoint(point: Point): Point {
  return { x: point.x, y: point.y };
}

function cloneRoutePlan(routePlan: RoutePlan): RoutePlan {
  return {
    estimatedSeconds: routePlan.estimatedSeconds,
    legs: routePlan.legs.map((leg) => ({
      ...leg,
      from: clonePoint(leg.from),
      to: clonePoint(leg.to),
    })),
  };
}

function isWalkingOnly(routePlan: RoutePlan): boolean {
  return routePlan.legs.every((leg) => leg.mode === "walk");
}

const WALK_SECONDS_PER_TILE = 20;

function moveToward(from: Point, to: Point, maxDistance: number): Point {
  const xDistance = to.x - from.x;
  const yDistance = to.y - from.y;

  if (xDistance !== 0) {
    const step =
      Math.sign(xDistance) * Math.min(Math.abs(xDistance), maxDistance);
    return { x: from.x + step, y: from.y };
  }

  if (yDistance !== 0) {
    const step =
      Math.sign(yDistance) * Math.min(Math.abs(yDistance), maxDistance);
    return { x: from.x, y: from.y + step };
  }

  return clonePoint(from);
}

function samePoint(left: Point, right: Point): boolean {
  return (
    Math.abs(left.x - right.x) < 0.000_001 &&
    Math.abs(left.y - right.y) < 0.000_001
  );
}

function statusAfterLeg(
  routePlan: RoutePlan,
  nextLegIndex: number,
): CitizenStatus {
  const nextLeg = routePlan.legs[nextLegIndex];

  if (nextLeg === undefined) {
    return "arrived";
  }

  return nextLeg.mode === "walk" ? "walking" : "waiting";
}

function scoreArrival(
  citizen: Citizen,
  time: number,
): { citizen: Citizen; completedTrips: number; lateTrips: number } {
  const status: CitizenStatus = time > citizen.deadline ? "late" : "arrived";

  return {
    citizen: {
      ...citizen,
      home: clonePoint(citizen.home),
      destination: clonePoint(citizen.destination),
      position: clonePoint(citizen.position),
      status,
    },
    completedTrips: 1,
    lateTrips: status === "late" ? 1 : 0,
  };
}

function markUnserved(citizen: Citizen): Citizen {
  return {
    ...citizen,
    home: clonePoint(citizen.home),
    destination: clonePoint(citizen.destination),
    position: clonePoint(citizen.position),
    status: "unserved",
    patienceRemaining: Math.max(0, citizen.patienceRemaining),
  };
}

function tickCitizen(
  state: GameState,
  citizen: Citizen,
  deltaSeconds: number,
): {
  citizen: Citizen;
  completedTrips: number;
  lateTrips: number;
  unservedTrips: number;
  waitSeconds: number;
  outcomes: TripOutcome[];
} {
  if (terminalStatuses.has(citizen.status)) {
    return {
      citizen: {
        ...citizen,
        home: clonePoint(citizen.home),
        destination: clonePoint(citizen.destination),
        position: clonePoint(citizen.position),
      },
      completedTrips: 0,
      lateTrips: 0,
      unservedTrips: 0,
      waitSeconds: 0,
      outcomes: [],
    };
  }

  // Home-fallback citizens (destination === home, created when no destination
  // building exists yet — see createHousingCitizens / isHomeFallbackCitizen)
  // have no real trip to make. Planning route home→home would score a phantom
  // zero-length "arrived" trip on the very next tick, flipping them terminal
  // and so making them unretargetable when a destination is later placed
  // (retargetCitizens skips terminal statuses). Hold them dormant instead:
  // unchanged, non-terminal, zero metrics, so they remain eligible for
  // retargeting. The same path covers bulldozing the last destination, which
  // retargets citizens back to home.
  if (samePoint(citizen.destination, citizen.home)) {
    return {
      citizen: {
        ...citizen,
        home: clonePoint(citizen.home),
        destination: clonePoint(citizen.destination),
        position: clonePoint(citizen.position),
        routePlan:
          citizen.routePlan === null ? null : cloneRoutePlan(citizen.routePlan),
      },
      completedTrips: 0,
      lateTrips: 0,
      unservedTrips: 0,
      waitSeconds: 0,
      outcomes: [],
    };
  }

  const isOnVehicle = state.transit.vehicles.some((vehicle) =>
    vehicle.passengerIds.includes(citizen.id),
  );

  if (citizen.status === "riding" && isOnVehicle) {
    return {
      citizen: {
        ...citizen,
        home: clonePoint(citizen.home),
        destination: clonePoint(citizen.destination),
        position: clonePoint(citizen.position),
        routePlan:
          citizen.routePlan === null ? null : cloneRoutePlan(citizen.routePlan),
      },
      completedTrips: 0,
      lateTrips: 0,
      unservedTrips: 0,
      waitSeconds: 0,
      outcomes: [],
    };
  }

  let routePlan = citizen.routePlan;
  let nextCitizen: Citizen = {
    ...citizen,
    home: clonePoint(citizen.home),
    destination: clonePoint(citizen.destination),
    position: clonePoint(citizen.position),
  };

  if (citizen.status === "riding" && !isOnVehicle) {
    routePlan = null;
    nextCitizen = {
      ...nextCitizen,
      status: "idle",
      routePlan: null,
      currentLegIndex: 0,
    };
  }

  if (routePlan === null) {
    // A citizen whose plan was invalidated mid-walk retains a fractional
    // position. findRoutePlan rejects non-integer coordinates, so snap to
    // the nearest tile before replanning.
    const snappedOrigin: Point = {
      x: Math.round(nextCitizen.position.x),
      y: Math.round(nextCitizen.position.y),
    };
    const plannedRoute = findRoutePlan(
      state,
      snappedOrigin,
      nextCitizen.destination,
    );

    if (plannedRoute === null) {
      return {
        citizen: markUnserved(nextCitizen),
        completedTrips: 0,
        lateTrips: 0,
        unservedTrips: 1,
        waitSeconds: 0,
        outcomes: [{ time: state.time, outcome: "unserved" }],
      };
    }

    routePlan = cloneRoutePlan(plannedRoute);
    nextCitizen = {
      ...nextCitizen,
      routePlan,
      currentLegIndex: 0,
      status: statusAfterLeg(routePlan, 0),
    };
  } else {
    routePlan = cloneRoutePlan(routePlan);
    nextCitizen = { ...nextCitizen, routePlan };
  }

  if (
    isWalkingOnly(routePlan) &&
    state.time > nextCitizen.deadline &&
    state.time + routePlan.estimatedSeconds > nextCitizen.deadline
  ) {
    return {
      citizen: markUnserved(nextCitizen),
      completedTrips: 0,
      lateTrips: 0,
      unservedTrips: 1,
      waitSeconds: 0,
      outcomes: [{ time: state.time, outcome: "unserved" }],
    };
  }

  const leg = routePlan.legs[nextCitizen.currentLegIndex];

  if (leg === undefined) {
    const arrival = scoreArrival(nextCitizen, state.time);
    return {
      ...arrival,
      unservedTrips: 0,
      waitSeconds: 0,
      outcomes: [
        {
          time: state.time,
          outcome: arrival.lateTrips > 0 ? "late" : "arrived",
        },
      ],
    };
  }

  if (leg.mode === "walk") {
    const position = moveToward(
      nextCitizen.position,
      leg.to,
      Math.max(0, deltaSeconds / WALK_SECONDS_PER_TILE),
    );
    const currentLegIndex = samePoint(position, leg.to)
      ? nextCitizen.currentLegIndex + 1
      : nextCitizen.currentLegIndex;
    nextCitizen = {
      ...nextCitizen,
      position,
      currentLegIndex,
      status: samePoint(position, leg.to)
        ? statusAfterLeg(routePlan, currentLegIndex)
        : "walking",
    };

    if (nextCitizen.status === "arrived") {
      const arrival = scoreArrival(nextCitizen, state.time);
      return {
        ...arrival,
        unservedTrips: 0,
        waitSeconds: 0,
        outcomes: [
          {
            time: state.time,
            outcome: arrival.lateTrips > 0 ? "late" : "arrived",
          },
        ],
      };
    }

    return {
      citizen: nextCitizen,
      completedTrips: 0,
      lateTrips: 0,
      unservedTrips: 0,
      waitSeconds: 0,
      outcomes: [],
    };
  }

  const patienceRemaining = Math.max(
    0,
    nextCitizen.patienceRemaining - deltaSeconds,
  );
  nextCitizen = {
    ...nextCitizen,
    status: "waiting",
    patienceRemaining,
  };

  if (patienceRemaining <= 0 || state.time > nextCitizen.deadline + 300) {
    return {
      citizen: markUnserved(nextCitizen),
      completedTrips: 0,
      lateTrips: 0,
      unservedTrips: 1,
      waitSeconds: deltaSeconds,
      outcomes: [{ time: state.time, outcome: "unserved" }],
    };
  }

  return {
    citizen: nextCitizen,
    completedTrips: 0,
    lateTrips: 0,
    unservedTrips: 0,
    waitSeconds: deltaSeconds,
    outcomes: [],
  };
}

function updateMetrics(
  metrics: Metrics,
  citizens: Citizen[],
  completedTrips: number,
  lateTrips: number,
  unservedTrips: number,
  waitSeconds: number,
  outcomes: TripOutcome[],
): Metrics {
  const totalWaitSeconds = metrics.totalWaitSeconds + waitSeconds;
  const waitingCitizens = citizens.filter(
    (citizen) => citizen.status === "waiting",
  );
  const waitingCitizenCount = waitingCitizens.length;
  const currentWaitSeconds = waitingCitizens.reduce(
    (total, citizen) => total + Math.max(0, 240 - citizen.patienceRemaining),
    0,
  );

  return {
    ...metrics,
    completedTrips: metrics.completedTrips + completedTrips,
    lateTrips: metrics.lateTrips + lateTrips,
    unservedTrips: metrics.unservedTrips + unservedTrips,
    totalWaitSeconds,
    waitingCitizenCount,
    averageWaitSeconds:
      waitingCitizenCount > 0 ? currentWaitSeconds / waitingCitizenCount : 0,
    tripOutcomes: [...metrics.tripOutcomes, ...outcomes],
  };
}

export function tickCitizens(
  state: GameState,
  deltaSeconds: number,
): GameState {
  const results = state.citizens.map((citizen) =>
    tickCitizen(state, citizen, deltaSeconds),
  );
  const citizens = results.map((result) => result.citizen);
  const completedTrips = results.reduce(
    (total, result) => total + result.completedTrips,
    0,
  );
  const lateTrips = results.reduce(
    (total, result) => total + result.lateTrips,
    0,
  );
  const unservedTrips = results.reduce(
    (total, result) => total + result.unservedTrips,
    0,
  );
  const waitSeconds = results.reduce(
    (total, result) => total + result.waitSeconds,
    0,
  );
  const outcomes = results.flatMap((result) => result.outcomes);

  return {
    ...state,
    citizens,
    metrics: updateMetrics(
      state.metrics,
      citizens,
      completedTrips,
      lateTrips,
      unservedTrips,
      waitSeconds,
      outcomes,
    ),
  };
}
