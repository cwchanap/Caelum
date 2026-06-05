import { describe, expect, it } from "vitest";
import { createInitialGameState } from "../../src/simulation/gameState";
import { findRoutePlan } from "../../src/simulation/router";
import {
  addBusRoute,
  addBusStop,
  addMetroLine,
  addMetroStation,
  setRouteActive,
} from "../../src/simulation/transit";

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

    expect(plan?.estimatedSeconds).toBe(310);
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
    state = addMetroStation(state, { x: 7, y: 8 });
    state = addMetroStation(state, { x: 22, y: 8 });
    state = addMetroLine(state, ["station-001", "station-002"]);

    const plan = findRoutePlan(state, { x: 6, y: 8 }, { x: 23, y: 8 });

    expect(plan?.estimatedSeconds).toBe(265);
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
