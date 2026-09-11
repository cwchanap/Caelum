import type {
  BuildingType,
  GameState,
  Heading,
  Point,
  Tile,
} from "../../domain/types";
import { ROAD_DIRECTION_OFFSET } from "../../domain/types";
import { tileSize } from "../boardTransform";
import { areaColors, colors } from "../colors";
import { roundaboutVisualTemplate } from "../roundaboutRenderer";
import { SolidGeometry, parseColor, toPixelGeometry } from "./primitives";

// Stroke weights mirror the Canvas renderers this batch replaces.
const GRID_WIDTH = 1;
const ROAD_STROKE_WIDTH = 4;
const ROUNDABOUT_STROKE_WIDTH = 5;
const TRACK_WIDTH = 4;
const ONE_WAY_ARROW_WIDTH = 2;
const BUILDING_OUTLINE_WIDTH = 2;
const BUILDING_OUTLINE_COLOR = "rgba(17, 24, 32, 0.45)";

const GRID = parseColor(colors.grid);
const ROAD_FILL = parseColor(colors.road);
const EMPTY_FILL = parseColor(colors.empty);
const CENTERLINE = parseColor(colors.roadCenterline);
const TRACK = parseColor(colors.track);
const ONE_WAY_ARROW = parseColor(colors.oneWayArrow);
const ROUNDABOUT_ISLAND = parseColor(colors.roundaboutIsland);
const BUILDING_OUTLINE = parseColor(BUILDING_OUTLINE_COLOR);

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

/** Tessellates a canvas-style strokeRect (lineWidth centered on the path). */
function strokeRect(
  g: SolidGeometry,
  x: number,
  y: number,
  width: number,
  height: number,
  thickness: number,
  color: ReturnType<typeof parseColor>,
): void {
  g.thickLine({ x, y }, { x: x + width, y }, thickness, color);
  g.thickLine(
    { x: x + width, y },
    { x: x + width, y: y + height },
    thickness,
    color,
  );
  g.thickLine(
    { x: x + width, y: y + height },
    { x, y: y + height },
    thickness,
    color,
  );
  g.thickLine({ x, y: y + height }, { x, y }, thickness, color);
}

function fillTileRect(
  g: SolidGeometry,
  tile: Point,
  color: ReturnType<typeof parseColor>,
): void {
  g.rect(tile.x * tileSize, tile.y * tileSize, tileSize, tileSize, color);
}

function strokeTileRect(
  g: SolidGeometry,
  tile: Point,
  thickness: number,
  color: ReturnType<typeof parseColor>,
): void {
  strokeRect(
    g,
    tile.x * tileSize,
    tile.y * tileSize,
    tileSize,
    tileSize,
    thickness,
    color,
  );
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

function tileFillColor(
  tile: Tile,
  islandKeys: ReadonlySet<string>,
): ReturnType<typeof parseColor> {
  if (islandKeys.has(`${tile.x},${tile.y}`)) return EMPTY_FILL;
  if (tile.kind === "empty" && tile.area !== undefined) {
    return parseColor(areaColors[tile.area]);
  }
  return tile.kind === "road" ? ROAD_FILL : EMPTY_FILL;
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
      g.thickLine(
        tileCenter,
        {
          x: tileCenter.x + (offset.x * tileSize) / 2,
          y: tileCenter.y + (offset.y * tileSize) / 2,
        },
        TRACK_WIDTH,
        TRACK,
      );
    }
    if (!connected) {
      // Canvas strokes an arc (radius 4, lineWidth 4): a ring band 2..6.
      g.ring(tileCenter, 4 + TRACK_WIDTH / 2, TRACK_WIDTH, TRACK);
    }
  }
}

/**
 * Tessellates the structural map scene — tile fills/grid, buildings, roads,
 * automatic junctions, roundabouts, track, and one-way arrows — in the same
 * painter order as renderMap + renderBuildings. Output is a solid triangle
 * vertex buffer in world pixels (tileSize grid), cached under `scene:<rev>`.
 */
export function buildMapBatch(state: GameState): Float32Array<ArrayBuffer> {
  const g = new SolidGeometry();
  const islandKeys = protectedIslandKeys(state);

  for (const tile of state.map.tiles) {
    fillTileRect(g, tile, tileFillColor(tile, islandKeys));
    strokeTileRect(g, tile, GRID_WIDTH, GRID);
  }

  const structureKinds = new Map(
    state.map.roadStructures.map((structure) => [structure.id, structure.kind]),
  );
  for (const tile of state.map.tiles) {
    if (tile.kind !== "road") continue;
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
      fillTileRect(g, tile, fill);
      strokeTileRect(g, tile, BUILDING_OUTLINE_WIDTH, BUILDING_OUTLINE);
    }
  }

  return g.toFloat32Array();
}
