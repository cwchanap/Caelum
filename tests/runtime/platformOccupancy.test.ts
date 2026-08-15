import { describe, expect, it } from "vitest";
import {
  positionKey,
  selectPlatformOccupancy,
  waitingLineId,
} from "../../src/domain/platformOccupancy";
import { createTestGameState } from "../helpers/gameState";
import type { ActiveTrip, Stop } from "../../src/domain/types";

const stop: Stop = {
  id: "stop-001",
  kind: "busStop",
  status: "present",
  position: { x: 3, y: 3 },
  platforms: [
    {
      id: "stop-001-p0",
      label: "A",
      capacity: 2,
      routeIds: ["route-001"],
    },
  ],
};

function stateWithTrips(trips: ActiveTrip[]) {
  return {
    ...createTestGameState(),
    transit: {
      ...createTestGameState().transit,
      stops: [stop],
      stations: [],
      routes: [],
      metroLines: [],
      vehicles: [],
    },
    activeTrips: trips,
  };
}

function waitingTrip(
  position: { x: number; y: number },
  lineId: string | undefined,
): ActiveTrip {
  return {
    id: `trip-${position.x}-${position.y}-${lineId ?? "walk"}`,
    simId: "sim-001",
    purpose: "commuteOutbound",
    origin: { x: 0, y: 0 },
    destination: { x: 9, y: 9 },
    position,
    status: "waiting",
    deadline: 9_999,
    routePlan: {
      estimatedSeconds: 100,
      legs: [
        {
          mode: lineId === undefined ? "walk" : "bus",
          from: position,
          to: { x: 9, y: 9 },
          ...(lineId === undefined ? {} : { lineId }),
          serviceDirection: lineId === undefined ? null : "loop",
          boardItineraryIndex: lineId === undefined ? null : 0,
          alightItineraryIndex: lineId === undefined ? null : 0,
        },
      ],
    },
    currentLegIndex: 0,
    patienceRemaining: 100,
    privateCarTrip: null,
  };
}

describe("positionKey", () => {
  it("joins coordinates with a comma", () => {
    expect(positionKey(3, 5)).toBe("3,5");
  });
});

describe("waitingLineId", () => {
  it("returns the lineId for a transit leg", () => {
    expect(waitingLineId(waitingTrip({ x: 1, y: 1 }, "route-001"))).toBe(
      "route-001",
    );
  });

  it("returns undefined for a walk leg", () => {
    expect(
      waitingLineId(waitingTrip({ x: 1, y: 1 }, undefined)),
    ).toBeUndefined();
  });
});

describe("selectPlatformOccupancy", () => {
  it("counts waiting trips on the matching platform", () => {
    const state = stateWithTrips([
      waitingTrip({ x: 3, y: 3 }, "route-001"),
      waitingTrip({ x: 3, y: 3 }, "route-001"),
    ]);
    const occupancy = selectPlatformOccupancy(state);
    expect(occupancy.get("stop-001-p0")).toEqual({ count: 2, capacity: 2 });
  });

  it("ignores non-waiting trips", () => {
    const riding: ActiveTrip = {
      ...waitingTrip({ x: 3, y: 3 }, "route-001"),
      status: "riding",
    };
    const state = stateWithTrips([riding]);
    const occupancy = selectPlatformOccupancy(state);
    expect(occupancy.get("stop-001-p0")).toEqual({ count: 0, capacity: 2 });
  });

  it("ignores waiting trips whose current leg is a walk (no lineId)", () => {
    const state = stateWithTrips([waitingTrip({ x: 3, y: 3 }, undefined)]);
    const occupancy = selectPlatformOccupancy(state);
    expect(occupancy.get("stop-001-p0")).toEqual({ count: 0, capacity: 2 });
  });

  it("does not count a waiting trip whose lineId is not served by the platform", () => {
    const state = stateWithTrips([waitingTrip({ x: 3, y: 3 }, "route-999")]);
    const occupancy = selectPlatformOccupancy(state);
    expect(occupancy.get("stop-001-p0")).toEqual({ count: 0, capacity: 2 });
  });

  it("returns an entry with zero count when no trips are waiting", () => {
    const state = stateWithTrips([]);
    const occupancy = selectPlatformOccupancy(state);
    expect(occupancy.get("stop-001-p0")).toEqual({ count: 0, capacity: 2 });
  });

  it("does not expose a platform entry or queue for a missing node", () => {
    const state = stateWithTrips([waitingTrip({ x: 3, y: 3 }, "route-001")]);
    state.transit.stops[0] = {
      ...state.transit.stops[0],
      status: "missing",
    };

    const occupancy = selectPlatformOccupancy(state);

    expect(occupancy.has("stop-001-p0")).toBe(false);
  });
});
