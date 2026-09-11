import type { PathGeometry } from "../../src/domain/types";
import { pointAt } from "../../src/render/pathGeometry";
import {
  SOLID_VERTEX_FLOATS,
  parseColor,
} from "../../src/render/webgpu/primitives";

const COLOR_EPSILON = 1e-4;

/** Groups the vertex rows of one color into their tessellation triangles. */
export function trianglesOfColor(
  data: Float32Array,
  css: string,
): number[][][] {
  const expected = parseColor(css).slice(0, 3);
  const rows: number[][] = [];
  for (let offset = 0; offset < data.length; offset += SOLID_VERTEX_FLOATS) {
    const row = Array.from(data.slice(offset, offset + SOLID_VERTEX_FLOATS));
    if (
      row
        .slice(2, 5)
        .every(
          (value, index) => Math.abs(value - expected[index]) < COLOR_EPSILON,
        )
    ) {
      rows.push(row);
    }
  }
  const triangles: number[][][] = [];
  for (let index = 0; index + 2 < rows.length; index += 3) {
    triangles.push(rows.slice(index, index + 3));
  }
  return triangles;
}

function insideTriangle(x: number, y: number, triangle: number[][]): boolean {
  const sign = (a: number[], b: number[]): number =>
    (b[0] - a[0]) * (y - a[1]) - (x - a[0]) * (b[1] - a[1]);
  const eps = 1e-6;
  const d1 = sign(triangle[0], triangle[1]);
  const d2 = sign(triangle[1], triangle[2]);
  const d3 = sign(triangle[2], triangle[0]);
  const hasNegative = d1 < -eps || d2 < -eps || d3 < -eps;
  const hasPositive = d1 > eps || d2 > eps || d3 > eps;
  return !(hasNegative && hasPositive);
}

/**
 * Fraction of centerline samples along `geometry` that fall inside a
 * tessellated triangle of `css` color. A solid strip covers every sample
 * (~1.0); a dashed strip leaves gap samples uncovered. Samples the middle
 * [0.12, 0.88] of the geometry so endpoint furniture (node cues,
 * connectors) cannot mask gaps.
 */
export function coveredStripFraction(
  vertices: Float32Array,
  css: string,
  geometry: PathGeometry,
  sampleCount = 240,
): number {
  const triangles = trianglesOfColor(vertices, css);
  if (triangles.length === 0) return 0;
  let covered = 0;
  for (let index = 0; index <= sampleCount; index += 1) {
    const point = pointAt(geometry, 0.12 + (0.76 * index) / sampleCount);
    if (
      triangles.some((triangle) => insideTriangle(point.x, point.y, triangle))
    ) {
      covered += 1;
    }
  }
  return covered / (sampleCount + 1);
}
