import type { GameState } from "../domain/types";
import type { RustGameSnapshot } from "./backend/types";

// The Growing Suburb scenario ships as a sandbox (see docs/architecture.md):
// the map starts empty, there are no timed growth waves, and growth is entirely
// player-driven through area painting and building placement. The Rust core
// therefore never produces growth waves, and the shell must not synthesize them
// either — doing so would make the Brief panel promise "First residents
// arrive" and the growth overlay paint tiles that Rust will never auto-apply.
//
// TODO(HPA-118): if timed growth waves return as a real scenario mechanic, move
// the scheduling, zoning, and citizen spawning into `crates/caelum-core` so
// browser and Tauri hosts stay symmetric and the wave schedule is deterministic
// end-to-end. At that point this file should read waves from
// `snapshot.scenario.growthWaves`. https://linear.app/cwchanap/issue/HPA-118
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
      growthWaves: [],
    },
  };
}
