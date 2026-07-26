import { tileId } from "../../src/domain/ids";
import { SNAPSHOT_SCHEMA_VERSION } from "../../src/domain/types";
import { MAP_HEIGHT, MAP_WIDTH } from "../../src/scenario/sandbox";
import type {
  GameBackend,
  RustGameSnapshot,
} from "../../src/runtime/backend/types";

// Build a full in-bounds empty grid so the default snapshot is valid on its
// own (matching what the Rust backend returns), instead of an empty `tiles`
// array that every downstream helper had to patch. Dimensions come from the
// single TS mirror of `crates/caelum-core/src/scenario.rs`.
function createEmptyTiles(
  width = MAP_WIDTH,
  height = MAP_HEIGHT,
): RustGameSnapshot["map"]["tiles"] {
  const tiles: RustGameSnapshot["map"]["tiles"] = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      tiles.push({
        id: tileId(x, y),
        x,
        y,
        kind: "empty",
        roadConnections: [],
      });
    }
  }
  return tiles;
}

export function createRustSnapshot(
  overrides: Partial<RustGameSnapshot> = {},
): RustGameSnapshot {
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    rules: {
      gameMode: "sandbox",
      economyPreset: "standard",
      sandbox: {
        templateId: "crossroads",
        startingCapital: 120_000,
        demandMultiplier: 1,
        moveInRate: "paused",
      },
    },
    time: 0,
    day: 0,
    clockMinutes: 0,
    speed: 1,
    paused: true,
    budget: 120_000,
    map: {
      width: MAP_WIDTH,
      height: MAP_HEIGHT,
      tiles: createEmptyTiles(),
      roadStructures: [],
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
      objectives: null,
      growthWaves: [],
    },
    ...overrides,
  };
}

export function createRustSnapshotWithRoadAccess(): RustGameSnapshot {
  const snapshot = createRustSnapshot();
  snapshot.transit.stops.push({
    id: "stop-001",
    kind: "busStop",
    status: "present",
    position: { x: 4, y: 4 },
    roadAccess: {
      roadPoint: { x: 4, y: 5 },
      preferredHeading: "east",
    },
    platforms: [],
  });
  return snapshot;
}

export function previewBackendStubs(): Pick<
  GameBackend,
  "createSandbox" | "previewRoute" | "previewRoadMutation"
> {
  return {
    async createSandbox(request) {
      const snapshot = createRustSnapshot({
        budget: request.startingCapital,
        rules: {
          gameMode: "sandbox",
          economyPreset:
            request.economyPreset === "creative" ? "creative" : "standard",
          sandbox: {
            templateId:
              request.templateId === "blankGrid" ? "blankGrid" : "crossroads",
            startingCapital: request.startingCapital,
            demandMultiplier: request.demandMultiplier,
            moveInRate: "paused",
          },
        },
      });
      return { ok: true, snapshot };
    },
    async previewRoute(request) {
      return {
        generation: request.generation,
        legs: [],
        totalTravelSeconds: 0,
        initialVehicleCost: 0,
        affordable: true,
        turnSummary: {
          straight: 0,
          rightTurn: 0,
          leftTurn: 0,
          uTurn: 0,
          roundaboutEntry: 0,
        },
        missingWaypointIds: [],
        warnings: [],
        rejection: null,
      };
    },
    async previewRoadMutation(request) {
      return {
        generation: request.generation,
        changedTiles: [],
        authoredTiles: [],
        generatedStructures: [],
        cost: 0,
        skippedTiles: [],
        routeImpacts: [],
        warnings: [],
        rejection: null,
      };
    },
  };
}
