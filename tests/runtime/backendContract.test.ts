import { describe, expect, expectTypeOf, it } from "vitest";
import {
  SNAPSHOT_SCHEMA_VERSION,
  type GameplayRejection,
} from "../../src/domain/types";
import type {
  DispatchResult,
  GameBackend,
  GameIntent,
  RoadMutationPreviewRequest,
  RoadMutationPreviewResponse,
  RoutePreviewRequest,
  RoutePreviewResponse,
  RustGameSnapshot,
  RustRouteLegPath,
} from "../../src/runtime/backend/types";
import type {
  PersistenceSnapshotRequest,
  PersistenceSnapshotResult,
  PersistenceValidationResult,
} from "../../src/runtime/backend";
import { rejectionMessage } from "../../src/runtime/rejectionMessages";
import { normalizeRouteLegPath } from "../../src/runtime/backend/shared";
import { normalizeRustSnapshot } from "../../src/runtime/snapshotView";
import {
  createRustSnapshot,
  createRustSnapshotWithRoadAccess,
  previewBackendStubs,
} from "../fixtures/rustSnapshot";

function assertLoadSnapshotRemoved(backend: GameBackend): void {
  // @ts-expect-error loadSnapshot is intentionally removed from GameBackend
  void backend.loadSnapshot;
}
void assertLoadSnapshotRemoved;

function assertDispatchImpactRemoved(result: DispatchResult): void {
  // @ts-expect-error DispatchResult exposes only snapshot, applied, and rejection
  void result.context;
}
void assertDispatchImpactRemoved;

describe("Rust backend contract", () => {
  it("uses structured gameplay rejections", () => {
    const insufficientBudget: GameplayRejection = {
      code: "insufficientBudget",
      context: {
        requiredBudget: 8_000,
        availableBudget: 7_999,
        affectedRouteIds: [],
      },
    };

    expectTypeOf<
      DispatchResult["rejection"]
    >().toEqualTypeOf<GameplayRejection | null>();
    expect(rejectionMessage(insufficientBudget)).toBe(
      "Needs $8,000; only $7,999 is available.",
    );
  });

  it("describes an exhausted route revision with route and revision context", () => {
    const exhaustedRevision: GameplayRejection = {
      code: "routeRevisionExhausted",
      context: {
        routeId: "route-001",
        actualRevision: 4_294_967_295,
        affectedRouteIds: [],
      },
    };

    expect(rejectionMessage(exhaustedRevision)).toBe(
      "route-001 cannot be edited because its revision 4,294,967,295 is exhausted.",
    );
  });

  it.each([
    {
      code: "invalidSpeed" as const,
      context: { affectedRouteIds: [] },
      message: "That simulation speed is not supported.",
    },
    {
      code: "blockedTile" as const,
      context: { affectedRouteIds: [] },
      message: "That tile is blocked.",
    },
    {
      code: "outOfBounds" as const,
      context: { affectedRouteIds: [] },
      message: "That location is outside the map.",
    },
    {
      code: "roadRequired" as const,
      context: { affectedRouteIds: [] },
      message: "Build a road here first.",
    },
    {
      code: "trackRequired" as const,
      context: { affectedRouteIds: [] },
      message: "Build track here first.",
    },
    {
      code: "invalidRoadStroke" as const,
      context: { affectedRouteIds: [] },
      message: "That road stroke has no valid tiles.",
    },
    {
      code: "invalidTrackStroke" as const,
      context: { affectedRouteIds: [] },
      message: "That track stroke has no valid tiles.",
    },
    {
      code: "invalidDirectionChange" as const,
      context: { affectedRouteIds: [] },
      message: "Change the approach lane; structure directions are automatic.",
    },
    {
      code: "nodeAlreadyExists" as const,
      context: { affectedRouteIds: [] },
      message: "A compatible transit node already occupies that anchor.",
    },
    {
      code: "ambiguousTransitNode" as const,
      context: { affectedRouteIds: [] },
      message:
        "More than one missing node matches this anchor; edit the route first.",
    },
    {
      code: "missingRouteNode" as const,
      context: { nodeId: "stop-001", affectedRouteIds: [] },
      message: "stop-001 is missing.",
    },
    {
      code: "incompatibleRouteNode" as const,
      context: { nodeId: "stop-001", affectedRouteIds: [] },
      message: "stop-001 is not compatible with this route mode.",
    },
    {
      code: "tooFewRouteNodes" as const,
      context: { affectedRouteIds: [] },
      message: "A route needs at least two distinct live nodes.",
    },
    {
      code: "duplicateRouteNodes" as const,
      context: { affectedRouteIds: [] },
      message: "Each route waypoint must be distinct.",
    },
    {
      code: "disconnectedLeg" as const,
      context: {
        fromWaypointId: "stop-001",
        toWaypointId: "stop-002",
        affectedRouteIds: [],
      },
      message: "No legal path connects stop-001 to stop-002.",
    },
    {
      code: "routeChangedWhileEditing" as const,
      context: { affectedRouteIds: [] },
      message:
        "This route changed while you were editing it. Reload the saved route.",
    },
    {
      code: "routeNotFound" as const,
      context: { routeId: "route-001", affectedRouteIds: [] },
      message: "route-001 no longer exists.",
    },
    {
      code: "inactiveRoute" as const,
      context: { routeId: "route-001", affectedRouteIds: [] },
      message: "route-001 is inactive.",
    },
    {
      code: "structureNotFound" as const,
      context: { structureId: "junction-001", affectedRouteIds: [] },
      message: "junction-001 no longer exists.",
    },
    {
      code: "invalidPlatform" as const,
      context: { affectedRouteIds: [] },
      message: "That platform cannot serve this route.",
    },
    {
      code: "invalidBuildingPlacement" as const,
      context: { affectedRouteIds: [] },
      message: "That building cannot be placed on this footprint.",
    },
    {
      code: "blockedFootprint" as const,
      context: { affectedRouteIds: [] },
      message:
        "The full footprint must contain only empty or replaceable road tiles.",
    },
    {
      code: "unsafeRoundaboutPortMapping" as const,
      context: { affectedRouteIds: [] },
      message:
        "The roads crossing this footprint cannot map safely to roundabout ports.",
    },
  ])(
    "maps rejection code $code through the TS message layer",
    ({ code, context, message }) => {
      expect(rejectionMessage({ code, context })).toBe(message);
    },
  );

  it("normalizes a Rust snapshot into shell-readable frontend state", () => {
    const rustSnapshot = createRustSnapshot({
      day: 1,
      clockMinutes: 9 * 60 + 15,
      metrics: {
        lateTrips: 1,
        completedTrips: 2,
        unservedTrips: 3,
        totalWaitSeconds: 45,
        waitingTripCount: 4,
        averageWaitSeconds: 11.25,
        tripOutcomes: [
          {
            outcome: "late",
            waitSeconds: 45,
            time: 555,
          },
        ],
        state: "running",
        lossReason: null,
      },
      sims: [
        {
          id: "sim-001",
          home: { x: 1, y: 1 },
          position: { x: 1, y: 1 },
          workerProfile: "worker",
          shiftTemplate: "standard",
          workplace: { x: 5, y: 1 },
          commuteDay: 1,
          outboundResolvedToday: false,
          outboundArrivedToday: false,
          returnResolvedToday: false,
          returnedHomeToday: false,
        },
      ],
    });
    const snapshot = normalizeRustSnapshot(rustSnapshot);
    const anotherSnapshot = normalizeRustSnapshot(createRustSnapshot());

    expect(rustSnapshot.metrics.waitingTripCount).toBe(4);
    expect(rustSnapshot.metrics.tripOutcomes).toEqual([
      {
        outcome: "late",
        waitSeconds: 45,
        time: 555,
      },
    ]);
    expect(snapshot.scenario.name).toBe("Crossroads");
    expect(snapshot.day).toBe(1);
    expect(snapshot.clockMinutes).toBe(555);
    expect(snapshot.sims).toHaveLength(1);
    expect(snapshot.metrics.waitingCitizenCount).toBe(4);
    expect(snapshot.metrics.waitingTripCount).toBe(4);
    expect(snapshot.metrics.tripOutcomes).toEqual([
      {
        outcome: "late",
        waitSeconds: 45,
        time: 555,
      },
    ]);
    // Growth waves pass through from the Rust snapshot (empty for the shipped
    // scenario).
    expect(snapshot.scenario.growthWaves).toEqual([]);
    expect(anotherSnapshot.scenario.growthWaves).toEqual([]);
  });

  it("rejects a schema-v2 snapshot", () => {
    const stale = createRustSnapshot({
      schemaVersion: 2 as unknown as typeof SNAPSHOT_SCHEMA_VERSION,
    });
    expect(() => normalizeRustSnapshot(stale)).toThrow(
      "Unsupported snapshot schema version: 2",
    );
  });

  it("normalizes committed bus and metro route path options to explicit nulls", () => {
    const snapshot = createRustSnapshot();
    const brokenBusLeg = {
      fromWaypointId: "stop-001",
      toWaypointId: "stop-002",
      direction: "loop" as const,
      kind: "service" as const,
      status: "networkDisconnected" as const,
      currentPath: undefined as unknown as null,
      lastValidPath: undefined as unknown as null,
      estimatedSeconds: undefined as unknown as null,
    };
    snapshot.transit.routes.push({
      id: "route-001",
      name: "Bus 1",
      color: "#00aaff",
      stopIds: ["stop-001", "stop-002"],
      vehicleIds: [],
      active: true,
      pattern: "loop",
      revision: 1,
      legs: [brokenBusLeg],
      pathBroken: true,
    });
    snapshot.transit.metroLines.push({
      id: "metro-001",
      name: "Metro 1",
      color: "#aa00ff",
      stationIds: ["station-001", "station-002"],
      vehicleIds: [],
      active: true,
      pattern: "shuttle",
      revision: 1,
      legs: [
        {
          ...brokenBusLeg,
          fromWaypointId: "station-001",
          toWaypointId: "station-002",
          direction: "outbound",
        },
      ],
      pathBroken: true,
    });

    const normalized = normalizeRustSnapshot(snapshot);

    expect(normalized.transit.routes[0].legs[0]).toMatchObject({
      currentPath: null,
      lastValidPath: null,
      estimatedSeconds: null,
    });
    expect(normalized.transit.metroLines[0].legs[0]).toMatchObject({
      currentPath: null,
      lastValidPath: null,
      estimatedSeconds: null,
    });
  });

  it("normalizes omitted optional route fields", () => {
    const legacyLeg = {
      fromWaypointId: "stop-001",
      toWaypointId: "stop-002",
      direction: "loop" as const,
      kind: "service" as const,
      status: "networkDisconnected" as const,
      currentPath: undefined,
      lastValidPath: undefined,
      estimatedSeconds: undefined,
    } satisfies RustRouteLegPath;

    const leg = normalizeRouteLegPath(legacyLeg);

    expect(leg.currentPath).toBeNull();
    expect(leg.lastValidPath).toBeNull();
    expect(leg.estimatedSeconds).toBeNull();
    expect(leg.failureReason).toBeNull();
  });

  it("preserves stop road access from the Rust snapshot", () => {
    const state = normalizeRustSnapshot(createRustSnapshotWithRoadAccess());

    expect(state.transit.stops[0].roadAccess).toEqual({
      roadPoint: { x: 4, y: 5 },
      preferredHeading: "east",
    });
  });

  it("maps the Rust no-road-access rejection code", () => {
    const rejection: GameplayRejection = {
      code: "noRoadAccess",
      context: { affectedRouteIds: [] },
    };

    expect(rejectionMessage(rejection)).toBe("That stop has no road access.");
  });

  it("normalizes omitted vehicle parkedPosition to explicit null", () => {
    const snapshot = createRustSnapshot();
    snapshot.transit.vehicles.push({
      id: "vehicle-001",
      mode: "bus",
      lineId: "route-001",
      capacity: 30,
      passengerIds: [],
      itineraryIndex: 0,
      pathStepIndex: 0,
      stepProgress: 0,
      // WASM path: Rust Option::None arrives as undefined, not null.
      parkedPosition: undefined as unknown as null,
    });

    const normalized = normalizeRustSnapshot(snapshot);

    expect(normalized.transit.vehicles[0].parkedPosition).toBeNull();
  });

  it("normalizes both Rust None encodings to null objectives", () => {
    const tauri = normalizeRustSnapshot(
      createRustSnapshot({
        scenario: {
          name: "Crossroads",
          objectives: null,
          growthWaves: [],
        },
      }),
    );
    const wasm = normalizeRustSnapshot(
      createRustSnapshot({
        scenario: {
          name: "Crossroads",
          objectives: undefined,
          growthWaves: [],
        },
      }),
    );

    expect(tauri.scenario.objectives).toBeNull();
    expect(wasm.scenario.objectives).toBeNull();
  });

  it("maps only known scenario fields", () => {
    const raw = createRustSnapshot() as RustGameSnapshot & {
      scenario: RustGameSnapshot["scenario"] & { unknownField: string };
    };
    raw.scenario.unknownField = "discard me";

    const normalized = normalizeRustSnapshot(raw);

    expect(normalized.scenario).toEqual({
      name: "Crossroads",
      objectives: null,
      growthWaves: [],
    });
    expect("unknownField" in normalized.scenario).toBe(false);
  });

  it("sources objective thresholds from the Rust snapshot, not a local shim", () => {
    // Guards against the drift that motivated this contract: a previous TS shim
    // hard-coded `rollingWindowSeconds = 600` while the core evaluates at 300.
    const campaignRules = {
      ...createRustSnapshot().rules,
      gameMode: "campaign" as const,
    };
    const withThresholds = createRustSnapshot({
      rules: campaignRules,
      scenario: {
        name: "Growing Suburb",
        objectives: {
          maxLateRatio: 0.25,
          maxUnservedRatio: 0.2,
          maxAverageWait: 180,
          rollingWindowSeconds: 300,
          survivalTime: 1_200,
        },
        growthWaves: [],
      },
    });
    const normalized = normalizeRustSnapshot(withThresholds);

    expect(normalized.scenario.objectives).toEqual(
      withThresholds.scenario.objectives,
    );
    expect(normalized.scenario.objectives?.rollingWindowSeconds).toBe(300);

    // And a custom threshold round-trips through unchanged (proving the value
    // is read from the snapshot, not overwritten by a constant).
    const custom = normalizeRustSnapshot(
      createRustSnapshot({
        rules: campaignRules,
        scenario: {
          name: "Tight Suburb",
          objectives: {
            maxLateRatio: 0.1,
            maxUnservedRatio: 0.05,
            maxAverageWait: 90,
            rollingWindowSeconds: 150,
            survivalTime: 600,
          },
          growthWaves: [],
        },
      }),
    );
    expect(custom.scenario.name).toBe("Tight Suburb");
    expect(custom.scenario.objectives?.maxLateRatio).toBe(0.1);
    expect(custom.scenario.objectives?.rollingWindowSeconds).toBe(150);
  });

  it("backend methods return promises so browser and Tauri share one runtime contract", async () => {
    const intent: GameIntent = { type: "setPaused", paused: false };
    const snapshot = createRustSnapshot();
    const backend: GameBackend = {
      ...previewBackendStubs(),
      snapshot: async () => snapshot,
      dispatch: async (received) => ({
        snapshot: {
          ...snapshot,
          paused:
            received.type === "setPaused" ? received.paused : snapshot.paused,
        },
        applied: true,
        rejection: null,
      }),
      tick: async () => ({
        snapshot,
        applied: false,
        rejection: null,
      }),
      reset: async () => ({ ok: true, snapshot }),
    };

    await expect(backend.dispatch(intent)).resolves.toMatchObject({
      applied: true,
      snapshot: { paused: false },
    });

    const routeRequest: RoutePreviewRequest = {
      mode: "bus",
      pattern: "loop",
      waypointIds: ["stop-001", "stop-002"],
      routeId: null,
      expectedRevision: null,
      generation: 7,
    };
    const roadRequest: RoadMutationPreviewRequest = {
      mutation: { type: "layRoad", point: { x: 2, y: 2 } },
      generation: 8,
    };
    expectTypeOf<GameBackend["previewRoute"]>().toEqualTypeOf<
      (request: RoutePreviewRequest) => Promise<RoutePreviewResponse>
    >();
    expectTypeOf<GameBackend["previewRoadMutation"]>().toEqualTypeOf<
      (
        request: RoadMutationPreviewRequest,
      ) => Promise<RoadMutationPreviewResponse>
    >();
    expectTypeOf<GameBackend["snapshotForSave"]>().toEqualTypeOf<
      () => Promise<PersistenceSnapshotResult>
    >();
    expectTypeOf<GameBackend["validateSnapshot"]>().toEqualTypeOf<
      (
        request: PersistenceSnapshotRequest,
      ) => Promise<PersistenceValidationResult>
    >();
    expectTypeOf<GameBackend["restoreSnapshot"]>().toEqualTypeOf<
      (
        request: PersistenceSnapshotRequest,
      ) => Promise<PersistenceSnapshotResult>
    >();
    await expect(backend.previewRoute(routeRequest)).resolves.toMatchObject({
      generation: routeRequest.generation,
      rejection: null,
    });
    await expect(
      backend.previewRoadMutation(roadRequest),
    ).resolves.toMatchObject({
      generation: roadRequest.generation,
      rejection: null,
    });
  });

  it("passes growth waves through from the Rust snapshot", () => {
    const withWave = createRustSnapshot({
      rules: {
        ...createRustSnapshot().rules,
        gameMode: "campaign",
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
        growthWaves: [
          {
            id: "wave-1",
            triggerTime: 0,
            message: "grow",
            applied: false,
            actions: [
              {
                type: "paintAreaRectangle",
                area: "residential",
                start: { x: 2, y: 3 },
                end: { x: 3, y: 3 },
              },
              {
                type: "placeBuilding",
                buildingType: "smallHouse",
                origin: { x: 2, y: 3 },
                rotation: 0,
              },
            ],
          },
        ],
      },
    });

    const normalized = normalizeRustSnapshot(withWave);
    expect(normalized.scenario.growthWaves).toEqual(
      withWave.scenario.growthWaves,
    );
    expect(normalized.scenario.growthWaves[0].actions[1]).toMatchObject({
      type: "placeBuilding",
      buildingType: "smallHouse",
    });
  });
});
