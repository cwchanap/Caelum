import type { GameState } from "../domain/types";
import { BUILDING_CATALOG, canPlaceBuilding } from "../simulation/buildings";
import {
  getTile,
  isValidRoadPlacement,
  isValidTrackPlacement,
} from "../simulation/map";
import type { UiState } from "../ui/uiState";
import type { BoardTransform } from "./canvas";
import { tileSize } from "./canvas";
import { colors } from "./colors";

/** The tile under the pointer: the drag's current tile while a gesture is
 *  active, otherwise the idle hover tile. */
function cursorTile(ui: UiState) {
  return ui.drag?.current ?? ui.hoverTile;
}

/** Tool/preset label shown on the cursor, or null when no badge applies. */
function badgeText(state: GameState, ui: UiState): string | null {
  const cursor = cursorTile(ui);
  if (cursor === null) {
    return null;
  }
  if (ui.selectedBuilding !== null) {
    const def = BUILDING_CATALOG[ui.selectedBuilding];
    const ok =
      state.budget >= def.cost &&
      canPlaceBuilding(state, ui.selectedBuilding, cursor, ui.buildingRotation);
    return `⦿ ${def.label} ${ui.buildingRotation}°${ok ? "" : " ⊘"}`;
  }
  switch (ui.activeTool) {
    case "road": {
      const glyph =
        ui.roadPreset === "oneWay"
          ? " →"
          : ui.roadPreset === "dualBidirectional"
            ? " ⇄"
            : "";
      const ok =
        isValidRoadPlacement(state, cursor) ||
        getTile(state.map, cursor)?.kind === "road";
      return `⦿ Road${glyph}${ok ? "" : " ⊘"}`;
    }
    case "track":
      return `⦿ Track${isValidTrackPlacement(state, cursor) ? "" : " ⊘"}`;
    case "remove":
      return "⦿ Demolish";
    default:
      return null;
  }
}

export function renderCursorBadge(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  ui: UiState,
  transform: BoardTransform,
): void {
  const text = badgeText(state, ui);
  const cursor = cursorTile(ui);
  if (text === null || cursor === null) {
    return;
  }
  const centerX =
    transform.offsetX + (cursor.x + 0.5) * tileSize * transform.scale;
  const tileTop = transform.offsetY + cursor.y * tileSize * transform.scale;
  const tileBottom =
    transform.offsetY + (cursor.y + 1) * tileSize * transform.scale;

  ctx.save();
  ctx.font = "12px ui-monospace, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const padding = 6;
  const width = ctx.measureText(text).width + padding * 2;
  const height = 20;
  const boxX = centerX - width / 2;
  // Default to above the tile, but flip below when the badge would clip the top
  // row (e.g. hovering row 0) so the label stays fully visible.
  const aboveY = tileTop - height - 8;
  const boxY = aboveY < 0 ? tileBottom + 8 : aboveY;

  ctx.fillStyle = colors.badgeBackground;
  ctx.fillRect(boxX, boxY, width, height);
  ctx.fillStyle = colors.badgeText;
  ctx.fillText(text, centerX, boxY + height / 2);
  ctx.restore();
}
