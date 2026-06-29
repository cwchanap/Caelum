import { describe, expect, it, vi } from "vitest";
import { renderOverlays } from "../../src/render/overlayRenderer";
import { createTestGameState } from "../helpers/gameState";
import { createUiState } from "../../src/ui/uiState";
import type { ActiveTrip, Citizen, Stop } from "../../src/domain/types";
import { axisLockedLine } from "../../src/ui/roadDrag";
import { colors } from "../../src/render/colors";
import { tileSize } from "../../src/render/canvas";
import { withRoads } from "../helpers/mapFixtures";

function fakeCtx() {
  return {
    save: vi.fn(),
    restore: vi.fn(),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    globalAlpha: 1,
  } as unknown as CanvasRenderingContext2D;
}

const stop: Stop = {
  id: "stop-001",
  kind: "busStop",
  position: { x: 3, y: 3 },
  platforms: [
    { id: "stop-001-p0", label: "A", capacity: 1, routeIds: ["route-001"] },
  ],
};

function waiter(): Citizen {
  return {
    id: "c1",
    home: { x: 3, y: 3 },
    destination: { x: 9, y: 9 },
    position: { x: 3, y: 3 },
    status: "waiting",
    patienceRemaining: 100,
    deadline: 9_999,
    routePlan: {
      estimatedSeconds: 100,
      legs: [
        {
          mode: "bus",
          from: { x: 3, y: 3 },
          to: { x: 9, y: 9 },
          lineId: "route-001",
        },
      ],
    },
    currentLegIndex: 0,
  };
}

function crowdingState(citizens: Citizen[]) {
  return {
    ...createTestGameState(),
    transit: {
      stops: [stop],
      stations: [],
      routes: [],
      metroLines: [],
      vehicles: [],
    },
    citizens,
  };
}

function withBuildingAt(
  state: ReturnType<typeof createTestGameState>,
  points: Array<{ x: number; y: number }>,
) {
  return {
    ...state,
    buildings: [
      ...state.buildings,
      {
        id: "building-001",
        type: "smallHouse" as const,
        origin: points[0] ?? { x: 0, y: 0 },
        rotation: 0 as const,
        occupiedTiles: points,
      },
    ],
  };
}

describe("crowding overlay", () => {
  it("fills a node tile when a platform is at capacity", () => {
    const state = crowdingState([waiter()]);
    const ui = { ...createUiState(), activeOverlay: "crowding" as const };

    const ctx = fakeCtx();
    renderOverlays(ctx, state, ui);

    expect(ctx.fillRect as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
      3 * 32,
      3 * 32,
      32,
      32,
    );
  });

  it("does not fill a node tile when no citizens are waiting", () => {
    const state = crowdingState([]);
    const ui = { ...createUiState(), activeOverlay: "crowding" as const };

    const ctx = fakeCtx();
    renderOverlays(ctx, state, ui);

    expect(ctx.fillRect as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });
});

function activeTrip(
  status: ActiveTrip["status"],
  position: { x: number; y: number },
  destination: { x: number; y: number },
): ActiveTrip {
  return {
    id: `trip-${status}`,
    simId: "sim-001",
    purpose: "commuteOutbound",
    origin: { x: 0, y: 0 },
    destination,
    position,
    status,
    deadline: 9_999,
    routePlan: null,
    currentLegIndex: 0,
    patienceRemaining: 100,
  };
}

describe("Rust trip overlays", () => {
  it("renders demand from active trip destinations when citizens are absent", () => {
    const state = {
      ...createTestGameState(),
      citizens: [],
      activeTrips: [activeTrip("walking", { x: 2, y: 2 }, { x: 9, y: 4 })],
    };
    const ui = { ...createUiState(), activeOverlay: "demand" as const };

    const ctx = fakeCtx();
    renderOverlays(ctx, state, ui);

    expect(ctx.fillRect as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
      9 * tileSize,
      4 * tileSize,
      tileSize,
      tileSize,
    );
  });

  it("renders lateness from late and unserved active trips when citizens are absent", () => {
    const state = {
      ...createTestGameState(),
      citizens: [],
      activeTrips: [
        activeTrip("late", { x: 2, y: 2 }, { x: 9, y: 4 }),
        activeTrip("unserved", { x: 3, y: 2 }, { x: 10, y: 4 }),
        activeTrip("walking", { x: 4, y: 2 }, { x: 11, y: 4 }),
      ],
    };
    const ui = { ...createUiState(), activeOverlay: "lateness" as const };

    const ctx = fakeCtx();
    renderOverlays(ctx, state, ui);

    expect(ctx.fillRect as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
      2 * tileSize,
      2 * tileSize,
      tileSize,
      tileSize,
    );
    expect(ctx.fillRect as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
      3 * tileSize,
      2 * tileSize,
      tileSize,
      tileSize,
    );
    expect(ctx.fillRect as ReturnType<typeof vi.fn>).not.toHaveBeenCalledWith(
      4 * tileSize,
      2 * tileSize,
      tileSize,
      tileSize,
    );
  });
});

function dragCtx() {
  return {
    save: vi.fn(),
    restore: vi.fn(),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    lineCap: "",
    lineJoin: "",
    globalAlpha: 1,
  } as unknown as CanvasRenderingContext2D;
}

// Records fillStyle/strokeStyle assignments so per-tile tints can be asserted.
function recordingFillCtx() {
  const fillStyles: string[] = [];
  const ctx = {
    save: vi.fn(),
    restore: vi.fn(),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    set fillStyle(v: string) {
      fillStyles.push(v);
    },
    get fillStyle() {
      return fillStyles.at(-1) ?? "";
    },
    strokeStyle: "",
    lineWidth: 0,
    lineCap: "",
    lineJoin: "",
    globalAlpha: 1,
  } as unknown as CanvasRenderingContext2D;
  return { ctx, fillStyles };
}

// Records canvas path tokens to derive each arrow shaft's direction vector.
// A shaft is a moveTo->lineTo pair whose displacement is large (>= tile/4); the
// chevron barbs are smaller and filtered out. This makes the test fail if the
// arrow is ever drawn pointing the wrong way, not merely on a stroke count.
function pathRecorderCtx() {
  const tokens: Array<{ t: "M" | "L"; x: number; y: number }> = [];
  const ctx = {
    save: vi.fn(),
    restore: vi.fn(),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn((x: number, y: number) => tokens.push({ t: "M", x, y })),
    lineTo: vi.fn((x: number, y: number) => tokens.push({ t: "L", x, y })),
    stroke: vi.fn(),
    fill: vi.fn(),
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    lineCap: "",
    lineJoin: "",
    globalAlpha: 1,
  } as unknown as CanvasRenderingContext2D;
  return { ctx, tokens };
}

function shaftDeltas(
  tokens: Array<{ t: "M" | "L"; x: number; y: number }>,
): Array<{ dx: number; dy: number }> {
  const out: Array<{ dx: number; dy: number }> = [];
  for (let i = 1; i < tokens.length; i += 1) {
    if (tokens[i].t === "L" && tokens[i - 1].t === "M") {
      const dx = tokens[i].x - tokens[i - 1].x;
      const dy = tokens[i].y - tokens[i - 1].y;
      // tileSize/2 == 16 for a full shaft; chevron barbs are ~7.5.
      if (Math.max(Math.abs(dx), Math.abs(dy)) >= 10) {
        out.push({ dx, dy });
      }
    }
  }
  return out;
}

// Captures the strokeStyle value in effect at each stroke() call. Only
// drawDirectionArrow calls stroke() (the per-tile loop uses strokeRect), so
// this records exactly the colors used for arrow shafts + chevron barbs.
function arrowStrokeColorCtx() {
  let currentStrokeStyle = "";
  const strokeStylesAtStroke: string[] = [];
  const ctx = {
    save: vi.fn(),
    restore: vi.fn(),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(() => {
      strokeStylesAtStroke.push(currentStrokeStyle);
    }),
    fill: vi.fn(),
    fillStyle: "",
    set strokeStyle(v: string) {
      currentStrokeStyle = v;
    },
    get strokeStyle() {
      return currentStrokeStyle;
    },
    lineWidth: 0,
    lineCap: "",
    lineJoin: "",
    globalAlpha: 1,
  } as unknown as CanvasRenderingContext2D;
  return { ctx, strokeStylesAtStroke };
}

describe("renderOverlays drag preview", () => {
  const drag = (
    tool: "road" | "track" | "remove",
    start: { x: number; y: number },
    current: { x: number; y: number },
  ) => ({ tool, start, current });
  const areaDrag = (
    area: "residential" | "commercial",
    start: { x: number; y: number },
    current: { x: number; y: number },
  ) => ({ tool: "area" as const, area, start, current });

  it("fills each tile of a road drag line with the build (green) tint", () => {
    const ctx = dragCtx();
    const state = createTestGameState();
    const ui = {
      ...createUiState(),
      activeTool: "road" as const,
      roadPreset: "twoWay" as const,
      drag: drag("road", { x: 1, y: 0 }, { x: 4, y: 0 }),
    };
    renderOverlays(ctx, state, ui);
    const line = axisLockedLine(ui.drag.start, ui.drag.current);
    expect(
      (ctx.fillRect as unknown as { mock: { calls: unknown[] } }).mock.calls
        .length,
    ).toBeGreaterThanOrEqual(line.length);
    expect(ctx.fillStyle).toBe(colors.previewValid);
  });

  it("uses the delete (red) tint for a remove drag line", () => {
    const ctx = dragCtx();
    const state = createTestGameState();
    const ui = {
      ...createUiState(),
      activeTool: "remove" as const,
      drag: drag("remove", { x: 1, y: 0 }, { x: 3, y: 0 }),
    };
    renderOverlays(ctx, state, ui);
    expect(ctx.fillStyle).toBe(colors.previewInvalid);
  });

  it("previews an area drag as a full rectangle", () => {
    const ctx = dragCtx();
    const state = createTestGameState();
    const ui = {
      ...createUiState(),
      activeTool: "area" as const,
      selectedArea: "residential" as const,
      drag: areaDrag("residential", { x: 1, y: 1 }, { x: 2, y: 2 }),
    };

    renderOverlays(ctx, state, ui);

    expect(ctx.fillRect).toHaveBeenCalledWith(
      1 * tileSize,
      1 * tileSize,
      tileSize,
      tileSize,
    );
    expect(ctx.fillRect).toHaveBeenCalledWith(
      2 * tileSize,
      1 * tileSize,
      tileSize,
      tileSize,
    );
    expect(ctx.fillRect).toHaveBeenCalledWith(
      1 * tileSize,
      2 * tileSize,
      tileSize,
      tileSize,
    );
    expect(ctx.fillRect).toHaveBeenCalledWith(
      2 * tileSize,
      2 * tileSize,
      tileSize,
      tileSize,
    );
  });

  it("tints area preview tiles by paintability", () => {
    const { ctx, fillStyles } = recordingFillCtx();
    const state = withRoads(createTestGameState(), [{ x: 2, y: 2 }]);
    const ui = {
      ...createUiState(),
      activeTool: "area" as const,
      selectedArea: "commercial" as const,
      drag: areaDrag("commercial", { x: 1, y: 1 }, { x: 2, y: 2 }),
    };

    renderOverlays(ctx, state, ui);

    expect(fillStyles).toContain(colors.previewValid);
    expect(fillStyles).toContain(colors.previewInvalid);
  });

  it("previews both lanes for the dual-bidirectional preset", () => {
    const ctx = dragCtx();
    const state = createTestGameState();
    const ui = {
      ...createUiState(),
      activeTool: "road" as const,
      roadPreset: "dualBidirectional" as const,
      drag: drag("road", { x: 1, y: 1 }, { x: 4, y: 1 }),
    };
    renderOverlays(ctx, state, ui);
    expect(
      (ctx.fillRect as unknown as { mock: { calls: unknown[] } }).mock.calls
        .length,
    ).toBeGreaterThanOrEqual(8);
  });

  it("tints per-tile: valid where placeable, invalid where blocked", () => {
    const { ctx, fillStyles } = recordingFillCtx();
    const state = withBuildingAt(createTestGameState(), [{ x: 3, y: 3 }]);
    const ui = {
      ...createUiState(),
      activeTool: "road" as const,
      roadPreset: "twoWay" as const,
      drag: drag("road", { x: 1, y: 3 }, { x: 3, y: 3 }),
    };
    renderOverlays(ctx, state, ui);
    expect(fillStyles).toContain(colors.previewValid);
    expect(fillStyles).toContain(colors.previewInvalid);
  });

  it("draws one-way arrows pointing along the drag axis (east)", () => {
    const { ctx, tokens } = pathRecorderCtx();
    const state = createTestGameState();
    const ui = {
      ...createUiState(),
      activeTool: "road" as const,
      roadPreset: "oneWay" as const,
      drag: drag("road", { x: 1, y: 0 }, { x: 4, y: 0 }),
    };
    renderOverlays(ctx, state, ui);
    const line = axisLockedLine(ui.drag.start, ui.drag.current);
    const shafts = shaftDeltas(tokens);
    // One shaft per tile, every shaft pointing east (positive x, ~0 y).
    expect(shafts).toHaveLength(line.length);
    expect(shafts.every((s) => s.dx > 0 && Math.abs(s.dy) < 1)).toBe(true);
    expect(ctx.lineCap).toBe("round");
    expect(ctx.lineJoin).toBe("round");
  });

  it("draws opposing arrows on both lanes of a dual-bidirectional drag", () => {
    const { ctx, tokens } = pathRecorderCtx();
    const state = createTestGameState();
    const ui = {
      ...createUiState(),
      activeTool: "road" as const,
      roadPreset: "dualBidirectional" as const,
      drag: drag("road", { x: 1, y: 0 }, { x: 4, y: 0 }),
    };
    renderOverlays(ctx, state, ui);
    const line = axisLockedLine(ui.drag.start, ui.drag.current);
    const shafts = shaftDeltas(tokens);
    // Forward lane points east, reverse lane points west — half each.
    expect(shafts).toHaveLength(2 * line.length);
    const eastbound = shafts.filter((s) => s.dx > 0);
    const westbound = shafts.filter((s) => s.dx < 0);
    expect(eastbound).toHaveLength(line.length);
    expect(westbound).toHaveLength(line.length);
  });

  it("draws no direction arrows for a two-way road drag", () => {
    const ctx = dragCtx();
    const state = createTestGameState();
    const ui = {
      ...createUiState(),
      activeTool: "road" as const,
      roadPreset: "twoWay" as const,
      drag: drag("road", { x: 1, y: 0 }, { x: 4, y: 0 }),
    };
    renderOverlays(ctx, state, ui);
    expect(ctx.stroke as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("draws no direction arrows for a remove drag", () => {
    const ctx = dragCtx();
    const state = createTestGameState();
    const ui = {
      ...createUiState(),
      activeTool: "remove" as const,
      drag: drag("remove", { x: 1, y: 0 }, { x: 3, y: 0 }),
    };
    renderOverlays(ctx, state, ui);
    expect(ctx.stroke as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("renders one-way arrows in the stable arrow color even when the line's last tile is invalid", () => {
    const { ctx, strokeStylesAtStroke } = arrowStrokeColorCtx();
    const state = withBuildingAt(createTestGameState(), [{ x: 3, y: 3 }]);
    // The last forward tile is invalid, so without an explicit strokeStyle the
    // arrows would inherit the red previewInvalidStroke from the per-tile loop.
    const ui = {
      ...createUiState(),
      activeTool: "road" as const,
      roadPreset: "oneWay" as const,
      drag: drag("road", { x: 1, y: 3 }, { x: 3, y: 3 }),
    };
    renderOverlays(ctx, state, ui);
    expect(strokeStylesAtStroke.length).toBeGreaterThan(0);
    expect(strokeStylesAtStroke.every((c) => c === colors.oneWayArrow)).toBe(
      true,
    );
  });

  it("renders dual-bidirectional arrows in the stable arrow color even when the line's last tile is invalid", () => {
    const { ctx, strokeStylesAtStroke } = arrowStrokeColorCtx();
    const state = withBuildingAt(createTestGameState(), [{ x: 3, y: 3 }]);
    const ui = {
      ...createUiState(),
      activeTool: "road" as const,
      roadPreset: "dualBidirectional" as const,
      drag: drag("road", { x: 1, y: 3 }, { x: 3, y: 3 }),
    };
    renderOverlays(ctx, state, ui);
    expect(strokeStylesAtStroke.length).toBeGreaterThan(0);
    expect(strokeStylesAtStroke.every((c) => c === colors.oneWayArrow)).toBe(
      true,
    );
  });
});
