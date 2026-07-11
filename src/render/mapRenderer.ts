import type {
  GameState,
  Heading,
  Point,
  RoadDirection,
  RoadPort,
  Tile,
} from "../domain/types";
import { ROAD_DIRECTION_OFFSET } from "../domain/types";
import { tileSize } from "./canvas";
import { areaColors, colors } from "./colors";
import { renderRoundabout } from "./roundaboutRenderer";

function center(point: Point): Point {
  return {
    x: point.x * tileSize + tileSize / 2,
    y: point.y * tileSize + tileSize / 2,
  };
}

function connectionEndpoint(point: Point, heading: Heading): Point {
  const tileCenter = center(point);
  const offset = ROAD_DIRECTION_OFFSET[heading];
  return {
    x: tileCenter.x + (offset.x * tileSize) / 2,
    y: tileCenter.y + (offset.y * tileSize) / 2,
  };
}

function drawRoadStub(
  ctx: CanvasRenderingContext2D,
  point: Point,
  heading: Heading,
): void {
  const tileCenter = center(point);
  const endpoint = connectionEndpoint(point, heading);
  ctx.beginPath();
  ctx.moveTo(tileCenter.x, tileCenter.y);
  ctx.lineTo(endpoint.x, endpoint.y);
  ctx.stroke();
}

function isCorner(headings: readonly Heading[]): boolean {
  if (headings.length !== 2) return false;
  const first = ROAD_DIRECTION_OFFSET[headings[0]];
  const second = ROAD_DIRECTION_OFFSET[headings[1]];
  return first.x * second.x + first.y * second.y === 0;
}

function drawOrdinaryRoad(ctx: CanvasRenderingContext2D, tile: Tile): void {
  for (const heading of tile.roadConnections) {
    drawRoadStub(ctx, tile, heading);
  }
  if (!isCorner(tile.roadConnections)) return;
  const from = connectionEndpoint(tile, tile.roadConnections[0]);
  const to = connectionEndpoint(tile, tile.roadConnections[1]);
  const tileCenter = center(tile);
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.quadraticCurveTo(tileCenter.x, tileCenter.y, to.x, to.y);
  ctx.stroke();
}

function drawAutomaticJunctionApproach(
  ctx: CanvasRenderingContext2D,
  port: RoadPort,
): void {
  drawRoadStub(ctx, port.point, port.edge);
}

function protectedIslandKeys(state: GameState): Set<string> {
  return new Set(
    state.map.roadStructures.flatMap((structure) =>
      structure.kind === "roundabout" && structure.size === "standard3x3"
        ? [`${structure.origin.x + 1},${structure.origin.y + 1}`]
        : [],
    ),
  );
}

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
  const islandKeys = protectedIslandKeys(state);

  for (const tile of state.map.tiles) {
    ctx.fillStyle = islandKeys.has(`${tile.x},${tile.y}`)
      ? colors.empty
      : tile.kind === "empty" && tile.area !== undefined
        ? areaColors[tile.area]
        : colors[tile.kind];
    ctx.fillRect(tile.x * tileSize, tile.y * tileSize, tileSize, tileSize);
    ctx.strokeRect(tile.x * tileSize, tile.y * tileSize, tileSize, tileSize);
  }

  const structureKinds = new Map(
    state.map.roadStructures.map((structure) => [structure.id, structure.kind]),
  );
  ctx.save();
  ctx.strokeStyle = colors.roadCenterline;
  ctx.lineWidth = 4;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const tile of state.map.tiles) {
    if (tile.kind !== "road") continue;
    const structureKind =
      tile.roadStructureId === undefined
        ? undefined
        : structureKinds.get(tile.roadStructureId);
    if (structureKind === undefined) {
      drawOrdinaryRoad(ctx, tile);
    }
  }
  for (const structure of state.map.roadStructures) {
    if (structure.kind === "automaticJunction") {
      for (const port of structure.ports) {
        drawAutomaticJunctionApproach(ctx, port);
      }
    }
  }
  ctx.restore();

  for (const structure of state.map.roadStructures) {
    if (structure.kind === "roundabout") {
      renderRoundabout(ctx, structure, {
        tileSize,
        tileToPixel: center,
      });
    }
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
