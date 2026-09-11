import { expect, it } from "vitest";
import type { PathGeometry, TripPosition } from "../../src/domain/types";
import { pointAndTangentAt, pointAt } from "../../src/render/pathGeometry";

function lineGeometry(): PathGeometry {
  return { kind: "line", from: { x: 1, y: 2 }, to: { x: 3, y: 4 } };
}

function quadraticGeometry(): PathGeometry {
  return {
    kind: "quadraticBezier",
    from: { x: 1, y: 2 },
    control: { x: 3, y: 1 },
    to: { x: 4, y: 5 },
  };
}

function arcGeometry(): PathGeometry {
  return {
    kind: "arc",
    center: { x: 2, y: 3 },
    radius: 2,
    startRadians: 0,
    sweepRadians: Math.PI / 2,
  };
}

function geometryStart(geometry: PathGeometry): TripPosition {
  return geometry.kind === "arc"
    ? {
        x:
          geometry.center.x + Math.cos(geometry.startRadians) * geometry.radius,
        y:
          geometry.center.y + Math.sin(geometry.startRadians) * geometry.radius,
      }
    : geometry.from;
}

function geometryEnd(geometry: PathGeometry): TripPosition {
  if (geometry.kind !== "arc") {
    return geometry.to;
  }
  const angle = geometry.startRadians + geometry.sweepRadians;
  return {
    x: geometry.center.x + Math.cos(angle) * geometry.radius,
    y: geometry.center.y + Math.sin(angle) * geometry.radius,
  };
}

it("samples every tagged geometry kind at its endpoints", () => {
  for (const geometry of [
    lineGeometry(),
    quadraticGeometry(),
    arcGeometry(),
  ] satisfies PathGeometry[]) {
    expect(pointAt(geometry, 0)).toEqual(geometryStart(geometry));
    expect(pointAt(geometry, 1)).toEqual(geometryEnd(geometry));
  }
});

it("interpolates a line by its progress", () => {
  expect(pointAt(lineGeometry(), 0.5)).toEqual({ x: 2, y: 3 });
});

it("returns position and tangent on a quadratic turn", () => {
  const geometry: PathGeometry = {
    kind: "quadraticBezier",
    from: { x: 0, y: 0 },
    control: { x: 1, y: 0 },
    to: { x: 1, y: 1 },
  };

  expect(pointAndTangentAt(geometry, 0.5)).toEqual({
    point: { x: 0.75, y: 0.25 },
    tangent: { x: 1, y: 1 },
  });
});

it("follows an arc in its signed sweep direction", () => {
  const sample = pointAndTangentAt(
    {
      kind: "arc",
      center: { x: 2, y: 2 },
      radius: 1,
      startRadians: 0,
      sweepRadians: Math.PI / 2,
    },
    1,
  );
  expect(sample.point.x).toBeCloseTo(2);
  expect(sample.point.y).toBeCloseTo(3);
  expect(sample.tangent.x).toBeCloseTo(-1);
  expect(sample.tangent.y).toBeCloseTo(0);
});
