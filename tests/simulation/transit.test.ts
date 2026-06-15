import { describe, expect, it } from "vitest";
import type {
  Citizen,
  GameState,
  MetroLine,
  Point,
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
  cycleRoadDirection,
  deleteRoute,
  layRoad,
  layTrack,
  recomputeRoutePaths,
  removeInfrastructureAtTile,
  renameRoute,
  setRouteActive,
  setRouteColor,
  stopCoverageRadius,
  tickVehicles,
} from "../../src/simulation/transit";
import { getTile } from "../../src/simulation/map";
import { hasBrokenSegment } from "../../src/simulation/network";

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

/** Inclusive tile run along a row, in either direction. */
function rowPath(y: number, fromX: number, toX: number): Point[] {
  const step = fromX <= toX ? 1 : -1;
  const out: Point[] = [];
  for (let x = fromX; ; x += step) {
    out.push({ x, y });
    if (x === toX) break;
  }
  return out;
}

/** Two-segment loop for a 2-node line along row y between x=fromX and x=toX. */
function loopSegments(y: number, fromX: number, toX: number): Point[][] {
  return [rowPath(y, fromX, toX), rowPath(y, toX, fromX)];
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
    state = withTrack(state, trackRow(8, 7, 22));
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
    state = withTrack(state, [{ x: 7, y: 8 }]);
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

    // 8 steps per segment -> 0.8/8 = 0.1 progress/s; over 5s that is 0.5,
    // still mid-segment (< 1) so progress stays > 0 without wrapping to 0.
    const nextState = tickVehicles(state, 5);

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
            segments: [],
            pathBroken: false,
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

describe("distance-based vehicle movement", () => {
  it("advances progress by speed/steps so longer segments take longer", () => {
    // createBusState: stops (7,8)->(15,8), 8 steps per segment.
    const state = createBusState();

    const after1s = tickVehicles(state, 1);
    // bus 0.8 tiles/s over 8 steps -> 0.1 progress/s
    expect(after1s.transit.vehicles[0].progress).toBeCloseTo(0.1, 5);

    const after10s = tickVehicles(state, 10);
    // Segment completed exactly at 10s: vehicle disembarks and advances.
    expect(after10s.transit.vehicles[0].segmentIndex).toBe(1);
  });

  it("converts overshoot progress when segments have different lengths (long→short)", () => {
    // Three stops at (7,8), (15,8), (22,8) on a loop.
    // Segments: [0]=7→15 (8 steps), [1]=15→22 (7 steps), [2]=22→7 (15 steps).
    const state = createThreeStopBusState();
    const vehicle = state.transit.vehicles[0]!;

    // Place vehicle near end of segment 0 (7→15, 8 steps).
    // progress = 0.9 means 0.9 of the way from stop-001 to stop-002.
    const preTick: GameState = {
      ...state,
      transit: {
        ...state.transit,
        vehicles: [{ ...vehicle, segmentIndex: 0, progress: 0.9 }],
      },
    };

    // Tick with enough delta to overshoot segment 0 by several tiles.
    // bus speed = 0.8 tiles/s; progress increment = 0.8 * delta / steps.
    // With 8 steps, need progress > 0.1 to cross: delta > 1.0s
    // Use delta = 3.0s: increment = 0.8*3/8 = 0.3; total = 0.9 + 0.3 = 1.2
    // Overshoot: 0.2 of segment 0 = 0.2 * 8 = 1.6 tiles past stop-002
    // Next segment 1 has 7 steps, so converted progress = 1.6 / 7 ≈ 0.22857
    const after = tickVehicles(preTick, 3.0);

    expect(after.transit.vehicles[0]!.segmentIndex).toBe(1);
    expect(after.transit.vehicles[0]!.progress).toBeCloseTo((0.2 * 8) / 7, 5);
  });

  it("converts overshoot progress when segments have different lengths (short→long)", () => {
    // Three stops at (7,8), (15,8), (22,8) on a loop.
    // Segments: [0]=7→15 (8 steps), [1]=15→22 (7 steps), [2]=22→7 (15 steps).
    const state = createThreeStopBusState();
    const vehicle = state.transit.vehicles[0]!;

    // Place vehicle near end of segment 1 (15→22, 7 steps).
    const preTick: GameState = {
      ...state,
      transit: {
        ...state.transit,
        vehicles: [{ ...vehicle, segmentIndex: 1, progress: 0.9 }],
      },
    };

    // Overshoot from segment 1 (7 steps) into segment 2 (15 steps).
    // bus speed = 0.8 tiles/s; increment = 0.8 * 3.0 / 7 ≈ 0.34286
    // total = 0.9 + 0.34286 ≈ 1.24286
    // Overshoot in segment-1 fractions: 0.24286
    // Overshoot in tiles: 0.24286 * 7 ≈ 1.7 tiles past stop-003
    // Converted to segment 2 (15 steps): 1.7 / 15 ≈ 0.11333
    const after = tickVehicles(preTick, 3.0);
    const overshoot = 0.9 + (0.8 * 3.0) / 7 - 1;

    expect(after.transit.vehicles[0]!.segmentIndex).toBe(2);
    expect(after.transit.vehicles[0]!.progress).toBeCloseTo(
      (overshoot * 7) / 15,
      5,
    );
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
            segments: loopSegments(8, 7, 15),
            pathBroken: false,
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
            segments: loopSegments(8, 7, 15),
            pathBroken: false,
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
      segments: loopSegments(8, 7, 15),
      pathBroken: false,
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
            segments: loopSegments(8, 7, 15),
            pathBroken: false,
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
            segments: loopSegments(8, 7, 15),
            pathBroken: false,
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
    state = withTrack(state, trackRow(2, 7, 22));
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
    state = withTrack(state, trackRow(8, 7, 15));
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

  it("returns the same reference when the color is unchanged", () => {
    const state = createBusState();
    const sameColor = state.transit.routes[0].color;
    expect(setRouteColor(state, "route-001", sameColor)).toBe(state);
  });

  it("returns the same reference when the name is unchanged", () => {
    const state = createBusState();
    const sameName = state.transit.routes[0].name;
    expect(renameRoute(state, "route-001", sameName)).toBe(state);
  });

  it("sets a metro line color by id", () => {
    let state = createInitialGameState();
    state = withTrack(state, trackRow(8, 7, 15));
    state = addMetroStation(state, { x: 7, y: 8 });
    state = addMetroStation(state, { x: 15, y: 8 });
    state = addMetroLine(state, ["station-001", "station-002"]);
    const next = setRouteColor(state, "metro-001", "#abcdef");
    expect(next.transit.metroLines[0].color).toBe("#abcdef");
  });

  it("toggles a metro line active flag by id", () => {
    let state = createInitialGameState();
    state = withTrack(state, trackRow(8, 7, 15));
    state = addMetroStation(state, { x: 7, y: 8 });
    state = addMetroStation(state, { x: 15, y: 8 });
    state = addMetroLine(state, ["station-001", "station-002"]);
    const next = setRouteActive(state, "metro-001", false);
    expect(next.transit.metroLines[0].active).toBe(false);
  });
});

describe("deleteRoute", () => {
  it("removes a bus route, its vehicles, and its platform assignments", () => {
    const state = createBusState(); // route-001 across stop-001/stop-002 + vehicle-001
    const assignedBefore = state.transit.stops
      .flatMap((s) => s.platforms)
      .some((p) => p.routeIds.includes("route-001"));
    expect(assignedBefore).toBe(true);

    const next = deleteRoute(state, "route-001");

    expect(next.transit.routes).toEqual([]);
    expect(next.transit.vehicles).toEqual([]);
    expect(
      next.transit.stops
        .flatMap((s) => s.platforms)
        .some((p) => p.routeIds.includes("route-001")),
    ).toBe(false);
  });

  it("removes a metro line, its vehicles, and its platform assignments", () => {
    let state = createInitialGameState();
    state = withTrack(state, trackRow(8, 7, 15));
    state = addMetroStation(state, { x: 7, y: 8 });
    state = addMetroStation(state, { x: 15, y: 8 });
    state = addMetroLine(state, ["station-001", "station-002"]);
    state = assignVehicle(state, "metro", "metro-001");

    const next = deleteRoute(state, "metro-001");

    expect(next.transit.metroLines).toEqual([]);
    expect(next.transit.vehicles).toEqual([]);
    expect(
      next.transit.stations
        .flatMap((s) => s.platforms)
        .some((p) => p.routeIds.includes("metro-001")),
    ).toBe(false);
  });

  it("returns the same reference for an unknown id", () => {
    const state = createBusState();
    expect(deleteRoute(state, "route-999")).toBe(state);
  });

  it("preserves a sibling route and its platform assignment when deleting a shared-terminal route", () => {
    // Two routes share a busTerminal and a survivor stop. Deleting routeA
    // must: (a) leave routeB in routes, (b) leave routeB's vehicle alive,
    // (c) leave routeB registered on its platform at the terminal, (d) strip
    // routeA's id from every platform it was on, (e) leave unrelated stops
    // untouched by reference equality.
    let state = createInitialGameState();
    state = { ...state, budget: 1_000_000 };
    state = addBusStop(state, { x: 7, y: 2 }, "busTerminal"); // shared
    state = addBusStop(state, { x: 15, y: 2 }); // routeA only
    state = addBusStop(state, { x: 22, y: 2 }); // routeB only
    state = addBusRoute(state, ["stop-001", "stop-002"]); // route-001 (A)
    state = addBusRoute(state, ["stop-001", "stop-003"]); // route-002 (B)
    state = assignVehicle(state, "bus", "route-001");
    state = assignVehicle(state, "bus", "route-002");

    const terminalBefore = state.transit.stops.find(
      (s) => s.id === "stop-001",
    )!;
    const survivorStopBefore = state.transit.stops.find(
      (s) => s.id === "stop-003",
    )!;
    // Sanity: both routes are registered on the terminal (different platforms
    // because assignRouteToLeastLoaded spreads them across A/B).
    expect(terminalBefore.platforms.flatMap((p) => p.routeIds).sort()).toEqual([
      "route-001",
      "route-002",
    ]);

    const next = deleteRoute(state, "route-001");

    // routeB survives
    expect(next.transit.routes.map((r) => r.id)).toEqual(["route-002"]);
    // routeB's vehicle survives; routeA's is removed
    expect(next.transit.vehicles.map((v) => v.id)).toEqual(["vehicle-002"]);
    // routeB is still registered at the terminal, routeA is fully scrubbed
    const terminalAfter = next.transit.stops.find((s) => s.id === "stop-001")!;
    expect(terminalAfter.platforms.flatMap((p) => p.routeIds)).toEqual([
      "route-002",
    ]);
    // The survivor-only stop keeps its platform assignment by reference
    const survivorStopAfter = next.transit.stops.find(
      (s) => s.id === "stop-003",
    )!;
    expect(survivorStopAfter).toBe(survivorStopBefore);
    // The routeA-only stop is gone from stops? No — stops themselves are not
    // deleted by deleteRoute (only the route is). Confirm stop-002 is still
    // present, just with routeA scrubbed from its platforms.
    const routeAOnlyStopAfter = next.transit.stops.find(
      (s) => s.id === "stop-002",
    )!;
    expect(routeAOnlyStopAfter).toBeDefined();
    expect(routeAOnlyStopAfter.platforms.flatMap((p) => p.routeIds)).toEqual(
      [],
    );
  });

  it("invalidates route plans that referenced a deleted bus route", () => {
    // A waiting citizen whose plan points at the deleted route must drop the
    // stale plan and return to idle, so tickCitizen replans on the next tick
    // instead of waiting until patience runs out.
    let state = createBusState();
    state = {
      ...state,
      citizens: state.citizens.map((citizen, index) =>
        index === 0
          ? {
              ...citizen,
              home: { x: 7, y: 8 },
              position: { x: 7, y: 8 },
              destination: { x: 16, y: 8 },
              status: "waiting",
              routePlan: {
                estimatedSeconds: 216,
                legs: [
                  {
                    mode: "bus",
                    from: { x: 7, y: 8 },
                    to: { x: 15, y: 8 },
                    lineId: "route-001",
                  },
                  { mode: "walk", from: { x: 15, y: 8 }, to: { x: 16, y: 8 } },
                ],
              },
              currentLegIndex: 0,
            }
          : citizen,
      ),
    };

    const next = deleteRoute(state, "route-001");
    const citizen = next.citizens[0]!;

    expect(next.transit.routes).toEqual([]);
    expect(citizen.status).toBe("idle");
    expect(citizen.routePlan).toBeNull();
    expect(citizen.currentLegIndex).toBe(0);
  });

  it("invalidates route plans that referenced a deleted metro line", () => {
    let state = createInitialGameState();
    state = withTrack(state, trackRow(8, 7, 15));
    state = addMetroStation(state, { x: 7, y: 8 });
    state = addMetroStation(state, { x: 15, y: 8 });
    state = addMetroLine(state, ["station-001", "station-002"]);
    state = {
      ...state,
      citizens: state.citizens.map((citizen, index) =>
        index === 0
          ? {
              ...citizen,
              home: { x: 7, y: 8 },
              position: { x: 7, y: 8 },
              destination: { x: 16, y: 8 },
              status: "waiting",
              routePlan: {
                estimatedSeconds: 216,
                legs: [
                  {
                    mode: "metro",
                    from: { x: 7, y: 8 },
                    to: { x: 15, y: 8 },
                    lineId: "metro-001",
                  },
                  { mode: "walk", from: { x: 15, y: 8 }, to: { x: 16, y: 8 } },
                ],
              },
              currentLegIndex: 0,
            }
          : citizen,
      ),
    };

    const next = deleteRoute(state, "metro-001");
    const citizen = next.citizens[0]!;

    expect(next.transit.metroLines).toEqual([]);
    expect(citizen.status).toBe("idle");
    expect(citizen.routePlan).toBeNull();
  });

  it("preserves reference equality for citizens whose plans did not reference the deleted route", () => {
    // Plans referencing a *different* route or no transit at all must keep
    // their citizen reference so the runtime's change-detection stays cheap.
    let state = createBusState();
    state = {
      ...state,
      citizens: state.citizens.map((citizen, index) =>
        index === 0
          ? {
              ...citizen,
              status: "walking",
              routePlan: {
                estimatedSeconds: 20,
                legs: [
                  {
                    mode: "walk",
                    from: { x: 2, y: 3 },
                    to: { x: 3, y: 3 },
                  },
                ],
              },
              currentLegIndex: 0,
            }
          : citizen,
      ),
    };
    const plannedCitizen = state.citizens[0]!;

    const next = deleteRoute(state, "route-001");

    // Same reference: walking plan did not reference the deleted route.
    expect(next.citizens[0]).toBe(plannedCitizen);
  });
});

describe("route path segments", () => {
  it("stores segments and pathBroken=false for a road-connected bus route", () => {
    let state = createInitialGameState();
    state = addBusStop(state, { x: 7, y: 8 });
    state = addBusStop(state, { x: 15, y: 8 });

    state = addBusRoute(state, ["stop-001", "stop-002"]);

    const route = state.transit.routes[0];
    expect(route.pathBroken).toBe(false);
    expect(route.segments).toHaveLength(2); // out + closing loop
    expect(route.segments[0][0]).toEqual({ x: 7, y: 8 });
    expect(route.segments[0].at(-1)).toEqual({ x: 15, y: 8 });
  });

  it("creates a metro line with pathBroken=true when stations have no track between them", () => {
    let state = createInitialGameState();
    // Track under the two station tiles only, satisfying placement rules,
    // but with no connecting track run between them, so the line still has
    // no path.
    state = withTrack(state, [
      { x: 7, y: 8 },
      { x: 22, y: 8 },
    ]);
    state = addMetroStation(state, { x: 7, y: 8 });
    state = addMetroStation(state, { x: 22, y: 8 });
    state = addMetroLine(state, ["station-001", "station-002"]);

    expect(state.transit.metroLines[0].pathBroken).toBe(true);
    expect(state.transit.metroLines[0].segments).toEqual([[], []]);
  });

  it("does not move vehicles on a pathBroken line and rejects new vehicles for it", () => {
    let state = createInitialGameState();
    // Track under the two station tiles only; no connecting run, so the
    // line stays pathBroken and rejects vehicle assignment.
    state = withTrack(state, [
      { x: 7, y: 8 },
      { x: 22, y: 8 },
    ]);
    state = addMetroStation(state, { x: 7, y: 8 });
    state = addMetroStation(state, { x: 22, y: 8 });
    state = addMetroLine(state, ["station-001", "station-002"]);

    const rejected = assignVehicle(state, "metro", "metro-001");
    expect(rejected).toBe(state);
  });

  it("sets pathBroken=true when a bus route references a dangling stop id", () => {
    let state = createInitialGameState();
    state = addBusStop(state, { x: 7, y: 8 });
    // Create a route with one real stop and one dangling id that maps to
    // no stop in state.transit.stops.
    state = addBusRoute(state, ["stop-001", "stop-999"]);

    const route = state.transit.routes[0];
    expect(route.active).toBe(false); // only one distinct valid stop
    expect(route.pathBroken).toBe(true); // dangling id → broken
    expect(route.segments).toEqual([]);
  });

  it("sets pathBroken=true when a metro line references a dangling station id", () => {
    let state = createInitialGameState();
    state = withTrack(state, trackRow(8, 7, 22));
    state = addMetroStation(state, { x: 7, y: 8 });
    // station-999 does not exist in state.transit.stations.
    state = addMetroLine(state, ["station-001", "station-999"]);

    const line = state.transit.metroLines[0];
    expect(line.active).toBe(false);
    expect(line.pathBroken).toBe(true);
    expect(line.segments).toEqual([]);
  });
});

describe("cycleRoadDirection", () => {
  it("cycles two-way -> N -> E -> S -> W -> two-way on a road tile", () => {
    const state = createInitialGameState();
    const order = ["north", "east", "south", "west", undefined];
    let next = state;
    for (const expected of order) {
      next = cycleRoadDirection(next, { x: 8, y: 8 });
      expect(getTile(next.map, { x: 8, y: 8 })?.oneWay).toBe(expected);
    }
  });

  it("ignores tiles that are not roads", () => {
    const state = createInitialGameState();
    // (2,3) is residential.
    const next = cycleRoadDirection(state, { x: 2, y: 3 });
    expect(next).toBe(state);
  });

  it("breaks a route's loop when a one-way severs it and restores it when reversed", () => {
    let state = createInitialGameState();
    state = addBusStop(state, { x: 7, y: 8 });
    state = addBusStop(state, { x: 15, y: 8 });
    state = addBusRoute(state, ["stop-001", "stop-002"]);
    expect(state.transit.routes[0].pathBroken).toBe(false);

    // One cycle -> north: (8,8) may now only be exited northward, so the
    // 7<->15 legs along y=8 can no longer pass through it.
    const broken = cycleRoadDirection(state, { x: 8, y: 8 });
    expect(getTile(broken.map, { x: 8, y: 8 })?.oneWay).toBe("north");
    expect(broken.transit.routes[0].pathBroken).toBe(true);

    // Four more cycles return the tile to two-way and repair the route.
    let restored = broken;
    for (let i = 0; i < 4; i += 1) {
      restored = cycleRoadDirection(restored, { x: 8, y: 8 });
    }
    expect(getTile(restored.map, { x: 8, y: 8 })?.oneWay).toBeUndefined();
    expect(restored.transit.routes[0].pathBroken).toBe(false);
  });
});

function removeRoadAt(state: GameState, point: Point): GameState {
  return {
    ...state,
    map: {
      ...state.map,
      tiles: state.map.tiles.map((tile) =>
        tile.x === point.x && tile.y === point.y
          ? { ...tile, kind: "empty" as const }
          : tile,
      ),
    },
  };
}

describe("recomputeRoutePaths", () => {
  it("marks a route broken when a road tile on its path is removed, parks the vehicle, and disembarks passengers", () => {
    let state = createBusState(); // stops at (7,8) and (15,8), one vehicle
    // Put a rider on board: simulate a citizen mid-ride.
    const rider: Citizen = {
      ...state.citizens[0],
      status: "riding",
      routePlan: {
        legs: [
          {
            mode: "bus",
            from: { x: 7, y: 8 },
            to: { x: 15, y: 8 },
            lineId: "route-001",
          },
        ],
        estimatedSeconds: 60,
      },
      currentLegIndex: 0,
    };
    state = {
      ...state,
      citizens: [rider, ...state.citizens.slice(1)],
      transit: {
        ...state.transit,
        vehicles: state.transit.vehicles.map((v) => ({
          ...v,
          passengerIds: [rider.id],
          progress: 0.5,
        })),
      },
    };

    // Sever the road between the stops, then recompute.
    const severed = recomputeRoutePaths(removeRoadAt(state, { x: 11, y: 8 }));

    const route = severed.transit.routes[0];
    expect(route.pathBroken).toBe(true);
    expect(route.active).toBe(true); // player toggle untouched

    const vehicle = severed.transit.vehicles[0];
    expect(vehicle.passengerIds).toEqual([]);
    expect(vehicle.progress).toBe(0);

    const citizen = severed.citizens[0];
    expect(citizen.status).toBe("idle");
    expect(citizen.routePlan).toBeNull();
    expect(citizen.position).toEqual({ x: 7, y: 8 }); // segment-start stop
  });

  it("clears pathBroken when the network is restored", () => {
    const state = createBusState();
    const severed = recomputeRoutePaths(removeRoadAt(state, { x: 11, y: 8 }));
    expect(severed.transit.routes[0].pathBroken).toBe(true);

    // Restore the tile and recompute again.
    const restored = recomputeRoutePaths({
      ...severed,
      map: {
        ...severed.map,
        tiles: severed.map.tiles.map((tile) =>
          tile.x === 11 && tile.y === 8
            ? { ...tile, kind: "road" as const }
            : tile,
        ),
      },
    });

    expect(restored.transit.routes[0].pathBroken).toBe(false);
    expect(restored.transit.routes[0].segments[0]).toHaveLength(9);

    // Vehicle parked at progress=0 should resume movement on the next tick.
    const ticked = tickVehicles(restored, 1);
    expect(ticked.transit.vehicles[0].progress).toBeGreaterThan(0);
  });

  it("marks a metro line broken when track on its path is removed, parks the vehicle, and disembarks passengers", () => {
    // Build a working metro line with continuous track.
    let state = createInitialGameState();
    state = withTrack(state, trackRow(8, 7, 15));
    state = addMetroStation(state, { x: 7, y: 8 });
    state = addMetroStation(state, { x: 15, y: 8 });
    state = addMetroLine(state, ["station-001", "station-002"]);
    state = assignVehicle(state, "metro", "metro-001");

    // Put a rider on board.
    const rider: Citizen = {
      ...state.citizens[0],
      status: "riding",
      routePlan: {
        legs: [
          {
            mode: "metro",
            from: { x: 7, y: 8 },
            to: { x: 15, y: 8 },
            lineId: "metro-001",
          },
        ],
        estimatedSeconds: 60,
      },
      currentLegIndex: 0,
    };
    state = {
      ...state,
      citizens: [rider, ...state.citizens.slice(1)],
      transit: {
        ...state.transit,
        vehicles: state.transit.vehicles.map((v) => ({
          ...v,
          passengerIds: [rider.id],
          progress: 0.5,
        })),
      },
    };

    // Sever the connecting track, then recompute.
    const severed = {
      ...state,
      map: {
        ...state.map,
        tiles: state.map.tiles.map((tile) =>
          tile.x === 11 && tile.y === 8 ? { ...tile, hasTrack: false } : tile,
        ),
      },
    };
    const result = recomputeRoutePaths(severed);

    const line = result.transit.metroLines[0];
    expect(line.pathBroken).toBe(true);
    expect(line.active).toBe(true);

    const vehicle = result.transit.vehicles[0];
    expect(vehicle.passengerIds).toEqual([]);
    expect(vehicle.progress).toBe(0);

    const citizen = result.citizens[0];
    expect(citizen.status).toBe("idle");
    expect(citizen.routePlan).toBeNull();
    expect(citizen.position).toEqual({ x: 7, y: 8 });
  });

  it("maintains pathBroken consistency with hasBrokenSegment after recomputation", () => {
    // Build a bus route and a metro line, then damage and restore the network.
    const state = createThreeStopBusState();

    // Damage the road between stops.
    const damaged = removeInfrastructureAtTile(state, { x: 11, y: 8 });
    const result = recomputeRoutePaths(damaged);
    const route = result.transit.routes[0];

    // pathBroken must agree with hasBrokenSegment when no IDs are missing.
    // (idsMissing is always false here because stops aren't removed.)
    expect(route.pathBroken).toBe(hasBrokenSegment(route.segments));

    // Restore and verify consistency holds in the non-broken direction too.
    const restored = recomputeRoutePaths({
      ...result,
      map: {
        ...result.map,
        tiles: result.map.tiles.map((tile) =>
          tile.x === 11 && tile.y === 8
            ? { ...tile, kind: "road" as const }
            : tile,
        ),
      },
    });
    const restoredRoute = restored.transit.routes[0];
    expect(restoredRoute.pathBroken).toBe(
      hasBrokenSegment(restoredRoute.segments),
    );
  });
});

describe("laying and removing infrastructure", () => {
  it("lays a road on an empty tile and charges $100", () => {
    const state = createInitialGameState();
    const next = layRoad(state, { x: 8, y: 2 });

    expect(next.map.tiles.find((t) => t.x === 8 && t.y === 2)?.kind).toBe(
      "road",
    );
    expect(next.budget).toBe(119_900);
  });

  it("lays track on a road tile to form a crossing and charges $500", () => {
    const state = createInitialGameState();
    const next = layTrack(state, { x: 9, y: 8 });

    const tile = next.map.tiles.find((t) => t.x === 9 && t.y === 8);
    expect(tile?.kind).toBe("road");
    expect(tile?.hasTrack).toBe(true);
    expect(next.budget).toBe(119_500);
  });

  it("rejects invalid placements unchanged", () => {
    const state = createInitialGameState();
    expect(layRoad(state, { x: 7, y: 8 })).toBe(state); // already road
    expect(layTrack(state, { x: 2, y: 3 })).toBe(state); // residential
  });

  it("rejects laying when the budget cannot cover the cost", () => {
    const broke = { ...createInitialGameState(), budget: 50 };
    expect(layRoad(broke, { x: 8, y: 2 })).toBe(broke);
    expect(layTrack(broke, { x: 8, y: 2 })).toBe(broke);
  });

  it("allows laying when budget equals the exact cost (boundary check)", () => {
    const exact = { ...createInitialGameState(), budget: 100 };
    const next = layRoad(exact, { x: 8, y: 2 });
    expect(next.map.tiles.find((t) => t.x === 8 && t.y === 2)?.kind).toBe(
      "road",
    );
    expect(next.budget).toBe(0); // 100 - 100
  });

  it("re-laying a severed road tile restores a broken route", () => {
    let state = createBusState(); // stops (7,8) and (15,8)
    state = removeInfrastructureAtTile(state, { x: 11, y: 8 });
    expect(state.transit.routes[0].pathBroken).toBe(true);

    state = layRoad(state, { x: 11, y: 8 });
    expect(state.transit.routes[0].pathBroken).toBe(false);
  });

  it("does not re-park vehicles when recomputing while already broken", () => {
    // Guard test for the broken->broken transition: side effects must fire
    // only on the transition INTO broken, not on every recompute.
    let state = createBusState();
    state = removeInfrastructureAtTile(state, { x: 11, y: 8 });
    expect(state.transit.routes[0].pathBroken).toBe(true);

    // Manually un-park the vehicle to detect a second (incorrect) re-park.
    state = {
      ...state,
      transit: {
        ...state.transit,
        vehicles: state.transit.vehicles.map((v) => ({ ...v, progress: 0.4 })),
      },
    };
    // Another unrelated network change while the route is still broken.
    const next = removeInfrastructureAtTile(state, { x: 3, y: 8 });
    expect(next.transit.routes[0].pathBroken).toBe(true);
    expect(next.transit.vehicles[0].progress).toBe(0.4); // not re-parked
  });

  it("bulldozes track before road on a crossing tile", () => {
    let state = layTrack(createInitialGameState(), { x: 9, y: 8 });

    state = removeInfrastructureAtTile(state, { x: 9, y: 8 });
    let tile = state.map.tiles.find((t) => t.x === 9 && t.y === 8);
    expect(tile?.hasTrack).toBe(false);
    expect(tile?.kind).toBe("road");

    state = removeInfrastructureAtTile(state, { x: 9, y: 8 });
    tile = state.map.tiles.find((t) => t.x === 9 && t.y === 8);
    expect(tile?.kind).toBe("empty");
  });
});
