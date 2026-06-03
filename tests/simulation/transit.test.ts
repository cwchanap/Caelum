import { describe, expect, it } from "vitest";
import type { GameState } from "../../src/domain/types";
import { placeBuilding } from "../../src/simulation/buildings";
import { createInitialGameState } from "../../src/simulation/gameState";
import {
  addBusRoute,
  addBusStop,
  addMetroLine,
  addMetroStation,
  assignVehicle,
  stopCoverageRadius,
  tickVehicles,
} from "../../src/simulation/transit";

function createBusState(): GameState {
  let state = createInitialGameState();
  state = addBusStop(state, { x: 7, y: 8 });
  state = addBusStop(state, { x: 15, y: 8 });
  state = addBusRoute(state, ["stop-001", "stop-002"]);
  return assignVehicle(state, "bus", "route-001");
}

function createThreeStopBusState(): GameState {
  let state = createInitialGameState();
  state = addBusStop(state, { x: 7, y: 8 });
  state = addBusStop(state, { x: 15, y: 8 });
  state = addBusStop(state, { x: 22, y: 8 });
  state = addBusRoute(state, ["stop-001", "stop-002", "stop-003"]);
  return assignVehicle(state, "bus", "route-001");
}

describe("transit network actions", () => {
  it("adds a bus stop on a valid road tile and charges the budget", () => {
    const state = createInitialGameState();

    const nextState = addBusStop(state, { x: 7, y: 8 });

    expect(nextState.transit.stops).toEqual([
      {
        id: "stop-001",
        kind: "busStop",
        position: { x: 7, y: 8 },
        platforms: [
          { id: "stop-001-p0", label: "A", capacity: 50, routeIds: [] },
        ],
      },
    ]);
    expect(nextState.budget).toBe(118_000);
  });

  it("returns expanded coverage for bus terminals", () => {
    expect(
      stopCoverageRadius({
        id: "stop-001",
        kind: "busTerminal",
        position: { x: 0, y: 0 },
        platforms: [],
      }),
    ).toBe(4);
    expect(
      stopCoverageRadius({
        id: "stop-002",
        kind: "busStop",
        position: { x: 0, y: 0 },
        platforms: [],
      }),
    ).toBe(2);
  });

  it("returns the original state when adding a bus stop on an invalid residential tile", () => {
    const state = createInitialGameState();

    const nextState = addBusStop(state, { x: 2, y: 3 });

    expect(nextState).toBe(state);
  });

  it("returns the original state when adding a metro station on a placed building footprint", () => {
    const state = placeBuilding(
      createInitialGameState(),
      "largeHouse",
      { x: 0, y: 0 },
      0,
    );

    const nextState = addMetroStation(state, { x: 2, y: 1 });

    expect(nextState).toBe(state);
  });

  it("creates an active bus route and assigns a bus vehicle to it", () => {
    let state = createInitialGameState();
    state = addBusStop(state, { x: 7, y: 8 });
    state = addBusStop(state, { x: 22, y: 8 });
    state = addBusRoute(state, ["stop-001", "stop-002"]);

    const nextState = assignVehicle(state, "bus", "route-001");

    expect(nextState.transit.routes[0]).toMatchObject({
      id: "route-001",
      name: "Bus 1",
      color: "#e04f39",
      stopIds: ["stop-001", "stop-002"],
      vehicleIds: ["vehicle-001"],
      active: true,
    });
    expect(nextState.transit.vehicles[0]).toEqual({
      id: "vehicle-001",
      mode: "bus",
      lineId: "route-001",
      capacity: 18,
      passengerIds: [],
      segmentIndex: 0,
      progress: 0,
    });
  });

  it("allocates route, metro line, and vehicle ids after lower ids are removed", () => {
    let state = createInitialGameState();
    state = addBusStop(state, { x: 7, y: 8 });
    state = addBusStop(state, { x: 15, y: 8 });
    state = addBusStop(state, { x: 22, y: 8 });
    state = addBusRoute(state, ["stop-001", "stop-002"]);
    state = addBusRoute(state, ["stop-002", "stop-003"]);
    state = assignVehicle(state, "bus", "route-001");
    state = assignVehicle(state, "bus", "route-002");
    state = {
      ...state,
      transit: {
        ...state.transit,
        routes: state.transit.routes.filter(
          (route) => route.id !== "route-001",
        ),
        vehicles: state.transit.vehicles.filter(
          (vehicle) => vehicle.id !== "vehicle-001",
        ),
      },
    };

    const withRoute = addBusRoute(state, ["stop-001", "stop-003"]);
    const withVehicle = assignVehicle(withRoute, "bus", "route-002");

    expect(withRoute.transit.routes.map((route) => route.id)).toEqual([
      "route-002",
      "route-003",
    ]);
    expect(withVehicle.transit.vehicles.map((vehicle) => vehicle.id)).toEqual([
      "vehicle-002",
      "vehicle-003",
    ]);

    let metroState = createInitialGameState();
    metroState = addMetroStation(metroState, { x: 7, y: 8 });
    metroState = addMetroStation(metroState, { x: 15, y: 8 });
    metroState = addMetroStation(metroState, { x: 22, y: 8 });
    metroState = addMetroLine(metroState, ["station-001", "station-002"]);
    metroState = addMetroLine(metroState, ["station-002", "station-003"]);
    metroState = {
      ...metroState,
      transit: {
        ...metroState.transit,
        metroLines: metroState.transit.metroLines.filter(
          (line) => line.id !== "metro-001",
        ),
      },
    };

    const withMetroLine = addMetroLine(metroState, [
      "station-001",
      "station-003",
    ]);

    expect(withMetroLine.transit.metroLines.map((line) => line.id)).toEqual([
      "metro-002",
      "metro-003",
    ]);
  });

  it("keeps bus routes inactive when stop IDs do not include two distinct valid stops", () => {
    let state = createInitialGameState();
    state = addBusStop(state, { x: 7, y: 8 });
    state = addBusRoute(state, ["stop-001", "stop-001"]);

    expect(state.transit.routes[0]).toMatchObject({
      stopIds: ["stop-001", "stop-001"],
      active: false,
    });
  });

  it("creates an active metro line and assigns a metro vehicle to it", () => {
    let state = createInitialGameState();
    state = addMetroStation(state, { x: 7, y: 8 });
    state = addMetroStation(state, { x: 22, y: 8 });
    state = addMetroLine(state, ["station-001", "station-002"]);

    const nextState = assignVehicle(state, "metro", "metro-001");

    expect(nextState.transit.metroLines[0]).toMatchObject({
      id: "metro-001",
      name: "Metro 1",
      color: "#2867b2",
      stationIds: ["station-001", "station-002"],
      vehicleIds: ["vehicle-001"],
      active: true,
    });
    expect(nextState.transit.vehicles[0]).toEqual({
      id: "vehicle-001",
      mode: "metro",
      lineId: "metro-001",
      capacity: 90,
      passengerIds: [],
      segmentIndex: 0,
      progress: 0,
    });
  });

  it("keeps metro lines inactive when station IDs do not include two distinct valid stations", () => {
    let state = createInitialGameState();
    state = addMetroStation(state, { x: 7, y: 8 });
    state = addMetroLine(state, ["station-001", "station-001"]);

    expect(state.transit.metroLines[0]).toMatchObject({
      stationIds: ["station-001", "station-001"],
      active: false,
    });
  });

  it("returns the original state when assigning vehicles to missing or mismatched lines", () => {
    let state = createInitialGameState();
    state = addBusStop(state, { x: 7, y: 8 });
    state = addBusStop(state, { x: 22, y: 8 });
    state = addBusRoute(state, ["stop-001", "stop-002"]);

    expect(assignVehicle(state, "bus", "route-999")).toBe(state);
    expect(assignVehicle(state, "metro", "route-001")).toBe(state);
  });

  it("returns the original state when assigning a bus vehicle to an inactive route", () => {
    let state = createInitialGameState();
    state = addBusStop(state, { x: 7, y: 8 });
    state = addBusRoute(state, ["stop-001"]);

    expect(assignVehicle(state, "bus", "route-001")).toBe(state);
  });

  it("returns the original state when assigning a metro vehicle to an inactive line", () => {
    let state = createInitialGameState();
    state = addMetroStation(state, { x: 7, y: 8 });
    state = addMetroLine(state, ["station-001"]);

    expect(assignVehicle(state, "metro", "metro-001")).toBe(state);
  });

  it("moves vehicles along their assigned line", () => {
    const state = createBusState();

    const nextState = tickVehicles(state, 30);

    expect(nextState.transit.vehicles[0]?.progress).toBeGreaterThan(0);
  });

  it("boards waiting citizens up to vehicle capacity", () => {
    const state = {
      ...createBusState(),
      citizens: Array.from({ length: 20 }, (_, index) => ({
        ...createInitialGameState().citizens[0]!,
        id: `citizen-${String(index + 1).padStart(3, "0")}`,
        position: { x: 7, y: 8 },
        status: "waiting" as const,
        routePlan: {
          estimatedSeconds: 60,
          legs: [
            {
              mode: "bus" as const,
              from: { x: 7, y: 8 },
              to: { x: 15, y: 8 },
              lineId: "route-001",
            },
          ],
        },
        currentLegIndex: 0,
      })),
    };

    const nextState = tickVehicles(state, 1);

    expect(nextState.transit.vehicles[0]?.passengerIds).toHaveLength(18);
    expect(
      nextState.citizens.filter((citizen) => citizen.status === "riding"),
    ).toHaveLength(18);
  });

  it("does not board a citizen waiting at a later stop on the same line", () => {
    const state = {
      ...createBusState(),
      citizens: [
        {
          ...createInitialGameState().citizens[0]!,
          position: { x: 15, y: 8 },
          status: "waiting" as const,
          routePlan: {
            estimatedSeconds: 60,
            legs: [
              {
                mode: "bus" as const,
                from: { x: 15, y: 8 },
                to: { x: 7, y: 8 },
                lineId: "route-001",
              },
            ],
          },
          currentLegIndex: 0,
        },
      ],
    };

    const nextState = tickVehicles(state, 1);

    expect(nextState.transit.vehicles[0]?.passengerIds).toEqual([]);
    expect(nextState.citizens[0]?.status).toBe("waiting");
  });

  it("does not board waiting citizens while a vehicle is mid-segment", () => {
    const busState = createBusState();
    const state = {
      ...busState,
      transit: {
        ...busState.transit,
        vehicles: [{ ...busState.transit.vehicles[0]!, progress: 0.5 }],
      },
      citizens: [
        {
          ...createInitialGameState().citizens[0]!,
          position: { x: 7, y: 8 },
          status: "waiting" as const,
          routePlan: {
            estimatedSeconds: 60,
            legs: [
              {
                mode: "bus" as const,
                from: { x: 7, y: 8 },
                to: { x: 15, y: 8 },
                lineId: "route-001",
              },
            ],
          },
          currentLegIndex: 0,
        },
      ],
    };

    const nextState = tickVehicles(state, 1);

    expect(nextState.transit.vehicles[0]?.passengerIds).toEqual([]);
    expect(nextState.citizens[0]?.status).toBe("waiting");
  });

  it("does not board a citizen already riding in another vehicle", () => {
    const busState = createBusState();
    const state = {
      ...busState,
      transit: {
        ...busState.transit,
        vehicles: [
          {
            ...busState.transit.vehicles[0]!,
            id: "vehicle-001",
            passengerIds: ["citizen-001"],
            progress: 0.5,
          },
          {
            ...busState.transit.vehicles[0]!,
            id: "vehicle-002",
            passengerIds: [],
            progress: 0,
          },
        ],
      },
      citizens: [
        {
          ...createInitialGameState().citizens[0]!,
          position: { x: 7, y: 8 },
          status: "waiting" as const,
          routePlan: {
            estimatedSeconds: 60,
            legs: [
              {
                mode: "bus" as const,
                from: { x: 7, y: 8 },
                to: { x: 15, y: 8 },
                lineId: "route-001",
              },
            ],
          },
          currentLegIndex: 0,
        },
      ],
    };

    const nextState = tickVehicles(state, 1);

    expect(nextState.transit.vehicles[0]?.passengerIds).toEqual([
      "citizen-001",
    ]);
    expect(nextState.transit.vehicles[1]?.passengerIds).toEqual([]);
  });

  it("disembarks passengers and advances their current leg when reaching the next segment", () => {
    const busState = createBusState();
    const state = {
      ...busState,
      transit: {
        ...busState.transit,
        vehicles: [
          {
            ...busState.transit.vehicles[0]!,
            passengerIds: ["citizen-001", "citizen-002"],
            progress: 0.99,
          },
        ],
      },
      citizens: createInitialGameState()
        .citizens.slice(0, 2)
        .map((citizen) => ({
          ...citizen,
          status: "riding" as const,
          routePlan: {
            estimatedSeconds: 60,
            legs: [
              {
                mode: "bus" as const,
                from: { x: 7, y: 8 },
                to: { x: 15, y: 8 },
                lineId: "route-001",
              },
              {
                mode: "walk" as const,
                from: { x: 15, y: 8 },
                to: { x: 16, y: 8 },
              },
            ],
          },
          currentLegIndex: 0,
        })),
    };

    const nextState = tickVehicles(state, 1);

    expect(nextState.transit.vehicles[0]?.segmentIndex).toBe(1);
    expect(nextState.transit.vehicles[0]?.passengerIds).toEqual([]);
    expect(nextState.citizens).toEqual([
      expect.objectContaining({
        id: "citizen-001",
        position: { x: 15, y: 8 },
        status: "walking",
        currentLegIndex: 1,
      }),
      expect.objectContaining({
        id: "citizen-002",
        position: { x: 15, y: 8 },
        status: "walking",
        currentLegIndex: 1,
      }),
    ]);
  });

  it("keeps passengers riding through an intermediate stop before their destination stop", () => {
    const busState = createThreeStopBusState();
    const state = {
      ...busState,
      transit: {
        ...busState.transit,
        vehicles: [
          {
            ...busState.transit.vehicles[0]!,
            passengerIds: ["citizen-001"],
            progress: 0.99,
          },
        ],
      },
      citizens: [
        {
          ...createInitialGameState().citizens[0]!,
          status: "riding" as const,
          routePlan: {
            estimatedSeconds: 120,
            legs: [
              {
                mode: "bus" as const,
                from: { x: 7, y: 8 },
                to: { x: 22, y: 8 },
                lineId: "route-001",
              },
            ],
          },
          currentLegIndex: 0,
        },
      ],
    };

    const nextState = tickVehicles(state, 1);

    expect(nextState.transit.vehicles[0]?.segmentIndex).toBe(1);
    expect(nextState.transit.vehicles[0]?.passengerIds).toEqual([
      "citizen-001",
    ]);
    expect(nextState.citizens[0]).toEqual(
      expect.objectContaining({ status: "riding", currentLegIndex: 0 }),
    );
  });

  it("leaves inactive and missing line vehicles unchanged", () => {
    const baseState = createInitialGameState();
    const state = {
      ...baseState,
      transit: {
        ...baseState.transit,
        routes: [
          {
            id: "route-001",
            name: "Bus 1",
            color: "#e04f39",
            stopIds: ["stop-001", "stop-002"],
            vehicleIds: ["vehicle-001"],
            active: false,
          },
        ],
        vehicles: [
          {
            id: "vehicle-001",
            mode: "bus" as const,
            lineId: "route-001",
            capacity: 18,
            passengerIds: [],
            segmentIndex: 0,
            progress: 0.25,
          },
          {
            id: "vehicle-002",
            mode: "metro" as const,
            lineId: "metro-999",
            capacity: 90,
            passengerIds: [],
            segmentIndex: 0,
            progress: 0.5,
          },
        ],
      },
    };

    const nextState = tickVehicles(state, 30);

    expect(nextState.transit.vehicles).toEqual(state.transit.vehicles);
  });
});

describe("auto-assign routes to platforms", () => {
  it("registers a new bus route on each served stop's least-loaded platform", () => {
    let state = createInitialGameState();
    state = { ...state, budget: 1_000_000 };
    state = addBusStop(state, { x: 7, y: 2 });
    state = addBusStop(state, { x: 22, y: 2 });
    const stopIds = state.transit.stops.map((s) => s.id);

    state = addBusRoute(state, stopIds);
    const routeId = state.transit.routes.at(-1)!.id;

    for (const stop of state.transit.stops) {
      const holding = stop.platforms.filter((p) =>
        p.routeIds.includes(routeId),
      );
      expect(holding).toHaveLength(1);
    }
  });

  it("spreads two routes across a terminal's platforms (least-loaded first)", () => {
    let state = createInitialGameState();
    state = { ...state, budget: 1_000_000 };
    state = addBusStop(state, { x: 7, y: 2 }, "busTerminal");
    state = addBusStop(state, { x: 22, y: 2 });
    const stopIds = state.transit.stops.map((s) => s.id);

    state = addBusRoute(state, stopIds);
    const routeA = state.transit.routes.at(-1)!.id;
    state = addBusRoute(state, stopIds);
    const routeB = state.transit.routes.at(-1)!.id;

    const terminal = state.transit.stops.find((s) => s.kind === "busTerminal")!;
    const platformOf = (routeId: string) =>
      terminal.platforms.find((p) => p.routeIds.includes(routeId))!.label;
    expect(platformOf(routeA)).toBe("A");
    expect(platformOf(routeB)).toBe("B");
  });

  it("registers a new metro line on each served station's least-loaded platform", () => {
    let state = createInitialGameState();
    state = { ...state, budget: 1_000_000 };
    state = addMetroStation(state, { x: 7, y: 2 });
    state = addMetroStation(state, { x: 22, y: 2 });
    expect(state.transit.stations).toHaveLength(2);
    const stationIds = state.transit.stations.map((s) => s.id);

    state = addMetroLine(state, stationIds);
    const lineId = state.transit.metroLines.at(-1)!.id;

    for (const station of state.transit.stations) {
      const holding = station.platforms.filter((p) =>
        p.routeIds.includes(lineId),
      );
      expect(holding).toHaveLength(1);
    }
  });
});
