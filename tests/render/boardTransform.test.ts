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
  rebaseCameraForResize,
  syncCanvasSize,
  tileSize,
  visibleWorldRect,
  ZOOM_STEP,
  zoomCameraAt,
  type Camera,
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

describe("passive dock resize", () => {
  const map = { width: 84, height: 54 };
  const full = { width: 1280, height: 800 };
  const docked = { width: 800, height: 800 };

  /** Rendered CSS scale and offsets a board+camera pair draws with. */
  function rendered(
    board: { width: number; height: number },
    camera: Camera | null,
  ) {
    const t = getBoardTransform(board, map, camera);
    return { scale: t.scale, offsetX: t.offsetX, offsetY: t.offsetY };
  }

  function expectSameRender(
    a: ReturnType<typeof rendered>,
    b: ReturnType<typeof rendered>,
  ) {
    expect(a.scale).toBeCloseTo(b.scale, 9);
    expect(a.offsetX).toBeCloseTo(b.offsetX, 6);
    expect(a.offsetY).toBeCloseTo(b.offsetY, 6);
  }

  it("a zoomed view keeps its rendered scale and offsets across dock open and close", () => {
    const zoomed = zoomCameraAt(full, map, null, 3, { x: 900, y: 300 });
    expect(zoomed).not.toBeNull();
    const before = rendered(full, zoomed);

    // A zoomed in-bounds view stays in bounds on the narrower board — the
    // safe viewport keeps pointing inside the map — so the rebase comes
    // back as an ordinary camera, not a retained one.
    const opened = rebaseCameraForResize(full, docked, map, zoomed);
    expect(opened?.retained).toBeFalsy();
    expectSameRender(rendered(docked, opened), before);

    // The exact round trip lands back on the pre-dock camera, which the
    // ordinary clamp already satisfies — it comes back without `retained`,
    // so later zooms apply the normal limits instead of parking blank
    // margins around the map.
    const closed = rebaseCameraForResize(docked, full, map, opened);
    expect(closed?.retained).toBeFalsy();
    expectSameRender(rendered(full, closed), before);
  });

  it("a default Fit dock round trip keeps visible map points and coalesces back to Fit", () => {
    const opened = rebaseCameraForResize(full, docked, map, null);
    expect(opened).not.toBeNull();
    expect(opened?.retained).toBe(true);

    // A map point that was visible before the dock opened keeps its exact
    // rendered position (scale and offsets are preserved).
    const world = { x: 12 * tileSize, y: 14 * tileSize };
    const before = getBoardTransform(full, map, null);
    const after = getBoardTransform(docked, map, opened);
    expect(after.offsetX + world.x * after.scale).toBeCloseTo(
      before.offsetX + world.x * before.scale,
      6,
    );
    expect(after.offsetY + world.y * after.scale).toBeCloseTo(
      before.offsetY + world.y * before.scale,
      6,
    );

    // Closing restores the canonical Fit exactly, so the camera clears.
    expect(rebaseCameraForResize(docked, full, map, opened)).toBeNull();
    expect(rebaseCameraForResize(full, full, map, null)).toBeNull();
  });

  it("closing the dock after a docked Fit keeps the smaller scale and margins", () => {
    const dockedFit = rendered(docked, null);
    const closed = rebaseCameraForResize(docked, full, map, null);
    expect(closed?.retained).toBe(true);
    expect(closed!.zoom).toBeLessThan(1);

    // The map renders smaller than the full-board fit, un-clamped, exactly
    // where the docked stage drew it.
    const after = rendered(full, closed);
    expectSameRender(after, dockedFit);
    expect(after.scale).toBeLessThan(fitScale(full, map));
  });

  it("a retained sub-fit view ignores pan and Zoom Out and anchors Zoom In without a jump", () => {
    const retained = rebaseCameraForResize(docked, full, map, null)!;
    expect(retained.zoom).toBeLessThan(1);

    expect(panCamera(full, map, retained, 50, 50)).toBe(retained);
    expect(
      applyCameraAction(full, map, retained, { kind: "pan", x: 1, y: 0 }),
    ).toBe(retained);
    expect(
      zoomCameraAt(full, map, retained, 1 / ZOOM_STEP, { x: 100, y: 200 }),
    ).toBe(retained);
    expect(applyCameraAction(full, map, retained, { kind: "zoomOut" })).toBe(
      retained,
    );

    // A tiny wheel zoom-in keeps the world point under the cursor fixed and
    // stays retained below fit.
    const anchor = { x: 300, y: 300 };
    const before = getBoardTransform(full, map, retained);
    const worldUnder = {
      x: (anchor.x - before.offsetX) / before.scale,
      y: (anchor.y - before.offsetY) / before.scale,
    };
    const wheeled = zoomCameraAt(full, map, retained, 1.01, anchor);
    expect(wheeled?.retained).toBe(true);
    const wheeledRender = getBoardTransform(full, map, wheeled);
    expect(
      wheeledRender.offsetX + worldUnder.x * wheeledRender.scale,
    ).toBeCloseTo(anchor.x, 6);
    expect(
      wheeledRender.offsetY + worldUnder.y * wheeledRender.scale,
    ).toBeCloseTo(anchor.y, 6);
  });

  it("small Zoom In steps stay retained below fit without jumping", () => {
    // A much narrower dock leaves the closed view far below fit.
    const narrow = { width: 600, height: 800 };
    const start = rebaseCameraForResize(narrow, full, map, null)!;
    expect(start.zoom).toBeLessThan(0.8);

    // Each small step stays passive below fit and keeps the world point
    // under the safe midpoint fixed.
    const anchor = { x: 640, y: 392 };
    const before = getBoardTransform(full, map, start);
    const worldUnder = {
      x: (anchor.x - before.offsetX) / before.scale,
      y: (anchor.y - before.offsetY) / before.scale,
    };
    let camera: Camera | null = start;
    for (let step = 0; step < 2; step += 1) {
      camera = zoomCameraAt(full, map, camera, ZOOM_STEP, anchor);
      expect(camera?.retained).toBe(true);
      expect(camera!.zoom).toBeLessThan(1);
      const t = getBoardTransform(full, map, camera);
      expect(t.offsetX + worldUnder.x * t.scale).toBeCloseTo(anchor.x, 6);
      expect(t.offsetY + worldUnder.y * t.scale).toBeCloseTo(anchor.y, 6);
    }
  });

  it("a retained view landing on exactly Fit zoom stays put unless it is the canonical Fit", () => {
    // A passive sub-fit view with noncanonical (letterboxed) offsets along the
    // horizontally letterboxed axis: one ×1.25 step lands zoom on exactly 1,
    // and the anchored view must not snap to the canonical Fit transform.
    const retained = {
      zoom: 0.8,
      center: { x: map.width / 2 + 0.3, y: map.height / 2 },
      retained: true,
    };
    const anchor = { x: 640, y: 392 };
    const before = getBoardTransform(full, map, retained);
    const worldUnder = {
      x: (anchor.x - before.offsetX) / before.scale,
      y: (anchor.y - before.offsetY) / before.scale,
    };

    const landed = zoomCameraAt(full, map, retained, ZOOM_STEP, anchor);
    expect(landed!.zoom).toBe(1);
    expect(landed?.retained).toBe(true);
    // The world point under the anchor never moves (no Fit snap).
    const after = getBoardTransform(full, map, landed);
    expect(after.offsetX + worldUnder.x * after.scale).toBeCloseTo(anchor.x, 6);
    expect(after.offsetY + worldUnder.y * after.scale).toBeCloseTo(anchor.y, 6);
    // Subsequent interactions: sub-fit rules still apply while contained and
    // retained — pan and Zoom Out are no-ops, and zooming past the letterbox
    // margin resumes ordinary clamped navigation.
    expect(panCamera(full, map, landed, 50, 50)).toBe(landed);
    expect(zoomCameraAt(full, map, landed, 1 / ZOOM_STEP, anchor)).toBe(landed);
    const nextStep = zoomCameraAt(full, map, landed, 1.5, anchor);
    expect(nextStep?.retained).toBeFalsy();
    expect(nextStep!.zoom).toBeGreaterThan(1);

    // A retained view whose complete transform already is the canonical Fit
    // still coalesces back to `null` at zoom 1.
    const canonicalCenter = {
      zoom: 0.8,
      center: { x: map.width / 2, y: map.height / 2 },
      retained: true,
    };
    const middle = {
      x: full.width / 2,
      y: (HUD_INSET.top + full.height - HUD_INSET.bottom) / 2,
    };
    const fitted = zoomCameraAt(full, map, canonicalCenter, ZOOM_STEP, middle);
    expect(fitted).toBeNull();
  });

  it("zooming in from a passive view never snaps and resumes ordinary navigation", () => {
    const letterboxed = rebaseCameraForResize(full, docked, map, null)!;
    const anchor = { x: 400, y: 392 };
    const before = getBoardTransform(docked, map, letterboxed);
    const worldUnder = {
      x: (anchor.x - before.offsetX) / before.scale,
      y: (anchor.y - before.offsetY) / before.scale,
    };

    let camera: Camera | null = letterboxed;
    for (let step = 0; step < 6; step += 1) {
      camera = zoomCameraAt(docked, map, camera, ZOOM_STEP, anchor);
      // The drawn point under the anchor never jumps, passive or not.
      const t = getBoardTransform(docked, map, camera);
      expect(t.offsetX + worldUnder.x * t.scale).toBeCloseTo(anchor.x, 6);
      expect(t.offsetY + worldUnder.y * t.scale).toBeCloseTo(anchor.y, 6);
      if (camera?.retained !== true) break;
    }
    // Once zoomed past fit with the view inside the ordinary clamp range,
    // the passive flag hands control back to clamped navigation.
    expect(camera?.retained).toBeFalsy();
    expect(camera!.zoom).toBeGreaterThan(1);
  });

  it("a retained zoomed pan stays bounded and resumes ordinary clamped navigation", () => {
    // A docked Fit leaves a passive above-fit view with a cropped edge; an
    // endless drag must stop at the ordinary map boundary instead of pushing
    // the whole map off the board.
    const opened = rebaseCameraForResize(full, docked, map, null)!;
    expect(opened.retained).toBe(true);
    const dragged = panCamera(docked, map, opened, -1e6, -1e6)!;
    expect(dragged).toEqual(clampCamera(docked, map, dragged));
    const drawn = getBoardTransform(docked, map, dragged);
    expect(drawn.offsetX).toBeLessThan(docked.width);
    expect(drawn.offsetX + drawn.width).toBeGreaterThan(0);
    expect(drawn.offsetY).toBeLessThan(docked.height);
    expect(drawn.offsetY + drawn.height).toBeGreaterThan(0);

    // Closing the dock on a corner-anchored zoom can park a passive center
    // outside the ordinary range. Panning further out is blocked at the
    // passive placement; panning back re-enters ordinary clamped navigation.
    const corner = zoomCameraAt(docked, map, null, 3, { x: 650, y: 392 })!;
    const offRange = rebaseCameraForResize(docked, full, map, corner)!;
    expect(offRange.retained).toBe(true);
    const ordinary = clampCamera(full, map, offRange);
    expect(ordinary.zoom).toBeCloseTo(offRange.zoom, 9);
    expect(ordinary.center).not.toEqual(offRange.center);

    const outward = panCamera(full, map, offRange, -400, 0)!;
    expect(outward.center.x).toBe(offRange.center.x);
    expect(outward.retained).toBe(true);

    const backIn = panCamera(full, map, offRange, 1e6, 0)!;
    expect(backIn.retained).toBeFalsy();
    expect(backIn).toEqual(clampCamera(full, map, backIn));
  });

  it("Zoom Out on a retained view with a cropped edge shrinks below fit until the whole map is inside", () => {
    // The dock-toggle trap: a Fit view rebased onto the narrower docked
    // board parks the camera with the map's right edge cropped offscreen.
    // Zoom Out must not stop at zoom 1 — it crosses below fit until every
    // edge is inside the safe viewport.
    const opened = rebaseCameraForResize(full, docked, map, null)!;
    expect(opened.retained).toBe(true);
    const parked = getBoardTransform(docked, map, opened);
    expect(parked.offsetX + parked.width).toBeGreaterThan(docked.width);

    let camera: Camera | null = opened;
    const safe = safeViewport(docked);
    for (let step = 0; step < 12; step += 1) {
      const next = applyCameraAction(docked, map, camera, {
        kind: "zoomOut",
      });
      if (next === camera) break;
      camera = next;
    }
    const t = getBoardTransform(docked, map, camera);
    expect(t.offsetX).toBeGreaterThanOrEqual(safe.x - 1e-6);
    expect(t.offsetX + t.width).toBeLessThanOrEqual(safe.x + safe.width + 1e-6);
    expect(t.offsetY).toBeGreaterThanOrEqual(safe.y - 1e-6);
    expect(t.offsetY + t.height).toBeLessThanOrEqual(
      safe.y + safe.height + 1e-6,
    );
    // Once the whole map is inside, Zoom Out becomes a no-op again.
    expect(applyCameraAction(docked, map, camera, { kind: "zoomOut" })).toBe(
      camera,
    );
  });

  it("wheel Zoom Out anchored in an exposed HUD inset cannot collapse the map into the HUD", () => {
    // Same docked crop as above, but the wheel pointer sits on exposed
    // canvas above the 72px safe top: anchoring the shrink there would
    // converge the map onto a point it can never bring inside the safe
    // viewport. The anchor must fall back to the safe edge so the shrink
    // still lands the whole map inside and then stops.
    const opened = rebaseCameraForResize(full, docked, map, null)!;
    expect(opened.retained).toBe(true);

    let camera: Camera | null = opened;
    const safe = safeViewport(docked);
    const anchor = { x: 10, y: 10 };
    for (let step = 0; step < 100; step += 1) {
      const next = zoomCameraAt(docked, map, camera, 1 / ZOOM_STEP, anchor);
      if (next === camera) break;
      camera = next;
    }

    const t = getBoardTransform(docked, map, camera);
    expect(t.offsetX).toBeGreaterThanOrEqual(safe.x - 1e-6);
    expect(t.offsetX + t.width).toBeLessThanOrEqual(safe.x + safe.width + 1e-6);
    expect(t.offsetY).toBeGreaterThanOrEqual(safe.y - 1e-6);
    expect(t.offsetY + t.height).toBeLessThanOrEqual(
      safe.y + safe.height + 1e-6,
    );
    expect(zoomCameraAt(docked, map, camera, 1 / ZOOM_STEP, anchor)).toBe(
      camera,
    );
  });

  it("wheel Zoom Out anchored in an exposed HUD inset lands a top-cropped map inside", () => {
    // The fixture above starts with the map's top already at the safe edge.
    // With the top cropped offscreen instead, the shrink anchors at the
    // clamped safe edge (anchor.y = 10 lands on safe.y) and the cropped
    // edge approaches it without crossing — still converging until every
    // edge is inside.
    let camera: Camera | null = {
      zoom: 1.4,
      center: { x: 42, y: 33 },
      retained: true,
    };
    const safe = safeViewport(docked);
    const parked = getBoardTransform(docked, map, camera);
    expect(parked.offsetY).toBeLessThan(safe.y);
    expect(parked.offsetX).toBeLessThan(safe.x);

    const anchor = { x: 10, y: 10 };
    for (let step = 0; step < 100; step += 1) {
      const next = zoomCameraAt(docked, map, camera, 1 / ZOOM_STEP, anchor);
      if (next === camera) break;
      camera = next;
    }

    const t = getBoardTransform(docked, map, camera);
    expect(t.offsetX).toBeGreaterThanOrEqual(safe.x - 1e-6);
    expect(t.offsetX + t.width).toBeLessThanOrEqual(safe.x + safe.width + 1e-6);
    expect(t.offsetY).toBeGreaterThanOrEqual(safe.y - 1e-6);
    expect(t.offsetY + t.height).toBeLessThanOrEqual(
      safe.y + safe.height + 1e-6,
    );
    expect(zoomCameraAt(docked, map, camera, 1 / ZOOM_STEP, anchor)).toBe(
      camera,
    );
  });

  it("a tiny wheel Zoom Out on a letterboxed retained view never snaps larger", () => {
    const letterboxed = rebaseCameraForResize(full, docked, map, null)!;
    expect(letterboxed.zoom).toBeGreaterThan(1);

    const anchor = { x: 400, y: 392 };
    const before = getBoardTransform(docked, map, letterboxed);
    const worldUnder = {
      x: (anchor.x - before.offsetX) / before.scale,
      y: (anchor.y - before.offsetY) / before.scale,
    };
    const wheeled = zoomCameraAt(docked, map, letterboxed, 0.99, anchor);
    // Not snapped up toward Fit, and the drawn point stays under the cursor.
    expect(wheeled!.zoom).toBeCloseTo(letterboxed.zoom * 0.99, 9);
    const after = getBoardTransform(docked, map, wheeled);
    expect(after.offsetX + worldUnder.x * after.scale).toBeCloseTo(anchor.x, 6);
    expect(after.offsetY + worldUnder.y * after.scale).toBeCloseTo(anchor.y, 6);
  });

  it("wheel-zooming over the blank margin after docked Fit cannot push the map offstage", () => {
    const stage = { width: 1024, height: 768 };
    const dockedStage = { width: 664, height: 768 };
    // Start at Fit with the dock open, then close the dock to expose a blank
    // margin at x = 664..1024.
    let camera: Camera | null = rebaseCameraForResize(
      dockedStage,
      stage,
      map,
      null,
    );
    expect(camera?.retained).toBe(true);

    // Repeatedly wheel-zoom in with the cursor in the blank margin (x = 970).
    for (let step = 0; step < 20; step += 1) {
      camera = zoomCameraAt(stage, map, camera, ZOOM_STEP, {
        x: 970,
        y: 384,
      });
    }

    const drawn = getBoardTransform(stage, map, camera);
    expect(drawn.offsetX).toBeLessThan(stage.width);
    expect(drawn.offsetX + drawn.width).toBeGreaterThan(0);
    expect(drawn.offsetY).toBeLessThan(stage.height);
    expect(drawn.offsetY + drawn.height).toBeGreaterThan(0);
    // At least a quarter-stage strip of the map stays visible onstage.
    expect(drawn.offsetX + drawn.width).toBeGreaterThanOrEqual(
      stage.width * 0.25 - 1e-6,
    );
  });

  it("allows panning back into view when a sub-fit retained camera still has a cropped edge", () => {
    const smallBoard = { width: 600, height: 500 };
    const largeBoard = { width: 1600, height: 1000 };
    const zoomed = zoomCameraAt(smallBoard, map, null, 2, { x: 300, y: 250 })!;
    const pannedToRightEdge = panCamera(smallBoard, map, zoomed, -1e6, 0)!;
    const resized = rebaseCameraForResize(
      smallBoard,
      largeBoard,
      map,
      pannedToRightEdge,
    )!;
    expect(resized.retained).toBe(true);
    expect(resized.zoom).toBeLessThan(1);

    const before = getBoardTransform(largeBoard, map, resized);
    expect(before.offsetX).toBeLessThan(0);

    // Dragging/panning further left cannot push the cropped left edge further offscreen.
    const outward = panCamera(largeBoard, map, resized, -100, 0)!;
    expect(outward.center.x).toBe(resized.center.x);

    // Dragging/keyboard-panning right recovers the cropped left side without snapping zoom.
    const stepped = applyCameraAction(largeBoard, map, resized, {
      kind: "pan",
      x: -1,
      y: 0,
    })!;
    expect(stepped.zoom).toBeCloseTo(resized.zoom, 9);
    const afterStep = getBoardTransform(largeBoard, map, stepped);
    expect(afterStep.offsetX).toBeGreaterThan(before.offsetX);

    const fullyRecovered = panCamera(largeBoard, map, stepped, 1e6, 0)!;
    expect(fullyRecovered.zoom).toBeCloseTo(resized.zoom, 9);
    const afterFull = getBoardTransform(largeBoard, map, fullyRecovered);
    expect(afterFull.offsetX).toBeGreaterThanOrEqual(0);
    expect(afterFull.offsetX + afterFull.width).toBeLessThanOrEqual(
      largeBoard.width,
    );
  });
});
