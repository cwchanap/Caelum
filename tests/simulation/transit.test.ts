import { describe, expect, it } from "vitest";
import type {
  Citizen,
  GameState,
  MetroLine,
  Station,
  Stop,
  Vehicle,
} from "../../src/domain/types";
import { placeBuilding } from "../../src/simulation/buildings";
import { createInitialGameState } from "../../src/simulation/gameState";
import { onPlatformCitizenIds } from "../../src/simulation/platforms";
import {
  addBusRoute,
  addBusStop,
  addMetroLine,
  addMetroStation,
  assignRouteToPlatform,
  assignVehicle,
  renameRoute,
  setRouteActive,
  setRouteColor,
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
    // Inactive routes should NOT be assigned to any platform.
    expect(
      state.transit.stops[0]!.platforms.some((p) =>
        p.routeIds.includes(state.transit.routes[0]!.id),
      ),
    ).toBe(false);
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
    // Inactive lines should NOT be assigned to any platform.
    expect(
      state.transit.stations[0]!.platforms.some((p) =>
        p.routeIds.includes(state.transit.metroLines[0]!.id),
      ),
    ).toBe(false);
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

describe("on-platform boarding gate", () => {
  it("boards only the on-platform citizen when capacity is 1", () => {
    const stopA: Stop = {
      id: "stop-001",
      kind: "busStop",
      position: { x: 7, y: 8 },
      platforms: [
        { id: "stop-001-p0", label: "A", capacity: 1, routeIds: ["route-001"] },
      ],
    };
    const stopB: Stop = {
      id: "stop-002",
      kind: "busStop",
      position: { x: 15, y: 8 },
      platforms: [
        { id: "stop-002-p0", label: "A", capacity: 1, routeIds: ["route-001"] },
      ],
    };

    const mkWaiter = (id: string, patience: number): Citizen => ({
      ...createInitialGameState().citizens[0]!,
      id,
      home: { x: 7, y: 8 },
      destination: { x: 15, y: 8 },
      position: { x: 7, y: 8 },
      status: "waiting",
      patienceRemaining: patience,
      deadline: 9_999,
      routePlan: {
        estimatedSeconds: 100,
        legs: [
          {
            mode: "bus",
            from: { x: 7, y: 8 },
            to: { x: 15, y: 8 },
            lineId: "route-001",
          },
        ],
      },
      currentLegIndex: 0,
    });

    const vehicle: Vehicle = {
      id: "vehicle-001",
      mode: "bus",
      lineId: "route-001",
      capacity: 18,
      passengerIds: [],
      segmentIndex: 0,
      progress: 0,
    };

    const state: GameState = {
      ...createInitialGameState(),
      transit: {
        stops: [stopA, stopB],
        stations: [],
        routes: [
          {
            id: "route-001",
            name: "Bus 1",
            color: "#e04f39",
            stopIds: ["stop-001", "stop-002"],
            vehicleIds: ["vehicle-001"],
            active: true,
          },
        ],
        metroLines: [],
        vehicles: [vehicle],
      },
      citizens: [mkWaiter("c-high", 100), mkWaiter("c-low", 10)],
    };

    const next = tickVehicles(state, 0.1);
    const boarded = next.transit.vehicles[0]!.passengerIds;
    expect(boarded).toEqual(["c-low"]); // lower patience is on-platform
  });

  it("frees the platform slot so an overflow citizen boards on a later tick", () => {
    // Capacity-1 platform: of the two waiters, only the longest-waiting
    // (lowest patience) is "on-platform"; the other is queued (overflow),
    // not permanently rejected. Once the on-platform rider leaves the
    // waiting set, the queued citizen takes the freed slot on a later tick.
    const stopA: Stop = {
      id: "stop-001",
      kind: "busStop",
      position: { x: 7, y: 8 },
      platforms: [
        { id: "stop-001-p0", label: "A", capacity: 1, routeIds: ["route-001"] },
      ],
    };
    const stopB: Stop = {
      id: "stop-002",
      kind: "busStop",
      position: { x: 15, y: 8 },
      platforms: [
        { id: "stop-002-p0", label: "A", capacity: 1, routeIds: ["route-001"] },
      ],
    };

    const mkWaiter = (id: string, patience: number): Citizen => ({
      ...createInitialGameState().citizens[0]!,
      id,
      home: { x: 7, y: 8 },
      destination: { x: 15, y: 8 },
      position: { x: 7, y: 8 },
      status: "waiting",
      patienceRemaining: patience,
      deadline: 9_999,
      routePlan: {
        estimatedSeconds: 100,
        legs: [
          {
            mode: "bus",
            from: { x: 7, y: 8 },
            to: { x: 15, y: 8 },
            lineId: "route-001",
          },
        ],
      },
      currentLegIndex: 0,
    });

    const vehicle: Vehicle = {
      id: "vehicle-001",
      mode: "bus",
      lineId: "route-001",
      capacity: 18,
      passengerIds: [],
      segmentIndex: 0,
      progress: 0,
    };

    const state: GameState = {
      ...createInitialGameState(),
      transit: {
        stops: [stopA, stopB],
        stations: [],
        routes: [
          {
            id: "route-001",
            name: "Bus 1",
            color: "#e04f39",
            stopIds: ["stop-001", "stop-002"],
            vehicleIds: ["vehicle-001"],
            active: true,
          },
        ],
        metroLines: [],
        vehicles: [vehicle],
      },
      citizens: [mkWaiter("c-high", 100), mkWaiter("c-low", 10)],
    };

    // Tick 1: only the on-platform rider (c-low) boards.
    const afterTick1 = tickVehicles(state, 0.1);
    expect(afterTick1.transit.vehicles[0]!.passengerIds).toEqual(["c-low"]);

    // Assert on real post-tick state: c-low boarded, so it is no longer
    // "waiting" (boardVehicle sets it to "riding"), which excludes it from
    // platformWaiterIds / onPlatformCitizenIds. The slot it held is freed.
    const cLowAfter = afterTick1.citizens.find((c) => c.id === "c-low")!;
    expect(cLowAfter.status).toBe("riding");
    const cHighAfter = afterTick1.citizens.find((c) => c.id === "c-high")!;
    expect(cHighAfter.status).toBe("waiting");

    // Boarding only triggers at progress === 0; tick 1 advanced the bus past
    // that. Reset the same vehicle to progress 0 at the stop so it is boardable
    // again on tick 2 (deterministic: no Math.random / wall-clock involved).
    const tick2State: GameState = {
      ...afterTick1,
      transit: {
        ...afterTick1.transit,
        vehicles: afterTick1.transit.vehicles.map((v) =>
          v.id === "vehicle-001" ? { ...v, segmentIndex: 0, progress: 0 } : v,
        ),
      },
    };

    // Tick 2: with c-low gone from the waiting set, c-high is now the
    // longest-waiting on-platform citizen and boards into the freed slot.
    const afterTick2 = tickVehicles(tick2State, 0.1);
    expect(afterTick2.transit.vehicles[0]!.passengerIds).toEqual([
      "c-low",
      "c-high",
    ]);
  });

  it("boards only the on-platform citizen at a capacity-1 metro platform", () => {
    const stationA: Station = {
      id: "station-001",
      position: { x: 7, y: 8 },
      platforms: [
        {
          id: "station-001-p0",
          label: "A",
          capacity: 1,
          routeIds: ["metro-001"],
        },
      ],
    };
    const stationB: Station = {
      id: "station-002",
      position: { x: 15, y: 8 },
      platforms: [
        {
          id: "station-002-p0",
          label: "A",
          capacity: 1,
          routeIds: ["metro-001"],
        },
      ],
    };

    const mkWaiter = (id: string, patience: number): Citizen => ({
      ...createInitialGameState().citizens[0]!,
      id,
      home: { x: 7, y: 8 },
      destination: { x: 15, y: 8 },
      position: { x: 7, y: 8 },
      status: "waiting",
      patienceRemaining: patience,
      deadline: 9_999,
      routePlan: {
        estimatedSeconds: 100,
        legs: [
          {
            mode: "metro",
            from: { x: 7, y: 8 },
            to: { x: 15, y: 8 },
            lineId: "metro-001",
          },
        ],
      },
      currentLegIndex: 0,
    });

    const metroLine: MetroLine = {
      id: "metro-001",
      name: "Metro 1",
      color: "#3b82f6",
      stationIds: ["station-001", "station-002"],
      vehicleIds: ["metro-vehicle-001"],
      active: true,
    };

    const vehicle: Vehicle = {
      id: "metro-vehicle-001",
      mode: "metro",
      lineId: "metro-001",
      capacity: 40,
      passengerIds: [],
      segmentIndex: 0,
      progress: 0,
    };

    const state: GameState = {
      ...createInitialGameState(),
      transit: {
        stops: [],
        stations: [stationA, stationB],
        routes: [],
        metroLines: [metroLine],
        vehicles: [vehicle],
      },
      citizens: [mkWaiter("c-high", 100), mkWaiter("c-low", 10)],
    };

    const next = tickVehicles(state, 0.1);
    const boarded = next.transit.vehicles[0]!.passengerIds;
    expect(boarded).toEqual(["c-low"]); // lower patience is on-platform
  });

  it("boards an identical citizen set regardless of vehicle iteration order", () => {
    // Determinism (spec): identical inputs produce identical boarding order
    // regardless of vehicle order.
    //
    // Construction: ONE capacity-2 platform at stop-001 holds route-001 and
    // serves THREE waiters (patience 10/20/30). onPlatformCitizenIds() keeps
    // only the 2 longest-waiting (lowest-patience: c-low, c-mid) on-platform;
    // c-high overflows. TWO vehicles on route-001 are both parked at stop-001
    // (segmentIndex 0, progress 0) so both attempt to board this tick from the
    // SAME shared platform. tickVehicles computes onPlatform and
    // occupiedPassengerIds ONCE from tick-start state and shares the (mutable)
    // occupied set across vehicles, so whichever vehicle iterates first claims
    // some of the on-platform riders and the next sees them as occupied. The
    // COMBINED set of boarded ids must therefore be exactly the 2 on-platform
    // citizens, independent of the order vehicles appear in the array.
    const stopA: Stop = {
      id: "stop-001",
      kind: "busStop",
      position: { x: 7, y: 8 },
      platforms: [
        { id: "stop-001-p0", label: "A", capacity: 2, routeIds: ["route-001"] },
      ],
    };
    const stopB: Stop = {
      id: "stop-002",
      kind: "busStop",
      position: { x: 15, y: 8 },
      platforms: [
        { id: "stop-002-p0", label: "A", capacity: 2, routeIds: ["route-001"] },
      ],
    };

    const mkWaiter = (id: string, patience: number): Citizen => ({
      ...createInitialGameState().citizens[0]!,
      id,
      home: { x: 7, y: 8 },
      destination: { x: 15, y: 8 },
      position: { x: 7, y: 8 },
      status: "waiting",
      patienceRemaining: patience,
      deadline: 9_999,
      routePlan: {
        estimatedSeconds: 100,
        legs: [
          {
            mode: "bus",
            from: { x: 7, y: 8 },
            to: { x: 15, y: 8 },
            lineId: "route-001",
          },
        ],
      },
      currentLegIndex: 0,
    });

    const mkVehicle = (id: string): Vehicle => ({
      id,
      mode: "bus",
      lineId: "route-001",
      capacity: 18,
      passengerIds: [],
      segmentIndex: 0,
      progress: 0,
    });

    const buildState = (vehicles: Vehicle[]): GameState => ({
      ...createInitialGameState(),
      transit: {
        stops: [stopA, stopB],
        stations: [],
        routes: [
          {
            id: "route-001",
            name: "Bus 1",
            color: "#e04f39",
            stopIds: ["stop-001", "stop-002"],
            vehicleIds: ["vehicle-001", "vehicle-002"],
            active: true,
          },
        ],
        metroLines: [],
        vehicles,
      },
      citizens: [
        mkWaiter("c-high", 30),
        mkWaiter("c-mid", 20),
        mkWaiter("c-low", 10),
      ],
    });

    const v0 = mkVehicle("vehicle-001");
    const v1 = mkVehicle("vehicle-002");

    const forward = buildState([v0, v1]);
    const reversed = buildState([v1, v0]);

    // Same on-platform set for both orderings (it derives from tick-start
    // state, which differs only in vehicle order).
    const expectedOnPlatform = onPlatformCitizenIds(forward);
    expect([...onPlatformCitizenIds(reversed)].sort()).toEqual(
      [...expectedOnPlatform].sort(),
    );
    // The 2 lowest-patience citizens are on-platform; c-high overflows.
    expect([...expectedOnPlatform].sort()).toEqual(["c-low", "c-mid"]);

    const boardedSet = (next: GameState): string[] =>
      [
        ...new Set([
          ...next.transit.vehicles[0]!.passengerIds,
          ...next.transit.vehicles[1]!.passengerIds,
        ]),
      ].sort();

    const boardedForward = boardedSet(tickVehicles(forward, 0.1));
    const boardedReversed = boardedSet(tickVehicles(reversed, 0.1));

    // Order-independent: identical combined boarding set either way.
    expect(boardedReversed).toEqual(boardedForward);
    // And it is exactly the 2 on-platform citizens; the overflow never boards.
    expect(boardedForward).toEqual(["c-low", "c-mid"]);
    expect(boardedForward).not.toContain("c-high");
  });

  it("boards citizens in patience/id order regardless of state.citizens array order", () => {
    // Three on-platform citizens (capacity 3) with a vehicle that has only
    // 2 free seats. The citizens appear in state.citizens in REVERSE
    // patience order (highest patience first). Boarding must still pick
    // the 2 longest-waiting (lowest patience), not the first 2 in the array.
    const stopA: Stop = {
      id: "stop-001",
      kind: "busStop",
      position: { x: 7, y: 8 },
      platforms: [
        { id: "stop-001-p0", label: "A", capacity: 3, routeIds: ["route-001"] },
      ],
    };
    const stopB: Stop = {
      id: "stop-002",
      kind: "busStop",
      position: { x: 15, y: 8 },
      platforms: [
        { id: "stop-002-p0", label: "A", capacity: 3, routeIds: ["route-001"] },
      ],
    };

    const mkWaiter = (id: string, patience: number): Citizen => ({
      ...createInitialGameState().citizens[0]!,
      id,
      home: { x: 7, y: 8 },
      destination: { x: 15, y: 8 },
      position: { x: 7, y: 8 },
      status: "waiting",
      patienceRemaining: patience,
      deadline: 9_999,
      routePlan: {
        estimatedSeconds: 100,
        legs: [
          {
            mode: "bus",
            from: { x: 7, y: 8 },
            to: { x: 15, y: 8 },
            lineId: "route-001",
          },
        ],
      },
      currentLegIndex: 0,
    });

    const vehicle: Vehicle = {
      id: "vehicle-001",
      mode: "bus",
      lineId: "route-001",
      capacity: 2, // only 2 seats
      passengerIds: [],
      segmentIndex: 0,
      progress: 0,
    };

    // citizens array in reverse patience order (c-high first)
    const state: GameState = {
      ...createInitialGameState(),
      transit: {
        stops: [stopA, stopB],
        stations: [],
        routes: [
          {
            id: "route-001",
            name: "Bus 1",
            color: "#e04f39",
            stopIds: ["stop-001", "stop-002"],
            vehicleIds: ["vehicle-001"],
            active: true,
          },
        ],
        metroLines: [],
        vehicles: [vehicle],
      },
      citizens: [
        mkWaiter("c-high", 100),
        mkWaiter("c-mid", 50),
        mkWaiter("c-low", 10),
      ],
    };

    const next = tickVehicles(state, 0.1);
    // The 2 longest-waiting (c-low, c-mid) board, NOT c-high
    expect(next.transit.vehicles[0]!.passengerIds).toEqual(["c-low", "c-mid"]);
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

describe("assignRouteToPlatform", () => {
  function terminalState() {
    let state = { ...createInitialGameState(), budget: 1_000_000 };
    state = addBusStop(state, { x: 7, y: 2 }, "busTerminal");
    state = addBusStop(state, { x: 22, y: 2 });
    state = addBusRoute(
      state,
      state.transit.stops.map((s) => s.id),
    );
    return state;
  }

  it("moves a route from its current platform to the target", () => {
    const state = terminalState();
    const terminal = state.transit.stops.find((s) => s.kind === "busTerminal")!;
    const routeId = state.transit.routes[0].id;
    const fromPlatform = terminal.platforms.find((p) =>
      p.routeIds.includes(routeId),
    )!;
    const target = terminal.platforms.find((p) => p.id !== fromPlatform.id)!;

    const next = assignRouteToPlatform(state, terminal.id, routeId, target.id);
    const movedTerminal = next.transit.stops.find((s) => s.id === terminal.id)!;
    expect(
      movedTerminal.platforms.find((p) => p.id === fromPlatform.id)!.routeIds,
    ).not.toContain(routeId);
    expect(
      movedTerminal.platforms.find((p) => p.id === target.id)!.routeIds,
    ).toContain(routeId);
  });

  it("is a no-op when the platform does not belong to the node", () => {
    const state = terminalState();
    const terminal = state.transit.stops.find((s) => s.kind === "busTerminal")!;
    const routeId = state.transit.routes[0].id;
    const next = assignRouteToPlatform(
      state,
      terminal.id,
      routeId,
      "nonexistent-platform",
    );
    expect(next).toBe(state);
  });

  it("is a no-op when the route does not serve the node", () => {
    const state = terminalState();
    const terminal = state.transit.stops.find((s) => s.kind === "busTerminal")!;
    const target = terminal.platforms[1].id;
    const next = assignRouteToPlatform(state, terminal.id, "route-999", target);
    expect(next).toBe(state);
  });

  it("is a no-op when the route already sits on the target platform", () => {
    const state = terminalState();
    const terminal = state.transit.stops.find((s) => s.kind === "busTerminal")!;
    const routeId = state.transit.routes[0].id;
    const current = terminal.platforms.find((p) =>
      p.routeIds.includes(routeId),
    )!;
    const next = assignRouteToPlatform(state, terminal.id, routeId, current.id);
    expect(next).toBe(state);
  });
});

describe("route mutators", () => {
  it("renames a bus route and leaves others untouched", () => {
    const state = createBusState();
    const next = renameRoute(state, "route-001", "Airport Express");
    expect(next.transit.routes[0].name).toBe("Airport Express");
    expect(next).not.toBe(state);
  });

  it("falls back to the auto-name when the new name is blank", () => {
    const state = createBusState();
    const next = renameRoute(state, "route-001", "   ");
    expect(next.transit.routes[0].name).toBe("Bus 1");
  });

  it("renames a metro line by id", () => {
    let state = createInitialGameState();
    state = addMetroStation(state, { x: 7, y: 8 });
    state = addMetroStation(state, { x: 15, y: 8 });
    state = addMetroLine(state, ["station-001", "station-002"]);
    const next = renameRoute(state, "metro-001", "Blue Line");
    expect(next.transit.metroLines[0].name).toBe("Blue Line");
  });

  it("sets a route color", () => {
    const state = createBusState();
    const next = setRouteColor(state, "route-001", "#123456");
    expect(next.transit.routes[0].color).toBe("#123456");
  });

  it("returns the same reference for an unknown id", () => {
    const state = createBusState();
    expect(renameRoute(state, "route-999", "X")).toBe(state);
    expect(setRouteColor(state, "route-999", "#000")).toBe(state);
    expect(setRouteActive(state, "route-999", false)).toBe(state);
  });

  it("deactivates and reactivates a route flag", () => {
    const state = createBusState();
    const off = setRouteActive(state, "route-001", false);
    expect(off.transit.routes[0].active).toBe(false);
    const on = setRouteActive(off, "route-001", true);
    expect(on.transit.routes[0].active).toBe(true);
  });

  it("returns the same reference when active is unchanged", () => {
    const state = createBusState();
    expect(setRouteActive(state, "route-001", true)).toBe(state);
  });
});
