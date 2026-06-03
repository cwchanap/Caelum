import { describe, expect, it } from "vitest";
import {
  busPlatforms,
  metroPlatforms,
  onPlatformCitizenIds,
  platformWaiterIds,
  selectPlatformOccupancy,
} from "../../src/simulation/platforms";
import type { Citizen, GameState, Stop } from "../../src/domain/types";

function waitingCitizen(
  id: string,
  position: { x: number; y: number },
  lineId: string,
  patienceRemaining: number,
): Citizen {
  return {
    id,
    home: position,
    destination: { x: 0, y: 0 },
    position,
    status: "waiting",
    patienceRemaining,
    deadline: 9_999,
    routePlan: {
      estimatedSeconds: 100,
      legs: [{ mode: "bus", from: position, to: { x: 0, y: 0 }, lineId }],
    },
    currentLegIndex: 0,
  };
}

function stateWithStop(stop: Stop, citizens: Citizen[]): GameState {
  return {
    time: 0,
    speed: 1,
    paused: false,
    budget: 0,
    map: { width: 20, height: 20, tiles: [] },
    buildings: [],
    scenario: {
      name: "t",
      growthWaves: [],
      objectives: {
        maxLateRatio: 1,
        maxUnservedRatio: 1,
        maxAverageWait: 9_999,
        rollingWindowSeconds: 1,
        survivalTime: 1,
      },
    },
    transit: {
      stops: [stop],
      stations: [],
      routes: [],
      metroLines: [],
      vehicles: [],
    },
    citizens,
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
  };
}

describe("platform builders", () => {
  it("creates one capacity-50 platform for a bus stop", () => {
    const platforms = busPlatforms("stop-001", "busStop");
    expect(platforms).toEqual([
      { id: "stop-001-p0", label: "A", capacity: 50, routeIds: [] },
    ]);
  });

  it("creates three capacity-50 platforms for a bus terminal", () => {
    const platforms = busPlatforms("stop-002", "busTerminal");
    expect(platforms.map((p) => p.label)).toEqual(["A", "B", "C"]);
    expect(platforms.every((p) => p.capacity === 50)).toBe(true);
    expect(platforms.map((p) => p.id)).toEqual([
      "stop-002-p0",
      "stop-002-p1",
      "stop-002-p2",
    ]);
  });

  it("creates two capacity-300 platforms for a metro station", () => {
    const platforms = metroPlatforms("station-001");
    expect(platforms.map((p) => p.label)).toEqual(["A", "B"]);
    expect(platforms.every((p) => p.capacity === 300)).toBe(true);
  });
});

describe("platform occupancy derivations", () => {
  const stop: Stop = {
    id: "stop-001",
    kind: "busStop",
    position: { x: 5, y: 5 },
    platforms: [
      { id: "stop-001-p0", label: "A", capacity: 2, routeIds: ["route-001"] },
    ],
  };

  it("counts waiting citizens whose line is on the platform", () => {
    const state = stateWithStop(stop, [
      waitingCitizen("c1", { x: 5, y: 5 }, "route-001", 100),
      waitingCitizen("c2", { x: 5, y: 5 }, "route-001", 90),
      waitingCitizen("c3", { x: 5, y: 5 }, "route-002", 80), // different line
    ]);
    expect(selectPlatformOccupancy(state).get("stop-001-p0")).toEqual({
      count: 2,
      capacity: 2,
    });
  });

  it("includes only the first `capacity` waiters (longest-waiting first) on the platform", () => {
    const state = stateWithStop(stop, [
      waitingCitizen("c1", { x: 5, y: 5 }, "route-001", 100), // most patience -> overflow
      waitingCitizen("c2", { x: 5, y: 5 }, "route-001", 50),
      waitingCitizen("c3", { x: 5, y: 5 }, "route-001", 10), // least patience -> on platform
    ]);
    const onPlatform = onPlatformCitizenIds(state);
    expect(onPlatform.has("c3")).toBe(true);
    expect(onPlatform.has("c2")).toBe(true);
    expect(onPlatform.has("c1")).toBe(false);
  });

  it("orders waiter ids longest-waiting (lowest patience) first", () => {
    const state = stateWithStop(stop, [
      waitingCitizen("c1", { x: 5, y: 5 }, "route-001", 100),
      waitingCitizen("c2", { x: 5, y: 5 }, "route-001", 50),
      waitingCitizen("c3", { x: 5, y: 5 }, "route-001", 10),
    ]);
    expect(platformWaiterIds(state).get("stop-001-p0")).toEqual([
      "c3",
      "c2",
      "c1",
    ]);
  });

  it("breaks patience ties by id ascending", () => {
    const state = stateWithStop(stop, [
      waitingCitizen("cb", { x: 5, y: 5 }, "route-001", 40),
      waitingCitizen("ca", { x: 5, y: 5 }, "route-001", 40),
    ]);
    expect(platformWaiterIds(state).get("stop-001-p0")).toEqual(["ca", "cb"]);
  });

  it("keys the index by position|lineId so same-position lines split by platform", () => {
    const sharedPosition = { x: 7, y: 7 };
    const multiLineStop: Stop = {
      id: "stop-multi",
      kind: "busTerminal",
      position: sharedPosition,
      platforms: [
        {
          id: "stop-multi-p0",
          label: "A",
          capacity: 2,
          routeIds: ["route-001"],
        },
        {
          id: "stop-multi-p1",
          label: "B",
          capacity: 2,
          routeIds: ["route-002"],
        },
      ],
    };
    const state = stateWithStop(multiLineStop, [
      waitingCitizen("c1", sharedPosition, "route-001", 100),
      waitingCitizen("c2", sharedPosition, "route-002", 100),
    ]);

    const occupancy = selectPlatformOccupancy(state);
    expect(occupancy.get("stop-multi-p0")).toEqual({ count: 1, capacity: 2 });
    expect(occupancy.get("stop-multi-p1")).toEqual({ count: 1, capacity: 2 });

    const onPlatform = onPlatformCitizenIds(state);
    expect(onPlatform.has("c1")).toBe(true);
    expect(onPlatform.has("c2")).toBe(true);
  });

  it("derives station occupancy through the stops+stations union", () => {
    const stationPosition = { x: 9, y: 9 };
    const stationCitizen: Citizen = {
      id: "m1",
      home: stationPosition,
      destination: { x: 0, y: 0 },
      position: stationPosition,
      status: "waiting",
      patienceRemaining: 100,
      deadline: 9_999,
      routePlan: {
        estimatedSeconds: 100,
        legs: [
          {
            mode: "metro",
            from: stationPosition,
            to: { x: 0, y: 0 },
            lineId: "metro-001",
          },
        ],
      },
      currentLegIndex: 0,
    };
    const state = stateWithStop(
      {
        id: "stop-unused",
        kind: "busStop",
        position: { x: 1, y: 1 },
        platforms: [],
      },
      [stationCitizen],
    );
    state.transit.stations = [
      {
        id: "station-001",
        position: stationPosition,
        platforms: [
          {
            id: "station-001-p0",
            label: "A",
            capacity: 300,
            routeIds: ["metro-001"],
          },
        ],
      },
    ];

    expect(selectPlatformOccupancy(state).get("station-001-p0")).toEqual({
      count: 1,
      capacity: 300,
    });
    expect(onPlatformCitizenIds(state).has("m1")).toBe(true);
  });
});
