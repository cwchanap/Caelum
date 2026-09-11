import type { GameState, Point, RoadStructure } from "../../domain/types";
import { ROAD_DIRECTION_OFFSET } from "../../domain/types";
import type { AuthoredRoadTilePreview } from "../../runtime/backend/types";
import {
  buildRoadMutationPreview,
  selectRouteEditorView,
} from "../../runtime/runtimeSelectors";
import { getBuildingFootprint } from "../../domain/catalog/buildings";
import { stopCoverageRadius } from "../../domain/catalog/transit";
import {
  canPlaceBusStop,
  isAreaPaintable,
  isBuildingAffordableForPresentation,
  canPlaceBuilding,
} from "../placementValidation";
import { axisLockedLine, rectanglePoints } from "../../ui/roadDrag";
import type { UiState } from "../../ui/uiState";
import { tileSize } from "../boardTransform";
import { colors } from "../colors";
import { failedLegMarkerPoint } from "../mapTextOverlay";
import { directionArrow } from "./mapBatch";
import { draftLegVertices } from "./transitBatch";
import { SolidGeometry, parseColor, withAlpha } from "./primitives";

const previewStrokeInset = 2;

/** Presentation flow is derived in Rust against the same road-capacity model. */
const ROAD_FLOW_CAPACITY = 4;
const MAX_CONGESTION_MULTIPLIER = 3;

const HOVER = parseColor(colors.hover);
const MISSING_HANDLE_DASH = { dash: 4, gap: 3 };
const BADGE_BACKGROUND = parseColor(colors.badgeBackground);
const BADGE_TEXT = parseColor(colors.badgeText);
const UNSERVED = parseColor(colors.unserved);
const LATE = parseColor(colors.late);
const PREVIEW_VALID = parseColor(colors.previewValid);
const PREVIEW_INVALID = parseColor(colors.previewInvalid);
const PREVIEW_VALID_STROKE = parseColor(colors.previewValidStroke);
const PREVIEW_INVALID_STROKE = parseColor(colors.previewInvalidStroke);
const ONE_WAY_ARROW = parseColor(colors.oneWayArrow);
const COVERAGE = parseColor(colors.coverage);
const DEMAND = parseColor(colors.demand);
const TRAFFIC = parseColor(colors.traffic);
const CROWDING = parseColor(colors.crowding);

type Rgb = ReturnType<typeof parseColor>;

/** Repeated demand saturates: each additional destination multiplies the
 *  remaining opacity, so stacks darken smoothly instead of overdrawing. */
function demandAlpha(count: number): number {
  return 1 - Math.pow(1 - 0.24, count);
}

function strokeRect(
  g: SolidGeometry,
  x: number,
  y: number,
  width: number,
  height: number,
  thickness: number,
  color: Rgb,
): void {
  g.thickLine({ x, y }, { x: x + width, y }, thickness, color);
  g.thickLine(
    { x: x + width, y },
    { x: x + width, y: y + height },
    thickness,
    color,
  );
  g.thickLine(
    { x: x + width, y: y + height },
    { x, y: y + height },
    thickness,
    color,
  );
  g.thickLine({ x, y: y + height }, { x, y }, thickness, color);
}

function fillTile(g: SolidGeometry, point: Point, color: Rgb): void {
  g.rect(point.x * tileSize, point.y * tileSize, tileSize, tileSize, color);
}

function strokeTile(g: SolidGeometry, point: Point, color: Rgb): void {
  strokeRect(
    g,
    point.x * tileSize + previewStrokeInset,
    point.y * tileSize + previewStrokeInset,
    tileSize - previewStrokeInset * 2,
    tileSize - previewStrokeInset * 2,
    2,
    color,
  );
}

function isInMap(state: GameState, point: Point): boolean {
  return (
    point.x >= 0 &&
    point.x < state.map.width &&
    point.y >= 0 &&
    point.y < state.map.height
  );
}

function drawDataOverlays(
  g: SolidGeometry,
  state: GameState,
  ui: UiState,
): void {
  if (ui.activeOverlay === "coverage") {
    for (const stop of state.transit.stops) {
      if (stop.status !== "present") continue;
      const radius = stopCoverageRadius(stop);
      g.rect(
        (stop.position.x - radius) * tileSize,
        (stop.position.y - radius) * tileSize,
        tileSize * (radius * 2 + 1),
        tileSize * (radius * 2 + 1),
        COVERAGE,
      );
    }
    for (const station of state.transit.stations) {
      if (station.status !== "present") continue;
      g.rect(
        (station.position.x - 4) * tileSize,
        (station.position.y - 4) * tileSize,
        tileSize * 9,
        tileSize * 9,
        COVERAGE,
      );
    }
  }

  if (ui.activeOverlay === "demand") {
    for (const row of state.demandFlow) {
      fillTile(g, row.point, withAlpha(DEMAND, demandAlpha(row.count)));
    }
  }

  if (ui.activeOverlay === "traffic") {
    const fullScaleFlow = ROAD_FLOW_CAPACITY * MAX_CONGESTION_MULTIPLIER;
    for (const row of state.trafficFlow) {
      fillTile(
        g,
        row.point,
        withAlpha(TRAFFIC, Math.min(row.flow / fullScaleFlow, 1)),
      );
    }
  }

  if (ui.activeOverlay === "crowding") {
    const occupancyByPlatform = new Map(
      state.platformOccupancy.map((row) => [row.platformId, row]),
    );
    const nodes = [...state.transit.stops, ...state.transit.stations].filter(
      (node) => node.status === "present",
    );
    for (const node of nodes) {
      let maxRatio = 0;
      for (const platform of node.platforms) {
        const entry = occupancyByPlatform.get(platform.id);
        if (entry !== undefined && entry.capacity > 0) {
          maxRatio = Math.max(maxRatio, entry.count / entry.capacity);
        }
      }
      if (maxRatio <= 0.5) continue;
      fillTile(
        g,
        node.position,
        withAlpha(CROWDING, maxRatio >= 1 ? 0.55 : 0.3),
      );
    }
  }
}

function drawBrokenRouteMarkers(
  g: SolidGeometry,
  state: GameState,
  ui: UiState,
): void {
  if (ui.selectedRouteId === null) return;
  const selected =
    state.transit.routes.find((route) => route.id === ui.selectedRouteId) ??
    state.transit.metroLines.find((line) => line.id === ui.selectedRouteId);
  if (selected === undefined) return;

  selected.legs.forEach((leg, legIndex) => {
    if (leg.status === "connected") return;
    const marker = failedLegMarkerPoint(state, leg);
    if (marker === null) return;
    const x = marker.x * tileSize + tileSize / 2;
    const y = marker.y * tileSize + tileSize / 2;
    const focused =
      ui.routeFailureFocus?.routeId === selected.id &&
      ui.routeFailureFocus.legIndex === legIndex;
    const lineWidth = focused ? 4 : 3;
    if (leg.status === "missingNode") {
      strokeRect(g, x - 8, y - 8, 16, 16, lineWidth, UNSERVED);
      g.thickLine(
        { x: x - 5, y: y - 5 },
        { x: x + 5, y: y + 5 },
        lineWidth,
        UNSERVED,
      );
      g.thickLine(
        { x: x + 5, y: y - 5 },
        { x: x - 5, y: y + 5 },
        lineWidth,
        UNSERVED,
      );
    } else {
      g.circle({ x, y }, focused ? 8 : 6, LATE);
    }
  });
}

type RoundaboutStructure = Extract<RoadStructure, { kind: "roundabout" }>;

function drawRoundaboutPreviewStructure(
  g: SolidGeometry,
  structure: RoundaboutStructure,
  valid: boolean,
  alreadyFilled: ReadonlySet<string>,
): void {
  const fillColor = valid ? PREVIEW_VALID : PREVIEW_INVALID;
  const strokeColor = valid ? PREVIEW_VALID_STROKE : PREVIEW_INVALID_STROKE;

  for (const point of structure.footprint) {
    if (!alreadyFilled.has(`${point.x},${point.y}`)) {
      fillTile(g, point, fillColor);
    }
  }

  if (structure.footprint.length > 0) {
    const xs = structure.footprint.map((point) => point.x);
    const ys = structure.footprint.map((point) => point.y);
    strokeRect(
      g,
      Math.min(...xs) * tileSize,
      Math.min(...ys) * tileSize,
      (Math.max(...xs) - Math.min(...xs) + 1) * tileSize,
      (Math.max(...ys) - Math.min(...ys) + 1) * tileSize,
      3,
      strokeColor,
    );
  }

  if (structure.size === "standard3x3") {
    // The authoritative 3x3 footprint owns its center even though that tile
    // is not carriageway: mark the protected island distinctly.
    g.rect(
      (structure.origin.x + 1.25) * tileSize,
      (structure.origin.y + 1.25) * tileSize,
      tileSize / 2,
      tileSize / 2,
      BADGE_BACKGROUND,
    );
  }

  for (const port of structure.ports) {
    const left = port.point.x * tileSize;
    const top = port.point.y * tileSize;
    const centerX = left + tileSize / 2;
    const centerY = top + tileSize / 2;
    const tick = tileSize / 4;
    if (port.edge === "north") {
      g.thickLine(
        { x: centerX, y: top },
        { x: centerX, y: top + tick },
        3,
        strokeColor,
      );
    } else if (port.edge === "east") {
      g.thickLine(
        { x: left + tileSize, y: centerY },
        { x: left + tileSize - tick, y: centerY },
        3,
        strokeColor,
      );
    } else if (port.edge === "south") {
      g.thickLine(
        { x: centerX, y: top + tileSize },
        { x: centerX, y: top + tileSize - tick },
        3,
        strokeColor,
      );
    } else {
      g.thickLine(
        { x: left, y: centerY },
        { x: left + tick, y: centerY },
        3,
        strokeColor,
      );
    }
  }
}

function drawAuthoredRoadConnections(
  g: SolidGeometry,
  tile: AuthoredRoadTilePreview,
): void {
  const centerX = tile.point.x * tileSize + tileSize / 2;
  const centerY = tile.point.y * tileSize + tileSize / 2;
  for (const heading of tile.roadConnections) {
    const offset = ROAD_DIRECTION_OFFSET[heading];
    g.thickLine(
      { x: centerX, y: centerY },
      {
        x: centerX + (offset.x * tileSize) / 2,
        y: centerY + (offset.y * tileSize) / 2,
      },
      4,
      PREVIEW_VALID_STROKE,
    );
  }
}

function drawRoadMutationPreview(
  g: SolidGeometry,
  state: GameState,
  ui: UiState,
  removal: boolean,
): void {
  const preview = buildRoadMutationPreview(state, ui);
  if (preview === null) return;

  const changed = new Set(
    preview.changedTiles.map((point) => `${point.x},${point.y}`),
  );
  const skipped = new Set(
    preview.skippedTiles.map((point) => `${point.x},${point.y}`),
  );
  const roundabouts = preview.generatedStructures.filter(
    (structure): structure is RoundaboutStructure =>
      structure.kind === "roundabout",
  );
  const roundaboutFootprint = new Set(
    roundabouts.flatMap((structure) =>
      structure.footprint.map((point) => `${point.x},${point.y}`),
    ),
  );
  const previewAccepted = preview.rejection === null;

  for (const point of [...preview.changedTiles, ...preview.skippedTiles]) {
    const key = `${point.x},${point.y}`;
    const valid =
      previewAccepted && changed.has(key) && !skipped.has(key) && !removal;
    fillTile(g, point, valid ? PREVIEW_VALID : PREVIEW_INVALID);
    if (!roundaboutFootprint.has(key)) {
      strokeTile(
        g,
        point,
        valid ? PREVIEW_VALID_STROKE : PREVIEW_INVALID_STROKE,
      );
    }
  }
  for (const structure of preview.generatedStructures) {
    if (structure.kind === "roundabout") {
      drawRoundaboutPreviewStructure(
        g,
        structure,
        previewAccepted && !removal,
        changed,
      );
      continue;
    }
    const fillColor = previewAccepted ? PREVIEW_VALID : PREVIEW_INVALID;
    const strokeColor = previewAccepted
      ? PREVIEW_VALID_STROKE
      : PREVIEW_INVALID_STROKE;
    for (const point of structure.footprint) {
      fillTile(g, point, fillColor);
      strokeTile(g, point, strokeColor);
    }
  }
  for (const tile of preview.authoredTiles) {
    drawAuthoredRoadConnections(g, tile);
  }
  for (const tile of preview.authoredTiles) {
    if (tile.oneWay != null) {
      directionArrow(g, tile.point, tile.oneWay, ONE_WAY_ARROW);
    }
  }
}

function drawDragPreview(
  g: SolidGeometry,
  state: GameState,
  ui: UiState,
): void {
  const gesture = ui.drag;
  if (gesture === null) return;

  if (gesture.tool === "area") {
    for (const point of rectanglePoints(gesture.start, gesture.current)) {
      const paintable = isAreaPaintable(state, point);
      fillTile(g, point, paintable ? PREVIEW_VALID : PREVIEW_INVALID);
      strokeTile(
        g,
        point,
        paintable ? PREVIEW_VALID_STROKE : PREVIEW_INVALID_STROKE,
      );
    }
    return;
  }

  const line = axisLockedLine(gesture.start, gesture.current);
  if (gesture.tool === "track") {
    for (const point of line) {
      fillTile(g, point, PREVIEW_VALID);
      strokeTile(g, point, PREVIEW_VALID_STROKE);
    }
    return;
  }

  drawRoadMutationPreview(g, state, ui, gesture.tool === "remove");
}

function drawBuildingPreview(
  g: SolidGeometry,
  state: GameState,
  ui: UiState,
): void {
  if (ui.hoverTile === null || ui.selectedBuilding === null) return;
  const validPlacement =
    isBuildingAffordableForPresentation(state, ui.selectedBuilding) &&
    canPlaceBuilding(
      state,
      ui.selectedBuilding,
      ui.hoverTile,
      ui.buildingRotation,
    );
  const fill = validPlacement ? PREVIEW_VALID : PREVIEW_INVALID;
  const stroke = validPlacement ? PREVIEW_VALID_STROKE : PREVIEW_INVALID_STROKE;
  for (const point of getBuildingFootprint(
    ui.selectedBuilding,
    ui.hoverTile,
    ui.buildingRotation,
  )) {
    fillTile(g, point, fill);
    strokeTile(g, point, stroke);
  }
}

function drawBusStopPreview(
  g: SolidGeometry,
  state: GameState,
  ui: UiState,
): void {
  if (ui.hoverTile === null) return;
  const validPlacement = canPlaceBusStop(state, ui.hoverTile);
  const fill = validPlacement ? PREVIEW_VALID : PREVIEW_INVALID;
  const stroke = validPlacement ? PREVIEW_VALID_STROKE : PREVIEW_INVALID_STROKE;
  fillTile(g, ui.hoverTile, fill);
  strokeTile(g, ui.hoverTile, stroke);
}

function drawHoverHighlight(g: SolidGeometry, hoverTile: Point): void {
  strokeRect(
    g,
    hoverTile.x * tileSize + 2,
    hoverTile.y * tileSize + 2,
    tileSize - 4,
    tileSize - 4,
    2,
    HOVER,
  );
}

function drawNumberedHandle(
  g: SolidGeometry,
  position: Point,
  selected: boolean,
  missing: boolean,
): void {
  const x = position.x * tileSize + tileSize / 2;
  const y = position.y * tileSize + tileSize / 2;
  const radius = selected ? 12 : 10;
  const lineWidth = selected ? 4 : 2;
  const stroke = missing ? UNSERVED : BADGE_TEXT;
  g.circle({ x, y }, radius, BADGE_BACKGROUND);
  // Canvas strokes the arc centered on the radius; the ring spans inward
  // from its radius, so pass radius + half the stroke width. The missing
  // ring is dashed [4,3] like the canvas renderer's setLineDash.
  if (missing) {
    g.dashedCurve(
      {
        kind: "arc",
        center: { x, y },
        radius,
        startRadians: 0,
        sweepRadians: Math.PI * 2,
      },
      lineWidth,
      MISSING_HANDLE_DASH.dash,
      MISSING_HANDLE_DASH.gap,
      stroke,
    );
  } else {
    g.ring({ x, y }, radius + lineWidth / 2, lineWidth, stroke);
  }
  // The cross is dashed [4,3] too, matching the canvas renderer.
  if (missing) {
    g.dashedLine(
      { x: x - 6, y: y - 6 },
      { x: x + 6, y: y + 6 },
      lineWidth,
      MISSING_HANDLE_DASH.dash,
      MISSING_HANDLE_DASH.gap,
      stroke,
    );
    g.dashedLine(
      { x: x + 6, y: y - 6 },
      { x: x - 6, y: y + 6 },
      lineWidth,
      MISSING_HANDLE_DASH.dash,
      MISSING_HANDLE_DASH.gap,
      stroke,
    );
  }
}

function drawOverVehicles(
  state: GameState,
  ui: UiState,
): Float32Array<ArrayBuffer> {
  const g = new SolidGeometry();
  const routeEditor = selectRouteEditorView(state, ui, null);
  if (routeEditor === null) return g.toFloat32Array();
  const nodePositions = new Map(
    [...state.transit.stops, ...state.transit.stations].map((node) => [
      node.id,
      node.position,
    ]),
  );
  for (const waypoint of routeEditor.waypoints) {
    const position = nodePositions.get(waypoint.id);
    if (!position) continue;
    drawNumberedHandle(
      g,
      position,
      waypoint.selected,
      waypoint.status === "missing",
    );
  }
  return g.toFloat32Array();
}

/**
 * Tessellates the three dynamic overlay ranges in painter order:
 * `underRoutes` (data overlays, broken-route markers, previews),
 * `routeDraft` (draft stroke), and `overVehicles` (route-handle
 * circles/crosses). Map-local text stays DOM-side; no text geometry here.
 */
export function buildOverlayRanges(
  state: GameState,
  ui: UiState,
): {
  underRoutes: Float32Array<ArrayBuffer>;
  routeDraft: Float32Array<ArrayBuffer>;
  overVehicles: Float32Array<ArrayBuffer>;
} {
  const g = new SolidGeometry();

  drawDataOverlays(g, state, ui);
  drawBrokenRouteMarkers(g, state, ui);

  let previewsRendered = false;
  if (ui.drag !== null) {
    drawDragPreview(g, state, ui);
    previewsRendered = true;
  } else if (
    ui.activeTool === "road" ||
    ui.activeTool === "roundabout" ||
    ui.activeTool === "remove"
  ) {
    drawRoadMutationPreview(g, state, ui, ui.activeTool === "remove");
    previewsRendered = ui.roadMutationPreview !== null;
  }

  if (!previewsRendered) {
    if (ui.hoverTile !== null && ui.selectedBuilding !== null) {
      drawBuildingPreview(g, state, ui);
    } else if (ui.hoverTile !== null && ui.activeTool === "busStop") {
      drawBusStopPreview(g, state, ui);
    } else if (ui.hoverTile !== null && isInMap(state, ui.hoverTile)) {
      drawHoverHighlight(g, ui.hoverTile);
    }
  }

  return {
    underRoutes: g.toFloat32Array(),
    routeDraft: draftLegVertices(state, ui),
    overVehicles: drawOverVehicles(state, ui),
  };
}
