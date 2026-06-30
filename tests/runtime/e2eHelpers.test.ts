import { describe, expect, it } from "vitest";
import { getBoardTransform } from "../../src/render/canvas";
import type { GameMap } from "../../src/domain/types";
import { MAP_HEIGHT, MAP_WIDTH } from "../../src/scenario/growingSuburb";
import { _boardTransformForTest as boardTransform } from "../e2e/helpers";

// The Growing Suburb scenario map dimensions, taken from the TS-side mirror of
// the Rust constants in `crates/caelum-core/src/scenario.rs`. getBoardTransform
// only reads width/height, so an empty tiles array is fine.
const map: GameMap = { width: MAP_WIDTH, height: MAP_HEIGHT, tiles: [] };

describe("e2e boardTransform", () => {
  it("matches getBoardTransform (the render source of truth)", () => {
    // Several board aspect ratios, including letterboxed cases where the map
    // is width-constrained and height-constrained.
    const boxes = [
      { width: 896, height: 576 }, // exact map aspect ratio (no letterbox)
      { width: 1200, height: 576 }, // wider than map -> letterboxed on x
      { width: 896, height: 800 }, // taller than map -> letterboxed on y
      { width: 400, height: 300 },
    ];

    for (const box of boxes) {
      const expected = getBoardTransform(box, map);
      const actual = boardTransform(box);

      expect(actual.scale).toBeCloseTo(expected.scale, 10);
      expect(actual.offsetX).toBeCloseTo(expected.offsetX, 10);
      expect(actual.offsetY).toBeCloseTo(expected.offsetY, 10);
    }
  });
});
