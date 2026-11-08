import type {
  AreaKind,
  BuildingType,
  GameMap,
  GameState,
  Heading,
  PathGeometry,
  Point,
  Tile,
  Tool,
} from "../../domain/types";
import { ROAD_DIRECTION_OFFSET } from "../../domain/types";
import { tileSize } from "../boardTransform";
import { colors } from "../colors";
import {
  type Rgba,
  SolidGeometry,
  parseColor,
  toPixelGeometry,
  withAlpha,
} from "./primitives";

// Stroke weights mirror the Canvas renderers this batch replaces.
const GRID_WIDTH = 1;
const ROAD_STROKE_WIDTH = 4;
const ROUNDABOUT_STROKE_WIDTH = 5;
const TRACK_WIDTH = 4;
const ONE_WAY_ARROW_WIDTH = 2;
const BUILDING_OUTLINE_WIDTH = 2;
const BUILDING_OUTLINE_COLOR = "rgba(17, 24, 32, 0.45)";
const BUILDING_SHADOW_COLOR = "rgba(74, 56, 34, 0.25)";

export type GridMode = "hidden" | "faint" | "normal";
export const GRID_FAINT_ALPHA = 0.5;
export const GRID_FAINT_TILE_PX = 20;
export const LOT_FILL_ALPHA = 0.45;
const LOT_DASH_WIDTH = 2;
const LOT_DASH_LENGTH = 6;
const LOT_GAP_LENGTH = 4;
const CURB_WIDTH = 2;
const CURB_INSET = 2;
const CURB_END_INSET = 3;
const SLEEPER_WIDTH = 1.5;
const SLEEPER_HALF_LENGTH = 5;
const SLEEPER_POSITIONS = [0.4, 0.8] as const;
const ROOF_SHADOW_OFFSET = 3;
const TREE_RATE = 0.12;
const TREE_JITTER_PX = 10;
const TREE_MIN_RADIUS = 6;
const TREE_RADIUS_SPAN = 3;
const TREE_CANOPY_SEGMENTS = 10;
const GRASS_SHADES = [0.96, 0.985, 1.01, 1.035] as const;
const BOARD_EDGE_SHADE = 0.92;

const GRID = parseColor(colors.grid);
const GRID_FAINT = withAlpha(GRID, GRID_FAINT_ALPHA);
const ROAD_FILL = parseColor(colors.road);
const EMPTY_FILL = parseColor(colors.empty);
const CENTERLINE = parseColor(colors.roadCenterline);
const TRACK = parseColor(colors.track);
const ONE_WAY_ARROW = parseColor(colors.oneWayArrow);
const ROUNDABOUT_ISLAND = parseColor(colors.roundaboutIsland);
const BUILDING_OUTLINE = parseColor(BUILDING_OUTLINE_COLOR);
const BUILDING_SHADOW = parseColor(BUILDING_SHADOW_COLOR);
const CURB = parseColor(colors.roadCurb);
const SLEEPER = parseColor(colors.trackSleeper);
const TREE_CANOPY = parseColor(colors.treeCanopy);

const buildingColors: Record<BuildingType, ReturnType<typeof parseColor>> = {
  busStop: parseColor(colors.buildingBus),
  busTerminal: parseColor(colors.buildingTerminal),
  metroStation: parseColor(colors.buildingMetro),
  smallHouse: parseColor(colors.buildingHouse),
  largeHouse: parseColor(colors.buildingHouse),
  supermarket: parseColor(colors.buildingCommercial),
  cinema: parseColor(colors.buildingCommercial),
  factory: parseColor(colors.buildingIndustrial),
  warehouse: parseColor(colors.buildingIndustrial),
  officeTower: parseColor(colors.buildingOffice),
  businessPark: parseColor(colors.buildingOffice),
  clinic: parseColor(colors.buildingCivic),
  school: parseColor(colors.buildingCivic),
  parkPlaza: parseColor(colors.buildingPark),
};

const areaFills: Record<AreaKind, Rgba> = {
  residential: parseColor(colors.areaResidential),
  commercial: parseColor(colors.areaCommercial),
  industrial: parseColor(colors.areaIndustrial),
  office: parseColor(colors.areaOffice),
  civic: parseColor(colors.areaCivic),
  park: parseColor(colors.areaPark),
};

const CARDINAL_OFFSETS: Array<{ heading: Heading; offset: Point }> = [
  { heading: "north", offset: { x: 0, y: -1 } },
  { heading: "east", offset: { x: 1, y: 0 } },
  { heading: "south", offset: { x: 0, y: 1 } },
  { heading: "west", offset: { x: -1, y: 0 } },
];

function keyOf(point: Point): string {
  return `${point.x},${point.y}`;
}

export function gridModeForTool(tool: Tool, tileCssPx: number): GridMode {
  if (tool === "inspect") return "hidden";
  return tileCssPx < GRID_FAINT_TILE_PX ? "faint" : "normal";
}

export function gridModeForUi(
  ui: { activeTool: Tool; selectedBuilding: BuildingType | null },
  tileCssPx: number,
): GridMode {
  if (ui.activeTool === "inspect" && ui.selectedBuilding !== null) {
    return tileCssPx < GRID_FAINT_TILE_PX ? "faint" : "normal";
  }
  return gridModeForTool(ui.activeTool, tileCssPx);
}

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

function center(point: Point): Point {
  return {
    x: point.x * tileSize + tileSize / 2,
    y: point.y * tileSize + tileSize / 2,
  };
}

function connectionEndpoint(point: Point, heading: Heading): Point {
  const tileCenter = center(point);
  const offset = ROAD_DIRECTION_OFFSET[heading];
  return {
    x: tileCenter.x + (offset.x * tileSize) / 2,
    y: tileCenter.y + (offset.y * tileSize) / 2,
  };
}

function isCorner(headings: readonly Heading[]): boolean {
  if (headings.length !== 2) return false;
  const first = ROAD_DIRECTION_OFFSET[headings[0]];
  const second = ROAD_DIRECTION_OFFSET[headings[1]];
  return first.x * second.x + first.y * second.y === 0;
}

function fillTileRect(
  g: SolidGeometry,
  tile: Point,
  color: ReturnType<typeof parseColor>,
): void {
  g.rect(tile.x * tileSize, tile.y * tileSize, tileSize, tileSize, color);
}

/** Tessellates one canvas-style strokeRect edge (lineWidth centered on the
 *  path). */
function strokeTileEdge(
  g: SolidGeometry,
  tile: Point,
  offset: Point,
  thickness: number,
  color: ReturnType<typeof parseColor>,
): void {
  const x0 = tile.x * tileSize;
  const y0 = tile.y * tileSize;
  if (offset.y === -1) {
    g.thickLine(
      { x: x0, y: y0 },
      { x: x0 + tileSize, y: y0 },
      thickness,
      color,
    );
  } else if (offset.x === 1) {
    g.thickLine(
      { x: x0 + tileSize, y: y0 },
      { x: x0 + tileSize, y: y0 + tileSize },
      thickness,
      color,
    );
  } else if (offset.y === 1) {
    g.thickLine(
      { x: x0 + tileSize, y: y0 + tileSize },
      { x: x0, y: y0 + tileSize },
      thickness,
      color,
    );
  } else {
    g.thickLine(
      { x: x0, y: y0 + tileSize },
      { x: x0, y: y0 },
      thickness,
      color,
    );
  }
}

/** Shaft + chevron head, matching the canvas drawDirectionArrow glyph. */
export function directionArrow(
  g: SolidGeometry,
  point: Point,
  direction: Heading,
  color: ReturnType<typeof parseColor>,
  width: number = ONE_WAY_ARROW_WIDTH,
): void {
  const offset = ROAD_DIRECTION_OFFSET[direction];
  const cx = point.x * tileSize + tileSize / 2;
  const cy = point.y * tileSize + tileSize / 2;
  const half = tileSize / 4;
  const tip = { x: cx + offset.x * half, y: cy + offset.y * half };
  const tail = { x: cx - offset.x * half, y: cy - offset.y * half };
  const head = tileSize / 6;
  g.thickLine(tail, tip, width, color);
  g.thickLine(
    tip,
    {
      x: tip.x - offset.x * head + offset.y * head,
      y: tip.y - offset.y * head - offset.x * head,
    },
    width,
    color,
  );
  g.thickLine(
    tip,
    {
      x: tip.x - offset.x * head - offset.y * head,
      y: tip.y - offset.y * head + offset.x * head,
    },
    width,
    color,
  );
}

function protectedIslandKeys(state: GameState): Set<string> {
  return new Set(
    state.map.roadStructures.flatMap((structure) =>
      structure.kind === "roundabout" && structure.size === "standard3x3"
        ? [`${structure.origin.x + 1},${structure.origin.y + 1}`]
        : [],
    ),
  );
}

function occupiedTileKeys(state: GameState): Set<string> {
  return new Set(
    state.buildings.flatMap((building) => building.occupiedTiles.map(keyOf)),
  );
}

function grassFill(map: GameMap, tile: Tile): Rgba {
  const shade =
    GRASS_SHADES[
      Math.floor(tileHash(tile.x, tile.y, 0) * GRASS_SHADES.length) %
        GRASS_SHADES.length
    ];
  const edge =
    tile.x === 0 ||
    tile.y === 0 ||
    tile.x === map.width - 1 ||
    tile.y === map.height - 1;
  const factor = shade * (edge ? BOARD_EDGE_SHADE : 1);
  return [
    Math.min(1, EMPTY_FILL[0] * factor),
    Math.min(1, EMPTY_FILL[1] * factor),
    Math.min(1, EMPTY_FILL[2] * factor),
    1,
  ];
}

function tileFillColor(
  map: GameMap,
  tile: Tile,
  islandKeys: ReadonlySet<string>,
  occupiedKeys: ReadonlySet<string>,
): Rgba {
  if (islandKeys.has(keyOf(tile))) return EMPTY_FILL;
  if (tile.kind === "road") return ROAD_FILL;
  if (tile.area !== undefined && !occupiedKeys.has(keyOf(tile))) {
    return withAlpha(areaFills[tile.area], LOT_FILL_ALPHA);
  }
  return grassFill(map, tile);
}

function drawOrdinaryRoad(g: SolidGeometry, tile: Tile): void {
  if (isCorner(tile.roadConnections)) {
    const from = connectionEndpoint(tile, tile.roadConnections[0]);
    const to = connectionEndpoint(tile, tile.roadConnections[1]);
    const control = center(tile);
    g.curve(
      { kind: "quadraticBezier", from, control, to },
      ROAD_STROKE_WIDTH,
      CENTERLINE,
    );
    return;
  }
  for (const heading of tile.roadConnections) {
    g.thickLine(
      center(tile),
      connectionEndpoint(tile, heading),
      ROAD_STROKE_WIDTH,
      CENTERLINE,
    );
  }
}

function drawCurbs(
  g: SolidGeometry,
  tile: Tile,
  tileByKey: ReadonlyMap<string, Tile>,
): void {
  const x0 = tile.x * tileSize;
  const y0 = tile.y * tileSize;
  for (const { heading, offset } of CARDINAL_OFFSETS) {
    const neighbor = tileByKey.get(`${tile.x + offset.x},${tile.y + offset.y}`);
    if (neighbor?.kind === "road") continue;
    switch (heading) {
      case "north":
        g.thickLine(
          { x: x0 + CURB_END_INSET, y: y0 + CURB_INSET },
          { x: x0 + tileSize - CURB_END_INSET, y: y0 + CURB_INSET },
          CURB_WIDTH,
          CURB,
        );
        break;
      case "east":
        g.thickLine(
          { x: x0 + tileSize - CURB_INSET, y: y0 + CURB_END_INSET },
          { x: x0 + tileSize - CURB_INSET, y: y0 + tileSize - CURB_END_INSET },
          CURB_WIDTH,
          CURB,
        );
        break;
      case "south":
        g.thickLine(
          { x: x0 + tileSize - CURB_END_INSET, y: y0 + tileSize - CURB_INSET },
          { x: x0 + CURB_END_INSET, y: y0 + tileSize - CURB_INSET },
          CURB_WIDTH,
          CURB,
        );
        break;
      case "west":
        g.thickLine(
          { x: x0 + CURB_INSET, y: y0 + tileSize - CURB_END_INSET },
          { x: x0 + CURB_INSET, y: y0 + CURB_END_INSET },
          CURB_WIDTH,
          CURB,
        );
        break;
    }
  }
}

/** Counterclockwise circulation arcs and the protected-island dot derived
 *  only from the serialized size/origin; never invents gameplay edges. */
function roundaboutVisualTemplate(
  structure: Extract<
    GameState["map"]["roadStructures"][number],
    { kind: "roundabout" }
  >,
): {
  circulationCurves: PathGeometry[];
  protectedIslands: Point[];
} {
  const dimension = structure.size === "compact2x2" ? 2 : 3;
  const segmentCount = structure.size === "compact2x2" ? 4 : 8;
  const center = {
    x: structure.origin.x + (dimension - 1) / 2,
    y: structure.origin.y + (dimension - 1) / 2,
  };
  const radius = structure.size === "compact2x2" ? 0.58 : 1.08;
  const sweepRadians = -(Math.PI * 2) / segmentCount;
  return {
    circulationCurves: Array.from({ length: segmentCount }, (_, index) => ({
      kind: "arc" as const,
      center,
      radius,
      startRadians: -index * ((Math.PI * 2) / segmentCount),
      sweepRadians,
    })),
    protectedIslands: structure.size === "standard3x3" ? [{ ...center }] : [],
  };
}

function drawRoundabout(
  g: SolidGeometry,
  structure: Extract<
    GameState["map"]["roadStructures"][number],
    { kind: "roundabout" }
  >,
): void {
  const template = roundaboutVisualTemplate(structure);
  for (const curve of template.circulationCurves) {
    g.curve(
      toPixelGeometry(curve, center),
      ROUNDABOUT_STROKE_WIDTH,
      CENTERLINE,
    );
  }
  for (const port of structure.ports) {
    const portCenter = center(port.point);
    const endpoint = {
      x:
        portCenter.x +
        (port.edge === "east"
          ? tileSize / 2
          : port.edge === "west"
            ? -tileSize / 2
            : 0),
      y:
        portCenter.y +
        (port.edge === "south"
          ? tileSize / 2
          : port.edge === "north"
            ? -tileSize / 2
            : 0),
    };
    g.thickLine(portCenter, endpoint, ROUNDABOUT_STROKE_WIDTH, CENTERLINE);
    const marker = {
      x: portCenter.x + (endpoint.x - portCenter.x) * 0.7,
      y: portCenter.y + (endpoint.y - portCenter.y) * 0.7,
    };
    const markerLength = tileSize / 4;
    const markerThickness = 2;
    if (port.edge === "north" || port.edge === "south") {
      g.rect(
        marker.x - markerLength / 2,
        marker.y - markerThickness / 2,
        markerLength,
        markerThickness,
        CENTERLINE,
      );
    } else {
      g.rect(
        marker.x - markerThickness / 2,
        marker.y - markerLength / 2,
        markerThickness,
        markerLength,
        CENTERLINE,
      );
    }
  }
  for (const island of template.protectedIslands) {
    g.circle(center(island), tileSize * 0.3, ROUNDABOUT_ISLAND);
  }
}

function drawLotPerimeters(
  g: SolidGeometry,
  map: GameMap,
  tileByKey: ReadonlyMap<string, Tile>,
  occupiedKeys: ReadonlySet<string>,
): void {
  const isVacant = (tile: Tile | undefined, area: AreaKind): boolean =>
    tile !== undefined &&
    tile.kind === "empty" &&
    tile.area === area &&
    !occupiedKeys.has(keyOf(tile));
  for (const tile of map.tiles) {
    if (tile.area === undefined || !isVacant(tile, tile.area)) continue;
    const area = tile.area;
    const x0 = tile.x * tileSize;
    const y0 = tile.y * tileSize;
    const edge = areaFills[area];
    for (const { heading, offset } of CARDINAL_OFFSETS) {
      const neighbor = tileByKey.get(
        `${tile.x + offset.x},${tile.y + offset.y}`,
      );
      if (isVacant(neighbor, area)) continue;
      switch (heading) {
        case "north":
          g.dashedLine(
            { x: x0, y: y0 },
            { x: x0 + tileSize, y: y0 },
            LOT_DASH_WIDTH,
            LOT_DASH_LENGTH,
            LOT_GAP_LENGTH,
            edge,
          );
          break;
        case "east":
          g.dashedLine(
            { x: x0 + tileSize, y: y0 },
            { x: x0 + tileSize, y: y0 + tileSize },
            LOT_DASH_WIDTH,
            LOT_DASH_LENGTH,
            LOT_GAP_LENGTH,
            edge,
          );
          break;
        case "south":
          g.dashedLine(
            { x: x0 + tileSize, y: y0 + tileSize },
            { x: x0, y: y0 + tileSize },
            LOT_DASH_WIDTH,
            LOT_DASH_LENGTH,
            LOT_GAP_LENGTH,
            edge,
          );
          break;
        case "west":
          g.dashedLine(
            { x: x0, y: y0 + tileSize },
            { x: x0, y: y0 },
            LOT_DASH_WIDTH,
            LOT_DASH_LENGTH,
            LOT_GAP_LENGTH,
            edge,
          );
          break;
      }
    }
  }
}

function drawTracks(g: SolidGeometry, state: GameState): void {
  const trackKeys = new Set(
    state.map.tiles
      .filter((tile) => tile.hasTrack === true)
      .map((tile) => `${tile.x},${tile.y}`),
  );
  if (trackKeys.size === 0) return;

  for (const tile of state.map.tiles) {
    if (tile.hasTrack !== true) continue;
    const tileCenter = center(tile);
    let connected = false;
    for (const offset of [
      { x: 0, y: -1 },
      { x: 1, y: 0 },
      { x: 0, y: 1 },
      { x: -1, y: 0 },
    ]) {
      if (!trackKeys.has(`${tile.x + offset.x},${tile.y + offset.y}`)) {
        continue;
      }
      connected = true;
      const endpoint = {
        x: tileCenter.x + (offset.x * tileSize) / 2,
        y: tileCenter.y + (offset.y * tileSize) / 2,
      };
      for (const t of SLEEPER_POSITIONS) {
        const px = tileCenter.x + (endpoint.x - tileCenter.x) * t;
        const py = tileCenter.y + (endpoint.y - tileCenter.y) * t;
        g.thickLine(
          {
            x: px - offset.y * SLEEPER_HALF_LENGTH,
            y: py - offset.x * SLEEPER_HALF_LENGTH,
          },
          {
            x: px + offset.y * SLEEPER_HALF_LENGTH,
            y: py + offset.x * SLEEPER_HALF_LENGTH,
          },
          SLEEPER_WIDTH,
          SLEEPER,
        );
      }
      g.thickLine(tileCenter, endpoint, TRACK_WIDTH, TRACK);
    }
    if (!connected) {
      // Canvas strokes an arc (radius 4, lineWidth 4): a ring band 2..6.
      g.ring(tileCenter, 4 + TRACK_WIDTH / 2, TRACK_WIDTH, TRACK);
    }
  }
}

function drawTrees(
  g: SolidGeometry,
  map: GameMap,
  islandKeys: ReadonlySet<string>,
  occupiedKeys: ReadonlySet<string>,
): void {
  for (const tile of map.tiles) {
    if (
      tile.kind !== "empty" ||
      tile.area !== undefined ||
      tile.hasTrack === true ||
      tile.roadStructureId !== undefined ||
      islandKeys.has(keyOf(tile)) ||
      occupiedKeys.has(keyOf(tile))
    ) {
      continue;
    }
    if (tileHash(tile.x, tile.y, 1) >= TREE_RATE) continue;
    const jx = (tileHash(tile.x, tile.y, 2) - 0.5) * TREE_JITTER_PX;
    const jy = (tileHash(tile.x, tile.y, 3) - 0.5) * TREE_JITTER_PX;
    const radius =
      TREE_MIN_RADIUS + tileHash(tile.x, tile.y, 4) * TREE_RADIUS_SPAN;
    const canopy = {
      x: tile.x * tileSize + tileSize / 2 + jx,
      y: tile.y * tileSize + tileSize / 2 + jy,
    };
    g.circle(
      { x: canopy.x + ROOF_SHADOW_OFFSET, y: canopy.y + ROOF_SHADOW_OFFSET },
      radius,
      BUILDING_SHADOW,
      TREE_CANOPY_SEGMENTS,
    );
    g.circle(canopy, radius, TREE_CANOPY, TREE_CANOPY_SEGMENTS);
  }
}

/**
 * Tessellates the structural map scene — tile fills/grid, vacant-lot
 * perimeters, decorative trees, curbs, roads, automatic junctions,
 * roundabouts, track with sleepers, one-way arrows and roofed buildings —
 * in the same painter order as renderMap + renderBuildings. Output is a
 * solid triangle vertex buffer in world pixels (tileSize grid), cached
 * under `scene:<rev>:<gridMode>`.
 */
export function buildMapBatch(
  state: GameState,
  gridMode: GridMode = "normal",
): Float32Array<ArrayBuffer> {
  const g = new SolidGeometry();
  const islandKeys = protectedIslandKeys(state);
  const occupiedKeys = occupiedTileKeys(state);
  const tileByKey = new Map(state.map.tiles.map((tile) => [keyOf(tile), tile]));

  for (const tile of state.map.tiles) {
    fillTileRect(
      g,
      tile,
      tileFillColor(state.map, tile, islandKeys, occupiedKeys),
    );
  }

  if (gridMode !== "hidden") {
    const grid = gridMode === "faint" ? GRID_FAINT : GRID;
    const boardWidth = state.map.width * tileSize;
    const boardHeight = state.map.height * tileSize;
    for (let x = 0; x <= state.map.width; x += 1) {
      g.thickLine(
        { x: x * tileSize, y: 0 },
        { x: x * tileSize, y: boardHeight },
        GRID_WIDTH,
        grid,
      );
    }
    for (let y = 0; y <= state.map.height; y += 1) {
      g.thickLine(
        { x: 0, y: y * tileSize },
        { x: boardWidth, y: y * tileSize },
        GRID_WIDTH,
        grid,
      );
    }
  }

  drawLotPerimeters(g, state.map, tileByKey, occupiedKeys);
  drawTrees(g, state.map, islandKeys, occupiedKeys);

  const structureKinds = new Map(
    state.map.roadStructures.map((structure) => [structure.id, structure.kind]),
  );
  for (const tile of state.map.tiles) {
    if (tile.kind !== "road") continue;
    drawCurbs(g, tile, tileByKey);
    const structureKind =
      tile.roadStructureId === undefined
        ? undefined
        : structureKinds.get(tile.roadStructureId);
    if (structureKind === undefined) {
      drawOrdinaryRoad(g, tile);
    }
  }
  for (const structure of state.map.roadStructures) {
    if (structure.kind !== "automaticJunction") continue;
    for (const port of structure.ports) {
      g.thickLine(
        center(port.point),
        connectionEndpoint(port.point, port.edge),
        ROAD_STROKE_WIDTH,
        CENTERLINE,
      );
    }
  }
  for (const structure of state.map.roadStructures) {
    if (structure.kind === "roundabout") {
      drawRoundabout(g, structure);
    }
  }

  drawTracks(g, state);

  for (const tile of state.map.tiles) {
    if (tile.kind === "road" && tile.oneWay !== undefined) {
      directionArrow(g, tile, tile.oneWay, ONE_WAY_ARROW);
    }
  }

  for (const building of state.buildings) {
    const fill = buildingColors[building.type];
    for (const tile of building.occupiedTiles) {
      g.rect(
        tile.x * tileSize + ROOF_SHADOW_OFFSET,
        tile.y * tileSize + ROOF_SHADOW_OFFSET,
        tileSize,
        tileSize,
        BUILDING_SHADOW,
      );
    }
    for (const tile of building.occupiedTiles) {
      fillTileRect(g, tile, fill);
      for (const { offset } of CARDINAL_OFFSETS) {
        if (occupiedKeys.has(`${tile.x + offset.x},${tile.y + offset.y}`)) {
          continue;
        }
        strokeTileEdge(
          g,
          tile,
          offset,
          BUILDING_OUTLINE_WIDTH,
          BUILDING_OUTLINE,
        );
      }
    }
  }

  return g.toFloat32Array();
}
