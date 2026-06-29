import { describe, expect, it, vi } from "vitest";
import { renderTransit } from "../../src/render/transitRenderer";
import { createUiState } from "../../src/ui/uiState";
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
    const ui = {
      ...createUiState(),
      activeTool: "busRoute" as const,
      draftStopIds: ["stop-001", "stop-002"],
      draftStopPaths: [
        [
          { x: 7, y: 8 },
          { x: 8, y: 8 },
          { x: 9, y: 8 },
        ],
      ],
    };
    renderTransit(mockCtx, busState(), ui);
    // The draft polyline was drawn — at minimum moveTo + lineTo for the path.
    expect(mockCtx.moveTo).toHaveBeenCalled();
    expect(mockCtx.lineTo).toHaveBeenCalled();
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
    // both segments become unpathable and the route is marked pathBroken.
    state = removeTestInfrastructureAtTile(state, { x: 11, y: 8 });
    expect(state.transit.routes[0].pathBroken).toBe(true);

    const context = ctx();
    renderTransit(context, state, createUiState());

    // segmentIndex=0 -> parked at stop-001 (7,8), centre = (7*32+16, 8*32+16)
    // = (240, 272). Vehicles are drawn via fillRect(point.x-7, point.y-14, 14, 8).
    expect(context.fillRect).toHaveBeenCalledWith(233, 258, 14, 8);
  });

  it("interpolates the vehicle position partway along its current segment", () => {
    let state = busState();

    // segments[0] for the (7,8)->(15,8) route has 8 steps (9 tiles along
    // y=8). progress=0.5 -> along = 0.5 * 8 = 4.0 -> tile index 4 = (11,8).
    state = {
      ...state,
      transit: {
        ...state.transit,
        vehicles: state.transit.vehicles.map((vehicle) => ({
          ...vehicle,
          progress: 0.5,
        })),
      },
    };

    const context = ctx();
    renderTransit(context, state, createUiState());

    // Centre of (11,8) = (11*32+16, 8*32+16) = (368, 272).
    // Vehicles are drawn via fillRect(point.x-7, point.y-14, 14, 8).
    expect(context.fillRect).toHaveBeenCalledWith(361, 258, 14, 8);
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
});
