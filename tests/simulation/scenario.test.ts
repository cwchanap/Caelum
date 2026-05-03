import { describe, expect, it } from "vitest";
import { tileId } from "../../src/domain/ids";
import { createInitialGameState } from "../../src/simulation/gameState";

describe("Growing Suburb scenario", () => {
  it("creates a deterministic starting city", () => {
    const state = createInitialGameState();

    expect(state.scenario.name).toBe("Growing Suburb");
    expect(state.map.width).toBe(28);
    expect(state.map.height).toBe(18);
    expect(state.map.tiles).toHaveLength(state.map.width * state.map.height);
    expect(state.budget).toBe(120_000);
    expect(state.citizens.length).toBe(36);
    expect(state.scenario.growthWaves).toHaveLength(3);
  });

  it("has deterministic tile IDs and representative tile kinds", () => {
    const state = createInitialGameState();
    const kinds = new Set(state.map.tiles.map((tile) => tile.kind));
    const tileIds = new Set(state.map.tiles.map((tile) => tile.id));
    const tileAt = (x: number, y: number) => state.map.tiles.find((tile) => tile.x === x && tile.y === y);

    expect(kinds.has("residential")).toBe(true);
    expect(kinds.has("jobs")).toBe(true);
    expect(kinds.has("road")).toBe(true);
    expect(kinds.has("empty")).toBe(true);
    expect(tileIds.size).toBe(state.map.tiles.length);

    expect(tileAt(7, 8)?.kind).toBe("road");
    expect(tileAt(2, 3)?.kind).toBe("residential");
    expect(tileAt(10, 4)?.kind).toBe("jobs");
    expect(tileAt(18, 10)?.kind).toBe("civic");
    expect(tileAt(4, 12)?.kind).toBe("park");
    expect(tileAt(0, 0)?.kind).toBe("empty");
  });

  it("creates deterministic citizen IDs with independent point objects", () => {
    const state = createInitialGameState();
    const citizenIds = new Set(state.citizens.map((citizen) => citizen.id));
    const firstCitizen = state.citizens[0];

    expect(citizenIds.size).toBe(state.citizens.length);
    expect(firstCitizen?.home).toEqual(firstCitizen?.position);
    expect(firstCitizen?.home).not.toBe(firstCitizen?.position);
  });

  it("creates deterministic growth waves", () => {
    const state = createInitialGameState();

    expect(state.scenario.growthWaves.map((wave) => wave.triggerTime)).toEqual([240, 540, 840]);

    for (const wave of state.scenario.growthWaves) {
      for (const tile of wave.tiles) {
        expect(tile.id).toBe(tileId(tile.x, tile.y));
      }
    }
  });
});
