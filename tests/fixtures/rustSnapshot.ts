import type { RustGameSnapshot } from "../../src/runtime/backend/types";

export function createRustSnapshot(
  overrides: Partial<RustGameSnapshot> = {},
): RustGameSnapshot {
  return {
    time: 0,
    day: 0,
    clockMinutes: 0,
    speed: 1,
    paused: true,
    budget: 120_000,
    map: { width: 28, height: 18, tiles: [] },
    buildings: [],
    transit: {
      stops: [],
      stations: [],
      routes: [],
      metroLines: [],
      vehicles: [],
    },
    sims: [],
    activeTrips: [],
    tripSequenceDay: 0,
    nextTripSequence: 1,
    metrics: {
      lateTrips: 0,
      completedTrips: 0,
      unservedTrips: 0,
      totalWaitSeconds: 0,
      waitingCitizenCount: 0,
      averageWaitSeconds: 0,
      tripOutcomes: [],
      state: "running",
      lossReason: null,
    },
    ...overrides,
  };
}
