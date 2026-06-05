import type { GameState, Point, Vehicle } from "../domain/types";
import type { UiState } from "../ui/uiState";
import { tileSize } from "./canvas";
import { colors } from "./colors";

function center(point: Point): Point {
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

function interpolate(from: Point, to: Point, progress: number): Point {
  const start = center(from);
  const end = center(to);
  const boundedProgress = Math.max(0, Math.min(1, progress));

  return {
    x: start.x + (end.x - start.x) * boundedProgress,
    y: start.y + (end.y - start.y) * boundedProgress,
  };
}

function routePositions(
  state: GameState,
  stopIds: string[],
): Array<Point | null> {
  const stopById = new Map(
    state.transit.stops.map((stop) => [stop.id, stop.position]),
  );
  return stopIds.map((stopId) => stopById.get(stopId) ?? null);
}

function stationPositions(
  state: GameState,
  stationIds: string[],
): Array<Point | null> {
  const stationById = new Map(
    state.transit.stations.map((station) => [station.id, station.position]),
  );
  return stationIds.map((stationId) => stationById.get(stationId) ?? null);
}

function vehiclePosition(state: GameState, vehicle: Vehicle): Point | null {
  const positions =
    vehicle.mode === "bus"
      ? routePositions(
          state,
          state.transit.routes.find((route) => route.id === vehicle.lineId)
            ?.stopIds ?? [],
        )
      : stationPositions(
          state,
          state.transit.metroLines.find((line) => line.id === vehicle.lineId)
            ?.stationIds ?? [],
        );

  if (positions.length < 2) {
    return null;
  }

  const segmentIndex =
    ((vehicle.segmentIndex % positions.length) + positions.length) %
    positions.length;
  const from = positions[segmentIndex];
  const to = positions[(segmentIndex + 1) % positions.length];

  if (from === null || to === null) {
    return null;
  }

  return interpolate(from, to, vehicle.progress);
}

export function renderTransit(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  ui: UiState,
): void {
  // Draw the selected-route halo FIRST so the colored line renders on top of
  // it. Drawing the halo after the line (the obvious order) covers the color
  // with a ~67% white stroke and washes the route out.
  if (ui.selectedRouteId !== null) {
    const route = state.transit.routes.find((r) => r.id === ui.selectedRouteId);
    if (route !== undefined) {
      drawPolyline(ctx, routePositions(state, route.stopIds), "#ffffffaa", 9);
    }
    const line = state.transit.metroLines.find(
      (l) => l.id === ui.selectedRouteId,
    );
    if (line !== undefined) {
      drawPolyline(
        ctx,
        stationPositions(state, line.stationIds),
        "#ffffffaa",
        12,
      );
    }
  }

  for (const route of state.transit.routes) {
    drawPolyline(ctx, routePositions(state, route.stopIds), route.color, 5);
  }

  for (const line of state.transit.metroLines) {
    drawPolyline(ctx, stationPositions(state, line.stationIds), line.color, 8);
  }

  // Draft preview: dashed stroke through the in-progress stops/stations.
  const draftIds =
    ui.activeTool === "busRoute"
      ? ui.draftStopIds
      : ui.activeTool === "metroLine"
        ? ui.draftStationIds
        : [];
  if (draftIds.length >= 1) {
    const positions =
      ui.activeTool === "busRoute"
        ? routePositions(state, draftIds)
        : stationPositions(state, draftIds);
    ctx.save();
    ctx.setLineDash([6, 6]);
    drawPolyline(ctx, positions, "#f4d35e", 3);
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
