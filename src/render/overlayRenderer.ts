import type { GameState, Point } from "../domain/types";
import {
  BUILDING_CATALOG,
  canPlaceBuilding,
  getBuildingFootprint,
} from "../simulation/buildings";
import { stopCoverageRadius } from "../simulation/transit";
import type { UiState } from "../ui/uiState";
import { tileSize } from "./canvas";
import { colors } from "./colors";

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
    ctx.fillStyle = colors.crowding;

    for (const stop of state.transit.stops) {
      if (stop.queueCitizenIds.length > 0) {
        fillTile(ctx, stop.position);
      }
    }

    for (const station of state.transit.stations) {
      if (station.queueCitizenIds.length > 0) {
        fillTile(ctx, station.position);
      }
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
