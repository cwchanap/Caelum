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
import {
  BUILDING_CATALOG,
  getRotatedFootprintSize,
} from "../../domain/catalog/buildings";
import {
  SPRITE_ATLAS_HEIGHT,
  SPRITE_ATLAS_WIDTH,
  SPRITE_TEXELS_PER_TILE,
  TRANSIT_SPRITE_LAYERS,
  spriteLayerFor,
  treeSpriteLayer,
} from "./spriteLayers";
import {
  ROAD_DIRECTION_OFFSET,
  ROUNDABOUT_DIMENSIONS,
} from "../../domain/types";
import { tileSize } from "../boardTransform";
import { areaColors, colors } from "../colors";
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
const ROOF_SHADOW_OFFSET = 3;
const TREE_RATE = 0.12;
const TREE_JITTER_PX = 10;
export const TREE_MIN_RADIUS = 6;
export const TREE_RADIUS_SPAN = 3;
export const TREE_CANOPY_SEGMENTS = 10;
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
const BUILDING_SHADOW = parseColor(BUILDING_SHADOW_COLOR);
const CURB = parseColor(colors.roadCurb);

const areaFills: Record<AreaKind, Rgba> = {
  residential: parseColor(areaColors.residential),
  commercial: parseColor(areaColors.commercial),
  industrial: parseColor(areaColors.industrial),
  office: parseColor(areaColors.office),
  civic: parseColor(areaColors.civic),
  park: parseColor(areaColors.park),
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

export function gridModeForUi(
  ui: { activeTool: Tool; selectedBuilding?: BuildingType | null },
  tileCssPx: number,
): GridMode {
  const armed = ui.activeTool !== "inspect" || Boolean(ui.selectedBuilding);
  if (!armed) return "hidden";
  return tileCssPx < GRID_FAINT_TILE_PX ? "faint" : "normal";
}

export function gridModeForTool(tool: Tool, tileCssPx: number): GridMode {
  return gridModeForUi({ activeTool: tool }, tileCssPx);
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

function tileEdgeEndpoints(
  tile: Point,
  heading: Heading,
  inset = 0,
  endInset = 0,
): { from: Point; to: Point } {
  const x0 = tile.x * tileSize;
  const y0 = tile.y * tileSize;
  switch (heading) {
    case "north":
      return {
        from: { x: x0 + endInset, y: y0 + inset },
        to: { x: x0 + tileSize - endInset, y: y0 + inset },
      };
    case "east":
      return {
        from: { x: x0 + tileSize - inset, y: y0 + endInset },
        to: { x: x0 + tileSize - inset, y: y0 + tileSize - endInset },
      };
    case "south":
      return {
        from: { x: x0 + tileSize - endInset, y: y0 + tileSize - inset },
        to: { x: x0 + endInset, y: y0 + tileSize - inset },
      };
    case "west":
      return {
        from: { x: x0 + inset, y: y0 + tileSize - endInset },
        to: { x: x0 + inset, y: y0 + endInset },
      };
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

function occupiedTileOwners(state: GameState): Map<string, number> {
  const owners = new Map<string, number>();
  state.buildings.forEach((building, index) => {
    for (const tile of building.occupiedTiles) {
      owners.set(keyOf(tile), index);
    }
  });
  return owners;
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
  tileOwners: ReadonlyMap<string, number>,
): Rgba {
  if (islandKeys.has(keyOf(tile))) return EMPTY_FILL;
  if (tile.kind === "road") return ROAD_FILL;
  if (tile.area !== undefined && !tileOwners.has(keyOf(tile))) {
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
  for (const { heading, offset } of CARDINAL_OFFSETS) {
    if (tile.roadConnections.includes(heading)) continue;
    const neighbor = tileByKey.get(`${tile.x + offset.x},${tile.y + offset.y}`);
    if (
      tile.roadStructureId !== undefined &&
      neighbor?.roadStructureId === tile.roadStructureId
    ) {
      continue;
    }
    const { from, to } = tileEdgeEndpoints(
      tile,
      heading,
      CURB_INSET,
      CURB_END_INSET,
    );
    g.thickLine(from, to, CURB_WIDTH, CURB);
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
  const dimension = ROUNDABOUT_DIMENSIONS[structure.size];
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
  tileOwners: ReadonlyMap<string, number>,
): void {
  const isVacant = (tile: Tile | undefined, area: AreaKind): boolean =>
    tile !== undefined &&
    tile.kind === "empty" &&
    tile.area === area &&
    tile.roadStructureId === undefined &&
    !tileOwners.has(keyOf(tile));
  for (const tile of map.tiles) {
    if (tile.area === undefined || !isVacant(tile, tile.area)) continue;
    const area = tile.area;
    const edge = areaFills[area];
    for (const { heading, offset } of CARDINAL_OFFSETS) {
      const neighbor = tileByKey.get(
        `${tile.x + offset.x},${tile.y + offset.y}`,
      );
      if (isVacant(neighbor, area)) continue;
      const { from, to } = tileEdgeEndpoints(tile, heading);
      g.dashedLine(
        from,
        to,
        LOT_DASH_WIDTH,
        LOT_DASH_LENGTH,
        LOT_GAP_LENGTH,
        edge,
      );
    }
  }
}

type TrackPiece = {
  kind: "straight" | "corner" | "half";
  rotation: 0 | 90 | 180 | 270;
};

/** N=1, E=2, S=4, W=8; art begins west–east or west–north. */
export const TRACK_PIECES: readonly (readonly TrackPiece[])[] = [
  [],
  [{ kind: "half", rotation: 90 }],
  [{ kind: "half", rotation: 180 }],
  [{ kind: "corner", rotation: 90 }],
  [{ kind: "half", rotation: 270 }],
  [{ kind: "straight", rotation: 90 }],
  [{ kind: "corner", rotation: 180 }],
  [
    { kind: "straight", rotation: 90 },
    { kind: "half", rotation: 180 },
  ],
  [{ kind: "half", rotation: 0 }],
  [{ kind: "corner", rotation: 0 }],
  [{ kind: "straight", rotation: 0 }],
  [
    { kind: "straight", rotation: 0 },
    { kind: "half", rotation: 90 },
  ],
  [{ kind: "corner", rotation: 270 }],
  [
    { kind: "straight", rotation: 90 },
    { kind: "half", rotation: 0 },
  ],
  [
    { kind: "straight", rotation: 0 },
    { kind: "half", rotation: 270 },
  ],
  [
    { kind: "straight", rotation: 0 },
    { kind: "half", rotation: 90 },
    { kind: "half", rotation: 270 },
  ],
];

function drawTracks(
  g: SolidGeometry,
  sprites: number[],
  state: GameState,
): void {
  const trackKeys = new Set(
    state.map.tiles
      .filter((tile) => tile.hasTrack === true)
      .map((tile) => `${tile.x},${tile.y}`),
  );
  if (trackKeys.size === 0) return;

  for (const tile of state.map.tiles) {
    if (tile.hasTrack !== true) continue;
    const tileCenter = center(tile);
    let mask = 0;
    for (const [index, { offset }] of CARDINAL_OFFSETS.entries()) {
      if (trackKeys.has(`${tile.x + offset.x},${tile.y + offset.y}`))
        mask |= 1 << index;
    }
    if (mask === 0) {
      // Canvas strokes an arc (radius 4, lineWidth 4): a ring band 2..6.
      g.ring(tileCenter, 4 + TRACK_WIDTH / 2, TRACK_WIDTH, TRACK);
    }
    for (const piece of TRACK_PIECES[mask]!) {
      const angle = (piece.rotation * Math.PI) / 180;
      const half = piece.kind === "half";
      const shift = half ? tileSize / 4 : 0;
      sprites.push(
        tileCenter.x - Math.cos(angle) * shift,
        tileCenter.y - Math.sin(angle) * shift,
        angle,
        half ? tileSize / 4 : tileSize / 2,
        tileSize / 2,
        (SPRITE_TEXELS_PER_TILE / SPRITE_ATLAS_WIDTH) * (half ? 0.5 : 1),
        SPRITE_TEXELS_PER_TILE / SPRITE_ATLAS_HEIGHT,
        piece.kind === "corner"
          ? TRANSIT_SPRITE_LAYERS.trackCorner
          : TRANSIT_SPRITE_LAYERS.trackStraight,
        1,
        1,
        1,
        1,
        0,
        0,
      );
    }
  }
}

function drawTrees(
  g: SolidGeometry,
  sprites: number[],
  map: GameMap,
  islandKeys: ReadonlySet<string>,
  tileOwners: ReadonlyMap<string, number>,
  transitNodeKeys: ReadonlySet<string>,
): void {
  for (const tile of map.tiles) {
    if (
      tile.kind !== "empty" ||
      tile.area !== undefined ||
      tile.hasTrack === true ||
      tile.roadStructureId !== undefined ||
      islandKeys.has(keyOf(tile)) ||
      tileOwners.has(keyOf(tile)) ||
      transitNodeKeys.has(keyOf(tile))
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
    // The flat canopy fill is gone; the tree sprite draws the tree. The
    // small offset shadow stays.
    g.circle(
      { x: canopy.x + ROOF_SHADOW_OFFSET, y: canopy.y + ROOF_SHADOW_OFFSET },
      radius,
      BUILDING_SHADOW,
      TREE_CANOPY_SEGMENTS,
    );
    const variant = treeSpriteLayer(tileHash(tile.x, tile.y, 5));
    sprites.push(
      canopy.x,
      canopy.y,
      0,
      radius,
      radius,
      SPRITE_TEXELS_PER_TILE / SPRITE_ATLAS_WIDTH,
      SPRITE_TEXELS_PER_TILE / SPRITE_ATLAS_HEIGHT,
      variant,
      1,
      1,
      1,
      1,
      0,
      0,
    );
  }
}

/**
 * Tessellates the structural map scene — tile fills/grid, vacant-lot
 * perimeters, tree shadows, curbs, roads, automatic junctions, roundabouts,
 * isolated-track indicators, and building shadows. Trees, buildings and
 * connected rails emit structural sprite rows. One-way arrows emit as a
 * separate solid range so the host can paint them over the opaque rail art;
 * transit-node markers are emitted separately above routes by transitBatch.
 */
export function buildMapBatch(
  state: GameState,
  gridMode: GridMode = "normal",
): {
  vertices: Float32Array<ArrayBuffer>;
  directionArrows: Float32Array<ArrayBuffer>;
  sprites: Float32Array<ArrayBuffer>;
} {
  const g = new SolidGeometry();
  const arrows = new SolidGeometry();
  const sprites: number[] = [];
  const islandKeys = protectedIslandKeys(state);
  const tileOwners = occupiedTileOwners(state);
  const transitNodeKeys = new Set(
    [...state.transit.stops, ...state.transit.stations]
      .filter((node) => node.status === "present")
      .map((node) => keyOf(node.position)),
  );
  const tileByKey = new Map(state.map.tiles.map((tile) => [keyOf(tile), tile]));

  const roadTiles: Tile[] = [];
  for (const tile of state.map.tiles) {
    const color = tileFillColor(state.map, tile, islandKeys, tileOwners);
    if (color === ROAD_FILL) {
      roadTiles.push(tile);
    } else {
      fillTileRect(g, tile, color);
    }
  }
  // Emit all opaque road tiles consecutively so Canvas2D fills connected
  // roads in one path instead of leaving AA seams across row-major runs.
  for (const tile of roadTiles) {
    fillTileRect(g, tile, ROAD_FILL);
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

  drawLotPerimeters(g, state.map, tileByKey, tileOwners);
  drawTrees(g, sprites, state.map, islandKeys, tileOwners, transitNodeKeys);

  // Trees precede buildings; transit nodes use the later marker range.
  for (const building of state.buildings) {
    const layer = spriteLayerFor(building.type);
    if (layer === undefined) continue;
    const definition = BUILDING_CATALOG[building.type];
    // Center of the rotated occupied footprint, but the half-extents and
    // uv scale stay the unrotated native footprint: the shader's rotation
    // handles orientation, so extents must not be swapped here too.
    const rotated = getRotatedFootprintSize(building.type, building.rotation);
    const sourceWidth = definition.width * SPRITE_TEXELS_PER_TILE;
    const sourceHeight = definition.height * SPRITE_TEXELS_PER_TILE;
    sprites.push(
      (building.origin.x + rotated.width / 2) * tileSize,
      (building.origin.y + rotated.height / 2) * tileSize,
      (building.rotation * Math.PI) / 180,
      (definition.width * tileSize) / 2,
      (definition.height * tileSize) / 2,
      sourceWidth / SPRITE_ATLAS_WIDTH,
      sourceHeight / SPRITE_ATLAS_HEIGHT,
      layer,
      1,
      1,
      1,
      1,
      0,
      0,
    );
  }

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

  drawTracks(g, sprites, state);

  for (const tile of state.map.tiles) {
    if (tile.kind === "road" && tile.oneWay !== undefined) {
      directionArrow(arrows, tile, tile.oneWay, ONE_WAY_ARROW);
    }
  }

  // One footprint shadow per sprite-bearing building (rotated size, same
  // +3/+3 offset as before). Flat roofs and outlines are gone — the textured
  // sprite pass draws the buildings — and busStop/metroStation are skipped
  // entirely: transitBatch markers stay alone over terrain.
  for (const building of state.buildings) {
    if (spriteLayerFor(building.type) === undefined) continue;
    const rotated = getRotatedFootprintSize(building.type, building.rotation);
    g.rect(
      building.origin.x * tileSize + ROOF_SHADOW_OFFSET,
      building.origin.y * tileSize + ROOF_SHADOW_OFFSET,
      rotated.width * tileSize,
      rotated.height * tileSize,
      BUILDING_SHADOW,
    );
  }

  return {
    vertices: g.toFloat32Array(),
    directionArrows: arrows.toFloat32Array(),
    sprites: new Float32Array(sprites) as Float32Array<ArrayBuffer>,
  };
}
