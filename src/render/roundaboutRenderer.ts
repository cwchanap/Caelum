import type {
  PathGeometry,
  RoadPort,
  RoadStructure,
  TripPosition,
} from "../domain/types";
import { colors } from "./colors";
import { drawPathGeometry } from "./pathRenderer";

type RoundaboutStructure = Extract<RoadStructure, { kind: "roundabout" }>;

export interface TileMetrics {
  tileSize: number;
  tileToPixel: (point: TripPosition) => TripPosition;
}

export interface RoundaboutVisualTemplate {
  circulationCurves: PathGeometry[];
  protectedIslands: TripPosition[];
}

export function roundaboutVisualTemplate(
  structure: RoundaboutStructure,
): RoundaboutVisualTemplate {
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

function drawPortStubAndEntryMarking(
  ctx: CanvasRenderingContext2D,
  port: RoadPort,
  metrics: TileMetrics,
): void {
  const center = metrics.tileToPixel(port.point);
  const halfTile = metrics.tileSize / 2;
  const endpoint = {
    x:
      center.x +
      (port.edge === "east" ? halfTile : port.edge === "west" ? -halfTile : 0),
    y:
      center.y +
      (port.edge === "south"
        ? halfTile
        : port.edge === "north"
          ? -halfTile
          : 0),
  };
  ctx.beginPath();
  ctx.moveTo(center.x, center.y);
  ctx.lineTo(endpoint.x, endpoint.y);
  ctx.stroke();

  const marker = {
    x: center.x + (endpoint.x - center.x) * 0.7,
    y: center.y + (endpoint.y - center.y) * 0.7,
  };
  const markerLength = metrics.tileSize / 4;
  const markerThickness = 2;
  if (port.edge === "north" || port.edge === "south") {
    ctx.fillRect(
      marker.x - markerLength / 2,
      marker.y - markerThickness / 2,
      markerLength,
      markerThickness,
    );
  } else {
    ctx.fillRect(
      marker.x - markerThickness / 2,
      marker.y - markerLength / 2,
      markerThickness,
      markerLength,
    );
  }
}

function drawProtectedIsland(
  ctx: CanvasRenderingContext2D,
  island: TripPosition,
  metrics: TileMetrics,
): void {
  const center = metrics.tileToPixel(island);
  ctx.beginPath();
  ctx.arc(center.x, center.y, metrics.tileSize * 0.3, 0, Math.PI * 2);
  ctx.fill();
}

export function renderRoundabout(
  ctx: CanvasRenderingContext2D,
  structure: RoundaboutStructure,
  metrics: TileMetrics,
): void {
  const template = roundaboutVisualTemplate(structure);
  ctx.save();
  ctx.strokeStyle = colors.roadCenterline;
  ctx.fillStyle = colors.roundaboutIsland;
  ctx.lineWidth = 5;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const curve of template.circulationCurves) {
    ctx.beginPath();
    drawPathGeometry(ctx, curve, metrics.tileToPixel);
    ctx.stroke();
  }
  ctx.fillStyle = colors.roadCenterline;
  for (const port of structure.ports) {
    drawPortStubAndEntryMarking(ctx, port, metrics);
  }
  ctx.fillStyle = colors.roundaboutIsland;
  for (const island of template.protectedIslands) {
    drawProtectedIsland(ctx, island, metrics);
  }
  ctx.restore();
}
