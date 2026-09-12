import type {
  GameState,
  PathGeometry,
  RouteLegPath,
  TripPosition,
  Vehicle,
} from "../../domain/types";
import type { UiState } from "../../ui/uiState";
import { tileSize } from "../boardTransform";
import { colors } from "../colors";
import { pointAndTangentAt } from "../pathGeometry";
import { VEHICLE_INSTANCE_FLOATS } from "./renderer";
import { parseColor, withAlpha, type Rgba } from "./primitives";
import {
  buildCorridorGroups,
  presentationForRoute,
  presentationPath,
  renderableLines,
  type CorridorGroups,
  UNRELATED_ROUTE_OPACITY,
} from "./transitBatch";

export interface WorldViewport {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Observed-interval alpha between two accepted presentation states. Renders
 *  vehicle motion one observed publication interval behind authority; never
 *  extrapolates past the latest observation. */
export function interpolationAlpha(
  previousObservedAtMs: number,
  latestObservedAtMs: number,
  rafNowMs: number,
): number {
  const interval = Math.max(1, latestObservedAtMs - previousObservedAtMs);
  return Math.max(0, Math.min(1, (rafNowMs - latestObservedAtMs) / interval));
}

/** World-space instance layout: x, y, angle, halfLength, halfWidth, r, g, b,
 *  a (pixels). The stride is the shader's 11 floats; transformInstances fills
 *  the two trailing slots with the world→clip factors. */
const INSTANCE_FLOATS = VEHICLE_INSTANCE_FLOATS;
const VEHICLE_HALF_LENGTH = 7;
const VEHICLE_HALF_WIDTH = 4;
const BUS_COLOR: Rgba = parseColor(colors.bus);
const METRO_COLOR: Rgba = parseColor(colors.metro);

function center(point: TripPosition): TripPosition {
  return {
    x: point.x * tileSize + tileSize / 2,
    y: point.y * tileSize + tileSize / 2,
  };
}

function itineraryFor(
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

/** Resolves the authored path step a vehicle cursor points at. Mirrors the
 *  canvas renderer: the leg's currentPath, itinerary index taken modulo the
 *  itinerary length. */
function stepAt(
  state: GameState,
  vehicle: Vehicle,
): { geometry: PathGeometry; travelSeconds: number } | undefined {
  const itinerary = itineraryFor(state, vehicle);
  if (itinerary === null || itinerary.length === 0) return undefined;
  const leg = itinerary[vehicle.itineraryIndex % itinerary.length];
  return leg?.currentPath?.steps[vehicle.pathStepIndex];
}

interface CursorSample {
  point: TripPosition;
  /** radians, or null when no tangent exists (parked) */
  angle: number | null;
}

/** Snap target: the latest cursor sampled on its own. Vehicles ride the
 *  same corridor-offset lane the committed route lines draw. */
function latestSample(
  state: GameState,
  vehicle: Vehicle,
  corridors: CorridorGroups,
): CursorSample | null {
  const itinerary = itineraryFor(state, vehicle);
  if (itinerary === null || itinerary.length === 0) {
    return vehicle.parkedPosition === null
      ? null
      : { point: center(vehicle.parkedPosition), angle: null };
  }
  const leg = itinerary[vehicle.itineraryIndex % itinerary.length];
  const step = leg?.currentPath?.steps[vehicle.pathStepIndex];
  if (step === undefined) {
    // Zero-step terminal reversals have a connected empty path and no step;
    // park at the terminal waypoint so paused/exact-boundary vehicles remain
    // visible instead of disappearing.
    if (
      vehicle.parkedPosition === null &&
      leg !== undefined &&
      leg.currentPath !== null &&
      leg.currentPath.steps.length === 0
    ) {
      const terminal = terminalWaypointPosition(state, vehicle, leg);
      if (terminal !== null) {
        return { point: center(terminal), angle: null };
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
    return { point: center(point), angle: null };
  }
  const presented = presentationForRoute(
    step.geometry,
    vehicle.lineId,
    corridors,
  ).geometry;
  const sample = pointAndTangentAt(presented, vehicle.stepProgress);
  return {
    point: center(sample.point),
    angle:
      vehicle.mode === "bus"
        ? Math.atan2(sample.tangent.y, sample.tangent.x)
        : null,
  };
}

/** Terminal/road-access anchor for a zero-step terminal reversal: the bus
 *  stop's road access point (passenger anchor fallback), or the station
 *  position. */
function terminalWaypointPosition(
  state: GameState,
  vehicle: Vehicle,
  leg: RouteLegPath,
): TripPosition | null {
  if (vehicle.mode === "bus") {
    const stop = state.transit.stops.find(
      (candidate) =>
        candidate.id === leg.fromWaypointId && candidate.status === "present",
    );
    return stop?.roadAccess?.roadPoint ?? stop?.position ?? null;
  }
  const station = state.transit.stations.find(
    (candidate) =>
      candidate.id === leg.fromWaypointId && candidate.status === "present",
  );
  return station?.position ?? null;
}

function sameGeometry(a: PathGeometry, b: PathGeometry): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "line" && b.kind === "line") {
    return (
      a.from.x === b.from.x &&
      a.from.y === b.from.y &&
      a.to.x === b.to.x &&
      a.to.y === b.to.y
    );
  }
  if (a.kind === "quadraticBezier" && b.kind === "quadraticBezier") {
    return (
      a.from.x === b.from.x &&
      a.from.y === b.from.y &&
      a.control.x === b.control.x &&
      a.control.y === b.control.y &&
      a.to.x === b.to.x &&
      a.to.y === b.to.y
    );
  }
  if (a.kind === "arc" && b.kind === "arc") {
    return (
      a.center.x === b.center.x &&
      a.center.y === b.center.y &&
      a.radius === b.radius &&
      a.startRadians === b.startRadians &&
      a.sweepRadians === b.sweepRadians
    );
  }
  return false;
}

/** Corridor offsets are state-derived presentation, and GameState is
 *  immutable with reference-equality dispatch, so they cache on state
 *  identity like the canvas renderer's transit cache did. */
const corridorsCache = new WeakMap<GameState, CorridorGroups>();

function corridorsFor(state: GameState): CorridorGroups {
  let corridors = corridorsCache.get(state);
  if (corridors === undefined) {
    corridors = buildCorridorGroups(renderableLines(state));
    corridorsCache.set(state, corridors);
  }
  return corridors;
}

export interface EncodeVehicleInstancesInput {
  /** Previous accepted state, or null after a scene change. */
  previous: GameState | null;
  latest: GameState;
  ui: UiState;
  /** Precomputed with interpolationAlpha; ignored while snapping. */
  alpha: number;
  /** Pause or speed 0: every vehicle snaps to its latest cursor. */
  paused: boolean;
  viewport: WorldViewport;
}

/** Interpolates the latest presented vehicles in path space against the
 *  previous accepted state, culls to the viewport plus one tile margin, and
 *  encodes visible instances in the presented (stable vehicle) order. */
export function encodeVehicleInstances(
  input: EncodeVehicleInstancesInput,
): Float32Array<ArrayBuffer> {
  const { previous, latest, alpha, paused } = input;
  const corridors = corridorsFor(latest);
  const previousById = new Map<string, Vehicle>();
  if (previous !== null) {
    for (const vehicle of previous.transit.vehicles) {
      previousById.set(vehicle.id, vehicle);
    }
  }

  const instances = new Float32Array(
    latest.transit.vehicles.length * INSTANCE_FLOATS,
  );
  let offset = 0;
  for (const vehicle of latest.transit.vehicles) {
    const previousVehicle = previousById.get(vehicle.id);
    const sample =
      paused || previousVehicle === undefined
        ? latestSample(latest, vehicle, corridors)
        : interpolateSample(
            previousVehicle,
            previous,
            vehicle,
            latest,
            alpha,
            corridors,
          );
    if (sample === null) continue;
    // 1. Route-emphasis opacity, 2. cull after sampling with a one-tile
    // margin, 3. encode — in that order per the design's pipeline.
    const color = withAlpha(
      vehicle.mode === "bus" ? BUS_COLOR : METRO_COLOR,
      emphasizedOpacity(input, vehicle),
    );
    const margin = tileSize;
    if (
      sample.point.x < input.viewport.minX - margin ||
      sample.point.x > input.viewport.maxX + margin ||
      sample.point.y < input.viewport.minY - margin ||
      sample.point.y > input.viewport.maxY + margin
    ) {
      continue;
    }
    instances[offset] = sample.point.x;
    instances[offset + 1] = sample.point.y;
    instances[offset + 2] = sample.angle ?? 0;
    instances[offset + 3] = VEHICLE_HALF_LENGTH;
    instances[offset + 4] = VEHICLE_HALF_WIDTH;
    instances[offset + 5] = color[0];
    instances[offset + 6] = color[1];
    instances[offset + 7] = color[2];
    instances[offset + 8] = color[3];
    offset += INSTANCE_FLOATS;
  }
  return instances.subarray(0, offset) as Float32Array<ArrayBuffer>;
}

function emphasizedOpacity(
  input: EncodeVehicleInstancesInput,
  vehicle: Vehicle,
): number {
  const editedRouteId =
    input.ui.routeDraft?.source.kind === "edit"
      ? input.ui.routeDraft.source.routeId
      : null;
  const hasEmphasis =
    input.ui.selectedRouteId !== null || editedRouteId !== null;
  const emphasized =
    hasEmphasis &&
    (vehicle.lineId === input.ui.selectedRouteId ||
      vehicle.lineId === editedRouteId);
  return emphasized || !hasEmphasis ? 1 : UNRELATED_ROUTE_OPACITY;
}

/** Same-line, same-itinerary continuity: same step, or exactly one step
 *  forward. Any discontinuity snaps to the latest cursor. */
function isContinuous(
  previousVehicle: Vehicle,
  latestVehicle: Vehicle,
): boolean {
  return (
    previousVehicle.lineId === latestVehicle.lineId &&
    previousVehicle.mode === latestVehicle.mode &&
    previousVehicle.itineraryIndex === latestVehicle.itineraryIndex &&
    (previousVehicle.parkedPosition === null) ===
      (latestVehicle.parkedPosition === null) &&
    (latestVehicle.pathStepIndex === previousVehicle.pathStepIndex ||
      latestVehicle.pathStepIndex === previousVehicle.pathStepIndex + 1)
  );
}

/** Same-line, same-itinerary, same-step interpolation; any discontinuity
 *  snaps to the latest cursor. The adjacent-step path deliberately has no
 *  backward-progress guard: a rollover legitimately resets progress while
 *  time moves forward (pinned by the rollover tests with latest progress
 *  numerically below previous). */
function interpolateSample(
  previousVehicle: Vehicle,
  previousState: GameState | null,
  latestVehicle: Vehicle,
  latestState: GameState,
  alpha: number,
  corridors: CorridorGroups,
): CursorSample | null {
  if (!isContinuous(previousVehicle, latestVehicle)) {
    return latestSample(latestState, latestVehicle, corridors);
  }
  if (latestVehicle.pathStepIndex === previousVehicle.pathStepIndex) {
    return sameStepSample(
      previousVehicle,
      previousState,
      latestVehicle,
      latestState,
      alpha,
      corridors,
    );
  }
  return adjacentStepSample(
    previousVehicle,
    latestVehicle,
    latestState,
    alpha,
    corridors,
  );
}

function sameStepSample(
  previousVehicle: Vehicle,
  previousState: GameState | null,
  latestVehicle: Vehicle,
  latestState: GameState,
  alpha: number,
  corridors: CorridorGroups,
): CursorSample | null {
  const previousStep =
    previousState === null ? undefined : stepAt(previousState, previousVehicle);
  const latestStep = stepAt(latestState, latestVehicle);
  if (previousStep === undefined || latestStep === undefined) {
    return latestSample(latestState, latestVehicle, corridors);
  }
  if (!sameGeometry(previousStep.geometry, latestStep.geometry)) {
    // The path under this cursor changed (route edit): snap to latest.
    return latestSample(latestState, latestVehicle, corridors);
  }
  if (latestVehicle.stepProgress < previousVehicle.stepProgress) {
    // Backward cursor jump within the same step (spec snap list): snap to
    // latest instead of interpolating the vehicle backwards along its lane.
    return latestSample(latestState, latestVehicle, corridors);
  }
  const progress =
    previousVehicle.stepProgress +
    (latestVehicle.stepProgress - previousVehicle.stepProgress) * alpha;
  return sampleStep(latestVehicle, latestStep.geometry, progress, corridors);
}

/** One adjacent step forward on the same itinerary path: interpolate through
 *  the remaining previous-step time plus the elapsed latest-step time. Both
 *  steps resolve from the latest state, so the index arithmetic alone proves
 *  adjacency within one presented path. */
function adjacentStepSample(
  previousVehicle: Vehicle,
  latestVehicle: Vehicle,
  latestState: GameState,
  alpha: number,
  corridors: CorridorGroups,
): CursorSample | null {
  const previousStep = stepAt(latestState, {
    ...latestVehicle,
    pathStepIndex: previousVehicle.pathStepIndex,
  });
  const latestStep = stepAt(latestState, latestVehicle);
  if (
    previousStep === undefined ||
    latestStep === undefined ||
    !validSeconds(previousStep.travelSeconds) ||
    !validSeconds(latestStep.travelSeconds)
  ) {
    return latestSample(latestState, latestVehicle, corridors);
  }
  const remainingPrevious =
    (1 - previousVehicle.stepProgress) * previousStep.travelSeconds;
  const elapsedLatest = latestVehicle.stepProgress * latestStep.travelSeconds;
  const span = remainingPrevious + elapsedLatest;
  if (!(span > 0)) {
    // Zero or invalid span cannot prove traversal; snap to latest.
    return latestSample(latestState, latestVehicle, corridors);
  }
  const target = alpha * span;
  if (target <= remainingPrevious) {
    const progress =
      1 - (remainingPrevious - target) / previousStep.travelSeconds;
    return sampleStep(
      latestVehicle,
      previousStep.geometry,
      progress,
      corridors,
    );
  }
  const progress = (target - remainingPrevious) / latestStep.travelSeconds;
  return sampleStep(latestVehicle, latestStep.geometry, progress, corridors);
}

function validSeconds(travelSeconds: number): boolean {
  return Number.isFinite(travelSeconds) && travelSeconds > 0;
}

function sampleStep(
  vehicle: Vehicle,
  geometry: PathGeometry,
  progress: number,
  corridors: CorridorGroups,
): CursorSample {
  const clamped = Math.max(0, Math.min(1, progress));
  const presented = presentationForRoute(
    geometry,
    vehicle.lineId,
    corridors,
  ).geometry;
  const sample = pointAndTangentAt(presented, clamped);
  return {
    point: center(sample.point),
    angle:
      vehicle.mode === "bus"
        ? Math.atan2(sample.tangent.y, sample.tangent.x)
        : null,
  };
}
