import type { GameMap, Point, Tile } from "../domain/types";

export type NetworkMode = "bus" | "metro";

function positionKey(x: number, y: number): string {
  return `${x},${y}`;
}

function isTraversable(tile: Tile, mode: NetworkMode): boolean {
  return mode === "bus" ? tile.kind === "road" : tile.hasTrack === true;
}

// Fixed N, E, S, W expansion order keeps BFS — and therefore the chosen
// shortest path — fully deterministic (a scenario contract).
const neighborOffsets: readonly Point[] = [
  { x: 0, y: -1 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
];

/**
 * Shortest 4-connected tile path for the given mode, or null when none
 * exists. The from/to endpoints are always traversable regardless of tile
 * kind/track so that stops placed beside the network (building footprints
 * sit on empty tiles) can connect through an adjacent road/track tile.
 */
export function findTilePath(
  map: GameMap,
  from: Point,
  to: Point,
  mode: NetworkMode,
): Point[] | null {
  const tileByKey = new Map(
    map.tiles.map((tile) => [positionKey(tile.x, tile.y), tile]),
  );
  const fromKey = positionKey(from.x, from.y);
  const toKey = positionKey(to.x, to.y);

  if (!tileByKey.has(fromKey) || !tileByKey.has(toKey)) {
    return null;
  }
  if (fromKey === toKey) {
    return [{ x: from.x, y: from.y }];
  }

  const parents = new Map<string, string | null>([[fromKey, null]]);
  const queue: Point[] = [{ x: from.x, y: from.y }];

  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head];

    for (const offset of neighborOffsets) {
      const next = { x: current.x + offset.x, y: current.y + offset.y };
      const nextKey = positionKey(next.x, next.y);

      if (parents.has(nextKey)) {
        continue;
      }

      const tile = tileByKey.get(nextKey);
      if (tile === undefined) {
        continue;
      }
      if (nextKey !== toKey && !isTraversable(tile, mode)) {
        continue;
      }

      parents.set(nextKey, positionKey(current.x, current.y));

      if (nextKey === toKey) {
        const path: Point[] = [];
        let cursor: string | null = nextKey;
        while (cursor !== null) {
          const [x, y] = cursor.split(",").map(Number);
          path.push({ x, y });
          cursor = parents.get(cursor) ?? null;
        }
        path.reverse();

        // Guard: reject a 2-tile path where neither endpoint is traversable.
        // The "endpoints are always traversable" rule allows off-network stops
        // to connect through an adjacent road/track tile, but when two stops
        // are directly adjacent on non-traversable ground the "path" contains
        // zero traversable tiles — which is never a valid transit connection.
        if (path.length === 2) {
          const fromTile = tileByKey.get(fromKey)!;
          if (!isTraversable(fromTile, mode) && !isTraversable(tile, mode)) {
            // Undo the parents entry so the BFS can find a longer valid route.
            // The target will be re-enqueued when a longer path reaches it.
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

/**
 * Tile path for every consecutive position pair, including the closing
 * loop segment (last -> first); vehicles cycle the whole loop. An
 * unpathable pair is stored as an empty array.
 */
export function computeRouteSegments(
  map: GameMap,
  positions: Point[],
  mode: NetworkMode,
): Point[][] {
  if (positions.length < 2) {
    return [];
  }

  return positions.map((from, index) => {
    const to = positions[(index + 1) % positions.length];
    return findTilePath(map, from, to, mode) ?? [];
  });
}

export function hasBrokenSegment(segments: Point[][]): boolean {
  return segments.some((segment) => segment.length === 0);
}
