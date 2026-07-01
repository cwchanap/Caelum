import type {
  ActiveTrip,
  GameMap,
  GameState,
  Point,
  Tile,
} from "../domain/types";
import {
  BUILDING_CATALOG,
  getBuildingFootprint,
} from "../domain/catalog/buildings";
import { stopCoverageRadius } from "../domain/catalog/transit";
// NOTE: The geometry helpers below (axisLockedLine, lineDirection,
// oppositeDirection, reverseLanePoints) mirror the authoritative Rust road
// geometry in `crates/caelum-core/src/transit.rs` (`lay_road_line`,
// `line_direction`, `opposite_direction`, `reverse_lane_points`). They are
// read-only preview helpers here — the Rust core is the sole authority for
// actual tile placement. If the Rust geometry changes, update these to match
// or the drag preview will drift from what the backend actually places.
import {
  axisLockedLine,
  lineDirection,
  oppositeDirection,
  planDragPreview,
  reverseLanePoints,
} from "../ui/roadDrag";
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

function positionKey(x: number, y: number): string {
  return `${x},${y}`;
}

function waitingLineId(entity: ActiveTrip): string | undefined {
  const leg = entity.routePlan?.legs[entity.currentLegIndex];
  return leg !== undefined && leg.mode !== "walk" ? leg.lineId : undefined;
}

function selectPlatformOccupancy(
  state: GameState,
): Map<string, { count: number; capacity: number }> {
  const occupancy = new Map<string, { count: number; capacity: number }>();
  const platformByPositionAndRoute = new Map<string, string>();
  const nodes = [...state.transit.stops, ...state.transit.stations];

  for (const node of nodes) {
    const posKey = positionKey(node.position.x, node.position.y);
    for (const platform of node.platforms) {
      occupancy.set(platform.id, { count: 0, capacity: platform.capacity });
      for (const routeId of platform.routeIds) {
        platformByPositionAndRoute.set(`${posKey}|${routeId}`, platform.id);
      }
    }
  }

  for (const entity of state.activeTrips ?? []) {
    if (entity.status !== "waiting") {
      continue;
    }
    const lineId = waitingLineId(entity);
    if (lineId === undefined) {
      continue;
    }
    const platformId = platformByPositionAndRoute.get(
      `${positionKey(entity.position.x, entity.position.y)}|${lineId}`,
    );
    const entry =
      platformId === undefined ? undefined : occupancy.get(platformId);
    if (entry !== undefined) {
      entry.count += 1;
    }
  }

  return occupancy;
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

  const isDelete = gesture.tool === "remove";
  const line = axisLockedLine(gesture.start, gesture.current);

  // Per-tile validity mirrors the commit path: a tile tints green only where a
  // road/track would actually land, and red where it collides, runs off-map, or
  // is unaffordable. The remove tool has no per-tile predicate — tint red.
  if (isDelete) {
    ctx.fillStyle = colors.previewInvalid;
    ctx.strokeStyle = colors.previewInvalidStroke;
    for (const point of line) {
      fillTile(ctx, point);
      strokeTile(ctx, point);
    }
  } else {
    for (const { point, buildable } of planDragPreview(state, ui, line)) {
      ctx.fillStyle = buildable ? colors.previewValid : colors.previewInvalid;
      ctx.strokeStyle = buildable
        ? colors.previewValidStroke
        : colors.previewInvalidStroke;
      fillTile(ctx, point);
      strokeTile(ctx, point);
    }
  }

  // Dual preset direction arrows: the oneWay preset shows the drag-axis
  // direction; dualBidirectional shows forward + opposing arrows.
  // twoWay / track / remove carry no per-tile direction, so they draw none.
  if (gesture.tool === "road") {
    const forward = lineDirection(line);
    if (forward !== null) {
      ctx.save();
      // Set an explicit arrow color: without this the arrows inherit the
      // strokeStyle left by the last tile of the per-tile preview loop above,
      // so every arrow would render red/green based on the line's final tile
      // instead of a stable glyph color. Mirrors renderMap's committed arrows.
      ctx.strokeStyle = colors.oneWayArrow;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      if (ui.roadPreset === "oneWay") {
        for (const point of line) {
          drawDirectionArrow(ctx, point, forward);
        }
      } else if (ui.roadPreset === "dualBidirectional") {
        const reverse = reverseLanePoints(line);
        const reverseDir = oppositeDirection(forward);
        for (const point of line) {
          drawDirectionArrow(ctx, point, forward);
        }
        for (const point of reverse) {
          drawDirectionArrow(ctx, point, reverseDir);
        }
      }
      ctx.restore();
    }
  }
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
      if (!wave.applied) {
        for (const tile of wave.tiles) {
          fillTile(ctx, tile);
        }
      }
    }
  }

  if (ui.drag !== null) {
    renderDragPreview(ctx, state, ui);
    return;
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
