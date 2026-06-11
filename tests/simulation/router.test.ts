import { describe, expect, it } from "vitest";
import type { GameState, Point } from "../../src/domain/types";
import { createInitialGameState } from "../../src/simulation/gameState";
import { findRoutePlan } from "../../src/simulation/router";
import {
  addBusRoute,
  addBusStop,
  addMetroLine,
  addMetroStation,
  assignVehicle,
  removeInfrastructureAtTile,
  setRouteActive,
  TILES_PER_SECOND,
} from "../../src/simulation/transit";

function withTrack(state: GameState, points: Point[]): GameState {
  const keys = new Set(points.map((p) => `${p.x},${p.y}`));
  return {
    ...state,
    map: {
      ...state.map,
      tiles: state.map.tiles.map((tile) =>
        keys.has(`${tile.x},${tile.y}`) ? { ...tile, hasTrack: true } : tile,
      ),
    },
  };
}

function trackRow(y: number, fromX: number, toX: number): Point[] {
  return Array.from({ length: toX - fromX + 1 }, (_, i) => ({
    x: fromX + i,
    y,
  }));
}

describe("route planning", () => {
  it("creates a walking route for nearby destinations", () => {
    const state = createInitialGameState();

    const plan = findRoutePlan(state, { x: 2, y: 3 }, { x: 4, y: 3 });

    expect(plan).toEqual({
      estimatedSeconds: 40,
      legs: [{ mode: "walk", from: { x: 2, y: 3 }, to: { x: 4, y: 3 } }],
    });
  });

  it("returns null when the origin or destination is outside the map", () => {
    const state = createInitialGameState();

    expect(findRoutePlan(state, { x: -1, y: 3 }, { x: 4, y: 3 })).toBeNull();
    expect(findRoutePlan(state, { x: 2, y: 3 }, { x: 28, y: 17 })).toBeNull();
  });

  it("returns null when the origin or destination is not an integer finite tile coordinate", () => {
    const state = createInitialGameState();

    expect(findRoutePlan(state, { x: 2.5, y: 3 }, { x: 4, y: 3 })).toBeNull();
    expect(
      findRoutePlan(
        state,
        { x: 2, y: 3 },
        { x: Number.POSITIVE_INFINITY, y: 17 },
      ),
    ).toBeNull();
    expect(
      findRoutePlan(state, { x: 2, y: Number.NaN }, { x: 4, y: 3 }),
    ).toBeNull();
  });

  it("creates a bus route when stops connect the origin and destination", () => {
    let state = createInitialGameState();
    state = addBusStop(state, { x: 7, y: 8 });
    state = addBusStop(state, { x: 22, y: 8 });
    state = addBusRoute(state, ["stop-001", "stop-002"]);

    const plan = findRoutePlan(state, { x: 6, y: 8 }, { x: 23, y: 8 });

    // walk(6,8)->(7,8) = 20*1 = 20
    // bus ride: 15 steps at 0.8 tiles/s + 90s boarding = 90 + 15/0.8 = 108.75
    // walk(22,8)->(23,8) = 20*1 = 20
    expect(plan?.estimatedSeconds).toBe(148.75);
    expect(plan?.legs.map((leg) => leg.mode)).toEqual(["walk", "bus", "walk"]);
    expect(plan?.legs[1]).toMatchObject({ mode: "bus", lineId: "route-001" });
    expect(plan?.legs).toEqual([
      { mode: "walk", from: { x: 6, y: 8 }, to: { x: 7, y: 8 } },
      {
        mode: "bus",
        from: { x: 7, y: 8 },
        to: { x: 22, y: 8 },
        lineId: "route-001",
      },
      { mode: "walk", from: { x: 22, y: 8 }, to: { x: 23, y: 8 } },
    ]);
  });

  it("creates a metro route for long station-connected trips", () => {
    let state = createInitialGameState();
    state = withTrack(state, trackRow(8, 7, 22));
    state = addMetroStation(state, { x: 7, y: 8 });
    state = addMetroStation(state, { x: 22, y: 8 });
    state = addMetroLine(state, ["station-001", "station-002"]);

    const plan = findRoutePlan(state, { x: 6, y: 8 }, { x: 23, y: 8 });

    // walk(6,8)->(7,8) = 20*1 = 20
    // metro ride: 15 steps at 1.6 tiles/s + 120s boarding = 120 + 15/1.6 = 129.375
    // walk(22,8)->(23,8) = 20*1 = 20
    expect(plan?.estimatedSeconds).toBe(169.375);
    expect(plan?.legs.map((leg) => leg.mode)).toEqual([
      "walk",
      "metro",
      "walk",
    ]);
    expect(plan?.legs[1]).toMatchObject({ mode: "metro", lineId: "metro-001" });
    expect(plan?.legs).toEqual([
      { mode: "walk", from: { x: 6, y: 8 }, to: { x: 7, y: 8 } },
      {
        mode: "metro",
        from: { x: 7, y: 8 },
        to: { x: 22, y: 8 },
        lineId: "metro-001",
      },
      { mode: "walk", from: { x: 22, y: 8 }, to: { x: 23, y: 8 } },
    ]);
  });

  it("creates a transfer route across bus and metro lines", () => {
    const state = {
      ...createInitialGameState(),
      transit: {
        stops: [
          {
            id: "stop-001",
            kind: "busStop" as const,
            position: { x: 0, y: 0 },
            platforms: [],
          },
          {
            id: "stop-002",
            kind: "busStop" as const,
            position: { x: 13, y: 8 },
            platforms: [],
          },
        ],
        stations: [
          { id: "station-001", position: { x: 13, y: 8 }, platforms: [] },
          {
            id: "station-002",
            position: { x: 27, y: 17 },
            platforms: [],
          },
        ],
        routes: [
          {
            id: "route-001",
            name: "Bus 1",
            color: "#e04f39",
            stopIds: ["stop-001", "stop-002"],
            vehicleIds: [],
            active: true,
            segments: [],
            pathBroken: false,
          },
        ],
        metroLines: [
          {
            id: "metro-001",
            name: "Metro 1",
            color: "#2867b2",
            stationIds: ["station-001", "station-002"],
            vehicleIds: [],
            active: true,
            segments: [],
            pathBroken: false,
          },
        ],
        vehicles: [],
      },
    };

    const plan = findRoutePlan(state, { x: 0, y: 0 }, { x: 27, y: 17 });

    expect(plan?.legs.map((leg) => leg.mode)).toEqual([
      "walk",
      "bus",
      "walk",
      "metro",
      "walk",
    ]);
    expect(plan?.legs).toEqual([
      { mode: "walk", from: { x: 0, y: 0 }, to: { x: 0, y: 0 } },
      {
        mode: "bus",
        from: { x: 0, y: 0 },
        to: { x: 13, y: 8 },
        lineId: "route-001",
      },
      { mode: "walk", from: { x: 13, y: 8 }, to: { x: 13, y: 8 } },
      {
        mode: "metro",
        from: { x: 13, y: 8 },
        to: { x: 27, y: 17 },
        lineId: "metro-001",
      },
      { mode: "walk", from: { x: 27, y: 17 }, to: { x: 27, y: 17 } },
    ]);
  });

  it("ignores inactive routes and lines deterministically", () => {
    let state = createInitialGameState();
    state = addBusStop(state, { x: 7, y: 8 });
    state = addBusStop(state, { x: 22, y: 8 });
    state = addBusRoute(state, ["stop-001", "stop-002"]);
    state = withTrack(state, trackRow(8, 7, 22));
    state = addMetroStation(state, { x: 7, y: 8 });
    state = addMetroStation(state, { x: 22, y: 8 });
    state = addMetroLine(state, ["station-001", "station-002"]);
    state = {
      ...state,
      transit: {
        ...state.transit,
        routes: state.transit.routes.map((route) => ({
          ...route,
          active: false,
        })),
        metroLines: state.transit.metroLines.map((line) => ({
          ...line,
          active: false,
        })),
      },
    };

    const plan = findRoutePlan(state, { x: 6, y: 8 }, { x: 23, y: 8 });

    expect(plan).toEqual({
      estimatedSeconds: 340,
      legs: [{ mode: "walk", from: { x: 6, y: 8 }, to: { x: 23, y: 8 } }],
    });
  });

  it("drops the bus leg once the route is toggled inactive via setRouteActive", () => {
    let state = createInitialGameState();
    state = addBusStop(state, { x: 7, y: 8 });
    state = addBusStop(state, { x: 22, y: 8 });
    state = addBusRoute(state, ["stop-001", "stop-002"]);

    const active = findRoutePlan(state, { x: 6, y: 8 }, { x: 23, y: 8 });
    expect(active?.legs.map((leg) => leg.mode)).toEqual([
      "walk",
      "bus",
      "walk",
    ]);

    const inactiveState = setRouteActive(state, "route-001", false);
    const inactive = findRoutePlan(
      inactiveState,
      { x: 6, y: 8 },
      { x: 23, y: 8 },
    );
    expect(inactive?.legs.some((leg) => leg.mode === "bus")).toBe(false);
  });
});

describe("path-length ride estimates", () => {
  it("estimates bus rides from stored segment steps, not Manhattan distance", () => {
    let state = createInitialGameState();
    state = addBusStop(state, { x: 7, y: 8 });
    state = addBusStop(state, { x: 22, y: 8 });
    state = addBusRoute(state, ["stop-001", "stop-002"]);
    state = assignVehicle(state, "bus", "route-001");

    const plan = findRoutePlan(state, { x: 7, y: 8 }, { x: 22, y: 8 });

    expect(plan).not.toBeNull();
    const busLeg = plan?.legs.find((leg) => leg.mode === "bus");
    expect(busLeg).toBeDefined();
    // 15 steps at 0.8 tiles/s + 90s boarding = 108.75s
    expect(plan?.estimatedSeconds).toBeCloseTo(
      90 + 15 / TILES_PER_SECOND.bus,
      5,
    );
  });

  it("ignores pathBroken routes when planning", () => {
    let state = createInitialGameState();
    state = addBusStop(state, { x: 7, y: 8 });
    state = addBusStop(state, { x: 22, y: 8 });
    state = addBusRoute(state, ["stop-001", "stop-002"]);
    state = removeInfrastructureAtTile(state, { x: 11, y: 8 });
    expect(state.transit.routes[0].pathBroken).toBe(true);

    const plan = findRoutePlan(state, { x: 7, y: 8 }, { x: 22, y: 8 });
    expect(plan?.legs.every((leg) => leg.mode === "walk")).toBe(true);
  });

  it("rides forward around the loop when the alighting stop is behind the boarding stop", () => {
    let state = createInitialGameState();
    state = addBusStop(state, { x: 7, y: 8 });
    state = addBusStop(state, { x: 15, y: 8 });
    state = addBusStop(state, { x: 22, y: 8 });
    state = addBusRoute(state, ["stop-001", "stop-002", "stop-003"]);
    state = assignVehicle(state, "bus", "route-001");

    // Origin beside stop-002 (index 1), destination beside stop-001 (index 0):
    // vehicles only travel forward, so the ride wraps 1 -> 2 -> 0 through the
    // closing segment: 7 + 15 = 22 steps. 90 + 22/0.8 = 117.5, plus 20s walk
    // on each end.
    const plan = findRoutePlan(state, { x: 16, y: 8 }, { x: 6, y: 8 });

    expect(plan).not.toBeNull();
    expect(plan?.estimatedSeconds).toBeCloseTo(20 + 117.5 + 20, 5);
  });
});
