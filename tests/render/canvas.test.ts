import { describe, expect, it, vi } from "vitest";
import { renderBuildings } from "../../src/render/buildingRenderer";
import { canvasToTile, syncCanvasSize } from "../../src/render/canvas";
import { renderOverlays } from "../../src/render/overlayRenderer";
import { getBuildingFootprint } from "../../src/domain/catalog/buildings";
import { stopCoverageRadius } from "../../src/domain/catalog/transit";
import { createUiState } from "../../src/ui/uiState";
import { createTestGameState, placeTestBuilding } from "../helpers/gameState";
import { withAreas } from "../helpers/mapFixtures";

const tileSize = 32;

interface RectCall {
  fillStyle: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface StrokeCall {
  strokeStyle: string;
  lineWidth: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

function createContextRecorder() {
  const calls = {
    fillRects: [] as RectCall[],
    strokeRects: [] as StrokeCall[],
  };
  let fillStyle = "";
  let strokeStyle = "";
  let lineWidth = 1;
  const ctx = {
    get fillStyle() {
      return fillStyle;
    },
    set fillStyle(value: string | CanvasGradient | CanvasPattern) {
      fillStyle = String(value);
    },
    get strokeStyle() {
      return strokeStyle;
    },
    set strokeStyle(value: string | CanvasGradient | CanvasPattern) {
      strokeStyle = String(value);
    },
    get lineWidth() {
      return lineWidth;
    },
    set lineWidth(value: number) {
      lineWidth = value;
    },
    fillRect(x: number, y: number, width: number, height: number) {
      calls.fillRects.push({
        fillStyle,
        x,
        y,
        width,
        height,
      });
    },
    strokeRect(x: number, y: number, width: number, height: number) {
      calls.strokeRects.push({
        strokeStyle,
        lineWidth,
        x,
        y,
        width,
        height,
      });
    },
  } as CanvasRenderingContext2D;

  return { ctx, calls };
}

function mockRect(width: number, height: number) {
  return {
    width,
    height,
    left: 0,
    top: 0,
    right: width,
    bottom: height,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  };
}

describe("canvas helpers", () => {
  it("syncs canvas dimensions to its rendered bounds", () => {
    const canvas = document.createElement("canvas");
    vi.stubGlobal("devicePixelRatio", 2);
    Object.defineProperty(canvas, "getBoundingClientRect", {
      value: () => mockRect(320.4, 200.6),
    });

    expect(syncCanvasSize(canvas)).toBe(true);
    expect(canvas.width).toBe(641);
    expect(canvas.height).toBe(401);
    expect(canvas.style.width).toBe("320px");
    expect(canvas.style.height).toBe("201px");
    expect(syncCanvasSize(canvas)).toBe(false);
    vi.unstubAllGlobals();
  });

  it("maps client coordinates to map tiles", () => {
    const canvas = document.createElement("canvas");
    const map = createTestGameState().map;

    canvas.width = map.width * 32;
    canvas.height = map.height * 32;
    Object.defineProperty(canvas, "getBoundingClientRect", {
      value: () => mockRect(canvas.width, canvas.height),
    });

    expect(canvasToTile(canvas, 16, 16, map)).toEqual({ x: 0, y: 0 });
    expect(canvasToTile(canvas, canvas.width + 1, 16, map)).toBeNull();
  });

  it("uses the building footprint helper for preview geometry", () => {
    expect(getBuildingFootprint("busTerminal", { x: 1, y: 2 }, 270)).toEqual([
      { x: 1, y: 2 },
      { x: 2, y: 2 },
      { x: 1, y: 3 },
      { x: 2, y: 3 },
      { x: 1, y: 4 },
      { x: 2, y: 4 },
    ]);
  });

  it("uses larger coverage for bus terminals than bus stops", () => {
    expect(
      stopCoverageRadius({
        id: "stop-001",
        kind: "busStop",
        position: { x: 0, y: 0 },
        platforms: [],
      }),
    ).toBe(2);
    expect(
      stopCoverageRadius({
        id: "stop-002",
        kind: "busTerminal",
        position: { x: 0, y: 0 },
        platforms: [],
      }),
    ).toBe(4);
  });

  it("renders every occupied building tile with the building type color", () => {
    const { ctx, calls } = createContextRecorder();
    const state = placeTestBuilding(
      createTestGameState(),
      "busTerminal",
      { x: 0, y: 0 },
      90,
    );

    renderBuildings(ctx, state);

    expect(
      calls.fillRects.filter((call) => call.fillStyle === "#c7472f"),
    ).toEqual([
      { fillStyle: "#c7472f", x: 0, y: 0, width: tileSize, height: tileSize },
      {
        fillStyle: "#c7472f",
        x: tileSize,
        y: 0,
        width: tileSize,
        height: tileSize,
      },
      {
        fillStyle: "#c7472f",
        x: 0,
        y: tileSize,
        width: tileSize,
        height: tileSize,
      },
      {
        fillStyle: "#c7472f",
        x: tileSize,
        y: tileSize,
        width: tileSize,
        height: tileSize,
      },
      {
        fillStyle: "#c7472f",
        x: 0,
        y: 2 * tileSize,
        width: tileSize,
        height: tileSize,
      },
      {
        fillStyle: "#c7472f",
        x: tileSize,
        y: 2 * tileSize,
        width: tileSize,
        height: tileSize,
      },
    ]);
    expect(calls.strokeRects).toHaveLength(6);
    expect(calls.strokeRects[0]).toMatchObject({
      strokeStyle: "rgba(17, 24, 32, 0.45)",
      lineWidth: 2,
    });
  });

  it("renders coverage overlays with terminal coverage radius", () => {
    const { ctx, calls } = createContextRecorder();
    const state = {
      ...createTestGameState(),
      transit: {
        ...createTestGameState().transit,
        stops: [
          {
            id: "stop-001",
            kind: "busTerminal" as const,
            position: { x: 6, y: 7 },
            platforms: [],
          },
        ],
      },
    };
    const ui = { ...createUiState(), activeOverlay: "coverage" as const };

    renderOverlays(ctx, state, ui);

    expect(calls.fillRects).toContainEqual({
      fillStyle: "rgba(40, 103, 178, 0.18)",
      x: 2 * tileSize,
      y: 3 * tileSize,
      width: 9 * tileSize,
      height: 9 * tileSize,
    });
  });

  it("renders selected building preview over the full footprint", () => {
    const { ctx, calls } = createContextRecorder();
    const state = createTestGameState();
    const ui = {
      ...createUiState(),
      hoverTile: { x: 0, y: 0 },
      selectedBuilding: "busTerminal" as const,
      buildingRotation: 270 as const,
    };

    renderOverlays(ctx, state, ui);

    expect(
      calls.fillRects.filter(
        (call) => call.fillStyle === "rgba(200, 255, 92, 0.32)",
      ),
    ).toEqual([
      {
        fillStyle: "rgba(200, 255, 92, 0.32)",
        x: 0,
        y: 0,
        width: tileSize,
        height: tileSize,
      },
      {
        fillStyle: "rgba(200, 255, 92, 0.32)",
        x: tileSize,
        y: 0,
        width: tileSize,
        height: tileSize,
      },
      {
        fillStyle: "rgba(200, 255, 92, 0.32)",
        x: 0,
        y: tileSize,
        width: tileSize,
        height: tileSize,
      },
      {
        fillStyle: "rgba(200, 255, 92, 0.32)",
        x: tileSize,
        y: tileSize,
        width: tileSize,
        height: tileSize,
      },
      {
        fillStyle: "rgba(200, 255, 92, 0.32)",
        x: 0,
        y: 2 * tileSize,
        width: tileSize,
        height: tileSize,
      },
      {
        fillStyle: "rgba(200, 255, 92, 0.32)",
        x: tileSize,
        y: 2 * tileSize,
        width: tileSize,
        height: tileSize,
      },
    ]);
    expect(calls.strokeRects).not.toContainEqual({
      strokeStyle: "#111820",
      lineWidth: 2,
      x: 2,
      y: 2,
      width: tileSize - 4,
      height: tileSize - 4,
    });
  });

  it("renders invalid selected building preview colors when placement overlaps", () => {
    const { ctx, calls } = createContextRecorder();
    const state = placeTestBuilding(
      withAreas(createTestGameState(), "residential", [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
      ]),
      "smallHouse",
      { x: 0, y: 0 },
      0,
    );
    const ui = {
      ...createUiState(),
      hoverTile: { x: 0, y: 0 },
      selectedBuilding: "busTerminal" as const,
      buildingRotation: 270 as const,
    };

    renderOverlays(ctx, state, ui);

    expect(
      calls.fillRects.filter(
        (call) => call.fillStyle === "rgba(255, 91, 91, 0.32)",
      ),
    ).toHaveLength(6);
    expect(
      calls.strokeRects.filter((call) => call.strokeStyle === "#ff5b5b"),
    ).toEqual([
      {
        strokeStyle: "#ff5b5b",
        lineWidth: 2,
        x: 2,
        y: 2,
        width: tileSize - 4,
        height: tileSize - 4,
      },
      {
        strokeStyle: "#ff5b5b",
        lineWidth: 2,
        x: tileSize + 2,
        y: 2,
        width: tileSize - 4,
        height: tileSize - 4,
      },
      {
        strokeStyle: "#ff5b5b",
        lineWidth: 2,
        x: 2,
        y: tileSize + 2,
        width: tileSize - 4,
        height: tileSize - 4,
      },
      {
        strokeStyle: "#ff5b5b",
        lineWidth: 2,
        x: tileSize + 2,
        y: tileSize + 2,
        width: tileSize - 4,
        height: tileSize - 4,
      },
      {
        strokeStyle: "#ff5b5b",
        lineWidth: 2,
        x: 2,
        y: 2 * tileSize + 2,
        width: tileSize - 4,
        height: tileSize - 4,
      },
      {
        strokeStyle: "#ff5b5b",
        lineWidth: 2,
        x: tileSize + 2,
        y: 2 * tileSize + 2,
        width: tileSize - 4,
        height: tileSize - 4,
      },
    ]);
  });

  it("renders invalid selected building preview colors when unaffordable", () => {
    const { ctx, calls } = createContextRecorder();
    const state = {
      ...createTestGameState(),
      budget: 3_999,
    };
    const ui = {
      ...createUiState(),
      hoverTile: { x: 0, y: 0 },
      selectedBuilding: "smallHouse" as const,
      buildingRotation: 0 as const,
    };

    renderOverlays(ctx, state, ui);

    expect(
      calls.fillRects.filter(
        (call) => call.fillStyle === "rgba(255, 91, 91, 0.32)",
      ),
    ).toEqual([
      {
        fillStyle: "rgba(255, 91, 91, 0.32)",
        x: 0,
        y: 0,
        width: tileSize,
        height: tileSize,
      },
      {
        fillStyle: "rgba(255, 91, 91, 0.32)",
        x: tileSize,
        y: 0,
        width: tileSize,
        height: tileSize,
      },
    ]);
    expect(
      calls.strokeRects.filter((call) => call.strokeStyle === "#ff5b5b"),
    ).toEqual([
      {
        strokeStyle: "#ff5b5b",
        lineWidth: 2,
        x: 2,
        y: 2,
        width: tileSize - 4,
        height: tileSize - 4,
      },
      {
        strokeStyle: "#ff5b5b",
        lineWidth: 2,
        x: tileSize + 2,
        y: 2,
        width: tileSize - 4,
        height: tileSize - 4,
      },
    ]);
  });
});
