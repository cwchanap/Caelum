import { describe, expect, it } from "vitest";
import type { TransitPath } from "../../src/domain/types";
import {
  canonicalCorridorPrimitive,
  corridorOffsets,
  directionArrowSamples,
  offsetGeometry,
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
});

describe("offsetGeometry", () => {
  it("translates every authored geometry point along the canonical normal", () => {
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

    expect(offset).toEqual({
      kind: "quadraticBezier",
      from: { x: 1, y: 2.25 },
      control: { x: 2, y: 3.25 },
      to: { x: 3, y: 2.25 },
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
});
