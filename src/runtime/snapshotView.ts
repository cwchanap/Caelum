import type { GameState } from "../domain/types";
import type { RustGameSnapshot } from "./backend/types";

export function normalizeRustSnapshot(snapshot: RustGameSnapshot): GameState {
  return {
    ...snapshot,
    metrics: {
      ...snapshot.metrics,
      waitingCitizenCount: snapshot.metrics.waitingTripCount,
    },
    scenario: {
      name: snapshot.scenario.name,
      objectives: snapshot.scenario.objectives,
      growthWaves: snapshot.scenario.growthWaves,
    },
  };
}
