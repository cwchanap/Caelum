import { createGrowingSuburbWaves } from "../scenario/growingSuburb";
import type { GameState, GrowthWave } from "../domain/types";
import type { RustGameSnapshot } from "./backend/types";

// Growth waves are a TS-side gameplay concept (zoning + citizen spawning +
// intro copy) that the Rust core does not model yet. Source them from the
// canonical TS scenario module rather than a drifted inline copy. The scenario
// name and objective thresholds come from the authoritative Rust snapshot (see
// `normalizeRustSnapshot`), so the shell can never drift from the values the
// core's `evaluate_objectives` actually enforces.
//
// TODO(HPA-118): move growth waves (scheduling, zoning, citizen spawning) into
// `crates/caelum-core` so browser and Tauri hosts stay symmetric and the wave
// schedule is deterministic end-to-end. Once landed, this file should read
// waves from `snapshot.scenario.growthWaves` and this TS-side constant goes
// away. https://linear.app/cwchanap/issue/HPA-118
const GROWTH_WAVES = createGrowingSuburbWaves();

export function normalizeRustSnapshot(snapshot: RustGameSnapshot): GameState {
  const nextGrowth: GrowthWave[] =
    snapshot.metrics.state === "running"
      ? GROWTH_WAVES.map((wave) => ({
          ...wave,
          tiles: [...wave.tiles],
        }))
      : [];

  return {
    ...snapshot,
    citizens: [],
    metrics: {
      ...snapshot.metrics,
      waitingCitizenCount: snapshot.metrics.waitingTripCount,
    },
    scenario: {
      name: snapshot.scenario.name,
      objectives: snapshot.scenario.objectives,
      growthWaves: nextGrowth,
    },
  };
}
