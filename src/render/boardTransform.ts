import type { GameMap, Point } from "../domain/types";

export const tileSize = 32;

export interface BoardTransform {
  scale: number;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
}

/** World-pixel center of a map tile. */
export function tileCenter(point: Point): Point {
  return {
    x: point.x * tileSize + tileSize / 2,
    y: point.y * tileSize + tileSize / 2,
  };
}

interface BoardSize {
  width: number;
  height: number;
}

type MapSize = Pick<GameMap, "width" | "height">;

/**
 * Local map view: never persisted and never sent to Rust. `zoom` multiplies
 * the fit-to-safe-viewport scale (1 shows the whole map); `center` is the
 * world point, in tiles, drawn at the middle of the safe viewport. `null`
 * everywhere means "fit". `retained` marks a passive layout result (dock or
 * window resize) that the ordinary clamp would move: the rendered pixels are
 * authoritative, so clamping is bypassed until navigation or an explicit Fit
 * takes over.
 */
export interface Camera {
  zoom: number;
  center: { x: number; y: number };
  retained?: boolean;
}

/** A camera change requested from outside the board (buttons, keys). `pan`
 *  moves by `x`/`y` steps of `PAN_STEP_FRACTION` of the safe viewport. */
export type CameraAction =
  | { kind: "zoomIn" }
  | { kind: "zoomOut" }
  | { kind: "fit" }
  | { kind: "pan"; x: number; y: number }
  | { kind: "centerOn"; point: Point };

/** Largest on-screen tile, in CSS px, the camera may zoom to. */
const MAX_TILE_CSS_PX = 96;
/** Zoom multiplier per button press or key press. */
export const ZOOM_STEP = 1.25;
const PAN_STEP_FRACTION = 0.2;

export const HUD_INSET = { top: 72, bottom: 88 } as const;

interface SafeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function safeRect(board: BoardSize): SafeRect {
  return {
    x: 0,
    y: HUD_INSET.top,
    width: board.width,
    height: Math.max(0, board.height - HUD_INSET.top - HUD_INSET.bottom),
  };
}

interface CanvasSizeTarget {
  width: number;
  height: number;
  style?: { width: string; height: string };
  getBoundingClientRect: () => Pick<DOMRectReadOnly, "width" | "height">;
}

/**
 * World px → board CSS px. With no camera the whole map is fitted and
 * centered inside the safe viewport; a camera zooms and pans that fit
 * (clamped so the view stays on the map). Every consumer — GPU host, pointer
 * mapping, DOM text overlay — uses this one function so they agree on where
 * a tile is.
 */
export function getBoardTransform(
  board: BoardSize,
  map: MapSize,
  camera: Camera | null = null,
): BoardTransform {
  const view = resolvedCamera(board, map, camera);
  const scale = fitScale(board, map) * view.zoom;
  const width = map.width * tileSize * scale;
  const height = map.height * tileSize * scale;
  const safe = safeRect(board);

  return {
    scale,
    offsetX: safe.x + safe.width / 2 - view.center.x * tileSize * scale,
    offsetY: safe.y + safe.height / 2 - view.center.y * tileSize * scale,
    width,
    height,
  };
}

/** World-pixel rectangle visible on the board (for vehicle culling). */
export function visibleWorldRect(
  board: BoardSize,
  map: MapSize,
  camera: Camera | null,
): { minX: number; minY: number; maxX: number; maxY: number } {
  const transform = getBoardTransform(board, map, camera);
  if (!(transform.scale > 0)) {
    return {
      minX: 0,
      minY: 0,
      maxX: map.width * tileSize,
      maxY: map.height * tileSize,
    };
  }
  return {
    minX: Math.max(0, -transform.offsetX / transform.scale),
    minY: Math.max(0, -transform.offsetY / transform.scale),
    maxX: Math.min(
      map.width * tileSize,
      (board.width - transform.offsetX) / transform.scale,
    ),
    maxY: Math.min(
      map.height * tileSize,
      (board.height - transform.offsetY) / transform.scale,
    ),
  };
}

export function fitScale(board: BoardSize, map: MapSize): number {
  const safe = safeRect(board);
  if (!(safe.width > 0 && safe.height > 0)) {
    return 0;
  }
  return Math.min(
    safe.width / (map.width * tileSize),
    safe.height / (map.height * tileSize),
  );
}

export function maxZoom(board: BoardSize, map: MapSize): number {
  const fit = fitScale(board, map);
  if (!(fit > 0)) {
    return 1;
  }
  return Math.max(1, MAX_TILE_CSS_PX / (tileSize * fit));
}

/**
 * Clamp zoom to [1, maxZoom] and keep the safe viewport inside the map. On an
 * axis where the whole map already fits inside the safe viewport, the map
 * stays centered there, so a zoom of 1 is exactly the fit view.
 */
export function clampCamera(
  board: BoardSize,
  map: MapSize,
  camera: Camera,
): Camera {
  const safe = safeRect(board);
  if (!(safe.width > 0 && safe.height > 0)) {
    return camera;
  }
  const zoom = Math.min(Math.max(camera.zoom, 1), maxZoom(board, map));
  const tilePx = fitScale(board, map) * zoom * tileSize;
  if (!(tilePx > 0)) {
    return camera;
  }
  const clampAxis = (center: number, safePx: number, mapTiles: number) => {
    const half = safePx / (2 * tilePx);
    if (2 * half >= mapTiles) {
      return mapTiles / 2;
    }
    return Math.min(Math.max(center, half), mapTiles - half);
  };
  return {
    zoom,
    center: {
      x: clampAxis(camera.center.x, safe.width, map.width),
      y: clampAxis(camera.center.y, safe.height, map.height),
    },
  };
}

/**
 * Whether the view draws the whole map inside the safe viewport. For a
 * retained view this is the test that decides whether panning or Zoom Out is
 * a real no-op — zoom alone cannot prove it, since a passive center can leave
 * an edge cropped offscreen or behind the HUD even at or below fit.
 */
function mapInsideSafe(
  board: BoardSize,
  map: MapSize,
  camera: Camera,
): boolean {
  const tilePx = fitScale(board, map) * camera.zoom * tileSize;
  if (!(tilePx > 0)) {
    return false;
  }
  const safe = safeRect(board);
  const offsetX = safe.x + safe.width / 2 - camera.center.x * tilePx;
  const offsetY = safe.y + safe.height / 2 - camera.center.y * tilePx;
  const eps = 1e-6;
  return (
    offsetX >= safe.x - eps &&
    offsetX + map.width * tilePx <= safe.x + safe.width + eps &&
    offsetY >= safe.y - eps &&
    offsetY + map.height * tilePx <= safe.y + safe.height + eps
  );
}

function resolvedCamera(
  board: BoardSize,
  map: MapSize,
  camera: Camera | null,
): Camera {
  if (camera?.retained === true) {
    // Passive layout preserved actual pixels; clamping would snap them (a
    // letterboxed fit or a zoom below 1 cannot survive clampCamera).
    return camera;
  }
  return clampCamera(
    board,
    map,
    camera ?? { zoom: 1, center: { x: map.width / 2, y: map.height / 2 } },
  );
}

/** Zoom 1 always shows the whole map, whatever its center, so it is the
 *  fitted view: report it as `null`. */
function fittedAsNull(camera: Camera): Camera | null {
  return camera.zoom <= 1 ? null : camera;
}

/**
 * Passive resize (dock open/close, window resize): compute the camera that
 * redraws the same CSS scale and offsets on the new board, so the map never
 * moves under a layout change — even from the default Fit, where clamping
 * would recenter a letterboxed view. No pointer anchor is involved. Returns
 * `null` when the preserved pixels already are the new board's canonical Fit
 * (e.g. an exact dock round trip), so the ordinary fitted view resumes. A
 * preserved view the ordinary clamp would leave untouched comes back as a
 * plain camera — `retained` is reserved for pixels clamping cannot
 * reproduce, so later navigation applies the normal limits.
 */
export function rebaseCameraForResize(
  oldBoard: BoardSize,
  newBoard: BoardSize,
  map: MapSize,
  camera: Camera | null,
): Camera | null {
  const previous = getBoardTransform(oldBoard, map, camera);
  const fit = fitScale(newBoard, map);
  if (!(previous.scale > 0) || !(fit > 0)) {
    return camera;
  }
  const safe = safeRect(newBoard);
  const tilePx = previous.scale * tileSize;
  const rebased: Camera = {
    zoom: previous.scale / fit,
    center: {
      x: (safe.x + safe.width / 2 - previous.offsetX) / tilePx,
      y: (safe.y + safe.height / 2 - previous.offsetY) / tilePx,
    },
  };
  // The rebased camera reproduces `previous` pixel-for-pixel, so comparing
  // `previous` to the new canonical Fit is the same comparison without a
  // round trip through the camera.
  const canonical = getBoardTransform(newBoard, map, null);
  const close = (a: number, b: number) =>
    Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b));
  if (
    close(previous.scale, canonical.scale) &&
    close(previous.offsetX, canonical.offsetX) &&
    close(previous.offsetY, canonical.offsetY)
  ) {
    return null;
  }
  const clamped = clampCamera(newBoard, map, rebased);
  const same = (a: number, b: number) => Math.abs(a - b) <= 1e-9;
  return same(clamped.zoom, rebased.zoom) &&
    same(clamped.center.x, rebased.center.x) &&
    same(clamped.center.y, rebased.center.y)
    ? fittedAsNull(clamped)
    : { ...rebased, retained: true };
}

/** Zoom by `factor`, keeping the world point under `anchor` (board CSS px)
 *  fixed on screen. */
export function zoomCameraAt(
  board: BoardSize,
  map: MapSize,
  camera: Camera | null,
  factor: number,
  anchor: { x: number; y: number },
): Camera | null {
  const current = resolvedCamera(board, map, camera);
  const fit = fitScale(board, map);
  const before = fit * current.zoom * tileSize;
  if (!(before > 0)) {
    return camera;
  }
  // Shrinking a retained view that already draws the whole map inside the
  // safe viewport only re-centers it, so Zoom Out stays a no-op — but a view
  // with an edge still cropped keeps zooming out below fit until every edge
  // is inside.
  if (
    current.retained === true &&
    factor < 1 &&
    mapInsideSafe(board, map, current)
  ) {
    return camera;
  }
  const safe = safeRect(board);
  const middleX = safe.x + safe.width / 2;
  const middleY = safe.y + safe.height / 2;
  const worldX = current.center.x + (anchor.x - middleX) / before;
  const worldY = current.center.y + (anchor.y - middleY) / before;
  // An ordinary view never zooms out below fit; a retained view may cross
  // below 1 while part of the map is still cropped, shrinking until the
  // whole map is inside the safe viewport (the check above then stops it).
  const floor = current.retained === true ? 0 : 1;
  const zoom = Math.min(
    Math.max(current.zoom * factor, floor),
    maxZoom(board, map),
  );
  const after = fit * zoom * tileSize;
  const moved = {
    zoom,
    center: {
      x: worldX - (anchor.x - middleX) / after,
      y: worldY - (anchor.y - middleY) / after,
    },
  };
  if (current.retained === true) {
    // A retained view bypasses clampCamera; zooming into a blank margin
    // outside the map could otherwise push the entire map offstage. Keep
    // cursor-on-map anchoring exact, and only bound off-map zooming so a
    // quarter-viewport strip (or whatever was already visible) stays onstage.
    const clampAxisForOffMapZoom = (
      nextCenter: number,
      currentCenter: number,
      worldCoord: number,
      mapTiles: number,
      safeStart: number,
      safeSpan: number,
      middle: number,
    ): number => {
      if (worldCoord >= 0 && worldCoord <= mapTiles) {
        return nextCenter;
      }
      const keepPx = Math.min(safeSpan * 0.25, mapTiles * after);
      if (worldCoord > mapTiles) {
        const beforeEdge = middle + (mapTiles - currentCenter) * before;
        const minEdge = Math.min(beforeEdge, safeStart + keepPx);
        const afterEdge = middle + (mapTiles - nextCenter) * after;
        return afterEdge < minEdge
          ? mapTiles - (minEdge - middle) / after
          : nextCenter;
      }
      const beforeEdge = middle - currentCenter * before;
      const maxEdge = Math.max(beforeEdge, safeStart + safeSpan - keepPx);
      const afterEdge = middle - nextCenter * after;
      return afterEdge > maxEdge ? (middle - maxEdge) / after : nextCenter;
    };
    moved.center.x = clampAxisForOffMapZoom(
      moved.center.x,
      current.center.x,
      worldX,
      map.width,
      safe.x,
      safe.width,
      middleX,
    );
    moved.center.y = clampAxisForOffMapZoom(
      moved.center.y,
      current.center.y,
      worldY,
      map.height,
      safe.y,
      safe.height,
      middleY,
    );
    // Still below fit: stay passive on the actually rendered pixels.
    if (zoom < 1) {
      return { ...moved, retained: true };
    }
    // Hand control back to ordinary clamped navigation only when the clamp
    // would not move the view — which at zoom 1 also means the whole
    // projected transform already is the canonical Fit. A retained view
    // reaching zoom 1 with passive offsets stays retained: returning `null`
    // here would snap it to Fit and move the anchored world point.
    const clamped = clampCamera(board, map, moved);
    const same = (a: number, b: number) => Math.abs(a - b) <= 1e-9;
    return same(clamped.zoom, moved.zoom) &&
      same(clamped.center.x, moved.center.x) &&
      same(clamped.center.y, moved.center.y)
      ? fittedAsNull(clamped)
      : { ...moved, retained: true };
  }
  return fittedAsNull(clampCamera(board, map, moved));
}

/** Ordinary clamp bounds for one axis, widened to include a passive center:
 *  the first drag cannot snap it, yet panning can never escape past it. */
function boundedAxisClamp(
  center: number,
  passive: number,
  half: number,
  mapTiles: number,
): number {
  let lo = half;
  let hi = mapTiles - half;
  if (2 * half >= mapTiles) {
    lo = hi = mapTiles / 2;
  }
  return Math.min(
    Math.max(center, Math.min(lo, passive)),
    Math.max(hi, passive),
  );
}

/** Drag the map by a CSS-pixel delta (content follows the pointer). */
export function panCamera(
  board: BoardSize,
  map: MapSize,
  camera: Camera | null,
  dx: number,
  dy: number,
): Camera | null {
  const current = resolvedCamera(board, map, camera);
  const tilePx = fitScale(board, map) * current.zoom * tileSize;
  if (!(tilePx > 0)) {
    return camera;
  }
  if (current.retained === true) {
    const safe = safeRect(board);
    // Only treat panning as a no-op when the whole map already fits inside
    // the safe viewport; a sub-fit view after enlarging the window can still
    // have an edge cropped offscreen or behind the HUD.
    if (mapInsideSafe(board, map, current)) {
      return camera;
    }
    // Passive placement leads: the first drag must not snap an off-range
    // passive center, yet panning can never push the view further out than
    // passive layout left it (the map cannot leave the board).
    const moved = {
      zoom: current.zoom,
      center: {
        x: current.center.x - dx / tilePx,
        y: current.center.y - dy / tilePx,
      },
    };
    const bounded = {
      ...moved,
      center: {
        x: boundedAxisClamp(
          moved.center.x,
          current.center.x,
          safe.width / (2 * tilePx),
          map.width,
        ),
        y: boundedAxisClamp(
          moved.center.y,
          current.center.y,
          safe.height / (2 * tilePx),
          map.height,
        ),
      },
    };
    // Once the ordinary clamp is identity, ordinary clamped navigation
    // resumes; otherwise the view stays passive rather than snapping.
    const clamped = clampCamera(board, map, bounded);
    const same = (a: number, b: number) => Math.abs(a - b) <= 1e-9;
    return same(clamped.zoom, bounded.zoom) &&
      same(clamped.center.x, bounded.center.x) &&
      same(clamped.center.y, bounded.center.y)
      ? fittedAsNull(clamped)
      : { ...bounded, retained: true };
  }
  return fittedAsNull(
    clampCamera(board, map, {
      zoom: current.zoom,
      center: {
        x: current.center.x - dx / tilePx,
        y: current.center.y - dy / tilePx,
      },
    }),
  );
}

export function applyCameraAction(
  board: BoardSize,
  map: MapSize,
  camera: Camera | null,
  action: CameraAction,
): Camera | null {
  const safe = safeRect(board);
  const middle = {
    x: safe.x + safe.width / 2,
    y: safe.y + safe.height / 2,
  };
  switch (action.kind) {
    case "fit":
      return null;
    case "zoomIn":
      return zoomCameraAt(board, map, camera, ZOOM_STEP, middle);
    case "zoomOut":
      return zoomCameraAt(board, map, camera, 1 / ZOOM_STEP, middle);
    case "pan":
      // A pan key moves the view, so the content moves the other way.
      return panCamera(
        board,
        map,
        camera,
        -action.x * safe.width * PAN_STEP_FRACTION,
        -action.y * safe.height * PAN_STEP_FRACTION,
      );
    case "centerOn": {
      const current = resolvedCamera(board, map, camera);
      const zoom =
        current.zoom <= 1 ? Math.min(2, maxZoom(board, map)) : current.zoom;
      return fittedAsNull(
        clampCamera(board, map, {
          zoom,
          center: { x: action.point.x + 0.5, y: action.point.y + 0.5 },
        }),
      );
    }
  }
}

/** Apply canvas backing-store size from known CSS dimensions (no layout read). */
export function applyCanvasPixelSize(
  canvas: CanvasSizeTarget,
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number = globalThis.devicePixelRatio ?? 1,
): boolean {
  const roundedCssWidth = Math.max(1, Math.round(cssWidth));
  const roundedCssHeight = Math.max(1, Math.round(cssHeight));
  const width = Math.max(1, Math.round(cssWidth * devicePixelRatio));
  const height = Math.max(1, Math.round(cssHeight * devicePixelRatio));

  if (canvas.style !== undefined) {
    canvas.style.width = `${roundedCssWidth}px`;
    canvas.style.height = `${roundedCssHeight}px`;
  }

  if (canvas.width === width && canvas.height === height) {
    return false;
  }

  canvas.width = width;
  canvas.height = height;
  return true;
}

/** One-shot size sync via layout read. Prefer ResizeObserver + applyCanvasPixelSize in the frame loop. */
export function syncCanvasSize(canvas: CanvasSizeTarget): boolean {
  const rect = canvas.getBoundingClientRect();
  return applyCanvasPixelSize(canvas, rect.width, rect.height);
}

/**
 * Screen→world→tile conversion against one resolved transform — the shared
 * mapping every pointer path uses, so a click, the hover highlight, and a
 * drag release cannot disagree. Returns null off-canvas or off-map.
 */
export function canvasToWorld(
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
  map: MapSize,
  transform: BoardTransform,
  rect: DOMRect = canvas.getBoundingClientRect(),
): { world: Point; tile: Point } | null {
  if (rect.width === 0 || rect.height === 0) {
    return null;
  }

  const cssX = clientX - rect.left;
  const cssY = clientY - rect.top;
  // Zoomed in, the map overflows the board, so off-canvas coordinates still
  // resolve to in-map tiles; a captured pointer's events keep arriving out
  // there. Reject them so a stroke freezes at the last visible tile.
  if (cssX < 0 || cssX >= rect.width || cssY < 0 || cssY >= rect.height) {
    return null;
  }
  if (!(transform.scale > 0)) {
    return null;
  }

  // Map in CSS px: the camera is clamped against the CSS board, the same box
  // the host and the DOM text overlay use.
  const world = {
    x: (cssX - transform.offsetX) / transform.scale,
    y: (cssY - transform.offsetY) / transform.scale,
  };
  const tile = {
    x: Math.floor(world.x / tileSize),
    y: Math.floor(world.y / tileSize),
  };

  return tile.x >= 0 && tile.x < map.width && tile.y >= 0 && tile.y < map.height
    ? { world, tile }
    : null;
}

export function canvasToTile(
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
  map: MapSize,
  camera: Camera | null = null,
): Point | null {
  const transform = getBoardTransform(
    canvas.getBoundingClientRect(),
    map,
    camera,
  );
  return canvasToWorld(canvas, clientX, clientY, map, transform)?.tile ?? null;
}
