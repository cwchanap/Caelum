import type {
  GameState,
  MetroLine,
  Point,
  Route,
  Vehicle,
} from "../domain/types";
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

/**
 * Positions used to draw a route/line polyline. Broken or segment-less lines
 * fall back to straight stop-to-stop/station-to-station lines as the visible
 * "off the network" cue; otherwise the line follows the stored tile path.
 */
function lineDrawPositions(
  state: GameState,
  line: { segments: Point[][]; pathBroken: boolean },
  fallbackIds: string[],
  kind: "stops" | "stations",
): Array<Point | null> {
  if (line.pathBroken || line.segments.length === 0) {
    return kind === "stops"
      ? routePositions(state, fallbackIds)
      : stationPositions(state, fallbackIds);
  }
  return line.segments.flat();
}

function vehiclePosition(state: GameState, vehicle: Vehicle): Point | null {
  const line =
    vehicle.mode === "bus"
      ? state.transit.routes.find((route) => route.id === vehicle.lineId)
      : state.transit.metroLines.find((l) => l.id === vehicle.lineId);
  if (line === undefined) {
    return null;
  }
  const ids =
    vehicle.mode === "bus"
      ? (line as Route).stopIds
      : (line as MetroLine).stationIds;
  const nodePositions =
    vehicle.mode === "bus"
      ? routePositions(state, ids)
      : stationPositions(state, ids);
  if (nodePositions.length < 2) {
    return null;
  }

  const segmentCount =
    line.segments.length > 0 ? line.segments.length : nodePositions.length;
  const segmentIndex =
    ((vehicle.segmentIndex % segmentCount) + segmentCount) % segmentCount;
  const segment = line.segments[segmentIndex];

  if (line.pathBroken || segment === undefined || segment.length === 0) {
    // Parked at the segment-start stop while the network is broken.
    const parked = nodePositions[segmentIndex % nodePositions.length];
    return parked === null ? null : center(parked);
  }

  const steps = segment.length - 1;
  if (steps <= 0) {
    return center(segment[0]);
  }
  const along = Math.max(0, Math.min(1, vehicle.progress)) * steps;
  const tileIndex = Math.min(Math.floor(along), steps - 1);
  return interpolate(
    segment[tileIndex],
    segment[tileIndex + 1],
    along - tileIndex,
  );
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
      drawPolyline(
        ctx,
        lineDrawPositions(state, route, route.stopIds, "stops"),
        "#ffffffaa",
        9,
      );
    }
    const line = state.transit.metroLines.find(
      (l) => l.id === ui.selectedRouteId,
    );
    if (line !== undefined) {
      drawPolyline(
        ctx,
        lineDrawPositions(state, line, line.stationIds, "stations"),
        "#ffffffaa",
        12,
      );
    }
  }

  for (const route of state.transit.routes) {
    drawPolyline(
      ctx,
      lineDrawPositions(state, route, route.stopIds, "stops"),
      route.color,
      5,
    );
  }

  for (const line of state.transit.metroLines) {
    drawPolyline(
      ctx,
      lineDrawPositions(state, line, line.stationIds, "stations"),
      line.color,
      8,
    );
  }

  // Draft preview: dashed stroke through the in-progress stops/stations,
  // following the stored draft tile paths so it matches the network.
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
