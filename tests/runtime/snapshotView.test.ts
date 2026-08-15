import { describe, expect, it } from "vitest";

import type { RustGameSnapshot } from "../../src/runtime/backend/types";
import { normalizeRustSnapshot } from "../../src/runtime/snapshotView";
import { createRustSnapshot } from "../fixtures/rustSnapshot";

const rawSimWithSkippedNull: RustGameSnapshot["sims"][number] = {
  id: "sim-skipped-null",
  home: { x: 1, y: 1 },
  position: { x: 1, y: 1 },
  workerProfile: "worker",
  // @ts-expect-error Rust skip_serializing_if fields are omitted, never null.
  shiftTemplate: null,
  commuteDay: 0,
  outboundResolvedToday: false,
  outboundArrivedToday: false,
  returnResolvedToday: false,
  returnedHomeToday: false,
};
void rawSimWithSkippedNull;

function createNullishWireSnapshot(
  nullish: "undefined" | "null",
): RustGameSnapshot {
  const none = nullish === "undefined" ? undefined : null;

  return {
    ...createRustSnapshot(),
    transit: {
      stops: [],
      stations: [],
      routes: [
        {
          id: "route-001",
          name: "Bus 1",
          color: "#00aaff",
          stopIds: ["stop-001", "stop-002"],
          vehicleIds: [],
          active: true,
          pattern: "loop" as const,
          revision: 1,
          legs: [
            {
              fromWaypointId: "stop-001",
              toWaypointId: "stop-002",
              direction: "loop" as const,
              kind: "service" as const,
              status: "networkDisconnected" as const,
              currentPath: none,
              lastValidPath: none,
              estimatedSeconds: none,
            },
          ],
          pathBroken: true,
          targetHeadwaySeconds: null,
        },
      ],
      metroLines: [
        {
          id: "metro-001",
          name: "Metro 1",
          color: "#aa00ff",
          stationIds: ["station-001", "station-002"],
          vehicleIds: [],
          active: true,
          pattern: "shuttle" as const,
          revision: 1,
          legs: [
            {
              fromWaypointId: "station-001",
              toWaypointId: "station-002",
              direction: "outbound" as const,
              kind: "service" as const,
              status: "networkDisconnected" as const,
              currentPath: none,
              lastValidPath: none,
              estimatedSeconds: none,
            },
          ],
          pathBroken: true,
        },
      ],
      vehicles: [
        {
          id: "vehicle-001",
          mode: "bus" as const,
          lineId: "route-001",
          capacity: 30,
          passengerIds: [],
          itineraryIndex: 0,
          pathStepIndex: 0,
          stepProgress: 0,
          parkedPosition: none,
        },
      ],
    },
    sims: [
      {
        id: "sim-001",
        home: { x: 1, y: 1 },
        position: { x: 1, y: 1 },
        workerProfile: "worker" as const,
        commuteDay: 0,
        outboundResolvedToday: false,
        outboundArrivedToday: false,
        returnResolvedToday: false,
        returnedHomeToday: false,
      },
    ],
    activeTrips: [
      {
        id: "trip-001",
        simId: "sim-001",
        purpose: "commuteOutbound" as const,
        origin: { x: 1, y: 1 },
        destination: { x: 5, y: 1 },
        position: { x: 1, y: 1 },
        status: "waiting" as const,
        deadline: 600,
        routePlan: {
          estimatedSeconds: 60,
          legs: [
            {
              mode: "bus" as const,
              from: { x: 1, y: 1 },
              to: { x: 5, y: 1 },
              serviceDirection: none,
              boardItineraryIndex: none,
              alightItineraryIndex: none,
            },
          ],
        },
        currentLegIndex: 0,
        patienceRemaining: 120,
        privateCarTrip: none,
      },
      {
        id: "trip-002",
        simId: "sim-001",
        purpose: "commuteReturn" as const,
        origin: { x: 5, y: 1 },
        destination: { x: 1, y: 1 },
        position: { x: 5, y: 1 },
        status: "walking" as const,
        deadline: 1_200,
        routePlan: none,
        currentLegIndex: 0,
        patienceRemaining: 120,
        privateCarTrip: none,
      },
    ],
    metrics: {
      lateTrips: 0,
      completedTrips: 0,
      unservedTrips: 0,
      totalWaitSeconds: 0,
      waitingTripCount: 1,
      averageWaitSeconds: 0,
      tripOutcomes: [],
      state: "running" as const,
      lossReason: none,
    },
    scenario: {
      name: "Crossroads",
      objectives: none,
      growthWaves: [],
    },
  };
}

describe("normalizeRustSnapshot", () => {
  it("normalizes ordinary WASM and JSON-compatible nullish raw snapshots equally", () => {
    const ordinary = createNullishWireSnapshot("undefined");
    const jsonCompatible = createNullishWireSnapshot("null");

    expect(normalizeRustSnapshot(ordinary)).toEqual(
      normalizeRustSnapshot(jsonCompatible),
    );

    const normalized = normalizeRustSnapshot(ordinary);
    expect(normalized.scenario.objectives).toBeNull();
    expect(normalized.metrics.lossReason).toBeNull();
    expect(normalized.transit.routes[0].legs[0].failureReason).toBeNull();
    expect(normalized.activeTrips[0].routePlan?.legs[0]).toMatchObject({
      serviceDirection: null,
      boardItineraryIndex: null,
      alightItineraryIndex: null,
    });
    expect(normalized.activeTrips[1].routePlan).toBeNull();
    expect("lineId" in normalized.activeTrips[0].routePlan!.legs[0]).toBe(
      false,
    );
    expect("shiftTemplate" in normalized.sims[0]).toBe(false);
    expect("workplace" in normalized.sims[0]).toBe(false);
  });
});
