import type { BuildingType, GameState } from "../domain/types";
import { tileSize } from "./canvas";
import { colors } from "./colors";

const buildingColors = {
  busStop: colors.buildingBus,
  busTerminal: colors.buildingTerminal,
  metroStation: colors.buildingMetro,
  smallHouse: colors.buildingHouse,
  largeHouse: colors.buildingHouse,
  supermarket: colors.buildingCommercial,
  cinema: colors.buildingCommercial,
  factory: colors.buildingIndustrial,
  warehouse: colors.buildingIndustrial,
  officeTower: colors.buildingOffice,
  businessPark: colors.buildingOffice,
  clinic: colors.buildingCivic,
  school: colors.buildingCivic,
  parkPlaza: colors.buildingPark,
} satisfies Record<BuildingType, string>;

function colorForBuilding(type: BuildingType): string {
  return buildingColors[type];
}

export function renderBuildings(
  ctx: CanvasRenderingContext2D,
  state: GameState,
): void {
  ctx.strokeStyle = "rgba(17, 24, 32, 0.45)";
  ctx.lineWidth = 2;

  for (const building of state.buildings) {
    ctx.fillStyle = colorForBuilding(building.type);

    for (const tile of building.occupiedTiles) {
      ctx.fillRect(tile.x * tileSize, tile.y * tileSize, tileSize, tileSize);
      ctx.strokeRect(tile.x * tileSize, tile.y * tileSize, tileSize, tileSize);
    }
  }
}
