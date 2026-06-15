import { describe, expect, it, vi } from "vitest";
import { renderMap } from "../../src/render/mapRenderer";
import { createInitialGameState } from "../../src/simulation/gameState";
import type { GameState, Point } from "../../src/domain/types";

// jsdom does not implement HTMLCanvasElement.getContext without the optional
// `canvas` package, so the render tests use a method stub. The tests only
// assert specific calls, which a stub satisfies as long as every method the
// renderer calls exists on it.
function ctx(): CanvasRenderingContext2D {
  return {
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    arc: vi.fn(),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    setLineDash: vi.fn(),
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    lineCap: "butt",
    lineJoin: "miter",
  } as unknown as CanvasRenderingContext2D;
}

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

function withOneWay(
  state: GameState,
  point: Point,
  oneWay: "north" | "east" | "south" | "west",
): GameState {
  return {
    ...state,
    map: {
      ...state.map,
      tiles: state.map.tiles.map((tile) =>
        tile.x === point.x && tile.y === point.y ? { ...tile, oneWay } : tile,
      ),
    },
  };
}

describe("renderMap track layer", () => {
  it("draws spokes between adjacent track tiles and a dot for an isolated tile", () => {
    // (2,2) and (3,2) are adjacent (connected); (10,10) has no track neighbors.
    const state = withTrack(createInitialGameState(), [
      { x: 2, y: 2 },
      { x: 3, y: 2 },
      { x: 10, y: 10 },
    ]);

    const context = ctx();
    renderMap(context, state);

    // tileSize=32: center of (x,y) = (32x+16, 32y+16).
    // (2,2) center = (80, 80); neighbor (3,2) is at offset (1,0), so the
    // spoke runs from the center halfway to the neighbor: (80+16, 80) = (96, 80).
    expect(context.moveTo).toHaveBeenCalledWith(80, 80);
    expect(context.lineTo).toHaveBeenCalledWith(96, 80);

    // (3,2) center = (112, 80); neighbor (2,2) is at offset (-1,0), so the
    // spoke runs to (112-16, 80) = (96, 80).
    expect(context.moveTo).toHaveBeenCalledWith(112, 80);
    expect(context.lineTo).toHaveBeenCalledWith(96, 80);

    // (10,10) has no track neighbors: drawn as a lone dot at its center
    // (10*32+16, 10*32+16) = (336, 336) with radius 4.
    expect(context.arc).toHaveBeenCalledWith(336, 336, 4, 0, Math.PI * 2);
  });
});

describe("renderMap one-way arrows", () => {
  it("draws a direction arrow shaft for a one-way road tile", () => {
    // (8,8) is a road tile; make it one-way east.
    const state = withOneWay(createInitialGameState(), { x: 8, y: 8 }, "east");

    const context = ctx();
    renderMap(context, state);

    // tileSize=32: center (8,8) = (272, 272). The shaft runs from tail to tip
    // along the arrow axis by tileSize/4 = 8 either side of center.
    expect(context.moveTo).toHaveBeenCalledWith(264, 272); // tail (west of center)
    expect(context.lineTo).toHaveBeenCalledWith(280, 272); // tip (east of center)
  });
});
