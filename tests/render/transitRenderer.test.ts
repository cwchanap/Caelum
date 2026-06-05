import { describe, expect, it, vi } from "vitest";
import { renderTransit } from "../../src/render/transitRenderer";
import { createInitialGameState } from "../../src/simulation/gameState";
import { createUiState } from "../../src/ui/uiState";
import {
  addBusRoute,
  addBusStop,
  assignVehicle,
} from "../../src/simulation/transit";

// jsdom does not implement HTMLCanvasElement.getContext without the optional
// `canvas` package, so the render tests use a method stub. The tests only
// assert no-throw, which a stub satisfies as long as every method the renderer
// calls exists on it.
function ctx(): CanvasRenderingContext2D {
  return {
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    arc: vi.fn(),
    fillRect: vi.fn(),
    setLineDash: vi.fn(),
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    lineCap: "butt",
    lineJoin: "miter",
  } as unknown as CanvasRenderingContext2D;
}

describe("renderTransit highlight", () => {
  function busState() {
    let state = createInitialGameState();
    state = addBusStop(state, { x: 7, y: 8 });
    state = addBusStop(state, { x: 15, y: 8 });
    state = addBusRoute(state, ["stop-001", "stop-002"]);
    return assignVehicle(state, "bus", "route-001");
  }

  it("renders without a selection or draft", () => {
    expect(() =>
      renderTransit(ctx(), busState(), createUiState()),
    ).not.toThrow();
  });

  it("renders with a selected route", () => {
    const ui = { ...createUiState(), selectedRouteId: "route-001" };
    expect(() => renderTransit(ctx(), busState(), ui)).not.toThrow();
  });

  it("renders a draft preview", () => {
    const ui = {
      ...createUiState(),
      activeTool: "busRoute" as const,
      draftStopIds: ["stop-001", "stop-002"],
    };
    expect(() => renderTransit(ctx(), busState(), ui)).not.toThrow();
  });
});
