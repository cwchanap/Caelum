import { describe, expect, it } from "vitest";
import type {
  BuildingRotation,
  GameState,
  Point,
} from "../../src/domain/types";
import { createInitialGameState } from "../../src/simulation/gameState";
import {
  BUILDING_CATALOG,
  canPlaceBuilding,
  getBuildingFootprint,
  getRotatedFootprintSize,
  placeBuilding,
} from "../../src/simulation/buildings";

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

describe("building catalog and footprints", () => {
  it("defines the first Build menu catalog", () => {
    expect(Object.keys(BUILDING_CATALOG)).toEqual([
      "busStop",
      "busTerminal",
      "metroStation",
      "smallHouse",
      "largeHouse",
    ]);
    expect(BUILDING_CATALOG.busTerminal).toMatchObject({
      label: "Bus Terminal",
      width: 3,
      height: 2,
      cost: 12_000,
      effect: "busTerminal",
    });
    expect(BUILDING_CATALOG.smallHouse).toMatchObject({
      label: "Small House",
      width: 2,
      height: 1,
      cost: 4_000,
      citizenCount: 4,
      effect: "housing",
    });
  });

  it.each([
    [0, { width: 3, height: 2 }],
    [90, { width: 2, height: 3 }],
    [180, { width: 3, height: 2 }],
    [270, { width: 2, height: 3 }],
  ] satisfies Array<[BuildingRotation, { width: number; height: number }]>)(
    "rotates a 3x2 footprint at %s degrees",
    (rotation, size) => {
      expect(getRotatedFootprintSize("busTerminal", rotation)).toEqual(size);
    },
  );

  it("expands a rotated footprint from its origin", () => {
    expect(getBuildingFootprint("smallHouse", { x: 4, y: 5 }, 90)).toEqual([
      { x: 4, y: 5 },
      { x: 4, y: 6 },
    ]);
  });

  it("validates the full building footprint against the map and occupancy", () => {
    const state = createInitialGameState();

    expect(canPlaceBuilding(state, "busTerminal", { x: 0, y: 0 }, 0)).toBe(
      true,
    );
    expect(canPlaceBuilding(state, "largeHouse", { x: 27, y: 17 }, 0)).toBe(
      false,
    );
    expect(canPlaceBuilding(state, "metroStation", { x: 7, y: 8 }, 0)).toBe(
      false,
    );

    const withHouse = placeBuilding(state, "smallHouse", { x: 0, y: 0 }, 0);

    expect(canPlaceBuilding(withHouse, "busStop", { x: 0, y: 0 }, 0)).toBe(
      false,
    );
  });

  it("places transit buildings with deterministic entity ids and effects", () => {
    let state = withTrack(createInitialGameState(), [{ x: 3, y: 0 }]);

    state = placeBuilding(state, "busTerminal", { x: 0, y: 0 }, 90);
    state = placeBuilding(state, "metroStation", { x: 3, y: 0 }, 0);

    expect(state.budget).toBe(83_000);
    expect(state.buildings).toEqual([
      {
        id: "building-001",
        type: "busTerminal",
        origin: { x: 0, y: 0 },
        rotation: 90,
        occupiedTiles: [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 0, y: 1 },
          { x: 1, y: 1 },
          { x: 0, y: 2 },
          { x: 1, y: 2 },
        ],
        transitNodeId: "stop-001",
      },
      {
        id: "building-002",
        type: "metroStation",
        origin: { x: 3, y: 0 },
        rotation: 0,
        occupiedTiles: [{ x: 3, y: 0 }],
        transitNodeId: "station-001",
      },
    ]);
    expect(state.transit.stops).toEqual([
      {
        id: "stop-001",
        kind: "busTerminal",
        position: { x: 0, y: 0 },
        platforms: [
          { id: "stop-001-p0", label: "A", capacity: 50, routeIds: [] },
          { id: "stop-001-p1", label: "B", capacity: 50, routeIds: [] },
          { id: "stop-001-p2", label: "C", capacity: 50, routeIds: [] },
        ],
      },
    ]);
    expect(state.transit.stations).toEqual([
      {
        id: "station-001",
        position: { x: 3, y: 0 },
        platforms: [
          { id: "station-001-p0", label: "A", capacity: 300, routeIds: [] },
          { id: "station-001-p1", label: "B", capacity: 300, routeIds: [] },
        ],
      },
    ]);
  });

  it("adds deterministic citizens immediately for house placement", () => {
    const state = placeBuilding(
      createInitialGameState(),
      "largeHouse",
      { x: 0, y: 0 },
      0,
    );

    expect(state.citizens).toHaveLength(46);
    expect(state.citizens[36]).toEqual({
      id: "citizen-037",
      home: { x: 0, y: 0 },
      destination: { x: 10, y: 4 },
      position: { x: 0, y: 0 },
      status: "idle",
      patienceRemaining: 240,
      deadline: 900,
      routePlan: null,
      currentLegIndex: 0,
    });
  });

  it("requires track under a metro station building and rejects other buildings on track", () => {
    const bare = createInitialGameState();
    expect(canPlaceBuilding(bare, "metroStation", { x: 8, y: 2 }, 0)).toBe(
      false,
    );

    const tracked = withTrack(bare, [{ x: 8, y: 2 }]);
    expect(canPlaceBuilding(tracked, "metroStation", { x: 8, y: 2 }, 0)).toBe(
      true,
    );
    expect(canPlaceBuilding(tracked, "smallHouse", { x: 8, y: 2 }, 0)).toBe(
      false,
    );
  });

  it("returns the original state object for invalid or unaffordable placement", () => {
    const state = createInitialGameState();
    const unaffordable = { ...state, budget: 1_999 };

    expect(placeBuilding(state, "largeHouse", { x: 27, y: 17 }, 0)).toBe(state);
    expect(placeBuilding(unaffordable, "busStop", { x: 0, y: 0 }, 0)).toBe(
      unaffordable,
    );
  });
});
