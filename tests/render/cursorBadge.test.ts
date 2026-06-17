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
});
