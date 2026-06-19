import { describe, expect, it } from "vitest";
import type { Citizen } from "../../src/domain/types";
import {
  createGrowingSuburbMap,
  MAP_HEIGHT,
  MAP_WIDTH,
} from "../../src/scenario/growingSuburb";
import { createInitialGameState } from "../../src/simulation/gameState";
import { tickSimulation } from "../../src/simulation/simulation";

function testCitizen(overrides: Partial<Citizen> = {}): Citizen {
  return {
    id: "citizen-001",
    home: { x: 2, y: 3 },
    destination: { x: 3, y: 3 },
    position: { x: 2, y: 3 },
    status: "idle",
    patienceRemaining: 240,
    deadline: 900,
    routePlan: null,
    currentLegIndex: 0,
    ...overrides,
  };
}

describe("Growing Suburb scenario", () => {
  it("creates a deterministic starting city", () => {
    const state = createInitialGameState();

    expect(state.scenario.name).toBe("Growing Suburb");
    expect(state.map.width).toBe(28);
    expect(state.map.height).toBe(18);
    expect(state.map.tiles).toHaveLength(state.map.width * state.map.height);
    expect(state.budget).toBe(120_000);
    expect(state.citizens).toEqual([]);
    expect(state.scenario.growthWaves).toEqual([]);
  });

  it("starts mostly empty with only a two-lane arterial cross", () => {
    const map = createGrowingSuburbMap();
    const roadTiles = map.tiles.filter((tile) => tile.kind === "road");
    const tileAt = (x: number, y: number) =>
      map.tiles.find((tile) => tile.x === x && tile.y === y);

    expect(map.tiles.filter((tile) => tile.area !== undefined)).toEqual([]);
    expect(roadTiles).toHaveLength(88);

    for (let x = 0; x < MAP_WIDTH; x += 1) {
      expect(tileAt(x, 8)?.kind).toBe("road");
      expect(tileAt(x, 9)?.kind).toBe("road");
    }

    for (let y = 0; y < MAP_HEIGHT; y += 1) {
      expect(tileAt(14, y)?.kind).toBe("road");
      expect(tileAt(15, y)?.kind).toBe("road");
    }

    expect(tileAt(7, 8)?.oneWay).toBe("west");
    expect(tileAt(7, 9)?.oneWay).toBe("east");
    expect(tileAt(14, 3)?.oneWay).toBe("south");
    expect(tileAt(15, 3)?.oneWay).toBe("north");
    expect(tileAt(14, 8)?.oneWay).toBeUndefined();
    expect(tileAt(15, 9)?.oneWay).toBeUndefined();
  });

  it("starts without citizens or growth waves", () => {
    const state = createInitialGameState();

    expect(state.citizens).toEqual([]);
    expect(state.scenario.growthWaves).toEqual([]);
  });

  it("does not advance while paused", () => {
    const state = createInitialGameState();

    expect(tickSimulation(state, 250)).toBe(state);
  });

  it("scales delta by simulation speed", () => {
    const state = {
      ...createInitialGameState(),
      paused: false,
      speed: 2 as const,
    };

    const nextState = tickSimulation(state, 100);

    expect(nextState.time).toBe(200);
  });

  it("evaluates waiting citizen deadlines against the advanced simulation time", () => {
    const baseState = createInitialGameState();
    const state = {
      ...baseState,
      paused: false,
      citizens: [
        {
          ...testCitizen(),
          destination: { x: 23, y: 8 },
          deadline: 0,
          patienceRemaining: 1_000,
          routePlan: {
            estimatedSeconds: 90,
            legs: [
              {
                mode: "bus" as const,
                from: { x: 7, y: 8 },
                to: { x: 23, y: 8 },
                lineId: "route-001",
              },
            ],
          },
          currentLegIndex: 0,
        },
      ],
    };

    const nextState = tickSimulation(state, 301);

    expect(nextState.time).toBe(301);
    expect(nextState.citizens[0]?.status).toBe("unserved");
    expect(nextState.metrics.unservedTrips).toBe(1);
  });

  it("scores one-step walking arrivals against the advanced simulation time", () => {
    const baseState = createInitialGameState();
    const state = {
      ...baseState,
      paused: false,
      citizens: [
        {
          ...testCitizen(),
          destination: { x: 3, y: 3 },
          deadline: 20,
        },
      ],
    };

    const nextState = tickSimulation(state, 20);

    expect(nextState.time).toBe(20);
    expect(nextState.citizens[0]?.status).toBe("arrived");
    expect(nextState.metrics.completedTrips).toBe(1);
    expect(nextState.metrics.lateTrips).toBe(0);
  });
});
