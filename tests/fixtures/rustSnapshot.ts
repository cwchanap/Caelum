import { tileId } from "../../src/domain/ids";
import type { RustGameSnapshot } from "../../src/runtime/backend/types";

const DEFAULT_MAP_WIDTH = 28;
const DEFAULT_MAP_HEIGHT = 18;

// Build a full in-bounds empty grid so the default snapshot is valid on its
// own (matching what the Rust backend returns), instead of an empty `tiles`
// array that every downstream helper had to patch.
function createEmptyTiles(
  width = DEFAULT_MAP_WIDTH,
  height = DEFAULT_MAP_HEIGHT,
): RustGameSnapshot["map"]["tiles"] {
  const tiles: RustGameSnapshot["map"]["tiles"] = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      tiles.push({ id: tileId(x, y), x, y, kind: "empty" });
    }
  }
  return tiles;
}

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
    map: {
      width: DEFAULT_MAP_WIDTH,
      height: DEFAULT_MAP_HEIGHT,
      tiles: createEmptyTiles(),
    },
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
      waitingTripCount: 0,
      averageWaitSeconds: 0,
      tripOutcomes: [],
      state: "running",
      lossReason: null,
    },
    scenario: {
      name: "Growing Suburb",
      objectives: {
        maxLateRatio: 0.25,
        maxUnservedRatio: 0.2,
        maxAverageWait: 180,
        rollingWindowSeconds: 300,
        survivalTime: 1_200,
      },
    },
    ...overrides,
  };
}
