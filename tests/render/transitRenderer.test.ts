import { describe, expect, it, vi } from "vitest";
import { renderTransit } from "../../src/render/transitRenderer";
import type { RouteLegPath, TransitPath } from "../../src/domain/types";
import { createUiState } from "../../src/ui/uiState";
import { createDraft } from "../../src/ui/routeDraft";
import {
  addTestBusRoute,
  addTestBusStop,
  addTestMetroLine,
  addTestMetroStation,
  assignTestVehicle,
  createTestGameState,
  removeTestInfrastructureAtTile,
} from "../helpers/gameState";
import { pointsOnRow, withRoads, withTracks } from "../helpers/mapFixtures";

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
    quadraticCurveTo: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    arc: vi.fn(),
    fillRect: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    setLineDash: vi.fn(),
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    lineCap: "butt",
    lineJoin: "miter",
  } as unknown as CanvasRenderingContext2D;
}

interface RecordedStroke {
  dash: number[];
  strokeStyle: string;
  globalAlpha: number;
  path: Array<{ x: number; y: number }>;
}

function recordingContext(): {
  ctx: CanvasRenderingContext2D;
  strokes: RecordedStroke[];
  fills: Array<{ fillStyle: string; globalAlpha: number }>;
} {
  const strokes: RecordedStroke[] = [];
  let dash: number[] = [];
  let strokeStyle = "";
  let fillStyle = "";
  let globalAlpha = 1;
  let path: Array<{ x: number; y: number }> = [];
  const fills: Array<{ fillStyle: string; globalAlpha: number }> = [];
  const context = {
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(() => {
      path = [];
    }),
    moveTo: vi.fn((x: number, y: number) => {
      path.push({ x, y });
    }),
    lineTo: vi.fn((x: number, y: number) => {
      path.push({ x, y });
    }),
    quadraticCurveTo: vi.fn(),
    stroke: vi.fn(() => {
      strokes.push({
        dash: [...dash],
        strokeStyle,
        globalAlpha,
        path: [...path],
      });
    }),
    fill: vi.fn(() => {
      fills.push({ fillStyle, globalAlpha });
    }),
    arc: vi.fn(),
    fillRect: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    setLineDash: vi.fn((next: number[]) => {
      dash = [...next];
    }),
    get strokeStyle() {
      return strokeStyle;
    },
    set strokeStyle(next: string) {
      strokeStyle = next;
    },
    get fillStyle() {
      return fillStyle;
    },
    set fillStyle(next: string) {
      fillStyle = next;
    },
    get globalAlpha() {
      return globalAlpha;
    },
    set globalAlpha(next: number) {
      globalAlpha = next;
    },
    lineWidth: 0,
    lineCap: "butt",
    lineJoin: "miter",
  } as unknown as CanvasRenderingContext2D;
  return { ctx: context, strokes, fills };
}

function linePath(x: number): TransitPath {
  return {
    kind: "road",
    steps: [
      {
        position: { x, y: 1 },
        enteringHeading: "east",
        leavingHeading: "east",
        movement: "straight",
        geometry: {
          kind: "line",
          from: { x, y: 1 },
          to: { x: x + 0.5, y: 1 },
        },
        travelSeconds: 1,
      },
    ],
    totalTravelSeconds: 1,
  };
}

function routeLeg(
  fromWaypointId: string,
  toWaypointId: string,
  status: RouteLegPath["status"],
  path: TransitPath | null,
): RouteLegPath {
  return {
    fromWaypointId,
    toWaypointId,
    direction: "loop",
    kind: "service",
    status,
    currentPath: status === "connected" ? path : null,
    lastValidPath: path,
    estimatedSeconds: path?.totalTravelSeconds ?? null,
  };
}

function stateWithLegs(legs: RouteLegPath[]) {
  const state = createTestGameState();
  return {
    ...state,
    transit: {
      ...state.transit,
      stops: [
        {
          id: "a",
          kind: "busStop" as const,
          status: "present" as const,
          position: { x: 1, y: 1 },
          platforms: [],
        },
        {
          id: "b",
          kind: "busStop" as const,
          status: "present" as const,
          position: { x: 2, y: 1 },
          platforms: [],
        },
        {
          id: "c",
          kind: "busStop" as const,
          status: "present" as const,
          position: { x: 3, y: 1 },
          platforms: [],
        },
        {
          id: "d",
          kind: "busStop" as const,
          status: "present" as const,
          position: { x: 4, y: 1 },
          platforms: [],
        },
      ],
      routes: [
        {
          id: "route-001",
          name: "Route 1",
          color: "#e04f39",
          stopIds: ["a", "b", "c", "d"],
          vehicleIds: [],
          active: true,
          pattern: "loop" as const,
          revision: 1,
          legs,
          pathBroken: legs.some((leg) => leg.status !== "connected"),
        },
      ],
    },
  };
}

describe("renderTransit highlight", () => {
  function busState() {
    let state = createTestGameState();
    state = withRoads(state, pointsOnRow(8, 7, 15));
    state = addTestBusStop(state, { x: 7, y: 8 });
    state = addTestBusStop(state, { x: 15, y: 8 });
    state = addTestBusRoute(state, ["stop-001", "stop-002"]);
    return assignTestVehicle(state, "bus", "route-001");
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
    const mockCtx = ctx();
    const state = busState();
    const ui = {
      ...createUiState(),
      activeTool: "busRoute" as const,
      routeDraft: {
        ...createDraft("bus", 1),
        waypointIds: ["stop-001", "stop-002"],
        generation: 1,
        preview: {
          generation: 1,
          legs: state.transit.routes[0].legs,
          totalTravelSeconds: 1,
          initialVehicleCost: 8_000,
          affordable: true,
          turnSummary: {
            straight: 0,
            rightTurn: 0,
            leftTurn: 0,
            uTurn: 0,
            roundaboutEntry: 0,
          },
          missingWaypointIds: [],
          warnings: [],
          rejection: null,
        },
      },
    };
    renderTransit(mockCtx, state, ui);
    // The draft polyline was drawn — at minimum moveTo + lineTo for the path.
    expect(mockCtx.moveTo).toHaveBeenCalled();
    expect(mockCtx.lineTo).toHaveBeenCalled();
  });

  it("does not render draft geometry from a stale preview generation", () => {
    const context = ctx();
    const sourceState = busState();
    const ui = {
      ...createUiState(),
      activeTool: "busRoute" as const,
      routeDraft: {
        ...createDraft("bus", 1),
        waypointIds: ["stop-001", "stop-002"],
        generation: 2,
        preview: {
          generation: 1,
          legs: sourceState.transit.routes[0].legs,
          totalTravelSeconds: 1,
          initialVehicleCost: 8_000,
          affordable: true,
          turnSummary: {
            straight: 0,
            rightTurn: 0,
            leftTurn: 0,
            uTurn: 0,
            roundaboutEntry: 0,
          },
          missingWaypointIds: [],
          warnings: [],
          rejection: null,
        },
      },
    };

    renderTransit(context, createTestGameState(), ui);

    expect(context.moveTo).not.toHaveBeenCalled();
    expect(context.lineTo).not.toHaveBeenCalled();
  });

  it("draws the route line through the road path tiles, not stop-to-stop", () => {
    // Stops at (7,8) and (15,4): the path runs along y=8 then up x=15, so the
    // polyline must include the corner tile (15,8) — a straight line would not.
    let state = createTestGameState();
    state = withRoads(state, [
      ...pointsOnRow(8, 7, 15),
      { x: 15, y: 4 },
      { x: 15, y: 5 },
      { x: 15, y: 6 },
      { x: 15, y: 7 },
    ]);
    state = addTestBusStop(state, { x: 7, y: 8 });
    state = addTestBusStop(state, { x: 15, y: 4 });
    state = addTestBusRoute(state, ["stop-001", "stop-002"]);

    const context = ctx();
    renderTransit(context, state, createUiState());

    // tileSize=32: corner tile (15,8) centre = (15*32+16, 8*32+16) = (496, 272).
    expect(context.lineTo).toHaveBeenCalledWith(496, 272);
  });

  it("parks the vehicle at the segment-start stop when the route is broken", () => {
    let state = busState();

    // Sever the road at (11,8), the midpoint of the (7,8)<->(15,8) route, so
    // both legs become unpathable and the route is marked pathBroken.
    state = removeTestInfrastructureAtTile(state, { x: 11, y: 8 });
    expect(state.transit.routes[0].pathBroken).toBe(true);

    const context = ctx();
    renderTransit(context, state, createUiState());

    // itineraryIndex=0 -> parked at stop-001 (7,8), centre = (7*32+16, 8*32+16)
    // = (240, 272). Vehicles are drawn via fillRect(point.x-7, point.y-14, 14, 8).
    expect(context.fillRect).toHaveBeenCalledWith(233, 258, 14, 8);
  });

  it("interpolates the vehicle position partway along its current path step", () => {
    let state = busState();

    // The first tagged step runs from (7,8) to (8,8). stepProgress=0.5
    // samples the midpoint at (7.5,8).
    state = {
      ...state,
      transit: {
        ...state.transit,
        vehicles: state.transit.vehicles.map((vehicle) => ({
          ...vehicle,
          stepProgress: 0.5,
        })),
      },
    };

    const context = ctx();
    renderTransit(context, state, createUiState());

    // Centre of (7.5,8) = (7.5*32+16, 8*32+16) = (256, 272).
    // The bus is drawn in local coordinates after rotating to the path tangent.
    expect(context.translate).toHaveBeenCalledWith(256, 272);
    expect(context.rotate).toHaveBeenCalledWith(0);
    expect(context.fillRect).toHaveBeenCalledWith(-7, -14, 14, 8);
  });

  it("parks a metro vehicle at the segment-start station when its line is broken", () => {
    let state = createTestGameState();
    // Track under stations (7,8) and (15,8) with a connecting track run.
    state = withTracks(state, pointsOnRow(8, 7, 15));
    state = addTestMetroStation(state, { x: 7, y: 8 });
    state = addTestMetroStation(state, { x: 15, y: 8 });
    state = addTestMetroLine(state, ["station-001", "station-002"]);
    state = assignTestVehicle(state, "metro", "metro-001");

    // Sever the connecting track at (11,8) so the line becomes broken.
    state = removeTestInfrastructureAtTile(state, { x: 11, y: 8 });
    expect(state.transit.metroLines[0].pathBroken).toBe(true);

    const context = ctx();
    renderTransit(context, state, createUiState());

    // Parked at station-001 (7,8), centre = (7*32+16, 8*32+16) = (240, 272).
    expect(context.fillRect).toHaveBeenCalledWith(233, 258, 14, 8);
  });

  it("draws current geometry solid and only the failed last-valid leg dotted", () => {
    const { ctx: context, strokes } = recordingContext();
    const state = stateWithLegs([
      routeLeg("a", "b", "connected", linePath(1)),
      routeLeg("b", "c", "networkDisconnected", linePath(2)),
      routeLeg("c", "d", "connected", linePath(3)),
    ]);

    renderTransit(context, state, {
      ...createUiState(),
      selectedRouteId: "route-001",
    });

    const strokesFor = (x: number) =>
      strokes.filter((stroke) => stroke.path[0]?.x === x * 32 + 16);
    expect(strokesFor(1).length).toBeGreaterThan(0);
    expect(strokesFor(1).every((stroke) => stroke.dash.length === 0)).toBe(
      true,
    );
    expect(strokesFor(2).some((stroke) => stroke.dash.length > 0)).toBe(true);
    expect(strokesFor(3).length).toBeGreaterThan(0);
    expect(strokesFor(3).every((stroke) => stroke.dash.length === 0)).toBe(
      true,
    );
  });

  it("uses a direct dotted fallback only when no last-valid geometry exists", () => {
    const { ctx: context, strokes } = recordingContext();
    const state = stateWithLegs([
      routeLeg("a", "b", "networkDisconnected", null),
    ]);
    state.transit.stops[0].position = { x: 4.5, y: 5.5 };
    state.transit.stops[1].position = { x: 9.5, y: 8.5 };

    renderTransit(context, state, {
      ...createUiState(),
      selectedRouteId: "route-001",
    });

    expect(strokes.at(-1)?.path).toEqual([
      { x: 160, y: 192 },
      { x: 320, y: 288 },
    ]);
    expect(strokes.at(-1)?.dash).toEqual([6, 5]);
  });

  it("selected halo repeats each leg dash state", () => {
    const { ctx: context, strokes } = recordingContext();
    const state = stateWithLegs([
      routeLeg("a", "b", "connected", linePath(1)),
      routeLeg("b", "c", "networkDisconnected", linePath(2)),
    ]);

    renderTransit(context, state, {
      ...createUiState(),
      selectedRouteId: "route-001",
    });

    const haloStrokes = strokes.filter(
      (stroke) => stroke.strokeStyle === "#ffffffaa",
    );
    expect(
      haloStrokes.find((stroke) => stroke.path[0]?.x === 48)?.dash,
    ).toEqual([]);
    expect(
      haloStrokes.find((stroke) => stroke.path[0]?.x === 80)?.dash,
    ).toEqual([6, 5]);
  });

  it("emits arrows only for the selected route and dims unrelated routes", () => {
    const { ctx: context, strokes, fills } = recordingContext();
    const sharedPath: TransitPath = {
      kind: "road",
      steps: [
        {
          position: { x: 1, y: 1 },
          enteringHeading: "east",
          leavingHeading: "east",
          movement: "straight",
          geometry: {
            kind: "line",
            from: { x: 1, y: 1 },
            to: { x: 5, y: 1 },
          },
          travelSeconds: 4,
        },
      ],
      totalTravelSeconds: 4,
    };
    const initial = stateWithLegs([
      routeLeg("a", "b", "connected", sharedPath),
    ]);
    const state = {
      ...initial,
      transit: {
        ...initial.transit,
        routes: [
          {
            ...initial.transit.routes[0],
            id: "route-0002",
            color: "#222222",
          },
          {
            ...initial.transit.routes[0],
            id: "route-0001",
            color: "#111111",
          },
        ],
      },
    };

    renderTransit(context, state, {
      ...createUiState(),
      selectedRouteId: "route-0002",
    });

    expect(
      strokes.find((stroke) => stroke.strokeStyle === "#222222")?.globalAlpha,
    ).toBe(1);
    expect(
      strokes.find((stroke) => stroke.strokeStyle === "#111111")?.globalAlpha,
    ).toBe(0.42);
    expect(fills.filter((fill) => fill.fillStyle === "#222222")).not.toEqual(
      [],
    );
    expect(fills.filter((fill) => fill.fillStyle === "#111111")).toEqual([]);
  });
});
