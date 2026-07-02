import { describe, expect, it } from "vitest";
import { createTestGameState } from "../helpers/gameState";
import { createUiState } from "../../src/ui/uiState";
import {
  axisLockedLine,
  canonicalLineDirection,
  lineDirection,
  oppositeDirection,
  planDragPreview,
  reverseLanePoints,
} from "../../src/ui/roadDrag";
import { pointsOnRow, withAreas, withRoads } from "../helpers/mapFixtures";

describe("axisLockedLine", () => {
  it("locks to the horizontal axis when |dx| >= |dy|", () => {
    expect(axisLockedLine({ x: 0, y: 0 }, { x: 3, y: 1 })).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 3, y: 0 },
    ]);
  });

  it("locks to the vertical axis when |dy| > |dx|", () => {
    expect(axisLockedLine({ x: 0, y: 0 }, { x: 1, y: 3 })).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 1 },
      { x: 0, y: 2 },
      { x: 0, y: 3 },
    ]);
  });

  it("breaks ties toward horizontal", () => {
    expect(axisLockedLine({ x: 0, y: 0 }, { x: 2, y: 2 })).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
    ]);
  });

  it("returns a single tile when start === end", () => {
    expect(axisLockedLine({ x: 5, y: 5 }, { x: 5, y: 5 })).toEqual([
      { x: 5, y: 5 },
    ]);
  });
});

describe("road drag direction helpers", () => {
  it("derives direction from the first two tiles", () => {
    expect(lineDirection([{ x: 1, y: 1 }])).toBeNull();
    expect(lineDirection(axisLockedLine({ x: 1, y: 1 }, { x: 3, y: 1 }))).toBe(
      "east",
    );
    expect(lineDirection(axisLockedLine({ x: 3, y: 1 }, { x: 1, y: 1 }))).toBe(
      "west",
    );
    expect(lineDirection(axisLockedLine({ x: 1, y: 1 }, { x: 1, y: 3 }))).toBe(
      "south",
    );
    expect(lineDirection(axisLockedLine({ x: 1, y: 3 }, { x: 1, y: 1 }))).toBe(
      "north",
    );
  });

  it("computes opposing directions and reverse lane points", () => {
    const line = axisLockedLine({ x: 1, y: 1 }, { x: 3, y: 1 });

    expect(oppositeDirection("east")).toBe("west");
    expect(reverseLanePoints(line)).toEqual([
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 3, y: 0 },
    ]);
  });

  it("places the dual-bidirectional reverse lane on a drag-order-invariant side", () => {
    // The reverse carriageway must sit on the same physical side of the
    // corridor whether the drag runs low→high or high→low, matching the
    // authoritative Rust `lay_road_line` canonical placement. A westward drag
    // must not flip the reverse lane to the opposite side. (The x-order mirrors
    // the input line order; only the side and tile set are required to match.)
    const eastDrag = axisLockedLine({ x: 1, y: 5 }, { x: 3, y: 5 });
    const westDrag = axisLockedLine({ x: 3, y: 5 }, { x: 1, y: 5 });

    const eastReverse = reverseLanePoints(eastDrag);
    const westReverse = reverseLanePoints(westDrag);

    expect(eastReverse).toEqual([
      { x: 1, y: 4 },
      { x: 2, y: 4 },
      { x: 3, y: 4 },
    ]);
    // Same tiles, north side (y=4) — not flipped to the south side (y=6).
    expect(westReverse).toEqual([
      { x: 3, y: 4 },
      { x: 2, y: 4 },
      { x: 1, y: 4 },
    ]);
    expect(new Set(eastReverse.map((p) => `${p.x},${p.y}`))).toEqual(
      new Set(westReverse.map((p) => `${p.x},${p.y}`)),
    );

    // Vertical corridors canonicalize to "south", whose left is +x (east).
    const southDrag = axisLockedLine({ x: 5, y: 1 }, { x: 5, y: 3 });
    const northDrag = axisLockedLine({ x: 5, y: 3 }, { x: 5, y: 1 });
    expect(
      new Set(reverseLanePoints(southDrag).map((p) => `${p.x},${p.y}`)),
    ).toEqual(new Set(["6,1", "6,2", "6,3"]));
    expect(
      new Set(reverseLanePoints(northDrag).map((p) => `${p.x},${p.y}`)),
    ).toEqual(new Set(["6,1", "6,2", "6,3"]));
  });
});

describe("planDragPreview", () => {
  const roadUi = (preset: "twoWay" | "oneWay" | "dualBidirectional") => ({
    ...createUiState(),
    activeTool: "road" as const,
    roadPreset: preset,
  });

  it("marks every tile of an affordable two-way line as buildable", () => {
    const state = createTestGameState();
    const line = axisLockedLine({ x: 1, y: 0 }, { x: 4, y: 0 });
    const plan = planDragPreview(state, roadUi("twoWay"), line);

    expect(plan).toHaveLength(line.length);
    expect(plan.map((t) => t.buildable)).toEqual([true, true, true, true]);
  });

  it("marks zoned empty tiles buildable for roads", () => {
    const state = withAreas(createTestGameState(), "residential", [
      { x: 2, y: 3 },
      { x: 3, y: 3 },
    ]);
    const line = axisLockedLine({ x: 1, y: 3 }, { x: 3, y: 3 });
    const plan = planDragPreview(state, roadUi("twoWay"), line);
    const byPoint = new Map(
      plan.map((t) => [`${t.point.x},${t.point.y}`, t.buildable]),
    );

    expect(byPoint.get("1,3")).toBe(true);
    expect(byPoint.get("2,3")).toBe(true);
    expect(byPoint.get("3,3")).toBe(true);
  });

  it("treats an existing forward-lane road as a free redirect", () => {
    const state = withRoads(createTestGameState(), [{ x: 8, y: 8 }]);
    const plan = planDragPreview(state, roadUi("twoWay"), [{ x: 8, y: 8 }]);

    expect(plan[0].buildable).toBe(true);
  });

  it("marks trailing tiles not buildable once budget is exhausted", () => {
    const state = { ...createTestGameState(), budget: 250 };
    const line = axisLockedLine({ x: 1, y: 0 }, { x: 4, y: 0 });
    const plan = planDragPreview(state, roadUi("twoWay"), line);

    expect(plan.map((t) => t.buildable)).toEqual([true, true, false, false]);
  });

  it("never marks a reverse lane on an existing road as buildable", () => {
    const state = withRoads(createTestGameState(), pointsOnRow(4, 24, 26));
    const line = axisLockedLine({ x: 24, y: 5 }, { x: 26, y: 5 });
    const plan = planDragPreview(state, roadUi("dualBidirectional"), line);
    const forward = plan.filter((t) => t.point.y === 5);
    const reverse = plan.filter((t) => t.point.y === 4);

    expect(forward.map((t) => t.buildable)).toEqual([true, true, true]);
    expect(reverse.map((t) => t.buildable)).toEqual([false, false, false]);
  });

  it("returns no tiles for the remove tool", () => {
    const state = createTestGameState();
    const ui = { ...createUiState(), activeTool: "remove" as const };
    const line = axisLockedLine({ x: 1, y: 0 }, { x: 3, y: 0 });

    expect(planDragPreview(state, ui, line)).toEqual([]);
  });

  it("marks track tiles buildable where track placement is valid", () => {
    const state = createTestGameState();
    const ui = { ...createUiState(), activeTool: "track" as const };
    const line = axisLockedLine({ x: 1, y: 0 }, { x: 3, y: 0 });
    const plan = planDragPreview(state, ui, line);

    expect(plan.map((t) => t.buildable)).toEqual([true, true, true]);
  });

  it("marks a track tile not buildable over an existing track", () => {
    const state = withRoads(createTestGameState(), [{ x: 2, y: 0 }]);
    const trackState = {
      ...state,
      map: {
        ...state.map,
        tiles: state.map.tiles.map((tile) =>
          tile.x === 2 && tile.y === 0 ? { ...tile, hasTrack: true } : tile,
        ),
      },
    };
    const ui = { ...createUiState(), activeTool: "track" as const };
    const line = axisLockedLine({ x: 1, y: 0 }, { x: 3, y: 0 });
    const plan = planDragPreview(trackState, ui, line);

    expect(plan.map((t) => t.buildable)).toEqual([true, false, true]);
  });
});

describe("canonicalLineDirection", () => {
  it("returns east for a horizontal line regardless of drag order", () => {
    expect(
      canonicalLineDirection(axisLockedLine({ x: 1, y: 1 }, { x: 3, y: 1 })),
    ).toBe("east");
    expect(
      canonicalLineDirection(axisLockedLine({ x: 3, y: 1 }, { x: 1, y: 1 })),
    ).toBe("east");
  });

  it("returns south for a vertical line regardless of drag order", () => {
    expect(
      canonicalLineDirection(axisLockedLine({ x: 1, y: 1 }, { x: 1, y: 3 })),
    ).toBe("south");
    expect(
      canonicalLineDirection(axisLockedLine({ x: 1, y: 3 }, { x: 1, y: 1 })),
    ).toBe("south");
  });

  it("returns null for a line shorter than two tiles", () => {
    expect(canonicalLineDirection([{ x: 1, y: 1 }])).toBeNull();
  });

  it("returns null when the first two tiles are identical (no displacement)", () => {
    expect(
      canonicalLineDirection([
        { x: 2, y: 2 },
        { x: 2, y: 2 },
      ]),
    ).toBeNull();
  });
});

describe("reverseLanePoints edge cases", () => {
  it("returns an empty array when the line has fewer than two tiles", () => {
    expect(reverseLanePoints([{ x: 1, y: 1 }])).toEqual([]);
    expect(reverseLanePoints([])).toEqual([]);
  });
});

describe("planDragPreview edge cases", () => {
  it("returns an empty array for a zero-length line", () => {
    const state = createTestGameState();
    const ui = { ...createUiState(), activeTool: "road" as const };
    expect(planDragPreview(state, ui, [])).toEqual([]);
  });
});
