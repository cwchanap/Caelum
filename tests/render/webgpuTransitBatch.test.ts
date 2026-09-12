import { describe, expect, it } from "vitest";
import type {
  GameState,
  PathGeometry,
  RouteLegPath,
  TransitPath,
} from "../../src/domain/types";
import {
  buildTransitBatch,
  draftLegVertices,
} from "../../src/render/webgpu/transitBatch";
import {
  SOLID_VERTEX_FLOATS,
  parseColor,
} from "../../src/render/webgpu/primitives";
import { UNRELATED_ROUTE_OPACITY } from "../../src/render/webgpu/transitBatch";
import { colors } from "../../src/render/colors";
import { createUiState } from "../../src/ui/uiState";
import { createDraft } from "../../src/ui/routeDraft";
import { createTestGameState } from "../helpers/gameState";
import { coveredStripFraction } from "../helpers/vertexCoverage";

const EPSILON = 1e-4;

function rowsOf(data: Float32Array): number[][] {
  const rows: number[][] = [];
  for (let offset = 0; offset < data.length; offset += SOLID_VERTEX_FLOATS) {
    rows.push(Array.from(data.slice(offset, offset + SOLID_VERTEX_FLOATS)));
  }
  return rows;
}

function colorOf(css: string): number[] {
  return Array.from(parseColor(css));
}

function sameColor(row: number[], css: string): boolean {
  const expected = colorOf(css);
  return row
    .slice(2, 6)
    .every((value, index) => Math.abs(value - expected[index]) < EPSILON);
}

function verticesOfColor(data: Float32Array, css: string): number[][] {
  return rowsOf(data).filter((row) => sameColor(row, css));
}

function hasVertexNear(
  data: Float32Array,
  css: string,
  x: number,
  y: number,
  tolerance = 0.01,
): boolean {
  return verticesOfColor(data, css).some(
    ([vx, vy]) => Math.abs(vx - x) < tolerance && Math.abs(vy - y) < tolerance,
  );
}

function alphasOfColor(data: Float32Array, css: string): number[] {
  // Match on RGB only so dimmed (alpha-scaled) vertices still report.
  const rgb = colorOf(css).slice(0, 3);
  const alphas = rowsOf(data)
    .filter((row) =>
      row
        .slice(2, 5)
        .every((value, index) => Math.abs(value - rgb[index]) < EPSILON),
    )
    .map((row) => row[5]);
  return [...new Set(alphas)];
}

/** Straight tile-space road path along y=1 from (1,1) to (5,1). */
function linePath(): TransitPath {
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
    failureReason: null,
  };
}

function stateWithLegs(
  legs: RouteLegPath[],
  stopPositions: { x: number; y: number }[] = [
    { x: 1, y: 1 },
    { x: 2, y: 1 },
  ],
): GameState {
  const base = createTestGameState();
  return {
    ...base,
    transit: {
      ...base.transit,
      stops: ["a", "b"].map((id, index) => ({
        id,
        kind: "busStop" as const,
        status: "present" as const,
        position: stopPositions[index],
        platforms: [],
      })),
      routes: [
        {
          id: "route-001",
          name: "Route 1",
          color: "#e04f39",
          stopIds: ["a", "b"],
          vehicleIds: [],
          active: true,
          pattern: "loop" as const,
          revision: 1,
          legs,
          pathBroken: legs.some((leg) => leg.status !== "connected"),
          targetHeadwaySeconds: null,
          serviceMetrics: null,
        },
      ],
    },
  };
}

function emptyLineDraft() {
  return { ...createDraft("bus", 1) };
}

/** Curved corner step (1,1) -> control (3,1) -> (3,3); stops sit on the
 *  curve endpoints so no endpoint connectors muddy the strip. */
function cornerPath(): TransitPath {
  return {
    kind: "road",
    steps: [
      {
        position: { x: 1, y: 1 },
        enteringHeading: "east",
        leavingHeading: "south",
        movement: "rightTurn",
        geometry: {
          kind: "quadraticBezier",
          from: { x: 1, y: 1 },
          control: { x: 3, y: 1 },
          to: { x: 3, y: 3 },
        },
        travelSeconds: 4,
      },
    ],
    totalTravelSeconds: 4,
  };
}

function pixelCorner(): PathGeometry {
  return {
    kind: "quadraticBezier",
    from: { x: 48, y: 48 },
    control: { x: 112, y: 48 },
    to: { x: 112, y: 112 },
  };
}

/** Render-only roundabout-style arc: quarter circle around (2,2), r=1. */
function arcPath(): TransitPath {
  return {
    kind: "road",
    steps: [
      {
        position: { x: 2, y: 2 },
        enteringHeading: "east",
        leavingHeading: "south",
        movement: "rightTurn",
        geometry: {
          kind: "arc",
          center: { x: 2, y: 2 },
          radius: 1,
          startRadians: 0,
          sweepRadians: Math.PI / 2,
        },
        travelSeconds: 4,
      },
    ],
    totalTravelSeconds: 4,
  };
}

function pixelArc(): PathGeometry {
  return {
    kind: "arc",
    center: { x: 80, y: 80 },
    radius: 32,
    startRadians: 0,
    sweepRadians: Math.PI / 2,
  };
}

describe("buildTransitBatch route style key", () => {
  it("encodes scene revision, selected route, and edited route", () => {
    const state = stateWithLegs([routeLeg("a", "b", "connected", linePath())]);
    const base = buildTransitBatch(state, createUiState(), 7);
    expect(base.routeStyleKey).toBe("routes:7:-:-");

    expect(
      buildTransitBatch(
        state,
        { ...createUiState(), selectedRouteId: "route-001" },
        7,
      ).routeStyleKey,
    ).toBe("routes:7:route-001:-");

    const editing = {
      ...createUiState(),
      routeDraft: {
        ...emptyLineDraft(),
        source: {
          kind: "edit" as const,
          routeId: "route-001",
          expectedRevision: 1,
        },
      },
    };
    expect(buildTransitBatch(state, editing, 7).routeStyleKey).toBe(
      "routes:7:-:route-001",
    );
    expect(
      buildTransitBatch(state, { ...editing, selectedRouteId: "route-001" }, 8)
        .routeStyleKey,
    ).toBe("routes:8:route-001:route-001");
  });
});

describe("buildTransitBatch committed legs", () => {
  it("draws bus legs at width 5 with the route color", () => {
    const state = stateWithLegs([routeLeg("a", "b", "connected", linePath())]);
    const { vertices } = buildTransitBatch(state, createUiState(), 1);

    // Pixel path (48,48) -> (176,48); width 5 puts corners at y 45.5/50.5.
    expect(hasVertexNear(vertices, "#e04f39", 48, 45.5)).toBe(true);
    expect(hasVertexNear(vertices, "#e04f39", 176, 50.5)).toBe(true);
    expect(hasVertexNear(vertices, "#e04f39", 48, 43.5)).toBe(false);
  });

  it("draws metro legs at width 8 with the line color", () => {
    const base = createTestGameState();
    const trackPath: TransitPath = {
      kind: "track",
      steps: [
        {
          position: { x: 1, y: 1 },
          heading: "east",
          geometry: { kind: "line", from: { x: 1, y: 1 }, to: { x: 5, y: 1 } },
          travelSeconds: 2,
        },
      ],
      totalTravelSeconds: 2,
    };
    const state = {
      ...base,
      transit: {
        ...base.transit,
        stations: [
          {
            id: "station-a",
            status: "present" as const,
            position: { x: 1, y: 1 },
            platforms: [],
          },
        ],
        metroLines: [
          {
            id: "metro-001",
            name: "Metro 1",
            color: "#3355aa",
            stationIds: ["station-a"],
            vehicleIds: [],
            active: true,
            pattern: "loop" as const,
            revision: 1,
            legs: [routeLeg("station-a", "station-a", "connected", trackPath)],
            pathBroken: false,
            targetHeadwaySeconds: null,
            serviceMetrics: null,
          },
        ],
      },
    };
    const { vertices } = buildTransitBatch(state, createUiState(), 1);

    expect(hasVertexNear(vertices, "#3355aa", 48, 44)).toBe(true);
    expect(hasVertexNear(vertices, "#3355aa", 176, 52)).toBe(true);
  });

  it("offsets shared corridors per route", () => {
    const base = stateWithLegs([routeLeg("a", "b", "connected", linePath())]);
    const route = { ...base.transit.routes[0] };
    const state = {
      ...base,
      transit: {
        ...base.transit,
        routes: [
          { ...route, id: "route-0002", color: "#222222" },
          { ...route, id: "route-0001", color: "#111111" },
        ],
      },
    };
    const { vertices } = buildTransitBatch(state, createUiState(), 1);

    // Sorted ids get offsets -2px and +2px around the shared corridor at
    // y=48: strokes land on y 46 and 50.
    expect(hasVertexNear(vertices, "#111111", 48, 43.5)).toBe(true);
    expect(hasVertexNear(vertices, "#222222", 48, 47.5)).toBe(true);
  });

  it("draws last-valid geometry dotted and current geometry solid", () => {
    const state = stateWithLegs([
      routeLeg("a", "b", "networkDisconnected", linePath()),
    ]);
    const { vertices } = buildTransitBatch(state, createUiState(), 1);

    // The 128px path with dash [6,5] starts a new dash quad every 11px,
    // leaving gaps the solid stroke would not have.
    const xs = new Set(verticesOfColor(vertices, "#e04f39").map(([x]) => x));
    expect(xs.has(48)).toBe(true);
    expect(xs.has(54)).toBe(true); // end of the first dash
    expect(xs.has(59)).toBe(true); // start of the second dash, after a gap
  });

  it("dashes a broken leg's curved corner step with on/off gaps", () => {
    const state = stateWithLegs(
      [routeLeg("a", "b", "networkDisconnected", cornerPath())],
      [
        { x: 1, y: 1 },
        { x: 3, y: 3 },
      ],
    );
    const { vertices } = buildTransitBatch(state, createUiState(), 1);

    // A solid strip covers the whole centerline; dash [6,5] leaves gaps.
    const covered = coveredStripFraction(vertices, "#e04f39", pixelCorner());
    expect(covered).toBeGreaterThan(0.3);
    expect(covered).toBeLessThan(0.95);
  });

  it("dashes a broken leg's arc step with on/off gaps", () => {
    const state = stateWithLegs(
      [routeLeg("a", "b", "networkDisconnected", arcPath())],
      [
        { x: 1, y: 1 },
        { x: 1, y: 3 },
      ],
    );
    const { vertices } = buildTransitBatch(state, createUiState(), 1);

    const covered = coveredStripFraction(vertices, "#e04f39", pixelArc());
    expect(covered).toBeGreaterThan(0.3);
    expect(covered).toBeLessThan(0.95);
  });

  it("uses a direct dotted fallback when no last-valid geometry exists", () => {
    const state = stateWithLegs([
      routeLeg("a", "b", "networkDisconnected", null),
    ]);
    const { vertices } = buildTransitBatch(state, createUiState(), 1);

    // Direct line between stop centers (48,48) -> (80,48).
    expect(hasVertexNear(vertices, "#e04f39", 48, 48, 3)).toBe(true);
    expect(hasVertexNear(vertices, "#e04f39", 59, 48, 3)).toBe(true);
  });

  it("bridges off-road stops with endpoint connectors", () => {
    const base = createTestGameState();
    const path: TransitPath = {
      kind: "road",
      steps: [
        {
          position: { x: 2, y: 1 },
          enteringHeading: "east",
          leavingHeading: "east",
          movement: "straight",
          geometry: { kind: "line", from: { x: 2, y: 1 }, to: { x: 5, y: 1 } },
          travelSeconds: 3,
        },
      ],
      totalTravelSeconds: 3,
    };
    const state = {
      ...base,
      transit: {
        ...base.transit,
        stops: [
          {
            id: "stop-a",
            kind: "busStop" as const,
            status: "present" as const,
            position: { x: 1, y: 1 },
            platforms: [],
          },
        ],
        routes: [
          {
            id: "route-001",
            name: "Route 1",
            color: "#e04f39",
            stopIds: ["stop-a"],
            vehicleIds: [],
            active: true,
            pattern: "loop" as const,
            revision: 1,
            legs: [routeLeg("stop-a", "stop-a", "connected", path)],
            pathBroken: false,
            targetHeadwaySeconds: null,
            serviceMetrics: null,
          },
        ],
      },
    };
    const { vertices } = buildTransitBatch(state, createUiState(), 1);

    // Connector from the off-road stop (48,48) to the path start (80,48).
    expect(hasVertexNear(vertices, "#e04f39", 48, 45.5)).toBe(true);
    expect(hasVertexNear(vertices, "#e04f39", 80, 50.5)).toBe(true);
  });
});

describe("buildTransitBatch emphasis", () => {
  it("draws a white halo under emphasized routes", () => {
    const state = stateWithLegs([routeLeg("a", "b", "connected", linePath())]);
    const { vertices } = buildTransitBatch(
      state,
      { ...createUiState(), selectedRouteId: "route-001" },
      1,
    );

    // Halo width = 5 + 4; corners at y 48 ± 4.5. Halo color is #ffffffaa.
    expect(hasVertexNear(vertices, "#ffffffaa", 48, 43.5)).toBe(true);
    expect(hasVertexNear(vertices, "#ffffffaa", 176, 52.5)).toBe(true);
  });

  it("draws the halo under an edited but unselected route", () => {
    const state = stateWithLegs([routeLeg("a", "b", "connected", linePath())]);
    const editing = {
      ...createUiState(),
      routeDraft: {
        ...emptyLineDraft(),
        source: {
          kind: "edit" as const,
          routeId: "route-001",
          expectedRevision: 1,
        },
      },
    };
    const { vertices } = buildTransitBatch(state, editing, 1);

    expect(hasVertexNear(vertices, "#ffffffaa", 48, 43.5)).toBe(true);
    expect(hasVertexNear(vertices, "#ffffffaa", 176, 52.5)).toBe(true);
  });

  it("dims unrelated routes with UNRELATED_ROUTE_OPACITY", () => {
    const base = stateWithLegs([routeLeg("a", "b", "connected", linePath())]);
    const route = { ...base.transit.routes[0] };
    const state = {
      ...base,
      transit: {
        ...base.transit,
        routes: [
          { ...route, id: "route-0002", color: "#222222" },
          { ...route, id: "route-0001", color: "#111111" },
        ],
      },
    };
    const { vertices } = buildTransitBatch(
      state,
      { ...createUiState(), selectedRouteId: "route-0002" },
      1,
    );

    expect(alphasOfColor(vertices, "#222222")).toEqual([1]);
    const dimmedAlphas = alphasOfColor(vertices, "#111111");
    expect(dimmedAlphas).toHaveLength(1);
    expect(dimmedAlphas[0]).toBeCloseTo(UNRELATED_ROUTE_OPACITY, 5);
  });

  it("draws direction arrows only for emphasized routes", () => {
    const state = stateWithLegs([routeLeg("a", "b", "connected", linePath())]);

    const selected = buildTransitBatch(
      state,
      { ...createUiState(), selectedRouteId: "route-001" },
      1,
    ).vertices;
    // First arrow tip sits 6px ahead of the sample at tile (2.5,1).
    expect(hasVertexNear(selected, "#e04f39", 96 + 6, 48)).toBe(true);

    const unselected = buildTransitBatch(state, createUiState(), 1).vertices;
    expect(hasVertexNear(unselected, "#e04f39", 96 + 6, 48)).toBe(false);
  });
});

describe("buildTransitBatch nodes and cues", () => {
  it("draws stop squares and station circles", () => {
    const base = createTestGameState();
    const state = {
      ...base,
      transit: {
        ...base.transit,
        stops: [
          {
            id: "stop-1",
            kind: "busStop" as const,
            status: "present" as const,
            position: { x: 2, y: 2 },
            platforms: [],
          },
        ],
        stations: [
          {
            id: "station-1",
            status: "present" as const,
            position: { x: 4, y: 2 },
            platforms: [],
          },
        ],
      },
    };
    const { vertices } = buildTransitBatch(state, createUiState(), 1);

    // Stop square (80,80) ± 5.
    expect(hasVertexNear(vertices, colors.bus, 75, 75)).toBe(true);
    // Station circle fan centered at (144,80) with radius 8.
    expect(hasVertexNear(vertices, colors.metro, 144, 80)).toBe(true);
  });

  it("draws the passenger-to-road access indicator", () => {
    const base = createTestGameState();
    const state = {
      ...base,
      transit: {
        ...base.transit,
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
    const { vertices } = buildTransitBatch(state, createUiState(), 1);

    // Indicator stroke (144,144) -> (144,176) plus arrowhead at the road end.
    expect(hasVertexNear(vertices, colors.hover, 143, 144)).toBe(true);
    expect(hasVertexNear(vertices, colors.hover, 144, 176)).toBe(true);
  });

  it("draws route node cues on the presented path", () => {
    const state = stateWithLegs([routeLeg("a", "b", "connected", linePath())]);
    const { vertices } = buildTransitBatch(state, createUiState(), 1);

    // Cue circle at stop a's center (48,48), radius 3, route color.
    expect(hasVertexNear(vertices, "#e04f39", 48, 48)).toBe(true);
  });
});

describe("buildTransitBatch draft stroke", () => {
  it("dashes curved draft steps", () => {
    const state = stateWithLegs(
      [routeLeg("a", "b", "connected", cornerPath())],
      [
        { x: 1, y: 1 },
        { x: 3, y: 3 },
      ],
    );
    const ui = {
      ...createUiState(),
      routeDraft: {
        ...emptyLineDraft(),
        generation: 1,
        preview: {
          generation: 1,
          legs: [routeLeg("a", "b", "connected", cornerPath())],
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
    const vertices = draftLegVertices(state, ui);

    // Draft dash [6,6]: half the centerline is covered, with gaps.
    const covered = coveredStripFraction(vertices, "#f4d35e", pixelCorner());
    expect(covered).toBeGreaterThan(0.3);
    expect(covered).toBeLessThan(0.95);
  });
});

describe("buildTransitBatch scope", () => {
  it("emits no draft geometry — drafts belong to the routeDraft range", () => {
    const state = stateWithLegs([routeLeg("a", "b", "connected", linePath())]);
    const ui = {
      ...createUiState(),
      routeDraft: {
        ...emptyLineDraft(),
        generation: 1,
        preview: {
          generation: 1,
          legs: state.transit.routes[0].legs,
          totalTravelSeconds: 1,
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
    const { vertices } = buildTransitBatch(state, ui, 1);

    expect(verticesOfColor(vertices, "#f4d35e")).toEqual([]);
  });
});
