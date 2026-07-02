import { describe, expect, it, vi } from "vitest";
import { renderCitizens } from "../../src/render/citizenRenderer";
import { colors } from "../../src/render/colors";
import { tileSize } from "../../src/render/canvas";
import { createTestGameState } from "../helpers/gameState";
import type { ActiveTrip } from "../../src/domain/types";

function ctx() {
  const fillStyles: string[] = [];
  const arcCalls: Array<{
    x: number;
    y: number;
    radius: number;
    start: number;
    end: number;
  }> = [];
  const c = {
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(
      (x: number, y: number, radius: number, start: number, end: number) =>
        arcCalls.push({ x, y, radius, start, end }),
    ),
    fill: vi.fn(),
    fillStyle: "",
  } as unknown as CanvasRenderingContext2D & {
    fillStyle: string;
  };
  // Wrap fillStyle assignment to record the color per draw call.
  Object.defineProperty(c, "fillStyle", {
    get() {
      return fillStyles.at(-1) ?? "";
    },
    set(v: string) {
      fillStyles.push(v);
    },
  });
  return { ctx: c, fillStyles, arcCalls };
}

function trip(
  status: ActiveTrip["status"],
  position: { x: number; y: number },
): ActiveTrip {
  return {
    id: `trip-${status}`,
    simId: "sim-001",
    purpose: "commuteOutbound",
    origin: { x: 0, y: 0 },
    destination: { x: 9, y: 9 },
    position,
    status,
    deadline: 9_999,
    routePlan: null,
    currentLegIndex: 0,
    patienceRemaining: 100,
  };
}

describe("renderCitizens", () => {
  it("draws nothing when there are no active trips", () => {
    const { ctx: c, fillStyles, arcCalls } = ctx();
    renderCitizens(c, createTestGameState());
    expect(fillStyles).toHaveLength(0);
    expect(arcCalls).toHaveLength(0);
  });

  it("skips arrived trips", () => {
    const { ctx: c, arcCalls } = ctx();
    const state = {
      ...createTestGameState(),
      activeTrips: [trip("arrived", { x: 2, y: 2 })],
    };
    renderCitizens(c, state);
    expect(arcCalls).toHaveLength(0);
  });

  it("draws a dot for each non-arrived trip at the tile offset", () => {
    const { ctx: c, arcCalls } = ctx();
    const state = {
      ...createTestGameState(),
      activeTrips: [
        trip("walking", { x: 1, y: 2 }),
        trip("waiting", { x: 3, y: 4 }),
      ],
    };
    renderCitizens(c, state);
    expect(arcCalls).toHaveLength(2);
    expect(arcCalls[0]).toEqual({
      x: 1 * tileSize + 10,
      y: 2 * tileSize + 10,
      radius: 3,
      start: 0,
      end: Math.PI * 2,
    });
    expect(arcCalls[1]).toEqual({
      x: 3 * tileSize + 10,
      y: 4 * tileSize + 10,
      radius: 3,
      start: 0,
      end: Math.PI * 2,
    });
  });

  it("uses the late color for late trips", () => {
    const { ctx: c, fillStyles } = ctx();
    const state = {
      ...createTestGameState(),
      activeTrips: [trip("late", { x: 1, y: 1 })],
    };
    renderCitizens(c, state);
    expect(fillStyles).toEqual([colors.late]);
  });

  it("uses the unserved color for unserved trips", () => {
    const { ctx: c, fillStyles } = ctx();
    const state = {
      ...createTestGameState(),
      activeTrips: [trip("unserved", { x: 1, y: 1 })],
    };
    renderCitizens(c, state);
    expect(fillStyles).toEqual([colors.unserved]);
  });

  it("uses the waiting color for waiting trips", () => {
    const { ctx: c, fillStyles } = ctx();
    const state = {
      ...createTestGameState(),
      activeTrips: [trip("waiting", { x: 1, y: 1 })],
    };
    renderCitizens(c, state);
    expect(fillStyles).toEqual([colors.waiting]);
  });

  it("uses the riding color for riding trips", () => {
    const { ctx: c, fillStyles } = ctx();
    const state = {
      ...createTestGameState(),
      activeTrips: [trip("riding", { x: 1, y: 1 })],
    };
    renderCitizens(c, state);
    expect(fillStyles).toEqual([colors.riding]);
  });

  it("uses the default citizen color for walking trips", () => {
    const { ctx: c, fillStyles } = ctx();
    const state = {
      ...createTestGameState(),
      activeTrips: [trip("walking", { x: 1, y: 1 })],
    };
    renderCitizens(c, state);
    expect(fillStyles).toEqual([colors.citizen]);
  });

  it("handles a null activeTrips field gracefully", () => {
    const { ctx: c, arcCalls } = ctx();
    const state = {
      ...createTestGameState(),
      activeTrips: undefined,
    };
    expect(() => renderCitizens(c, state)).not.toThrow();
    expect(arcCalls).toHaveLength(0);
  });
});
