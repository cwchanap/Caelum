import { getBoardTransform, HUD_INSET, tileSize } from "./boardTransform";
import type { Camera } from "./boardTransform";
import type { GameMap, Point } from "../domain/types";

/** Horizontal breathing room from the stage edges. */
export const INSPECTOR_POPOVER_EDGE = 8;
/** Space between the selected tile and the card. */
export const INSPECTOR_POPOVER_GAP = 12;

interface Size {
  width: number;
  height: number;
}

interface InspectorPopoverInput {
  stage: Size;
  card: Size;
  tile: Point;
  map: Pick<GameMap, "width" | "height">;
  camera: Camera | null;
}

function isPositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Which edge of the card carries the arrow pointing at the selected tile. */
export type InspectorPopoverSide = "left" | "right" | "bottom";

/**
 * Stage-local position for the Inspector card, or `null` when the selected
 * tile's center is outside the visible map area (or nothing is measured yet).
 * The anchor itself is never pinned to a stage edge; only the card is nudged
 * inside the safe area once its tile is actually visible.
 */
export function placeInspectorPopover({
  stage,
  card,
  tile,
  map,
  camera,
}: InspectorPopoverInput): {
  left: number;
  top: number;
  side: InspectorPopoverSide;
} | null {
  if (
    !isPositive(stage.width) ||
    !isPositive(stage.height) ||
    !isPositive(card.width) ||
    !isPositive(card.height)
  ) {
    return null;
  }

  const safeLeft = INSPECTOR_POPOVER_EDGE;
  const safeTop = HUD_INSET.top;
  const safeRight = stage.width - INSPECTOR_POPOVER_EDGE;
  const safeBottom = stage.height - HUD_INSET.bottom;
  if (safeRight <= safeLeft || safeBottom <= safeTop) {
    return null;
  }

  const transform = getBoardTransform(stage, map, camera);
  if (!(transform.scale > 0)) {
    return null;
  }

  const size = tileSize * transform.scale;
  const centerX = transform.offsetX + (tile.x + 0.5) * size;
  const centerY = transform.offsetY + (tile.y + 0.5) * size;
  if (
    centerX < safeLeft ||
    centerX > safeRight ||
    centerY < safeTop ||
    centerY > safeBottom
  ) {
    return null;
  }

  const tileLeft = centerX - size / 2;
  const tileRight = centerX + size / 2;
  const tileTop = centerY - size / 2;
  const tileBottom = centerY + size / 2;

  // Prefer the roomier side so a tile near an edge flips before it clamps.
  const flippedLeft = safeRight - tileRight < tileLeft - safeLeft;
  const flippedAbove = safeBottom - tileBottom < tileTop - safeTop;
  const left = flippedLeft
    ? tileLeft - INSPECTOR_POPOVER_GAP - card.width
    : tileRight + INSPECTOR_POPOVER_GAP;
  const top = flippedAbove
    ? tileTop - INSPECTOR_POPOVER_GAP - card.height
    : tileBottom + INSPECTOR_POPOVER_GAP;

  // The arrow points back along the axis the card had to flip on; the
  // horizontal side wins when neither axis was constrained.
  const side: InspectorPopoverSide = flippedLeft
    ? "right"
    : flippedAbove
      ? "bottom"
      : "left";

  return {
    left: clamp(left, safeLeft, Math.max(safeLeft, safeRight - card.width)),
    top: clamp(top, safeTop, Math.max(safeTop, safeBottom - card.height)),
    side,
  };
}
