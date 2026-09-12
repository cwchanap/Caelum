import type {
  GameState,
  PathGeometry,
  RouteLegPath,
  TransitPath,
  TripPosition,
} from "../../domain/types";
import type { UiState } from "../../ui/uiState";
import { tileSize } from "../boardTransform";
import { colors } from "../colors";
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

function center(point: TripPosition): TripPosition {
  return {
    x: point.x * tileSize + tileSize / 2,
    y: point.y * tileSize + tileSize / 2,
  };
}

function sameTripPosition(a: TripPosition, b: TripPosition): boolean {
  return a.x === b.x && a.y === b.y;
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
  ].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
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
): void {
  for (const step of path.steps) {
    const geometry = toPixelGeometry(
      offsetForRoute(step.geometry, routeId, corridors),
      center,
    );
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
  }
}

function drawEndpointConnector(
  g: SolidGeometry,
  nodePosition: TripPosition,
  pathEndpoint: TripPosition,
  color: Rgba,
  lineWidth: number,
): void {
  if (sameTripPosition(nodePosition, pathEndpoint)) return;
  g.thickLine(center(nodePosition), center(pathEndpoint), lineWidth, color);
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
  for (const leg of legs) {
    const path = presentationPath(leg);
    const from = nodes.get(leg.fromWaypointId);
    const to = nodes.get(leg.toWaypointId);
    if (path !== null) {
      drawSteps(
        g,
        path,
        color,
        lineWidth,
        routeId,
        corridors,
        // Canvas renderLeg dashes only the failed last-valid geometry.
        leg.status !== "connected" ? BROKEN_LEG_DASH : undefined,
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
    } else if (from !== undefined && to !== undefined) {
      // Broken leg with no last-valid geometry: dotted endpoint-to-endpoint.
      g.dashedLine(
        center(from),
        center(to),
        lineWidth,
        BROKEN_LEG_DASH.dash,
        BROKEN_LEG_DASH.gap,
        color,
      );
    }
  }
}

function drawArrowhead(
  g: SolidGeometry,
  point: TripPosition,
  angleRadians: number,
  color: Rgba,
): void {
  const pixel = center(point);
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

    const from = center(stop.position);
    const to = center(access.roadPoint);
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
      g.circle(center(presentation.translatePoint(node.position)), 3, cueColor);
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
  const corridors = buildCorridorGroups(lines);
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

  for (const stop of state.transit.stops) {
    if (stop.status !== "present") continue;
    const point = center(stop.position);
    g.rect(point.x - 5, point.y - 5, 10, 10, STOP_MARKER_COLOR);
  }
  for (const station of state.transit.stations) {
    if (station.status !== "present") continue;
    g.circle(center(station.position), 8, STATION_MARKER_COLOR);
  }
  drawRouteNodeCues(g, state, lines, corridors, emphasizedIds);

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
  const draftLegs =
    draft !== null &&
    draft.preview !== null &&
    draft.preview.generation === draft.generation
      ? draft.preview.legs
      : [];
  if (draftLegs.length < 1) {
    return new Float32Array(0);
  }

  const g = new SolidGeometry();
  const corridors = buildCorridorGroups(renderableLines(state));
  const nodes = nodePositionMap(state);
  const draftRouteId = editedId ?? `draft-${draft?.instanceId ?? 0}`;

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
        center(from),
        center(to),
        3,
        DRAFT_DASH.dash,
        DRAFT_DASH.gap,
        DRAFT_COLOR,
      );
    }
  }
  return g.toFloat32Array();
}
