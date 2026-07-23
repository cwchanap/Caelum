import { describe, expect, it, vi } from "vitest";
import {
  renderOverlays,
  renderRoadPreviewFeedbackBadge,
  renderRouteDraftHandles,
} from "../../src/render/overlayRenderer";
import { renderTransit } from "../../src/render/transitRenderer";
import { createTestGameState } from "../helpers/gameState";
import { createUiState } from "../../src/ui/uiState";
import type {
  ActiveTrip,
  Point,
  RoadStructure,
  RouteLegPath,
  Stop,
  TransitPath,
} from "../../src/domain/types";
import { colors } from "../../src/render/colors";
import { tileSize, type BoardTransform } from "../../src/render/canvas";
import { withAreas, withRoads, withTracks } from "../helpers/mapFixtures";
import type { RouteEditorView } from "../../src/runtime/types";

/** Identity transform (scale=1, no offset) for badge-position tests. */
const identityTransform: BoardTransform = {
  scale: 1,
  offsetX: 0,
  offsetY: 0,
  width: 28 * tileSize,
  height: 18 * tileSize,
};

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

function editDraftView(): RouteEditorView {
  return {
    source: "edit",
    title: "Editing Route 1",
    mode: "bus",
    pattern: "loop",
    waypoints: [
      {
        id: "stop-001",
        index: 0,
        label: "Stop A",
        status: "present",
        selected: false,
      },
      {
        id: "stop-002",
        index: 1,
        label: "Missing Bus Stop",
        status: "missing",
        selected: true,
      },
      {
        id: "stop-003",
        index: 2,
        label: "Stop C",
        status: "present",
        selected: false,
      },
    ],
    selectedIndex: 1,
    interaction: "replace",
    previewPending: false,
    previewStatus: "broken",
    previewMessage: "Missing Bus Stop to Stop C cannot connect",
    previewWarnings: [],
    canSave: true,
    canReload: false,
    canUndo: false,
    canRedo: false,
    notice: null,
  };
}

function draftHandleContext() {
  let status: "present" | "missing" = "present";
  const labels: Array<{ text: string; status: "present" | "missing" }> = [];
  const ctx = {
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    stroke: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    fill: vi.fn(),
    setLineDash: vi.fn((dash: number[]) => {
      status = dash.length > 0 ? "missing" : "present";
    }),
    fillText: vi.fn((text: string) => labels.push({ text, status })),
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    font: "",
    textAlign: "center",
    textBaseline: "middle",
  } as unknown as CanvasRenderingContext2D;
  return { ctx, labels };
}

describe("route draft handles", () => {
  it("renders numbered present and missing handles", () => {
    const { ctx, labels } = draftHandleContext();
    renderRouteDraftHandles(
      ctx,
      editDraftView(),
      new Map([
        ["stop-001", { x: 2, y: 3 }],
        ["stop-002", { x: 6, y: 4 }],
        ["stop-003", { x: 8, y: 5 }],
      ]),
    );

    expect(labels).toEqual([
      { text: "1", status: "present" },
      { text: "2", status: "missing" },
      { text: "3", status: "present" },
    ]);
  });
});

describe("roadside stop access", () => {
  it("uses roadside validation for the bus-stop hover tint", () => {
    const state = withRoads(createTestGameState(), [{ x: 4, y: 5 }]);
    const { ctx, fillStyles } = recordingFillCtx();

    renderOverlays(ctx, state, {
      ...createUiState(),
      activeTool: "busStop",
      hoverTile: { x: 4, y: 4 },
    });

    expect(fillStyles).toContain(colors.previewValid);
  });

  it("draws access from passenger anchor to road point", () => {
    const state = createTestGameState();
    const accessState = {
      ...state,
      transit: {
        ...state.transit,
        stops: [
          {
            id: "stop-access",
            kind: "busStop" as const,
            status: "present" as const,
            position: { x: 4, y: 4 },
            roadAccess: { roadPoint: { x: 4, y: 5 } },
            platforms: [],
          },
        ],
      },
    };
    const ctx = dragCtx();

    renderTransit(ctx, accessState, createUiState());

    expect(ctx.moveTo).toHaveBeenCalledWith(
      4 * tileSize + tileSize / 2,
      4 * tileSize + tileSize / 2,
    );
    expect(ctx.lineTo).toHaveBeenCalledWith(
      4 * tileSize + tileSize / 2,
      5 * tileSize + tileSize / 2,
    );
  });
});

const stop: Stop = {
  id: "stop-001",
  kind: "busStop",
  status: "present",
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
          serviceDirection: "loop",
          boardItineraryIndex: 0,
          alightItineraryIndex: 0,
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

function markerPath(
  from: { x: number; y: number },
  to: { x: number; y: number },
): TransitPath {
  return {
    kind: "road",
    steps: [
      {
        position: from,
        enteringHeading: "east",
        leavingHeading: "east",
        movement: "straight",
        geometry: { kind: "line", from, to },
        travelSeconds: 1,
      },
    ],
    totalTravelSeconds: 1,
  };
}

function failedMarkerLeg(
  fromWaypointId: string,
  toWaypointId: string,
  status: RouteLegPath["status"],
  lastValidPath: TransitPath,
): RouteLegPath {
  return {
    fromWaypointId,
    toWaypointId,
    direction: "loop",
    kind: "service",
    status,
    currentPath: null,
    lastValidPath,
    estimatedSeconds: null,
    failureReason: null,
  };
}

describe("broken route markers", () => {
  it("uses distinct missing-node and disconnected-leg markers", () => {
    const state = createTestGameState();
    const routeState = {
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
            status: "missing" as const,
            position: { x: 2, y: 1 },
            platforms: [],
          },
          {
            id: "c",
            kind: "busStop" as const,
            status: "present" as const,
            position: { x: 6, y: 1 },
            platforms: [],
          },
        ],
        routes: [
          {
            id: "route-001",
            name: "Route 1",
            color: "#e04f39",
            stopIds: ["a", "b", "c"],
            vehicleIds: [],
            active: true,
            pattern: "loop" as const,
            revision: 1,
            legs: [
              failedMarkerLeg(
                "a",
                "b",
                "missingNode",
                markerPath({ x: 1, y: 1 }, { x: 2, y: 1 }),
              ),
              failedMarkerLeg(
                "b",
                "c",
                "networkDisconnected",
                markerPath({ x: 2, y: 1 }, { x: 6, y: 1 }),
              ),
            ],
            pathBroken: true,
          },
        ],
      },
    };
    const context = {
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      fill: vi.fn(),
      arc: vi.fn(),
      strokeRect: vi.fn(),
      fillRect: vi.fn(),
      strokeStyle: "",
      fillStyle: "",
      lineWidth: 0,
      globalAlpha: 1,
    } as unknown as CanvasRenderingContext2D;

    renderOverlays(context, routeState, {
      ...createUiState(),
      selectedRouteId: "route-001",
    });

    expect(context.strokeRect).toHaveBeenCalledTimes(1);
    expect(context.arc).toHaveBeenCalledTimes(1);
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
    fillText: vi.fn(),
    measureText: vi.fn((text: string) => ({ width: text.length * 6 })),
    fillStyle: "",
    strokeStyle: "",
    font: "",
    textAlign: "start",
    textBaseline: "alphabetic",
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
    fillText: vi.fn(),
    measureText: vi.fn((text: string) => ({ width: text.length * 6 })),
    set fillStyle(v: string) {
      fillStyles.push(v);
    },
    get fillStyle() {
      return fillStyles.at(-1) ?? "";
    },
    strokeStyle: "",
    font: "",
    textAlign: "start",
    textBaseline: "alphabetic",
    lineWidth: 0,
    lineCap: "",
    lineJoin: "",
    globalAlpha: 1,
  } as unknown as CanvasRenderingContext2D;
  return { ctx, fillStyles };
}

function footprint3x3(origin: Point): Point[] {
  return Array.from({ length: 9 }, (_, index) => ({
    x: origin.x + (index % 3),
    y: origin.y + Math.floor(index / 3),
  }));
}

function standardRoundaboutFixture(): Extract<
  RoadStructure,
  { kind: "roundabout" }
> {
  const origin = { x: 5, y: 5 };
  return {
    kind: "roundabout",
    id: "roundabout-001",
    origin,
    size: "standard3x3",
    footprint: footprint3x3(origin),
    ports: [
      { id: "north", point: { x: 6, y: 5 }, edge: "north" },
      { id: "east", point: { x: 7, y: 6 }, edge: "east" },
      { id: "south", point: { x: 6, y: 7 }, edge: "south" },
      { id: "west", point: { x: 5, y: 6 }, edge: "west" },
    ],
  };
}

describe("authoritative road mutation preview", () => {
  const drag = {
    tool: "road" as const,
    start: { x: 1, y: 2 },
    current: { x: 3, y: 2 },
  };

  it("renders the matching Rust response for a road-tool hover", () => {
    const ctx = dragCtx();
    renderOverlays(ctx, createTestGameState(), {
      ...createUiState(),
      activeTool: "road",
      hoverTile: { x: 6, y: 4 },
      roadPreviewGeneration: 2,
      roadMutationPreview: {
        generation: 2,
        changedTiles: [{ x: 6, y: 4 }],
        authoredTiles: [],
        generatedStructures: [],
        cost: 100,
        skippedTiles: [],
        routeImpacts: [],
        warnings: [],
        rejection: null,
      },
    });
    expect(ctx.fillRect).toHaveBeenCalledWith(
      6 * tileSize,
      4 * tileSize,
      tileSize,
      tileSize,
    );
  });

  it("renders changed and skipped tiles from the matching Rust response", () => {
    const ctx = dragCtx();
    const ui = {
      ...createUiState(),
      activeTool: "road" as const,
      drag,
      roadPreviewGeneration: 4,
      roadMutationPreview: {
        generation: 4,
        changedTiles: [
          { x: 1, y: 2 },
          { x: 2, y: 2 },
        ],
        authoredTiles: [],
        generatedStructures: [],
        cost: 200,
        skippedTiles: [{ x: 3, y: 2 }],
        routeImpacts: [{ routeId: "route-001", kind: "rerouted" as const }],
        warnings: [],
        rejection: null,
      },
    };

    renderOverlays(ctx, createTestGameState(), ui);

    expect(ctx.fillRect).toHaveBeenCalledWith(
      1 * tileSize,
      2 * tileSize,
      tileSize,
      tileSize,
    );
    expect(ctx.fillRect).toHaveBeenCalledWith(
      3 * tileSize,
      2 * tileSize,
      tileSize,
      tileSize,
    );
  });

  it("ignores a road preview whose generation does not match", () => {
    const ctx = dragCtx();
    renderOverlays(ctx, createTestGameState(), {
      ...createUiState(),
      activeTool: "road",
      drag,
      roadPreviewGeneration: 5,
      roadMutationPreview: {
        generation: 4,
        changedTiles: [{ x: 1, y: 2 }],
        authoredTiles: [],
        generatedStructures: [],
        cost: 100,
        skippedTiles: [],
        routeImpacts: [],
        warnings: [],
        rejection: null,
      },
    });
    expect(ctx.fillRect).not.toHaveBeenCalled();
    expect(ctx.fillText).not.toHaveBeenCalled();
    expect(ctx.lineTo).not.toHaveBeenCalled();
  });

  it("draws authored road connection topology without inferring adjacency", () => {
    const ctx = dragCtx();
    renderOverlays(ctx, createTestGameState(), {
      ...createUiState(),
      activeTool: "road",
      drag,
      roadPreviewGeneration: 1,
      roadMutationPreview: {
        generation: 1,
        changedTiles: [{ x: 1, y: 2 }],
        authoredTiles: [
          {
            point: { x: 1, y: 2 },
            oneWay: null,
            roadConnections: ["north", "east"],
            roadStructureId: null,
          },
        ],
        generatedStructures: [],
        cost: 100,
        skippedTiles: [],
        routeImpacts: [],
        warnings: [],
        rejection: null,
      },
    });

    expect(ctx.moveTo).toHaveBeenCalledWith(48, 80);
    expect(ctx.lineTo).toHaveBeenCalledWith(48, 64);
    expect(ctx.lineTo).toHaveBeenCalledWith(64, 80);
    expect(ctx.lineTo).toHaveBeenCalledTimes(2);
  });

  it("presents the exact authoritative road preview cost", () => {
    const ctx = dragCtx();
    const state = createTestGameState();
    const ui = {
      ...createUiState(),
      activeTool: "road" as const,
      drag,
      roadPreviewGeneration: 1,
      roadMutationPreview: {
        generation: 1,
        changedTiles: [{ x: 1, y: 2 }],
        authoredTiles: [],
        generatedStructures: [],
        cost: 375,
        skippedTiles: [],
        routeImpacts: [],
        warnings: [],
        rejection: null,
      },
    };
    renderOverlays(ctx, state, ui);
    renderRoadPreviewFeedbackBadge(ctx, state, ui, identityTransform);

    expect(ctx.fillText).toHaveBeenCalledWith(
      "$375",
      expect.any(Number),
      expect.any(Number),
    );
  });

  it("presents stable route-impact feedback from the Rust response", () => {
    const ctx = dragCtx();
    const state = createTestGameState();
    const ui = {
      ...createUiState(),
      activeTool: "road" as const,
      drag,
      roadPreviewGeneration: 1,
      roadMutationPreview: {
        generation: 1,
        changedTiles: [{ x: 1, y: 2 }],
        authoredTiles: [],
        generatedStructures: [],
        cost: 500,
        skippedTiles: [],
        routeImpacts: [
          { routeId: "route-z", kind: "broken" as const },
          { routeId: "route-a", kind: "rerouted" as const },
        ],
        warnings: [],
        rejection: null,
      },
    };
    renderOverlays(ctx, state, ui);
    renderRoadPreviewFeedbackBadge(ctx, state, ui, identityTransform);

    expect(ctx.fillText).toHaveBeenCalledWith(
      "$500 · route-a rerouted · route-z broken",
      expect.any(Number),
      expect.any(Number),
    );
  });

  it("draws direction arrows from authored preview tiles", () => {
    const ctx = dragCtx();
    renderOverlays(ctx, createTestGameState(), {
      ...createUiState(),
      activeTool: "road",
      drag,
      roadPreviewGeneration: 1,
      roadMutationPreview: {
        generation: 1,
        changedTiles: [{ x: 1, y: 2 }],
        authoredTiles: [
          {
            point: { x: 1, y: 2 },
            oneWay: "west",
            roadConnections: ["west"],
            roadStructureId: null,
          },
        ],
        generatedStructures: [],
        cost: 100,
        skippedTiles: [],
        routeImpacts: [],
        warnings: [],
        rejection: null,
      },
    });
    expect(ctx.stroke).toHaveBeenCalled();
    expect(ctx.strokeStyle).toBe(colors.oneWayArrow);
  });

  it("treats an omitted two-way wire field as non-directional", () => {
    const ctx = dragCtx();
    expect(() =>
      renderOverlays(ctx, createTestGameState(), {
        ...createUiState(),
        activeTool: "road",
        drag,
        roadPreviewGeneration: 1,
        roadMutationPreview: {
          generation: 1,
          changedTiles: [{ x: 1, y: 2 }],
          authoredTiles: [
            {
              point: { x: 1, y: 2 },
              // Rust omits Option::None fields on the wire for a two-way tile.
              roadConnections: ["east"],
              roadStructureId: null,
            },
          ],
          generatedStructures: [],
          cost: 100,
          skippedTiles: [],
          routeImpacts: [],
          warnings: [],
          rejection: null,
        },
      }),
    ).not.toThrow();
  });

  it("renders generated structure footprints from Rust", () => {
    const ctx = dragCtx();
    renderOverlays(ctx, createTestGameState(), {
      ...createUiState(),
      activeTool: "road",
      drag,
      roadPreviewGeneration: 1,
      roadMutationPreview: {
        generation: 1,
        changedTiles: [],
        authoredTiles: [],
        generatedStructures: [
          {
            kind: "automaticJunction",
            id: "junction-001",
            footprint: [{ x: 4, y: 4 }],
            ports: [],
          },
        ],
        cost: 0,
        skippedTiles: [],
        routeImpacts: [],
        warnings: [],
        rejection: null,
      },
    });
    expect(ctx.fillRect).toHaveBeenCalledWith(
      4 * tileSize,
      4 * tileSize,
      tileSize,
      tileSize,
    );
  });

  it("draws the authoritative roundabout footprint and captured ports", () => {
    const ctx = dragCtx();
    const structure = standardRoundaboutFixture();
    renderOverlays(ctx, createTestGameState(), {
      ...createUiState(),
      activeTool: "roundabout",
      hoverTile: structure.origin,
      roadPreviewGeneration: 1,
      roadMutationPreview: {
        generation: 1,
        changedTiles: structure.footprint,
        authoredTiles: [],
        generatedStructures: [structure],
        cost: 2_000,
        skippedTiles: [],
        routeImpacts: [],
        warnings: [],
        rejection: null,
      },
    });

    for (const point of structure.footprint) {
      expect(ctx.fillRect).toHaveBeenCalledWith(
        point.x * tileSize,
        point.y * tileSize,
        tileSize,
        tileSize,
      );
    }
    expect(ctx.strokeRect).toHaveBeenCalledWith(
      5 * tileSize,
      5 * tileSize,
      3 * tileSize,
      3 * tileSize,
    );
    expect(ctx.fillRect).toHaveBeenCalledWith(
      6.25 * tileSize,
      6.25 * tileSize,
      0.5 * tileSize,
      0.5 * tileSize,
    );
    expect(ctx.moveTo).toHaveBeenCalledWith(6.5 * tileSize, 5 * tileSize);
    expect(ctx.lineTo).toHaveBeenCalledWith(6.5 * tileSize, 5.25 * tileSize);
    expect(ctx.moveTo).toHaveBeenCalledWith(8 * tileSize, 6.5 * tileSize);
    expect(ctx.lineTo).toHaveBeenCalledWith(7.75 * tileSize, 6.5 * tileSize);
    expect(ctx.strokeStyle).toBe(colors.previewValidStroke);
  });

  it("uses invalid preview styling when Rust rejects the roundabout", () => {
    const ctx = dragCtx();
    const structure = standardRoundaboutFixture();
    const state = createTestGameState();
    const ui = {
      ...createUiState(),
      activeTool: "roundabout" as const,
      hoverTile: structure.origin,
      roadPreviewGeneration: 1,
      roadMutationPreview: {
        generation: 1,
        changedTiles: structure.footprint,
        authoredTiles: [],
        generatedStructures: [structure],
        cost: 2_000,
        skippedTiles: [],
        routeImpacts: [],
        warnings: [],
        rejection: {
          code: "unsafeRoundaboutPortMapping" as const,
          context: { affectedRouteIds: [] },
        },
      },
    };
    renderOverlays(ctx, state, ui);
    renderRoadPreviewFeedbackBadge(ctx, state, ui, identityTransform);

    for (const point of structure.footprint) {
      expect(ctx.fillRect).toHaveBeenCalledWith(
        point.x * tileSize,
        point.y * tileSize,
        tileSize,
        tileSize,
      );
    }
    expect(ctx.fillRect).toHaveBeenCalledWith(
      6.25 * tileSize,
      6.25 * tileSize,
      0.5 * tileSize,
      0.5 * tileSize,
    );
    expect(ctx.moveTo).toHaveBeenCalledWith(6.5 * tileSize, 5 * tileSize);
    expect(ctx.lineTo).toHaveBeenCalledWith(6.5 * tileSize, 5.25 * tileSize);
    expect(ctx.fillText).toHaveBeenCalledWith(
      "$2,000",
      expect.any(Number),
      expect.any(Number),
    );
    expect(ctx.strokeStyle).toBe(colors.previewInvalidStroke);
  });

  it("remove hover highlights the complete owned footprint", () => {
    const ctx = dragCtx();
    const structure = standardRoundaboutFixture();
    renderOverlays(ctx, createTestGameState(), {
      ...createUiState(),
      activeTool: "remove",
      hoverTile: { x: 6, y: 6 },
      roadPreviewGeneration: 1,
      roadMutationPreview: {
        generation: 1,
        changedTiles: structure.footprint,
        authoredTiles: [],
        generatedStructures: [],
        cost: 0,
        skippedTiles: [],
        routeImpacts: [],
        warnings: [],
        rejection: null,
      },
    });

    for (const point of structure.footprint) {
      expect(ctx.fillRect).toHaveBeenCalledWith(
        point.x * tileSize,
        point.y * tileSize,
        tileSize,
        tileSize,
      );
    }
  });
});

describe("local footprint previews", () => {
  it("keeps area drag footprint rendering local", () => {
    const ctx = dragCtx();
    renderOverlays(ctx, createTestGameState(), {
      ...createUiState(),
      activeTool: "area",
      selectedArea: "residential",
      drag: {
        tool: "area",
        area: "residential",
        start: { x: 1, y: 1 },
        current: { x: 2, y: 2 },
      },
    });
    expect(ctx.fillRect).toHaveBeenCalledTimes(4);
  });

  it("keeps track gesture footprint rendering local", () => {
    const ctx = dragCtx();
    renderOverlays(ctx, createTestGameState(), {
      ...createUiState(),
      activeTool: "track",
      drag: {
        tool: "track",
        start: { x: 1, y: 1 },
        current: { x: 3, y: 1 },
      },
    });
    expect(ctx.fillRect).toHaveBeenCalledTimes(3);
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
            status: "present" as const,
            position: { x: 5, y: 5 },
            platforms: [],
          },
          {
            id: "stop-002",
            kind: "busTerminal" as const,
            status: "present" as const,
            position: { x: 10, y: 10 },
            platforms: [],
          },
        ],
        stations: [
          {
            id: "station-001",
            status: "present" as const,
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

  it("does not render coverage for missing nodes", () => {
    const ctx = fakeCtx();
    const state = {
      ...createTestGameState(),
      transit: {
        ...createTestGameState().transit,
        stops: [{ ...stop, status: "missing" as const }],
      },
    };
    const ui = { ...createUiState(), activeOverlay: "coverage" as const };

    renderOverlays(ctx, state, ui);

    expect(ctx.fillRect).not.toHaveBeenCalled();
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
            actions: [
              {
                type: "paintAreaRectangle" as const,
                area: "residential" as const,
                start: { x: 5, y: 5 },
                end: { x: 6, y: 5 },
              },
            ],
          },
          {
            id: "wave-002",
            triggerTime: 200,
            message: "Wave 2",
            applied: true,
            actions: [
              {
                type: "paintAreaRectangle" as const,
                area: "commercial" as const,
                start: { x: 7, y: 5 },
                end: { x: 7, y: 5 },
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

  it("fills footprint tiles for placeBuilding actions in unapplied waves", () => {
    const ctx = fakeCtx();
    const state = {
      ...createTestGameState(),
      scenario: {
        ...createTestGameState().scenario,
        growthWaves: [
          {
            id: "wave-build",
            triggerTime: 0,
            message: "",
            applied: false,
            actions: [
              {
                type: "placeBuilding" as const,
                buildingType: "smallHouse" as const,
                origin: { x: 10, y: 5 },
                rotation: 0 as const,
              },
            ],
          },
        ],
      },
    };
    const ui = { ...createUiState(), activeOverlay: "growth" as const };
    renderOverlays(ctx, state, ui);
    // smallHouse is 2x1 at rotation 0 → tiles (10,5) and (11,5).
    expect(ctx.fillRect).toHaveBeenCalledWith(
      10 * tileSize,
      5 * tileSize,
      tileSize,
      tileSize,
    );
    expect(ctx.fillRect).toHaveBeenCalledWith(
      11 * tileSize,
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
      status: "present",
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
      status: "present",
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
      status: "present",
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
          {
            mode: "bus",
            from: { x: 3, y: 3 },
            to: { x: 9, y: 9 },
            lineId,
            serviceDirection: "loop",
            boardItineraryIndex: 0,
            alightItineraryIndex: 0,
          },
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

describe("renderOverlays building preview", () => {
  it("previews a metroStation placement over a track tile as valid", () => {
    // Exercises the metroStation branches of canPlaceBuilding (kind empty-or-
    // road, hasTrack required) via the building preview path.
    const ctx = dragCtx();
    let state = createTestGameState();
    state = withTracks(state, [{ x: 4, y: 4 }]);
    const ui = {
      ...createUiState(),
      selectedBuilding: "metroStation" as const,
      buildingRotation: 0 as const,
      hoverTile: { x: 4, y: 4 },
    };
    renderOverlays(ctx, state, ui);
    expect(ctx.fillStyle).toBe(colors.previewValid);
  });

  it("previews a metroStation placement over a track-less tile as invalid", () => {
    const ctx = dragCtx();
    const state = createTestGameState();
    const ui = {
      ...createUiState(),
      selectedBuilding: "metroStation" as const,
      buildingRotation: 0 as const,
      hoverTile: { x: 4, y: 4 },
    };
    renderOverlays(ctx, state, ui);
    expect(ctx.fillStyle).toBe(colors.previewInvalid);
  });
});

describe("renderOverlays road preview off-map", () => {
  it("uses Rust skipped tiles for an off-map stroke", () => {
    const { ctx, fillStyles } = recordingFillCtx();
    const state = createTestGameState();
    const ui = {
      ...createUiState(),
      activeTool: "road" as const,
      roadPreset: "twoWay" as const,
      drag: {
        tool: "road" as const,
        start: { x: 0, y: 0 },
        current: { x: -2, y: 0 },
      },
      roadPreviewGeneration: 1,
      roadMutationPreview: {
        generation: 1,
        changedTiles: [{ x: 0, y: 0 }],
        authoredTiles: [],
        generatedStructures: [],
        cost: 100,
        skippedTiles: [
          { x: -1, y: 0 },
          { x: -2, y: 0 },
        ],
        routeImpacts: [],
        warnings: [],
        rejection: null,
      },
    };
    renderOverlays(ctx, state, ui);
    expect(fillStyles).toContain(colors.previewInvalid);
  });
});
