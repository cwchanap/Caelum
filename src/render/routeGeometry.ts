import type {
  MovementKind,
  PathGeometry,
  TransitPath,
  TripPosition,
} from "../domain/types";
import { pointAndTangentAt } from "./pathRenderer";

const GEOMETRY_SAMPLE_SEGMENTS = 32;

function translated(point: TripPosition, dx: number, dy: number): TripPosition {
  return { x: point.x + dx, y: point.y + dy };
}

export function translateGeometry(
  geometry: PathGeometry,
  dx: number,
  dy: number,
): PathGeometry {
  if (geometry.kind === "line") {
    return {
      kind: "line",
      from: translated(geometry.from, dx, dy),
      to: translated(geometry.to, dx, dy),
    };
  }
  if (geometry.kind === "quadraticBezier") {
    return {
      kind: "quadraticBezier",
      from: translated(geometry.from, dx, dy),
      control: translated(geometry.control, dx, dy),
      to: translated(geometry.to, dx, dy),
    };
  }
  return {
    ...geometry,
    center: translated(geometry.center, dx, dy),
  };
}

export function corridorOffsets(
  routeIds: readonly string[],
  gap: number,
): ReadonlyMap<string, number> {
  const stable = [...new Set(routeIds)].sort();
  return new Map(
    stable.map((id, index) => [id, (index - (stable.length - 1) / 2) * gap]),
  );
}

export function offsetGeometry(
  geometry: PathGeometry,
  pixels: number,
  canonicalTangent: TripPosition,
): PathGeometry {
  const length = Math.hypot(canonicalTangent.x, canonicalTangent.y) || 1;
  const normal = {
    x: -canonicalTangent.y / length,
    y: canonicalTangent.x / length,
  };
  return translateGeometry(geometry, normal.x * pixels, normal.y * pixels);
}

function stableNumber(value: number): string {
  const normalized = Object.is(value, -0) ? 0 : value;
  return Number(normalized.toFixed(9)).toString();
}

function pointKey(point: TripPosition): string {
  return `${stableNumber(point.x)},${stableNumber(point.y)}`;
}

function withoutNegativeZero(point: TripPosition): TripPosition {
  return {
    x: Object.is(point.x, -0) ? 0 : point.x,
    y: Object.is(point.y, -0) ? 0 : point.y,
  };
}

function normalizedRadians(value: number): number {
  const tau = Math.PI * 2;
  const normalized = ((value % tau) + tau) % tau;
  return Math.abs(normalized - tau) < 1e-9 ? 0 : normalized;
}

function ordered(left: string, right: string): [string, string] {
  return left <= right ? [left, right] : [right, left];
}

export function geometryKey(geometry: PathGeometry): string {
  const start = pointAndTangentAt(geometry, 0).point;
  const end = pointAndTangentAt(geometry, 1).point;
  const [from, to] = ordered(pointKey(start), pointKey(end));
  if (geometry.kind === "line") {
    return `line:${from}|${to}`;
  }
  if (geometry.kind === "quadraticBezier") {
    return `quadratic:${from}|${pointKey(geometry.control)}|${to}`;
  }
  const endpointAngles = ordered(
    stableNumber(normalizedRadians(geometry.startRadians)),
    stableNumber(
      normalizedRadians(geometry.startRadians + geometry.sweepRadians),
    ),
  );
  return [
    "arc",
    pointKey(geometry.center),
    stableNumber(geometry.radius),
    ...endpointAngles,
  ].join(":");
}

export interface CorridorPrimitive {
  key: string;
  canonicalTangent: TripPosition;
}

export function canonicalCorridorPrimitive(
  geometry: PathGeometry,
): CorridorPrimitive {
  const start = pointAndTangentAt(geometry, 0);
  const end = pointAndTangentAt(geometry, 1);
  const forward = pointKey(start.point) <= pointKey(end.point);
  return {
    key: geometryKey(geometry),
    canonicalTangent: withoutNegativeZero(
      forward ? start.tangent : { x: -end.tangent.x, y: -end.tangent.y },
    ),
  };
}

interface GeometryDistanceSample {
  progress: number;
  distance: number;
}

interface MeasuredGeometry {
  length: number;
  samples: GeometryDistanceSample[];
}

function measureGeometry(geometry: PathGeometry): MeasuredGeometry {
  const segments =
    geometry.kind === "line"
      ? 1
      : geometry.kind === "arc"
        ? Math.max(
            8,
            Math.ceil(
              (Math.abs(geometry.sweepRadians) / (Math.PI * 2)) *
                GEOMETRY_SAMPLE_SEGMENTS,
            ),
          )
        : GEOMETRY_SAMPLE_SEGMENTS;
  const samples: GeometryDistanceSample[] = [{ progress: 0, distance: 0 }];
  let previous = pointAndTangentAt(geometry, 0).point;
  let distance = 0;
  for (let index = 1; index <= segments; index += 1) {
    const progress = index / segments;
    const point = pointAndTangentAt(geometry, progress).point;
    distance += Math.hypot(point.x - previous.x, point.y - previous.y);
    samples.push({ progress, distance });
    previous = point;
  }
  return { length: distance, samples };
}

function progressAtDistance(
  measured: MeasuredGeometry,
  distance: number,
): number {
  const target = Math.max(0, Math.min(measured.length, distance));
  const upperIndex = measured.samples.findIndex(
    (sample) => sample.distance >= target,
  );
  if (upperIndex <= 0) return 0;
  const upper = measured.samples[upperIndex];
  const lower = measured.samples[upperIndex - 1];
  const span = upper.distance - lower.distance;
  const local = span === 0 ? 0 : (target - lower.distance) / span;
  return lower.progress + (upper.progress - lower.progress) * local;
}

interface PathDistanceSample {
  point: TripPosition;
  tangent: TripPosition;
  movement: MovementKind | "track";
  distanceFromEndpoint: number;
}

function samplePathByDistance(
  path: TransitPath,
  spacingTiles: number,
): PathDistanceSample[] {
  if (spacingTiles <= 0 || path.steps.length === 0) return [];
  const measured = path.steps.map((step) => measureGeometry(step.geometry));
  const totalLength = measured.reduce((total, item) => total + item.length, 0);
  const samples: PathDistanceSample[] = [];
  for (
    let pathDistance = spacingTiles;
    pathDistance < totalLength;
    pathDistance += spacingTiles
  ) {
    let accumulated = 0;
    let stepIndex = 0;
    while (
      stepIndex < measured.length - 1 &&
      pathDistance > accumulated + measured[stepIndex].length
    ) {
      accumulated += measured[stepIndex].length;
      stepIndex += 1;
    }
    const progress = progressAtDistance(
      measured[stepIndex],
      pathDistance - accumulated,
    );
    const geometrySample = pointAndTangentAt(
      path.steps[stepIndex].geometry,
      progress,
    );
    samples.push({
      ...geometrySample,
      movement: path.kind === "road" ? path.steps[stepIndex].movement : "track",
      distanceFromEndpoint: Math.min(pathDistance, totalLength - pathDistance),
    });
  }
  return samples;
}

export interface DirectionArrowSample {
  point: TripPosition;
  angleRadians: number;
  movement: MovementKind | "track";
}

export function directionArrowSamples(
  path: TransitPath,
  spacingTiles: number,
): DirectionArrowSample[] {
  return samplePathByDistance(path, spacingTiles)
    .filter((sample) => sample.distanceFromEndpoint >= 0.5)
    .map((sample) => ({
      point: sample.point,
      angleRadians: Math.atan2(sample.tangent.y, sample.tangent.x),
      movement: sample.movement,
    }));
}
