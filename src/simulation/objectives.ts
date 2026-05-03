import type { GameState } from "../domain/types";

function lose(state: GameState, lossReason: string): GameState {
  return {
    ...state,
    metrics: {
      ...state.metrics,
      state: "lost",
      lossReason
    }
  };
}

export function evaluateObjectives(state: GameState): GameState {
  if (state.metrics.state !== "running") {
    return state;
  }

  const { maxAverageWait, maxLateRatio, maxUnservedRatio, rollingWindowSeconds, survivalTime } = state.scenario.objectives;
  const windowStart = state.time - rollingWindowSeconds;
  const windowOutcomes = state.metrics.tripOutcomes.filter((outcome) => outcome.time >= windowStart);
  const hasOutcomeHistory = state.metrics.tripOutcomes.length > 0;
  const completedTrips = hasOutcomeHistory
    ? windowOutcomes.filter((outcome) => outcome.outcome === "arrived" || outcome.outcome === "late").length
    : state.metrics.completedTrips;
  const lateTrips = hasOutcomeHistory ? windowOutcomes.filter((outcome) => outcome.outcome === "late").length : state.metrics.lateTrips;
  const unservedTrips = hasOutcomeHistory
    ? windowOutcomes.filter((outcome) => outcome.outcome === "unserved").length
    : state.metrics.unservedTrips;
  const totalTrips = completedTrips + unservedTrips;

  if (totalTrips >= 10 && unservedTrips / totalTrips > maxUnservedRatio) {
    return lose(state, "Too many unserved citizens");
  }

  if (completedTrips >= 10 && lateTrips / completedTrips > maxLateRatio) {
    return lose(state, "Too many late arrivals");
  }

  if (state.metrics.waitingCitizenCount > 0 && state.metrics.averageWaitSeconds > maxAverageWait) {
    return lose(state, "Average wait time is too high");
  }

  if (state.time >= survivalTime) {
    return {
      ...state,
      metrics: {
        ...state.metrics,
        state: "won",
        lossReason: null
      }
    };
  }

  return state;
}
