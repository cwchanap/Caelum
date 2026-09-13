import { describe, expect, it } from "vitest";
import type { GameState, RoadStructure } from "../../src/domain/types";
import { buildMapBatch } from "../../src/render/webgpu/mapBatch";
import {
  SOLID_VERTEX_FLOATS,
  parseColor,
} from "../../src/render/webgpu/primitives";
import { colors } from "../../src/render/colors";
import { createTestGameState, placeTestBuilding } from "../helpers/gameState";
import {
  pointsOnRow,
  withOneWayRoads,
  withRoads,
  withTracks,
} from "../helpers/mapFixtures";

const EPSILON = 1e-4;

function rowsOf(data: Float32Array): number[][] {
  const rows: number[][] = [];
  for (let offset = 0; offset < data.length; offset += SOLID_VERTEX_FLOATS) {
    rows.push(Array.from(data.slice(offset, offset + SOLID_VERTEX_FLOATS)));
  }
  return rows;
}

function sameColor(row: number[], css: string): boolean {
  const expected = Array.from(parseColor(css));
  return row
    .slice(2, 6)
    .every((value, index) => Math.abs(value - expected[index]) < EPSILON);
}

function verticesOfColor(data: Float32Array, css: string): number[][] {
  return rowsOf(data).filter((row) => sameColor(row, css));
}

function hasVertexNear(
  data: Float32Array,
  css: string,
  x: number,
  y: number,
  tolerance = 0.01,
): boolean {
  return verticesOfColor(data, css).some(
    ([vx, vy]) => Math.abs(vx - x) < tolerance && Math.abs(vy - y) < tolerance,
  );
}

function withAreaTile(state: GameState, x: number, y: number): GameState {
  return {
    ...state,
    map: {
      ...state.map,
      tiles: state.map.tiles.map((tile) =>
        tile.x === x && tile.y === y ? { ...tile, area: "office" } : tile,
      ),
    },
  };
}

function withJunction(state: GameState, structure: RoadStructure): GameState {
  const owned = new Set(structure.footprint.map((p) => `${p.x},${p.y}`));
  return {
    ...state,
    map: {
      ...state.map,
      tiles: state.map.tiles.map((tile) =>
        owned.has(`${tile.x},${tile.y}`)
          ? { ...tile, roadStructureId: structure.id }
          : tile,
      ),
      roadStructures: [...state.map.roadStructures, structure],
    },
  };
}

describe("buildMapBatch tile layer", () => {
  it("fills tiles with area/road colors and strokes the grid", () => {
    let state = createTestGameState();
    state = withAreaTile(state, 2, 3);
    state = withRoads(state, [{ x: 5, y: 5 }]);
    const batch = buildMapBatch(state);

    // Tile (2,3) is empty with an office zone: filled with the area color.
    expect(hasVertexNear(batch, colors.areaOffice, 64, 96)).toBe(true);
    // Tile (5,5) is a road: filled with the road color.
    expect(hasVertexNear(batch, colors.road, 5 * 32, 5 * 32)).toBe(true);
    // Grid strokes run along the tile boundary (lineWidth 1, centered).
    expect(hasVertexNear(batch, colors.grid, 64, 95.5)).toBe(true);
    expect(hasVertexNear(batch, colors.grid, 96, 128 + 0.5)).toBe(true);
  });
});

describe("buildMapBatch road layer", () => {
  it("draws straight road stubs from tile centers to connection edges", () => {
    const state = withRoads(createTestGameState(), pointsOnRow(8, 7, 15));
    const batch = buildMapBatch(state);

    // Tile (8,8) center = (272,272); stub quads span the west (256,272) and
    // east (288,272) edge midpoints with the centerline color (width 4:
    // quad corners sit at ±2 off the axis).
    expect(hasVertexNear(batch, colors.roadCenterline, 256, 270)).toBe(true);
    expect(hasVertexNear(batch, colors.roadCenterline, 272, 274)).toBe(true);
    expect(hasVertexNear(batch, colors.roadCenterline, 288, 274)).toBe(true);
  });

  it("draws corner roads as one curve and no center stubs", () => {
    const initial = createTestGameState();
    const state: GameState = {
      ...initial,
      map: {
        ...initial.map,
        tiles: initial.map.tiles.map((tile) =>
          tile.x === 6 && tile.y === 6
            ? { ...tile, kind: "road", roadConnections: ["north", "east"] }
            : tile,
        ),
      },
    };
    const batch = buildMapBatch(state);

    // The quadratic curve samples near the canvas midpoint of the north-edge
    // to east-edge curve with control at the tile center: t=0.5 lands at
    // (212, 204).
    expect(hasVertexNear(batch, colors.roadCenterline, 208, 192, 2.5)).toBe(
      true,
    );
    expect(hasVertexNear(batch, colors.roadCenterline, 224, 208, 2.5)).toBe(
      true,
    );
    expect(hasVertexNear(batch, colors.roadCenterline, 212, 204, 2.5)).toBe(
      true,
    );
    // A west stub would put quad corners at (206,208); a corner road must
    // not produce them.
    expect(hasVertexNear(batch, colors.roadCenterline, 206, 208)).toBe(false);
  });

  it("draws automatic junction approaches instead of ordinary stubs", () => {
    let state = withRoads(createTestGameState(), [
      { x: 5, y: 5 },
      { x: 6, y: 5 },
    ]);
    // Structure-owned tile keeps unrelated authored connections, but the
    // batch must render only the junction's port approaches.
    state = {
      ...state,
      map: {
        ...state.map,
        tiles: state.map.tiles.map((tile) =>
          tile.x === 6 && tile.y === 5
            ? { ...tile, roadConnections: ["north"] }
            : tile,
        ),
      },
    };
    state = withJunction(state, {
      kind: "automaticJunction",
      id: "junction-1",
      footprint: [{ x: 6, y: 5 }],
      ports: [
        { id: "port-west", point: { x: 6, y: 5 }, edge: "west" },
        { id: "port-east", point: { x: 6, y: 5 }, edge: "east" },
      ],
    });
    const batch = buildMapBatch(state);

    // Port approaches from tile (6,5) center (208,176) to both edges.
    expect(hasVertexNear(batch, colors.roadCenterline, 192, 174)).toBe(true);
    expect(hasVertexNear(batch, colors.roadCenterline, 224, 178)).toBe(true);
    // The unrelated authored "north" connection must not render (a north
    // stub would put quad corners at (206,160)).
    expect(hasVertexNear(batch, colors.roadCenterline, 206, 160)).toBe(false);
  });
});

describe("buildMapBatch roundabout layer", () => {
  it("draws circulation, port stubs, entry markings, and the island", () => {
    const structure: RoadStructure = {
      kind: "roundabout",
      id: "roundabout-1",
      origin: { x: 3, y: 3 },
      size: "standard3x3",
      footprint: [
        { x: 3, y: 3 },
        { x: 4, y: 3 },
        { x: 5, y: 3 },
        { x: 3, y: 4 },
        { x: 4, y: 4 },
        { x: 5, y: 4 },
        { x: 3, y: 5 },
        { x: 4, y: 5 },
        { x: 5, y: 5 },
      ],
      ports: [{ id: "port-west", point: { x: 3, y: 4 }, edge: "west" }],
    };
    const state = withJunction(createTestGameState(), structure);
    const batch = buildMapBatch(state);

    // Circulation curves orbit the structure center (4,4) -> (144,144) at
    // radius 1.08 tiles = 34.56px.
    const circulation = verticesOfColor(batch, colors.roadCenterline).filter(
      ([x, y]) =>
        Math.abs(Math.hypot(x - 144, y - 144) - 34.56) < 2.6 &&
        x > 96 &&
        x < 192 &&
        y > 96 &&
        y < 192,
    );
    expect(circulation.length).toBeGreaterThan(0);

    // Port stub from tile (3,4) center (112,144) to the west edge (96,144).
    expect(hasVertexNear(batch, colors.roadCenterline, 96, 141.5)).toBe(true);

    // Entry marking: an 8-long, 2-thick rect across the stub at 70% along
    // (west port -> vertical marking).
    expect(hasVertexNear(batch, colors.roadCenterline, 99.8, 140)).toBe(true);
    expect(hasVertexNear(batch, colors.roadCenterline, 101.8, 148)).toBe(true);

    // The protected island tile (4,4) is filled as empty, and the island
    // circle is drawn with the roundabout island color.
    expect(hasVertexNear(batch, colors.empty, 128, 128)).toBe(true);
    expect(
      verticesOfColor(batch, colors.roundaboutIsland).some(
        ([x, y]) => Math.hypot(x - 144, y - 144) < 9.7,
      ),
    ).toBe(true);
  });

  it("draws a compact roundabout with ports on all four edges and no island", () => {
    const structure: RoadStructure = {
      kind: "roundabout",
      id: "roundabout-1",
      origin: { x: 6, y: 6 },
      size: "compact2x2",
      footprint: [
        { x: 6, y: 6 },
        { x: 7, y: 6 },
        { x: 6, y: 7 },
        { x: 7, y: 7 },
      ],
      ports: [
        { id: "port-north", point: { x: 6, y: 6 }, edge: "north" },
        { id: "port-east", point: { x: 7, y: 6 }, edge: "east" },
        { id: "port-south", point: { x: 7, y: 7 }, edge: "south" },
        { id: "port-west", point: { x: 6, y: 7 }, edge: "west" },
      ],
    };
    const state = withJunction(createTestGameState(), structure);
    const batch = buildMapBatch(state);

    // Compact circulation orbits the 2x2 center (224,224) at radius
    // 0.58 tiles = 18.56px with four arcs.
    const circulation = verticesOfColor(batch, colors.roadCenterline).filter(
      ([x, y]) => Math.abs(Math.hypot(x - 224, y - 224) - 18.56) < 2.6,
    );
    expect(circulation.length).toBeGreaterThan(0);

    // North/south ports draw a horizontal entry marking 70% along the stub.
    // North port at (6,6): center (208,208), tip (208,192), mark at 196.8.
    expect(hasVertexNear(batch, colors.roadCenterline, 204, 195.8)).toBe(true);
    // South port at (7,7): center (240,240), tip (240,256), mark at 251.2.
    expect(hasVertexNear(batch, colors.roadCenterline, 236, 250.2)).toBe(true);
    // East/west ports draw a vertical marking. West port at (6,7): center
    // (208,240), tip (192,240), mark at 196.8.
    expect(hasVertexNear(batch, colors.roadCenterline, 197.8, 244)).toBe(true);
    // East port stub reaches the east edge midpoint of tile (7,6).
    expect(hasVertexNear(batch, colors.roadCenterline, 256, 205.5)).toBe(true);

    // Compact roundabouts own no protected island.
    expect(verticesOfColor(batch, colors.roundaboutIsland)).toHaveLength(0);
  });
});

describe("buildMapBatch track layer", () => {
  it("draws spokes between adjacent track tiles and a dot ring for isolated tiles", () => {
    const state = withTracks(createTestGameState(), [
      { x: 2, y: 2 },
      { x: 3, y: 2 },
      { x: 10, y: 10 },
    ]);
    const batch = buildMapBatch(state);

    // Spokes meet at the shared edge midpoint (96,80) with track color.
    expect(hasVertexNear(batch, colors.track, 96, 78)).toBe(true);
    expect(hasVertexNear(batch, colors.track, 96, 82)).toBe(true);
    // Isolated tile (10,10): a stroked dot at its center (336,336) with
    // radius 4 and lineWidth 4 -> a ring band of radii 2..6.
    expect(hasVertexNear(batch, colors.track, 336 + 2, 336)).toBe(true);
    expect(hasVertexNear(batch, colors.track, 336, 336 - 6)).toBe(true);
  });
});

describe("buildMapBatch one-way layer", () => {
  it("draws one-way arrows as a shaft and chevron barbs", () => {
    const state = withOneWayRoads(createTestGameState(), [
      { x: 8, y: 8, oneWay: "east" },
    ]);
    const batch = buildMapBatch(state);

    const head = 32 / 6;
    // Shaft quad from tail (264,272) to tip (280,272), corners ±1 off axis.
    expect(hasVertexNear(batch, colors.oneWayArrow, 264, 271)).toBe(true);
    expect(hasVertexNear(batch, colors.oneWayArrow, 280, 273)).toBe(true);
    // Chevron barbs angle back from the tip symmetrically.
    expect(
      hasVertexNear(batch, colors.oneWayArrow, 280 - head, 272 + head, 2),
    ).toBe(true);
    expect(
      hasVertexNear(batch, colors.oneWayArrow, 280 - head, 272 - head, 2),
    ).toBe(true);
  });
});

describe("buildMapBatch building layer", () => {
  it("fills building footprints with the type color and outline", () => {
    const state = placeTestBuilding(
      createTestGameState(),
      "smallHouse",
      { x: 4, y: 5 },
      0,
    );
    const batch = buildMapBatch(state);

    const building = state.buildings[0];
    expect(building).toBeDefined();
    for (const tile of building.occupiedTiles) {
      expect(
        hasVertexNear(batch, colors.buildingHouse, tile.x * 32, tile.y * 32),
      ).toBe(true);
      // Outline stroke (lineWidth 2, centered on the tile boundary).
      expect(
        hasVertexNear(
          batch,
          "rgba(17, 24, 32, 0.45)",
          tile.x * 32 - 1,
          tile.y * 32,
        ),
      ).toBe(true);
    }
  });
});
