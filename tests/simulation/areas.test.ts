import { describe, expect, it } from "vitest";
import type { GameState } from "../../src/domain/types";
import { createInitialGameState } from "../../src/simulation/gameState";
import {
  AREA_KINDS,
  isAreaPaintable,
  paintAreaRectangle,
  planAreaPaintPreview,
  rectanglePoints,
} from "../../src/simulation/areas";
import { withAreas, withRoads, withTracks } from "../helpers/mapFixtures";

function areaAt(state: GameState, x: number, y: number) {
  return state.map.tiles.find((tile) => tile.x === x && tile.y === y)?.area;
}

describe("area painting", () => {
  it("defines the player-facing area types in HUD order", () => {
    expect(AREA_KINDS).toEqual([
      "residential",
      "commercial",
      "industrial",
      "office",
      "civic",
      "park",
    ]);
  });

  it("returns inclusive rectangle points in row-major order", () => {
    expect(rectanglePoints({ x: 3, y: 2 }, { x: 1, y: 4 })).toEqual([
      { x: 1, y: 2 },
      { x: 2, y: 2 },
      { x: 3, y: 2 },
      { x: 1, y: 3 },
      { x: 2, y: 3 },
      { x: 3, y: 3 },
      { x: 1, y: 4 },
      { x: 2, y: 4 },
      { x: 3, y: 4 },
    ]);
  });

  it("paints valid empty tiles and skips roads and tracks", () => {
    let state = createInitialGameState();
    state = withRoads(state, [{ x: 2, y: 1 }]);
    state = withTracks(state, [{ x: 3, y: 1 }]);

    const next = paintAreaRectangle(
      state,
      "residential",
      { x: 1, y: 1 },
      { x: 3, y: 2 },
    );

    expect(areaAt(next, 1, 1)).toBe("residential");
    expect(areaAt(next, 2, 1)).toBeUndefined();
    expect(areaAt(next, 3, 1)).toBeUndefined();
    expect(areaAt(next, 1, 2)).toBe("residential");
    expect(next).not.toBe(state);
  });

  it("skips placed building footprints", () => {
    const state: GameState = {
      ...createInitialGameState(),
      buildings: [
        {
          id: "building-001",
          type: "smallHouse",
          origin: { x: 1, y: 1 },
          rotation: 0,
          occupiedTiles: [
            { x: 1, y: 1 },
            { x: 2, y: 1 },
          ],
        },
      ],
    };

    const next = paintAreaRectangle(
      state,
      "commercial",
      { x: 1, y: 1 },
      { x: 3, y: 1 },
    );

    expect(areaAt(next, 1, 1)).toBeUndefined();
    expect(areaAt(next, 2, 1)).toBeUndefined();
    expect(areaAt(next, 3, 1)).toBe("commercial");
  });

  it("skips transit stop and station positions", () => {
    const state: GameState = {
      ...createInitialGameState(),
      transit: {
        ...createInitialGameState().transit,
        stops: [
          {
            id: "stop-001",
            kind: "busStop",
            position: { x: 1, y: 1 },
            platforms: [],
          },
        ],
        stations: [
          {
            id: "station-001",
            position: { x: 2, y: 1 },
            platforms: [],
          },
        ],
      },
    };

    const next = paintAreaRectangle(
      state,
      "office",
      { x: 1, y: 1 },
      { x: 3, y: 1 },
    );

    expect(areaAt(next, 1, 1)).toBeUndefined();
    expect(areaAt(next, 2, 1)).toBeUndefined();
    expect(areaAt(next, 3, 1)).toBe("office");
  });

  it("re-zones empty tiles that already carry a different area", () => {
    const state = withAreas(createInitialGameState(), "residential", [
      { x: 1, y: 1 },
      { x: 2, y: 1 },
    ]);

    const next = paintAreaRectangle(
      state,
      "commercial",
      { x: 1, y: 1 },
      { x: 2, y: 1 },
    );

    expect(areaAt(next, 1, 1)).toBe("commercial");
    expect(areaAt(next, 2, 1)).toBe("commercial");
    expect(next).not.toBe(state);
  });

  it("returns the same state reference when nothing can be painted", () => {
    const state = withRoads(createInitialGameState(), [
      { x: 1, y: 1 },
      { x: 2, y: 1 },
    ]);

    expect(
      paintAreaRectangle(state, "commercial", { x: 1, y: 1 }, { x: 2, y: 1 }),
    ).toBe(state);
  });

  it("plans per-tile preview validity for the rectangle", () => {
    const state = withRoads(createInitialGameState(), [{ x: 2, y: 1 }]);

    expect(planAreaPaintPreview(state, { x: 1, y: 1 }, { x: 2, y: 1 })).toEqual(
      [
        { point: { x: 1, y: 1 }, paintable: true },
        { point: { x: 2, y: 1 }, paintable: false },
      ],
    );
  });

  it("rejects off-map points", () => {
    expect(isAreaPaintable(createInitialGameState(), { x: -1, y: 0 })).toBe(
      false,
    );
  });
});
