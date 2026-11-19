import { describe, expect, it } from "vitest";
import type { GameState, Point, RoadStructure } from "../../src/domain/types";
import {
  GRID_FAINT_ALPHA,
  GRID_FAINT_TILE_PX,
  LOT_FILL_ALPHA,
  TREE_CANOPY_SEGMENTS,
  TREE_MIN_RADIUS,
  TREE_RADIUS_SPAN,
  buildMapBatch,
  gridModeForTool,
  gridModeForUi,
} from "../../src/render/webgpu/mapBatch";
import { SPRITE_INSTANCE_FLOATS } from "../../src/render/gameplayRenderer";
import {
  BUILDING_SPRITE_LAYERS,
  SPRITE_ATLAS_HEIGHT,
  SPRITE_ATLAS_WIDTH,
  SPRITE_TEXELS_PER_TILE,
  TREE_SPRITE_LAYER_BASE,
  TREE_SPRITE_URLS,
} from "../../src/render/webgpu/spriteAtlas";
import { BUILDING_CATALOG } from "../../src/domain/catalog/buildings";
import {
  SOLID_VERTEX_FLOATS,
  parseColor,
  withAlpha,
  type Rgba,
} from "../../src/render/webgpu/primitives";
import { colors } from "../../src/render/colors";
import { tileSize } from "../../src/render/boardTransform";
import { createTestGameState, placeTestBuilding } from "../helpers/gameState";
import {
  pointsOnRow,
  withAreas,
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

function sameColorRgba(row: number[], rgba: Rgba): boolean {
  return row
    .slice(2, 6)
    .every((value, index) => Math.abs(value - rgba[index]) < EPSILON);
}

function verticesOfRgba(data: Float32Array, rgba: Rgba): number[][] {
  return rowsOf(data).filter((row) => sameColorRgba(row, rgba));
}

function verticesOfColor(data: Float32Array, css: string): number[][] {
  return verticesOfRgba(data, parseColor(css));
}

function hasVertexNearRgba(
  data: Float32Array,
  rgba: Rgba,
  x: number,
  y: number,
  tolerance = 0.01,
): boolean {
  return verticesOfRgba(data, rgba).some(
    ([vx, vy]) => Math.abs(vx - x) < tolerance && Math.abs(vy - y) < tolerance,
  );
}

function hasVertexNear(
  data: Float32Array,
  css: string,
  x: number,
  y: number,
  tolerance = 0.01,
): boolean {
  return hasVertexNearRgba(data, parseColor(css), x, y, tolerance);
}

function rectOf(
  x0: number,
  y0: number,
  width: number,
  height: number,
): Point[] {
  const points: Point[] = [];
  for (let y = y0; y < y0 + height; y += 1) {
    for (let x = x0; x < x0 + width; x += 1) {
      points.push({ x, y });
    }
  }
  return points;
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
  it("tints zoned lots, fills roads, and strokes the grid", () => {
    let state = createTestGameState();
    state = withAreaTile(state, 2, 3);
    state = withRoads(state, [{ x: 5, y: 5 }]);
    const batch = buildMapBatch(state).vertices;

    // Tile (2,3) is empty with an office zone: tinted fill, dashed perimeter.
    const lotFill = withAlpha(parseColor(colors.areaOffice), LOT_FILL_ALPHA);
    expect(hasVertexNearRgba(batch, lotFill, 64, 96)).toBe(true);
    expect(hasVertexNear(batch, colors.areaOffice, 64, 95)).toBe(true);
    // Tile (5,5) is a road: filled with the road color.
    expect(hasVertexNear(batch, colors.road, 5 * 32, 5 * 32)).toBe(true);
    // Grid strokes run along the tile boundary (lineWidth 1, centered).
    expect(hasVertexNear(batch, colors.grid, 64.5, 0)).toBe(true);
    expect(hasVertexNear(batch, colors.grid, 0, 96.5)).toBe(true);
  });
});

describe("buildMapBatch grass variation", () => {
  it("varies empty-tile fills into more than one subtle grass shade", () => {
    const batch = buildMapBatch(createTestGameState(), "hidden").vertices;
    const base = parseColor(colors.empty);
    const shades = new Set(
      rowsOf(batch)
        .filter(
          (row) =>
            Math.abs(row[2] - base[0]) < 0.08 &&
            Math.abs(row[3] - base[1]) < 0.08 &&
            Math.abs(row[4] - base[2]) < 0.08 &&
            row[5] === 1,
        )
        .map((row) =>
          row
            .slice(2, 6)
            .map((v) => v.toFixed(3))
            .join(","),
        ),
    );
    expect(shades.size).toBeGreaterThan(1);
  });
});

describe("buildMapBatch grid modes", () => {
  it("emits no grid geometry in hidden mode", () => {
    const batch = buildMapBatch(createTestGameState(), "hidden").vertices;
    expect(verticesOfColor(batch, colors.grid)).toHaveLength(0);
    const faint = withAlpha(parseColor(colors.grid), GRID_FAINT_ALPHA);
    expect(verticesOfRgba(batch, faint)).toHaveLength(0);
  });

  it("fades the same grid lines in faint mode", () => {
    const batch = buildMapBatch(createTestGameState(), "faint").vertices;
    const faint = withAlpha(parseColor(colors.grid), GRID_FAINT_ALPHA);
    expect(hasVertexNearRgba(batch, faint, 64.5, 0)).toBe(true);
    expect(hasVertexNearRgba(batch, faint, 0, 96.5)).toBe(true);
    expect(verticesOfColor(batch, colors.grid)).toHaveLength(0);
  });

  it("derives the mode from the armed tool and a discrete tile-size band", () => {
    expect(gridModeForTool("inspect", 32)).toBe("hidden");
    expect(gridModeForTool("inspect", 4)).toBe("hidden");
    expect(gridModeForTool("road", 32)).toBe("normal");
    expect(gridModeForTool("road", GRID_FAINT_TILE_PX - 0.5)).toBe("faint");
    expect(gridModeForTool("road", GRID_FAINT_TILE_PX)).toBe("normal");
  });

  it("arms the grid for building placement while the tool stays inspect", () => {
    expect(
      gridModeForUi(
        { activeTool: "inspect", selectedBuilding: "smallHouse" },
        GRID_FAINT_TILE_PX + 4,
      ),
    ).toBe("normal");
    expect(
      gridModeForUi(
        { activeTool: "inspect", selectedBuilding: "smallHouse" },
        GRID_FAINT_TILE_PX - 0.5,
      ),
    ).toBe("faint");
    expect(
      gridModeForUi(
        { activeTool: "inspect", selectedBuilding: null },
        GRID_FAINT_TILE_PX + 4,
      ),
    ).toBe("hidden");
    expect(
      gridModeForUi(
        { activeTool: "road", selectedBuilding: null },
        GRID_FAINT_TILE_PX - 0.5,
      ),
    ).toBe("faint");
  });
});

describe("buildMapBatch vacant-lot layer", () => {
  it("outlines a 6x6 zone as one lot with no interior dashes", () => {
    const state = withAreas(
      createTestGameState(),
      "residential",
      rectOf(2, 2, 6, 6),
    );
    const batch = buildMapBatch(state, "hidden").vertices;

    const dashes = verticesOfColor(batch, colors.areaResidential);
    expect(dashes.length).toBeGreaterThan(0);
    const onPerimeter = ([vx, vy]: number[]) =>
      Math.abs(vx - 64) <= 1.1 ||
      Math.abs(vx - 256) <= 1.1 ||
      Math.abs(vy - 64) <= 1.1 ||
      Math.abs(vy - 256) <= 1.1;
    expect(dashes.every(onPerimeter)).toBe(true);
    expect(
      dashes.some(
        ([vx, vy]) => Math.abs(vx - 96) <= 1.1 && vy > 66 && vy < 254,
      ),
    ).toBe(false);
    expect(dashes).toHaveLength(24 * 4 * 6);
  });

  it("drops the lot fill and grows dashes where a building occupies tiles", () => {
    let state = withAreas(
      createTestGameState(),
      "residential",
      rectOf(2, 2, 6, 6),
    );
    state = placeTestBuilding(state, "smallHouse", { x: 3, y: 3 }, 0);
    const batch = buildMapBatch(state, "hidden").vertices;

    const lotFill = withAlpha(
      parseColor(colors.areaResidential),
      LOT_FILL_ALPHA,
    );
    expect(verticesOfRgba(batch, lotFill)).toHaveLength(34 * 6);
    expect(
      verticesOfColor(batch, colors.areaResidential).some(
        ([vx, vy]) => Math.abs(vy - 96) <= 1.1 && vx >= 96 && vx <= 128,
      ),
    ).toBe(true);
  });
});

describe("buildMapBatch decorative trees", () => {
  it("scatters tree shadow circles deterministically on empty unzoned tiles", () => {
    const state = createTestGameState();
    const first = buildMapBatch(state, "hidden");
    const second = buildMapBatch(state, "hidden");
    expect(second.vertices).toEqual(first.vertices);

    // The flat canopy fill is gone; only the small offset shadow circles
    // remain, one TREE_CANOPY_SEGMENTS circle per tree.
    const shadows = verticesOfRgba(first.vertices, TREE_SHADOW);
    expect(shadows.length).toBeGreaterThan(0);
    expect(shadows.length % (TREE_CANOPY_SEGMENTS * 3)).toBe(0);
    const tileByKey = new Map(
      state.map.tiles.map((tile) => [`${tile.x},${tile.y}`, tile]),
    );
    for (const [vx, vy] of shadows) {
      const tile = tileByKey.get(
        `${Math.floor((vx - 3) / tileSize)},${Math.floor((vy - 3) / tileSize)}`,
      )!;
      expect(tile.kind).toBe("empty");
      expect(tile.area).toBeUndefined();
      expect(tile.hasTrack).not.toBe(true);
    }
  });
});

describe("buildMapBatch road furniture", () => {
  it("draws curbs where a road tile meets non-road ground", () => {
    const state = withRoads(createTestGameState(), [{ x: 8, y: 8 }]);
    const batch = buildMapBatch(state, "hidden").vertices;

    expect(hasVertexNear(batch, colors.roadCurb, 259, 257)).toBe(true);
    expect(hasVertexNear(batch, colors.roadCurb, 287, 259)).toBe(true);
    expect(hasVertexNear(batch, colors.roadCurb, 285, 287)).toBe(true);
    expect(hasVertexNear(batch, colors.roadCurb, 257, 285)).toBe(true);
  });

  it("leaves connected road edges curb-free", () => {
    const state = withRoads(createTestGameState(), [
      { x: 8, y: 8 },
      { x: 9, y: 8 },
    ]);
    const batch = buildMapBatch(state, "hidden").vertices;

    const curbs = verticesOfColor(batch, colors.roadCurb);
    expect(curbs.length).toBeGreaterThan(0);
    expect(
      curbs.some(
        ([vx, vy]) => Math.abs(vx - 288) <= 1.1 && vy >= 256 && vy <= 288,
      ),
    ).toBe(false);
  });

  it("draws curbs between parallel unconnected roads", () => {
    let state = createTestGameState();
    state = {
      ...state,
      map: {
        ...state.map,
        tiles: state.map.tiles.map((tile) => {
          if (tile.x === 8 && tile.y === 8) {
            return {
              ...tile,
              kind: "road",
              roadConnections: ["north", "south"],
            };
          }
          if (tile.x === 9 && tile.y === 8) {
            return {
              ...tile,
              kind: "road",
              roadConnections: ["north", "south"],
            };
          }
          return tile;
        }),
      },
    };
    const batch = buildMapBatch(state, "hidden").vertices;
    const curbs = verticesOfColor(batch, colors.roadCurb);
    // East curb of (8, 8) and west curb of (9, 8) must be present.
    expect(
      curbs.some(
        ([vx, vy]) => Math.abs(vx - 287) <= 1.1 && vy >= 256 && vy <= 288,
      ),
    ).toBe(true);
    expect(
      curbs.some(
        ([vx, vy]) => Math.abs(vx - 289) <= 1.1 && vy >= 256 && vy <= 288,
      ),
    ).toBe(true);
  });

  it("adds sleeper ticks across connected track but not isolated dots", () => {
    const state = withTracks(createTestGameState(), [
      { x: 8, y: 8 },
      { x: 9, y: 8 },
    ]);
    const batch = buildMapBatch(state, "hidden").vertices;

    const sleepers = verticesOfColor(batch, colors.trackSleeper);
    expect(sleepers.length).toBeGreaterThan(0);
    expect(
      sleepers.some(
        ([vx, vy]) => Math.abs(vx - 278.4) < 1.6 && Math.abs(vy - 267) <= 5.5,
      ),
    ).toBe(true);

    const isolated = buildMapBatch(
      withTracks(createTestGameState(), [{ x: 10, y: 10 }]),
      "hidden",
    ).vertices;
    expect(verticesOfColor(isolated, colors.trackSleeper)).toHaveLength(0);
  });
});

describe("buildMapBatch road layer", () => {
  it("draws straight road stubs from tile centers to connection edges", () => {
    const state = withRoads(createTestGameState(), pointsOnRow(8, 7, 15));
    const batch = buildMapBatch(state).vertices;

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
    const batch = buildMapBatch(state).vertices;

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
    const batch = buildMapBatch(state).vertices;

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
    const batch = buildMapBatch(state).vertices;

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

  it("does not outline the protected island as a vacant lot", () => {
    const footprint = rectOf(3, 3, 3, 3);
    const ring = footprint.filter((p) => p.x !== 4 || p.y !== 4);
    const structure: RoadStructure = {
      kind: "roundabout",
      id: "roundabout-1",
      origin: { x: 3, y: 3 },
      size: "standard3x3",
      footprint,
      ports: [],
    };
    // Zone a 5x5 residential block, then install the roundabout across its
    // center: ring tiles turn to road, the island keeps kind "empty" and its
    // area (mirroring install_roundabout in the core).
    let state = withAreas(
      createTestGameState(),
      "residential",
      rectOf(2, 2, 5, 5),
    );
    state = withRoads(state, ring);
    state = withJunction(state, structure);
    const batch = buildMapBatch(state, "hidden").vertices;

    const dashes = verticesOfColor(batch, colors.areaResidential);
    // Island tile (4,4) spans [128,160]^2; dashes only emit on tile edges
    // (LOT_DASH_WIDTH 2 -> +-1 around the edge), so these bands catch any
    // perimeter drawn around or through the island.
    const near = (v: number, edge: number) => Math.abs(v - edge) <= 1.1;
    const onIslandEdge = ([vx, vy]: number[]) =>
      ((near(vx, 128) || near(vx, 160)) && vy > 126 && vy < 162) ||
      ((near(vy, 128) || near(vy, 160)) && vx > 126 && vx < 162);
    expect(dashes.some(onIslandEdge)).toBe(false);
    // The surrounding zone still draws its outer perimeter.
    expect(
      dashes.some(([vx, vy]) => near(vy, 64) && vx >= 64 && vx <= 224),
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
    const batch = buildMapBatch(state).vertices;

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
    const batch = buildMapBatch(state).vertices;

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
    const batch = buildMapBatch(state).vertices;

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
  it("replaces flat roofs and outlines with one footprint shadow per sprite building", () => {
    const state = placeTestBuilding(
      createTestGameState(),
      "smallHouse",
      { x: 4, y: 5 },
      0,
    );
    const batch = buildMapBatch(state);

    // No flat roof fill and no outline stroke anywhere in the scene.
    expect(verticesOfColor(batch.vertices, "#a96a52")).toHaveLength(0);
    expect(verticesOfRgba(batch.vertices, BUILDING_OUTLINE)).toHaveLength(0);
    // One solid shadow rectangle over the whole rotated footprint (2x1
    // native tiles), offset by the same +3/+3 as before.
    expect(
      hasVertexNearRgba(batch.vertices, TREE_SHADOW, 4 * 32 + 3, 5 * 32 + 3),
    ).toBe(true);
    expect(
      hasVertexNearRgba(batch.vertices, TREE_SHADOW, 6 * 32 + 3, 6 * 32 + 3),
    ).toBe(true);
    // Tree shadows survive alongside it: 30 rows per circle, 6 per rect.
    const shadowRows = verticesOfRgba(batch.vertices, TREE_SHADOW).length;
    expect((shadowRows - 6) % (TREE_CANOPY_SEGMENTS * 3)).toBe(0);
  });

  it("follows the rotated footprint at a quarter turn", () => {
    // largeHouse: native 3x2 tiles; a 90° rotation occupies 2x3 tiles and
    // the shadow rect must match that rotated footprint, not the native one.
    const state = placeTestBuilding(
      createTestGameState(),
      "largeHouse",
      { x: 4, y: 3 },
      90,
    );
    const batch = buildMapBatch(state);

    expect(
      hasVertexNearRgba(batch.vertices, TREE_SHADOW, 4 * 32 + 3, 3 * 32 + 3),
    ).toBe(true);
    expect(
      hasVertexNearRgba(batch.vertices, TREE_SHADOW, 6 * 32 + 3, 6 * 32 + 3),
    ).toBe(true);
    // The unrotated 3x2 far corner stays shadow-free.
    expect(
      hasVertexNearRgba(batch.vertices, TREE_SHADOW, 7 * 32 + 3, 5 * 32 + 3),
    ).toBe(false);
  });

  it("skips shadow, pad and outline for bus stops and metro stations", () => {
    const base = createTestGameState();
    const baseShadowRows = verticesOfRgba(
      buildMapBatch(base, "hidden").vertices,
      TREE_SHADOW,
    ).length;
    // Place the transit building on a tile without a tree, so the baseline
    // shadow count would be unchanged by any placement that adds no rect.
    const treeTiles = new Set(
      spriteRowsOf(buildMapBatch(base, "hidden").sprites).map(
        (row) =>
          `${Math.floor(row[0]! / tileSize)},${Math.floor(row[1]! / tileSize)}`,
      ),
    );
    const target = base.map.tiles.find(
      (tile) =>
        tile.kind === "empty" &&
        tile.area === undefined &&
        !treeTiles.has(`${tile.x},${tile.y}`),
    );
    expect(target).toBeDefined();

    for (const type of ["busStop", "metroStation"] as const) {
      const batch = buildMapBatch(
        placeTestBuilding(base, type, target!, 0),
        "hidden",
      );
      // No detached 32x32 shadow square, no flat pad, no outline: the
      // procedural transitBatch marker stays alone over terrain.
      expect(verticesOfRgba(batch.vertices, TREE_SHADOW)).toHaveLength(
        baseShadowRows,
      );
      expect(verticesOfRgba(batch.vertices, BUILDING_OUTLINE)).toHaveLength(0);
      expect(
        verticesOfRgba(batch.vertices, parseColor("#e8734f")),
      ).toHaveLength(0);
      expect(
        verticesOfRgba(batch.vertices, parseColor("#3d7fd4")),
      ).toHaveLength(0);
      // And no sprite instance either — only tree rows remain.
      expect(
        spriteRowsOf(batch.sprites).every(
          (row) =>
            row[7]! >= TREE_SPRITE_LAYER_BASE &&
            row[7]! < TREE_SPRITE_LAYER_BASE + TREE_SPRITE_URLS.length,
        ),
      ).toBe(true);
    }
  });
});

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

const TREE_SHADOW = parseColor("rgba(74, 56, 34, 0.25)");
const BUILDING_OUTLINE = parseColor("rgba(17, 24, 32, 0.45)");

/** Tree sprite rows carry a tree layer (0-2); trees are emitted first, so
 *  they replace the old canopy-circle count in these fixtures. */
function treeRowCount(sprites: Float32Array): number {
  return spriteRowsOf(sprites).filter((row) => row[7]! < 3).length;
}

describe("buildMapBatch sprite instances", () => {
  it("returns solid vertices and sprite rows from one deterministic build", () => {
    const state = createTestGameState();
    const first = buildMapBatch(state, "hidden");
    const second = buildMapBatch(state, "hidden");
    expect(first.sprites.length % SPRITE_INSTANCE_FLOATS).toBe(0);
    expect(second.vertices).toEqual(first.vertices);
    expect(second.sprites).toEqual(first.sprites);
  });

  it("emits one tree sprite per canopy with all three variants and 12-18px extents", () => {
    // Empty-state edge of the tree invariants: with no buildings, zones or
    // roads every sprite row is a tree. The same deterministic checks are
    // also exercised against an actual Small Town snapshot built by the
    // real Rust sandbox (WASM) in tests/runtime/smallTownSpriteBatch.test.ts,
    // which this jsdom project cannot load.
    const state = createTestGameState();
    const batch = buildMapBatch(state, "hidden");
    const rows = spriteRowsOf(batch.sprites);
    const treeRows = rows.slice(0, treeRowCount(batch.sprites));
    // The default state places no buildings: every sprite row is a tree.
    expect(rows).toHaveLength(treeRowCount(batch.sprites));
    expect(treeRows.length).toBeGreaterThan(0);
    expect(new Set(treeRows.map((row) => row[7]))).toEqual(new Set([0, 1, 2]));
    for (const [x, y, angle, hx, hy, su, sv, , cx, cy] of treeRows) {
      expect(angle).toBe(0);
      expect(hx).toBeGreaterThanOrEqual(TREE_MIN_RADIUS);
      expect(hx).toBeLessThanOrEqual(TREE_MIN_RADIUS + TREE_RADIUS_SPAN);
      expect(hy).toBe(hx);
      expect(su).toBeCloseTo(192 / SPRITE_ATLAS_WIDTH, 6);
      expect(sv).toBeCloseTo(192 / SPRITE_ATLAS_HEIGHT, 6);
      // Trailing clip-scale slots belong to the host projection.
      expect(cx).toBe(0);
      expect(cy).toBe(0);
      const tile = state.map.tiles.find(
        (candidate) =>
          Math.abs(candidate.x * tileSize + tileSize / 2 - x) <= tileSize &&
          Math.abs(candidate.y * tileSize + tileSize / 2 - y) <= tileSize,
      );
      expect(tile).toBeDefined();
    }
  });

  it("drops the tree sprite (not a building sprite) where its tile is zoned or built on", () => {
    const state = createTestGameState();
    const before = buildMapBatch(state, "hidden");
    const rows = spriteRowsOf(before.sprites);
    const treeRows = rows.slice(0, treeRowCount(before.sprites));
    const target = treeRows[0]!;
    const tileX = Math.floor(target[0]! / tileSize);
    const tileY = Math.floor(target[1]! / tileSize);

    const zoned = buildMapBatch(
      withAreas(state, "park", [{ x: tileX, y: tileY }]),
      "hidden",
    );
    expect(spriteRowsOf(zoned.sprites)).toHaveLength(rows.length - 1);
    // busStop keeps no sprite instance: its procedural marker stays alone.
    const built = buildMapBatch(
      placeTestBuilding(state, "busStop", { x: tileX, y: tileY }, 0),
      "hidden",
    );
    expect(spriteRowsOf(built.sprites)).toHaveLength(rows.length - 1);
  });

  it("emits one unrotated-extent instance per building at 0/90/180/270", () => {
    // largeHouse: native 3x2 tiles. A 90/270 rotation occupies 2x3 tiles
    // but the half-extents and uv stay the unrotated native footprint.
    const expected = {
      0: { center: [5.5, 4], angle: 0 },
      90: { center: [5, 4.5], angle: Math.PI / 2 },
      180: { center: [5.5, 4], angle: Math.PI },
      270: { center: [5, 4.5], angle: (3 * Math.PI) / 2 },
    } as const;
    for (const rotation of [0, 90, 180, 270] as const) {
      const state = placeTestBuilding(
        createTestGameState(),
        "largeHouse",
        { x: 4, y: 3 },
        rotation,
      );
      const batch = buildMapBatch(state, "hidden");
      const rows = spriteRowsOf(batch.sprites);
      expect(rows).toHaveLength(treeRowCount(batch.sprites) + 1);
      const [x, y, angle, hx, hy, su, sv, layer] = rows[rows.length - 1]!;
      const want = expected[rotation];
      expect(x).toBeCloseTo(want.center[0] * tileSize, 6);
      expect(y).toBeCloseTo(want.center[1] * tileSize, 6);
      expect(angle).toBeCloseTo(want.angle, 6);
      expect(hx).toBe((BUILDING_CATALOG.largeHouse.width * tileSize) / 2);
      expect(hy).toBe((BUILDING_CATALOG.largeHouse.height * tileSize) / 2);
      expect(su).toBeCloseTo(
        (BUILDING_CATALOG.largeHouse.width * SPRITE_TEXELS_PER_TILE) /
          SPRITE_ATLAS_WIDTH,
        6,
      );
      expect(sv).toBeCloseTo(
        (BUILDING_CATALOG.largeHouse.height * SPRITE_TEXELS_PER_TILE) /
          SPRITE_ATLAS_HEIGHT,
        6,
      );
      expect(layer).toBe(BUILDING_SPRITE_LAYERS.largeHouse);
    }
  });

  it("derives uv scale from each building's native catalog footprint", () => {
    const state = placeTestBuilding(
      createTestGameState(),
      "smallHouse",
      { x: 2, y: 2 },
      0,
    );
    const batch = buildMapBatch(state, "hidden");
    const rows = spriteRowsOf(batch.sprites);
    const [su, sv, layer] = rows[rows.length - 1]!.slice(5, 8);
    expect(su).toBeCloseTo(384 / SPRITE_ATLAS_WIDTH, 6);
    expect(sv).toBeCloseTo(192 / SPRITE_ATLAS_HEIGHT, 6);
    expect(layer).toBe(BUILDING_SPRITE_LAYERS.smallHouse);
  });
});
