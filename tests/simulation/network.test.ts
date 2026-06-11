import { describe, expect, it } from "vitest";
import type { GameState, Point } from "../../src/domain/types";
import { createInitialGameState } from "../../src/simulation/gameState";
import {
  computeRouteSegments,
  findTilePath,
  hasBrokenSegment,
} from "../../src/simulation/network";

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

function trackRow(y: number, fromX: number, toX: number): Point[] {
  return Array.from({ length: toX - fromX + 1 }, (_, i) => ({
    x: fromX + i,
    y,
  }));
}

describe("findTilePath", () => {
  it("finds the straight shortest bus path along the y=8 road row", () => {
    const state = createInitialGameState();

    const path = findTilePath(
      state.map,
      { x: 7, y: 8 },
      { x: 11, y: 8 },
      "bus",
    );

    expect(path).toEqual([
      { x: 7, y: 8 },
      { x: 8, y: 8 },
      { x: 9, y: 8 },
      { x: 10, y: 8 },
      { x: 11, y: 8 },
    ]);
  });

  it("is deterministic when two equal shortest paths exist (N,E,S,W expansion)", () => {
    // The road network has only one row, so equal alternatives need a track
    // ring: a 2x3 loop where (5,2)->(7,4) has two 4-step paths (across-then-
    // down vs down-then-across). BFS discovery order must always pick the
    // across-then-down one.
    const ring = [
      ...trackRow(2, 5, 7),
      ...trackRow(4, 5, 7),
      { x: 5, y: 3 },
      { x: 7, y: 3 },
    ];
    const state = withTrack(createInitialGameState(), ring);

    const path = findTilePath(
      state.map,
      { x: 5, y: 2 },
      { x: 7, y: 4 },
      "metro",
    );

    expect(path).toEqual([
      { x: 5, y: 2 },
      { x: 6, y: 2 },
      { x: 7, y: 2 },
      { x: 7, y: 3 },
      { x: 7, y: 4 },
    ]);
  });

  it("returns null when no bus path exists", () => {
    const state = createInitialGameState();

    // (2,3) is a residential tile with no road under or near the endpoint's
    // immediate connectivity requirement: its neighbors are residential/empty.
    expect(
      findTilePath(state.map, { x: 2, y: 3 }, { x: 7, y: 8 }, "bus"),
    ).toBeNull();
  });

  it("treats endpoints as traversable so off-road stops connect via an adjacent road", () => {
    const state = createInitialGameState();

    // (8,7) and (16,7) are empty tiles directly above the y=8 road (the e2e
    // flow places Bus Stop buildings there).
    const path = findTilePath(
      state.map,
      { x: 8, y: 7 },
      { x: 16, y: 7 },
      "bus",
    );

    expect(path).not.toBeNull();
    expect(path?.[0]).toEqual({ x: 8, y: 7 });
    expect(path?.[1]).toEqual({ x: 8, y: 8 });
    expect(path?.at(-1)).toEqual({ x: 16, y: 7 });
    // Path goes from (8,7) via the road network to (16,7). The y=8 road is
    // continuous, and the x=15 column also provides road connectivity. Both
    // routes yield valid shortest paths of equal length; either is acceptable.
    expect(path?.length).toEqual(11);
  });

  it("routes metro along track tiles only, including crossings over roads", () => {
    // Track row y=2 from x=5 to x=9 crosses the x=7 road column at (7,2).
    const state = withTrack(createInitialGameState(), trackRow(2, 5, 9));

    const metro = findTilePath(
      state.map,
      { x: 5, y: 2 },
      { x: 9, y: 2 },
      "metro",
    );
    expect(metro).toHaveLength(5);

    // The same tiles are not traversable for buses (except endpoints).
    expect(
      findTilePath(state.map, { x: 5, y: 2 }, { x: 9, y: 2 }, "bus"),
    ).toBeNull();
  });

  it("returns a single-tile path when from equals to", () => {
    const state = createInitialGameState();
    expect(
      findTilePath(state.map, { x: 7, y: 8 }, { x: 7, y: 8 }, "bus"),
    ).toEqual([{ x: 7, y: 8 }]);
  });

  it("returns null for out-of-bounds endpoints", () => {
    const state = createInitialGameState();
    expect(
      findTilePath(state.map, { x: -1, y: 8 }, { x: 7, y: 8 }, "bus"),
    ).toBeNull();
  });

  it("returns null when adjacent endpoints are both non-traversable for buses", () => {
    const state = createInitialGameState();
    // (1,2) and (1,3) are empty tiles with no road connection between them.
    expect(
      findTilePath(state.map, { x: 1, y: 2 }, { x: 1, y: 3 }, "bus"),
    ).toBeNull();
  });

  it("returns null when adjacent endpoints are both non-traversable for metro", () => {
    const state = createInitialGameState();
    // No track on any tile by default; both are non-traversable for metro.
    expect(
      findTilePath(state.map, { x: 1, y: 2 }, { x: 1, y: 3 }, "metro"),
    ).toBeNull();
  });

  it("rejects the degenerate adjacent-empty path and finds the valid road-connected alternative", () => {
    const state = createInitialGameState();
    // (8,7) and (9,7) are both empty and adjacent above the y=8 road row.
    // The degenerate 2-tile path is rejected; BFS finds the road path:
    // (8,7)→(8,8)→(9,8)→(9,7).
    const path = findTilePath(
      state.map,
      { x: 8, y: 7 },
      { x: 9, y: 7 },
      "bus",
    );
    expect(path).not.toBeNull();
    expect(path).toHaveLength(4);
    expect(path?.[0]).toEqual({ x: 8, y: 7 });
    expect(path?.[1]).toEqual({ x: 8, y: 8 }); // road
    expect(path?.[2]).toEqual({ x: 9, y: 8 }); // road
    expect(path?.[3]).toEqual({ x: 9, y: 7 });
  });
});

describe("computeRouteSegments", () => {
  it("returns one segment per consecutive pair plus the closing loop segment", () => {
    const state = createInitialGameState();
    const positions = [
      { x: 7, y: 8 },
      { x: 15, y: 8 },
      { x: 22, y: 8 },
    ];

    const segments = computeRouteSegments(state.map, positions, "bus");

    expect(segments).toHaveLength(3);
    expect(segments[0]).toHaveLength(9); // 7..15 along y=8
    expect(segments[1]).toHaveLength(8); // 15..22
    expect(segments[2]).toHaveLength(16); // 22..7 closing loop
    expect(hasBrokenSegment(segments)).toBe(false);
  });

  it("marks unpathable pairs as empty segments and reports them broken", () => {
    const state = createInitialGameState();
    const positions = [
      { x: 7, y: 8 },
      { x: 2, y: 3 }, // residential island, unreachable by road
    ];

    const segments = computeRouteSegments(state.map, positions, "bus");

    expect(segments).toHaveLength(2);
    expect(segments[0]).toEqual([]);
    expect(segments[1]).toEqual([]);
    expect(hasBrokenSegment(segments)).toBe(true);
  });

  it("returns no segments for fewer than two positions, which is not broken", () => {
    const state = createInitialGameState();
    expect(computeRouteSegments(state.map, [{ x: 7, y: 8 }], "bus")).toEqual(
      [],
    );
    expect(hasBrokenSegment([])).toBe(false);
  });
});
