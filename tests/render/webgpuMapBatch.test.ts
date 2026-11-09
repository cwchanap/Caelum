import { describe, expect, it } from "vitest";
import type { GameState, Point, RoadStructure } from "../../src/domain/types";
import {
  GRID_FAINT_ALPHA,
  GRID_FAINT_TILE_PX,
  LOT_FILL_ALPHA,
  buildMapBatch,
  gridModeForTool,
  gridModeForUi,
} from "../../src/render/webgpu/mapBatch";
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

function tilesOfColor(data: Float32Array, css: string): Point[] {
  const keys = new Set(
    verticesOfColor(data, css).map(
      ([vx, vy]) => `${Math.floor(vx / tileSize)},${Math.floor(vy / tileSize)}`,
    ),
  );
  return [...keys].map((key) => {
    const [x, y] = key.split(",").map(Number);
    return { x, y };
  });
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
    const batch = buildMapBatch(state);

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
    const batch = buildMapBatch(createTestGameState(), "hidden");
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
    const batch = buildMapBatch(createTestGameState(), "hidden");
    expect(verticesOfColor(batch, colors.grid)).toHaveLength(0);
    const faint = withAlpha(parseColor(colors.grid), GRID_FAINT_ALPHA);
    expect(verticesOfRgba(batch, faint)).toHaveLength(0);
  });

  it("fades the same grid lines in faint mode", () => {
    const batch = buildMapBatch(createTestGameState(), "faint");
    const faint = withAlpha(parseColor(colors.grid), GRID_FAINT_ALPHA);
    expect(hasVertexNearRgba(batch, faint, 64.5, 0)).toBe(true);
    expect(hasVertexNearRgba(batch, faint, 0, 96.5)).toBe(true);
    expect(verticesOfColor(batch, colors.grid)).toHaveLength(0);
  });

  it("derives the mode from the armed tool and a discrete tile-size band", () => {
    expect(gridModeForTool("inspect", 32)).toBe("hidden");
    expect(gridModeForTool("inspect", 4)).toBe("hidden");
    for (const tool of [
      "busStop",
      "busRoute",
      "metroStation",
      "metroLine",
      "area",
      "road",
      "roundabout",
      "track",
      "remove",
    ] as const) {
      expect(gridModeForTool(tool, 32)).toBe("normal");
      expect(gridModeForTool(tool, GRID_FAINT_TILE_PX - 0.5)).toBe("faint");
    }
    expect(gridModeForTool("road", GRID_FAINT_TILE_PX)).toBe("normal");
    expect(gridModeForTool("road", GRID_FAINT_TILE_PX + 4)).toBe("normal");
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
    const batch = buildMapBatch(state, "hidden");

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
    const batch = buildMapBatch(state, "hidden");

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
  it("scatters canopy circles deterministically on empty unzoned tiles", () => {
    const state = createTestGameState();
    const first = buildMapBatch(state, "hidden");
    const second = buildMapBatch(state, "hidden");
    expect(second).toEqual(first);

    const canopies = verticesOfColor(first, colors.treeCanopy);
    expect(canopies.length).toBeGreaterThan(0);
    expect(canopies.length / 30).toBeLessThan(state.map.tiles.length * 0.25);
    const tileByKey = new Map(
      state.map.tiles.map((tile) => [`${tile.x},${tile.y}`, tile]),
    );
    for (const [vx, vy] of canopies) {
      const tile = tileByKey.get(
        `${Math.floor(vx / tileSize)},${Math.floor(vy / tileSize)}`,
      )!;
      expect(tile.kind).toBe("empty");
      expect(tile.area).toBeUndefined();
      expect(tile.hasTrack).not.toBe(true);
    }
  });

  it("removes a tree when its tile is zoned or built on", () => {
    const state = createTestGameState();
    const spots = tilesOfColor(
      buildMapBatch(state, "hidden"),
      colors.treeCanopy,
    );
    expect(spots.length).toBeGreaterThan(0);
    const target = spots[0];
    const inTile = ([vx, vy]: number[]) =>
      Math.floor(vx / tileSize) === target.x &&
      Math.floor(vy / tileSize) === target.y;

    const zoned = buildMapBatch(withAreas(state, "park", [target]), "hidden");
    expect(verticesOfColor(zoned, colors.treeCanopy).some(inTile)).toBe(false);

    const built = buildMapBatch(
      placeTestBuilding(state, "busStop", target, 0),
      "hidden",
    );
    expect(verticesOfColor(built, colors.treeCanopy).some(inTile)).toBe(false);
  });
});

describe("buildMapBatch road furniture", () => {
  it("draws curbs where a road tile meets non-road ground", () => {
    const state = withRoads(createTestGameState(), [{ x: 8, y: 8 }]);
    const batch = buildMapBatch(state, "hidden");

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
    const batch = buildMapBatch(state, "hidden");

    const curbs = verticesOfColor(batch, colors.roadCurb);
    expect(curbs.length).toBeGreaterThan(0);
    expect(
      curbs.some(
        ([vx, vy]) => Math.abs(vx - 288) <= 1.1 && vy >= 256 && vy <= 288,
      ),
    ).toBe(false);
  });

  it("adds sleeper ticks across connected track but not isolated dots", () => {
    const state = withTracks(createTestGameState(), [
      { x: 8, y: 8 },
      { x: 9, y: 8 },
    ]);
    const batch = buildMapBatch(state, "hidden");

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
    );
    expect(verticesOfColor(isolated, colors.trackSleeper)).toHaveLength(0);
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
  it("fills building footprints, shadows them, and outlines the perimeter only", () => {
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
      expect(
        hasVertexNear(
          batch,
          "rgba(74, 56, 34, 0.25)",
          tile.x * 32 + 3,
          tile.y * 32 + 3,
        ),
      ).toBe(true);
    }
    // Outline stroke (lineWidth 2, centered on the tile boundary).
    expect(
      hasVertexNear(batch, "rgba(17, 24, 32, 0.45)", 4 * 32 - 1, 5 * 32),
    ).toBe(true);
    expect(
      hasVertexNear(batch, "rgba(17, 24, 32, 0.45)", 6 * 32 + 1, 5 * 32),
    ).toBe(true);
    expect(verticesOfColor(batch, "rgba(17, 24, 32, 0.45)")).toHaveLength(
      6 * 6,
    );
  });

  it("keeps the shared boundary between two adjacent buildings outlined", () => {
    let state = placeTestBuilding(
      createTestGameState(),
      "smallHouse",
      { x: 4, y: 4 },
      0,
    );
    state = placeTestBuilding(state, "smallHouse", { x: 4, y: 5 }, 0);
    const batch = buildMapBatch(state);

    // The y=160 seams between (4,4)|(4,5) and (5,4)|(5,5) belong to
    // different buildings, so they keep a 2px stroke instead of merging.
    expect(hasVertexNear(batch, "rgba(17, 24, 32, 0.45)", 128, 159)).toBe(true);
    expect(hasVertexNear(batch, "rgba(17, 24, 32, 0.45)", 192, 161)).toBe(true);
    // The 2x2 block's 8 perimeter edges plus the 2 internal seams: 10 quads.
    expect(verticesOfColor(batch, "rgba(17, 24, 32, 0.45)")).toHaveLength(60);
  });

  it("emits every shadow before roof fills regardless of building order", () => {
    const shadow = parseColor("rgba(74, 56, 34, 0.25)");
    const roof = parseColor(colors.buildingHouse);
    for (const southernFirst of [true, false]) {
      let state = createTestGameState();
      for (const origin of southernFirst
        ? [
            { x: 4, y: 4 },
            { x: 4, y: 3 },
          ]
        : [
            { x: 4, y: 3 },
            { x: 4, y: 4 },
          ]) {
        state = placeTestBuilding(state, "smallHouse", origin, 0);
      }
      const rows = rowsOf(buildMapBatch(state, "hidden"));

      const lastShadow = rows.reduce(
        (last, row, index) => (sameColorRgba(row, shadow) ? index : last),
        -1,
      );
      const firstFill = rows.findIndex((row) => sameColorRgba(row, roof));
      expect(lastShadow).toBeGreaterThanOrEqual(0);
      // A later building's shadow must not overpaint an earlier roof.
      expect(firstFill).toBeGreaterThan(lastShadow);
    }
  });
});
