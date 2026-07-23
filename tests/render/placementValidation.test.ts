import { describe, expect, it } from "vitest";
import {
  canPlaceBusStop,
  canPlaceBuilding,
  isAreaPaintable,
  isValidRoadPlacement,
  isValidTrackPlacement,
} from "../../src/render/placementValidation";
import { createTestGameState } from "../helpers/gameState";
import { withAreas, withRoads } from "../helpers/mapFixtures";
import type { GameState, Point } from "../../src/domain/types";

/** Mark a tile as structure-owned (e.g. a roundabout center island:
 * kind "empty" with a roadStructureId) without changing its kind. */
function withStructureTile(
  state: GameState,
  point: Point,
  structureId = "roundabout-3x3-0-0",
): GameState {
  return {
    ...state,
    map: {
      ...state.map,
      tiles: state.map.tiles.map((tile) =>
        tile.x === point.x && tile.y === point.y
          ? { ...tile, roadStructureId: structureId }
          : tile,
      ),
    },
  };
}

describe("placement validation blocks structure-owned tiles", () => {
  // A 3x3 roundabout center island is kind "empty" with a roadStructureId.
  // Rust blocks every infrastructure/zoning op on structure-owned tiles; the
  // TS preview helpers must agree so the cursor does not show a green
  // buildable preview that Rust then rejects on click.
  const center = { x: 5, y: 5 };

  it("canPlaceBuilding returns false on a structure-owned empty tile", () => {
    // Set residential area on the 2x1 footprint so the only blocker is the
    // structure id on the origin tile.
    const state = withStructureTile(
      withAreas(createTestGameState(), "residential", [
        center,
        { x: center.x + 1, y: center.y },
      ]),
      center,
    );
    expect(canPlaceBuilding(state, "smallHouse", center, 0)).toBe(false);
  });

  it("isValidRoadPlacement returns false on a structure-owned empty tile", () => {
    const state = withStructureTile(createTestGameState(), center);
    expect(isValidRoadPlacement(state, center)).toBe(false);
  });

  it("isValidTrackPlacement returns false on a structure-owned empty tile", () => {
    const state = withStructureTile(createTestGameState(), center);
    expect(isValidTrackPlacement(state, center)).toBe(false);
  });

  it("isAreaPaintable returns false on a structure-owned empty tile", () => {
    const state = withStructureTile(createTestGameState(), center);
    expect(isAreaPaintable(state, center)).toBe(false);
  });

  it("still allows placement on a normal empty tile (no structure id)", () => {
    // smallHouse requires residential area and a 2x1 footprint.
    const state = withAreas(createTestGameState(), "residential", [
      center,
      { x: center.x + 1, y: center.y },
    ]);
    expect(canPlaceBuilding(state, "smallHouse", center, 0)).toBe(true);
    expect(isValidRoadPlacement(state, center)).toBe(true);
    expect(isValidTrackPlacement(state, center)).toBe(true);
    expect(isAreaPaintable(state, center)).toBe(true);
  });
});

describe("bus stop placement", () => {
  it("accepts a bus stop anchor beside a road, not on it", () => {
    const state = withRoads(createTestGameState(), [{ x: 4, y: 5 }]);

    expect(canPlaceBusStop(state, { x: 4, y: 4 })).toBe(true);
    expect(canPlaceBusStop(state, { x: 4, y: 5 })).toBe(false);
  });
});
