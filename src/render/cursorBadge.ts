import type {
  BuildingRotation,
  BuildingType,
  GameMap,
  GameState,
  Point,
  Tile,
} from "../domain/types";
import { AREA_LABELS } from "../domain/catalog/areas";
import {
  BUILDING_CATALOG,
  getBuildingFootprint,
} from "../domain/catalog/buildings";
import type { UiState } from "../ui/uiState";
import type { BoardTransform } from "./canvas";
import { tileSize } from "./canvas";
import { colors } from "./colors";

function samePoint(left: Point, right: Point): boolean {
  return left.x === right.x && left.y === right.y;
}

function getTile(map: GameMap, point: Point): Tile | null {
  if (
    point.x < 0 ||
    point.x >= map.width ||
    point.y < 0 ||
    point.y >= map.height
  ) {
    return null;
  }

  return map.tiles.find((tile) => samePoint(tile, point)) ?? null;
}

function isBuildingOccupied(state: GameState, point: Point): boolean {
  return state.buildings.some((building) =>
    building.occupiedTiles.some((occupiedTile) =>
      samePoint(occupiedTile, point),
    ),
  );
}

function isTransitNodeAt(state: GameState, point: Point): boolean {
  return (
    state.transit.stops.some(
      (stop) => stop.status === "present" && samePoint(stop.position, point),
    ) ||
    state.transit.stations.some(
      (station) =>
        station.status === "present" && samePoint(station.position, point),
    )
  );
}

function canPlaceBuilding(
  state: GameState,
  type: BuildingType,
  origin: Point,
  rotation: BuildingRotation,
): boolean {
  const definition = BUILDING_CATALOG[type];
  const footprint = getBuildingFootprint(type, origin, rotation);

  return footprint.every((point) => {
    const tile = getTile(state.map, point);
    const kindOk =
      type === "metroStation"
        ? tile?.kind === "empty" || tile?.kind === "road"
        : tile?.kind === "empty";
    const trackOk =
      type === "metroStation"
        ? tile?.hasTrack === true
        : tile?.hasTrack !== true;
    const areaOk =
      definition.allowedArea === undefined ||
      tile?.area === definition.allowedArea;

    return (
      kindOk &&
      trackOk &&
      areaOk &&
      !isBuildingOccupied(state, point) &&
      !isTransitNodeAt(state, point)
    );
  });
}

function isValidRoadPlacement(state: GameState, point: Point): boolean {
  const tile = getTile(state.map, point);
  return (
    tile?.kind === "empty" &&
    !isBuildingOccupied(state, point) &&
    !isTransitNodeAt(state, point)
  );
}

function isValidTrackPlacement(state: GameState, point: Point): boolean {
  const tile = getTile(state.map, point);
  return (
    (tile?.kind === "empty" || tile?.kind === "road") &&
    tile?.hasTrack !== true &&
    !isBuildingOccupied(state, point) &&
    !isTransitNodeAt(state, point)
  );
}

function isAreaPaintable(state: GameState, point: Point): boolean {
  const tile = getTile(state.map, point);
  return (
    tile?.kind === "empty" &&
    tile.hasTrack !== true &&
    !isBuildingOccupied(state, point) &&
    !isTransitNodeAt(state, point)
  );
}

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
    case "roundabout": {
      const sizeLabel = ui.roundaboutSize === "compact2x2" ? "2×2" : "3×3";
      const preview = ui.roadMutationPreview;
      const ok =
        preview === null ||
        preview.generation !== ui.roadPreviewGeneration ||
        preview.rejection === null;
      return `⦿ Roundabout ${sizeLabel}${ok ? "" : " ⊘"}`;
    }
    case "area": {
      if (ui.selectedArea === null) {
        return null;
      }
      const ok = isAreaPaintable(state, cursor);
      return `⦿ Area ${AREA_LABELS[ui.selectedArea]}${ok ? "" : " ⊘"}`;
    }
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
  const width = ctx.measureText(text).width + padding * 2;
  const boxX = centerX - width / 2;
  // Default to above the tile, but flip below when the badge would clip the top
  // row (e.g. hovering row 0) so the label stays fully visible.
  const aboveY = tileTop - height - gap;
  const boxY = aboveY < 0 ? tileBottom + gap : aboveY;

  ctx.fillStyle = colors.badgeBackground;
  ctx.fillRect(boxX, boxY, width, height);
  ctx.fillStyle = colors.badgeText;
  ctx.fillText(text, centerX, boxY + height / 2);
  ctx.restore();
}
