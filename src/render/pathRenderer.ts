import type { PathGeometry, TripPosition } from "../domain/types";

function lerpPoint(
  from: TripPosition,
  to: TripPosition,
  progress: number,
): TripPosition {
  return {
    x: from.x + (to.x - from.x) * progress,
    y: from.y + (to.y - from.y) * progress,
  };
}

export function pointAt(
  geometry: PathGeometry,
  progress: number,
): TripPosition {
  const t = Math.max(0, Math.min(1, progress));
  if (geometry.kind === "line") {
    return lerpPoint(geometry.from, geometry.to, t);
  }
  if (geometry.kind === "quadraticBezier") {
    const a = (1 - t) * (1 - t);
    const b = 2 * (1 - t) * t;
    const c = t * t;
    return {
      x: a * geometry.from.x + b * geometry.control.x + c * geometry.to.x,
      y: a * geometry.from.y + b * geometry.control.y + c * geometry.to.y,
    };
  }
  const angle = geometry.startRadians + geometry.sweepRadians * t;
  return {
    x: geometry.center.x + Math.cos(angle) * geometry.radius,
    y: geometry.center.y + Math.sin(angle) * geometry.radius,
  };
}

export function drawPathGeometry(
  ctx: CanvasRenderingContext2D,
  geometry: PathGeometry,
  tileToPixel: (point: TripPosition) => TripPosition,
): void {
  const from = tileToPixel(pointAt(geometry, 0));
  ctx.moveTo(from.x, from.y);
  if (geometry.kind === "line") {
    const to = tileToPixel(geometry.to);
    ctx.lineTo(to.x, to.y);
  } else if (geometry.kind === "quadraticBezier") {
    const control = tileToPixel(geometry.control);
    const to = tileToPixel(geometry.to);
    ctx.quadraticCurveTo(control.x, control.y, to.x, to.y);
  } else {
    const center = tileToPixel(geometry.center);
    const radiusPoint = tileToPixel({
      x: geometry.center.x + geometry.radius,
      y: geometry.center.y,
    });
    const radius = Math.hypot(
      radiusPoint.x - center.x,
      radiusPoint.y - center.y,
    );
    ctx.arc(
      center.x,
      center.y,
      radius,
      geometry.startRadians,
      geometry.startRadians + geometry.sweepRadians,
      geometry.sweepRadians < 0,
    );
  }
}
