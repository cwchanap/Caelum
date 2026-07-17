import { describe, expect, it } from "vitest";
import type { TransitPath } from "../../src/domain/types";
import {
  canonicalCorridorPrimitive,
  corridorOffsets,
  directionArrowSamples,
  offsetGeometry,
  routePathPresentation,
} from "../../src/render/routeGeometry";

function curvedMovementPath(): TransitPath {
  return {
    kind: "road",
    steps: [
      {
        position: { x: 0, y: 0 },
        enteringHeading: "east",
        leavingHeading: "west",
        movement: "uTurn",
        geometry: {
          kind: "quadraticBezier",
          from: { x: 0, y: 0 },
          control: { x: 2, y: -2 },
          to: { x: 0, y: -4 },
        },
        travelSeconds: 1,
      },
      {
        position: { x: 0, y: -4 },
        enteringHeading: "west",
        leavingHeading: "south",
        movement: "roundaboutCirculation",
        geometry: {
          kind: "arc",
          center: { x: 2, y: -4 },
          radius: 2,
          startRadians: Math.PI,
          sweepRadians: -Math.PI,
        },
        travelSeconds: 1,
      },
    ],
    totalTravelSeconds: 2,
  };
}

describe("corridorOffsets", () => {
  it("centers stable offsets by sorted route id", () => {
    expect(
      corridorOffsets(["route-0003", "route-0001", "route-0002"], 3),
    ).toEqual(
      new Map([
        ["route-0001", -3],
        ["route-0002", 0],
        ["route-0003", 3],
      ]),
    );
  });

  it("gives the same offsets regardless of insertion order", () => {
    expect([...corridorOffsets(["b", "a", "c"], 4)]).toEqual([
      ...corridorOffsets(["c", "b", "a"], 4),
    ]);
  });

  it("groups opposite directions under one canonical primitive", () => {
    const eastbound = {
      kind: "line" as const,
      from: { x: 1, y: 3 },
      to: { x: 5, y: 3 },
    };
    const westbound = {
      kind: "line" as const,
      from: eastbound.to,
      to: eastbound.from,
    };

    const forward = canonicalCorridorPrimitive(eastbound);
    const reverse = canonicalCorridorPrimitive(westbound);

    expect(reverse.key).toBe(forward.key);
    expect(reverse.canonicalTangent).toEqual(forward.canonicalTangent);
  });

  it("groups reversed quadratic and arc primitives without direction labels", () => {
    const quadratic = {
      kind: "quadraticBezier" as const,
      from: { x: 1, y: 2 },
      control: { x: 3, y: 4 },
      to: { x: 5, y: 2 },
    };
    const reverseQuadratic = {
      ...quadratic,
      from: quadratic.to,
      to: quadratic.from,
    };
    const arc = {
      kind: "arc" as const,
      center: { x: 8, y: 8 },
      radius: 2,
      startRadians: 0,
      sweepRadians: Math.PI / 2,
    };
    const reverseArc = {
      ...arc,
      startRadians: Math.PI / 2,
      sweepRadians: -Math.PI / 2,
    };

    expect(canonicalCorridorPrimitive(reverseQuadratic)).toEqual(
      canonicalCorridorPrimitive(quadratic),
    );
    const forwardArc = canonicalCorridorPrimitive(arc);
    const backwardArc = canonicalCorridorPrimitive(reverseArc);
    expect(backwardArc.key).toBe(forwardArc.key);
    expect(backwardArc.canonicalTangent.x).toBeCloseTo(
      forwardArc.canonicalTangent.x,
      10,
    );
    expect(backwardArc.canonicalTangent.y).toBeCloseTo(
      forwardArc.canonicalTangent.y,
      10,
    );
  });
});

describe("routePathPresentation", () => {
  it("maps points on a zero-sweep arc without dividing by zero", () => {
    const presentation = routePathPresentation(
      {
        kind: "arc",
        center: { x: 2, y: 2 },
        radius: 1,
        startRadians: 0,
        sweepRadians: 0,
      },
      0.5,
      { x: 0, y: 1 },
    );
    const mapped = presentation.translatePoint({ x: 3, y: 2 });
    expect(Number.isFinite(mapped.x)).toBe(true);
    expect(Number.isFinite(mapped.y)).toBe(true);
  });
});

describe("offsetGeometry", () => {
  it("offsets Bézier endpoints along local normals matching the canonical side", () => {
    const offset = offsetGeometry(
      {
        kind: "quadraticBezier",
        from: { x: 1, y: 2 },
        control: { x: 2, y: 3 },
        to: { x: 3, y: 2 },
      },
      0.25,
      { x: 1, y: 0 },
    );

    // Canonical normal is (0, 1). Start tangent is (2, 2) → unit normal
    // (-√2/2, √2/2), sign +1. End tangent is (2, -2) → unit normal
    // (√2/2, √2/2), sign +1. Control offset is the average.
    const s = Math.sqrt(2) / 8; // 0.25 * √2/2 / 2
    expect(offset).toEqual({
      kind: "quadraticBezier",
      from: { x: 1 - s, y: 2 + s },
      control: { x: 2, y: 3 + s },
      to: { x: 3 + s, y: 2 + s },
    });
  });

  it("offsets arcs by adjusting the radius", () => {
    const offset = offsetGeometry(
      {
        kind: "arc",
        center: { x: 2, y: 2 },
        radius: 1,
        startRadians: 0,
        sweepRadians: Math.PI / 2,
      },
      0.25,
      // Tangent at start (0°, CCW) is (0, 1); canonical normal is (-1, 0).
      // Radial at start is (1, 0). dot((-1,0), (1,0)) = -1 < 0 → decrease.
      { x: 0, y: 1 },
    );

    expect(offset).toEqual({
      kind: "arc",
      center: { x: 2, y: 2 },
      radius: 0.75,
      startRadians: 0,
      sweepRadians: Math.PI / 2,
    });
  });
});

describe("directionArrowSamples", () => {
  it("arrow tangents follow a U-turn and roundabout arc", () => {
    const arrows = directionArrowSamples(curvedMovementPath(), 1.5);

    expect(arrows.map((arrow) => arrow.movement)).toEqual(
      expect.arrayContaining(["uTurn", "roundaboutCirculation"]),
    );
    expect(arrows.every((arrow) => Number.isFinite(arrow.angleRadians))).toBe(
      true,
    );
  });

  it("returns concrete quadratic U-turn positions and tangents", () => {
    const path: TransitPath = {
      kind: "road",
      steps: [
        {
          position: { x: 0, y: 0 },
          enteringHeading: "east",
          leavingHeading: "west",
          movement: "uTurn",
          geometry: {
            kind: "quadraticBezier",
            from: { x: 0, y: 0 },
            control: { x: 1, y: 1 },
            to: { x: 2, y: 0 },
          },
          travelSeconds: 1,
        },
      ],
      totalTravelSeconds: 1,
    };

    expect(directionArrowSamples(path, 1)).toEqual([
      {
        point: {
          x: expect.closeTo(0.8528943093, 8),
          y: expect.closeTo(0.4891799579, 8),
        },
        angleRadians: expect.closeTo(0.1460581325, 8),
        movement: "uTurn",
      },
    ]);
  });

  it("returns concrete roundabout arc positions and tangents", () => {
    const path: TransitPath = {
      kind: "road",
      steps: [
        {
          position: { x: 2, y: 0 },
          enteringHeading: "south",
          leavingHeading: "west",
          movement: "roundaboutCirculation",
          geometry: {
            kind: "arc",
            center: { x: 0, y: 0 },
            radius: 2,
            startRadians: 0,
            sweepRadians: Math.PI / 2,
          },
          travelSeconds: 1,
        },
      ],
      totalTravelSeconds: 1,
    };

    expect(directionArrowSamples(path, Math.PI / 2)).toEqual([
      {
        point: {
          x: expect.closeTo(1.4124261858, 8),
          y: expect.closeTo(1.4159986828, 8),
        },
        angleRadians: expect.closeTo(2.3574575589, 8),
        movement: "roundaboutCirculation",
      },
    ]);
  });
});
