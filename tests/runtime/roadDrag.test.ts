import { describe, expect, it } from "vitest";
import type { GameState } from "../../src/domain/types";
import { createInitialGameState } from "../../src/simulation/gameState";
import { getTile } from "../../src/simulation/map";
import { COSTS, addBusStop, addBusRoute } from "../../src/simulation/transit";
import { createUiState } from "../../src/ui/uiState";
import { axisLockedLine, applyDragGesture } from "../../src/ui/roadDrag";

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

  it("walks in the negative direction", () => {
    expect(axisLockedLine({ x: 3, y: 0 }, { x: 0, y: 0 })).toEqual([
      { x: 3, y: 0 },
      { x: 2, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: 0 },
    ]);
  });
});

function tileAt(state: GameState, x: number, y: number) {
  const t = getTile(state.map, { x, y });
  if (t === null) throw new Error(`no tile at ${x},${y}`);
  return t;
}

const roadUi = (preset: "twoWay" | "oneWay") => ({
  ...createUiState(),
  activeTool: "road" as const,
  roadPreset: preset,
});

describe("applyDragGesture single-lane road", () => {
  it("lays a two-way road line and charges per tile", () => {
    const state = createInitialGameState();
    const line = axisLockedLine({ x: 1, y: 0 }, { x: 4, y: 0 });
    const next = applyDragGesture(state, roadUi("twoWay"), line);
    for (const x of [1, 2, 3, 4]) {
      expect(tileAt(next, x, 0).kind).toBe("road");
      expect(tileAt(next, x, 0).oneWay).toBeUndefined();
    }
    expect(next.budget).toBe(state.budget - 4 * COSTS.road);
  });

  it("lays a one-way road line in the eastbound drag direction", () => {
    const state = createInitialGameState();
    const line = axisLockedLine({ x: 1, y: 0 }, { x: 4, y: 0 });
    const next = applyDragGesture(state, roadUi("oneWay"), line);
    for (const x of [1, 2, 3, 4]) {
      expect(tileAt(next, x, 0).oneWay).toBe("east");
    }
  });

  it("lays one-way westbound when dragged in reverse", () => {
    const state = createInitialGameState();
    const line = axisLockedLine({ x: 4, y: 0 }, { x: 1, y: 0 });
    const next = applyDragGesture(state, roadUi("oneWay"), line);
    for (const x of [1, 2, 3, 4]) {
      expect(tileAt(next, x, 0).oneWay).toBe("west");
    }
  });

  it("lays one-way southbound for a vertical drag", () => {
    const state = createInitialGameState();
    const line = axisLockedLine({ x: 0, y: 0 }, { x: 0, y: 3 });
    const next = applyDragGesture(state, roadUi("oneWay"), line);
    for (const y of [0, 1, 2, 3]) {
      expect(tileAt(next, 0, y).oneWay).toBe("south");
    }
  });

  it("redirects an existing one-way line back to two-way for free", () => {
    const state = createInitialGameState();
    const line = axisLockedLine({ x: 1, y: 0 }, { x: 4, y: 0 });
    const oneWay = applyDragGesture(state, roadUi("oneWay"), line);
    expect(tileAt(oneWay, 2, 0).oneWay).toBe("east");
    const cleared = applyDragGesture(oneWay, roadUi("twoWay"), line);
    expect(tileAt(cleared, 2, 0).oneWay).toBeUndefined();
    expect(cleared.budget).toBe(oneWay.budget); // already road -> no charge
  });

  it("skips non-empty tiles in the line and only charges placed tiles", () => {
    const state = createInitialGameState();
    // Row y=3 crosses residential at x 2..5; x1 and x6 are empty.
    const line = axisLockedLine({ x: 1, y: 3 }, { x: 6, y: 3 });
    const next = applyDragGesture(state, roadUi("twoWay"), line);
    expect(tileAt(next, 1, 3).kind).toBe("road");
    expect(tileAt(next, 2, 3).kind).toBe("residential");
    expect(tileAt(next, 6, 3).kind).toBe("road");
    expect(next.budget).toBe(state.budget - 2 * COSTS.road);
  });

  it("stops laying when the budget is exhausted mid-line", () => {
    const state = { ...createInitialGameState(), budget: 250 };
    const line = axisLockedLine({ x: 1, y: 0 }, { x: 4, y: 0 });
    const next = applyDragGesture(state, roadUi("twoWay"), line);
    expect(tileAt(next, 1, 0).kind).toBe("road");
    expect(tileAt(next, 2, 0).kind).toBe("road");
    expect(tileAt(next, 3, 0).kind).toBe("empty");
    expect(next.budget).toBe(50);
  });
});

describe("applyDragGesture track", () => {
  it("lays track along the line", () => {
    const state = createInitialGameState();
    const ui = { ...createUiState(), activeTool: "track" as const };
    const line = axisLockedLine({ x: 1, y: 0 }, { x: 4, y: 0 });
    const next = applyDragGesture(state, ui, line);
    for (const x of [1, 2, 3, 4]) {
      expect(tileAt(next, x, 0).hasTrack).toBe(true);
    }
    expect(next.budget).toBe(state.budget - 4 * COSTS.track);
  });
});

describe("applyDragGesture dual bidirectional", () => {
  const dualUi = {
    ...createUiState(),
    activeTool: "road" as const,
    roadPreset: "dualBidirectional" as const,
  };

  it("east drag: forward east on the dragged row, west on the lane to the north", () => {
    const state = createInitialGameState();
    const line = axisLockedLine({ x: 1, y: 1 }, { x: 4, y: 1 });
    const next = applyDragGesture(state, dualUi, line);
    for (const x of [1, 2, 3, 4]) {
      expect(tileAt(next, x, 1).oneWay).toBe("east");
      expect(tileAt(next, x, 0).oneWay).toBe("west");
    }
    expect(next.budget).toBe(state.budget - 8 * COSTS.road);
  });

  it("west drag: forward west, east on the lane to the south", () => {
    const state = createInitialGameState();
    const line = axisLockedLine({ x: 4, y: 1 }, { x: 1, y: 1 });
    const next = applyDragGesture(state, dualUi, line);
    for (const x of [1, 2, 3, 4]) {
      expect(tileAt(next, x, 1).oneWay).toBe("west");
      expect(tileAt(next, x, 2).oneWay).toBe("east");
    }
  });

  it("south drag: forward south, north on the lane to the east", () => {
    const state = createInitialGameState();
    const line = axisLockedLine({ x: 24, y: 0 }, { x: 24, y: 4 });
    const next = applyDragGesture(state, dualUi, line);
    for (const y of [0, 1, 2, 3, 4]) {
      expect(tileAt(next, 24, y).oneWay).toBe("south");
      expect(tileAt(next, 25, y).oneWay).toBe("north");
    }
  });

  it("north drag: forward north, south on the lane to the west", () => {
    const state = createInitialGameState();
    const line = axisLockedLine({ x: 24, y: 4 }, { x: 24, y: 0 });
    const next = applyDragGesture(state, dualUi, line);
    for (const y of [0, 1, 2, 3, 4]) {
      expect(tileAt(next, 24, y).oneWay).toBe("north");
      expect(tileAt(next, 23, y).oneWay).toBe("south");
    }
  });

  it("never hijacks an existing road for the reverse lane", () => {
    const state = createInitialGameState();
    // Row y=9 is empty; the lane to the north (y=8) is an existing road row.
    const line = axisLockedLine({ x: 24, y: 9 }, { x: 26, y: 9 });
    const next = applyDragGesture(state, dualUi, line);
    for (const x of [24, 25, 26]) {
      expect(tileAt(next, x, 9).oneWay).toBe("east"); // forward lane laid
      expect(tileAt(next, x, 8).kind).toBe("road");
      expect(tileAt(next, x, 8).oneWay).toBeUndefined(); // existing road untouched
    }
    expect(next.budget).toBe(state.budget - 3 * COSTS.road); // reverse lane skipped
  });
});

describe("applyDragGesture recomputes route paths after setting directions", () => {
  it("breaks a route's return leg when a one-way drag severs it", () => {
    let state = createInitialGameState();
    state = addBusStop(state, { x: 7, y: 8 });
    state = addBusStop(state, { x: 15, y: 8 });
    state = addBusRoute(state, ["stop-001", "stop-002"]);
    expect(state.transit.routes[0].pathBroken).toBe(false);

    // Drag an existing stretch of the y=8 road one-way EAST. The eastbound
    // leg still works but the westbound return can no longer pass, so the
    // round-trip route must be reported broken — which only happens if route
    // paths are recomputed after the drag sets the directions.
    const ui = {
      ...createUiState(),
      activeTool: "road" as const,
      roadPreset: "oneWay" as const,
    };
    const line = axisLockedLine({ x: 8, y: 8 }, { x: 10, y: 8 });
    const dragged = applyDragGesture(state, ui, line);

    expect(getTile(dragged.map, { x: 8, y: 8 })?.oneWay).toBe("east");
    expect(dragged.transit.routes[0].pathBroken).toBe(true);
  });
});
