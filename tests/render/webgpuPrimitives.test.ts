import { expect, it } from "vitest";
import type { PathGeometry } from "../../src/domain/types";
import { pointAndTangentAt } from "../../src/render/pathGeometry";
import {
  SolidGeometry,
  SOLID_VERTEX_FLOATS,
  parseColor,
} from "../../src/render/webgpu/primitives";

const red = parseColor("#ff0000");

function vertices(geometry: SolidGeometry): number[][] {
  const data = geometry.toFloat32Array();
  const rows: number[][] = [];
  for (let offset = 0; offset < data.length; offset += SOLID_VERTEX_FLOATS) {
    rows.push(Array.from(data.slice(offset, offset + SOLID_VERTEX_FLOATS)));
  }
  return rows;
}

function positions(geometry: SolidGeometry): [number, number][] {
  return vertices(geometry).map(([x, y]) => [x, y]);
}

function expectClose(actual: number, expected: number): void {
  expect(actual).toBeCloseTo(expected, 5);
}

it("parses hex, rgb, and rgba colors into normalized floats", () => {
  const hex = parseColor("#d7e2df");
  expectClose(hex[0], 0xd7 / 255);
  expectClose(hex[1], 0xe2 / 255);
  expectClose(hex[2], 0xdf / 255);
  expectClose(hex[3], 1);

  const short = parseColor("#e04");
  expectClose(short[0], 0xee / 255);
  expectClose(short[1], 0);
  expectClose(short[2], 0x44 / 255);

  const rgb = parseColor("rgb(216, 180, 95)");
  expectClose(rgb[0], 216 / 255);
  expectClose(rgb[1], 180 / 255);
  expectClose(rgb[2], 95 / 255);
  expectClose(rgb[3], 1);

  const rgba = parseColor("rgba(224, 79, 57, 0.32)");
  expectClose(rgba[0], 224 / 255);
  expectClose(rgba[1], 79 / 255);
  expectClose(rgba[2], 57 / 255);
  expectClose(rgba[3], 0.32);
});

it("rejects unparseable colors", () => {
  expect(() => parseColor("not-a-color")).toThrow();
});

it("tessellates a rectangle into two colored triangles", () => {
  const geometry = new SolidGeometry().rect(1, 2, 3, 4, red);
  const rows = vertices(geometry);
  expect(rows).toHaveLength(6);
  for (const row of rows) {
    expect(row[0]).toBeGreaterThanOrEqual(1);
    expect(row[0]).toBeLessThanOrEqual(4);
    expect(row[1]).toBeGreaterThanOrEqual(2);
    expect(row[1]).toBeLessThanOrEqual(6);
    expectClose(row[2], 1);
    expectClose(row[5], 1);
  }
  // Exactly the four rectangle corners, each corner appearing at least once.
  const corners = new Set(positions(geometry).map(([x, y]) => `${x},${y}`));
  expect(corners).toEqual(new Set(["1,2", "4,2", "1,6", "4,6"]));
});

it("tessellates a thick line as a quad around the segment", () => {
  const geometry = new SolidGeometry().thickLine(
    { x: 0, y: 0 },
    { x: 4, y: 0 },
    2,
    red,
  );
  const rows = vertices(geometry);
  expect(rows).toHaveLength(6);
  const points = new Set(positions(geometry).map(([x, y]) => `${x},${y}`));
  expect(points).toEqual(new Set(["0,-1", "0,1", "4,-1", "4,1"]));
});

it("splits a dashed stroke into dash quads", () => {
  const geometry = new SolidGeometry().dashedLine(
    { x: 0, y: 0 },
    { x: 4, y: 0 },
    2,
    1,
    1,
    red,
  );
  const rows = vertices(geometry);
  expect(rows).toHaveLength(12);
  const xs = positions(geometry).map(([x]) => x);
  // Dashes cover [0,1] and [2,3]; the gap [1,2] is skipped.
  expect(Math.min(...xs)).toBe(0);
  expect(Math.max(...xs)).toBe(3);
  expect(new Set(xs)).toEqual(new Set([0, 1, 2, 3]));
});

it("fans a circle around its center", () => {
  const geometry = new SolidGeometry().circle({ x: 0, y: 0 }, 2, red, 4);
  const rows = vertices(geometry);
  expect(rows).toHaveLength(4 * 3);
  for (const [x, y] of positions(geometry)) {
    const distance = Math.hypot(x, y);
    expect(distance === 0 || Math.abs(distance - 2) < 1e-5).toBe(true);
  }
});

it("forms a ring between inner and outer radii", () => {
  const geometry = new SolidGeometry().ring({ x: 1, y: 1 }, 2, 1, red, 4);
  const rows = vertices(geometry);
  expect(rows).toHaveLength(4 * 6);
  for (const [x, y] of positions(geometry)) {
    const distance = Math.hypot(x - 1, y - 1);
    expect(distance === 1 || distance === 2).toBe(true);
  }
});

it("builds an arrow from a shaft quad and a head triangle", () => {
  const geometry = new SolidGeometry().arrow(
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    2,
    red,
  );
  const rows = vertices(geometry);
  // Shaft quad (6 verts) + head triangle (3 verts).
  expect(rows).toHaveLength(9);
  const points = positions(geometry);
  expect(points).toContainEqual([10, 0]);
  const shaftXs = points.filter(([x]) => x <= 4).map(([x]) => x);
  expect(new Set(shaftXs)).toEqual(new Set([0, 4]));
});

it("builds a cross from two thick lines", () => {
  const geometry = new SolidGeometry().cross({ x: 5, y: 5 }, 4, 1, red);
  const rows = vertices(geometry);
  expect(rows).toHaveLength(12);
  const points = positions(geometry);
  const xs = new Set(points.map(([x]) => x));
  const ys = new Set(points.map(([, y]) => y));
  expect(xs).toEqual(new Set([3, 7, 4.5, 5.5]));
  expect(ys).toEqual(new Set([3, 7, 4.5, 5.5]));
});

it("tessellates a quadratic curve by sampling pointAndTangentAt", () => {
  const curve: PathGeometry = {
    kind: "quadraticBezier",
    from: { x: 0, y: 0 },
    control: { x: 2, y: 4 },
    to: { x: 4, y: 0 },
  };
  const width = 1;
  const segments = 3;
  const geometry = new SolidGeometry().curve(curve, width, red, segments);

  const rows = vertices(geometry);
  expect(rows).toHaveLength(segments * 6);

  const half = width / 2;
  for (let segment = 0; segment < segments; segment += 1) {
    const start = pointAndTangentAt(curve, segment / segments);
    const end = pointAndTangentAt(curve, (segment + 1) / segments);
    const startNormal = { x: -start.tangent.y, y: start.tangent.x };
    const endNormal = { x: -end.tangent.y, y: end.tangent.x };
    const expected = [
      [
        start.point.x -
          (startNormal.x * half) / Math.hypot(startNormal.x, startNormal.y),
        start.point.y -
          (startNormal.y * half) / Math.hypot(startNormal.x, startNormal.y),
      ],
      [
        end.point.x -
          (endNormal.x * half) / Math.hypot(endNormal.x, endNormal.y),
        end.point.y -
          (endNormal.y * half) / Math.hypot(endNormal.x, endNormal.y),
      ],
      [
        start.point.x +
          (startNormal.x * half) / Math.hypot(startNormal.x, startNormal.y),
        start.point.y +
          (startNormal.y * half) / Math.hypot(startNormal.x, startNormal.y),
      ],
      [
        end.point.x -
          (endNormal.x * half) / Math.hypot(endNormal.x, endNormal.y),
        end.point.y -
          (endNormal.y * half) / Math.hypot(endNormal.x, endNormal.y),
      ],
      [
        end.point.x +
          (endNormal.x * half) / Math.hypot(endNormal.x, endNormal.y),
        end.point.y +
          (endNormal.y * half) / Math.hypot(endNormal.x, endNormal.y),
      ],
      [
        start.point.x +
          (startNormal.x * half) / Math.hypot(startNormal.x, startNormal.y),
        start.point.y +
          (startNormal.y * half) / Math.hypot(startNormal.x, startNormal.y),
      ],
    ];
    for (let corner = 0; corner < 6; corner += 1) {
      expectClose(rows[segment * 6 + corner][0], expected[corner][0]);
      expectClose(rows[segment * 6 + corner][1], expected[corner][1]);
    }
  }
});

it("tessellates an arc by sampling pointAndTangentAt", () => {
  const curve: PathGeometry = {
    kind: "arc",
    center: { x: 0, y: 0 },
    radius: 3,
    startRadians: 0,
    sweepRadians: Math.PI / 2,
  };
  const geometry = new SolidGeometry().curve(curve, 1, red, 2);
  const rows = vertices(geometry);
  expect(rows).toHaveLength(2 * 6);

  // Every vertex lies between the inner and outer arc radius.
  for (const [x, y] of positions(geometry)) {
    const distance = Math.hypot(x, y);
    expect(distance).toBeGreaterThanOrEqual(2.5 - 1e-5);
    expect(distance).toBeLessThanOrEqual(3.5 + 1e-5);
  }

  // Segment-boundary corners are pointAndTangentAt offset by half width.
  const half = 0.5;
  const boundaryPoints = [0.5, 1].flatMap((progress) => {
    const sample = pointAndTangentAt(curve, progress);
    const normal = {
      x: -sample.tangent.y,
      y: sample.tangent.x,
    };
    return [
      [sample.point.x - normal.x * half, sample.point.y - normal.y * half],
      [sample.point.x + normal.x * half, sample.point.y + normal.y * half],
    ] satisfies [number, number][];
  });
  const points = positions(geometry);
  for (const expected of boundaryPoints) {
    const match = points.find(
      ([x, y]) =>
        Math.abs(x - expected[0]) < 1e-5 && Math.abs(y - expected[1]) < 1e-5,
    );
    expect(match).toBeDefined();
  }
});
