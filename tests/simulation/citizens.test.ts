import { describe, expect, it } from "vitest";
import type { GameState } from "../../src/domain/types";
import { createInitialGameState } from "../../src/simulation/gameState";
import { tickCitizens } from "../../src/simulation/citizens";
import { addBusRoute, addBusStop } from "../../src/simulation/transit";

function withFirstCitizen(state: GameState, citizen: Partial<GameState["citizens"][number]>): GameState {
  return {
    ...state,
    citizens: state.citizens.map((existingCitizen, index) =>
      index === 0 ? { ...existingCitizen, ...citizen } : existingCitizen
    )
  };
}

describe("citizen lifecycle", () => {
  it("plans a route for the first citizen and starts walking", () => {
    const state = createInitialGameState();

    const nextState = tickCitizens(state, 1);
    const citizen = nextState.citizens[0];

    expect(citizen?.routePlan).not.toBeNull();
    expect(citizen?.status).toBe("walking");
    expect(citizen?.currentLegIndex).toBe(0);
    expect(citizen?.position).toEqual({ x: 3, y: 3 });
    expect(
      Math.abs((citizen?.position.x ?? 0) - state.citizens[0]!.position.x) +
        Math.abs((citizen?.position.y ?? 0) - state.citizens[0]!.position.y)
    ).toBe(1);
  });

  it.each(["arrived", "late", "unserved"] as const)("leaves %s citizens unchanged", (status) => {
    const state = withFirstCitizen(createInitialGameState(), {
      status,
      position: { x: 4, y: 4 },
      routePlan: {
        estimatedSeconds: 20,
        legs: [{ mode: "walk", from: { x: 4, y: 4 }, to: { x: 5, y: 4 } }]
      },
      currentLegIndex: 0,
      patienceRemaining: 123
    });
    const originalCitizen = state.citizens[0];

    const nextState = tickCitizens(state, 1);

    expect(nextState.citizens[0]).toEqual(originalCitizen);
    expect(nextState.metrics.completedTrips).toBe(state.metrics.completedTrips);
    expect(nextState.metrics.lateTrips).toBe(state.metrics.lateTrips);
    expect(nextState.metrics.unservedTrips).toBe(state.metrics.unservedTrips);
  });

  it("marks long overdue walking-only trips unserved when no transit exists", () => {
    const state = withFirstCitizen(
      {
        ...createInitialGameState(),
        time: 101
      },
      {
        deadline: 100,
        destination: { x: 27, y: 17 }
      }
    );

    const nextState = tickCitizens(state, 1);

    expect(nextState.citizens.some((citizen) => citizen.status === "unserved")).toBe(true);
    expect(nextState.metrics.unservedTrips).toBeGreaterThan(0);
  });

  it("arrives on a short walking-only route and increments completed trips without mutating home", () => {
    const state = withFirstCitizen(createInitialGameState(), {
      destination: { x: 3, y: 3 },
      deadline: 900
    });
    const originalHome = state.citizens[0]?.home;

    let nextState = tickCitizens(state, 1);
    nextState = tickCitizens({ ...nextState, time: nextState.time + 1 }, 1);

    const citizen = nextState.citizens[0];

    expect(citizen?.status).toBe("arrived");
    expect(nextState.metrics.completedTrips).toBe(1);
    expect(citizen?.home).toEqual({ x: 2, y: 3 });
    expect(citizen?.home).not.toBe(originalHome);
  });

  it("marks a trip late when it arrives after the deadline", () => {
    const state = withFirstCitizen(createInitialGameState(), {
      destination: { x: 3, y: 3 },
      deadline: 0
    });

    const nextState = tickCitizens(state, 1);
    const citizen = nextState.citizens[0];

    expect(citizen?.status).toBe("late");
    expect(nextState.metrics.completedTrips).toBe(1);
    expect(nextState.metrics.lateTrips).toBe(1);
  });

  it("marks citizens unserved when route planning returns null", () => {
    const state = withFirstCitizen(createInitialGameState(), {
      destination: { x: 28, y: 17 }
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
      patienceRemaining: 2
    });

    let nextState = tickCitizens(state, 1);
    nextState = tickCitizens({ ...nextState, time: nextState.time + 1 }, 1);

    expect(nextState.citizens[0]?.status).toBe("waiting");
    expect(nextState.citizens[0]?.patienceRemaining).toBe(1);
    expect(nextState.metrics.totalWaitSeconds).toBe(1);
    expect(nextState.metrics.waitingCitizenCount).toBe(1);
    expect(nextState.metrics.averageWaitSeconds).toBe(1);

    nextState = tickCitizens({ ...nextState, time: nextState.time + 1 }, 1);

    const citizen = nextState.citizens[0];

    expect(citizen?.status).toBe("unserved");
    expect(citizen?.patienceRemaining).toBe(0);
    expect(nextState.metrics.unservedTrips).toBe(1);
    expect(nextState.metrics.totalWaitSeconds).toBe(2);
    expect(nextState.metrics.waitingCitizenCount).toBe(0);
    expect(nextState.metrics.averageWaitSeconds).toBe(0);
  });
});
