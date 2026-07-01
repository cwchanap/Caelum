import { describe, expect, it, vi } from "vitest";
import { renderOverlays } from "../../src/render/overlayRenderer";
import { createTestGameState } from "../helpers/gameState";
import { createUiState } from "../../src/ui/uiState";
import type { ActiveTrip, Stop } from "../../src/domain/types";
import { axisLockedLine, reverseLanePoints } from "../../src/ui/roadDrag";
import { colors } from "../../src/render/colors";
import { tileSize } from "../../src/render/canvas";
import { withAreas, withRoads } from "../helpers/mapFixtures";

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

function waiter(): ActiveTrip {
  return {
    id: "c1",
    simId: "sim-c1",
    purpose: "commuteOutbound",
    origin: { x: 3, y: 3 },
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

function crowdingState(activeTrips: ActiveTrip[]) {
  return {
    ...createTestGameState(),
    transit: {
      stops: [stop],
      stations: [],
      routes: [],
      metroLines: [],
      vehicles: [],
    },
    activeTrips,
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

  it("does not fill a node tile when no trips are waiting", () => {
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

// Like shaftDeltas but also records the tile each shaft is centered on, so a
// test can assert which lane carries which direction — not just that both
// directions appear somewhere on the canvas.
function shaftsByTile(
  tokens: Array<{ t: "M" | "L"; x: number; y: number }>,
): Array<{ tile: { x: number; y: number }; dx: number; dy: number }> {
  const out: Array<{ tile: { x: number; y: number }; dx: number; dy: number }> =
    [];
  for (let i = 1; i < tokens.length; i += 1) {
    if (tokens[i].t === "L" && tokens[i - 1].t === "M") {
      const dx = tokens[i].x - tokens[i - 1].x;
      const dy = tokens[i].y - tokens[i - 1].y;
      if (Math.max(Math.abs(dx), Math.abs(dy)) >= 10) {
        const midX = (tokens[i].x + tokens[i - 1].x) / 2;
        const midY = (tokens[i].y + tokens[i - 1].y) / 2;
        out.push({
          tile: {
            x: Math.round((midX - tileSize / 2) / tileSize),
            y: Math.round((midY - tileSize / 2) / tileSize),
          },
          dx,
          dy,
        });
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

  it("uses canonical (east/south) arrows for dual-bidirectional regardless of drag direction", () => {
    // The Rust `lay_road_line` commits the primary lane with the canonical
    // axis direction (east for horizontal, south for vertical) and the reverse
    // lane with its opposite — independent of drag order. The preview arrows
    // must match the commit, so a westward or northward drag must still show
    // eastbound/southbound primary arrows on the drag-line tiles and the
    // opposing arrows on the reverse-lane tiles. Dragging the wrong way
    // previously flipped both carriageways' arrow directions.
    const state = createTestGameState();

    const westUi = {
      ...createUiState(),
      activeTool: "road" as const,
      roadPreset: "dualBidirectional" as const,
      drag: drag("road", { x: 4, y: 0 }, { x: 1, y: 0 }),
    };
    const westCtx = pathRecorderCtx();
    renderOverlays(westCtx.ctx, state, westUi);
    const westLine = axisLockedLine(westUi.drag.start, westUi.drag.current);
    const westReverse = reverseLanePoints(westLine);
    const westShafts = shaftsByTile(westCtx.tokens);
    expect(westShafts).toHaveLength(2 * westLine.length);
    // Primary lane tiles (y=0) carry eastbound arrows (canonical east).
    const westPrimary = westShafts.filter((s) => s.tile.y === 0);
    expect(westPrimary).toHaveLength(westLine.length);
    expect(westPrimary.every((s) => s.dx > 0 && Math.abs(s.dy) < 1)).toBe(true);
    // Reverse lane tiles (y=-1) carry westbound arrows (opposite of canonical).
    const westReverseShafts = westShafts.filter((s) => s.tile.y === -1);
    expect(westReverseShafts).toHaveLength(westReverse.length);
    expect(westReverseShafts.every((s) => s.dx < 0 && Math.abs(s.dy) < 1)).toBe(
      true,
    );

    const northUi = {
      ...createUiState(),
      activeTool: "road" as const,
      roadPreset: "dualBidirectional" as const,
      drag: drag("road", { x: 0, y: 4 }, { x: 0, y: 1 }),
    };
    const northCtx = pathRecorderCtx();
    renderOverlays(northCtx.ctx, state, northUi);
    const northLine = axisLockedLine(northUi.drag.start, northUi.drag.current);
    const northReverse = reverseLanePoints(northLine);
    const northShafts = shaftsByTile(northCtx.tokens);
    expect(northShafts).toHaveLength(2 * northLine.length);
    // Primary lane (x=0) carries southbound arrows (canonical south).
    const northPrimary = northShafts.filter((s) => s.tile.x === 0);
    expect(northPrimary).toHaveLength(northLine.length);
    expect(northPrimary.every((s) => s.dy > 0 && Math.abs(s.dx) < 1)).toBe(
      true,
    );
    // Reverse lane (x=1) carries northbound arrows (opposite of canonical).
    const northReverseShafts = northShafts.filter((s) => s.tile.x === 1);
    expect(northReverseShafts).toHaveLength(northReverse.length);
    expect(
      northReverseShafts.every((s) => s.dy < 0 && Math.abs(s.dx) < 1),
    ).toBe(true);
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

describe("coverage overlay", () => {
  it("fills coverage areas for stops and stations", () => {
    const ctx = fakeCtx();
    const state = {
      ...createTestGameState(),
      transit: {
        stops: [
          {
            id: "stop-001",
            kind: "busStop" as const,
            position: { x: 5, y: 5 },
            platforms: [],
          },
          {
            id: "stop-002",
            kind: "busTerminal" as const,
            position: { x: 10, y: 10 },
            platforms: [],
          },
        ],
        stations: [
          {
            id: "station-001",
            position: { x: 15, y: 15 },
            platforms: [],
          },
        ],
        routes: [],
        metroLines: [],
        vehicles: [],
      },
    };
    const ui = { ...createUiState(), activeOverlay: "coverage" as const };
    renderOverlays(ctx, state, ui);
    // busStop radius 2 -> (5-2, 5-2) origin, 5x5 box.
    expect(ctx.fillRect).toHaveBeenCalledWith(
      (5 - 2) * tileSize,
      (5 - 2) * tileSize,
      tileSize * 5,
      tileSize * 5,
    );
    // busTerminal radius 4 -> (10-4, 10-4) origin, 9x9 box.
    expect(ctx.fillRect).toHaveBeenCalledWith(
      (10 - 4) * tileSize,
      (10 - 4) * tileSize,
      tileSize * 9,
      tileSize * 9,
    );
    // station radius 4 -> (15-4, 15-4) origin, 9x9 box.
    expect(ctx.fillRect).toHaveBeenCalledWith(
      (15 - 4) * tileSize,
      (15 - 4) * tileSize,
      tileSize * 9,
      tileSize * 9,
    );
  });
});

describe("growth overlay", () => {
  it("fills tiles for unapplied growth waves and skips applied ones", () => {
    const ctx = fakeCtx();
    const state = {
      ...createTestGameState(),
      scenario: {
        ...createTestGameState().scenario,
        growthWaves: [
          {
            id: "wave-001",
            triggerTime: 100,
            message: "Wave 1",
            applied: false,
            tiles: [
              {
                id: "5,5",
                x: 5,
                y: 5,
                area: "residential" as const,
                createsCitizens: 0,
              },
              {
                id: "6,5",
                x: 6,
                y: 5,
                area: "residential" as const,
                createsCitizens: 0,
              },
            ],
          },
          {
            id: "wave-002",
            triggerTime: 200,
            message: "Wave 2",
            applied: true,
            tiles: [
              {
                id: "7,5",
                x: 7,
                y: 5,
                area: "commercial" as const,
                createsCitizens: 0,
              },
            ],
          },
        ],
      },
    };
    const ui = { ...createUiState(), activeOverlay: "growth" as const };
    renderOverlays(ctx, state, ui);
    expect(ctx.fillRect).toHaveBeenCalledWith(
      5 * tileSize,
      5 * tileSize,
      tileSize,
      tileSize,
    );
    expect(ctx.fillRect).toHaveBeenCalledWith(
      6 * tileSize,
      5 * tileSize,
      tileSize,
      tileSize,
    );
    // The applied wave's tile must not be filled.
    expect(ctx.fillRect).not.toHaveBeenCalledWith(
      7 * tileSize,
      5 * tileSize,
      tileSize,
      tileSize,
    );
  });
});

describe("building preview", () => {
  it("renders a valid placement in the valid tint over an empty residential tile", () => {
    const { ctx, fillStyles } = recordingFillCtx();
    let state = createTestGameState();
    const emptyTile = state.map.tiles.find((tile) => tile.kind === "empty");
    if (emptyTile === undefined) {
      throw new Error("expected an empty tile");
    }
    // smallHouse is 2x1; paint the footprint residential.
    state = withAreas(state, "residential", [
      emptyTile,
      { x: emptyTile.x + 1, y: emptyTile.y },
    ]);
    const ui = {
      ...createUiState(),
      selectedBuilding: "smallHouse" as const,
      buildingRotation: 0 as const,
      hoverTile: { x: emptyTile.x, y: emptyTile.y },
    };
    renderOverlays(ctx, state, ui);
    expect(fillStyles).toContain(colors.previewValid);
  });

  it("renders an invalid placement in the invalid tint when budget is insufficient", () => {
    const { ctx, fillStyles } = recordingFillCtx();
    let state = createTestGameState();
    const emptyTile = state.map.tiles.find((tile) => tile.kind === "empty");
    if (emptyTile === undefined) {
      throw new Error("expected an empty tile");
    }
    state = withAreas(state, "residential", [
      emptyTile,
      { x: emptyTile.x + 1, y: emptyTile.y },
    ]);
    state = { ...state, budget: 0 };
    const ui = {
      ...createUiState(),
      selectedBuilding: "smallHouse" as const,
      buildingRotation: 0 as const,
      hoverTile: { x: emptyTile.x, y: emptyTile.y },
    };
    renderOverlays(ctx, state, ui);
    expect(fillStyles).toContain(colors.previewInvalid);
  });

  it("renders an invalid placement when the tile is occupied by a building", () => {
    const { ctx, fillStyles } = recordingFillCtx();
    let state = createTestGameState();
    const emptyTile = state.map.tiles.find((tile) => tile.kind === "empty");
    if (emptyTile === undefined) {
      throw new Error("expected an empty tile");
    }
    state = withAreas(state, "residential", [
      emptyTile,
      { x: emptyTile.x + 1, y: emptyTile.y },
    ]);
    state = withBuildingAt(state, [emptyTile]);
    const ui = {
      ...createUiState(),
      selectedBuilding: "smallHouse" as const,
      buildingRotation: 0 as const,
      hoverTile: { x: emptyTile.x, y: emptyTile.y },
    };
    renderOverlays(ctx, state, ui);
    expect(fillStyles).toContain(colors.previewInvalid);
  });
});

describe("crowding overlay ratios", () => {
  it("uses the lower globalAlpha (0.3) when crowding is between 50% and 100%", () => {
    // capacity 4, 3 waiters -> 75% -> maxRatio in (0.5, 1) -> globalAlpha 0.3.
    const crowdedStop: Stop = {
      id: "stop-001",
      kind: "busStop",
      position: { x: 3, y: 3 },
      platforms: [
        { id: "stop-001-p0", label: "A", capacity: 4, routeIds: ["route-001"] },
      ],
    };
    const state = {
      ...createTestGameState(),
      transit: {
        stops: [crowdedStop],
        stations: [],
        routes: [],
        metroLines: [],
        vehicles: [],
      },
      activeTrips: [waiter(), waiter(), waiter()],
    };
    const ui = { ...createUiState(), activeOverlay: "crowding" as const };
    const ctx = fakeCtx();
    renderOverlays(ctx, state, ui);
    expect(ctx.globalAlpha).toBe(0.3);
    expect(ctx.fillRect).toHaveBeenCalledWith(
      3 * tileSize,
      3 * tileSize,
      tileSize,
      tileSize,
    );
  });

  it("uses the higher globalAlpha (0.55) when crowding is at or above 100%", () => {
    // capacity 1, 2 waiters -> 200% -> maxRatio >= 1 -> globalAlpha 0.55.
    const ctx = fakeCtx();
    const state = crowdingState([waiter(), waiter()]);
    const ui = { ...createUiState(), activeOverlay: "crowding" as const };
    renderOverlays(ctx, state, ui);
    expect(ctx.globalAlpha).toBe(0.55);
  });

  it("does not fill when crowding is at or below 50%", () => {
    // capacity 4, 2 waiters -> 50% -> maxRatio <= 0.5 -> skip.
    const quietStop: Stop = {
      id: "stop-001",
      kind: "busStop",
      position: { x: 3, y: 3 },
      platforms: [
        { id: "stop-001-p0", label: "A", capacity: 4, routeIds: ["route-001"] },
      ],
    };
    const state = {
      ...createTestGameState(),
      transit: {
        stops: [quietStop],
        stations: [],
        routes: [],
        metroLines: [],
        vehicles: [],
      },
      activeTrips: [waiter(), waiter()],
    };
    const ui = { ...createUiState(), activeOverlay: "crowding" as const };
    const ctx = fakeCtx();
    renderOverlays(ctx, state, ui);
    expect(ctx.fillRect).not.toHaveBeenCalled();
  });

  it("uses the max ratio across multiple platforms on a single node", () => {
    // Two platforms: p0 (cap 10, 3 waiters = 30%) and p1 (cap 10, 6 waiters = 60%).
    // maxRatio = 0.6 -> globalAlpha 0.3.
    const multiStop: Stop = {
      id: "stop-001",
      kind: "busTerminal",
      position: { x: 3, y: 3 },
      platforms: [
        {
          id: "stop-001-p0",
          label: "A",
          capacity: 10,
          routeIds: ["route-001"],
        },
        {
          id: "stop-001-p1",
          label: "B",
          capacity: 10,
          routeIds: ["route-002"],
        },
      ],
    };
    const waiterOn = (lineId: string): ActiveTrip => ({
      ...waiter(),
      routePlan: {
        estimatedSeconds: 100,
        legs: [
          { mode: "bus", from: { x: 3, y: 3 }, to: { x: 9, y: 9 }, lineId },
        ],
      },
    });
    const state = {
      ...createTestGameState(),
      transit: {
        stops: [multiStop],
        stations: [],
        routes: [],
        metroLines: [],
        vehicles: [],
      },
      activeTrips: [
        ...Array.from({ length: 3 }, () => waiterOn("route-001")),
        ...Array.from({ length: 6 }, () => waiterOn("route-002")),
      ],
    };
    const ui = { ...createUiState(), activeOverlay: "crowding" as const };
    const ctx = fakeCtx();
    renderOverlays(ctx, state, ui);
    expect(ctx.globalAlpha).toBe(0.3);
    expect(ctx.fillRect).toHaveBeenCalledWith(
      3 * tileSize,
      3 * tileSize,
      tileSize,
      tileSize,
    );
  });
});
