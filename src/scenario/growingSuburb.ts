import { tileId } from "../domain/ids";
import type {
  Citizen,
  GameMap,
  GrowthWave,
  RoadDirection,
  Scenario,
  Tile,
} from "../domain/types";

// Authoritative Growing Suburb map dimensions. Exported so tests (e2e helpers,
// runtime helper tests) can reference the source of truth instead of
// duplicating magic numbers that silently drift if the scenario changes.
export const MAP_WIDTH = 28;
export const MAP_HEIGHT = 18;

function starterRoadDirection(x: number, y: number): RoadDirection | undefined {
  const horizontal = y === 8 || y === 9;
  const vertical = x === 14 || x === 15;

  if (horizontal && vertical) {
    return undefined;
  }
  if (y === 8) return "west";
  if (y === 9) return "east";
  if (x === 14) return "south";
  if (x === 15) return "north";
  return undefined;
}

function isStarterRoad(x: number, y: number): boolean {
  return y === 8 || y === 9 || x === 14 || x === 15;
}

function createTile(x: number, y: number): Tile {
  const oneWay = starterRoadDirection(x, y);
  return {
    id: tileId(x, y),
    x,
    y,
    kind: isStarterRoad(x, y) ? "road" : "empty",
    ...(oneWay === undefined ? {} : { oneWay }),
  };
}

export function createGrowingSuburbMap(): GameMap {
  const tiles: Tile[] = [];

  for (let y = 0; y < MAP_HEIGHT; y += 1) {
    for (let x = 0; x < MAP_WIDTH; x += 1) {
      tiles.push(createTile(x, y));
    }
  }

  return { width: MAP_WIDTH, height: MAP_HEIGHT, tiles };
}

export function createStartingCitizens(): Citizen[] {
  return [];
}

export function createGrowingSuburbWaves(): GrowthWave[] {
  return [];
}

export function createGrowingSuburbScenario(): Scenario {
  return {
    name: "Growing Suburb",
    growthWaves: createGrowingSuburbWaves(),
    objectives: {
      maxLateRatio: 0.25,
      maxUnservedRatio: 0.2,
      maxAverageWait: 180,
      rollingWindowSeconds: 300,
      survivalTime: 1_200,
    },
  };
}
