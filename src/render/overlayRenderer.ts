import {
  ROAD_DIRECTION_OFFSET,
  type ActiveTrip,
  type GameMap,
  type GameState,
  type Point,
  type Tile,
} from "../domain/types";
import type {
  AuthoredRoadTilePreview,
  RoadMutationPreviewResponse,
} from "../runtime/backend/types";
import {
  BUILDING_CATALOG,
  getBuildingFootprint,
} from "../domain/catalog/buildings";
import { stopCoverageRadius } from "../domain/catalog/transit";
import { selectPlatformOccupancy } from "../domain/platformOccupancy";
import { axisLockedLine } from "../ui/roadDrag";
import type { UiState } from "../ui/uiState";
import { tileSize } from "./canvas";
import { colors } from "./colors";
import { drawDirectionArrow } from "./mapRenderer";

const previewStrokeInset = 2;

function samePoint(left: Point, right: Point): boolean {
  return left.x === right.x && left.y === right.y;
}

function getTile(map: GameMap, point: Point): Tile | null {
  if (
    point.x < 0 ||
    point.x >= map.width ||
    point.y < 0 ||
    point.y >= map.height
  ) {
    return null;
  }

  return map.tiles.find((tile) => samePoint(tile, point)) ?? null;
}

function isBuildingOccupied(state: GameState, point: Point): boolean {
  return state.buildings.some((building) =>
    building.occupiedTiles.some((occupiedTile) =>
      samePoint(occupiedTile, point),
    ),
  );
}

function isTransitNodeAt(state: GameState, point: Point): boolean {
  return (
    state.transit.stops.some((stop) => samePoint(stop.position, point)) ||
    state.transit.stations.some((station) => samePoint(station.position, point))
  );
}

function canPlaceBuilding(
  state: GameState,
  type: keyof typeof BUILDING_CATALOG,
  origin: Point,
  rotation: 0 | 90 | 180 | 270,
): boolean {
  const definition = BUILDING_CATALOG[type];
  const footprint = getBuildingFootprint(type, origin, rotation);

  return footprint.every((point) => {
    const tile = getTile(state.map, point);
    const kindOk =
      type === "metroStation"
        ? tile?.kind === "empty" || tile?.kind === "road"
        : tile?.kind === "empty";
    const trackOk =
      type === "metroStation"
        ? tile?.hasTrack === true
        : tile?.hasTrack !== true;
    const areaOk =
      definition.allowedArea === undefined ||
      tile?.area === definition.allowedArea;

    return (
      kindOk &&
      trackOk &&
      areaOk &&
      !isBuildingOccupied(state, point) &&
      !isTransitNodeAt(state, point)
    );
  });
}

function rectanglePoints(start: Point, end: Point): Point[] {
  const minX = Math.min(start.x, end.x);
  const maxX = Math.max(start.x, end.x);
  const minY = Math.min(start.y, end.y);
  const maxY = Math.max(start.y, end.y);
  const points: Point[] = [];

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      points.push({ x, y });
    }
  }

  return points;
}

function isAreaPaintable(state: GameState, point: Point): boolean {
  const tile = getTile(state.map, point);
  return (
    tile?.kind === "empty" &&
    tile.hasTrack !== true &&
    !isBuildingOccupied(state, point) &&
    !isTransitNodeAt(state, point)
  );
}

function planAreaPaintPreview(
  state: GameState,
  start: Point,
  end: Point,
): Array<{ point: Point; paintable: boolean }> {
  return rectanglePoints(start, end).map((point) => ({
    point,
    paintable: isAreaPaintable(state, point),
  }));
}

function overlayTrips(state: GameState): ActiveTrip[] {
  return state.activeTrips ?? [];
}

function fillTile(ctx: CanvasRenderingContext2D, point: Point): void {
  ctx.fillRect(point.x * tileSize, point.y * tileSize, tileSize, tileSize);
}

function fillCoverageArea(
  ctx: CanvasRenderingContext2D,
  point: Point,
  radius: number,
): void {
  ctx.fillRect(
    (point.x - radius) * tileSize,
    (point.y - radius) * tileSize,
    tileSize * (radius * 2 + 1),
    tileSize * (radius * 2 + 1),
  );
}

function strokeTile(ctx: CanvasRenderingContext2D, point: Point): void {
  ctx.strokeRect(
    point.x * tileSize + previewStrokeInset,
    point.y * tileSize + previewStrokeInset,
    tileSize - previewStrokeInset * 2,
    tileSize - previewStrokeInset * 2,
  );
}

function renderBuildingPreview(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  ui: UiState,
): void {
  if (ui.hoverTile === null || ui.selectedBuilding === null) {
    return;
  }

  const validPlacement =
    state.budget >= BUILDING_CATALOG[ui.selectedBuilding].cost &&
    canPlaceBuilding(
      state,
      ui.selectedBuilding,
      ui.hoverTile,
      ui.buildingRotation,
    );
  const footprint = getBuildingFootprint(
    ui.selectedBuilding,
    ui.hoverTile,
    ui.buildingRotation,
  );

  ctx.fillStyle = validPlacement ? colors.previewValid : colors.previewInvalid;
  ctx.strokeStyle = validPlacement
    ? colors.previewValidStroke
    : colors.previewInvalidStroke;
  ctx.lineWidth = 2;

  for (const point of footprint) {
    fillTile(ctx, point);
    strokeTile(ctx, point);
  }
}

function isInMap(state: GameState, point: Point): boolean {
  return (
    point.x >= 0 &&
    point.x < state.map.width &&
    point.y >= 0 &&
    point.y < state.map.height
  );
}

function drawAuthoredRoadConnections(
  ctx: CanvasRenderingContext2D,
  tile: AuthoredRoadTilePreview,
): void {
  const centerX = tile.point.x * tileSize + tileSize / 2;
  const centerY = tile.point.y * tileSize + tileSize / 2;
  for (const heading of tile.roadConnections) {
    const offset = ROAD_DIRECTION_OFFSET[heading];
    ctx.beginPath();
    ctx.moveTo(centerX, centerY);
    ctx.lineTo(
      centerX + (offset.x * tileSize) / 2,
      centerY + (offset.y * tileSize) / 2,
    );
    ctx.stroke();
  }
}

function compareRouteImpacts(
  left: RoadMutationPreviewResponse["routeImpacts"][number],
  right: RoadMutationPreviewResponse["routeImpacts"][number],
): number {
  if (left.routeId !== right.routeId) {
    return left.routeId < right.routeId ? -1 : 1;
  }
  if (left.kind === right.kind) return 0;
  return left.kind < right.kind ? -1 : 1;
}

function roadPreviewFeedback(preview: RoadMutationPreviewResponse): string {
  const impacts = [...preview.routeImpacts]
    .sort(compareRouteImpacts)
    .map((impact) => `${impact.routeId} ${impact.kind}`)
    .join(" · ");
  const cost = `$${preview.cost.toLocaleString()}`;
  return impacts.length === 0 ? cost : `${cost} · ${impacts}`;
}

function roadPreviewAnchor(preview: RoadMutationPreviewResponse): Point {
  return (
    preview.authoredTiles[0]?.point ??
    preview.changedTiles[0] ??
    preview.skippedTiles[0] ??
    preview.generatedStructures[0]?.footprint[0] ?? { x: 0, y: 0 }
  );
}

function renderRoadPreviewFeedback(
  ctx: CanvasRenderingContext2D,
  preview: RoadMutationPreviewResponse,
): void {
  const text = roadPreviewFeedback(preview);
  const anchor = roadPreviewAnchor(preview);
  const centerX = anchor.x * tileSize + tileSize / 2;
  const height = 18;
  const padding = 4;

  ctx.save();
  ctx.font = "11px ui-monospace, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const width = ctx.measureText(text).width + padding * 2;
  const boxX = centerX - width / 2;
  const boxY = Math.max(2, anchor.y * tileSize - height - 4);
  ctx.fillStyle = colors.badgeBackground;
  ctx.fillRect(boxX, boxY, width, height);
  ctx.fillStyle = colors.badgeText;
  ctx.fillText(text, centerX, boxY + height / 2);
  ctx.restore();
}

function renderRoadMutationPreview(
  ctx: CanvasRenderingContext2D,
  ui: UiState,
  removal: boolean,
): void {
  const preview = ui.roadMutationPreview;
  if (preview === null || preview.generation !== ui.roadPreviewGeneration) {
    return;
  }
  const changed = new Set(
    preview.changedTiles.map((point) => `${point.x},${point.y}`),
  );
  const skipped = new Set(
    preview.skippedTiles.map((point) => `${point.x},${point.y}`),
  );
  for (const point of [...preview.changedTiles, ...preview.skippedTiles]) {
    const key = `${point.x},${point.y}`;
    const valid = changed.has(key) && !skipped.has(key);
    ctx.fillStyle =
      valid && !removal ? colors.previewValid : colors.previewInvalid;
    ctx.strokeStyle =
      valid && !removal
        ? colors.previewValidStroke
        : colors.previewInvalidStroke;
    fillTile(ctx, point);
    strokeTile(ctx, point);
  }
  for (const structure of preview.generatedStructures) {
    ctx.fillStyle = colors.previewValid;
    ctx.strokeStyle = colors.previewValidStroke;
    for (const point of structure.footprint) {
      fillTile(ctx, point);
      strokeTile(ctx, point);
    }
  }
  if (preview.authoredTiles.length > 0) {
    ctx.save();
    ctx.strokeStyle = colors.previewValidStroke;
    ctx.lineWidth = 4;
    ctx.lineCap = "round";
    for (const tile of preview.authoredTiles) {
      drawAuthoredRoadConnections(ctx, tile);
    }
    ctx.restore();
  }
  const directed = preview.authoredTiles.filter((tile) => tile.oneWay !== null);
  if (directed.length > 0) {
    ctx.save();
    ctx.strokeStyle = colors.oneWayArrow;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const tile of directed) {
      if (tile.oneWay !== null) {
        drawDirectionArrow(ctx, tile.point, tile.oneWay);
      }
    }
    ctx.restore();
  }
  renderRoadPreviewFeedback(ctx, preview);
}

function renderDragPreview(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  ui: UiState,
): void {
  // The gesture is atomic — a non-null `drag` already implies a drag tool and a
  // concrete current tile, so this single check replaces the old three-field
  // guard (dragStart + hoverTile + activeTool).
  const gesture = ui.drag;
  if (gesture === null) {
    return;
  }
  ctx.lineWidth = 2;

  if (gesture.tool === "area") {
    for (const { point, paintable } of planAreaPaintPreview(
      state,
      gesture.start,
      gesture.current,
    )) {
      ctx.fillStyle = paintable ? colors.previewValid : colors.previewInvalid;
      ctx.strokeStyle = paintable
        ? colors.previewValidStroke
        : colors.previewInvalidStroke;
      fillTile(ctx, point);
      strokeTile(ctx, point);
    }
    return;
  }

  const line = axisLockedLine(gesture.start, gesture.current);
  if (gesture.tool === "track") {
    ctx.fillStyle = colors.previewValid;
    ctx.strokeStyle = colors.previewValidStroke;
    for (const point of line) {
      fillTile(ctx, point);
      strokeTile(ctx, point);
    }
    return;
  }

  renderRoadMutationPreview(ctx, ui, gesture.tool === "remove");
}

export function renderOverlays(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  ui: UiState,
): void {
  if (ui.activeOverlay === "coverage") {
    ctx.fillStyle = colors.coverage;

    for (const stop of state.transit.stops) {
      fillCoverageArea(ctx, stop.position, stopCoverageRadius(stop));
    }

    for (const station of state.transit.stations) {
      fillCoverageArea(ctx, station.position, 4);
    }
  }

  if (ui.activeOverlay === "lateness") {
    ctx.fillStyle = colors.lateness;

    for (const trip of overlayTrips(state)) {
      if (trip.status === "late" || trip.status === "unserved") {
        fillTile(ctx, trip.position);
      }
    }
  }

  if (ui.activeOverlay === "demand") {
    ctx.fillStyle = colors.demand;

    for (const trip of overlayTrips(state)) {
      if (trip.status !== "arrived") {
        fillTile(ctx, trip.destination);
      }
    }
  }

  if (ui.activeOverlay === "crowding") {
    const occupancy = selectPlatformOccupancy(state);
    const nodes = [...state.transit.stops, ...state.transit.stations];

    for (const node of nodes) {
      let maxRatio = 0;
      for (const platform of node.platforms) {
        const entry = occupancy.get(platform.id);
        if (entry !== undefined && entry.capacity > 0) {
          maxRatio = Math.max(maxRatio, entry.count / entry.capacity);
        }
      }

      if (maxRatio <= 0.5) {
        continue;
      }

      ctx.save();
      ctx.globalAlpha = maxRatio >= 1 ? 0.55 : 0.3;
      ctx.fillStyle = colors.crowding;
      fillTile(ctx, node.position);
      ctx.restore();
    }
  }

  if (ui.activeOverlay === "growth") {
    ctx.fillStyle = colors.growth;

    for (const wave of state.scenario.growthWaves) {
      if (wave.applied) {
        continue;
      }
      for (const action of wave.actions) {
        if (action.type === "paintAreaRectangle") {
          const minX = Math.min(action.start.x, action.end.x);
          const maxX = Math.max(action.start.x, action.end.x);
          const minY = Math.min(action.start.y, action.end.y);
          const maxY = Math.max(action.start.y, action.end.y);
          for (let y = minY; y <= maxY; y += 1) {
            for (let x = minX; x <= maxX; x += 1) {
              fillTile(ctx, { x, y });
            }
          }
        } else if (action.type === "placeBuilding") {
          for (const tile of getBuildingFootprint(
            action.buildingType,
            action.origin,
            action.rotation,
          )) {
            fillTile(ctx, tile);
          }
        }
      }
    }
  }

  if (ui.drag !== null) {
    renderDragPreview(ctx, state, ui);
    return;
  }

  if (ui.activeTool === "road" || ui.activeTool === "remove") {
    renderRoadMutationPreview(ctx, ui, ui.activeTool === "remove");
    if (ui.roadMutationPreview !== null) {
      return;
    }
  }

  if (ui.hoverTile !== null && ui.selectedBuilding !== null) {
    renderBuildingPreview(ctx, state, ui);
    return;
  }

  if (ui.hoverTile !== null && isInMap(state, ui.hoverTile)) {
    ctx.strokeStyle = colors.hover;
    ctx.lineWidth = 2;
    ctx.strokeRect(
      ui.hoverTile.x * tileSize + 2,
      ui.hoverTile.y * tileSize + 2,
      tileSize - 4,
      tileSize - 4,
    );
  }
}
