import type { GameState } from "../domain/types";
import { tileSize } from "./canvas";
import { colors } from "./colors";

export function renderMap(ctx: CanvasRenderingContext2D, state: GameState): void {
  ctx.lineWidth = 1;
  ctx.strokeStyle = colors.grid;

  for (const tile of state.map.tiles) {
    ctx.fillStyle = colors[tile.kind];
    ctx.fillRect(tile.x * tileSize, tile.y * tileSize, tileSize, tileSize);
    ctx.strokeRect(tile.x * tileSize, tile.y * tileSize, tileSize, tileSize);
  }
}
