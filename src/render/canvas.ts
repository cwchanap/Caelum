import type { GameMap, GameState, Point } from "../domain/types";
import type { UiState } from "../ui/uiState";
import { renderBuildings } from "./buildingRenderer";
import { renderCitizens } from "./citizenRenderer";
import { renderCursorBadge } from "./cursorBadge";
import { renderMap } from "./mapRenderer";
import {
  renderOverlays,
  renderRoadPreviewFeedbackBadge,
  renderRouteDraftHandleOverlay,
} from "./overlayRenderer";
import { renderTransit } from "./transitRenderer";

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

interface CanvasSizeTarget {
  width: number;
  height: number;
  style?: { width: string; height: string };
  getBoundingClientRect: () => Pick<DOMRectReadOnly, "width" | "height">;
}

export function getBoardTransform(
  board: BoardSize,
  map: GameMap,
): BoardTransform {
  const mapWidth = map.width * tileSize;
  const mapHeight = map.height * tileSize;
  const scale = Math.min(board.width / mapWidth, board.height / mapHeight);
  const width = mapWidth * scale;
  const height = mapHeight * scale;

  return {
    scale,
    offsetX: (board.width - width) / 2,
    offsetY: (board.height - height) / 2,
    width,
    height,
  };
}

export function syncCanvasSize(canvas: CanvasSizeTarget): boolean {
  const rect = canvas.getBoundingClientRect();
  const cssWidth = Math.max(1, Math.round(rect.width));
  const cssHeight = Math.max(1, Math.round(rect.height));
  const devicePixelRatio = globalThis.devicePixelRatio ?? 1;
  const width = Math.max(1, Math.round(rect.width * devicePixelRatio));
  const height = Math.max(1, Math.round(rect.height * devicePixelRatio));

  if (canvas.style !== undefined) {
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
  }

  if (canvas.width === width && canvas.height === height) {
    return false;
  }

  canvas.width = width;
  canvas.height = height;
  return true;
}

export function canvasToTile(
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
  map: GameMap,
): Point | null {
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) {
    return null;
  }

  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const transform = getBoardTransform(canvas, map);
  const canvasX = (clientX - rect.left) * scaleX;
  const canvasY = (clientY - rect.top) * scaleY;
  const point = {
    x: Math.floor((canvasX - transform.offsetX) / transform.scale / tileSize),
    y: Math.floor((canvasY - transform.offsetY) / transform.scale / tileSize),
  };

  return point.x >= 0 &&
    point.x < map.width &&
    point.y >= 0 &&
    point.y < map.height
    ? point
    : null;
}

export function renderGame(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  ui: UiState,
): void {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  const transform = getBoardTransform(ctx.canvas, state.map);

  ctx.save();
  ctx.translate(transform.offsetX, transform.offsetY);
  ctx.scale(transform.scale, transform.scale);
  renderMap(ctx, state);
  renderBuildings(ctx, state);
  renderOverlays(ctx, state, ui);
  renderTransit(ctx, state, ui);
  renderCitizens(ctx, state);
  renderRouteDraftHandleOverlay(ctx, state, ui);
  ctx.restore();

  renderRoadPreviewFeedbackBadge(ctx, state, ui, transform);
  renderCursorBadge(ctx, state, ui, transform);
}
