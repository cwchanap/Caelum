import type { GameState } from "../domain/types";
import type { UiState } from "../ui/uiState";
import type { BoardTransform } from "./boardTransform";
import { tileSize } from "./boardTransform";
import { colors } from "./colors";
import { selectMapTextOverlayItems } from "./mapTextOverlay";

export function renderCursorBadge(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  ui: UiState,
  transform: BoardTransform,
): void {
  const item = selectMapTextOverlayItems(state, ui).find(
    (candidate) => candidate.kind === "cursorBadge",
  );
  if (item === undefined || item.kind !== "cursorBadge") {
    return;
  }
  const cursor = item.anchor;
  const centerX =
    transform.offsetX + (cursor.x + 0.5) * tileSize * transform.scale;
  const tileTop = transform.offsetY + cursor.y * tileSize * transform.scale;
  const tileBottom =
    transform.offsetY + (cursor.y + 1) * tileSize * transform.scale;

  // The badge is drawn after `renderGame`'s outer ctx.restore(), i.e. in the
  // transform-less context, while its position math (above) already bakes DPR
  // in via transform.scale (derived from the backing-store canvas width). The
  // visual sizes below therefore live in raw backing-store pixels and would
  // render at half CSS size on a retina (DPR=2) target, so scale them by DPR
  // to keep the on-screen geometry constant regardless of pixel density.
  const dpr = globalThis.devicePixelRatio ?? 1;
  const gap = 8 * dpr;
  const padding = 6 * dpr;
  const height = 20 * dpr;

  ctx.save();
  ctx.font = `${12 * dpr}px ui-monospace, monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const width = ctx.measureText(item.text).width + padding * 2;
  const boxX = centerX - width / 2;
  // placement "aboveOrBelow": default above the tile, but flip below when the
  // badge would clip the top row (e.g. hovering row 0) so the label stays
  // fully visible.
  const aboveY = tileTop - height - gap;
  const boxY = aboveY < 0 ? tileBottom + gap : aboveY;

  ctx.fillStyle = colors.badgeBackground;
  ctx.fillRect(boxX, boxY, width, height);
  ctx.fillStyle = colors.badgeText;
  ctx.fillText(item.text, centerX, boxY + height / 2);
  ctx.restore();
}
