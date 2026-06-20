import type { GameState, Point, RoadDirection } from "../domain/types";
import { ROAD_DIRECTION_OFFSET } from "../domain/types";
import { tileSize } from "./canvas";
import { areaColors, colors } from "./colors";

/** Draw a directional road arrow (shaft + chevron head) centered on `point`,
 *  pointing along `direction`. Rendered in world coordinates. The caller is
 *  responsible for strokeStyle / lineWidth / lineCap / lineJoin. Shared by the
 *  committed-road render pass and the drag-line preview so both agree on glyph
 *  shape. */
export function drawDirectionArrow(
  ctx: CanvasRenderingContext2D,
  point: Point,
  direction: RoadDirection,
): void {
  const offset = ROAD_DIRECTION_OFFSET[direction];
  const cx = point.x * tileSize + tileSize / 2;
  const cy = point.y * tileSize + tileSize / 2;
  const half = tileSize / 4;
  const tipX = cx + offset.x * half;
  const tipY = cy + offset.y * half;
  const tailX = cx - offset.x * half;
  const tailY = cy - offset.y * half;

  // Shaft.
  ctx.beginPath();
  ctx.moveTo(tailX, tailY);
  ctx.lineTo(tipX, tipY);
  ctx.stroke();

  // Chevron head: two short barbs from the tip, angled back along the
  // perpendicular axis.
  const perpX = offset.y;
  const perpY = -offset.x;
  const head = tileSize / 6;
  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(
    tipX - offset.x * head + perpX * head,
    tipY - offset.y * head + perpY * head,
  );
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(
    tipX - offset.x * head - perpX * head,
    tipY - offset.y * head - perpY * head,
  );
  ctx.stroke();
}

export function renderMap(
  ctx: CanvasRenderingContext2D,
  state: GameState,
): void {
  ctx.lineWidth = 1;
  ctx.strokeStyle = colors.grid;

  for (const tile of state.map.tiles) {
    ctx.fillStyle =
      tile.kind === "empty" && tile.area !== undefined
        ? areaColors[tile.area]
        : colors[tile.kind];
    ctx.fillRect(tile.x * tileSize, tile.y * tileSize, tileSize, tileSize);
    ctx.strokeRect(tile.x * tileSize, tile.y * tileSize, tileSize, tileSize);
  }

  // PERF: Rebuilds every frame; fine for a ~504-tile map. Could cache on
  // GameState identity if this ever shows up in a profile.
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

  const oneWayTiles = state.map.tiles.filter(
    (tile) => tile.kind === "road" && tile.oneWay !== undefined,
  );

  if (oneWayTiles.length > 0) {
    ctx.save();
    ctx.strokeStyle = colors.oneWayArrow;
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    for (const tile of oneWayTiles) {
      const oneWay = tile.oneWay;
      if (oneWay === undefined) {
        continue;
      }
      drawDirectionArrow(ctx, tile, oneWay);
    }

    ctx.restore();
  }
}
