import type {
  GameState,
  PathGeometry,
  RouteLegPath,
  TransitPath,
  TripPosition,
} from "../../domain/types";
import type { UiState } from "../../ui/uiState";
import { tileCenter, tileSize } from "../boardTransform";
import { colors } from "../colors";
import { pointAndTangentAt, type GeometrySample } from "../pathGeometry";
import {
  canonicalCorridorPrimitive,
  corridorOffsets,
  directionArrowSamples,
  routePathPresentation,
  type RoutePathPresentation,
} from "../routeGeometry";
import {
  SolidGeometry,
  parseColor,
  toPixelGeometry,
  withAlpha,
  type Rgba,
} from "./primitives";

/** Alpha applied to route geometry when a different route is emphasized. */
export const UNRELATED_ROUTE_OPACITY = 0.42;

const SHARED_CORRIDOR_GAP_PX = 4;
const DIRECTION_ARROW_SPACING_TILES = 1.5;
const BROKEN_LEG_DASH = { dash: 6, gap: 5 };
const DRAFT_DASH = { dash: 6, gap: 6 };
const DRAFT_COLOR = parseColor("#f4d35e");
const HALO_COLOR = parseColor("#ffffffaa");
const BUS_LINE_WIDTH = 5;
const METRO_LINE_WIDTH = 8;
const STOP_MARKER_COLOR = parseColor(colors.bus);
const STATION_MARKER_COLOR = parseColor(colors.metro);
const ACCESS_INDICATOR_COLOR = parseColor(colors.hover);
const STOP_MARKER_RADIUS = 7;
const STATION_MARKER_HALF = 7;
const STATION_MARKER_CORNER = 3;
const MARKER_RIM_WIDTH = 2;
const MARKER_FILL_COLOR = parseColor("#ffffff");

function sameTripPosition(a: TripPosition, b: TripPosition): boolean {
  return a.x === b.x && a.y === b.y;
}

/** Join the outer edges of neighboring solid strokes at a turn. */
function fillCornerNotch(
  g: SolidGeometry,
  previousEnd: GeometrySample,
  start: GeometrySample,
  lineWidth: number,
  color: Rgba,
): void {
  const p1 = previousEnd.point;
  const p2 = start.point;
  const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  // Bridge nearby corridor offsets, not unrelated leg endpoints.
  if (dist > 12) return;

  const t1 = previousEnd.tangent;
  const t2 = start.tangent;
  const len1 = Math.hypot(t1.x, t1.y);
  const len2 = Math.hypot(t2.x, t2.y);
  if (len1 === 0 || len2 === 0) return;

  const u1 = { x: t1.x / len1, y: t1.y / len1 };
  const u2 = { x: t2.x / len2, y: t2.y / len2 };
  const cross = u1.x * u2.y - u1.y * u2.x;
  if (Math.abs(cross) < 1e-4) return; // Nearly parallel strokes need no join.

  const halfWidth = lineWidth / 2;
  const n1 = { x: -u1.y * halfWidth, y: u1.x * halfWidth };
  const n2 = { x: -u2.y * halfWidth, y: u2.x * halfWidth };

  // In screen coordinates, positive cross is a right turn and negative is a left turn.
  const sign = cross > 0 ? -1 : 1;
  const o1 = { x: p1.x + sign * n1.x, y: p1.y + sign * n1.y };
  const o2 = { x: p2.x + sign * n2.x, y: p2.y + sign * n2.y };

  if (dist < 0.5) {
    // Subpixel offsets can use a single bevel triangle.
    const p = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    g.triangle(p, o1, o2, color);
  } else {
    const i1 = { x: p1.x - sign * n1.x, y: p1.y - sign * n1.y };
    const i2 = { x: p2.x - sign * n2.x, y: p2.y - sign * n2.y };
    g.triangle(o1, o2, i2, color);
    g.triangle(o1, i2, i1, color);
  }
}

export interface RenderableLine {
  id: string;
  mode: "bus" | "metro";
  color: string;
  lineWidth: number;
  waypointIds: string[];
  legs: RouteLegPath[];
}

export interface CorridorGroup {
  canonicalTangent: TripPosition;
  offsets: ReadonlyMap<string, number>;
}

export type CorridorGroups = ReadonlyMap<string, CorridorGroup>;

export function presentationPath(leg: RouteLegPath): TransitPath | null {
  return leg.status === "connected" ? leg.currentPath : leg.lastValidPath;
}

export function renderableLines(state: GameState): RenderableLine[] {
  return [
    ...state.transit.routes.map((route) => ({
      id: route.id,
      mode: "bus" as const,
      color: route.color,
      lineWidth: BUS_LINE_WIDTH,
      waypointIds: route.stopIds,
      legs: route.legs,
    })),
    ...state.transit.metroLines.map((line) => ({
      id: line.id,
      mode: "metro" as const,
      color: line.color,
      lineWidth: METRO_LINE_WIDTH,
      waypointIds: line.stationIds,
      legs: line.legs,
    })),
  ].sort((left, right) => left.id.localeCompare(right.id));
}

export function buildCorridorGroups(
  lines: readonly RenderableLine[],
): CorridorGroups {
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

/** Corridor offsets are state-derived presentation, and GameState is
 *  immutable with reference-equality dispatch, so they cache on state
 *  identity. */
const corridorsCache = new WeakMap<GameState, CorridorGroups>();

export function corridorsFor(state: GameState): CorridorGroups {
  let corridors = corridorsCache.get(state);
  if (corridors === undefined) {
    corridors = buildCorridorGroups(renderableLines(state));
    corridorsCache.set(state, corridors);
  }
  return corridors;
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

export function presentationForRoute(
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

/** Extract the start/end tile position of a step's geometry. Arcs are
 *  render-only roundabout circulation curves with no from/to endpoint, so
 *  they return undefined and skip the connector. */
function geometryEndpoint(
  geometry: PathGeometry,
  end: "start" | "end",
): TripPosition | undefined {
  if (geometry.kind === "line" || geometry.kind === "quadraticBezier") {
    return end === "start" ? geometry.from : geometry.to;
  }
  return undefined;
}

function drawSteps(
  g: SolidGeometry,
  path: TransitPath,
  color: Rgba,
  lineWidth: number,
  routeId: string,
  corridors: CorridorGroups,
  dash?: { dash: number; gap: number },
  initialPreviousEnd?: GeometrySample,
): GeometrySample | undefined {
  let previousEnd = dash === undefined ? initialPreviousEnd : undefined;
  for (const step of path.steps) {
    const geometry = toPixelGeometry(
      offsetForRoute(step.geometry, routeId, corridors),
      tileCenter,
    );
    if (dash === undefined) {
      const start = pointAndTangentAt(geometry, 0);
      if (previousEnd !== undefined) {
        fillCornerNotch(g, previousEnd, start, lineWidth, color);
      }
    }
    if (geometry.kind === "line") {
      if (dash !== undefined) {
        g.dashedLine(
          geometry.from,
          geometry.to,
          lineWidth,
          dash.dash,
          dash.gap,
          color,
        );
      } else {
        g.thickLine(geometry.from, geometry.to, lineWidth, color);
      }
    } else if (dash !== undefined) {
      g.dashedCurve(geometry, lineWidth, dash.dash, dash.gap, color);
    } else {
      g.curve(geometry, lineWidth, color);
    }
    if (dash === undefined) {
      previousEnd = pointAndTangentAt(geometry, 1);
    }
  }
  return previousEnd;
}

function drawEndpointConnector(
  g: SolidGeometry,
  nodePosition: TripPosition,
  pathEndpoint: TripPosition,
  color: Rgba,
  lineWidth: number,
): void {
  if (sameTripPosition(nodePosition, pathEndpoint)) return;
  g.thickLine(
    tileCenter(nodePosition),
    tileCenter(pathEndpoint),
    lineWidth,
    color,
  );
}

function drawLegs(
  g: SolidGeometry,
  nodes: Map<string, TripPosition>,
  legs: RouteLegPath[],
  color: Rgba,
  lineWidth: number,
  routeId: string,
  corridors: CorridorGroups,
): void {
  let previousEnd: GeometrySample | undefined;
  for (const leg of legs) {
    const path = presentationPath(leg);
    const from = nodes.get(leg.fromWaypointId);
    const to = nodes.get(leg.toWaypointId);
    if (path !== null) {
      const isDashed = leg.status !== "connected";
      previousEnd = drawSteps(
        g,
        path,
        color,
        lineWidth,
        routeId,
        corridors,
        // Only failed last-valid geometry is dashed.
        isDashed ? BROKEN_LEG_DASH : undefined,
        previousEnd,
      );
      const firstStep = path.steps[0];
      const lastStep = path.steps[path.steps.length - 1];
      if (from !== undefined && firstStep !== undefined) {
        const pathStart = geometryEndpoint(
          offsetForRoute(firstStep.geometry, routeId, corridors),
          "start",
        );
        if (pathStart !== undefined) {
          drawEndpointConnector(g, from, pathStart, color, lineWidth);
        }
      }
      if (to !== undefined && lastStep !== undefined) {
        const pathEnd = geometryEndpoint(
          offsetForRoute(lastStep.geometry, routeId, corridors),
          "end",
        );
        if (pathEnd !== undefined) {
          drawEndpointConnector(g, pathEnd, to, color, lineWidth);
        }
      }
    } else {
      previousEnd = undefined;
      if (from !== undefined && to !== undefined) {
        // Broken leg with no last-valid geometry: dotted endpoint-to-endpoint.
        g.dashedLine(
          tileCenter(from),
          tileCenter(to),
          lineWidth,
          BROKEN_LEG_DASH.dash,
          BROKEN_LEG_DASH.gap,
          color,
        );
      }
    }
  }
}

function drawArrowhead(
  g: SolidGeometry,
  point: TripPosition,
  angleRadians: number,
  color: Rgba,
): void {
  const pixel = tileCenter(point);
  const cos = Math.cos(angleRadians);
  const sin = Math.sin(angleRadians);
  g.triangle(
    { x: pixel.x + 6 * cos, y: pixel.y + 6 * sin },
    { x: pixel.x - 4 * cos + 4 * sin, y: pixel.y - 4 * sin - 4 * cos },
    { x: pixel.x - 4 * cos - 4 * sin, y: pixel.y - 4 * sin + 4 * cos },
    color,
  );
}

function drawLineDirectionArrows(
  g: SolidGeometry,
  line: RenderableLine,
  corridors: CorridorGroups,
): void {
  for (const leg of line.legs) {
    const path = presentationPath(leg);
    if (path === null) continue;
    const presentation = offsetPath(path, line.id, corridors);
    for (const arrow of directionArrowSamples(
      presentation,
      DIRECTION_ARROW_SPACING_TILES,
    )) {
      drawArrowhead(g, arrow.point, arrow.angleRadians, parseColor(line.color));
    }
  }
}

function drawStopAccessIndicators(g: SolidGeometry, state: GameState): void {
  for (const stop of state.transit.stops) {
    const access = stop.roadAccess;
    if (stop.status !== "present" || access === undefined) continue;

    const from = tileCenter(stop.position);
    const to = tileCenter(access.roadPoint);
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.hypot(dx, dy);
    if (length === 0) continue;

    const unitX = dx / length;
    const unitY = dy / length;
    const arrowLength = Math.min(7, length / 3);
    const arrowWidth = Math.min(4, arrowLength / 2);
    const baseX = to.x - unitX * arrowLength;
    const baseY = to.y - unitY * arrowLength;

    g.thickLine(from, to, 2, ACCESS_INDICATOR_COLOR);
    g.triangle(
      to,
      { x: baseX - unitY * arrowWidth, y: baseY + unitX * arrowWidth },
      { x: baseX + unitY * arrowWidth, y: baseY - unitX * arrowWidth },
      ACCESS_INDICATOR_COLOR,
    );
  }
}

function roundedSquare(
  g: SolidGeometry,
  center: TripPosition,
  half: number,
  cornerRadius: number,
  color: Rgba,
): void {
  const inner = half - cornerRadius;
  g.rect(center.x - inner, center.y - half, inner * 2, half * 2, color);
  g.rect(center.x - half, center.y - inner, half * 2, inner * 2, color);
  for (const dx of [-1, 1]) {
    for (const dy of [-1, 1]) {
      g.circle(
        { x: center.x + dx * inner, y: center.y + dy * inner },
        cornerRadius,
        color,
        8,
      );
    }
  }
}

function markerColors(
  lines: readonly RenderableLine[],
  emphasizedIds: ReadonlySet<string>,
): Map<string, Rgba> {
  const byWaypoint = new Map<string, Rgba>();
  const emphasizedClaims = new Set<string>();
  for (const line of lines) {
    const emphasized = emphasizedIds.size === 0 || emphasizedIds.has(line.id);
    const color = withAlpha(
      parseColor(line.color),
      emphasized ? 1 : UNRELATED_ROUTE_OPACITY,
    );
    for (const waypointId of line.waypointIds) {
      if (emphasizedClaims.has(waypointId)) continue;
      if (!emphasized && byWaypoint.has(waypointId)) continue;
      byWaypoint.set(waypointId, color);
      if (emphasized) emphasizedClaims.add(waypointId);
    }
  }
  return byWaypoint;
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
  g: SolidGeometry,
  state: GameState,
  lines: readonly RenderableLine[],
  corridors: CorridorGroups,
  emphasizedIds: ReadonlySet<string>,
): void {
  for (const line of lines) {
    const cueColor = withAlpha(
      parseColor(line.color),
      emphasizedIds.size === 0 || emphasizedIds.has(line.id)
        ? 1
        : UNRELATED_ROUTE_OPACITY,
    );
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
      g.circle(
        tileCenter(presentation.translatePoint(node.position)),
        3,
        cueColor,
      );
    }
  }
}

/** The route the UI is actively editing, mirroring the canvas renderer's
 *  derivation from the route draft source. */
function editedRouteId(ui: UiState): string | null {
  return ui.routeDraft?.source.kind === "edit"
    ? ui.routeDraft.source.routeId
    : null;
}

/** Cache key for committed route geometry: scene revision plus the
 *  selected/edited-route emphasis. Hosts reuse it to skip re-tessellation
 *  while the structural scene and emphasis are unchanged. */
export function routeStyleKeyFor(ui: UiState, sceneRevision: number): string {
  return `routes:${sceneRevision}:${ui.selectedRouteId ?? "-"}:${editedRouteId(ui) ?? "-"}`;
}

/**
 * Tessellates committed transit presentation — emphasis halos, route legs
 * with corridor offsets, direction arrows, stop access indicators, stop and
 * station markers, and route node cues — in the same painter order as
 * renderTransit (minus vehicles and the draft, which are separate ranges).
 */
export function buildTransitBatch(
  state: GameState,
  ui: UiState,
  sceneRevision: number,
): { vertices: Float32Array<ArrayBuffer>; routeStyleKey: string } {
  const editedId = editedRouteId(ui);
  const routeStyleKey = routeStyleKeyFor(ui, sceneRevision);
  const emphasizedIds = new Set(
    [ui.selectedRouteId, editedId].filter(
      (routeId): routeId is string => routeId !== null,
    ),
  );
  const g = new SolidGeometry();
  const lines = renderableLines(state);
  const corridors = corridorsFor(state);
  const nodes = nodePositionMap(state);

  for (const line of lines) {
    if (!emphasizedIds.has(line.id)) continue;
    drawLegs(
      g,
      nodes,
      line.legs,
      HALO_COLOR,
      line.lineWidth + 4,
      line.id,
      corridors,
    );
  }

  for (const line of lines) {
    const color = withAlpha(
      parseColor(line.color),
      emphasizedIds.size === 0 || emphasizedIds.has(line.id)
        ? 1
        : UNRELATED_ROUTE_OPACITY,
    );
    drawLegs(g, nodes, line.legs, color, line.lineWidth, line.id, corridors);
  }

  for (const line of lines) {
    if (emphasizedIds.has(line.id)) {
      drawLineDirectionArrows(g, line, corridors);
    }
  }
  drawStopAccessIndicators(g, state);
  drawRouteNodeCues(g, state, lines, corridors, emphasizedIds);

  const markerColorsByWaypoint = markerColors(lines, emphasizedIds);
  for (const stop of state.transit.stops) {
    if (stop.status !== "present") continue;
    const point = tileCenter(stop.position);
    const rim = markerColorsByWaypoint.get(stop.id) ?? STOP_MARKER_COLOR;
    g.circle(point, STOP_MARKER_RADIUS, rim);
    g.circle(point, STOP_MARKER_RADIUS - MARKER_RIM_WIDTH, MARKER_FILL_COLOR);
  }
  for (const station of state.transit.stations) {
    if (station.status !== "present") continue;
    const point = tileCenter(station.position);
    const rim = markerColorsByWaypoint.get(station.id) ?? STATION_MARKER_COLOR;
    roundedSquare(g, point, STATION_MARKER_HALF, STATION_MARKER_CORNER, rim);
    roundedSquare(
      g,
      point,
      STATION_MARKER_HALF - MARKER_RIM_WIDTH,
      STATION_MARKER_CORNER - MARKER_RIM_WIDTH,
      MARKER_FILL_COLOR,
    );
  }

  return { vertices: g.toFloat32Array(), routeStyleKey };
}

/**
 * Tessellates the live route-draft stroke (the canvas draft block) as its own
 * dynamic range. Emits nothing when the draft is absent or its preview is
 * from a stale generation.
 */
export function draftLegVertices(
  state: GameState,
  ui: UiState,
): Float32Array<ArrayBuffer> {
  const draft = ui.routeDraft;
  const editedId = editedRouteId(ui);
  if (
    draft === null ||
    draft.preview === null ||
    draft.preview.generation !== draft.generation
  ) {
    return new Float32Array(0);
  }
  const draftLegs = draft.preview.legs;
  if (draftLegs.length < 1) {
    return new Float32Array(0);
  }

  const g = new SolidGeometry();
  const corridors = corridorsFor(state);
  const nodes = nodePositionMap(state);
  const draftRouteId = editedId ?? `draft-${draft.instanceId}`;

  for (const leg of draftLegs) {
    const path = presentationPath(leg);
    const from = nodes.get(leg.fromWaypointId);
    const to = nodes.get(leg.toWaypointId);
    if (path !== null) {
      drawSteps(g, path, DRAFT_COLOR, 3, draftRouteId, corridors, DRAFT_DASH);
      const firstStep = path.steps[0];
      const lastStep = path.steps[path.steps.length - 1];
      if (from !== undefined && firstStep !== undefined) {
        const pathStart = geometryEndpoint(
          offsetForRoute(firstStep.geometry, draftRouteId, corridors),
          "start",
        );
        if (pathStart !== undefined) {
          drawEndpointConnector(g, from, pathStart, DRAFT_COLOR, 3);
        }
      }
      if (to !== undefined && lastStep !== undefined) {
        const pathEnd = geometryEndpoint(
          offsetForRoute(lastStep.geometry, draftRouteId, corridors),
          "end",
        );
        if (pathEnd !== undefined) {
          drawEndpointConnector(g, pathEnd, to, DRAFT_COLOR, 3);
        }
      }
    } else if (from !== undefined && to !== undefined) {
      g.dashedLine(
        tileCenter(from),
        tileCenter(to),
        3,
        DRAFT_DASH.dash,
        DRAFT_DASH.gap,
        DRAFT_COLOR,
      );
    }
  }
  return g.toFloat32Array();
}
