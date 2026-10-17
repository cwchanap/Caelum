import type { GameMap, Point } from "../domain/types";

export const tileSize = 32;

export interface BoardTransform {
  scale: number;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
}

interface BoardSize {
  width: number;
  height: number;
}

type MapSize = Pick<GameMap, "width" | "height">;

/**
 * Local map view: never persisted and never sent to Rust. `zoom` multiplies
 * the fit-to-board scale (1 shows the whole map); `center` is the world point,
 * in tiles, drawn at the middle of the board. `null` everywhere means "fit".
 */
export interface Camera {
  zoom: number;
  center: { x: number; y: number };
}

/** A camera change requested from outside the board (buttons, keys). `pan`
 *  moves by `x`/`y` steps of `PAN_STEP_FRACTION` of the board. */
export type CameraAction =
  | { kind: "zoomIn" }
  | { kind: "zoomOut" }
  | { kind: "fit" }
  | { kind: "pan"; x: number; y: number };

/** Largest on-screen tile, in CSS px, the camera may zoom to. */
const MAX_TILE_CSS_PX = 96;
/** Zoom multiplier per button press or key press. */
export const ZOOM_STEP = 1.25;
const PAN_STEP_FRACTION = 0.2;

interface CanvasSizeTarget {
  width: number;
  height: number;
  style?: { width: string; height: string };
  getBoundingClientRect: () => Pick<DOMRectReadOnly, "width" | "height">;
}

/**
 * World px → board CSS px. With no camera the whole map is fitted and
 * centered; a camera zooms and pans that fit (clamped so the view stays on the
 * map). Every consumer — GPU host, pointer mapping, DOM text overlay — uses
 * this one function so they agree on where a tile is.
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

  return {
    scale,
    offsetX: board.width / 2 - view.center.x * tileSize * scale,
    offsetY: board.height / 2 - view.center.y * tileSize * scale,
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
  return Math.min(
    board.width / (map.width * tileSize),
    board.height / (map.height * tileSize),
  );
}

export function maxZoom(board: BoardSize, map: MapSize): number {
  const fit = fitScale(board, map);
  return Math.max(1, MAX_TILE_CSS_PX / (tileSize * fit));
}

/**
 * Clamp zoom to [1, maxZoom] and keep the viewport inside the map. On an axis
 * where the whole map already fits, the map stays centered, so a zoom of 1 is
 * exactly the fit view.
 */
export function clampCamera(
  board: BoardSize,
  map: MapSize,
  camera: Camera,
): Camera {
  if (!(board.width > 0 && board.height > 0)) {
    return camera;
  }
  const zoom = Math.min(Math.max(camera.zoom, 1), maxZoom(board, map));
  const tilePx = fitScale(board, map) * zoom * tileSize;
  const clampAxis = (center: number, boardPx: number, mapTiles: number) => {
    const half = boardPx / (2 * tilePx);
    if (2 * half >= mapTiles) {
      return mapTiles / 2;
    }
    return Math.min(Math.max(center, half), mapTiles - half);
  };
  return {
    zoom,
    center: {
      x: clampAxis(camera.center.x, board.width, map.width),
      y: clampAxis(camera.center.y, board.height, map.height),
    },
  };
}

function resolvedCamera(
  board: BoardSize,
  map: MapSize,
  camera: Camera | null,
): Camera {
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
  const worldX = current.center.x + (anchor.x - board.width / 2) / before;
  const worldY = current.center.y + (anchor.y - board.height / 2) / before;
  const zoom = Math.min(
    Math.max(current.zoom * factor, 1),
    maxZoom(board, map),
  );
  const after = fit * zoom * tileSize;
  return fittedAsNull(
    clampCamera(board, map, {
      zoom,
      center: {
        x: worldX - (anchor.x - board.width / 2) / after,
        y: worldY - (anchor.y - board.height / 2) / after,
      },
    }),
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
  const middle = { x: board.width / 2, y: board.height / 2 };
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
        -action.x * board.width * PAN_STEP_FRACTION,
        -action.y * board.height * PAN_STEP_FRACTION,
      );
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

export function canvasToTile(
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
  map: MapSize,
  camera: Camera | null = null,
): Point | null {
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) {
    return null;
  }

  // Map in CSS px: the camera is clamped against the CSS board, the same box
  // the host and the DOM text overlay use.
  const transform = getBoardTransform(rect, map, camera);
  const cssX = clientX - rect.left;
  const cssY = clientY - rect.top;
  const point = {
    x: Math.floor((cssX - transform.offsetX) / transform.scale / tileSize),
    y: Math.floor((cssY - transform.offsetY) / transform.scale / tileSize),
  };

  return point.x >= 0 &&
    point.x < map.width &&
    point.y >= 0 &&
    point.y < map.height
    ? point
    : null;
}
