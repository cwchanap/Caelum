import { describe, expect, it, vi } from "vitest";
import {
  canvasToTile,
  getBoardTransform,
  syncCanvasSize,
  tileSize,
} from "../../src/render/boardTransform";
import { createTestGameState } from "../helpers/gameState";

function mockRect(width: number, height: number) {
  return {
    width,
    height,
    left: 0,
    top: 0,
    right: width,
    bottom: height,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  };
}

describe("board transform", () => {
  it("fits the whole map into the board and centers the letterbox", () => {
    const map = createTestGameState().map;
    const transform = getBoardTransform({ width: 1280, height: 800 }, map);

    // The 18-tile map height binds against the 800px board.
    expect(transform.scale).toBeCloseTo(800 / (map.height * tileSize));
    expect(transform.width).toBeCloseTo(map.width * tileSize * transform.scale);
    expect(transform.height).toBeCloseTo(800);
    expect(transform.offsetX).toBeCloseTo((1280 - transform.width) / 2);
    expect(transform.offsetY).toBe(0);
  });

  it("syncs canvas dimensions to its rendered bounds", () => {
    const canvas = document.createElement("canvas");
    vi.stubGlobal("devicePixelRatio", 2);
    Object.defineProperty(canvas, "getBoundingClientRect", {
      value: () => mockRect(320.4, 200.6),
    });

    expect(syncCanvasSize(canvas)).toBe(true);
    expect(canvas.width).toBe(641);
    expect(canvas.height).toBe(401);
    expect(canvas.style.width).toBe("320px");
    expect(canvas.style.height).toBe("201px");
    expect(syncCanvasSize(canvas)).toBe(false);
    vi.unstubAllGlobals();
  });

  it("maps client coordinates to map tiles", () => {
    const canvas = document.createElement("canvas");
    const map = createTestGameState().map;

    canvas.width = map.width * 32;
    canvas.height = map.height * 32;
    Object.defineProperty(canvas, "getBoundingClientRect", {
      value: () => mockRect(canvas.width, canvas.height),
    });

    expect(canvasToTile(canvas, 16, 16, map)).toEqual({ x: 0, y: 0 });
    expect(canvasToTile(canvas, canvas.width + 1, 16, map)).toBeNull();
  });
});
