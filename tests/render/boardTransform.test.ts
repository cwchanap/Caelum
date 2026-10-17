import { describe, expect, it, vi } from "vitest";
import {
  applyCameraAction,
  canvasToTile,
  getBoardTransform,
  maxZoom,
  panCamera,
  syncCanvasSize,
  tileSize,
  visibleWorldRect,
  zoomCameraAt,
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

  it("maps client coordinates through a zoomed, panned camera", () => {
    const canvas = document.createElement("canvas");
    const map = createTestGameState().map;
    Object.defineProperty(canvas, "getBoundingClientRect", {
      value: () => mockRect(map.width * tileSize, map.height * tileSize),
    });
    // Zoom 2 shows half the map; the view origin sits at tile (10, 4).
    const camera = { zoom: 2, center: { x: 17, y: 8.5 } };

    expect(canvasToTile(canvas, 1, 1, map, camera)).toEqual({ x: 10, y: 4 });
    expect(canvasToTile(canvas, 65, 1, map, camera)).toEqual({ x: 11, y: 4 });
  });
});

describe("camera", () => {
  const map = { width: 84, height: 54 };
  const board = { width: 1280, height: 800 };

  it("a missing camera and zoom 1 are both the fitted view", () => {
    const fitted = getBoardTransform(board, map);
    const zoomOne = getBoardTransform(board, map, {
      zoom: 1,
      center: { x: 3, y: 50 },
    });

    expect(zoomOne).toEqual(fitted);
    // Before the board has a size nothing is culled.
    expect(visibleWorldRect({ width: 0, height: 0 }, map, null)).toEqual({
      minX: 0,
      minY: 0,
      maxX: map.width * tileSize,
      maxY: map.height * tileSize,
    });
    expect(visibleWorldRect(board, map, null)).toEqual({
      minX: 0,
      minY: 0,
      maxX: map.width * tileSize,
      maxY: map.height * tileSize,
    });
  });

  it("zooming keeps the world point under the cursor fixed", () => {
    const anchor = { x: 900, y: 200 };
    const before = getBoardTransform(board, map);
    const worldX = (anchor.x - before.offsetX) / before.scale;
    const worldY = (anchor.y - before.offsetY) / before.scale;

    const camera = zoomCameraAt(board, map, null, 3, anchor);
    const after = getBoardTransform(board, map, camera);

    expect(camera?.zoom).toBeCloseTo(3);
    expect(after.offsetX + worldX * after.scale).toBeCloseTo(anchor.x);
    expect(after.offsetY + worldY * after.scale).toBeCloseTo(anchor.y);
  });

  it("clamps zoom and keeps the view on the map", () => {
    const zoomedFar = zoomCameraAt(board, map, null, 1000, { x: 0, y: 0 })!;
    expect(zoomedFar.zoom).toBe(maxZoom(board, map));

    // Dragging far past the top-left corner stops with the map edge at the
    // board edge.
    const panned = panCamera(board, map, zoomedFar, 1e6, 1e6);
    const transform = getBoardTransform(board, map, panned);
    expect(transform.offsetX).toBeCloseTo(0);
    expect(transform.offsetY).toBeCloseTo(0);

    // Zooming out past the whole map is the fitted view again.
    expect(zoomCameraAt(board, map, zoomedFar, 1e-6, { x: 0, y: 0 })).toBe(
      null,
    );
    expect(panCamera(board, map, null, 50, 50)).toBe(null);
    expect(applyCameraAction(board, map, zoomedFar, { kind: "fit" })).toBe(
      null,
    );
  });
});
