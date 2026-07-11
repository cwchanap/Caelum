import type { GameMap, Point, Tile } from "../domain/types";
import { ROAD_DIRECTION_OFFSET } from "../domain/types";

export type TilePathMode = "bus" | "metro";

// TS-side pathfinding used only for live route-draft previews (stop-to-stop
// segment hints). It is NOT an authority: the Rust core re-validates and
// rebuilds the real tagged legs on `addBusRoute`/`addMetroLine`. If one-way road
// handling or traversal rules diverge here, the preview may briefly mismatch
// the committed route, but the core's directional legs are what gameplay uses. Keep
// this in sync with `crates/caelum-core::router` where practical.

function positionKey(point: Point): string {
  return `${point.x},${point.y}`;
}

function isTraversable(tile: Tile, mode: TilePathMode): boolean {
  return mode === "bus" ? tile.kind === "road" : tile.hasTrack === true;
}

const neighborOffsets: readonly Point[] = [
  { x: 0, y: -1 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
];

export function findTilePath(
  map: GameMap,
  from: Point,
  to: Point,
  mode: TilePathMode,
): Point[] | null {
  const tileByKey = new Map(map.tiles.map((tile) => [positionKey(tile), tile]));
  const fromKey = positionKey(from);
  const toKey = positionKey(to);

  if (!tileByKey.has(fromKey) || !tileByKey.has(toKey)) {
    return null;
  }
  if (fromKey === toKey) {
    return [{ ...from }];
  }

  const parents = new Map<string, string | null>([[fromKey, null]]);
  const queue: Point[] = [{ ...from }];

  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head];
    const currentKey = positionKey(current);
    const currentTile = tileByKey.get(currentKey);

    for (const offset of neighborOffsets) {
      const next = { x: current.x + offset.x, y: current.y + offset.y };
      const nextKey = positionKey(next);

      if (parents.has(nextKey)) {
        continue;
      }

      const nextTile = tileByKey.get(nextKey);
      if (nextTile === undefined) {
        continue;
      }

      const isFinalHopToOffNetworkStop =
        nextKey === toKey && !isTraversable(nextTile, mode);
      if (
        !isFinalHopToOffNetworkStop &&
        mode === "bus" &&
        currentTile?.kind === "road" &&
        currentTile.oneWay !== undefined
      ) {
        const allowed = ROAD_DIRECTION_OFFSET[currentTile.oneWay];
        if (offset.x !== allowed.x || offset.y !== allowed.y) {
          continue;
        }
      }

      if (nextKey !== toKey && !isTraversable(nextTile, mode)) {
        continue;
      }

      parents.set(nextKey, currentKey);

      if (nextKey === toKey) {
        const path: Point[] = [];
        let cursor: string | null = nextKey;
        while (cursor !== null) {
          const [x, y] = cursor.split(",").map(Number);
          path.push({ x, y });
          cursor = parents.get(cursor) ?? null;
        }
        path.reverse();

        if (path.length === 2) {
          const fromTile = tileByKey.get(fromKey)!;
          if (
            !isTraversable(fromTile, mode) &&
            !isTraversable(nextTile, mode)
          ) {
            parents.delete(nextKey);
            continue;
          }
        }

        return path;
      }

      queue.push(next);
    }
  }

  return null;
}
