import { describe, expect, it } from "vitest";
import type { GameState } from "../../src/domain/types";
import { createInitialGameState } from "../../src/simulation/gameState";
import { tickCitizens } from "../../src/simulation/citizens";
import {
  addBusRoute,
  addBusStop,
  assignVehicle,
  tickVehicles,
} from "../../src/simulation/transit";
import { handleTileClick } from "../../src/ui/actions";
import { createUiState } from "../../src/ui/uiState";

function withFirstCitizen(
  state: GameState,
  citizen: Partial<GameState["citizens"][number]>,
): GameState {
  return {
    ...state,
    citizens: state.citizens.map((existingCitizen, index) =>
      index === 0 ? { ...existingCitizen, ...citizen } : existingCitizen,
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
    const state = createInitialGameState();

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
        {
          ...baseState.citizens[0]!,
          status: "waiting" as const,
          patienceRemaining: 235,
          routePlan: waitingRoutePlan,
        },
        {
          ...baseState.citizens[1]!,
          status: "waiting" as const,
          patienceRemaining: 230,
          routePlan: waitingRoutePlan,
        },
      ],
    };

    const nextState = tickCitizens(state, 0);

    expect(nextState.metrics.totalWaitSeconds).toBe(100);
    expect(nextState.metrics.waitingCitizenCount).toBe(2);
    expect(nextState.metrics.averageWaitSeconds).toBe(7.5);
  });
});
