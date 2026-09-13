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
import { withAreas, withRoads } from "../helpers/mapFixtures";
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

  it("skips non-present stops and stations in the coverage overlay", () => {
    const base = withStops(createTestGameState(), [
      {
        id: "stop-gone",
        kind: "busStop" as const,
        status: "missing" as const,
        position: { x: 2, y: 2 },
        platforms: [],
      },
    ]);
    const state = {
      ...base,
      transit: {
        ...base.transit,
        stations: [
          {
            id: "station-gone",
            status: "missing" as const,
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

    expect(underRoutes.length).toBe(0);
  });

  it("skips crowding fills below the threshold and for unmeasured platforms", () => {
    const base = withStops(createTestGameState(), [
      presentStop("stop-low", { x: 2, y: 2 }),
      presentStop("stop-quiet", { x: 5, y: 2 }),
      presentStop("stop-silent", { x: 8, y: 2 }),
    ]);
    const state = {
      ...base,
      platformOccupancy: [
        // 40% occupancy: below the 0.5 cutoff -> no fill.
        { platformId: "stop-low-p0", count: 20, capacity: 50 },
        // Zero-capacity row contributes no ratio.
        { platformId: "stop-quiet-p0", count: 0, capacity: 0 },
        // stop-silent's platform has no occupancy row at all.
      ],
    };
    const { underRoutes } = buildOverlayRanges(state, {
      ...createUiState(),
      activeOverlay: "crowding",
    });

    expect(underRoutes.length).toBe(0);
  });
});

describe("buildOverlayRanges broken route markers", () => {
  it("draws markers for a selected metro line and enlarges the focused leg", () => {
    const base = withStops(createTestGameState(), []);
    const state = {
      ...base,
      transit: {
        ...base.transit,
        stations: [
          {
            id: "station-1",
            status: "present" as const,
            position: { x: 2, y: 2 },
            platforms: [],
          },
          {
            id: "station-gone",
            status: "missing" as const,
            position: { x: 6, y: 6 },
            platforms: [],
          },
        ],
        metroLines: [
          {
            id: "metro-001",
            name: "Metro 1",
            color: "#3355aa",
            stationIds: ["station-1", "station-gone"],
            vehicleIds: [],
            active: true,
            pattern: "loop" as const,
            revision: 1,
            legs: [
              routeLeg("station-1", "station-gone", "missingNode", null),
              routeLeg(
                "station-gone",
                "station-1",
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

    const { underRoutes: plain } = buildOverlayRanges(state, {
      ...createUiState(),
      selectedRouteId: "metro-001",
    });
    // Metro leg markers resolve through the same failed-leg anchors: the
    // missing-station cross sits at (6,6) and the disconnected leg falls
    // back to the last-valid path midpoint (3,1) -> (112,48).
    expect(hasVertexNear(plain, colors.unserved, 200, 198.5)).toBe(true);
    // Unfocused disconnected leg: radius-6 dot has no vertex at r=8 (120,48).
    expect(hasVertexNear(plain, colors.late, 120, 48)).toBe(false);

    const { underRoutes: focused } = buildOverlayRanges(state, {
      ...createUiState(),
      selectedRouteId: "metro-001",
      routeFailureFocus: { routeId: "metro-001", legIndex: 1 },
    });
    // Focused leg grows to radius 8: exact rim vertex at (112+8, 48).
    expect(hasVertexNear(focused, colors.late, 120, 48)).toBe(true);
  });

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

  it("emits nothing when the selected id matches no route or metro line", () => {
    const { underRoutes } = buildOverlayRanges(createTestGameState(), {
      ...createUiState(),
      selectedRouteId: "route-404",
    });

    expect(underRoutes.length).toBe(0);
  });

  it("skips a failed leg whose marker has no anchor", () => {
    // Both waypoints left the network entirely: failedLegMarkerPoint has no
    // position to anchor on, so no marker is emitted.
    const base = withStops(createTestGameState(), []);
    const state = {
      ...base,
      transit: {
        ...base.transit,
        routes: [
          {
            id: "route-001",
            name: "Route 1",
            color: "#e04f39",
            stopIds: ["ghost-a", "ghost-b"],
            vehicleIds: [],
            active: true,
            pattern: "loop" as const,
            revision: 1,
            legs: [routeLeg("ghost-a", "ghost-b", "missingNode", null)],
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

    expect(underRoutes.length).toBe(0);
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

  it("previews a generated roundabout: ring fill, island, and port ticks", () => {
    const state = createTestGameState();
    // 3x3 roundabout at origin (4,4): footprint is the eight carriageway
    // tiles around the protected center; one port per edge.
    const ring = [
      { x: 4, y: 4 },
      { x: 5, y: 4 },
      { x: 6, y: 4 },
      { x: 4, y: 5 },
      { x: 6, y: 5 },
      { x: 4, y: 6 },
      { x: 5, y: 6 },
      { x: 6, y: 6 },
    ];
    const ui = {
      ...createUiState(),
      activeTool: "roundabout" as const,
      roadPreviewGeneration: 1,
      roadMutationPreview: {
        generation: 1,
        // (4,4) is both a changed tile and footprint tile: it is filled once
        // via the changed pass and skipped in the structure fill.
        changedTiles: [{ x: 4, y: 4 }],
        skippedTiles: [],
        authoredTiles: [],
        generatedStructures: [
          {
            kind: "roundabout" as const,
            id: "rb-1",
            origin: { x: 4, y: 4 },
            size: "standard3x3" as const,
            footprint: ring,
            ports: [
              { id: "p-n", point: { x: 5, y: 4 }, edge: "north" as const },
              { id: "p-e", point: { x: 6, y: 5 }, edge: "east" as const },
              { id: "p-s", point: { x: 5, y: 6 }, edge: "south" as const },
              { id: "p-w", point: { x: 4, y: 5 }, edge: "west" as const },
            ],
          },
        ],
        cost: 800,
        routeImpacts: [],
        warnings: [],
        rejection: null,
      },
    };
    const { underRoutes } = buildOverlayRanges(state, ui);

    // Ring tiles filled valid — both the changed (4,4) and fill-only (5,4).
    expect(hasVertexNear(underRoutes, colors.previewValid, 128, 128)).toBe(
      true,
    );
    expect(hasVertexNear(underRoutes, colors.previewValid, 160, 128)).toBe(
      true,
    );
    // Footprint tiles keep the structure bounding stroke instead of the
    // per-tile preview stroke: the bounding box runs 128..224 px, so its
    // left edge has quad corners at x=128±1.5.
    expect(
      hasVertexNear(underRoutes, colors.previewValidStroke, 126.5, 128),
    ).toBe(true);
    // Protected island: a badge-colored square at origin+1.25 tiles.
    expect(hasVertexNear(underRoutes, colors.badgeBackground, 168, 168)).toBe(
      true,
    );
    // Port ticks: north (5,4)->(176,128) down; west (4,5)->(128,176) right.
    expect(
      hasVertexNear(underRoutes, colors.previewValidStroke, 177.5, 128),
    ).toBe(true);
    expect(
      hasVertexNear(underRoutes, colors.previewValidStroke, 128, 177.5),
    ).toBe(true);
  });

  it("previews a compact roundabout without the protected island", () => {
    const state = createTestGameState();
    const ui = {
      ...createUiState(),
      activeTool: "roundabout" as const,
      roadPreviewGeneration: 1,
      roadMutationPreview: {
        generation: 1,
        changedTiles: [],
        skippedTiles: [],
        authoredTiles: [],
        generatedStructures: [
          {
            kind: "roundabout" as const,
            id: "rb-1",
            origin: { x: 4, y: 4 },
            size: "compact2x2" as const,
            footprint: [
              { x: 4, y: 4 },
              { x: 5, y: 4 },
              { x: 4, y: 5 },
              { x: 5, y: 5 },
            ],
            ports: [
              { id: "p-n", point: { x: 4, y: 4 }, edge: "north" as const },
            ],
          },
        ],
        cost: 400,
        routeImpacts: [],
        warnings: [],
        rejection: null,
      },
    };
    const { underRoutes } = buildOverlayRanges(state, ui);

    expect(hasVertexNear(underRoutes, colors.previewValid, 128, 128)).toBe(
      true,
    );
    // Compact roundabouts have no protected center tile: no badge-colored
    // island anywhere in the range.
    expect(
      rowsOf(underRoutes).some(([, , r, g, b]) =>
        Array.from(parseColor(colors.badgeBackground))
          .slice(0, 3)
          .every((v, i) => Math.abs([r, g, b][i] - v) < EPSILON),
      ),
    ).toBe(false);
  });

  it("tints generated structures invalid when the preview is rejected", () => {
    const state = createTestGameState();
    const ui = {
      ...createUiState(),
      activeTool: "roundabout" as const,
      roadPreviewGeneration: 1,
      roadMutationPreview: {
        generation: 1,
        changedTiles: [],
        skippedTiles: [],
        authoredTiles: [],
        generatedStructures: [
          {
            kind: "roundabout" as const,
            id: "rb-1",
            origin: { x: 4, y: 4 },
            size: "standard3x3" as const,
            footprint: [
              { x: 4, y: 4 },
              { x: 5, y: 4 },
              { x: 6, y: 4 },
              { x: 4, y: 5 },
              { x: 6, y: 5 },
              { x: 4, y: 6 },
              { x: 5, y: 6 },
              { x: 6, y: 6 },
            ],
            ports: [
              { id: "p-s", point: { x: 5, y: 6 }, edge: "south" as const },
            ],
          },
          {
            kind: "automaticJunction" as const,
            id: "jx-1",
            footprint: [{ x: 8, y: 8 }],
            ports: [],
          },
        ],
        cost: 800,
        routeImpacts: [],
        warnings: [],
        rejection: { code: "insufficientBudget" as const, context: {} },
      },
    };
    const { underRoutes } = buildOverlayRanges(state, ui);

    expect(hasVertexNear(underRoutes, colors.previewInvalid, 128, 128)).toBe(
      true,
    );
    // South port tick at (5,6): center (176,208) downward-then-up tick uses
    // the invalid stroke color.
    expect(
      hasVertexNear(underRoutes, colors.previewInvalidStroke, 177.5, 224),
    ).toBe(true);
    // The rejected junction footprint also tints invalid: fill and stroke.
    expect(hasVertexNear(underRoutes, colors.previewInvalid, 256, 256)).toBe(
      true,
    );
    // strokeTile insets the rect by 2 and thickLine offsets corners ±1 along
    // the normal: top-left quad corner at (258, 257).
    expect(
      hasVertexNear(underRoutes, colors.previewInvalidStroke, 258, 257),
    ).toBe(true);
  });

  it("previews non-roundabout generated structures as filled tiles", () => {
    const state = createTestGameState();
    const ui = {
      ...createUiState(),
      activeTool: "road" as const,
      roadPreviewGeneration: 1,
      roadMutationPreview: {
        generation: 1,
        changedTiles: [],
        skippedTiles: [],
        authoredTiles: [],
        generatedStructures: [
          {
            kind: "automaticJunction" as const,
            id: "jx-1",
            footprint: [{ x: 3, y: 3 }],
            ports: [],
          },
        ],
        cost: 0,
        routeImpacts: [],
        warnings: [],
        rejection: null,
      },
    };
    const { underRoutes } = buildOverlayRanges(state, ui);

    expect(hasVertexNear(underRoutes, colors.previewValid, 96, 96)).toBe(true);
    // Junction tiles also get the per-tile stroke inset by 2px.
    expect(hasVertexNear(underRoutes, colors.previewValidStroke, 98, 99)).toBe(
      true,
    );
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

  it("tints the building footprint invalid on unplaceable tiles", () => {
    // smallHouse needs residential zoning; bare tiles tint invalid.
    const { underRoutes } = buildOverlayRanges(createTestGameState(), {
      ...createUiState(),
      selectedBuilding: "smallHouse",
      buildingRotation: 0,
      hoverTile: { x: 3, y: 3 },
    });

    expect(hasVertexNear(underRoutes, colors.previewInvalid, 96, 96)).toBe(
      true,
    );
    // Inset stroke: top-left quad corner at (98, 97).
    expect(
      hasVertexNear(underRoutes, colors.previewInvalidStroke, 98, 97),
    ).toBe(true);
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

  it("tints unpaintable tiles invalid in the area drag preview", () => {
    // The drag rect spans an empty tile and a road tile; the road is not
    // paintable and gets the invalid fill/stroke.
    const state = withRoads(createTestGameState(), [{ x: 3, y: 2 }]);
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
    expect(hasVertexNear(underRoutes, colors.previewInvalid, 96, 64)).toBe(
      true,
    );
    // Inset stroke: top-left quad corner at (98, 65).
    expect(
      hasVertexNear(underRoutes, colors.previewInvalidStroke, 98, 65),
    ).toBe(true);
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

  it("dashes the missing-waypoint cross", () => {
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

    // Canvas dashes the missing cross [4,3]; a solid cross covers
    // everything. Probe the (170,170)->(182,182) diagonal centerline.
    const covered = coveredStripFraction(overVehicles, colors.unserved, {
      kind: "line",
      from: { x: 170, y: 170 },
      to: { x: 182, y: 182 },
    });
    expect(covered).toBeGreaterThan(0.3);
    expect(covered).toBeLessThan(0.95);
  });

  it("enlarges the selected waypoint handle", () => {
    const base = withStops(createTestGameState(), [
      presentStop("stop-1", { x: 2, y: 2 }),
    ]);
    const ui = {
      ...createUiState(),
      routeDraft: {
        ...createDraft("bus", 1),
        waypointIds: ["stop-1"],
        selectedIndex: 0,
      },
    };
    const { overVehicles } = buildOverlayRanges(base, ui);

    // Selected handle: radius 12 fill (rim vertex at 80+12) and a 4px ring
    // band centered at radius 13 -> outer edge vertex at 80+14.
    expect(hasVertexNear(overVehicles, colors.badgeBackground, 92, 80)).toBe(
      true,
    );
    expect(hasVertexNear(overVehicles, colors.badgeText, 94, 80)).toBe(true);
  });

  it("skips draft waypoints whose node left the network", () => {
    const base = withStops(createTestGameState(), [
      presentStop("stop-1", { x: 2, y: 2 }),
    ]);
    const draftWith = (waypointIds: string[]) => ({
      ...createUiState(),
      routeDraft: { ...createDraft("bus", 1), waypointIds },
    });
    const withGhost = buildOverlayRanges(
      base,
      draftWith(["stop-1", "ghost-stop"]),
    ).overVehicles;
    const withoutGhost = buildOverlayRanges(
      base,
      draftWith(["stop-1"]),
    ).overVehicles;

    // The unresolvable waypoint emits no geometry — identical to omitting it.
    expect(withGhost.length).toBe(withoutGhost.length);
    expect(hasVertexNear(withGhost, colors.badgeBackground, 80, 80)).toBe(true);
  });
});
