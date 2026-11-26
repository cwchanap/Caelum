import { describe, expect, it } from "vitest";
import type { GameState, Tile } from "../../src/domain/types";
import { buildMapBatch } from "../../src/render/webgpu/mapBatch";
import { SPRITE_INSTANCE_FLOATS } from "../../src/render/gameplayRenderer";
import {
  SPRITE_ATLAS_HEIGHT,
  SPRITE_ATLAS_WIDTH,
  SPRITE_TEXELS_PER_TILE,
} from "../../src/render/webgpu/spriteAtlas";
import { createWasmBackend } from "../../src/runtime/backend/wasmBackend";
import { applyPresentationUpdate } from "../../src/runtime/presentationView";
import { createPresentationUpdate } from "../fixtures/rustSnapshot";

function spriteRowsOf(sprites: Float32Array): number[][] {
  const rows: number[][] = [];
  for (
    let offset = 0;
    offset < sprites.length;
    offset += SPRITE_INSTANCE_FLOATS
  ) {
    rows.push(
      Array.from(sprites.slice(offset, offset + SPRITE_INSTANCE_FLOATS)),
    );
  }
  return rows;
}

/** Mirrors the private tile hash in src/render/webgpu/mapBatch.ts so the
 *  deterministic tree placement can be recomputed from the live snapshot. */
function tileHash(x: number, y: number, salt: number): number {
  let h =
    (Math.imul(x, 0x27d4eb2d) ^
      Math.imul(y, 0x165667b1) ^
      Math.imul(salt + 1, 0x9e3779b9)) >>>
    0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = (h ^ (h >>> 13)) >>> 0;
  return h / 4294967296;
}

const TREE_RATE = 0.12;
const TREE_JITTER_PX = 10;
const TREE_MIN_RADIUS = 6;
const TREE_RADIUS_SPAN = 3;
const TILE_SIZE = 32;

/** Same eligibility as mapBatch's drawTrees, computed from the snapshot:
 *  empty, unzoned, road/structure-free and not owned by a building or a
 *  standard3x3 roundabout island. */
function expectedTreeTiles(state: GameState): Tile[] {
  const owners = new Set(
    state.buildings.flatMap((building) =>
      building.occupiedTiles.map((tile) => `${tile.x},${tile.y}`),
    ),
  );
  const islands = new Set(
    state.map.roadStructures.flatMap((structure) =>
      structure.kind === "roundabout" && structure.size === "standard3x3"
        ? [`${structure.origin.x + 1},${structure.origin.y + 1}`]
        : [],
    ),
  );
  return state.map.tiles.filter(
    (tile) =>
      tile.kind === "empty" &&
      tile.area === undefined &&
      tile.hasTrack !== true &&
      tile.roadStructureId === undefined &&
      !islands.has(`${tile.x},${tile.y}`) &&
      !owners.has(`${tile.x},${tile.y}`) &&
      tileHash(tile.x, tile.y, 1) < TREE_RATE,
  );
}

describe("buildMapBatch on an actual Small Town snapshot", () => {
  // Built by the real Rust sandbox factory through the WASM backend; the
  // render project's jsdom environment cannot load WASM, so the live
  // snapshot exercise runs here in the runtime project.
  it("places deterministic trees (all three variants, exact extents) only on eligible tiles", async () => {
    const backend = await createWasmBackend();
    const created = await backend.buildSandboxSnapshot({
      economyPreset: "standard",
      templateId: "smallTown",
      mapSize: "small",
      startingCapital: 120_000,
      demandMultiplier: 1,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw created.error;
    const state = applyPresentationUpdate(
      null,
      createPresentationUpdate(created.snapshot),
    );

    // Representative Small Town premises: smallTown rules, 28x18 map, the
    // six authored sprite-bearing buildings.
    expect(state.rules.sandbox.templateId).toBe("smallTown");
    expect([state.map.width, state.map.height]).toEqual([28, 18]);
    expect(state.buildings).toHaveLength(6);

    const batch = buildMapBatch(state, "hidden");
    expect(batch.sprites.length % SPRITE_INSTANCE_FLOATS).toBe(0);
    const rows = spriteRowsOf(batch.sprites);
    const treeRows = rows.filter((row) => row[7]! < 3);
    const buildingRows = rows.filter((row) => row[7]! >= 3);

    // Trees first: one row per hash-selected eligible tile, and all three
    // deterministic variants present in the real town.
    const expectedTiles = expectedTreeTiles(state);
    expect(expectedTiles.length).toBeGreaterThan(30);
    expect(treeRows).toHaveLength(expectedTiles.length);
    expect(new Set(treeRows.map((row) => row[7]))).toEqual(new Set([0, 1, 2]));

    // Every tree row anchors to its expected tile: angle, jitter window,
    // 12-18px diameter extents, uv scale, and trailing clip-scale slots.
    const byTile = new Map<number, number[]>();
    for (const row of treeRows) {
      const [x, y, angle, hx, hy, su, sv, , r, g, b, a, cx, cy] = row;
      expect(angle).toBe(0);
      expect(hy).toBe(hx);
      expect(hx).toBeGreaterThanOrEqual(TREE_MIN_RADIUS);
      expect(hx).toBeLessThanOrEqual(TREE_MIN_RADIUS + TREE_RADIUS_SPAN);
      expect(su).toBeCloseTo(SPRITE_TEXELS_PER_TILE / SPRITE_ATLAS_WIDTH, 6);
      expect(sv).toBeCloseTo(SPRITE_TEXELS_PER_TILE / SPRITE_ATLAS_HEIGHT, 6);
      expect([r, g, b, a]).toEqual([1, 1, 1, 1]);
      expect(cx).toBe(0);
      expect(cy).toBe(0);
      const tileX = Math.round((x! - TILE_SIZE / 2) / TILE_SIZE);
      const tileY = Math.round((y! - TILE_SIZE / 2) / TILE_SIZE);
      const tile = expectedTiles.find(
        (candidate) =>
          candidate.x === tileX &&
          candidate.y === tileY &&
          Math.abs(
            tileX * TILE_SIZE +
              TILE_SIZE / 2 +
              (tileHash(tileX, tileY, 2) - 0.5) * TREE_JITTER_PX -
              x!,
          ) < 0.5 &&
          Math.abs(
            tileY * TILE_SIZE +
              TILE_SIZE / 2 +
              (tileHash(tileX, tileY, 3) - 0.5) * TREE_JITTER_PX -
              y!,
          ) < 0.5,
      );
      expect(
        tile,
        `tree row at ${x},${y} anchors to an eligible tile`,
      ).toBeDefined();
      // Variant follows the tile hash, not insertion order.
      expect(row[7]).toBe(Math.floor(tileHash(tileX, tileY, 5) * 3));
      const key = tileX * 1000 + tileY;
      expect(byTile.has(key)).toBe(false);
      byTile.set(key, row);
    }
    expect(byTile.size).toBe(expectedTiles.length);

    // The six buildings each keep exactly one sprite row after the trees.
    expect(buildingRows).toHaveLength(6);
    for (const row of buildingRows) {
      expect(row[7]).toBeGreaterThanOrEqual(3);
      expect(row.slice(8, 12)).toEqual([1, 1, 1, 1]);
      expect(row.slice(12, 14)).toEqual([0, 0]);
    }
  });
});
