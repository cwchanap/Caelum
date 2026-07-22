import type { Point } from "../domain/types";

/** Inclusive straight tile line from `start`, locked to the dominant axis.
 * Ties (|dx| === |dy|) lock horizontal. start === end yields [start]. */
export function axisLockedLine(start: Point, end: Point): Point[] {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const horizontal = Math.abs(dx) >= Math.abs(dy);
  const length = horizontal ? Math.abs(dx) : Math.abs(dy);
  const stepX = horizontal ? Math.sign(dx) : 0;
  const stepY = horizontal ? 0 : Math.sign(dy);
  const line: Point[] = [];
  for (let index = 0; index <= length; index += 1) {
    line.push({
      x: start.x + stepX * index,
      y: start.y + stepY * index,
    });
  }
  return line;
}
