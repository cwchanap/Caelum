import type {
  GameState,
  PathGeometry,
  RouteLegPath,
  TransitPath,
  TripPosition,
  Vehicle,
} from "../domain/types";
import type { UiState } from "../ui/uiState";
import { tileSize } from "./canvas";
import { colors } from "./colors";
import { drawPathGeometry, pointAndTangentAt } from "./pathRenderer";
import {
  canonicalCorridorPrimitive,
  corridorOffsets,
  directionArrowSamples,
  offsetGeometry,
} from "./routeGeometry";

export const UNRELATED_ROUTE_OPACITY = 0.42;
const SHARED_CORRIDOR_GAP_PX = 4;
const DIRECTION_ARROW_SPACING_TILES = 1.5;

function center(point: TripPosition): TripPosition {
  return {
    x: point.x * tileSize + tileSize / 2,
    y: point.y * tileSize + tileSize / 2,
  };
}

function drawTransitPath(
  ctx: CanvasRenderingContext2D,
  path: TransitPath,
  color: string,
  lineWidth: number,
  routeId: string,
  corridors: CorridorGroups,
): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const step of path.steps) {
    ctx.beginPath();
    drawPathGeometry(
      ctx,
      offsetForRoute(step.geometry, routeId, corridors),
      center,
    );
    ctx.stroke();
  }
}

interface RouteStrokeStyle {
  color: string;
  lineWidth: number;
}

interface RenderableLine {
  id: string;
  color: string;
  lineWidth: number;
  legs: RouteLegPath[];
}

interface CorridorGroup {
  canonicalTangent: TripPosition;
  offsets: ReadonlyMap<string, number>;
}

type CorridorGroups = ReadonlyMap<string, CorridorGroup>;

function presentationPath(leg: RouteLegPath): TransitPath | null {
  return leg.status === "connected" ? leg.currentPath : leg.lastValidPath;
}

function renderableLines(state: GameState): RenderableLine[] {
  return [
    ...state.transit.routes.map((route) => ({
      id: route.id,
      color: route.color,
      lineWidth: 5,
      legs: route.legs,
    })),
    ...state.transit.metroLines.map((line) => ({
      id: line.id,
      color: line.color,
      lineWidth: 8,
      legs: line.legs,
    })),
  ].sort((left, right) => left.id.localeCompare(right.id));
}

function buildCorridorGroups(lines: readonly RenderableLine[]): CorridorGroups {
  const grouped = new Map<
    string,
    { canonicalTangent: TripPosition; routeIds: Set<string> }
  >();
  for (const line of lines) {
    for (const leg of line.legs) {
      const path = presentationPath(leg);
      if (path === null) continue;
      for (const step of path.steps) {
        const primitive = canonicalCorridorPrimitive(step.geometry);
        const group = grouped.get(primitive.key);
        if (group === undefined) {
          grouped.set(primitive.key, {
            canonicalTangent: primitive.canonicalTangent,
            routeIds: new Set([line.id]),
          });
        } else {
          group.routeIds.add(line.id);
        }
      }
    }
  }
  return new Map(
    [...grouped].map(([key, group]) => [
      key,
      {
        canonicalTangent: group.canonicalTangent,
        offsets: corridorOffsets([...group.routeIds], SHARED_CORRIDOR_GAP_PX),
      },
    ]),
  );
}

function offsetForRoute(
  geometry: PathGeometry,
  routeId: string,
  corridors: CorridorGroups,
): PathGeometry {
  const primitive = canonicalCorridorPrimitive(geometry);
  const group = corridors.get(primitive.key);
  if (group === undefined) return geometry;
  const pixels = group.offsets.get(routeId) ?? 0;
  return offsetGeometry(geometry, pixels / tileSize, group.canonicalTangent);
}

function offsetPath(
  path: TransitPath,
  routeId: string,
  corridors: CorridorGroups,
): TransitPath {
  if (path.kind === "road") {
    return {
      ...path,
      steps: path.steps.map((step) => ({
        ...step,
        geometry: offsetForRoute(step.geometry, routeId, corridors),
      })),
    };
  }
  return {
    ...path,
    steps: path.steps.map((step) => ({
      ...step,
      geometry: offsetForRoute(step.geometry, routeId, corridors),
    })),
  };
}

function routeLegEndpoints(
  state: GameState,
  leg: RouteLegPath,
): { from?: TripPosition; to?: TripPosition } {
  const nodes = [...state.transit.stops, ...state.transit.stations];
  return {
    from: nodes.find((node) => node.id === leg.fromWaypointId)?.position,
    to: nodes.find((node) => node.id === leg.toWaypointId)?.position,
  };
}

function renderLeg(
  ctx: CanvasRenderingContext2D,
  leg: RouteLegPath,
  endpoints: { from?: TripPosition; to?: TripPosition },
  style: RouteStrokeStyle,
  routeId: string,
  corridors: CorridorGroups,
): void {
  const path = presentationPath(leg);
  const dotted = leg.status !== "connected";
  ctx.setLineDash(dotted ? [6, 5] : []);
  if (path !== null) {
    drawTransitPath(
      ctx,
      path,
      style.color,
      style.lineWidth,
      routeId,
      corridors,
    );
  } else if (
    dotted &&
    endpoints.from !== undefined &&
    endpoints.to !== undefined
  ) {
    ctx.strokeStyle = style.color;
    ctx.lineWidth = style.lineWidth;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    drawPathGeometry(
      ctx,
      { kind: "line", from: endpoints.from, to: endpoints.to },
      center,
    );
    ctx.stroke();
  }
  ctx.setLineDash([]);
}

function drawLegs(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  legs: RouteLegPath[],
  color: string,
  lineWidth: number,
  routeId: string,
  corridors: CorridorGroups,
): void {
  for (const leg of legs) {
    renderLeg(
      ctx,
      leg,
      routeLegEndpoints(state, leg),
      { color, lineWidth },
      routeId,
      corridors,
    );
  }
}

function drawDraftLegs(
  ctx: CanvasRenderingContext2D,
  legs: RouteLegPath[],
  color: string,
  lineWidth: number,
  routeId: string,
  corridors: CorridorGroups,
): void {
  for (const leg of legs) {
    if (leg.currentPath !== null) {
      drawTransitPath(
        ctx,
        leg.currentPath,
        color,
        lineWidth,
        routeId,
        corridors,
      );
    }
  }
}

function drawDirectionArrowhead(
  ctx: CanvasRenderingContext2D,
  point: TripPosition,
  angleRadians: number,
): void {
  const pixel = center(point);
  ctx.save();
  ctx.translate(pixel.x, pixel.y);
  ctx.rotate(angleRadians);
  ctx.beginPath();
  ctx.moveTo(6, 0);
  ctx.lineTo(-4, -4);
  ctx.lineTo(-4, 4);
  ctx.fill();
  ctx.restore();
}

function drawLineDirectionArrows(
  ctx: CanvasRenderingContext2D,
  line: RenderableLine,
  corridors: CorridorGroups,
): void {
  ctx.globalAlpha = 1;
  ctx.fillStyle = line.color;
  for (const leg of line.legs) {
    const path = presentationPath(leg);
    if (path === null) continue;
    const presentation = offsetPath(path, line.id, corridors);
    for (const arrow of directionArrowSamples(
      presentation,
      DIRECTION_ARROW_SPACING_TILES,
    )) {
      drawDirectionArrowhead(ctx, arrow.point, arrow.angleRadians);
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

interface VehicleSample {
  point: TripPosition;
  tangent: TripPosition | null;
}

function vehicleSample(
  state: GameState,
  vehicle: Vehicle,
): VehicleSample | null {
  const itinerary = vehicleItinerary(state, vehicle);
  if (itinerary === null || itinerary.length === 0) {
    return vehicle.parkedPosition === null
      ? null
      : { point: center(vehicle.parkedPosition), tangent: null };
  }
  const leg = itinerary[vehicle.itineraryIndex % itinerary.length];
  const path = leg?.currentPath;
  const step = path?.steps[vehicle.pathStepIndex];
  if (step === undefined) {
    return vehicle.parkedPosition === null
      ? null
      : { point: center(vehicle.parkedPosition), tangent: null };
  }
  const sample = pointAndTangentAt(step.geometry, vehicle.stepProgress);
  return { point: center(sample.point), tangent: sample.tangent };
}

export function renderTransit(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  ui: UiState,
): void {
  const lines = renderableLines(state);
  const corridors = buildCorridorGroups(lines);
  const editedRouteId =
    ui.routeDraft?.source.kind === "edit" ? ui.routeDraft.source.routeId : null;
  const emphasizedIds = new Set(
    [ui.selectedRouteId, editedRouteId].filter(
      (routeId): routeId is string => routeId !== null,
    ),
  );

  for (const line of lines) {
    if (!emphasizedIds.has(line.id)) continue;
    ctx.globalAlpha = 1;
    drawLegs(
      ctx,
      state,
      line.legs,
      "#ffffffaa",
      line.lineWidth + 4,
      line.id,
      corridors,
    );
  }

  for (const line of lines) {
    ctx.globalAlpha =
      emphasizedIds.size === 0 || emphasizedIds.has(line.id)
        ? 1
        : UNRELATED_ROUTE_OPACITY;
    drawLegs(
      ctx,
      state,
      line.legs,
      line.color,
      line.lineWidth,
      line.id,
      corridors,
    );
  }
  ctx.globalAlpha = 1;

  const draft = ui.routeDraft;
  const draftLegs =
    draft !== null &&
    draft.preview !== null &&
    draft.preview.generation === draft.generation
      ? draft.preview.legs
      : [];
  if (draftLegs.length >= 1) {
    ctx.save();
    ctx.setLineDash([6, 6]);
    drawDraftLegs(
      ctx,
      draftLegs,
      "#f4d35e",
      3,
      editedRouteId ?? `draft-${draft?.instanceId ?? 0}`,
      corridors,
    );
    ctx.restore();
    ctx.setLineDash([]);
  }

  for (const line of lines) {
    if (emphasizedIds.has(line.id)) {
      drawLineDirectionArrows(ctx, line, corridors);
    }
  }

  for (const stop of state.transit.stops) {
    if (stop.status !== "present") continue;
    const point = center(stop.position);
    ctx.fillStyle = colors.bus;
    ctx.fillRect(point.x - 5, point.y - 5, 10, 10);
  }
  for (const station of state.transit.stations) {
    if (station.status !== "present") continue;
    const point = center(station.position);
    ctx.fillStyle = colors.metro;
    ctx.beginPath();
    ctx.arc(point.x, point.y, 8, 0, Math.PI * 2);
    ctx.fill();
  }
  for (const vehicle of state.transit.vehicles) {
    const sample = vehicleSample(state, vehicle);
    if (sample === null) {
      continue;
    }
    ctx.fillStyle = vehicle.mode === "bus" ? colors.bus : colors.metro;
    if (vehicle.mode === "bus" && sample.tangent !== null) {
      ctx.save();
      ctx.translate(sample.point.x, sample.point.y);
      ctx.rotate(Math.atan2(sample.tangent.y, sample.tangent.x));
      ctx.fillRect(-7, -14, 14, 8);
      ctx.restore();
    } else {
      ctx.fillRect(sample.point.x - 7, sample.point.y - 14, 14, 8);
    }
  }
}
