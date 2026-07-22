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
  routePathPresentation,
  type RoutePathPresentation,
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

/** Extract the start/end tile position of a step's geometry. Arcs are
 *  render-only roundabout circulation curves with no from/to endpoint, so
 *  they return undefined and skip the connector. Rust road/track path steps
 *  only emit line/quadraticBezier. */
function geometryEndpoint(
  geometry: PathGeometry,
  end: "start" | "end",
): TripPosition | undefined {
  if (geometry.kind === "line" || geometry.kind === "quadraticBezier") {
    return end === "start" ? geometry.from : geometry.to;
  }
  return undefined;
}

function sameTripPosition(a: TripPosition, b: TripPosition): boolean {
  return a.x === b.x && a.y === b.y;
}

/** Draw a short connector between an off-road node (bus stop / terminal
 *  anchor on a building tile) and its road access tile. Rust's `RoadPath`
 *  starts/ends at the adjacent road tile, not the stop, so without this the
 *  route stroke begins at the access road and leaves building-backed
 *  terminals visually disconnected. The road-side endpoint uses the
 *  corridor-offset step geometry so the connector meets the offset stroke in
 *  shared corridors. Zero-length connectors (on-road stops where the path
 *  already reaches the node) are skipped. */
function drawEndpointConnector(
  ctx: CanvasRenderingContext2D,
  nodePosition: TripPosition,
  pathEndpoint: TripPosition,
  style: RouteStrokeStyle,
): void {
  if (sameTripPosition(nodePosition, pathEndpoint)) return;
  ctx.strokeStyle = style.color;
  ctx.lineWidth = style.lineWidth;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  drawPathGeometry(
    ctx,
    { kind: "line", from: nodePosition, to: pathEndpoint },
    center,
  );
  ctx.stroke();
}

interface RouteStrokeStyle {
  color: string;
  lineWidth: number;
}

interface RenderableLine {
  id: string;
  mode: "bus" | "metro";
  color: string;
  lineWidth: number;
  waypointIds: string[];
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
      mode: "bus" as const,
      color: route.color,
      lineWidth: 5,
      waypointIds: route.stopIds,
      legs: route.legs,
    })),
    ...state.transit.metroLines.map((line) => ({
      id: line.id,
      mode: "metro" as const,
      color: line.color,
      lineWidth: 8,
      waypointIds: line.stationIds,
      legs: line.legs,
    })),
  ].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
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

function presentationForRoute(
  geometry: PathGeometry,
  routeId: string,
  corridors: CorridorGroups,
): RoutePathPresentation {
  const primitive = canonicalCorridorPrimitive(geometry);
  const group = corridors.get(primitive.key);
  if (group === undefined) {
    return routePathPresentation(geometry, 0, primitive.canonicalTangent);
  }
  const pixels = group.offsets.get(routeId) ?? 0;
  return routePathPresentation(
    geometry,
    pixels / tileSize,
    group.canonicalTangent,
  );
}

function offsetForRoute(
  geometry: PathGeometry,
  routeId: string,
  corridors: CorridorGroups,
): PathGeometry {
  return presentationForRoute(geometry, routeId, corridors).geometry;
}

function offsetPath(
  path: TransitPath,
  routeId: string,
  corridors: CorridorGroups,
): TransitPath {
  const steps = path.steps.map((step) => ({
    ...step,
    geometry: offsetForRoute(step.geometry, routeId, corridors),
  }));
  return { ...path, steps } as TransitPath;
}

function nodePositionMap(state: GameState): Map<string, TripPosition> {
  const positions = new Map<string, TripPosition>();
  for (const stop of state.transit.stops) {
    positions.set(stop.id, stop.position);
  }
  for (const station of state.transit.stations) {
    positions.set(station.id, station.position);
  }
  return positions;
}

function routeLegEndpoints(
  nodes: Map<string, TripPosition>,
  leg: RouteLegPath,
): { from?: TripPosition; to?: TripPosition } {
  return {
    from: nodes.get(leg.fromWaypointId),
    to: nodes.get(leg.toWaypointId),
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
    // Off-road anchors (roadside stops, bus-terminal buildings) route between
    // adjacent road access tiles, so the path's first/last geometry endpoints
    // are the access road, not the stop. Bridge the gap so building-backed
    // terminals are visually connected to their route. Use the corridor-offset
    // step endpoint so the connector meets the offset stroke in shared
    // corridors.
    const firstStep = path.steps[0];
    const lastStep = path.steps[path.steps.length - 1];
    if (endpoints.from !== undefined && firstStep !== undefined) {
      const pathStart = geometryEndpoint(
        offsetForRoute(firstStep.geometry, routeId, corridors),
        "start",
      );
      if (pathStart !== undefined) {
        drawEndpointConnector(ctx, endpoints.from, pathStart, style);
      }
    }
    if (endpoints.to !== undefined && lastStep !== undefined) {
      const pathEnd = geometryEndpoint(
        offsetForRoute(lastStep.geometry, routeId, corridors),
        "end",
      );
      if (pathEnd !== undefined) {
        drawEndpointConnector(ctx, pathEnd, endpoints.to, style);
      }
    }
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
  nodes: Map<string, TripPosition>,
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
      routeLegEndpoints(nodes, leg),
      { color, lineWidth },
      routeId,
      corridors,
    );
  }
}

function drawDraftLegs(
  ctx: CanvasRenderingContext2D,
  nodes: Map<string, TripPosition>,
  legs: RouteLegPath[],
  color: string,
  lineWidth: number,
  routeId: string,
  corridors: CorridorGroups,
): void {
  for (const leg of legs) {
    const path = presentationPath(leg);
    const endpoints = routeLegEndpoints(nodes, leg);
    if (path !== null) {
      drawTransitPath(ctx, path, color, lineWidth, routeId, corridors);
      const firstStep = path.steps[0];
      const lastStep = path.steps[path.steps.length - 1];
      if (endpoints.from !== undefined && firstStep !== undefined) {
        const pathStart = geometryEndpoint(
          offsetForRoute(firstStep.geometry, routeId, corridors),
          "start",
        );
        if (pathStart !== undefined) {
          drawEndpointConnector(ctx, endpoints.from, pathStart, {
            color,
            lineWidth,
          });
        }
      }
      if (endpoints.to !== undefined && lastStep !== undefined) {
        const pathEnd = geometryEndpoint(
          offsetForRoute(lastStep.geometry, routeId, corridors),
          "end",
        );
        if (pathEnd !== undefined) {
          drawEndpointConnector(ctx, pathEnd, endpoints.to, {
            color,
            lineWidth,
          });
        }
      }
    } else if (endpoints.from !== undefined && endpoints.to !== undefined) {
      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth;
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

function waypointGeometry(
  line: RenderableLine,
  waypointId: string,
): PathGeometry | null {
  for (const leg of line.legs) {
    if (leg.fromWaypointId !== waypointId) continue;
    const path = presentationPath(leg);
    const geometry = path?.steps[0]?.geometry;
    if (geometry !== undefined) return geometry;
  }
  for (const leg of line.legs) {
    if (leg.toWaypointId !== waypointId) continue;
    const path = presentationPath(leg);
    const geometry = path?.steps.at(-1)?.geometry;
    if (geometry !== undefined) return geometry;
  }
  return null;
}

function drawRouteNodeCues(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  lines: readonly RenderableLine[],
  corridors: CorridorGroups,
  emphasizedIds: ReadonlySet<string>,
): void {
  for (const line of lines) {
    ctx.globalAlpha =
      emphasizedIds.size === 0 || emphasizedIds.has(line.id)
        ? 1
        : UNRELATED_ROUTE_OPACITY;
    ctx.fillStyle = line.color;
    const nodes =
      line.mode === "bus" ? state.transit.stops : state.transit.stations;
    for (const waypointId of new Set(line.waypointIds)) {
      const node = nodes.find(
        (candidate) =>
          candidate.id === waypointId && candidate.status === "present",
      );
      const geometry = waypointGeometry(line, waypointId);
      if (node === undefined || geometry === null) continue;
      const presentation = presentationForRoute(geometry, line.id, corridors);
      const point = center(presentation.translatePoint(node.position));
      ctx.beginPath();
      ctx.arc(point.x, point.y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
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

function terminalWaypointPosition(
  state: GameState,
  vehicle: Vehicle,
  leg: RouteLegPath,
): TripPosition | null {
  const nodes =
    vehicle.mode === "bus" ? state.transit.stops : state.transit.stations;
  const node = nodes.find(
    (candidate) =>
      candidate.id === leg.fromWaypointId && candidate.status === "present",
  );
  return node?.position ?? null;
}

function vehicleSample(
  state: GameState,
  vehicle: Vehicle,
  corridors: CorridorGroups,
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
    // Zero-step terminal reversals have a connected empty path and no step;
    // park at the terminal waypoint so paused/exact-boundary vehicles remain visible.
    if (
      vehicle.parkedPosition === null &&
      path != null &&
      path.steps.length === 0 &&
      leg !== undefined
    ) {
      const terminal = terminalWaypointPosition(state, vehicle, leg);
      if (terminal !== null) {
        return { point: center(terminal), tangent: null };
      }
    }
    if (vehicle.parkedPosition === null) return null;
    const geometry =
      leg === undefined ? undefined : presentationPath(leg)?.steps[0]?.geometry;
    const point =
      geometry === undefined
        ? vehicle.parkedPosition
        : presentationForRoute(
            geometry,
            vehicle.lineId,
            corridors,
          ).translatePoint(vehicle.parkedPosition);
    return { point: center(point), tangent: null };
  }
  const presentation = presentationForRoute(
    step.geometry,
    vehicle.lineId,
    corridors,
  );
  const sample = pointAndTangentAt(presentation.geometry, vehicle.stepProgress);
  return { point: center(sample.point), tangent: sample.tangent };
}

interface TransitRenderCache {
  lines: RenderableLine[];
  corridors: CorridorGroups;
  nodes: Map<string, TripPosition>;
}

/** Memoizes the state-derived transit render structures (`renderableLines`,
 *  `buildCorridorGroups`, `nodePositionMap`) on GameState identity. Since
 *  GameState is immutable and the runtime uses reference-equality dispatch,
 *  the cache hits on every re-render that doesn't follow a sim tick — e.g.
 *  paused canvas redraws, hover-only updates, and drag previews. Sim ticks
 *  produce a new GameState, so the cache misses once per tick and rebuilds. */
const transitRenderCache = new WeakMap<GameState, TransitRenderCache>();

function getTransitRenderCache(state: GameState): TransitRenderCache {
  let cached = transitRenderCache.get(state);
  if (cached === undefined) {
    const lines = renderableLines(state);
    cached = {
      lines,
      corridors: buildCorridorGroups(lines),
      nodes: nodePositionMap(state),
    };
    transitRenderCache.set(state, cached);
  }
  return cached;
}

function renderTransitContents(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  ui: UiState,
): void {
  const { lines, corridors, nodes } = getTransitRenderCache(state);
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
      nodes,
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
      nodes,
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
      nodes,
      draftLegs,
      "#f4d35e",
      3,
      editedRouteId ?? `draft-${draft?.instanceId ?? 0}`,
      corridors,
    );
    ctx.restore();
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
  drawRouteNodeCues(ctx, state, lines, corridors, emphasizedIds);
  for (const vehicle of state.transit.vehicles) {
    const sample = vehicleSample(state, vehicle, corridors);
    if (sample === null) {
      continue;
    }
    const dimmed = emphasizedIds.size > 0 && !emphasizedIds.has(vehicle.lineId);
    ctx.globalAlpha = dimmed ? UNRELATED_ROUTE_OPACITY : 1;
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
  ctx.globalAlpha = 1;
}

export function renderTransit(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  ui: UiState,
): void {
  ctx.save();
  try {
    renderTransitContents(ctx, state, ui);
  } finally {
    ctx.restore();
  }
}
