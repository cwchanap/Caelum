import type { GameState } from "../domain/types";
import { tileSize } from "./canvas";
import { colors } from "./colors";

export function renderMap(
  ctx: CanvasRenderingContext2D,
  state: GameState,
): void {
  ctx.lineWidth = 1;
  ctx.strokeStyle = colors.grid;

  for (const tile of state.map.tiles) {
    ctx.fillStyle = colors[tile.kind];
    ctx.fillRect(tile.x * tileSize, tile.y * tileSize, tileSize, tileSize);
    ctx.strokeRect(tile.x * tileSize, tile.y * tileSize, tileSize, tileSize);
  }

  const trackKeys = new Set(
    state.map.tiles
      .filter((tile) => tile.hasTrack === true)
      .map((tile) => `${tile.x},${tile.y}`),
  );

  if (trackKeys.size > 0) {
    ctx.save();
    ctx.strokeStyle = colors.track;
    ctx.lineWidth = 4;
    ctx.lineCap = "round";

    for (const tile of state.map.tiles) {
      if (tile.hasTrack !== true) {
        continue;
      }
      const cx = tile.x * tileSize + tileSize / 2;
      const cy = tile.y * tileSize + tileSize / 2;
      let connected = false;

      for (const offset of [
        { x: 0, y: -1 },
        { x: 1, y: 0 },
        { x: 0, y: 1 },
        { x: -1, y: 0 },
      ]) {
        if (!trackKeys.has(`${tile.x + offset.x},${tile.y + offset.y}`)) {
          continue;
        }
        connected = true;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(
          cx + (offset.x * tileSize) / 2,
          cy + (offset.y * tileSize) / 2,
        );
        ctx.stroke();
      }

      if (!connected) {
        ctx.beginPath();
        ctx.arc(cx, cy, 4, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.restore();
  }
}
