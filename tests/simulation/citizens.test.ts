import { describe, expect, it } from "vitest";
import type { Citizen, GameState } from "../../src/domain/types";
import { placeBuilding } from "../../src/simulation/buildings";
import { createInitialGameState } from "../../src/simulation/gameState";
import { tickCitizens } from "../../src/simulation/citizens";
import { tickSimulation } from "../../src/simulation/simulation";
import {
  addBusRoute,
  addBusStop,
  assignVehicle,
  tickVehicles,
} from "../../src/simulation/transit";
import { handleTileClick } from "../../src/ui/actions";
import { createUiState } from "../../src/ui/uiState";
import { pointsOnRow, withAreas, withRoads } from "../helpers/mapFixtures";

function testCitizen(overrides: Partial<Citizen> = {}): Citizen {
  return {
    id: "citizen-001",
    home: { x: 2, y: 3 },
    destination: { x: 5, y: 3 },
    position: { x: 2, y: 3 },
    status: "idle",
    patienceRemaining: 240,
    deadline: 900,
    routePlan: null,
    currentLegIndex: 0,
    ...overrides,
  };
}

function withFirstCitizen(
  state: GameState,
  citizen: Partial<Citizen>,
): GameState {
  const nextCitizen = testCitizen(citizen);
  return {
    ...state,
    citizens:
      state.citizens.length === 0
        ? [nextCitizen]
        : state.citizens.map((existingCitizen, index) =>
            index === 0
              ? { ...existingCitizen, ...nextCitizen, ...citizen }
              : existingCitizen,
          ),
  };
}

function advanceCitizens(
  state: GameState,
  tickCount: number,
  deltaSeconds = 1,
): GameState {
  let nextState = state;

  for (let tick = 0; tick < tickCount; tick += 1) {
    nextState = tickCitizens(nextState, deltaSeconds);
  }

  return nextState;
}

describe("citizen lifecycle", () => {
  it("plans a route for the first citizen and starts walking", () => {
    const state = withFirstCitizen(createInitialGameState(), {});

    const nextState = tickCitizens(state, 1);
    const citizen = nextState.citizens[0];

    expect(citizen?.routePlan).not.toBeNull();
    expect(citizen?.status).toBe("walking");
    expect(citizen?.currentLegIndex).toBe(0);
    expect(citizen?.position.x).toBeCloseTo(2.05);
    expect(citizen?.position.y).toBe(3);
    expect(
      Math.abs((citizen?.position.x ?? 0) - state.citizens[0]!.position.x) +
        Math.abs((citizen?.position.y ?? 0) - state.citizens[0]!.position.y),
    ).toBeCloseTo(0.05);
  });

  it("scales walking movement by simulated time instead of frame count", () => {
    const state = withFirstCitizen(createInitialGameState(), {
      destination: { x: 5, y: 3 },
      deadline: 900,
    });

    const afterOneSecond = advanceCitizens(state, 60, 1 / 60);

    expect(afterOneSecond.citizens[0]?.status).toBe("walking");
    expect(afterOneSecond.citizens[0]?.position.x).toBeCloseTo(2.05);
    expect(afterOneSecond.metrics.completedTrips).toBe(0);
  });

  it.each(["arrived", "late", "unserved"] as const)(
    "leaves %s citizens unchanged",
    (status) => {
      const state = withFirstCitizen(createInitialGameState(), {
        status,
        position: { x: 4, y: 4 },
        routePlan: {
          estimatedSeconds: 20,
          legs: [{ mode: "walk", from: { x: 4, y: 4 }, to: { x: 5, y: 4 } }],
        },
        currentLegIndex: 0,
        patienceRemaining: 123,
      });
      const originalCitizen = state.citizens[0];

      const nextState = tickCitizens(state, 20);

      expect(nextState.citizens[0]).toEqual(originalCitizen);
      expect(nextState.metrics.completedTrips).toBe(
        state.metrics.completedTrips,
      );
      expect(nextState.metrics.lateTrips).toBe(state.metrics.lateTrips);
      expect(nextState.metrics.unservedTrips).toBe(state.metrics.unservedTrips);
    },
  );

  it("leaves riding citizens on their current transit leg", () => {
    const state = withFirstCitizen(
      {
        ...createInitialGameState(),
        transit: {
          ...createInitialGameState().transit,
          vehicles: [
            {
              id: "vehicle-001",
              mode: "bus",
              lineId: "route-001",
              capacity: 18,
              passengerIds: ["citizen-001"],
              segmentIndex: 0,
              progress: 0.5,
            },
          ],
        },
      },
      {
        status: "riding",
        patienceRemaining: 123,
        routePlan: {
          estimatedSeconds: 60,
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
      },
    );

    const nextState = tickCitizens(state, 10);

    expect(nextState.citizens[0]).toEqual(state.citizens[0]);
    expect(nextState.metrics.totalWaitSeconds).toBe(
      state.metrics.totalWaitSeconds,
    );
  });

  it("recovers riding citizens whose vehicle was removed", () => {
    let state = createInitialGameState();
    state = withRoads(state, pointsOnRow(8, 7, 15));
    state = addBusStop(state, { x: 7, y: 8 });
    state = addBusStop(state, { x: 15, y: 8 });
    state = addBusRoute(state, ["stop-001", "stop-002"]);
    state = assignVehicle(state, "bus", "route-001");
    state = withFirstCitizen(state, {
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
    });
    state = tickVehicles(state, 0);
    expect(state.citizens[0]?.status).toBe("riding");

    const removed = handleTileClick(
      state,
      { ...createUiState(), activeTool: "remove" },
      { x: 7, y: 8 },
    ).state;
    const recovered = tickCitizens(removed, 1);

    expect(recovered.transit.vehicles).toHaveLength(0);
    expect(recovered.citizens[0]?.status).not.toBe("riding");
  });

  it("replans from the citizen's current position, not home, after being dropped at a stop", () => {
    // Simulate a citizen whose home is far from the transit stop where they
    // were parked after a route break. The replan must originate from the
    // parked position, not from home.
    let state = createInitialGameState();
    state = withRoads(state, pointsOnRow(8, 15, 22));
    state = addBusStop(state, { x: 15, y: 8 });
    state = addBusStop(state, { x: 22, y: 8 });
    state = addBusRoute(state, ["stop-001", "stop-002"]);
    state = assignVehicle(state, "bus", "route-001");

    // Citizen's home is at (2,3) — far from any stop — but they were riding
    // and got parked at stop-001 (15,8) after a route break.
    state = withFirstCitizen(state, {
      home: { x: 2, y: 3 },
      position: { x: 15, y: 8 },
      destination: { x: 23, y: 8 },
      status: "idle",
      routePlan: null,
      currentLegIndex: 0,
    });

    const nextState = tickCitizens(state, 1);
    const citizen = nextState.citizens[0]!;

    // The plan must exist and the first leg must start from the citizen's
    // current position (15,8), not from home (2,3).
    expect(citizen.routePlan).not.toBeNull();
    expect(citizen.routePlan!.legs[0]!.from).toEqual({ x: 15, y: 8 });
  });

  it("replans successfully when a citizen has a fractional walking position", () => {
    // A citizen mid-walk has a fractional position (e.g. x=5.3) when their
    // route is invalidated. The replan must snap to the nearest integer and
    // produce a valid plan rather than marking the citizen unserved.
    let state = createInitialGameState();
    state = withRoads(state, pointsOnRow(8, 7, 22));
    state = addBusStop(state, { x: 7, y: 8 });
    state = addBusStop(state, { x: 22, y: 8 });
    state = addBusRoute(state, ["stop-001", "stop-002"]);

    state = withFirstCitizen(state, {
      home: { x: 5, y: 8 },
      position: { x: 5.3, y: 8 },
      destination: { x: 23, y: 8 },
      status: "idle",
      routePlan: null,
      currentLegIndex: 0,
      deadline: 900,
    });

    const nextState = tickCitizens(state, 1);
    const citizen = nextState.citizens[0]!;

    expect(citizen.status).not.toBe("unserved");
    expect(citizen.routePlan).not.toBeNull();
    // First leg should start from the snapped position (5,8), not the
    // fractional one — and definitely not from home (2,3).
    expect(citizen.routePlan!.legs[0]!.from).toEqual({ x: 5, y: 8 });
  });

  it("marks long overdue walking-only trips unserved when no transit exists", () => {
    const state = withFirstCitizen(
      {
        ...createInitialGameState(),
        time: 101,
      },
      {
        deadline: 100,
        destination: { x: 27, y: 17 },
      },
    );

    const nextState = tickCitizens(state, 20);

    expect(
      nextState.citizens.some((citizen) => citizen.status === "unserved"),
    ).toBe(true);
    expect(nextState.metrics.unservedTrips).toBeGreaterThan(0);
  });

  it("arrives on a short walking-only route and increments completed trips without mutating home", () => {
    const state = withFirstCitizen(createInitialGameState(), {
      destination: { x: 3, y: 3 },
      deadline: 900,
    });
    const originalHome = state.citizens[0]?.home;

    const nextState = tickCitizens(state, 20);

    const citizen = nextState.citizens[0];

    expect(citizen?.status).toBe("arrived");
    expect(nextState.metrics.completedTrips).toBe(1);
    expect(citizen?.home).toEqual({ x: 2, y: 3 });
    expect(citizen?.home).not.toBe(originalHome);
  });

  it("marks a trip late when it arrives after the deadline", () => {
    const state = withFirstCitizen(
      { ...createInitialGameState(), time: 1 },
      {
        deadline: 0,
        routePlan: {
          estimatedSeconds: 90,
          legs: [
            {
              mode: "bus",
              from: { x: 7, y: 8 },
              to: { x: 23, y: 8 },
              lineId: "route-001",
            },
          ],
        },
        currentLegIndex: 1,
      },
    );

    const nextState = tickCitizens(state, 1);
    const citizen = nextState.citizens[0];

    expect(citizen?.status).toBe("late");
    expect(nextState.metrics.completedTrips).toBe(1);
    expect(nextState.metrics.lateTrips).toBe(1);
  });

  it("marks citizens unserved when route planning returns null", () => {
    const state = withFirstCitizen(createInitialGameState(), {
      destination: { x: 28, y: 17 },
    });

    const nextState = tickCitizens(state, 1);
    const citizen = nextState.citizens[0];

    expect(citizen?.status).toBe("unserved");
    expect(citizen?.routePlan).toBeNull();
    expect(nextState.metrics.unservedTrips).toBe(1);
  });

  it("marks waiting citizens unserved when patience reaches zero", () => {
    let state = createInitialGameState();
    state = withRoads(state, pointsOnRow(8, 7, 22));
    state = addBusStop(state, { x: 7, y: 8 });
    state = addBusStop(state, { x: 22, y: 8 });
    state = addBusRoute(state, ["stop-001", "stop-002"]);
    state = withFirstCitizen(state, {
      home: { x: 6, y: 8 },
      position: { x: 6, y: 8 },
      destination: { x: 23, y: 8 },
      patienceRemaining: 240,
    });

    let nextState = advanceCitizens(state, 21);

    expect(nextState.citizens[0]?.status).toBe("waiting");
    expect(nextState.citizens[0]?.patienceRemaining).toBe(239);
    expect(nextState.metrics.totalWaitSeconds).toBe(1);
    expect(nextState.metrics.waitingCitizenCount).toBe(1);
    expect(nextState.metrics.averageWaitSeconds).toBe(1);

    nextState = tickCitizens(nextState, 239);

    const citizen = nextState.citizens[0];

    expect(citizen?.status).toBe("unserved");
    expect(citizen?.patienceRemaining).toBe(0);
    expect(nextState.metrics.unservedTrips).toBe(1);
    expect(nextState.metrics.totalWaitSeconds).toBe(240);
    expect(nextState.metrics.waitingCitizenCount).toBe(0);
    expect(nextState.metrics.averageWaitSeconds).toBe(0);
  });

  it("averages wait time across citizens currently waiting", () => {
    const baseState = createInitialGameState();
    const waitingRoutePlan = {
      estimatedSeconds: 90,
      legs: [
        {
          mode: "bus" as const,
          from: { x: 7, y: 8 },
          to: { x: 22, y: 8 },
          lineId: "route-001",
        },
      ],
    };
    const state = {
      ...baseState,
      metrics: {
        ...baseState.metrics,
        totalWaitSeconds: 100,
      },
      citizens: [
        testCitizen({
          status: "waiting" as const,
          patienceRemaining: 235,
          routePlan: waitingRoutePlan,
        }),
        testCitizen({
          id: "citizen-002",
          status: "waiting" as const,
          patienceRemaining: 230,
          routePlan: waitingRoutePlan,
        }),
      ],
    };

    const nextState = tickCitizens(state, 0);

    expect(nextState.metrics.totalWaitSeconds).toBe(100);
    expect(nextState.metrics.waitingCitizenCount).toBe(2);
    expect(nextState.metrics.averageWaitSeconds).toBe(7.5);
  });
});

describe("home-fallback citizens while no destination exists", () => {
  // Regression: housing placed while the clock is running and no destination
  // building exists yet gave every citizen destination = home. The router
  // planned a zero-length walk, so the next tick immediately flipped them to
  // terminal `arrived` and recorded phantom completedTrips. Worse, terminal
  // citizens are skipped by retargetCitizens, so later placing a destination
  // never revived them — those houses permanently lost demand. The fix holds
  // home-fallback citizens dormant (non-terminal, no trip scored) until a real
  // destination is assigned.

  function residentialWithHouse(): GameState {
    const withArea = withAreas(createInitialGameState(), "residential", [
      { x: 1, y: 1 },
      { x: 2, y: 1 },
    ]);
    const placed = placeBuilding(withArea, "smallHouse", { x: 1, y: 1 }, 0);
    // Unpause so tickSimulation actually advances the sim.
    return {
      ...placed,
      paused: false,
      speed: 1,
      metrics: { ...placed.metrics, state: "running" },
    };
  }

  it("does not score a phantom arrived trip when destination equals home", () => {
    const state = residentialWithHouse();

    const ticked = tickSimulation(state, 30);

    for (const citizen of ticked.citizens) {
      // Must stay non-terminal and home-fallback so retarget can still reach them.
      expect(citizen.status).not.toBe("arrived");
      expect(citizen.status).not.toBe("late");
      expect(citizen.status).not.toBe("unserved");
      expect(citizen.destination).toEqual(citizen.home);
    }
    // No phantom completed/late/unserved trips from the zero-length walk.
    expect(ticked.metrics.completedTrips).toBe(0);
    expect(ticked.metrics.lateTrips).toBe(0);
    expect(ticked.metrics.unservedTrips).toBe(0);
    expect(ticked.metrics.tripOutcomes).toEqual([]);
  });

  it("stays retargetable after the clock has ticked when a destination is placed later", () => {
    // This is the core sandbox flow: player drops housing, the sim runs, then
    // they add a destination. Before the fix, the intermediate tick terminals
    // the citizens and the later placeBuilding's retarget is a no-op.
    let state = residentialWithHouse();
    state = tickSimulation(state, 30);

    state = withAreas(state, "commercial", [
      { x: 5, y: 1 },
      { x: 6, y: 1 },
      { x: 5, y: 2 },
      { x: 6, y: 2 },
    ]);
    state = placeBuilding(state, "supermarket", { x: 5, y: 1 }, 0);

    // Every previously home-fallback citizen must now target a real
    // supermarket tile, be idle, and have its route plan cleared for replanning.
    expect(state.citizens.length).toBeGreaterThan(0);
    for (const citizen of state.citizens) {
      expect(citizen.destination).not.toEqual(citizen.home);
      expect(
        state.buildings.some((building) =>
          building.occupiedTiles.some(
            (tile) =>
              tile.x === citizen.destination.x &&
              tile.y === citizen.destination.y,
          ),
        ),
      ).toBe(true);
      expect(citizen.status).toBe("idle");
      expect(citizen.routePlan).toBeNull();
      expect(citizen.currentLegIndex).toBe(0);
    }
  });
});
