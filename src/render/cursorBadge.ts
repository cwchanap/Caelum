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

/** Tool/preset label shown on the cursor, or null when no badge applies. */
function badgeText(state: GameState, ui: UiState): string | null {
  if (ui.hoverTile === null) {
    return null;
  }
  if (ui.selectedBuilding !== null) {
    const def = BUILDING_CATALOG[ui.selectedBuilding];
    const ok =
      state.budget >= def.cost &&
      canPlaceBuilding(
        state,
        ui.selectedBuilding,
        ui.hoverTile,
        ui.buildingRotation,
      );
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
        isValidRoadPlacement(state, ui.hoverTile) ||
        getTile(state.map, ui.hoverTile)?.kind === "road";
      return `⦿ Road${glyph}${ok ? "" : " ⊘"}`;
    }
    case "track":
      return `⦿ Track${isValidTrackPlacement(state, ui.hoverTile) ? "" : " ⊘"}`;
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
  if (text === null || ui.hoverTile === null) {
    return;
  }
  const centerX =
    transform.offsetX + (ui.hoverTile.x + 0.5) * tileSize * transform.scale;
  const tileTop =
    transform.offsetY + ui.hoverTile.y * tileSize * transform.scale;

  ctx.save();
  ctx.font = "12px ui-monospace, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const padding = 6;
  const width = ctx.measureText(text).width + padding * 2;
  const height = 20;
  const boxX = centerX - width / 2;
  const boxY = tileTop - height - 8;

  ctx.fillStyle = colors.badgeBackground;
  ctx.fillRect(boxX, boxY, width, height);
  ctx.fillStyle = colors.badgeText;
  ctx.fillText(text, centerX, boxY + height / 2);
  ctx.restore();
}
