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

  const totalTrips = state.metrics.completedTrips + state.metrics.unservedTrips;
  const { maxAverageWait, maxLateRatio, maxUnservedRatio, survivalTime } = state.scenario.objectives;

  if (totalTrips >= 10 && state.metrics.unservedTrips / totalTrips > maxUnservedRatio) {
    return lose(state, "Too many unserved citizens");
  }

  if (state.metrics.completedTrips >= 10 && state.metrics.lateTrips / state.metrics.completedTrips > maxLateRatio) {
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
