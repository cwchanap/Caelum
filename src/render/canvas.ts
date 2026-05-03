import type { GameMap, GameState, Point } from "../domain/types";
import type { UiState } from "../ui/uiState";
import { renderCitizens } from "./citizenRenderer";
import { renderMap } from "./mapRenderer";
import { renderOverlays } from "./overlayRenderer";
import { renderTransit } from "./transitRenderer";

export const tileSize = 32;

export function canvasToTile(canvas: HTMLCanvasElement, clientX: number, clientY: number, map: GameMap): Point | null {
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) {
    return null;
  }

  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const point = {
    x: Math.floor(((clientX - rect.left) * scaleX) / tileSize),
    y: Math.floor(((clientY - rect.top) * scaleY) / tileSize)
  };

  return point.x >= 0 && point.x < map.width && point.y >= 0 && point.y < map.height ? point : null;
}

export function renderGame(ctx: CanvasRenderingContext2D, state: GameState, ui: UiState): void {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  renderMap(ctx, state);
  renderOverlays(ctx, state, ui);
  renderTransit(ctx, state);
  renderCitizens(ctx, state);
}
