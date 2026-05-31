import type { GameState, Metrics, TransitNetwork } from "../domain/types";
import {
  createGrowingSuburbMap,
  createGrowingSuburbScenario,
  createStartingCitizens,
} from "../scenario/growingSuburb";

function createEmptyTransitNetwork(): TransitNetwork {
  return {
    stops: [],
    stations: [],
    routes: [],
    metroLines: [],
    vehicles: [],
  };
}

function createInitialMetrics(): Metrics {
  return {
    lateTrips: 0,
    completedTrips: 0,
    unservedTrips: 0,
    totalWaitSeconds: 0,
    waitingCitizenCount: 0,
    averageWaitSeconds: 0,
    tripOutcomes: [],
    state: "running",
    lossReason: null,
  };
}

export function createInitialGameState(): GameState {
  return {
    time: 0,
    speed: 1,
    paused: true,
    budget: 120_000,
    map: createGrowingSuburbMap(),
    scenario: createGrowingSuburbScenario(),
    transit: createEmptyTransitNetwork(),
    citizens: createStartingCitizens(),
    metrics: createInitialMetrics(),
  };
}
