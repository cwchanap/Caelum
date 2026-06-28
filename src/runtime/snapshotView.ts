import type { GameState, GrowthWave, Scenario } from "../domain/types";
import type { RustGameSnapshot } from "./backend/types";

const scenario: Scenario = {
  name: "Growing Suburb",
  growthWaves: [
    {
      id: "intro",
      triggerTime: 0,
      message: "First residents arrive — build destinations so they can commute.",
      applied: false,
      tiles: [],
    },
  ],
  objectives: {
    maxLateRatio: 0.25,
    maxUnservedRatio: 0.2,
    maxAverageWait: 180,
    rollingWindowSeconds: 600,
    survivalTime: 1_200,
  },
};

export function normalizeRustSnapshot(snapshot: RustGameSnapshot): GameState {
  const nextGrowth: GrowthWave[] =
    snapshot.metrics.state === "running" ? scenario.growthWaves : [];

  return {
    ...snapshot,
    scenario: {
      ...scenario,
      growthWaves: nextGrowth,
    },
  };
}
