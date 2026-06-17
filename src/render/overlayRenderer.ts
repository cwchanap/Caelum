import type { GameState, Point, Tool } from "../domain/types";
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

const DRAG_PREVIEW_TOOLS: Tool[] = ["road", "track", "remove"];

function renderDragPreview(ctx: CanvasRenderingContext2D, ui: UiState): void {
  if (
    ui.dragStart === null ||
    ui.hoverTile === null ||
    !DRAG_PREVIEW_TOOLS.includes(ui.activeTool)
  ) {
    return;
  }
  const isDelete = ui.activeTool === "remove";
  ctx.fillStyle = isDelete ? colors.previewInvalid : colors.previewValid;
  ctx.strokeStyle = isDelete
    ? colors.previewInvalidStroke
    : colors.previewValidStroke;
  ctx.lineWidth = 2;
  const line = axisLockedLine(ui.dragStart, ui.hoverTile);
  // Dual preset shows both lanes so the 2-lane footprint is visible while
  // dragging; reverse-lane tiles sit left-of-travel (right-hand traffic).
  const isDual =
    ui.activeTool === "road" && ui.roadPreset === "dualBidirectional";
  const reverse = isDual ? reverseLanePoints(line) : [];
  const tiles = isDual ? [...line, ...reverse] : line;
  for (const point of tiles) {
    fillTile(ctx, point);
    strokeTile(ctx, point);
  }

  // Direction arrows on the preview (design spec §E): the oneWay preset shows
  // the drag-axis direction; dualBidirectional shows forward + opposing arrows.
  // twoWay / track / remove carry no per-tile direction, so they draw none.
  if (ui.activeTool === "road") {
    const forward = lineDirection(line);
    if (forward !== null) {
      ctx.save();
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      if (ui.roadPreset === "oneWay") {
        for (const point of line) {
          drawDirectionArrow(ctx, point, forward);
        }
      } else if (isDual) {
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

  if (ui.dragStart !== null) {
    renderDragPreview(ctx, ui);
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
