import { describe, expect, it, vi } from "vitest";
import { renderMap } from "../../src/render/mapRenderer";
import { createInitialGameState } from "../../src/simulation/gameState";
import type { GameState, Point } from "../../src/domain/types";
import { colors } from "../../src/render/colors";
import { withTracks } from "../helpers/mapFixtures";

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

function recordingFillCtx() {
  let fillStyle = "";
  const fills: Array<{ x: number; y: number; style: string }> = [];
  const context = {
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    arc: vi.fn(),
    fillRect: vi.fn((x: number, y: number) => {
      fills.push({ x, y, style: fillStyle });
    }),
    strokeRect: vi.fn(),
    setLineDash: vi.fn(),
    get fillStyle() {
      return fillStyle;
    },
    set fillStyle(value: string) {
      fillStyle = value;
    },
    strokeStyle: "",
    lineWidth: 0,
    lineCap: "butt",
    lineJoin: "miter",
  } as unknown as CanvasRenderingContext2D;
  return { context, fills };
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
        tile.x === point.x && tile.y === point.y
          ? { ...tile, kind: "road", oneWay }
          : tile,
      ),
    },
  };
}

function withOnlyRoads(state: GameState, points: Point[]): GameState {
  const roadKeys = new Set(points.map((point) => `${point.x},${point.y}`));
  return {
    ...state,
    map: {
      ...state.map,
      tiles: state.map.tiles.map((tile) => {
        const { oneWay: _oneWay, ...rest } = tile;
        return roadKeys.has(`${tile.x},${tile.y}`)
          ? { ...rest, kind: "road" as const, hasTrack: false }
          : { ...rest, kind: "empty" as const, hasTrack: false };
      }),
    },
  };
}

describe("renderMap area layer", () => {
  it("fills empty area tiles with area colors while preserving road tiles", () => {
    const initialState = createInitialGameState();
    const areaTile = initialState.map.tiles.find(
      (tile) => tile.kind === "empty",
    );
    if (areaTile === undefined) {
      throw new Error("expected the scenario to have at least one empty tile");
    }

    const state: GameState = {
      ...initialState,
      map: {
        ...initialState.map,
        tiles: initialState.map.tiles.map((tile) => {
          if (tile.x === areaTile.x && tile.y === areaTile.y) {
            return { ...tile, area: "office" };
          }
          if (tile.x === 7 && tile.y === 8) {
            const { oneWay: _oneWay, ...rest } = tile;
            return { ...rest, kind: "road" as const, area: "office" };
          }
          return tile;
        }),
      },
    };

    const { context, fills } = recordingFillCtx();
    renderMap(context, state);

    expect(fills).toContainEqual({
      x: areaTile.x * 32,
      y: areaTile.y * 32,
      style: colors.areaOffice,
    });
    expect(fills).toContainEqual({
      x: 7 * 32,
      y: 8 * 32,
      style: colors.road,
    });
  });
});

describe("renderMap track layer", () => {
  it("draws spokes between adjacent track tiles and a dot for an isolated tile", () => {
    // (2,2) and (3,2) are adjacent (connected); (10,10) has no track neighbors.
    const state = withTracks(createInitialGameState(), [
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
    const state = withOneWay(createInitialGameState(), { x: 8, y: 8 }, "east");

    const context = ctx();
    renderMap(context, state);

    // tileSize=32: center (8,8) = (272, 272). The shaft runs from tail to tip
    // along the arrow axis by tileSize/4 = 8 either side of center.
    expect(context.moveTo).toHaveBeenCalledWith(264, 272); // tail (west of center)
    expect(context.lineTo).toHaveBeenCalledWith(280, 272); // tip (east of center)
  });

  it("draws both chevron-head barbs from the tip", () => {
    // The chevron head is the most error-prone perp/sign math: two barbs
    // angled back from the tip along the perpendicular axis. Verify both
    // barbs start at the tip and land symmetrically about the arrow axis.
    const state = withOneWay(createInitialGameState(), { x: 8, y: 8 }, "east");

    const context = ctx();
    renderMap(context, state);

    // tip = (280, 272); head = tileSize/6.
    const head = 32 / 6;
    // Both barbs begin at the tip.
    expect(context.moveTo).toHaveBeenCalledWith(280, 272);
    // Upper barb (perp = (0,-1) for east) and lower barb (perp reflected).
    expect(context.lineTo).toHaveBeenCalledWith(280 - head, 272 - head);
    expect(context.lineTo).toHaveBeenCalledWith(280 - head, 272 + head);
  });

  it("draws no arrow for two-way road tiles", () => {
    const state = withOnlyRoads(createInitialGameState(), [{ x: 8, y: 8 }]);

    const context = ctx();
    renderMap(context, state);

    expect(context.moveTo).not.toHaveBeenCalled();
    expect(context.lineTo).not.toHaveBeenCalled();
  });
});
