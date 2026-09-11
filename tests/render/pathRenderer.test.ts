import { expect, it } from "vitest";
import type { PathGeometry, TripPosition } from "../../src/domain/types";
import { drawPathGeometry } from "../../src/render/pathRenderer";

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

function recordingContext(): CanvasRenderingContext2D & {
  commandKinds(): string[];
} {
  const commands: string[] = [];
  return {
    beginPath: () => undefined,
    moveTo: () => commands.push("moveTo"),
    lineTo: () => commands.push("lineTo"),
    quadraticCurveTo: () => commands.push("quadraticCurveTo"),
    arc: () => commands.push("arc"),
    stroke: () => commands.push("stroke"),
    commandKinds: () => commands,
  } as unknown as CanvasRenderingContext2D & { commandKinds(): string[] };
}

const identityTileToPixel = (point: TripPosition): TripPosition => point;

it("draws every tagged geometry", () => {
  const ctx = recordingContext();
  for (const geometry of [
    lineGeometry(),
    quadraticGeometry(),
    arcGeometry(),
  ] satisfies PathGeometry[]) {
    ctx.beginPath();
    drawPathGeometry(ctx, geometry, identityTileToPixel);
    ctx.stroke();
  }
  expect(ctx.commandKinds()).toEqual([
    "moveTo",
    "lineTo",
    "stroke",
    "moveTo",
    "quadraticCurveTo",
    "stroke",
    "moveTo",
    "arc",
    "stroke",
  ]);
});
