import type { PathGeometry, TripPosition } from "../../domain/types";
import { pointAndTangentAt } from "../pathGeometry";
import { measureGeometry, progressAtDistance } from "../routeGeometry";

/** Interleaved solid vertex layout: x, y, r, g, b, a. */
export const SOLID_VERTEX_FLOATS = 6;

export type Rgba = readonly [number, number, number, number];

/** Multiplies a color's alpha (canvas `globalAlpha` bakes into vertices). */
export function withAlpha(color: Rgba, alpha: number): Rgba {
  return [color[0], color[1], color[2], color[3] * alpha];
}

/** Converts tile-space path geometry (see drawPathGeometry's tileToPixel)
 *  into the pixel-space geometry the batch tessellators consume. */
export function toPixelGeometry(
  geometry: PathGeometry,
  tileToPixel: (point: TripPosition) => TripPosition,
): PathGeometry {
  if (geometry.kind === "line") {
    return {
      kind: "line",
      from: tileToPixel(geometry.from),
      to: tileToPixel(geometry.to),
    };
  }
  if (geometry.kind === "quadraticBezier") {
    return {
      kind: "quadraticBezier",
      from: tileToPixel(geometry.from),
      control: tileToPixel(geometry.control),
      to: tileToPixel(geometry.to),
    };
  }
  const center = tileToPixel(geometry.center);
  const radiusPoint = tileToPixel({
    x: geometry.center.x + geometry.radius,
    y: geometry.center.y,
  });
  return {
    ...geometry,
    center,
    radius: Math.hypot(radiusPoint.x - center.x, radiusPoint.y - center.y),
  };
}

/** Parses the CSS color subset the canvas renderers use
 *  (#rgb, #rgba, #rrggbb, #rrggbbaa, rgb(), rgba()). */
export function parseColor(css: string): Rgba {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(css);
  if (hex) {
    const digits =
      hex[1].length <= 4
        ? hex[1]
            .split("")
            .map((digit) => digit + digit)
            .join("")
        : hex[1];
    return [
      Number.parseInt(digits.slice(0, 2), 16) / 255,
      Number.parseInt(digits.slice(2, 4), 16) / 255,
      Number.parseInt(digits.slice(4, 6), 16) / 255,
      digits.length === 8 ? Number.parseInt(digits.slice(6, 8), 16) / 255 : 1,
    ];
  }
  const rgb =
    /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(
      css,
    );
  if (rgb) {
    return [
      Number(rgb[1]) / 255,
      Number(rgb[2]) / 255,
      Number(rgb[3]) / 255,
      rgb[4] === undefined ? 1 : Number(rgb[4]),
    ];
  }
  throw new Error(`unsupported color: ${css}`);
}

/**
 * CPU tessellation of solid (non-instanced) shapes into a triangle vertex
 * buffer matching the solid pipeline layout. Curve shapes sample
 * `pointAndTangentAt` — the single curve sampler — instead of reimplementing
 * curve equations.
 */
export class SolidGeometry {
  private readonly vertices: number[] = [];

  rect(x: number, y: number, width: number, height: number, color: Rgba): this {
    this.pushQuad(
      { x, y },
      { x: x + width, y },
      { x, y: y + height },
      { x: x + width, y: y + height },
      color,
    );
    return this;
  }

  thickLine(
    from: TripPosition,
    to: TripPosition,
    width: number,
    color: Rgba,
  ): this {
    this.pushSegment(from, to, width, color);
    return this;
  }

  dashedLine(
    from: TripPosition,
    to: TripPosition,
    width: number,
    dashLength: number,
    gapLength: number,
    color: Rgba,
  ): this {
    const length = Math.hypot(to.x - from.x, to.y - from.y);
    const direction = {
      x: (to.x - from.x) / length,
      y: (to.y - from.y) / length,
    };
    let distance = 0;
    let drawing = true;
    while (distance < length - 1e-6) {
      const step = Math.min(
        drawing ? dashLength : gapLength,
        length - distance,
      );
      if (drawing) {
        this.pushSegment(
          {
            x: from.x + direction.x * distance,
            y: from.y + direction.y * distance,
          },
          {
            x: from.x + direction.x * (distance + step),
            y: from.y + direction.y * (distance + step),
          },
          width,
          color,
        );
      }
      distance += step;
      drawing = !drawing;
    }
    return this;
  }

  /** Fills one triangle (canvas-style arrowheads). */
  triangle(
    a: TripPosition,
    b: TripPosition,
    c: TripPosition,
    color: Rgba,
  ): this {
    this.pushTriangle(a, b, c, color);
    return this;
  }

  circle(
    center: TripPosition,
    radius: number,
    color: Rgba,
    segments = 24,
  ): this {
    for (let index = 0; index < segments; index += 1) {
      const startAngle = (index / segments) * Math.PI * 2;
      const endAngle = ((index + 1) / segments) * Math.PI * 2;
      this.pushTriangle(
        center,
        {
          x: center.x + Math.cos(startAngle) * radius,
          y: center.y + Math.sin(startAngle) * radius,
        },
        {
          x: center.x + Math.cos(endAngle) * radius,
          y: center.y + Math.sin(endAngle) * radius,
        },
        color,
      );
    }
    return this;
  }

  ring(
    center: TripPosition,
    radius: number,
    thickness: number,
    color: Rgba,
    segments = 24,
  ): this {
    const inner = radius - thickness;
    for (let index = 0; index < segments; index += 1) {
      const startAngle = (index / segments) * Math.PI * 2;
      const endAngle = ((index + 1) / segments) * Math.PI * 2;
      this.pushQuad(
        {
          x: center.x + Math.cos(startAngle) * inner,
          y: center.y + Math.sin(startAngle) * inner,
        },
        {
          x: center.x + Math.cos(endAngle) * inner,
          y: center.y + Math.sin(endAngle) * inner,
        },
        {
          x: center.x + Math.cos(startAngle) * radius,
          y: center.y + Math.sin(startAngle) * radius,
        },
        {
          x: center.x + Math.cos(endAngle) * radius,
          y: center.y + Math.sin(endAngle) * radius,
        },
        color,
      );
    }
    return this;
  }

  arrow(
    tail: TripPosition,
    tip: TripPosition,
    width: number,
    color: Rgba,
  ): this {
    const length = Math.hypot(tip.x - tail.x, tip.y - tail.y);
    const direction = {
      x: (tip.x - tail.x) / length,
      y: (tip.y - tail.y) / length,
    };
    const headLength = width * 3;
    const headHalfWidth = width * 2;
    const base = {
      x: tip.x - direction.x * headLength,
      y: tip.y - direction.y * headLength,
    };
    this.pushSegment(tail, base, width, color);
    const normal = { x: -direction.y, y: direction.x };
    this.pushTriangle(
      {
        x: base.x + normal.x * headHalfWidth,
        y: base.y + normal.y * headHalfWidth,
      },
      tip,
      {
        x: base.x - normal.x * headHalfWidth,
        y: base.y - normal.y * headHalfWidth,
      },
      color,
    );
    return this;
  }

  cross(
    center: TripPosition,
    size: number,
    thickness: number,
    color: Rgba,
  ): this {
    const half = size / 2;
    this.pushSegment(
      { x: center.x - half, y: center.y },
      { x: center.x + half, y: center.y },
      thickness,
      color,
    );
    this.pushSegment(
      { x: center.x, y: center.y - half },
      { x: center.x, y: center.y + half },
      thickness,
      color,
    );
    return this;
  }

  curve(
    geometry: PathGeometry,
    width: number,
    color: Rgba,
    segments = 24,
  ): this {
    const half = width / 2;
    for (let index = 0; index < segments; index += 1) {
      const start = pointAndTangentAt(geometry, index / segments);
      const end = pointAndTangentAt(geometry, (index + 1) / segments);
      this.pushQuad(
        offsetByNormal(start, -half),
        offsetByNormal(end, -half),
        offsetByNormal(start, half),
        offsetByNormal(end, half),
        color,
      );
    }
    return this;
  }

  /** Dashes along a sampled curve — the batch equivalent of canvas
   *  `setLineDash`, which natively dashes bezier/arc strokes. Dash and gap
   *  are pixel arc lengths; each dash is emitted as a thick-line chord
   *  following the curve (same arc-length sampler as direction arrows). */
  dashedCurve(
    geometry: PathGeometry,
    width: number,
    dashLength: number,
    gapLength: number,
    color: Rgba,
  ): this {
    const measured = measureGeometry(geometry);
    const pointAtLength = (distance: number): TripPosition =>
      pointAndTangentAt(geometry, progressAtDistance(measured, distance)).point;
    let distance = 0;
    let drawing = true;
    while (distance < measured.length - 1e-6) {
      const end = Math.min(
        distance + (drawing ? dashLength : gapLength),
        measured.length,
      );
      if (drawing) {
        this.pushSegment(
          pointAtLength(distance),
          pointAtLength(end),
          width,
          color,
        );
      }
      distance = end;
      drawing = !drawing;
    }
    return this;
  }

  toFloat32Array(): Float32Array<ArrayBuffer> {
    return new Float32Array(this.vertices);
  }

  private pushSegment(
    from: TripPosition,
    to: TripPosition,
    width: number,
    color: Rgba,
  ): void {
    const length = Math.hypot(to.x - from.x, to.y - from.y);
    const normal = {
      x: (-(to.y - from.y) / length) * (width / 2),
      y: ((to.x - from.x) / length) * (width / 2),
    };
    this.pushQuad(
      { x: from.x - normal.x, y: from.y - normal.y },
      { x: to.x - normal.x, y: to.y - normal.y },
      { x: from.x + normal.x, y: from.y + normal.y },
      { x: to.x + normal.x, y: to.y + normal.y },
      color,
    );
  }

  private pushQuad(
    a: TripPosition,
    b: TripPosition,
    c: TripPosition,
    d: TripPosition,
    color: Rgba,
  ): void {
    // Triangle a-b-c then b-d-c.
    this.pushTriangle(a, b, c, color);
    this.pushTriangle(b, d, c, color);
  }

  private pushTriangle(
    a: TripPosition,
    b: TripPosition,
    c: TripPosition,
    color: Rgba,
  ): void {
    for (const point of [a, b, c]) {
      this.vertices.push(
        point.x,
        point.y,
        color[0],
        color[1],
        color[2],
        color[3],
      );
    }
  }
}

function offsetByNormal(
  sample: ReturnType<typeof pointAndTangentAt>,
  distance: number,
): TripPosition {
  const length = Math.hypot(sample.tangent.x, sample.tangent.y) || 1;
  return {
    x: sample.point.x + (-sample.tangent.y / length) * distance,
    y: sample.point.y + (sample.tangent.x / length) * distance,
  };
}
