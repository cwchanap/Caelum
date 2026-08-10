import {
  ROAD_DIRECTION_OFFSET,
  type ActiveTrip,
  type GameState,
  type Point,
  type RoadStructure,
  type RouteLegPath,
  type TransitPath,
  type TripPosition,
} from "../domain/types";
import type { AuthoredRoadTilePreview } from "../runtime/backend/types";
import {
  buildRoadMutationPreview,
  selectRouteEditorView,
  selectRouteFailures,
} from "../runtime/runtimeSelectors";
import type {
  RoadMutationPreviewView,
  RouteEditorView,
} from "../runtime/types";
import { getBuildingFootprint } from "../domain/catalog/buildings";
import { stopCoverageRadius } from "../domain/catalog/transit";
import { selectPlatformOccupancy } from "../domain/platformOccupancy";
import { axisLockedLine } from "../ui/roadDrag";
import type { UiState } from "../ui/uiState";
import { tileSize, type BoardTransform } from "./canvas";
import { colors } from "./colors";
import { drawDirectionArrow } from "./mapRenderer";
import { pointAndTangentAt } from "./pathRenderer";
import {
  canPlaceBuilding,
  canPlaceBusStop,
  isBuildingAffordableForPresentation,
  isAreaPaintable,
} from "./placementValidation";

const previewStrokeInset = 2;

type RoundaboutStructure = Extract<RoadStructure, { kind: "roundabout" }>;

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
    isBuildingAffordableForPresentation(state, ui.selectedBuilding) &&
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

function renderBusStopPreview(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  ui: UiState,
): void {
  if (ui.hoverTile === null) return;

  const validPlacement = canPlaceBusStop(state, ui.hoverTile);
  ctx.fillStyle = validPlacement ? colors.previewValid : colors.previewInvalid;
  ctx.strokeStyle = validPlacement
    ? colors.previewValidStroke
    : colors.previewInvalidStroke;
  ctx.lineWidth = 2;
  fillTile(ctx, ui.hoverTile);
  strokeTile(ctx, ui.hoverTile);
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
  left: RoadMutationPreviewView["routeImpacts"][number],
  right: RoadMutationPreviewView["routeImpacts"][number],
): number {
  if (left.routeName !== right.routeName) {
    return left.routeName < right.routeName ? -1 : 1;
  }
  if (left.kind === right.kind) return 0;
  return left.kind < right.kind ? -1 : 1;
}

function roadPreviewFeedback(preview: RoadMutationPreviewView): string {
  const impacts = [...preview.routeImpacts]
    .sort(compareRouteImpacts)
    .map((impact) => `${impact.routeName} ${impact.kind}`)
    .join(" · ");
  const cost = preview.costLabel;
  return impacts.length === 0 ? cost : `${cost} · ${impacts}`;
}

function roadPreviewAnchor(preview: RoadMutationPreviewView): Point {
  return (
    preview.authoredTiles[0]?.point ??
    preview.changedTiles[0] ??
    preview.generatedStructures[0]?.footprint[0] ?? { x: 0, y: 0 }
  );
}

function renderRoadPreviewFeedback(
  ctx: CanvasRenderingContext2D,
  preview: RoadMutationPreviewView,
  transform: BoardTransform,
): void {
  const text = roadPreviewFeedback(preview);
  const anchor = roadPreviewAnchor(preview);
  // Position math bakes in the board transform (offset + scale) so this
  // can be drawn in the untransformed context (after ctx.restore()), just
  // like renderCursorBadge. DPR scaling keeps the on-screen size constant.
  const dpr = globalThis.devicePixelRatio ?? 1;
  const centerX =
    transform.offsetX + (anchor.x + 0.5) * tileSize * transform.scale;
  const height = 18 * dpr;
  const padding = 4 * dpr;

  ctx.save();
  ctx.font = `${11 * dpr}px ui-monospace, monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const width = ctx.measureText(text).width + padding * 2;
  const boxX = centerX - width / 2;
  const anchorY = transform.offsetY + anchor.y * tileSize * transform.scale;
  const boxY = Math.max(2, anchorY - height - 4 * dpr);
  ctx.fillStyle = colors.badgeBackground;
  ctx.fillRect(boxX, boxY, width, height);
  ctx.fillStyle = colors.badgeText;
  ctx.fillText(text, centerX, boxY + height / 2);
  ctx.restore();
}

function renderRoundaboutPreviewStructure(
  ctx: CanvasRenderingContext2D,
  structure: RoundaboutStructure,
  valid: boolean,
  alreadyFilled: ReadonlySet<string>,
): void {
  const fillColor = valid ? colors.previewValid : colors.previewInvalid;
  const strokeColor = valid
    ? colors.previewValidStroke
    : colors.previewInvalidStroke;

  ctx.fillStyle = fillColor;
  for (const point of structure.footprint) {
    if (!alreadyFilled.has(`${point.x},${point.y}`)) {
      fillTile(ctx, point);
    }
  }

  if (structure.footprint.length > 0) {
    const xs = structure.footprint.map((point) => point.x);
    const ys = structure.footprint.map((point) => point.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 3;
    ctx.strokeRect(
      minX * tileSize,
      minY * tileSize,
      (maxX - minX + 1) * tileSize,
      (maxY - minY + 1) * tileSize,
    );
  }

  if (structure.size === "standard3x3") {
    // The authoritative 3x3 footprint owns its center even though that tile is
    // not carriageway. Mark the protected island distinctly so the preview
    // does not suggest it remains buildable.
    ctx.fillStyle = colors.badgeBackground;
    ctx.fillRect(
      (structure.origin.x + 1.25) * tileSize,
      (structure.origin.y + 1.25) * tileSize,
      tileSize / 2,
      tileSize / 2,
    );
  }

  if (structure.ports.length === 0) {
    return;
  }
  ctx.beginPath();
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  for (const port of structure.ports) {
    const left = port.point.x * tileSize;
    const top = port.point.y * tileSize;
    const centerX = left + tileSize / 2;
    const centerY = top + tileSize / 2;
    const tick = tileSize / 4;
    if (port.edge === "north") {
      ctx.moveTo(centerX, top);
      ctx.lineTo(centerX, top + tick);
    } else if (port.edge === "east") {
      ctx.moveTo(left + tileSize, centerY);
      ctx.lineTo(left + tileSize - tick, centerY);
    } else if (port.edge === "south") {
      ctx.moveTo(centerX, top + tileSize);
      ctx.lineTo(centerX, top + tileSize - tick);
    } else {
      ctx.moveTo(left, centerY);
      ctx.lineTo(left + tick, centerY);
    }
  }
  ctx.stroke();
}

function renderRoadMutationPreview(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  ui: UiState,
  removal: boolean,
  precomputed: RoadMutationPreviewView | null | undefined,
): void {
  const preview = precomputed ?? buildRoadMutationPreview(state, ui);
  if (preview === null) {
    return;
  }
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
    ctx.fillStyle = valid ? colors.previewValid : colors.previewInvalid;
    ctx.strokeStyle = valid
      ? colors.previewValidStroke
      : colors.previewInvalidStroke;
    fillTile(ctx, point);
    if (!roundaboutFootprint.has(key)) {
      strokeTile(ctx, point);
    }
  }
  for (const structure of preview.generatedStructures) {
    if (structure.kind === "roundabout") {
      renderRoundaboutPreviewStructure(
        ctx,
        structure,
        previewAccepted && !removal,
        changed,
      );
      continue;
    }
    ctx.fillStyle = previewAccepted
      ? colors.previewValid
      : colors.previewInvalid;
    ctx.strokeStyle = previewAccepted
      ? colors.previewValidStroke
      : colors.previewInvalidStroke;
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
  const directed = preview.authoredTiles.filter((tile) => tile.oneWay != null);
  if (directed.length > 0) {
    ctx.save();
    ctx.strokeStyle = colors.oneWayArrow;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const tile of directed) {
      if (tile.oneWay != null) {
        drawDirectionArrow(ctx, tile.point, tile.oneWay);
      }
    }
    ctx.restore();
  }
  // Road preview feedback text is drawn in the untransformed context by
  // `renderRoadPreviewFeedbackBadge` (called from `renderGame` after
  // ctx.restore()) so its on-screen size stays consistent with the cursor
  // badge regardless of board scale.
}

function renderDragPreview(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  ui: UiState,
  roadPreview: RoadMutationPreviewView | null | undefined,
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

  renderRoadMutationPreview(
    ctx,
    state,
    ui,
    gesture.tool === "remove",
    roadPreview,
  );
}

function transitNode(state: GameState, nodeId: string) {
  return (
    state.transit.stops.find((node) => node.id === nodeId) ??
    state.transit.stations.find((node) => node.id === nodeId)
  );
}

function drawNumberedHandle(
  ctx: CanvasRenderingContext2D,
  position: TripPosition,
  number: number,
  options: { selected: boolean; missing: boolean },
): void {
  const x = position.x * tileSize + tileSize / 2;
  const y = position.y * tileSize + tileSize / 2;
  const radius = options.selected ? 12 : 10;
  ctx.save();
  ctx.setLineDash(options.missing ? [4, 3] : []);
  ctx.lineWidth = options.selected ? 4 : 2;
  ctx.strokeStyle = options.missing ? colors.unserved : colors.badgeText;
  ctx.fillStyle = colors.badgeBackground;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  if (options.missing) {
    ctx.beginPath();
    ctx.moveTo(x - 6, y - 6);
    ctx.lineTo(x + 6, y + 6);
    ctx.moveTo(x + 6, y - 6);
    ctx.lineTo(x - 6, y + 6);
    ctx.stroke();
  }
  ctx.font = "bold 11px ui-monospace, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = colors.badgeText;
  ctx.fillText(String(number), x, y);
  ctx.restore();
}

export function renderRouteDraftHandles(
  ctx: CanvasRenderingContext2D,
  editor: RouteEditorView,
  nodePositions: ReadonlyMap<string, TripPosition>,
): void {
  for (const waypoint of editor.waypoints) {
    const position = nodePositions.get(waypoint.id);
    if (!position) continue;
    drawNumberedHandle(ctx, position, waypoint.index + 1, {
      selected: waypoint.selected,
      missing: waypoint.status === "missing",
    });
  }
}

export function renderRouteDraftHandleOverlay(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  ui: UiState,
): void {
  const routeEditor = selectRouteEditorView(state, ui, null);
  if (routeEditor === null) return;
  renderRouteDraftHandles(
    ctx,
    routeEditor,
    new Map(
      [...state.transit.stops, ...state.transit.stations].map((node) => [
        node.id,
        node.position,
      ]),
    ),
  );
}

function pathMidpoint(path: TransitPath): TripPosition | null {
  if (path.steps.length === 0) {
    return null;
  }
  const target = path.totalTravelSeconds / 2;
  let elapsed = 0;
  for (const step of path.steps) {
    const next = elapsed + step.travelSeconds;
    if (target <= next || step === path.steps.at(-1)) {
      const progress =
        step.travelSeconds <= 0 ? 0.5 : (target - elapsed) / step.travelSeconds;
      return pointAndTangentAt(
        step.geometry,
        Math.max(0, Math.min(1, progress)),
      ).point;
    }
    elapsed = next;
  }
  return null;
}

function failedLegMarkerPoint(
  state: GameState,
  leg: RouteLegPath,
): TripPosition | null {
  const from = transitNode(state, leg.fromWaypointId);
  const to = transitNode(state, leg.toWaypointId);
  if (leg.status === "missingNode") {
    return (
      (from?.status === "missing" ? from.position : undefined) ??
      (to?.status === "missing" ? to.position : undefined) ??
      from?.position ??
      to?.position ??
      null
    );
  }
  if (leg.lastValidPath !== null) {
    return pathMidpoint(leg.lastValidPath);
  }
  return from !== undefined && to !== undefined
    ? {
        x: (from.position.x + to.position.x) / 2,
        y: (from.position.y + to.position.y) / 2,
      }
    : (from?.position ?? to?.position ?? null);
}

function renderBrokenRouteMarkers(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  ui: UiState,
): void {
  if (ui.selectedRouteId === null) {
    return;
  }
  const selected =
    state.transit.routes.find((route) => route.id === ui.selectedRouteId) ??
    state.transit.metroLines.find((line) => line.id === ui.selectedRouteId);
  if (selected === undefined) {
    return;
  }
  const failureRows = selectRouteFailures(
    state,
    selected.pattern,
    "stopIds" in selected ? selected.stopIds : selected.stationIds,
    selected.legs,
  );
  selected.legs.forEach((leg, legIndex) => {
    if (leg.status === "connected") {
      return;
    }
    const marker = failedLegMarkerPoint(state, leg);
    if (marker === null) {
      return;
    }
    const x = marker.x * tileSize + tileSize / 2;
    const y = marker.y * tileSize + tileSize / 2;
    const focused =
      ui.routeFailureFocus?.routeId === selected.id &&
      ui.routeFailureFocus.legIndex === legIndex;
    ctx.save();
    ctx.lineWidth = focused ? 4 : 3;
    if (leg.status === "missingNode") {
      ctx.strokeStyle = colors.unserved;
      ctx.strokeRect(x - 8, y - 8, 16, 16);
      ctx.beginPath();
      ctx.moveTo(x - 5, y - 5);
      ctx.lineTo(x + 5, y + 5);
      ctx.moveTo(x + 5, y - 5);
      ctx.lineTo(x - 5, y + 5);
      ctx.stroke();
    } else {
      ctx.fillStyle = colors.late;
      ctx.beginPath();
      ctx.arc(x, y, focused ? 8 : 6, 0, Math.PI * 2);
      ctx.fill();
    }
    const failure = failureRows.find((row) => row.legIndex === legIndex);
    if (failure !== undefined) {
      ctx.font = "10px ui-monospace, monospace";
      ctx.textAlign = "left";
      ctx.textBaseline = "bottom";
      ctx.fillStyle = colors.badgeText;
      ctx.fillText(failure.guidance, x + 12, y - 8);
    }
    ctx.restore();
  });
}

export function renderOverlays(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  ui: UiState,
  roadPreview: RoadMutationPreviewView | null | undefined = undefined,
): void {
  if (ui.activeOverlay === "coverage") {
    ctx.fillStyle = colors.coverage;

    for (const stop of state.transit.stops) {
      if (stop.status !== "present") continue;
      fillCoverageArea(ctx, stop.position, stopCoverageRadius(stop));
    }

    for (const station of state.transit.stations) {
      if (station.status !== "present") continue;
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
    const nodes = [...state.transit.stops, ...state.transit.stations].filter(
      (node) => node.status === "present",
    );

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

  renderBrokenRouteMarkers(ctx, state, ui);

  if (ui.drag !== null) {
    renderDragPreview(ctx, state, ui, roadPreview);
    return;
  }

  if (
    ui.activeTool === "road" ||
    ui.activeTool === "roundabout" ||
    ui.activeTool === "remove"
  ) {
    renderRoadMutationPreview(
      ctx,
      state,
      ui,
      ui.activeTool === "remove",
      roadPreview,
    );
    if (ui.roadMutationPreview !== null) {
      return;
    }
  }

  if (ui.hoverTile !== null && ui.selectedBuilding !== null) {
    renderBuildingPreview(ctx, state, ui);
    return;
  }

  if (ui.hoverTile !== null && ui.activeTool === "busStop") {
    renderBusStopPreview(ctx, state, ui);
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

/**
 * Draws the road-mutation preview feedback badge (cost / route impacts) in
 * the untransformed context (after `ctx.restore()`), so its on-screen size
 * stays consistent with the cursor badge regardless of board scale.
 */
export function renderRoadPreviewFeedbackBadge(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  ui: UiState,
  transform: BoardTransform,
  precomputed: RoadMutationPreviewView | null | undefined = undefined,
): void {
  const preview = precomputed ?? buildRoadMutationPreview(state, ui);
  if (preview === null) {
    return;
  }
  renderRoadPreviewFeedback(ctx, preview, transform);
}
