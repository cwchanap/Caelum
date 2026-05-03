import type { Citizen, CitizenStatus, GameState, Metrics, Point, RoutePlan } from "../domain/types";
import { findRoutePlan } from "./router";

const terminalStatuses = new Set<CitizenStatus>(["arrived", "late", "unserved"]);

function clonePoint(point: Point): Point {
  return { x: point.x, y: point.y };
}

function cloneRoutePlan(routePlan: RoutePlan): RoutePlan {
  return {
    estimatedSeconds: routePlan.estimatedSeconds,
    legs: routePlan.legs.map((leg) => ({
      ...leg,
      from: clonePoint(leg.from),
      to: clonePoint(leg.to)
    }))
  };
}

function isWalkingOnly(routePlan: RoutePlan): boolean {
  return routePlan.legs.every((leg) => leg.mode === "walk");
}

function moveToward(from: Point, to: Point): Point {
  if (from.x < to.x) return { x: from.x + 1, y: from.y };
  if (from.x > to.x) return { x: from.x - 1, y: from.y };
  if (from.y < to.y) return { x: from.x, y: from.y + 1 };
  if (from.y > to.y) return { x: from.x, y: from.y - 1 };
  return clonePoint(from);
}

function samePoint(left: Point, right: Point): boolean {
  return left.x === right.x && left.y === right.y;
}

function statusAfterLeg(routePlan: RoutePlan, nextLegIndex: number): CitizenStatus {
  const nextLeg = routePlan.legs[nextLegIndex];

  if (nextLeg === undefined) {
    return "arrived";
  }

  return nextLeg.mode === "walk" ? "walking" : "waiting";
}

function scoreArrival(citizen: Citizen, time: number): { citizen: Citizen; completedTrips: number; lateTrips: number } {
  const status: CitizenStatus = time > citizen.deadline ? "late" : "arrived";

  return {
    citizen: {
      ...citizen,
      home: clonePoint(citizen.home),
      destination: clonePoint(citizen.destination),
      position: clonePoint(citizen.position),
      status
    },
    completedTrips: 1,
    lateTrips: status === "late" ? 1 : 0
  };
}

function markUnserved(citizen: Citizen): Citizen {
  return {
    ...citizen,
    home: clonePoint(citizen.home),
    destination: clonePoint(citizen.destination),
    position: clonePoint(citizen.position),
    status: "unserved",
    patienceRemaining: Math.max(0, citizen.patienceRemaining)
  };
}

function tickCitizen(
  state: GameState,
  citizen: Citizen,
  deltaSeconds: number
): { citizen: Citizen; completedTrips: number; lateTrips: number; unservedTrips: number; waitSeconds: number } {
  if (terminalStatuses.has(citizen.status)) {
    return {
      citizen: {
        ...citizen,
        home: clonePoint(citizen.home),
        destination: clonePoint(citizen.destination),
        position: clonePoint(citizen.position)
      },
      completedTrips: 0,
      lateTrips: 0,
      unservedTrips: 0,
      waitSeconds: 0
    };
  }

  let routePlan = citizen.routePlan;
  let nextCitizen: Citizen = {
    ...citizen,
    home: clonePoint(citizen.home),
    destination: clonePoint(citizen.destination),
    position: clonePoint(citizen.position)
  };

  if (routePlan === null) {
    const plannedRoute = findRoutePlan(state, nextCitizen.home, nextCitizen.destination);

    if (plannedRoute === null) {
      return { citizen: markUnserved(nextCitizen), completedTrips: 0, lateTrips: 0, unservedTrips: 1, waitSeconds: 0 };
    }

    routePlan = cloneRoutePlan(plannedRoute);
    nextCitizen = { ...nextCitizen, routePlan, currentLegIndex: 0, status: statusAfterLeg(routePlan, 0) };
  } else {
    routePlan = cloneRoutePlan(routePlan);
    nextCitizen = { ...nextCitizen, routePlan };
  }

  if (isWalkingOnly(routePlan) && state.time > nextCitizen.deadline && state.time + routePlan.estimatedSeconds > nextCitizen.deadline) {
    return { citizen: markUnserved(nextCitizen), completedTrips: 0, lateTrips: 0, unservedTrips: 1, waitSeconds: 0 };
  }

  const leg = routePlan.legs[nextCitizen.currentLegIndex];

  if (leg === undefined) {
    const arrival = scoreArrival(nextCitizen, state.time);
    return { ...arrival, unservedTrips: 0, waitSeconds: 0 };
  }

  if (leg.mode === "walk") {
    const position = moveToward(nextCitizen.position, leg.to);
    const currentLegIndex = samePoint(position, leg.to) ? nextCitizen.currentLegIndex + 1 : nextCitizen.currentLegIndex;
    nextCitizen = {
      ...nextCitizen,
      position,
      currentLegIndex,
      status: samePoint(position, leg.to) ? statusAfterLeg(routePlan, currentLegIndex) : "walking"
    };

    if (nextCitizen.status === "arrived") {
      const arrival = scoreArrival(nextCitizen, state.time + deltaSeconds);
      return { ...arrival, unservedTrips: 0, waitSeconds: 0 };
    }

    return { citizen: nextCitizen, completedTrips: 0, lateTrips: 0, unservedTrips: 0, waitSeconds: 0 };
  }

  const patienceRemaining = Math.max(0, nextCitizen.patienceRemaining - deltaSeconds);
  nextCitizen = {
    ...nextCitizen,
    status: "waiting",
    patienceRemaining
  };

  if (patienceRemaining <= 0 || state.time > nextCitizen.deadline + 300) {
    return { citizen: markUnserved(nextCitizen), completedTrips: 0, lateTrips: 0, unservedTrips: 1, waitSeconds: deltaSeconds };
  }

  return { citizen: nextCitizen, completedTrips: 0, lateTrips: 0, unservedTrips: 0, waitSeconds: deltaSeconds };
}

function updateMetrics(metrics: Metrics, citizens: Citizen[], completedTrips: number, lateTrips: number, unservedTrips: number, waitSeconds: number): Metrics {
  const totalWaitSeconds = metrics.totalWaitSeconds + waitSeconds;
  const waitingCitizens = citizens.filter((citizen) => citizen.status === "waiting");
  const waitingCitizenCount = waitingCitizens.length;
  const currentWaitSeconds = waitingCitizens.reduce(
    (total, citizen) => total + Math.max(0, 240 - citizen.patienceRemaining),
    0
  );

  return {
    ...metrics,
    completedTrips: metrics.completedTrips + completedTrips,
    lateTrips: metrics.lateTrips + lateTrips,
    unservedTrips: metrics.unservedTrips + unservedTrips,
    totalWaitSeconds,
    waitingCitizenCount,
    averageWaitSeconds: waitingCitizenCount > 0 ? currentWaitSeconds / waitingCitizenCount : 0
  };
}

export function tickCitizens(state: GameState, deltaSeconds: number): GameState {
  const results = state.citizens.map((citizen) => tickCitizen(state, citizen, deltaSeconds));
  const citizens = results.map((result) => result.citizen);
  const completedTrips = results.reduce((total, result) => total + result.completedTrips, 0);
  const lateTrips = results.reduce((total, result) => total + result.lateTrips, 0);
  const unservedTrips = results.reduce((total, result) => total + result.unservedTrips, 0);
  const waitSeconds = results.reduce((total, result) => total + result.waitSeconds, 0);

  return {
    ...state,
    time: state.time + deltaSeconds,
    citizens,
    metrics: updateMetrics(state.metrics, citizens, completedTrips, lateTrips, unservedTrips, waitSeconds)
  };
}
