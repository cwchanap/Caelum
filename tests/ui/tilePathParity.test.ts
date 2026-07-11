import { describe, expect, it } from "vitest";

import { tileId } from "../../src/domain/ids";
import type {
  GameMap,
  Point,
  RoadDirection,
  Tile,
} from "../../src/domain/types";
import { findTilePath } from "../../src/ui/tilePath";

// Parity fixtures mirroring `crates/caelum-core/tests/network_paths.rs`.
// The TS `findTilePath` is a preview-only BFS that must stay in sync with the
// Rust `network::find_tile_path` authority. These tests pin the same fixtures
// and expected paths so drift between the two implementations is caught here
// rather than surfacing as stale route-draft previews.

const MAP_WIDTH = 28;
const MAP_HEIGHT = 18;

function createEmptyMap(): GameMap {
  const tiles: Tile[] = [];
  for (let y = 0; y < MAP_HEIGHT; y += 1) {
    for (let x = 0; x < MAP_WIDTH; x += 1) {
      tiles.push({
        id: tileId(x, y),
        x,
        y,
        kind: "empty",
        roadConnections: [],
      });
    }
  }
  return {
    width: MAP_WIDTH,
    height: MAP_HEIGHT,
    tiles,
    roadStructures: [],
  };
}

function tileAt(map: GameMap, x: number, y: number): Tile {
  const tile = map.tiles.find((t) => t.x === x && t.y === y);
  if (!tile) {
    throw new Error(`no tile at (${x}, ${y})`);
  }
  return tile;
}

function setRoad(
  map: GameMap,
  x: number,
  y: number,
  oneWay?: RoadDirection,
): void {
  const tile = tileAt(map, x, y);
  tile.kind = "road";
  if (oneWay === undefined) {
    delete tile.oneWay;
  } else {
    tile.oneWay = oneWay;
  }
}

function setTrack(map: GameMap, x: number, y: number): void {
  tileAt(map, x, y).hasTrack = true;
}

function pointsEqual(path: Point[] | null): (number | null)[][] {
  if (path === null) {
    return [[null]];
  }
  return path.map((p) => [p.x, p.y]);
}

describe("findTilePath parity with Rust network::find_tile_path", () => {
  it("finds straight shortest bus path (mirrors network_paths.rs)", () => {
    const map = createEmptyMap();
    for (let x = 2; x <= 6; x += 1) {
      setRoad(map, x, 5);
    }

    const path = findTilePath(map, { x: 2, y: 5 }, { x: 6, y: 5 }, "bus");

    expect(pointsEqual(path)).toEqual([
      [2, 5],
      [3, 5],
      [4, 5],
      [5, 5],
      [6, 5],
    ]);
  });

  it("uses north/east/south/west neighbor order for deterministic ties (mirrors network_paths.rs)", () => {
    const map = createEmptyMap();
    for (let x = 5; x <= 7; x += 1) {
      setTrack(map, x, 2);
    }
    for (let x = 4; x <= 7; x += 1) {
      setTrack(map, x, 5);
    }
    setTrack(map, 5, 3);
    setTrack(map, 7, 3);

    const path = findTilePath(map, { x: 5, y: 2 }, { x: 7, y: 4 }, "metro");

    expect(pointsEqual(path)).toEqual([
      [5, 2],
      [6, 2],
      [7, 2],
      [7, 3],
      [7, 4],
    ]);
  });

  it("connects adjacent off-network endpoints through road (mirrors network_paths.rs)", () => {
    const map = createEmptyMap();
    setRoad(map, 8, 5);
    setRoad(map, 9, 5);

    const path = findTilePath(map, { x: 8, y: 4 }, { x: 9, y: 4 }, "bus");

    expect(pointsEqual(path)).toEqual([
      [8, 4],
      [8, 5],
      [9, 5],
      [9, 4],
    ]);
  });

  it("constrains buses but not metro on one-way roads (mirrors network_paths.rs)", () => {
    const map = createEmptyMap();
    for (let x = 7; x <= 9; x += 1) {
      setRoad(map, x, 5);
      setTrack(map, x, 5);
    }
    // CycleRoadDirection twice: None -> north -> east.
    setRoad(map, 8, 5, "east");

    expect(
      findTilePath(map, { x: 7, y: 5 }, { x: 9, y: 5 }, "bus"),
    ).not.toBeNull();
    expect(findTilePath(map, { x: 9, y: 5 }, { x: 7, y: 5 }, "bus")).toBeNull();
    expect(
      findTilePath(map, { x: 9, y: 5 }, { x: 7, y: 5 }, "metro"),
    ).not.toBeNull();
  });
});
