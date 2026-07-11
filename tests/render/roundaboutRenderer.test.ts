import { describe, expect, it, vi } from "vitest";
import type { Point, RoadStructure } from "../../src/domain/types";
import {
  renderRoundabout,
  type TileMetrics,
} from "../../src/render/roundaboutRenderer";

function footprint(origin: Point, size: number): Point[] {
  return Array.from({ length: size * size }, (_, index) => ({
    x: origin.x + (index % size),
    y: origin.y + Math.floor(index / size),
  }));
}

function compactRoundaboutFixture(): Extract<
  RoadStructure,
  { kind: "roundabout" }
> {
  const origin = { x: 5, y: 5 };
  return {
    kind: "roundabout",
    id: "roundabout-compact",
    origin,
    size: "compact2x2",
    footprint: footprint(origin, 2),
    ports: [
      { id: "north", point: { x: 5, y: 5 }, edge: "north" },
      { id: "east", point: { x: 6, y: 5 }, edge: "east" },
      { id: "south", point: { x: 6, y: 6 }, edge: "south" },
      { id: "west", point: { x: 5, y: 6 }, edge: "west" },
    ],
  };
}

function standardRoundaboutFixture(): Extract<
  RoadStructure,
  { kind: "roundabout" }
> {
  const origin = { x: 5, y: 5 };
  return {
    kind: "roundabout",
    id: "roundabout-standard",
    origin,
    size: "standard3x3",
    footprint: footprint(origin, 3),
    ports: [
      { id: "north", point: { x: 6, y: 5 }, edge: "north" },
      { id: "east", point: { x: 7, y: 6 }, edge: "east" },
      { id: "south", point: { x: 6, y: 7 }, edge: "south" },
      { id: "west", point: { x: 5, y: 6 }, edge: "west" },
    ],
  };
}

function metrics(): TileMetrics {
  return {
    tileSize: 32,
    tileToPixel: (point) => ({
      x: point.x * 32 + 16,
      y: point.y * 32 + 16,
    }),
  };
}

function recordingContext() {
  const context = {
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    arc: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    fillRect: vi.fn(),
    setLineDash: vi.fn(),
    strokeStyle: "",
    fillStyle: "",
    lineWidth: 0,
    lineCap: "butt",
    lineJoin: "miter",
  } as unknown as CanvasRenderingContext2D;
  return context;
}

describe("renderRoundabout", () => {
  it("draws four compact curves and no center island", () => {
    const context = recordingContext();
    const structure = compactRoundaboutFixture();

    renderRoundabout(context, structure, metrics());

    expect(context.arc).toHaveBeenCalledTimes(4);
    expect(context.fill).not.toHaveBeenCalled();
    expect(context.lineTo).toHaveBeenCalledTimes(structure.ports.length);
    expect(context.fillRect).toHaveBeenCalledTimes(structure.ports.length);
  });

  it("draws eight standard curves and one protected center island", () => {
    const context = recordingContext();

    renderRoundabout(context, standardRoundaboutFixture(), metrics());

    expect(context.arc).toHaveBeenCalledTimes(9);
    expect(context.fill).toHaveBeenCalledTimes(1);
    expect(context.arc).toHaveBeenLastCalledWith(
      6.5 * 32,
      6.5 * 32,
      expect.any(Number),
      0,
      Math.PI * 2,
    );
  });
});
