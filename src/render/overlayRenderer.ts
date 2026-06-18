import type { GameState, Point } from "../domain/types";
import {
  BUILDING_CATALOG,
  canPlaceBuilding,
  getBuildingFootprint,
} from "../simulation/buildings";
import { selectPlatformOccupancy } from "../simulation/platforms";
import { stopCoverageRadius } from "../simulation/transit";
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
  const isDelete = gesture.tool === "remove";
  ctx.lineWidth = 2;
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

    for (const citizen of state.citizens) {
      if (citizen.status === "late" || citizen.status === "unserved") {
        fillTile(ctx, citizen.position);
      }
    }
  }

  if (ui.activeOverlay === "demand") {
    ctx.fillStyle = colors.demand;

    for (const citizen of state.citizens) {
      if (citizen.status !== "arrived") {
        fillTile(ctx, citizen.destination);
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
