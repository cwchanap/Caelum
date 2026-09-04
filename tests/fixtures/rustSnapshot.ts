import { tileId } from "../../src/domain/ids";
import { SNAPSHOT_SCHEMA_VERSION } from "../../src/domain/types";
import { MAP_HEIGHT, MAP_WIDTH } from "../../src/scenario/sandbox";
import type {
  GameBackend,
  PresentationUpdate,
  RustGameSnapshot,
  RustTransitNetwork,
} from "../../src/runtime/backend/types";

// Build a full in-bounds empty grid so this minimal fixture is valid on its own,
// instead of an empty `tiles` array that every downstream helper had to patch.
// It intentionally omits the canonical Crossroads roads; authoritative sandbox
// templates and dimensions live in `crates/caelum-core/src/sandbox.rs`.
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

function createEmptyTransitNetwork(): RustTransitNetwork {
  return {
    stops: [],
    stations: [],
    routes: [],
    metroLines: [],
    vehicles: [],
  };
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
    transit: createEmptyTransitNetwork(),
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
      name: "Crossroads",
      objectives: null,
      growthWaves: [],
    },
    ...overrides,
  };
}

/**
 * Project a raw fixture snapshot into the presentation wire the Rust engine
 * would emit, mirroring `caelum_core::presentation::project_update` for the
 * fields test backends need. `includeScene=false` yields the frame-only shape
 * of ticks and rejected/no-op dispatches.
 */
export function createPresentationUpdate(
  snapshot: RustGameSnapshot,
  includeScene = true,
): PresentationUpdate {
  return {
    scene: includeScene
      ? {
          rules: snapshot.rules,
          map: snapshot.map,
          buildings: snapshot.buildings,
          stops: snapshot.transit.stops,
          stations: snapshot.transit.stations,
          routes: snapshot.transit.routes.map((route) => {
            const { serviceMetrics: _serviceMetrics, ...rest } = route;
            return {
              ...rest,
              targetHeadwaySeconds: route.targetHeadwaySeconds ?? null,
            };
          }),
          metroLines: snapshot.transit.metroLines.map((line) => {
            const { serviceMetrics: _serviceMetrics, ...rest } = line;
            return {
              ...rest,
              targetHeadwaySeconds: line.targetHeadwaySeconds ?? null,
            };
          }),
        }
      : null,
    frame: {
      time: snapshot.time,
      day: snapshot.day,
      clockMinutes: snapshot.clockMinutes,
      speed: snapshot.speed,
      paused: snapshot.paused,
      budget: snapshot.budget,
      metrics: {
        lateTrips: snapshot.metrics.lateTrips,
        unservedTrips: snapshot.metrics.unservedTrips,
        averageWaitSeconds: snapshot.metrics.averageWaitSeconds,
        state: snapshot.metrics.state,
      },
      populationCount: snapshot.sims.length,
      buildingOccupancy: [],
      platformOccupancy: [],
      trafficFlow: [],
      demandFlow: [],
      vehicles: snapshot.transit.vehicles.map((vehicle) => {
        const {
          capacity: _capacity,
          passengerIds: _passengerIds,
          ...rest
        } = vehicle;
        return rest;
      }),
      serviceMetrics: [
        ...snapshot.transit.routes.flatMap((route) =>
          route.serviceMetrics
            ? [{ lineId: route.id, metrics: route.serviceMetrics }]
            : [],
        ),
        ...snapshot.transit.metroLines.flatMap((line) =>
          line.serviceMetrics
            ? [{ lineId: line.id, metrics: line.serviceMetrics }]
            : [],
        ),
      ],
    },
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
  | "presentation"
  | "snapshotForSave"
  | "buildSandboxSnapshot"
  | "restoreSnapshot"
  | "previewRoute"
  | "previewRoadMutation"
> {
  return {
    presentation() {
      return Promise.resolve(createPresentationUpdate(createRustSnapshot()));
    },
    async buildSandboxSnapshot(request) {
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
          },
        },
      });
      return { ok: true, snapshot };
    },
    async snapshotForSave() {
      return { ok: true, snapshot: createRustSnapshot({ paused: true }) };
    },
    async restoreSnapshot(snapshot) {
      return {
        ok: true,
        update: createPresentationUpdate(snapshot as RustGameSnapshot),
      };
    },
    async previewRoute(request) {
      return {
        generation: request.generation,
        legs: [],
        totalTravelSeconds: 0,
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

export interface PersistenceBackendCounters {
  snapshotForSaveCalls: number;
  restoreSnapshotCalls: number;
  tickCalls: number;
}

export function persistenceBackendStubs(): {
  backend: Pick<
    GameBackend,
    | "buildSandboxSnapshot"
    | "snapshotForSave"
    | "restoreSnapshot"
    | "previewRoute"
    | "previewRoadMutation"
    | "tick"
  >;
  counters: PersistenceBackendCounters;
} {
  const counters: PersistenceBackendCounters = {
    snapshotForSaveCalls: 0,
    restoreSnapshotCalls: 0,
    tickCalls: 0,
  };
  const backend = previewBackendStubs();

  return {
    backend: {
      ...backend,
      async snapshotForSave() {
        counters.snapshotForSaveCalls += 1;
        return backend.snapshotForSave();
      },
      async restoreSnapshot(snapshot) {
        counters.restoreSnapshotCalls += 1;
        return backend.restoreSnapshot(snapshot);
      },
      async tick() {
        counters.tickCalls += 1;
        return {
          update: createPresentationUpdate(createRustSnapshot(), false),
          applied: false,
          rejection: null,
        };
      },
    },
    counters,
  };
}
