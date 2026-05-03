import { describe, expect, it } from "vitest";
import type { GameState } from "../../src/domain/types";
import { createInitialGameState } from "../../src/simulation/gameState";
import { evaluateObjectives } from "../../src/simulation/objectives";

function withMetrics(state: GameState, metrics: Partial<GameState["metrics"]>): GameState {
  return {
    ...state,
    metrics: {
      ...state.metrics,
      ...metrics
    }
  };
}

describe("objectives", () => {
  it("wins after survival time when thresholds are healthy", () => {
    const state = { ...createInitialGameState(), time: 1_201 };

    expect(evaluateObjectives(state).metrics.state).toBe("won");
  });

  it("loses when unserved ratio is too high", () => {
    const state = withMetrics(createInitialGameState(), {
      completedTrips: 10,
      unservedTrips: 10
    });

    const evaluated = evaluateObjectives(state);

    expect(evaluated.metrics.state).toBe("lost");
    expect(evaluated.metrics.lossReason).toBe("Too many unserved citizens");
  });

  it("loses when late ratio is too high after enough trips", () => {
    const state = withMetrics(createInitialGameState(), {
      completedTrips: 10,
      lateTrips: 3
    });

    const evaluated = evaluateObjectives(state);

    expect(evaluated.metrics.state).toBe("lost");
    expect(evaluated.metrics.lossReason).toBe("Too many late arrivals");
  });

  it("counts late trips within completed trips for late ratio losses", () => {
    const state = withMetrics(createInitialGameState(), {
      completedTrips: 10,
      lateTrips: 3,
      unservedTrips: 0
    });

    const evaluated = evaluateObjectives(state);

    expect(evaluated.metrics.state).toBe("lost");
    expect(evaluated.metrics.lossReason).toBe("Too many late arrivals");
  });

  it("loses when average wait is too high while citizens are waiting", () => {
    const state = withMetrics(createInitialGameState(), {
      waitingCitizenCount: 2,
      averageWaitSeconds: 181
    });

    const evaluated = evaluateObjectives(state);

    expect(evaluated.metrics.state).toBe("lost");
    expect(evaluated.metrics.lossReason).toBe("Average wait time is too high");
  });

  it("evaluates trip ratios over the rolling objective window", () => {
    const state = withMetrics(
      {
        ...createInitialGameState(),
        time: 1_000
      },
      {
        completedTrips: 20,
        lateTrips: 8,
        unservedTrips: 0,
        tripOutcomes: [
          ...Array.from({ length: 6 }, (_, index) => ({ time: 100 + index, outcome: "late" as const })),
          ...Array.from({ length: 2 }, (_, index) => ({ time: 990 + index, outcome: "late" as const })),
          ...Array.from({ length: 12 }, (_, index) => ({ time: 980 + index, outcome: "arrived" as const }))
        ]
      }
    );

    const evaluated = evaluateObjectives(state);

    expect(evaluated.metrics.state).toBe("running");
  });

  it("ignores stale failures when the rolling objective window is empty", () => {
    const state = withMetrics(
      {
        ...createInitialGameState(),
        time: 1_000
      },
      {
        completedTrips: 10,
        lateTrips: 10,
        unservedTrips: 0,
        tripOutcomes: Array.from({ length: 10 }, (_, index) => ({ time: 100 + index, outcome: "late" as const }))
      }
    );

    const evaluated = evaluateObjectives(state);

    expect(evaluated.metrics.state).toBe("running");
  });

  it("leaves already finished states unchanged", () => {
    const wonState = withMetrics(createInitialGameState(), { state: "won" });
    const lostState = withMetrics(createInitialGameState(), {
      state: "lost",
      lossReason: "Existing loss"
    });

    expect(evaluateObjectives(wonState)).toBe(wonState);
    expect(evaluateObjectives(lostState)).toBe(lostState);
  });
});
