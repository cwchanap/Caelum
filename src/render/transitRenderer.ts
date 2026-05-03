import type { GameState, Point, Vehicle } from "../domain/types";
import { tileSize } from "./canvas";
import { colors } from "./colors";

function center(point: Point): Point {
  return {
    x: point.x * tileSize + tileSize / 2,
    y: point.y * tileSize + tileSize / 2
  };
}

function drawPolyline(ctx: CanvasRenderingContext2D, positions: Point[], color: string, lineWidth: number): void {
  if (positions.length === 0) {
    return;
  }

  const firstPoint = center(positions[0]);
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(firstPoint.x, firstPoint.y);

  for (const position of positions.slice(1)) {
    const point = center(position);
    ctx.lineTo(point.x, point.y);
  }

  ctx.stroke();
}

function interpolate(from: Point, to: Point, progress: number): Point {
  const start = center(from);
  const end = center(to);
  const boundedProgress = Math.max(0, Math.min(1, progress));

  return {
    x: start.x + (end.x - start.x) * boundedProgress,
    y: start.y + (end.y - start.y) * boundedProgress
  };
}

function routePositions(state: GameState, stopIds: string[]): Point[] {
  const stopById = new Map(state.transit.stops.map((stop) => [stop.id, stop.position]));
  return stopIds.flatMap((stopId) => {
    const position = stopById.get(stopId);
    return position === undefined ? [] : [position];
  });
}

function stationPositions(state: GameState, stationIds: string[]): Point[] {
  const stationById = new Map(state.transit.stations.map((station) => [station.id, station.position]));
  return stationIds.flatMap((stationId) => {
    const position = stationById.get(stationId);
    return position === undefined ? [] : [position];
  });
}

function vehiclePosition(state: GameState, vehicle: Vehicle): Point | null {
  const positions =
    vehicle.mode === "bus"
      ? routePositions(state, state.transit.routes.find((route) => route.id === vehicle.lineId)?.stopIds ?? [])
      : stationPositions(state, state.transit.metroLines.find((line) => line.id === vehicle.lineId)?.stationIds ?? []);

  if (positions.length === 0) {
    return null;
  }

  if (positions.length === 1) {
    return center(positions[0]);
  }

  const segmentIndex = ((vehicle.segmentIndex % positions.length) + positions.length) % positions.length;
  const from = positions[segmentIndex];
  const to = positions[(segmentIndex + 1) % positions.length];

  return interpolate(from, to, vehicle.progress);
}

export function renderTransit(ctx: CanvasRenderingContext2D, state: GameState): void {
  for (const route of state.transit.routes) {
    drawPolyline(ctx, routePositions(state, route.stopIds), route.color, 5);
  }

  for (const line of state.transit.metroLines) {
    drawPolyline(ctx, stationPositions(state, line.stationIds), line.color, 8);
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
