import type { PathGeometry, TripPosition } from "../domain/types";
import { pointAt } from "./pathGeometry";

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
