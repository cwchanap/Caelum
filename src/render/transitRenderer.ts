import type {
  GameState,
  Point,
  RouteLegPath,
  TransitPath,
  TripPosition,
  Vehicle,
} from "../domain/types";
import type { UiState } from "../ui/uiState";
import { tileSize } from "./canvas";
import { colors } from "./colors";
import { drawPathGeometry, pointAt } from "./pathRenderer";

function center(point: TripPosition): TripPosition {
  return {
    x: point.x * tileSize + tileSize / 2,
    y: point.y * tileSize + tileSize / 2,
  };
}

function drawPolyline(
  ctx: CanvasRenderingContext2D,
  positions: Array<Point | null>,
  color: string,
  lineWidth: number,
): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  let previousPoint: Point | null = null;
  for (const position of positions) {
    if (position === null) {
      previousPoint = null;
      continue;
    }
    if (previousPoint !== null) {
      const from = center(previousPoint);
      const to = center(position);
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
    }
    previousPoint = position;
  }
}

function drawTransitPath(
  ctx: CanvasRenderingContext2D,
  path: TransitPath,
  color: string,
  lineWidth: number,
): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const step of path.steps) {
    ctx.beginPath();
    drawPathGeometry(ctx, step.geometry, center);
    ctx.stroke();
  }
}

function drawLegs(
  ctx: CanvasRenderingContext2D,
  legs: RouteLegPath[],
  color: string,
  lineWidth: number,
): void {
  for (const leg of legs) {
    if (leg.currentPath !== null) {
      drawTransitPath(ctx, leg.currentPath, color, lineWidth);
    }
  }
}

function vehicleItinerary(
  state: GameState,
  vehicle: Vehicle,
): RouteLegPath[] | null {
  if (vehicle.mode === "bus") {
    return (
      state.transit.routes.find((route) => route.id === vehicle.lineId)?.legs ??
      null
    );
  }
  return (
    state.transit.metroLines.find((line) => line.id === vehicle.lineId)?.legs ??
    null
  );
}

function vehiclePosition(
  state: GameState,
  vehicle: Vehicle,
): TripPosition | null {
  const itinerary = vehicleItinerary(state, vehicle);
  if (itinerary === null || itinerary.length === 0) {
    return vehicle.parkedPosition === null
      ? null
      : center(vehicle.parkedPosition);
  }
  const leg = itinerary[vehicle.itineraryIndex % itinerary.length];
  const path = leg?.currentPath;
  const step = path?.steps[vehicle.pathStepIndex];
  if (step === undefined) {
    return vehicle.parkedPosition === null
      ? null
      : center(vehicle.parkedPosition);
  }
  return center(pointAt(step.geometry, vehicle.stepProgress));
}

export function renderTransit(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  ui: UiState,
): void {
  if (ui.selectedRouteId !== null) {
    const route = state.transit.routes.find(
      (candidate) => candidate.id === ui.selectedRouteId,
    );
    if (route !== undefined) {
      drawLegs(ctx, route.legs, "#ffffffaa", 9);
    }
    const line = state.transit.metroLines.find(
      (candidate) => candidate.id === ui.selectedRouteId,
    );
    if (line !== undefined) {
      drawLegs(ctx, line.legs, "#ffffffaa", 12);
    }
  }

  for (const route of state.transit.routes) {
    drawLegs(ctx, route.legs, route.color, 5);
  }
  for (const line of state.transit.metroLines) {
    drawLegs(ctx, line.legs, line.color, 8);
  }

  const draftPaths =
    ui.activeTool === "busRoute"
      ? ui.draftStopPaths
      : ui.activeTool === "metroLine"
        ? ui.draftStationPaths
        : [];
  if (draftPaths.length >= 1) {
    ctx.save();
    ctx.setLineDash([6, 6]);
    drawPolyline(ctx, draftPaths.flat(), "#f4d35e", 3);
    ctx.restore();
  }

  for (const stop of state.transit.stops) {
    const point = center(stop.position);
    ctx.fillStyle = colors.bus;
    ctx.fillRect(point.x - 5, point.y - 5, 10, 10);
  }
  for (const station of state.transit.stations) {
    const point = center(station.position);
    ctx.fillStyle = colors.metro;
    ctx.beginPath();
    ctx.arc(point.x, point.y, 8, 0, Math.PI * 2);
    ctx.fill();
  }
  for (const vehicle of state.transit.vehicles) {
    const point = vehiclePosition(state, vehicle);
    if (point === null) {
      continue;
    }
    ctx.fillStyle = vehicle.mode === "bus" ? colors.bus : colors.metro;
    ctx.fillRect(point.x - 7, point.y - 14, 14, 8);
  }
}
