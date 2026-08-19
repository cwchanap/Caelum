import { describe, expect, it } from "vitest";
import type {
  ActiveTrip,
  GameState,
  Point,
  RoadPathStep,
} from "../../src/domain/types";
import { selectTrafficFlow } from "../../src/domain/traffic";
import { createTestGameState } from "../helpers/gameState";

function roadStep(position: Point): RoadPathStep {
  return {
    position,
    enteringHeading: "east",
    leavingHeading: "east",
    movement: "straight",
    geometry: {
      kind: "line",
      from: position,
      to: { x: position.x + 1, y: position.y },
    },
    travelSeconds: 1,
  };
}

function drivingTrip(id: string, positions: Point[]): ActiveTrip {
  return {
    id,
    simId: `sim-${id}`,
    purpose: "commuteOutbound",
    origin: { x: 0, y: 0 },
    destination: { x: 8, y: 8 },
    position: positions[0] ?? { x: 0, y: 0 },
    status: "driving",
    deadline: 100,
    routePlan: null,
    currentLegIndex: 0,
    patienceRemaining: 100,
    currentLegWaitSeconds: 0,
    privateCarTrip: {
      path: {
        kind: "road",
        steps: positions.map(roadStep),
        totalTravelSeconds: positions.length,
      },
      arrivalTime: 100,
    },
  };
}

function roadState(points: Point[]): GameState {
  const roadKeys = new Set(points.map((point) => `${point.x},${point.y}`));
  const state = createTestGameState();
  return {
    ...state,
    map: {
      ...state.map,
      tiles: state.map.tiles.map((tile) =>
        roadKeys.has(`${tile.x},${tile.y}`)
          ? { ...tile, kind: "road" as const }
          : tile,
      ),
    },
  };
}

describe("selectTrafficFlow", () => {
  it("deduplicates each driving car and aggregates shared road points", () => {
    const state = roadState([
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 0, y: 1 },
    ]);
    const waitingTrip = {
      ...drivingTrip("waiting", [{ x: 1, y: 0 }]),
      status: "waiting" as const,
      currentLegWaitSeconds: 0,
      privateCarTrip: null,
    };

    expect(
      selectTrafficFlow({
        ...state,
        activeTrips: [
          drivingTrip("car-1", [
            { x: 1, y: 0 },
            { x: 2, y: 0 },
            { x: 2, y: 0 },
          ]),
          drivingTrip("car-2", [{ x: 2, y: 0 }]),
          drivingTrip("car-3", [{ x: 0, y: 1 }]),
          waitingTrip,
        ],
      }),
    ).toEqual([
      { point: { x: 1, y: 0 }, flow: 1 },
      { point: { x: 2, y: 0 }, flow: 2 },
      { point: { x: 0, y: 1 }, flow: 1 },
    ]);
  });

  it("omits a path point whose current tile is no longer a road", () => {
    const state = roadState([
      { x: 1, y: 0 },
      { x: 2, y: 0 },
    ]);
    const tiles = state.map.tiles.map((tile) =>
      tile.x === 2 && tile.y === 0 ? { ...tile, kind: "empty" as const } : tile,
    );

    expect(
      selectTrafficFlow({
        ...state,
        map: { ...state.map, tiles },
        activeTrips: [
          drivingTrip("car-1", [
            { x: 1, y: 0 },
            { x: 2, y: 0 },
            { x: 2, y: 0 },
          ]),
        ],
      }),
    ).toEqual([{ point: { x: 1, y: 0 }, flow: 1 }]);
  });
});
