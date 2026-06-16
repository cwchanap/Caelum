import { describe, expect, it, vi } from "vitest";
import { renderOverlays } from "../../src/render/overlayRenderer";
import { createInitialGameState } from "../../src/simulation/gameState";
import { createUiState } from "../../src/ui/uiState";
import type { Citizen, Stop } from "../../src/domain/types";
import { axisLockedLine } from "../../src/ui/roadDrag";
import { colors } from "../../src/render/colors";

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
    ...createInitialGameState(),
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

describe("renderOverlays drag preview", () => {
  it("fills each tile of a road drag line with the build (green) tint", () => {
    const ctx = dragCtx();
    const state = createInitialGameState();
    const ui = {
      ...createUiState(),
      activeTool: "road" as const,
      roadPreset: "twoWay" as const,
      dragStart: { x: 1, y: 0 },
      hoverTile: { x: 4, y: 0 },
    };
    renderOverlays(ctx, state, ui);
    const line = axisLockedLine(ui.dragStart, ui.hoverTile);
    expect((ctx.fillRect as unknown as { mock: { calls: unknown[] } }).mock.calls.length)
      .toBeGreaterThanOrEqual(line.length);
    expect(ctx.fillStyle).toBe(colors.previewValid);
  });

  it("uses the delete (red) tint for a remove drag line", () => {
    const ctx = dragCtx();
    const state = createInitialGameState();
    const ui = {
      ...createUiState(),
      activeTool: "remove" as const,
      dragStart: { x: 1, y: 0 },
      hoverTile: { x: 3, y: 0 },
    };
    renderOverlays(ctx, state, ui);
    expect(ctx.fillStyle).toBe(colors.previewInvalid);
  });

  it("previews both lanes for the dual-bidirectional preset", () => {
    const ctx = dragCtx();
    const state = createInitialGameState();
    const ui = {
      ...createUiState(),
      activeTool: "road" as const,
      roadPreset: "dualBidirectional" as const,
      dragStart: { x: 1, y: 1 },
      hoverTile: { x: 4, y: 1 },
    };
    renderOverlays(ctx, state, ui);
    expect(
      (ctx.fillRect as unknown as { mock: { calls: unknown[] } }).mock.calls
        .length,
    ).toBeGreaterThanOrEqual(8);
  });
});
