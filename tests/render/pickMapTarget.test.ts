import { describe, expect, it } from "vitest";
import { pickMapTarget } from "../../src/render/webgpu/pickMapTarget";
import { tileSize } from "../../src/render/boardTransform";
import type { GameState } from "../../src/domain/types";
import {
  addTestBusRoute,
  addTestBusStop,
  createTestGameState,
  placeTestBuilding,
} from "../helpers/gameState";
import { pointsOnRow, withRoads } from "../helpers/mapFixtures";

function corridorState(routeCount = 1): GameState {
  let state = createTestGameState();
  state = withRoads(state, pointsOnRow(8, 7, 15));
  state = addTestBusStop(state, { x: 7, y: 8 });
  state = addTestBusStop(state, { x: 15, y: 8 });
  for (let index = 0; index < routeCount; index += 1) {
    state = addTestBusRoute(state, ["stop-001", "stop-002"]);
  }
  return state;
}

describe("pickMapTarget", () => {
  it("picks the sample inside half a tile", () => {
    const pick = pickMapTarget(
      [{ id: "vehicle-001", point: { x: 80, y: 80 } }],
      null,
      { x: 90, y: 88 },
      { x: 2, y: 2 },
    );

    expect(pick).toEqual({ vehicleId: "vehicle-001", lineId: null });
  });

  it("keeps the boundary at exactly half a tile and misses beyond it", () => {
    const samples = [{ id: "vehicle-001", point: { x: 80, y: 80 } }];

    expect(
      pickMapTarget(
        samples,
        null,
        { x: 80 + tileSize / 2, y: 80 },
        { x: 3, y: 2 },
      ),
    ).toEqual({
      vehicleId: "vehicle-001",
      lineId: null,
    });
    expect(
      pickMapTarget(
        samples,
        null,
        { x: 80 + tileSize / 2 + 0.5, y: 80 },
        { x: 3, y: 2 },
      ),
    ).toBeNull();
    expect(
      pickMapTarget(samples, null, { x: 400, y: 400 }, { x: 12, y: 12 }),
    ).toBeNull();
  });

  it("picks the nearest of two samples", () => {
    const pick = pickMapTarget(
      [
        { id: "vehicle-001", point: { x: 80, y: 80 } },
        { id: "vehicle-002", point: { x: 84, y: 80 } },
      ],
      null,
      { x: 83, y: 80 },
      { x: 2, y: 2 },
    );

    expect(pick).toEqual({ vehicleId: "vehicle-002", lineId: null });
  });

  it("breaks a distance tie by id", () => {
    const pick = pickMapTarget(
      [
        { id: "vehicle-002", point: { x: 76, y: 80 } },
        { id: "vehicle-001", point: { x: 84, y: 80 } },
      ],
      null,
      { x: 80, y: 80 },
      { x: 2, y: 2 },
    );

    expect(pick).toEqual({ vehicleId: "vehicle-001", lineId: null });
  });

  it("misses an empty sample list", () => {
    expect(
      pickMapTarget([], null, { x: 80, y: 80 }, { x: 2, y: 2 }),
    ).toBeNull();
  });
});

describe("pickMapTarget line paths", () => {
  it("hits a line whose presented step is on the clicked tile", () => {
    const state = corridorState();

    const pick = pickMapTarget([], state, { x: 300, y: 272 }, { x: 9, y: 8 });

    expect(pick).toEqual({ vehicleId: null, lineId: "route-001" });
  });

  it("stays pickable up to the path end tile", () => {
    const state = corridorState();

    const pick = pickMapTarget([], state, { x: 491, y: 272 }, { x: 15, y: 8 });

    expect(pick).toEqual({ vehicleId: null, lineId: "route-001" });
  });

  it("does not let a shared-corridor proximity radius steal an adjacent building tile", () => {
    let state = corridorState(2);
    state = placeTestBuilding(state, "smallHouse", { x: 9, y: 7 }, 0);

    expect(
      pickMapTarget([], state, { x: 300, y: 255 }, { x: 9, y: 7 }),
    ).toBeNull();
  });

  it("picks the nearest of two lines sharing the corridor, then the stable id", () => {
    const state = corridorState(2);

    expect(
      pickMapTarget([], state, { x: 300, y: 271 }, { x: 9, y: 8 }),
    ).toEqual({ vehicleId: null, lineId: "route-001" });
    expect(
      pickMapTarget([], state, { x: 300, y: 273 }, { x: 9, y: 8 }),
    ).toEqual({ vehicleId: null, lineId: "route-002" });
    expect(
      pickMapTarget([], state, { x: 300, y: 272 }, { x: 9, y: 8 }),
    ).toEqual({ vehicleId: null, lineId: "route-001" });
  });

  it("returns both candidates when a vehicle and a line share the click", () => {
    const state = corridorState();

    const pick = pickMapTarget(
      [{ id: "vehicle-001", point: { x: 300, y: 272 } }],
      state,
      { x: 300, y: 272 },
      { x: 9, y: 8 },
    );

    expect(pick).toEqual({ vehicleId: "vehicle-001", lineId: "route-001" });
  });
});
