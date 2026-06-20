import { describe, expect, it } from "vitest";
import { tileId } from "../../src/domain/ids";
import type { GameState, GrowthWave, Point } from "../../src/domain/types";
import { createInitialGameState } from "../../src/simulation/gameState";
import { placeBuilding } from "../../src/simulation/buildings";
import {
  applyDueGrowthWaves,
  getTile,
  isValidBusStopPlacement,
  isValidCivicAnchorPlacement,
  isValidMetroStationPlacement,
  isValidRoadPlacement,
  isValidTrackPlacement,
  setTileKind,
  setTileOneWay,
} from "../../src/simulation/map";
import { withAreas, withRoads, withTracks } from "../helpers/mapFixtures";

function withTime(state: GameState, time: number): GameState {
  return { ...state, time };
}

function withGrowthWaves(
  state: GameState,
  growthWaves: GrowthWave[],
): GameState {
  return {
    ...state,
    scenario: {
      ...state.scenario,
      growthWaves,
    },
  };
}

function withDestinationTile(state: GameState, point: Point): GameState {
  return {
    ...state,
    map: {
      ...state.map,
      tiles: state.map.tiles.map((tile) =>
        tile.x === point.x && tile.y === point.y
          ? { ...tile, kind: "jobs" as const }
          : tile,
      ),
    },
  };
}

function testGrowthWave(): GrowthWave {
  return {
    id: "wave-test",
    triggerTime: 240,
    message: "Test growth wave",
    applied: false,
    tiles: [
      {
        id: tileId(1, 1),
        x: 1,
        y: 1,
        kind: "residential",
        createsCitizens: 8,
      },
      {
        id: tileId(2, 1),
        x: 2,
        y: 1,
        kind: "residential",
        createsCitizens: 8,
      },
      {
        id: tileId(3, 1),
        x: 3,
        y: 1,
        kind: "residential",
        createsCitizens: 8,
      },
    ],
  };
}

describe("map helpers", () => {
  it("returns tiles by point and null for out-of-bounds points", () => {
    const state = withRoads(createInitialGameState(), [{ x: 7, y: 8 }]);

    expect(getTile(state.map, { x: 7, y: 8 })?.kind).toBe("road");
    expect(getTile(state.map, { x: -1, y: 8 })).toBeNull();
    expect(getTile(state.map, { x: 28, y: 8 })).toBeNull();
    expect(getTile(state.map, { x: 7, y: 18 })).toBeNull();
  });

  it("allows bus stops only on unoccupied road tiles", () => {
    const state = withRoads(
      withAreas(createInitialGameState(), "residential", [{ x: 1, y: 1 }]),
      [{ x: 7, y: 8 }],
    );

    expect(isValidBusStopPlacement(state, { x: 7, y: 8 })).toBe(true);
    expect(isValidBusStopPlacement(state, { x: 1, y: 1 })).toBe(false);
    expect(
      isValidBusStopPlacement(
        {
          ...state,
          transit: {
            ...state.transit,
            stops: [
              {
                id: "stop-001",
                kind: "busStop",
                position: { x: 7, y: 8 },
                platforms: [],
              },
            ],
          },
        },
        { x: 7, y: 8 },
      ),
    ).toBe(false);
  });

  it("allows metro stations on unoccupied tracked road or empty tiles", () => {
    const state = withTracks(
      withRoads(createInitialGameState(), [{ x: 7, y: 8 }]),
      [
        { x: 7, y: 8 },
        { x: 0, y: 0 },
      ],
    );

    expect(isValidMetroStationPlacement(state, { x: 7, y: 8 })).toBe(true);
    expect(isValidMetroStationPlacement(state, { x: 0, y: 0 })).toBe(true);
    expect(isValidMetroStationPlacement(state, { x: 1, y: 1 })).toBe(false);
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
                platforms: [],
              },
            ],
          },
        },
        { x: 0, y: 0 },
      ),
    ).toBe(false);
  });

  it("allows civic anchors only on empty tiles", () => {
    const state = withRoads(createInitialGameState(), [{ x: 7, y: 8 }]);

    expect(isValidCivicAnchorPlacement(state, { x: 0, y: 0 })).toBe(true);
    expect(isValidCivicAnchorPlacement(state, { x: 7, y: 8 })).toBe(false);
  });

  it("returns the original state when no growth waves are due", () => {
    const state = withTime(createInitialGameState(), 200);

    expect(applyDueGrowthWaves(state)).toBe(state);
  });

  it("applies due growth waves once and preserves unique citizen IDs", () => {
    const state = withDestinationTile(
      withGrowthWaves(withTime(createInitialGameState(), 250), [
        testGrowthWave(),
      ]),
      { x: 4, y: 1 },
    );

    const grownState = applyDueGrowthWaves(state);

    expect(grownState.citizens).toHaveLength(24);

    const citizenIds = new Set(
      grownState.citizens.map((citizen) => citizen.id),
    );
    expect(citizenIds.size).toBe(grownState.citizens.length);

    const newCitizen = grownState.citizens[0];
    expect(newCitizen?.home).toEqual({ x: 1, y: 1 });
    expect(newCitizen?.home).toEqual(newCitizen?.position);
    expect(newCitizen?.home).not.toBe(newCitizen?.position);
    expect(newCitizen?.home).not.toBe(newCitizen?.destination);
    expect(newCitizen?.position).not.toBe(newCitizen?.destination);
    expect(newCitizen?.deadline).toBe(1_150);

    const reappliedState = applyDueGrowthWaves(withTime(grownState, 300));
    expect(reappliedState.citizens).toHaveLength(24);
  });

  it("skips citizen creation on building-occupied wave tiles", () => {
    const state = withAreas(
      withGrowthWaves(withTime(createInitialGameState(), 250), [
        testGrowthWave(),
      ]),
      "residential",
      [
        { x: 1, y: 1 },
        { x: 2, y: 1 },
      ],
    );

    const withBuilding = placeBuilding(state, "smallHouse", { x: 1, y: 1 }, 0);

    const grownState = applyDueGrowthWaves(withBuilding);

    const citizensOnOccupiedTiles = grownState.citizens.filter(
      (c) =>
        (c.home.x === 1 && c.home.y === 1) ||
        (c.home.x === 2 && c.home.y === 1),
    );
    expect(citizensOnOccupiedTiles).toHaveLength(4);

    const citizensOnFreeTile = grownState.citizens.filter(
      (c) => c.home.x === 3 && c.home.y === 1,
    );
    expect(citizensOnFreeTile).toHaveLength(8);

    expect(grownState.citizens).toHaveLength(12);
  });
});

describe("road and track placement validation", () => {
  it("allows road on empty tiles and rejects existing roads", () => {
    const state = withRoads(
      withAreas(createInitialGameState(), "commercial", [{ x: 1, y: 1 }]),
      [{ x: 7, y: 8 }],
    );
    expect(isValidRoadPlacement(state, { x: 1, y: 1 })).toBe(true);
    expect(isValidRoadPlacement(state, { x: 7, y: 8 })).toBe(false);
  });

  it("allows track on empty and road tiles but not duplicates", () => {
    const state = withRoads(
      withAreas(createInitialGameState(), "office", [{ x: 1, y: 1 }]),
      [{ x: 7, y: 8 }],
    );
    expect(isValidTrackPlacement(state, { x: 1, y: 1 })).toBe(true);
    expect(isValidTrackPlacement(state, { x: 7, y: 8 })).toBe(true);
    const tracked = withTracks(state, [{ x: 1, y: 1 }]);
    expect(isValidTrackPlacement(tracked, { x: 1, y: 1 })).toBe(false);
  });
});

describe("station and stop placement with track rules", () => {
  it("requires track under a metro station", () => {
    const state = withRoads(createInitialGameState(), [{ x: 7, y: 8 }]);
    expect(isValidMetroStationPlacement(state, { x: 8, y: 2 })).toBe(false); // empty, no track
    expect(isValidMetroStationPlacement(state, { x: 7, y: 8 })).toBe(false); // road, no track

    const tracked = withTracks(state, [
      { x: 8, y: 2 },
      { x: 7, y: 8 },
    ]);
    expect(isValidMetroStationPlacement(tracked, { x: 8, y: 2 })).toBe(true);
    expect(isValidMetroStationPlacement(tracked, { x: 7, y: 8 })).toBe(true); // crossing OK
  });

  it("rejects bus stops on crossings", () => {
    const state = withTracks(
      withRoads(createInitialGameState(), [
        { x: 9, y: 8 },
        { x: 10, y: 8 },
      ]),
      [{ x: 9, y: 8 }],
    );
    expect(isValidBusStopPlacement(state, { x: 9, y: 8 })).toBe(false);
    expect(isValidBusStopPlacement(state, { x: 10, y: 8 })).toBe(true);
  });
});

describe("growth waves skip player infrastructure", () => {
  it("does not convert a wave tile the player laid road on, and skips its citizens", () => {
    let state = withGrowthWaves(createInitialGameState(), [testGrowthWave()]);
    state = {
      ...state,
      time: 240,
      map: {
        ...state.map,
        tiles: state.map.tiles.map((tile) =>
          tile.x === 1 && tile.y === 1
            ? { ...tile, kind: "road" as const }
            : tile,
        ),
      },
    };

    const next = applyDueGrowthWaves(state);

    const tile = next.map.tiles.find((t) => t.x === 1 && t.y === 1);
    expect(tile?.kind).toBe("road");
    expect(next.citizens.length).toBe(state.citizens.length + 16);
  });
});

describe("road direction helpers", () => {
  it("sets a one-way direction on a tile", () => {
    const state = createInitialGameState();
    const map = setTileOneWay(state.map, { x: 8, y: 8 }, "east");
    expect(getTile(map, { x: 8, y: 8 })?.oneWay).toBe("east");
  });

  it("clears the one-way direction when set to undefined", () => {
    const state = createInitialGameState();
    const withDir = setTileOneWay(state.map, { x: 8, y: 8 }, "east");
    const cleared = setTileOneWay(withDir, { x: 8, y: 8 }, undefined);
    const tile = getTile(cleared, { x: 8, y: 8 });
    expect(tile?.oneWay).toBeUndefined();
    expect("oneWay" in (tile as object)).toBe(false);
  });

  it("drops one-way when a road tile stops being a road", () => {
    const state = createInitialGameState();
    const withDir = setTileOneWay(state.map, { x: 8, y: 8 }, "east");
    const emptied = setTileKind(withDir, { x: 8, y: 8 }, "empty");
    const tile = getTile(emptied, { x: 8, y: 8 });
    expect(tile?.kind).toBe("empty");
    expect("oneWay" in (tile as object)).toBe(false);
  });

  it("keeps one-way when the tile stays a road", () => {
    const state = createInitialGameState();
    const withDir = setTileOneWay(state.map, { x: 8, y: 8 }, "east");
    const stillRoad = setTileKind(withDir, { x: 8, y: 8 }, "road");
    expect(getTile(stillRoad, { x: 8, y: 8 })?.oneWay).toBe("east");
  });

  it("ignores one-way on non-road tiles", () => {
    const state = createInitialGameState();
    const nonRoad: Point = { x: 1, y: 1 };
    expect(getTile(state.map, nonRoad)?.kind).toBe("empty");
    const before = getTile(state.map, nonRoad);
    const attempted = setTileOneWay(state.map, nonRoad, "east");
    expect(getTile(attempted, nonRoad)?.oneWay).toBeUndefined();
    expect(getTile(attempted, nonRoad)).toEqual(before);
  });
});
