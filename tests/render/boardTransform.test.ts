import { describe, expect, it, vi } from "vitest";
import {
  applyCameraAction,
  canvasToTile,
  clampCamera,
  fitScale,
  getBoardTransform,
  HUD_INSET,
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

function safeViewport(board: { width: number; height: number }) {
  return {
    x: 0,
    y: HUD_INSET.top,
    width: board.width,
    height: board.height - HUD_INSET.top - HUD_INSET.bottom,
  };
}

describe("board transform", () => {
  it("fits the whole map into the safe viewport between the HUD bands", () => {
    const map = createTestGameState().map;
    const board = { width: 1280, height: 800 };
    const transform = getBoardTransform(board, map);
    const safe = safeViewport(board);

    // The 18-tile map height binds against the safe viewport, not the board.
    expect(transform.scale).toBeCloseTo(safe.height / (map.height * tileSize));
    expect(transform.width).toBeCloseTo(map.width * tileSize * transform.scale);
    expect(transform.height).toBeCloseTo(safe.height);
    expect(transform.offsetY).toBeCloseTo(safe.y);
    expect(transform.offsetX).toBeCloseTo(
      safe.x + (safe.width - transform.width) / 2,
    );
    expect(transform.offsetY + transform.height).toBeCloseTo(
      safe.y + safe.height,
    );
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
    canvas.height = map.height * 32 + HUD_INSET.top + HUD_INSET.bottom;
    Object.defineProperty(canvas, "getBoundingClientRect", {
      value: () => mockRect(canvas.width, canvas.height),
    });

    expect(canvasToTile(canvas, 16, HUD_INSET.top + 16, map)).toEqual({
      x: 0,
      y: 0,
    });
    expect(canvasToTile(canvas, canvas.width + 1, 16, map)).toBeNull();
  });

  it("maps client coordinates through a zoomed, panned camera", () => {
    const canvas = document.createElement("canvas");
    const map = createTestGameState().map;
    Object.defineProperty(canvas, "getBoundingClientRect", {
      value: () =>
        mockRect(
          map.width * tileSize,
          map.height * tileSize + HUD_INSET.top + HUD_INSET.bottom,
        ),
    });
    // Zoom 2 shows half the map; the view origin sits at tile (10, 4).
    const camera = { zoom: 2, center: { x: 17, y: 8.5 } };

    expect(canvasToTile(canvas, 1, HUD_INSET.top + 1, map, camera)).toEqual({
      x: 10,
      y: 4,
    });
    expect(canvasToTile(canvas, 65, HUD_INSET.top + 1, map, camera)).toEqual({
      x: 11,
      y: 4,
    });
  });

  it("rejects captured-pointer coordinates past the canvas edge", () => {
    const canvas = document.createElement("canvas");
    const map = createTestGameState().map;
    const boardHeight =
      map.height * tileSize + HUD_INSET.top + HUD_INSET.bottom;
    Object.defineProperty(canvas, "getBoundingClientRect", {
      value: () => mockRect(map.width * tileSize, boardHeight),
    });
    const camera = { zoom: 2, center: { x: 17, y: 8.5 } };

    // Zoomed in, the map overflows the board: a pointer past the edge still
    // resolves to a real in-map tile, but nothing is visible out there.
    expect(
      canvasToTile(canvas, map.width * tileSize + 1, 1, map, camera),
    ).toBeNull();
    expect(canvasToTile(canvas, -1, 1, map, camera)).toBeNull();
    expect(canvasToTile(canvas, 1, boardHeight + 4, map, camera)).toBeNull();
    expect(canvasToTile(canvas, 1, -4, map, camera)).toBeNull();
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
    // safe-viewport edge.
    const panned = panCamera(board, map, zoomedFar, 1e6, 1e6);
    const transform = getBoardTransform(board, map, panned);
    expect(transform.offsetX).toBeCloseTo(0);
    expect(transform.offsetY).toBeCloseTo(HUD_INSET.top);

    // Zooming out past the whole map is the fitted view again.
    expect(zoomCameraAt(board, map, zoomedFar, 1e-6, { x: 0, y: 0 })).toBe(
      null,
    );
    expect(panCamera(board, map, null, 50, 50)).toBe(null);
    expect(applyCameraAction(board, map, zoomedFar, { kind: "fit" })).toBe(
      null,
    );
  });

  it("keeps every map edge reachable inside the safe viewport at maximum zoom", () => {
    const zoomed = zoomCameraAt(board, map, null, 1000, {
      x: board.width / 2,
      y: board.height / 2,
    })!;
    expect(zoomed.zoom).toBe(maxZoom(board, map));
    const safe = safeViewport(board);

    const bottomRight = panCamera(board, map, zoomed, -1e6, -1e6);
    const afterBottomRight = getBoardTransform(board, map, bottomRight);
    expect(afterBottomRight.offsetX + afterBottomRight.width).toBeCloseTo(
      safe.x + safe.width,
    );
    expect(afterBottomRight.offsetY + afterBottomRight.height).toBeCloseTo(
      safe.y + safe.height,
    );

    const topLeft = panCamera(board, map, zoomed, 1e6, 1e6);
    const afterTopLeft = getBoardTransform(board, map, topLeft);
    expect(afterTopLeft.offsetX).toBeCloseTo(safe.x);
    expect(afterTopLeft.offsetY).toBeCloseTo(safe.y);
  });

  it("stays finite and no-ops when the HUD bands consume the whole board", () => {
    const board = {
      width: 1280,
      height: HUD_INSET.top + HUD_INSET.bottom,
    };
    const camera = { zoom: 2, center: { x: 40, y: 30 } };

    expect(fitScale(board, map)).toBe(0);
    expect(Number.isFinite(maxZoom(board, map))).toBe(true);
    expect(clampCamera(board, map, camera)).toEqual(camera);
    expect(zoomCameraAt(board, map, camera, 2, { x: 0, y: 0 })).toEqual(camera);
    expect(panCamera(board, map, camera, 40, 40)).toEqual(camera);
    expect(applyCameraAction(board, map, camera, { kind: "zoomIn" })).toEqual(
      camera,
    );
    expect(
      applyCameraAction(board, map, camera, { kind: "pan", x: 1, y: 0 }),
    ).toEqual(camera);

    for (const candidate of [camera, null]) {
      const transform = getBoardTransform(board, map, candidate);
      expect(transform.scale).toBe(0);
      expect(Number.isFinite(transform.offsetX)).toBe(true);
      expect(Number.isFinite(transform.offsetY)).toBe(true);
    }
  });

  it("centers the focused tile's marker while preserving the active zoom", () => {
    const camera = applyCameraAction(
      board,
      map,
      { zoom: 3, center: { x: 40, y: 30 } },
      { kind: "centerOn", point: { x: 30, y: 20 } },
    );

    expect(camera).toEqual({ zoom: 3, center: { x: 30.5, y: 20.5 } });
    const transform = getBoardTransform(board, map, camera);
    const safe = safeViewport(board);
    expect(transform.offsetX + 30.5 * tileSize * transform.scale).toBeCloseTo(
      safe.x + safe.width / 2,
    );
    expect(transform.offsetY + 20.5 * tileSize * transform.scale).toBeCloseTo(
      safe.y + safe.height / 2,
    );
  });

  it("sizes keyboard pan steps from the safe viewport", () => {
    const zoomed = zoomCameraAt(board, map, null, 4, {
      x: board.width / 2,
      y: board.height / 2,
    })!;
    const safe = safeViewport(board);
    expect(
      applyCameraAction(board, map, zoomed, { kind: "pan", x: 0, y: 1 }),
    ).toEqual(panCamera(board, map, zoomed, 0, -safe.height * 0.2));
    expect(
      applyCameraAction(board, map, zoomed, { kind: "pan", x: 1, y: 0 }),
    ).toEqual(panCamera(board, map, zoomed, -safe.width * 0.2, 0));
  });

  it("centers at a bounded 2x zoom from the fitted view", () => {
    const point = { x: 30, y: 20 };
    const camera = applyCameraAction(board, map, null, {
      kind: "centerOn",
      point,
    });

    expect(camera).toEqual({ zoom: 2, center: { x: 30.5, y: 20.5 } });
    expect(
      applyCameraAction(
        board,
        map,
        { zoom: 1, center: { x: 42, y: 27 } },
        { kind: "centerOn", point },
      ),
    ).toEqual({ zoom: 2, center: { x: 30.5, y: 20.5 } });
    expect(
      applyCameraAction({ width: 8064, height: 5360 }, map, null, {
        kind: "centerOn",
        point,
      }),
    ).toBeNull();
  });
});
