import { describe, expect, it } from "vitest";
import { createInitialGameState } from "../../src/simulation/gameState";

describe("Growing Suburb scenario", () => {
  it("creates a deterministic starting city", () => {
    const state = createInitialGameState();

    expect(state.scenario.name).toBe("Growing Suburb");
    expect(state.map.width).toBe(28);
    expect(state.map.height).toBe(18);
    expect(state.budget).toBe(120_000);
    expect(state.citizens.length).toBe(36);
    expect(state.scenario.growthWaves).toHaveLength(3);
  });

  it("has residential, job, road, and empty tiles", () => {
    const state = createInitialGameState();
    const kinds = new Set(state.map.tiles.map((tile) => tile.kind));

    expect(kinds.has("residential")).toBe(true);
    expect(kinds.has("jobs")).toBe(true);
    expect(kinds.has("road")).toBe(true);
    expect(kinds.has("empty")).toBe(true);
  });
});
