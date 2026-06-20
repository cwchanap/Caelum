import { describe, expect, it, vi } from "vitest";
import { renderCursorBadge } from "../../src/render/cursorBadge";
import { getBoardTransform } from "../../src/render/canvas";
import { createInitialGameState } from "../../src/simulation/gameState";
import { createUiState } from "../../src/ui/uiState";

function badgeCtx() {
  const calls: string[] = [];
  const ctx = {
    canvas: { width: 896, height: 576 },
    save: vi.fn(),
    restore: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn((text: string) => calls.push(text)),
    measureText: vi.fn((text: string) => ({ width: text.length * 7 })),
    fillStyle: "",
    font: "",
    textAlign: "",
    textBaseline: "",
  } as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

describe("renderCursorBadge", () => {
  it("draws nothing when there is no hover tile", () => {
    const { ctx, calls } = badgeCtx();
    const state = createInitialGameState();
    renderCursorBadge(
      ctx,
      state,
      createUiState(),
      getBoardTransform(ctx.canvas, state.map),
    );
    expect(calls).toHaveLength(0);
  });

  it("labels the one-way road preset with a direction glyph", () => {
    const { ctx, calls } = badgeCtx();
    const state = createInitialGameState();
    const ui = {
      ...createUiState(),
      activeTool: "road" as const,
      roadPreset: "oneWay" as const,
      hoverTile: { x: 1, y: 0 },
    };
    renderCursorBadge(ctx, state, ui, getBoardTransform(ctx.canvas, state.map));
    expect(calls.join("")).toContain("Road");
    expect(calls.join("")).toContain("→");
  });

  it("labels the 2-lane bidirectional preset with the ⇄ glyph", () => {
    const { ctx, calls } = badgeCtx();
    const state = createInitialGameState();
    const ui = {
      ...createUiState(),
      activeTool: "road" as const,
      roadPreset: "dualBidirectional" as const,
      hoverTile: { x: 1, y: 0 },
    };
    renderCursorBadge(ctx, state, ui, getBoardTransform(ctx.canvas, state.map));
    expect(calls.join("")).toContain("Road");
    expect(calls.join("")).toContain("⇄");
    // Must not also emit the one-way glyph.
    expect(calls.join("")).not.toContain("→");
  });

  it("labels the remove tool as Demolish", () => {
    const { ctx, calls } = badgeCtx();
    const state = createInitialGameState();
    const ui = {
      ...createUiState(),
      activeTool: "remove" as const,
      hoverTile: { x: 1, y: 0 },
    };
    renderCursorBadge(ctx, state, ui, getBoardTransform(ctx.canvas, state.map));
    expect(calls.join("")).toContain("Demolish");
  });

  it("labels a valid area paint target without the blocked marker", () => {
    const { ctx, calls } = badgeCtx();
    const state = createInitialGameState();
    const emptyTile = state.map.tiles.find((tile) => tile.kind === "empty");
    if (emptyTile === undefined) {
      throw new Error("expected the scenario to have at least one empty tile");
    }
    const ui = {
      ...createUiState(),
      activeTool: "area" as const,
      selectedArea: "commercial" as const,
      hoverTile: { x: emptyTile.x, y: emptyTile.y },
    };
    renderCursorBadge(ctx, state, ui, getBoardTransform(ctx.canvas, state.map));
    const text = calls.join("");
    expect(text).toContain("Area Commercial");
    expect(text).not.toContain("⊘");
  });

  it("marks area paint blocked over a starter road tile", () => {
    const { ctx, calls } = badgeCtx();
    const state = createInitialGameState();
    const ui = {
      ...createUiState(),
      activeTool: "area" as const,
      selectedArea: "commercial" as const,
      hoverTile: { x: 7, y: 8 },
    };
    renderCursorBadge(ctx, state, ui, getBoardTransform(ctx.canvas, state.map));
    expect(calls.join("")).toContain("⊘");
  });

  it("draws nothing in area mode when no area is selected", () => {
    const { ctx, calls } = badgeCtx();
    const state = createInitialGameState();
    const ui = {
      ...createUiState(),
      activeTool: "area" as const,
      selectedArea: null,
      hoverTile: { x: 1, y: 1 },
    };
    renderCursorBadge(ctx, state, ui, getBoardTransform(ctx.canvas, state.map));
    expect(calls).toHaveLength(0);
    expect(ctx.save).not.toHaveBeenCalled();
    expect(ctx.fillRect).not.toHaveBeenCalled();
    expect(ctx.fillText).not.toHaveBeenCalled();
  });

  it("flips the badge below the tile on the top row so it does not clip", () => {
    const { ctx } = badgeCtx();
    const state = createInitialGameState();
    const ui = {
      ...createUiState(),
      activeTool: "road" as const,
      hoverTile: { x: 1, y: 0 },
    };
    renderCursorBadge(ctx, state, ui, getBoardTransform(ctx.canvas, state.map));
    const boxY = (ctx.fillRect as unknown as { mock: { calls: number[][] } })
      .mock.calls[0][1];
    // y=0 tile bottom is 32; badge sits just below it instead of above the top.
    expect(boxY).toBe(32 + 8);
  });

  it("draws the badge above the tile when there is room", () => {
    const { ctx } = badgeCtx();
    const state = createInitialGameState();
    const ui = {
      ...createUiState(),
      activeTool: "road" as const,
      hoverTile: { x: 1, y: 5 },
    };
    renderCursorBadge(ctx, state, ui, getBoardTransform(ctx.canvas, state.map));
    const boxY = (ctx.fillRect as unknown as { mock: { calls: number[][] } })
      .mock.calls[0][1];
    // y=5 tile top is 160; badge sits 20px tall + 8px padding above it.
    expect(boxY).toBe(160 - 20 - 8);
  });

  it("scales the badge geometry by devicePixelRatio so it stays constant in CSS px", () => {
    // The badge draws after renderGame's ctx.restore() in raw backing-store
    // pixels; on a retina (DPR=2) target its font/height/gap must be doubled
    // or it renders at half-size. jsdom defaults to DPR=1, so stub explicitly.
    vi.stubGlobal("devicePixelRatio", 2);
    try {
      const { ctx } = badgeCtx();
      const state = createInitialGameState();
      const ui = {
        ...createUiState(),
        activeTool: "road" as const,
        hoverTile: { x: 1, y: 5 },
      };
      renderCursorBadge(
        ctx,
        state,
        ui,
        getBoardTransform(ctx.canvas, state.map),
      );
      // Font, height and the above-tile gap all double at DPR=2.
      expect(ctx.font).toBe("24px ui-monospace, monospace");
      const fillRectCalls = (
        ctx.fillRect as unknown as { mock: { calls: number[][] } }
      ).mock.calls;
      // [x, y, width, height] — height must be 20 * 2.
      expect(fillRectCalls[0][3]).toBe(40);
      // boxY = tileTop(160) - height(40) - gap(16) = 104.
      expect(fillRectCalls[0][1]).toBe(104);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
