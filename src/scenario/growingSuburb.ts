import { entityId, tileId } from "../domain/ids";
import type { Citizen, GameMap, GrowthWave, Scenario, Tile, TileKind } from "../domain/types";

const width = 28;
const height = 18;

function kindFor(x: number, y: number): TileKind {
  if (y === 8 || x === 7 || x === 15 || x === 22) return "road";
  if (x >= 2 && x <= 5 && y >= 3 && y <= 6) return "residential";
  if (x >= 10 && x <= 13 && y >= 4 && y <= 7) return "jobs";
  if (x >= 18 && x <= 20 && y >= 10 && y <= 12) return "civic";
  if (x >= 4 && x <= 6 && y >= 12 && y <= 14) return "park";
  return "empty";
}

export function createGrowingSuburbMap(): GameMap {
  const tiles: Tile[] = [];

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      tiles.push({ id: tileId(x, y), x, y, kind: kindFor(x, y) });
    }
  }

  return { width, height, tiles };
}

export function createStartingCitizens(): Citizen[] {
  const homes = [
    { x: 2, y: 3 },
    { x: 3, y: 3 },
    { x: 4, y: 3 },
    { x: 5, y: 3 },
    { x: 2, y: 4 },
    { x: 3, y: 4 },
    { x: 4, y: 4 },
    { x: 5, y: 4 },
    { x: 2, y: 5 },
    { x: 3, y: 5 },
    { x: 4, y: 5 },
    { x: 5, y: 5 }
  ];
  const destinations = [
    { x: 10, y: 4 },
    { x: 11, y: 4 },
    { x: 12, y: 4 },
    { x: 10, y: 5 },
    { x: 11, y: 5 },
    { x: 12, y: 5 },
    { x: 18, y: 10 },
    { x: 19, y: 10 },
    { x: 20, y: 10 }
  ];

  return Array.from({ length: 36 }, (_, index) => {
    const home = { ...homes[index % homes.length] };
    const destination = { ...destinations[index % destinations.length] };
    return {
      id: entityId("citizen", index + 1),
      home,
      destination,
      position: { ...home },
      status: "idle",
      patienceRemaining: 240,
      deadline: 900,
      routePlan: null,
      currentLegIndex: 0
    };
  });
}

export function createGrowingSuburbWaves(): GrowthWave[] {
  return [
    {
      id: "wave-north",
      triggerTime: 240,
      message: "North homes open",
      applied: false,
      tiles: [
        { id: tileId(8, 2), x: 8, y: 2, kind: "residential", createsCitizens: 8 },
        { id: tileId(9, 2), x: 9, y: 2, kind: "residential", createsCitizens: 8 },
        { id: tileId(10, 2), x: 10, y: 2, kind: "residential", createsCitizens: 8 }
      ]
    },
    {
      id: "wave-east-jobs",
      triggerTime: 540,
      message: "East office park opens",
      applied: false,
      tiles: [
        { id: tileId(23, 5), x: 23, y: 5, kind: "jobs", createsCitizens: 0 },
        { id: tileId(24, 5), x: 24, y: 5, kind: "jobs", createsCitizens: 0 }
      ]
    },
    {
      id: "wave-south",
      triggerTime: 840,
      message: "South suburb opens",
      applied: false,
      tiles: [
        { id: tileId(16, 14), x: 16, y: 14, kind: "residential", createsCitizens: 10 },
        { id: tileId(17, 14), x: 17, y: 14, kind: "residential", createsCitizens: 10 }
      ]
    }
  ];
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
      survivalTime: 1_200
    }
  };
}
