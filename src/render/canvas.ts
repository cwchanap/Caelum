import type { GameState, Point } from "../domain/types";
import type { UiState } from "../ui/uiState";
import { renderCitizens } from "./citizenRenderer";
import { renderMap } from "./mapRenderer";
import { renderOverlays } from "./overlayRenderer";
import { renderTransit } from "./transitRenderer";

export const tileSize = 32;

export function canvasToTile(canvas: HTMLCanvasElement, clientX: number, clientY: number): Point {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;

  return {
    x: Math.floor(((clientX - rect.left) * scaleX) / tileSize),
    y: Math.floor(((clientY - rect.top) * scaleY) / tileSize)
  };
}

export function renderGame(ctx: CanvasRenderingContext2D, state: GameState, ui: UiState): void {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  renderMap(ctx, state);
  renderOverlays(ctx, state, ui);
  renderTransit(ctx, state);
  renderCitizens(ctx, state);
}
