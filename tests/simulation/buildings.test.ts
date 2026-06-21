import { describe, expect, it } from "vitest";
import type { BuildingRotation } from "../../src/domain/types";
import { createInitialGameState } from "../../src/simulation/gameState";
import {
  BUILDING_CATALOG,
  canPlaceBuilding,
  getBuildingFootprint,
  getRotatedFootprintSize,
  placeBuilding,
} from "../../src/simulation/buildings";
import { withAreas, withRoads, withTracks } from "../helpers/mapFixtures";

describe("building catalog and footprints", () => {
  it("defines the first Build menu catalog", () => {
    expect(Object.keys(BUILDING_CATALOG)).toEqual([
      "busStop",
      "busTerminal",
      "metroStation",
      "smallHouse",
      "largeHouse",
      "supermarket",
      "cinema",
      "factory",
      "warehouse",
      "officeTower",
      "businessPark",
      "clinic",
      "school",
      "parkPlaza",
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

  it("defines zoned destination buildings in the catalog", () => {
    expect(BUILDING_CATALOG.supermarket).toMatchObject({
      label: "Supermarket",
      width: 2,
      height: 2,
      allowedArea: "commercial",
      effect: "destination",
    });
    expect(BUILDING_CATALOG.officeTower).toMatchObject({
      label: "Office Tower",
      allowedArea: "office",
      effect: "destination",
    });
    expect(BUILDING_CATALOG.parkPlaza).toMatchObject({
      label: "Park Plaza",
      allowedArea: "park",
      effect: "destination",
    });
  });

  it("enforces the effect ↔ allowedArea invariant across the catalog", () => {
    // Locks the convention that housing/destination buildings must declare a
    // zoned allowedArea (so they are placeable only in their district) and
    // transit buildings must NOT (so they remain freely placeable on roads).
    // A catalog edit that violates this would be silently legal at the type
    // level today; this test is the low-cost backstop until BuildingDefinition
    // becomes a proper discriminated union.
    for (const def of Object.values(BUILDING_CATALOG)) {
      if (def.effect === "housing" || def.effect === "destination") {
        expect(
          def.allowedArea,
          `${def.type} must declare allowedArea`,
        ).toBeDefined();
      } else {
        expect(
          def.allowedArea,
          `${def.type} must not declare allowedArea`,
        ).toBeUndefined();
      }
    }
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
    const residential = withAreas(state, "residential", [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
    ]);

    expect(canPlaceBuilding(state, "busTerminal", { x: 0, y: 0 }, 0)).toBe(
      true,
    );
    expect(canPlaceBuilding(state, "largeHouse", { x: 27, y: 17 }, 0)).toBe(
      false,
    );
    expect(canPlaceBuilding(state, "metroStation", { x: 7, y: 8 }, 0)).toBe(
      false,
    );

    const withHouse = placeBuilding(
      residential,
      "smallHouse",
      { x: 0, y: 0 },
      0,
    );

    expect(canPlaceBuilding(withHouse, "busStop", { x: 0, y: 0 }, 0)).toBe(
      false,
    );
  });

  it("requires matching area for zoned building footprints", () => {
    const base = createInitialGameState();
    const residential = withAreas(base, "residential", [
      { x: 1, y: 1 },
      { x: 2, y: 1 },
    ]);
    const commercial = withAreas(base, "commercial", [
      { x: 1, y: 1 },
      { x: 2, y: 1 },
    ]);

    expect(canPlaceBuilding(base, "smallHouse", { x: 1, y: 1 }, 0)).toBe(false);
    expect(canPlaceBuilding(commercial, "smallHouse", { x: 1, y: 1 }, 0)).toBe(
      false,
    );
    expect(canPlaceBuilding(residential, "smallHouse", { x: 1, y: 1 }, 0)).toBe(
      true,
    );
  });

  it("places transit buildings with deterministic entity ids and effects", () => {
    let state = withTracks(createInitialGameState(), [{ x: 3, y: 0 }]);

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
      withAreas(createInitialGameState(), "residential", [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 2, y: 0 },
        { x: 0, y: 1 },
        { x: 1, y: 1 },
        { x: 2, y: 1 },
      ]),
      "largeHouse",
      { x: 0, y: 0 },
      0,
    );

    expect(state.citizens).toHaveLength(10);
    expect(state.citizens[0]).toEqual({
      id: "citizen-001",
      home: { x: 0, y: 0 },
      destination: { x: 0, y: 0 },
      position: { x: 0, y: 0 },
      status: "idle",
      patienceRemaining: 240,
      deadline: 900,
      routePlan: null,
      currentLegIndex: 0,
    });
  });

  it("uses home as a fallback destination when no destination building exists", () => {
    const state = placeBuilding(
      withAreas(createInitialGameState(), "residential", [
        { x: 1, y: 1 },
        { x: 2, y: 1 },
      ]),
      "smallHouse",
      { x: 1, y: 1 },
      0,
    );

    expect(state.citizens).toHaveLength(4);
    expect(state.citizens[0]).toMatchObject({
      id: "citizen-001",
      home: { x: 1, y: 1 },
      destination: { x: 1, y: 1 },
    });
  });

  it("uses placed destination buildings for later housing citizens", () => {
    let state = withAreas(createInitialGameState(), "commercial", [
      { x: 5, y: 1 },
      { x: 6, y: 1 },
      { x: 5, y: 2 },
      { x: 6, y: 2 },
    ]);
    state = placeBuilding(state, "supermarket", { x: 5, y: 1 }, 0);
    state = withAreas(state, "residential", [
      { x: 1, y: 1 },
      { x: 2, y: 1 },
    ]);
    state = placeBuilding(state, "smallHouse", { x: 1, y: 1 }, 0);

    expect(state.citizens[0].destination).toEqual({ x: 5, y: 1 });
    expect(state.citizens[1].destination).toEqual({ x: 6, y: 1 });
    expect(state.citizens[2].destination).toEqual({ x: 5, y: 2 });
    expect(state.citizens[3].destination).toEqual({ x: 6, y: 2 });
  });

  it("requires track under a metro station building and rejects other buildings on track", () => {
    const bare = createInitialGameState();
    expect(canPlaceBuilding(bare, "metroStation", { x: 8, y: 2 }, 0)).toBe(
      false,
    );

    const tracked = withTracks(bare, [{ x: 8, y: 2 }]);
    expect(canPlaceBuilding(tracked, "metroStation", { x: 8, y: 2 }, 0)).toBe(
      true,
    );
    expect(canPlaceBuilding(tracked, "smallHouse", { x: 8, y: 2 }, 0)).toBe(
      false,
    );
  });

  it("allows metro station building on road + track crossings, matching the station tool rule", () => {
    const state = withRoads(createInitialGameState(), [{ x: 7, y: 8 }]);
    const crossing = withTracks(state, [{ x: 7, y: 8 }]);
    expect(canPlaceBuilding(crossing, "metroStation", { x: 7, y: 8 }, 0)).toBe(
      true,
    );
    // Non-metro buildings are still rejected on any track.
    expect(canPlaceBuilding(crossing, "smallHouse", { x: 7, y: 8 }, 0)).toBe(
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
