import { describe, expect, it, vi } from "vitest";
import { canvasToTile, syncCanvasSize } from "../../src/render/canvas";
import { createInitialGameState } from "../../src/simulation/gameState";

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
    toJSON: () => ({})
  };
}

describe("canvas helpers", () => {
  it("syncs canvas dimensions to its rendered bounds", () => {
    const canvas = document.createElement("canvas");
    vi.stubGlobal("devicePixelRatio", 2);
    Object.defineProperty(canvas, "getBoundingClientRect", {
      value: () => mockRect(320.4, 200.6)
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
    const map = createInitialGameState().map;

    canvas.width = map.width * 32;
    canvas.height = map.height * 32;
    Object.defineProperty(canvas, "getBoundingClientRect", {
      value: () => mockRect(canvas.width, canvas.height)
    });

    expect(canvasToTile(canvas, 16, 16, map)).toEqual({ x: 0, y: 0 });
    expect(canvasToTile(canvas, canvas.width + 1, 16, map)).toBeNull();
  });
});
