import { describe, expect, it } from "vitest";
import type { GameState } from "../../src/domain/types";
import { createInitialGameState } from "../../src/simulation/gameState";
import {
  applyDueGrowthWaves,
  getTile,
  isValidBusStopPlacement,
  isValidCivicAnchorPlacement,
  isValidMetroStationPlacement,
} from "../../src/simulation/map";

function withTime(state: GameState, time: number): GameState {
  return { ...state, time };
}

describe("map helpers", () => {
  it("returns tiles by point and null for out-of-bounds points", () => {
    const state = createInitialGameState();

    expect(getTile(state.map, { x: 7, y: 8 })?.kind).toBe("road");
    expect(getTile(state.map, { x: -1, y: 8 })).toBeNull();
    expect(getTile(state.map, { x: 28, y: 8 })).toBeNull();
    expect(getTile(state.map, { x: 7, y: 18 })).toBeNull();
  });

  it("allows bus stops only on unoccupied road tiles", () => {
    const state = createInitialGameState();

    expect(isValidBusStopPlacement(state, { x: 7, y: 8 })).toBe(true);
    expect(isValidBusStopPlacement(state, { x: 2, y: 3 })).toBe(false);
    expect(
      isValidBusStopPlacement(
        {
          ...state,
          transit: {
            ...state.transit,
            stops: [
              { id: "stop-001", position: { x: 7, y: 8 }, queueCitizenIds: [] },
            ],
          },
        },
        { x: 7, y: 8 },
      ),
    ).toBe(false);
  });

  it("allows metro stations on unoccupied road or empty tiles", () => {
    const state = createInitialGameState();

    expect(isValidMetroStationPlacement(state, { x: 7, y: 8 })).toBe(true);
    expect(isValidMetroStationPlacement(state, { x: 0, y: 0 })).toBe(true);
    expect(isValidMetroStationPlacement(state, { x: 2, y: 3 })).toBe(false);
    expect(
      isValidMetroStationPlacement(
        {
          ...state,
          transit: {
            ...state.transit,
            stations: [
              {
                id: "station-001",
                position: { x: 0, y: 0 },
                queueCitizenIds: [],
              },
            ],
          },
        },
        { x: 0, y: 0 },
      ),
    ).toBe(false);
  });

  it("allows civic anchors only on empty tiles", () => {
    const state = createInitialGameState();

    expect(isValidCivicAnchorPlacement(state, { x: 0, y: 0 })).toBe(true);
    expect(isValidCivicAnchorPlacement(state, { x: 7, y: 8 })).toBe(false);
  });

  it("returns the original state when no growth waves are due", () => {
    const state = withTime(createInitialGameState(), 200);

    expect(applyDueGrowthWaves(state)).toBe(state);
  });

  it("applies due growth waves once and preserves unique citizen IDs", () => {
    const state = withTime(createInitialGameState(), 250);

    const grownState = applyDueGrowthWaves(state);

    expect(getTile(grownState.map, { x: 8, y: 2 })?.kind).toBe("residential");
    expect(grownState.citizens).toHaveLength(60);

    const citizenIds = new Set(
      grownState.citizens.map((citizen) => citizen.id),
    );
    expect(citizenIds.size).toBe(grownState.citizens.length);

    const newCitizen = grownState.citizens[36];
    expect(newCitizen?.home).toEqual({ x: 8, y: 2 });
    expect(newCitizen?.home).toEqual(newCitizen?.position);
    expect(newCitizen?.home).not.toBe(newCitizen?.position);
    expect(newCitizen?.home).not.toBe(newCitizen?.destination);
    expect(newCitizen?.position).not.toBe(newCitizen?.destination);
    expect(newCitizen?.deadline).toBe(1_150);

    const reappliedState = applyDueGrowthWaves(withTime(grownState, 300));
    expect(reappliedState.citizens).toHaveLength(60);
  });
});
