import { describe, expect, it } from "vitest";
import type {
  GameState,
  RouteLegPath,
  TransitPath,
} from "../../src/domain/types";
import { buildOverlayRanges } from "../../src/render/webgpu/overlayBatch";
import {
  SOLID_VERTEX_FLOATS,
  parseColor,
} from "../../src/render/webgpu/primitives";
import { colors } from "../../src/render/colors";
import { getBuildingFootprint } from "../../src/domain/catalog/buildings";
import { createUiState } from "../../src/ui/uiState";
import { createDraft } from "../../src/ui/routeDraft";
import { createTestGameState } from "../helpers/gameState";
import { withAreas } from "../helpers/mapFixtures";
import { coveredStripFraction } from "../helpers/vertexCoverage";

const EPSILON = 1e-4;

function rowsOf(data: Float32Array): number[][] {
  const rows: number[][] = [];
  for (let offset = 0; offset < data.length; offset += SOLID_VERTEX_FLOATS) {
    rows.push(Array.from(data.slice(offset, offset + SOLID_VERTEX_FLOATS)));
  }
  return rows;
}

function hasVertexNear(
  data: Float32Array,
  css: string,
  x: number,
  y: number,
  tolerance = 0.01,
): boolean {
  const expected = Array.from(parseColor(css));
  return rowsOf(data).some(
    ([vx, vy, r, g, b, a]) =>
      Math.abs(vx - x) < tolerance &&
      Math.abs(vy - y) < tolerance &&
      [r, g, b, a].every((value, index) => {
        if (index === 3) return true; // alpha asserted separately
        return Math.abs(value - expected[index]) < EPSILON;
      }),
  );
}

function alphaAt(
  data: Float32Array,
  css: string,
  x: number,
  y: number,
): number {
  const expected = Array.from(parseColor(css));
  const row = rowsOf(data).find(
    ([vx, vy, r, g, b]) =>
      Math.abs(vx - x) < 0.01 &&
      Math.abs(vy - y) < 0.01 &&
      [r, g, b].every(
        (value, index) => Math.abs(value - expected[index]) < EPSILON,
      ),
  );
  expect(row).toBeDefined();
  return row![5];
}

function presentStop(id: string, position: { x: number; y: number }) {
  return {
    id,
    kind: "busStop" as const,
    status: "present" as const,
    position,
    platforms: [{ id: `${id}-p0`, label: "A", capacity: 50, routeIds: [] }],
  };
}

function routeLeg(
  fromWaypointId: string,
  toWaypointId: string,
  status: RouteLegPath["status"],
  lastValidPath: TransitPath | null,
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

function straightPath(): TransitPath {
  return {
    kind: "road",
    steps: [
      {
        position: { x: 1, y: 1 },
        enteringHeading: "east",
        leavingHeading: "east",
        movement: "straight",
        geometry: { kind: "line", from: { x: 1, y: 1 }, to: { x: 5, y: 1 } },
        travelSeconds: 4,
      },
    ],
    totalTravelSeconds: 4,
  };
}

function withStops(
  state: GameState,
  stops: GameState["transit"]["stops"],
): GameState {
  return { ...state, transit: { ...state.transit, stops } };
}

describe("buildOverlayRanges shape", () => {
  it("exposes exactly the three dynamic triangle ranges (no text)", () => {
    const ranges = buildOverlayRanges(createTestGameState(), createUiState());
    expect(Object.keys(ranges).sort()).toEqual([
      "overVehicles",
      "routeDraft",
      "underRoutes",
    ]);
    for (const vertices of Object.values(ranges)) {
      expect(vertices).toBeInstanceOf(Float32Array);
    }
  });
});

describe("buildOverlayRanges data overlays", () => {
  it("fills coverage areas for present stops and stations", () => {
    let state = createTestGameState();
    state = withStops(state, [presentStop("stop-1", { x: 2, y: 2 })]);
    state = {
      ...state,
      transit: {
        ...state.transit,
        stations: [
          {
            id: "station-1",
            status: "present" as const,
            position: { x: 8, y: 2 },
            platforms: [],
          },
        ],
      },
    };
    const { underRoutes } = buildOverlayRanges(state, {
      ...createUiState(),
      activeOverlay: "coverage",
    });

    // busStop radius 2: rect from (0,0) spanning 5 tiles; station radius 4
    // from its own position.
    expect(hasVertexNear(underRoutes, colors.coverage, 0, 0)).toBe(true);
    expect(hasVertexNear(underRoutes, colors.coverage, 160, 160)).toBe(true);
    expect(alphaAt(underRoutes, colors.coverage, 0, 0)).toBeCloseTo(
      parseColor(colors.coverage)[3],
      5,
    );
  });

  it("saturates repeated demand into the fill alpha", () => {
    const state = {
      ...createTestGameState(),
      demandFlow: [
        { point: { x: 5, y: 5 }, count: 1 },
        { point: { x: 6, y: 5 }, count: 3 },
      ],
    };
    const { underRoutes } = buildOverlayRanges(state, {
      ...createUiState(),
      activeOverlay: "demand",
    });

    expect(alphaAt(underRoutes, colors.demand, 160, 160)).toBeCloseTo(0.24, 5);
    expect(alphaAt(underRoutes, colors.demand, 224, 160)).toBeCloseTo(
      1 - Math.pow(0.76, 3),
      4,
    );
  });

  it("scales traffic alpha by flow", () => {
    const state = {
      ...createTestGameState(),
      trafficFlow: [{ point: { x: 5, y: 5 }, flow: 6 }],
    };
    const { underRoutes } = buildOverlayRanges(state, {
      ...createUiState(),
      activeOverlay: "traffic",
    });

    expect(alphaAt(underRoutes, colors.traffic, 160, 160)).toBeCloseTo(
      0.24 * 0.5,
      5,
    );
  });

  it("fills crowded nodes by occupancy ratio", () => {
    const base = withStops(createTestGameState(), [
      presentStop("stop-1", { x: 2, y: 2 }),
    ]);
    const crowdingUi = {
      ...createUiState(),
      activeOverlay: "crowding" as const,
    };

    const stateFull = {
      ...base,
      platformOccupancy: [{ platformId: "stop-1-p0", count: 50, capacity: 50 }],
    };
    const { underRoutes: full } = buildOverlayRanges(stateFull, crowdingUi);
    expect(alphaAt(full, colors.crowding, 64, 64)).toBeCloseTo(0.2 * 0.55, 5);

    const stateHalf = {
      ...base,
      platformOccupancy: [{ platformId: "stop-1-p0", count: 38, capacity: 50 }],
    };
    const { underRoutes: half } = buildOverlayRanges(stateHalf, crowdingUi);
    expect(alphaAt(half, colors.crowding, 64, 64)).toBeCloseTo(0.2 * 0.3, 5);
  });
});

describe("buildOverlayRanges broken route markers", () => {
  it("draws missing-node crosses and disconnected-leg dots", () => {
    const base = createTestGameState();
    const stopped = withStops(base, [
      presentStop("stop-1", { x: 1, y: 1 }),
      {
        id: "stop-gone",
        kind: "busStop" as const,
        status: "missing" as const,
        position: { x: 5, y: 5 },
        platforms: [],
      },
    ]);
    const state = {
      ...stopped,
      transit: {
        ...stopped.transit,
        routes: [
          {
            id: "route-001",
            name: "Route 1",
            color: "#e04f39",
            stopIds: ["stop-1", "stop-gone"],
            vehicleIds: [],
            active: true,
            pattern: "loop" as const,
            revision: 1,
            legs: [
              routeLeg("stop-1", "stop-gone", "missingNode", null),
              routeLeg(
                "stop-1",
                "stop-1",
                "networkDisconnected",
                straightPath(),
              ),
            ],
            pathBroken: true,
            targetHeadwaySeconds: null,
            serviceMetrics: null,
          },
        ],
      },
    };
    const { underRoutes } = buildOverlayRanges(state, {
      ...createUiState(),
      selectedRouteId: "route-001",
    });

    // Missing node at (5,5): 16px unserved box plus cross at (176,176).
    expect(hasVertexNear(underRoutes, colors.unserved, 168, 166.5)).toBe(true);
    expect(
      hasVertexNear(underRoutes, colors.unserved, 172.06, 169.94, 0.05),
    ).toBe(true);
    // Disconnected leg: last-valid midpoint (3,1) -> late dot at (112,48).
    expect(hasVertexNear(underRoutes, colors.late, 112, 48)).toBe(true);
  });
});

describe("buildOverlayRanges placement and mutation previews", () => {
  it("previews a road mutation from the matching Rust response", () => {
    const state = createTestGameState();
    const ui = {
      ...createUiState(),
      activeTool: "road" as const,
      roadPreviewGeneration: 3,
      roadMutationPreview: {
        generation: 3,
        changedTiles: [{ x: 2, y: 2 }],
        skippedTiles: [{ x: 3, y: 2 }],
        authoredTiles: [
          {
            point: { x: 2, y: 2 },
            oneWay: "east" as const,
            roadConnections: ["east" as const],
          },
        ],
        generatedStructures: [],
        cost: 200,
        routeImpacts: [],
        warnings: [],
        rejection: null,
      },
    };
    const { underRoutes } = buildOverlayRanges(state, ui);

    // Changed tile valid, skipped tile invalid.
    expect(hasVertexNear(underRoutes, colors.previewValid, 64, 64)).toBe(true);
    expect(hasVertexNear(underRoutes, colors.previewInvalid, 96, 64)).toBe(
      true,
    );
    // Authored connection stub from tile (2,2) center (80,80) to east edge.
    expect(hasVertexNear(underRoutes, colors.previewValidStroke, 96, 78)).toBe(
      true,
    );
    // One-way arrow on the authored tile (shaft spans cx ± tileSize/4).
    expect(hasVertexNear(underRoutes, colors.oneWayArrow, 88, 81)).toBe(true);
  });

  it("previews a building footprint over empty tiles", () => {
    // smallHouse requires a residential zone on every footprint tile.
    let state = createTestGameState();
    state = withAreas(state, "residential", [
      { x: 3, y: 3 },
      { x: 4, y: 3 },
    ]);
    const hoverTile = { x: 3, y: 3 };
    const { underRoutes } = buildOverlayRanges(state, {
      ...createUiState(),
      selectedBuilding: "smallHouse",
      buildingRotation: 0,
      hoverTile,
    });

    for (const point of getBuildingFootprint("smallHouse", hoverTile, 0)) {
      expect(
        hasVertexNear(
          underRoutes,
          colors.previewValid,
          point.x * 32,
          point.y * 32,
        ),
      ).toBe(true);
    }
  });

  it("previews a bus stop tint by roadside validity", () => {
    const state = createTestGameState();
    // No adjacent road -> invalid tint.
    const { underRoutes } = buildOverlayRanges(state, {
      ...createUiState(),
      activeTool: "busStop",
      hoverTile: { x: 3, y: 3 },
    });
    expect(hasVertexNear(underRoutes, colors.previewInvalid, 96, 96)).toBe(
      true,
    );

    // Adjacent bare road -> valid tint.
    const roadState = {
      ...state,
      map: {
        ...state.map,
        tiles: state.map.tiles.map((tile) =>
          tile.x === 4 && tile.y === 3
            ? {
                ...tile,
                kind: "road" as const,
                roadConnections: ["east" as const],
              }
            : tile,
        ),
      },
    };
    const { underRoutes: valid } = buildOverlayRanges(roadState, {
      ...createUiState(),
      activeTool: "busStop",
      hoverTile: { x: 3, y: 3 },
    });
    expect(hasVertexNear(valid, colors.previewValid, 96, 96)).toBe(true);
  });
});

describe("buildOverlayRanges drag gestures", () => {
  it("previews area paint tiles with per-tile validity", () => {
    const state = createTestGameState();
    const { underRoutes } = buildOverlayRanges(state, {
      ...createUiState(),
      drag: {
        tool: "area",
        area: "residential",
        start: { x: 2, y: 2 },
        current: { x: 3, y: 2 },
      },
    });

    expect(hasVertexNear(underRoutes, colors.previewValid, 64, 64)).toBe(true);
    expect(hasVertexNear(underRoutes, colors.previewValid, 96, 64)).toBe(true);
  });

  it("previews the axis-locked track gesture", () => {
    const state = createTestGameState();
    const { underRoutes } = buildOverlayRanges(state, {
      ...createUiState(),
      drag: {
        tool: "track",
        start: { x: 2, y: 2 },
        current: { x: 4, y: 3 },
      },
    });

    // Ties lock horizontal: tiles (2,2), (3,2), (4,2).
    expect(hasVertexNear(underRoutes, colors.previewValid, 64, 64)).toBe(true);
    expect(hasVertexNear(underRoutes, colors.previewValid, 128, 64)).toBe(true);
    // Interior of tile (4,3), which the horizontal tie does not cover.
    expect(hasVertexNear(underRoutes, colors.previewValid, 140, 110)).toBe(
      false,
    );
  });
});

describe("buildOverlayRanges route draft", () => {
  function draftUi(generation: number) {
    return {
      ...createUiState(),
      routeDraft: {
        ...createDraft("bus", 1),
        waypointIds: ["stop-1", "stop-2"],
        generation,
        preview: {
          generation: 1,
          legs: [
            routeLeg("stop-1", "stop-2", "networkDisconnected", straightPath()),
          ],
          totalTravelSeconds: 4,
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
  }

  it("draws the dashed draft stroke in routeDraft", () => {
    const base = withStops(createTestGameState(), [
      presentStop("stop-1", { x: 1, y: 1 }),
      presentStop("stop-2", { x: 2, y: 1 }),
    ]);
    const ui = draftUi(1);
    const { routeDraft } = buildOverlayRanges(base, ui);

    // Dash quads along (48,48) -> (176,48) in the draft yellow.
    expect(hasVertexNear(routeDraft, "#f4d35e", 48, 48, 2)).toBe(true);
    expect(hasVertexNear(routeDraft, "#f4d35e", 59, 48, 2)).toBe(true);
  });

  it("emits nothing for a stale preview generation", () => {
    const base = withStops(createTestGameState(), [
      presentStop("stop-1", { x: 1, y: 1 }),
      presentStop("stop-2", { x: 2, y: 1 }),
    ]);
    const ui = draftUi(2); // preview generation 1 is stale
    const { routeDraft } = buildOverlayRanges(base, ui);

    expect(routeDraft.length).toBe(0);
  });
});

describe("buildOverlayRanges route handles", () => {
  it("draws handle circles over vehicles and crosses for missing waypoints", () => {
    const base = withStops(createTestGameState(), [
      presentStop("stop-1", { x: 2, y: 2 }),
      {
        id: "stop-gone",
        kind: "busStop" as const,
        status: "missing" as const,
        position: { x: 5, y: 5 },
        platforms: [],
      },
    ]);
    const ui = {
      ...createUiState(),
      routeDraft: {
        ...createDraft("bus", 1),
        waypointIds: ["stop-1", "stop-gone"],
      },
    };
    const { overVehicles } = buildOverlayRanges(base, ui);

    // Present waypoint: filled badge circle at (80,80), stroked ring band
    // spanning radii 9..11.
    expect(hasVertexNear(overVehicles, colors.badgeBackground, 80, 80)).toBe(
      true,
    );
    expect(hasVertexNear(overVehicles, colors.badgeText, 91, 80)).toBe(true);
    // Missing waypoint: cross over the handle at (176,176).
    expect(hasVertexNear(overVehicles, colors.unserved, 170, 170, 2)).toBe(
      true,
    );
  });

  it("dashes the missing-waypoint ring", () => {
    const base = withStops(createTestGameState(), [
      presentStop("stop-1", { x: 2, y: 2 }),
      {
        id: "stop-gone",
        kind: "busStop" as const,
        status: "missing" as const,
        position: { x: 5, y: 5 },
        platforms: [],
      },
    ]);
    const ui = {
      ...createUiState(),
      routeDraft: {
        ...createDraft("bus", 1),
        waypointIds: ["stop-1", "stop-gone"],
      },
    };
    const { overVehicles } = buildOverlayRanges(base, ui);

    // Canvas dashes the missing ring [4,3]; a solid ring covers everything.
    // The canvas arc sits at radius 10 (band 9..11) — probe its centerline.
    const covered = coveredStripFraction(overVehicles, colors.unserved, {
      kind: "arc",
      center: { x: 176, y: 176 },
      radius: 10,
      startRadians: 0,
      sweepRadians: Math.PI * 2,
    });
    expect(covered).toBeGreaterThan(0.3);
    expect(covered).toBeLessThan(0.95);
  });
});
