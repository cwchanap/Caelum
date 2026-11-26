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
import { SPRITE_INSTANCE_FLOATS } from "../../src/render/gameplayRenderer";
import { TRANSIT_SPRITE_LAYERS } from "../../src/render/webgpu/spriteAtlas";
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

function markerRow(
  data: Float32Array,
  x: number,
  y: number,
  layer: number,
): number[] {
  for (let i = 0; i < data.length; i += SPRITE_INSTANCE_FLOATS) {
    const row = Array.from(data.slice(i, i + SPRITE_INSTANCE_FLOATS));
    if (row[0] === x && row[1] === y && row[7] === layer) return row;
  }
  throw new Error(`missing marker at ${x},${y} layer ${layer}`);
}

function expectTint(row: number[], color: string, alpha = 1): void {
  const expected = parseColor(color);
  [...expected.slice(0, 3), alpha].forEach((value, i) =>
    expect(row[8 + i]).toBeCloseTo(value, 5),
  );
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

function cornerJointPath(): TransitPath {
  return {
    kind: "road",
    steps: [
      {
        position: { x: 1, y: 1 },
        enteringHeading: "east",
        leavingHeading: "east",
        movement: "straight",
        geometry: { kind: "line", from: { x: 1, y: 1 }, to: { x: 2, y: 1 } },
        travelSeconds: 1.25,
      },
      {
        position: { x: 2, y: 1 },
        enteringHeading: "east",
        leavingHeading: "south",
        movement: "rightTurn",
        geometry: { kind: "line", from: { x: 2, y: 1 }, to: { x: 2, y: 2 } },
        travelSeconds: 1.75,
      },
    ],
    totalTravelSeconds: 3,
  };
}

function straightJointPath(): TransitPath {
  return {
    kind: "road",
    steps: [
      {
        position: { x: 1, y: 1 },
        enteringHeading: "east",
        leavingHeading: "east",
        movement: "straight",
        geometry: { kind: "line", from: { x: 1, y: 1 }, to: { x: 2, y: 1 } },
        travelSeconds: 1.25,
      },
      {
        position: { x: 2, y: 1 },
        enteringHeading: "east",
        leavingHeading: "east",
        movement: "straight",
        geometry: { kind: "line", from: { x: 2, y: 1 }, to: { x: 3, y: 1 } },
        travelSeconds: 1.25,
      },
    ],
    totalTravelSeconds: 2.5,
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

  it("draws a connected curved leg solid, with no endpoint connectors", () => {
    // Stops sit exactly on the curve endpoints, so both connector calls
    // take the sameTripPosition early return.
    const state = stateWithLegs(
      [routeLeg("a", "b", "connected", cornerPath())],
      [
        { x: 1, y: 1 },
        { x: 3, y: 3 },
      ],
    );
    const { vertices } = buildTransitBatch(state, createUiState(), 1);

    const covered = coveredStripFraction(vertices, "#e04f39", pixelCorner());
    expect(covered).toBeGreaterThan(0.95);
  });

  it("fills the butt-cap notch where two solid steps turn at a shared tile", () => {
    const state = stateWithLegs(
      [routeLeg("a", "b", "connected", cornerJointPath())],
      [
        { x: 1, y: 1 },
        { x: 2, y: 2 },
      ],
    );
    const { vertices } = buildTransitBatch(state, createUiState(), 1);

    expect(hasVertexNear(vertices, "#e04f39", 80, 48)).toBe(true);
    expect(hasVertexNear(vertices, "#e04f39", 80, 45.5)).toBe(true);
    expect(hasVertexNear(vertices, "#e04f39", 82.5, 48)).toBe(true);
    // Bevel triangle fills the outer notch without overlapping the inner corner
    const rim = (5 / 2) * Math.SQRT1_2;
    expect(hasVertexNear(vertices, "#e04f39", 80 - rim, 48 + rim)).toBe(false);
  });

  it("does not fill a collinear joint between solid steps", () => {
    const state = stateWithLegs(
      [routeLeg("a", "b", "connected", straightJointPath())],
      [
        { x: 1, y: 1 },
        { x: 3, y: 1 },
      ],
    );
    const { vertices } = buildTransitBatch(state, createUiState(), 1);

    expect(hasVertexNear(vertices, "#e04f39", 80, 48)).toBe(false);
  });

  it("fills the corner notch across legs meeting at a stop", () => {
    const leg1Path: TransitPath = {
      kind: "road",
      steps: [
        {
          position: { x: 1, y: 1 },
          enteringHeading: "east",
          leavingHeading: "east",
          movement: "straight",
          geometry: { kind: "line", from: { x: 1, y: 1 }, to: { x: 2, y: 1 } },
          travelSeconds: 1.25,
        },
      ],
      totalTravelSeconds: 1.25,
    };
    const leg2Path: TransitPath = {
      kind: "road",
      steps: [
        {
          position: { x: 2, y: 1 },
          enteringHeading: "east",
          leavingHeading: "south",
          movement: "rightTurn",
          geometry: { kind: "line", from: { x: 2, y: 1 }, to: { x: 2, y: 2 } },
          travelSeconds: 1.75,
        },
      ],
      totalTravelSeconds: 1.75,
    };
    const state = stateWithLegs(
      [
        routeLeg("a", "b", "connected", leg1Path),
        routeLeg("b", "c", "connected", leg2Path),
      ],
      [
        { x: 1, y: 1 },
        { x: 2, y: 1 },
        { x: 2, y: 2 },
      ],
    );
    const { vertices } = buildTransitBatch(state, createUiState(), 1);

    const rows = verticesOfColor(vertices, "#e04f39");
    const corners = [
      [80, 48],
      [80, 45.5],
      [82.5, 48],
    ];
    expect(
      rows.some(
        (_, index) =>
          index % 3 === 0 &&
          corners.every(([x, y]) =>
            rows
              .slice(index, index + 3)
              .some(
                ([vx, vy]) =>
                  Math.abs(vx - x) < 0.01 && Math.abs(vy - y) < 0.01,
              ),
          ),
      ),
    ).toBe(true);
  });

  it("does not fill a corner within a dashed broken leg", () => {
    const state = stateWithLegs(
      [routeLeg("a", "b", "networkDisconnected", cornerJointPath())],
      [
        { x: 1, y: 1 },
        { x: 2, y: 2 },
      ],
    );
    const { vertices } = buildTransitBatch(state, createUiState(), 1);

    expect(hasVertexNear(vertices, "#e04f39", 80, 48)).toBe(false);
  });

  it("does not join solid legs across a pathless broken leg", () => {
    const path = cornerJointPath();
    if (path.kind !== "road") throw new Error("expected a road path");
    const first = { ...path, steps: [path.steps[0]] };
    const second = { ...path, steps: [path.steps[1]] };
    const state = stateWithLegs(
      [
        routeLeg("a", "b", "connected", first),
        routeLeg("b", "c", "networkDisconnected", null),
        routeLeg("c", "d", "connected", second),
      ],
      [
        { x: 1, y: 1 },
        { x: 2, y: 2 },
      ],
    );
    const { vertices } = buildTransitBatch(state, createUiState(), 1);

    expect(hasVertexNear(vertices, "#e04f39", 80, 48)).toBe(false);
  });

  it("emits no arrowheads for a pathless failed leg", () => {
    const state = stateWithLegs([
      routeLeg("a", "b", "networkDisconnected", null),
    ]);
    const { vertices } = buildTransitBatch(
      state,
      { ...createUiState(), selectedRouteId: "route-001" },
      1,
    );

    // The emphasized leg still draws its dashed endpoint fallback…
    expect(hasVertexNear(vertices, "#e04f39", 48, 48, 3)).toBe(true);
    // …but with no path there is nothing to sample arrows along: the first
    // arrow tip would have landed 6px past (96,48).
    expect(hasVertexNear(vertices, "#e04f39", 102, 48, 1)).toBe(false);
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
  it("emits untinted faces and route-tinted rims for present stops", () => {
    const state = stateWithLegs([routeLeg("a", "b", "connected", linePath())]);
    const { sprites } = buildTransitBatch(state, createUiState(), 1);
    const face = Array.from(sprites.slice(0, SPRITE_INSTANCE_FLOATS));
    const rim = Array.from(
      sprites.slice(SPRITE_INSTANCE_FLOATS, SPRITE_INSTANCE_FLOATS * 2),
    );
    expect(face.slice(0, 5)).toEqual([48, 48, 0, 7, 7]);
    expect(face[7]).toBe(TRANSIT_SPRITE_LAYERS.busStop);
    expect(face.slice(8, 12)).toEqual([1, 1, 1, 1]);
    expect(rim[7]).toBe(TRANSIT_SPRITE_LAYERS.busStopRing);
    rim
      .slice(8, 12)
      .forEach((value, i) =>
        expect(value).toBeCloseTo(parseColor("#e04f39")[i], 5),
      );
  });

  it("draws unserved stop and station faces with their default rims", () => {
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
    const { sprites } = buildTransitBatch(state, createUiState(), 1);
    expect(sprites.length).toBe(4 * SPRITE_INSTANCE_FLOATS);
    expect(
      markerRow(sprites, 80, 80, TRANSIT_SPRITE_LAYERS.busStop).slice(8, 12),
    ).toEqual([1, 1, 1, 1]);
    expectTint(
      markerRow(sprites, 80, 80, TRANSIT_SPRITE_LAYERS.busStopRing),
      colors.bus,
    );
    expect(
      markerRow(sprites, 144, 80, TRANSIT_SPRITE_LAYERS.metroStation).slice(
        8,
        12,
      ),
    ).toEqual([1, 1, 1, 1]);
    expectTint(
      markerRow(sprites, 144, 80, TRANSIT_SPRITE_LAYERS.metroStationRing),
      colors.metro,
    );
  });

  it("rims served markers in the serving line's color", () => {
    const base = stateWithLegs([routeLeg("a", "b", "connected", linePath())]);
    const state = {
      ...base,
      transit: {
        ...base.transit,
        stations: [
          {
            id: "station-1",
            status: "present" as const,
            position: { x: 4, y: 4 },
            platforms: [],
          },
        ],
        routes: [{ ...base.transit.routes[0], color: "#33cc77" }],
        metroLines: [
          {
            id: "metro-001",
            name: "Metro 1",
            color: "#3366cc",
            stationIds: ["station-1"],
            vehicleIds: [],
            active: true,
            pattern: "loop" as const,
            revision: 1,
            legs: [],
            pathBroken: false,
            targetHeadwaySeconds: null,
            serviceMetrics: null,
          },
        ],
      },
    };
    const { sprites } = buildTransitBatch(state, createUiState(), 1);
    expectTint(
      markerRow(sprites, 48, 48, TRANSIT_SPRITE_LAYERS.busStopRing),
      "#33cc77",
    );
    expectTint(
      markerRow(sprites, 144, 144, TRANSIT_SPRITE_LAYERS.metroStationRing),
      "#3366cc",
    );
    expect(
      markerRow(sprites, 144, 144, TRANSIT_SPRITE_LAYERS.metroStation).slice(
        8,
        12,
      ),
    ).toEqual([1, 1, 1, 1]);
  });

  it("dims unserved stops when a route is emphasized", () => {
    const base = stateWithLegs([routeLeg("a", "b", "connected", linePath())]);
    const state: GameState = {
      ...base,
      transit: {
        ...base.transit,
        stops: [
          ...base.transit.stops,
          {
            id: "stop-unserved",
            kind: "busStop",
            position: { x: 9, y: 9 },
            status: "present",
            platforms: [],
          },
        ],
      },
    };
    const { sprites } = buildTransitBatch(
      state,
      { ...createUiState(), selectedRouteId: "route-001" },
      1,
    );

    // Unserved stop at (9*32 + 16, 9*32 + 16) = (304, 304).
    // Its rim should be dimmed with UNRELATED_ROUTE_OPACITY.
    expectTint(
      markerRow(sprites, 304, 304, TRANSIT_SPRITE_LAYERS.busStopRing),
      colors.bus,
      UNRELATED_ROUTE_OPACITY,
    );
    expect(
      markerRow(sprites, 304, 304, TRANSIT_SPRITE_LAYERS.busStop).slice(8, 12),
    ).toEqual([1, 1, 1, 1]);
  });

  it("rims a shared marker with the emphasized serving line's color", () => {
    const base = stateWithLegs([routeLeg("a", "b", "connected", linePath())]);
    const route = base.transit.routes[0];
    const state = {
      ...base,
      transit: {
        ...base.transit,
        routes: [
          route,
          { ...route, id: "route-002", name: "Route 2", color: "#2f9e44" },
        ],
      },
    };

    const plain = buildTransitBatch(state, createUiState(), 1).sprites;
    expectTint(
      markerRow(plain, 48, 48, TRANSIT_SPRITE_LAYERS.busStopRing),
      "#e04f39",
    );

    const selected = buildTransitBatch(
      state,
      { ...createUiState(), selectedRouteId: "route-002" },
      1,
    ).sprites;
    expectTint(
      markerRow(selected, 48, 48, TRANSIT_SPRITE_LAYERS.busStopRing),
      "#2f9e44",
    );
  });

  it("updates rims for editing, recolor, deletion, tombstones and rebuilding", () => {
    const base = stateWithLegs([routeLeg("a", "b", "connected", linePath())]);
    const route = base.transit.routes[0]!;
    const state = {
      ...base,
      transit: {
        ...base.transit,
        routes: [route, { ...route, id: "route-002", color: "#2867b2" }],
      },
    };
    const editing = {
      ...createUiState(),
      routeDraft: {
        ...emptyLineDraft(),
        source: {
          kind: "edit" as const,
          routeId: "route-002",
          expectedRevision: 1,
        },
      },
    };
    const edited = buildTransitBatch(state, editing, 1);
    expectTint(
      markerRow(edited.sprites, 48, 48, TRANSIT_SPRITE_LAYERS.busStopRing),
      "#2867b2",
    );
    expect(edited.routeStyleKey).not.toBe(
      buildTransitBatch(state, createUiState(), 1).routeStyleKey,
    );

    const recolored = {
      ...state,
      transit: {
        ...state.transit,
        routes: [route, { ...state.transit.routes[1]!, color: "#2e9e5b" }],
      },
    };
    const recoloredBatch = buildTransitBatch(recolored, editing, 2);
    expectTint(
      markerRow(
        recoloredBatch.sprites,
        48,
        48,
        TRANSIT_SPRITE_LAYERS.busStopRing,
      ),
      "#2e9e5b",
    );
    expect(recoloredBatch.routeStyleKey).not.toBe(edited.routeStyleKey);
    const deleted = {
      ...recolored,
      transit: { ...recolored.transit, routes: [] },
    };
    expectTint(
      markerRow(
        buildTransitBatch(deleted, createUiState(), 3).sprites,
        48,
        48,
        TRANSIT_SPRITE_LAYERS.busStopRing,
      ),
      colors.bus,
    );
    const missing = {
      ...recolored,
      transit: {
        ...recolored.transit,
        stops: recolored.transit.stops.map((stop) =>
          stop.id === "a" ? { ...stop, status: "missing" as const } : stop,
        ),
      },
    };
    expect(buildTransitBatch(missing, editing, 3).sprites.length).toBe(
      2 * SPRITE_INSTANCE_FLOATS,
    );
    expectTint(
      markerRow(
        buildTransitBatch(recolored, editing, 4).sprites,
        48,
        48,
        TRANSIT_SPRITE_LAYERS.busStopRing,
      ),
      "#2e9e5b",
    );
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

  it("skips markers and access indicators for missing nodes", () => {
    const base = createTestGameState();
    const state = {
      ...base,
      transit: {
        ...base.transit,
        stops: [
          {
            id: "stop-gone",
            kind: "busStop" as const,
            status: "missing" as const,
            position: { x: 6, y: 6 },
            roadAccess: { roadPoint: { x: 6, y: 7 } },
            platforms: [],
          },
        ],
        stations: [
          {
            id: "station-gone",
            status: "missing" as const,
            position: { x: 8, y: 8 },
            platforms: [],
          },
        ],
      },
    };
    const { vertices, sprites } = buildTransitBatch(state, createUiState(), 1);

    expect(verticesOfColor(vertices, colors.bus)).toEqual([]);
    expect(verticesOfColor(vertices, colors.metro)).toEqual([]);
    expect(sprites).toHaveLength(0);
    // The missing stop's roadAccess must not emit an indicator either.
    expect(verticesOfColor(vertices, colors.hover)).toEqual([]);
  });

  it("skips a zero-length stop access indicator", () => {
    const base = createTestGameState();
    const state = {
      ...base,
      transit: {
        ...base.transit,
        stops: [
          {
            id: "stop-on-road",
            kind: "busStop" as const,
            status: "present" as const,
            position: { x: 4, y: 4 },
            // The stop sits on its access point: no arrow can be drawn.
            roadAccess: { roadPoint: { x: 4, y: 4 } },
            platforms: [],
          },
        ],
      },
    };
    const { vertices, sprites } = buildTransitBatch(state, createUiState(), 1);

    expect(verticesOfColor(vertices, colors.hover)).toEqual([]);
    // The stop marker itself still renders.
    expectTint(
      markerRow(sprites, 144, 144, TRANSIT_SPRITE_LAYERS.busStopRing),
      colors.bus,
    );
    expect(
      markerRow(sprites, 144, 144, TRANSIT_SPRITE_LAYERS.busStop).slice(8, 12),
    ).toEqual([1, 1, 1, 1]);
  });

  it("does not emit a displaced cue when the presented path is centered", () => {
    const state = stateWithLegs([routeLeg("a", "b", "connected", linePath())]);
    const { vertices } = buildTransitBatch(state, createUiState(), 1);

    // Centered paths have no displaced node cue.
    expect(hasVertexNear(vertices, "#e04f39", 48, 48)).toBe(false);
  });

  it("positions displaced bus cues against the opaque sprite silhouette", () => {
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
    const { vertices, sprites } = buildTransitBatch(state, createUiState(), 1);

    // The opaque rim ends about 72 texels from center in a 192px image,
    // displayed at 14 world px. The ±2px corridor offsets leave the
    // radius-3 cues slightly overlapping that visible silhouette.
    expect(hasVertexNear(vertices, "#111111", 48, 48 - 5.25 - 2)).toBe(true);
    expect(hasVertexNear(vertices, "#222222", 48, 48 + 5.25 + 2)).toBe(true);
    expect(hasVertexNear(vertices, "#111111", 48, 46)).toBe(false);
    expectTint(
      markerRow(sprites, 48, 48, TRANSIT_SPRITE_LAYERS.busStopRing),
      "#111111",
    );
    expect(
      markerRow(sprites, 48, 48, TRANSIT_SPRITE_LAYERS.busStop).slice(8, 12),
    ).toEqual([1, 1, 1, 1]);
  });

  it("positions displaced metro cues against the opaque station silhouette", () => {
    const base = stateWithLegs([routeLeg("a", "b", "connected", linePath())]);
    const trackPath: TransitPath = {
      kind: "track",
      totalTravelSeconds: 1,
      steps: [
        {
          position: { x: 1, y: 1 },
          heading: "east",
          travelSeconds: 1,
          geometry: { kind: "line", from: { x: 1, y: 1 }, to: { x: 2, y: 1 } },
        },
      ],
    };
    const state: GameState = {
      ...base,
      transit: {
        ...base.transit,
        stops: [],
        stations: base.transit.stops.map(({ id, position }) => ({
          id,
          position,
          status: "present",
          platforms: [],
        })),
        routes: [],
        metroLines: ["#111111", "#222222"].map((color, index) => ({
          id: `metro-000${index + 1}`,
          name: "Metro",
          color,
          stationIds: ["a", "b"],
          vehicleIds: [],
          active: true,
          pattern: "loop",
          revision: 1,
          legs: [routeLeg("a", "b", "connected", trackPath)],
          pathBroken: false,
          targetHeadwaySeconds: null,
          serviceMetrics: null,
        })),
      },
    };
    const { vertices } = buildTransitBatch(state, createUiState(), 1);

    expect(hasVertexNear(vertices, "#111111", 48, 48 - 5.25 - 2)).toBe(true);
    expect(hasVertexNear(vertices, "#222222", 48, 48 + 5.25 + 2)).toBe(true);

    const diagonalPath: TransitPath = {
      kind: "track",
      totalTravelSeconds: 4,
      steps: [
        {
          position: { x: 1, y: 1 },
          heading: "east",
          travelSeconds: 4,
          geometry: {
            kind: "line",
            from: { x: 1, y: 1 },
            to: { x: 5, y: 5 },
          },
        },
      ],
    };
    const diagonal: GameState = {
      ...state,
      transit: {
        ...state.transit,
        stations: state.transit.stations.map((station, index) => ({
          ...station,
          position: { x: index + 1, y: index + 1 },
        })),
        metroLines: state.transit.metroLines.map((line) => ({
          ...line,
          legs: [routeLeg("a", "b", "connected", diagonalPath)],
        })),
      },
    };
    const diagonalVertices = buildTransitBatch(
      diagonal,
      createUiState(),
      1,
    ).vertices;
    const component = ((88 * 14) / 192 + 2) / Math.SQRT2;
    expect(
      hasVertexNear(
        diagonalVertices,
        "#111111",
        48 + component,
        48 - component,
      ),
    ).toBe(true);
    expect(
      hasVertexNear(
        diagonalVertices,
        "#222222",
        48 - component,
        48 + component,
      ),
    ).toBe(true);
  });

  it("emits one dimmed station rim and an opaque face", () => {
    const base = createTestGameState();
    const state = {
      ...base,
      transit: {
        ...base.transit,
        stations: [
          {
            id: "station-1",
            status: "present" as const,
            position: { x: 4, y: 4 },
            platforms: [],
          },
        ],
        metroLines: [
          {
            id: "metro-001",
            name: "Metro 1",
            color: "#3366cc",
            stationIds: ["station-1"],
            vehicleIds: [],
            active: true,
            pattern: "loop" as const,
            revision: 1,
            legs: [],
            pathBroken: false,
            targetHeadwaySeconds: null,
            serviceMetrics: null,
          },
        ],
      },
    };
    const { sprites } = buildTransitBatch(
      state,
      { ...createUiState(), selectedRouteId: "route-unrelated" },
      1,
    );

    expect(sprites.length).toBe(2 * SPRITE_INSTANCE_FLOATS);
    expectTint(
      markerRow(sprites, 144, 144, TRANSIT_SPRITE_LAYERS.metroStationRing),
      "#3366cc",
      UNRELATED_ROUTE_OPACITY,
    );
    expect(
      markerRow(sprites, 144, 144, TRANSIT_SPRITE_LAYERS.metroStation).slice(
        8,
        12,
      ),
    ).toEqual([1, 1, 1, 1]);
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
          initialFleet: null,
        },
      },
    };
    const vertices = draftLegVertices(state, ui);

    // Draft dash [6,6]: half the centerline is covered, with gaps.
    const covered = coveredStripFraction(vertices, "#f4d35e", pixelCorner());
    expect(covered).toBeGreaterThan(0.3);
    expect(covered).toBeLessThan(0.95);
  });

  it("emits nothing when the matching preview carries no legs", () => {
    const state = stateWithLegs([]);
    const ui = {
      ...createUiState(),
      routeDraft: {
        ...emptyLineDraft(),
        generation: 1,
        preview: {
          generation: 1,
          legs: [],
          totalTravelSeconds: 0,
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
          initialFleet: null,
        },
      },
    };

    expect(draftLegVertices(state, ui)).toHaveLength(0);
  });

  it("dashes a draft leg endpoint-to-endpoint when it has no path", () => {
    const state = stateWithLegs([]);
    const ui = {
      ...createUiState(),
      routeDraft: {
        ...emptyLineDraft(),
        waypointIds: ["a", "b"],
        generation: 1,
        preview: {
          generation: 1,
          legs: [routeLeg("a", "b", "networkDisconnected", null)],
          totalTravelSeconds: 0,
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
          initialFleet: null,
        },
      },
    };
    const vertices = draftLegVertices(state, ui);

    // Direct dashed connector between stop centers (48,48) -> (80,48).
    expect(hasVertexNear(vertices, "#f4d35e", 48, 48, 3)).toBe(true);
    expect(hasVertexNear(vertices, "#f4d35e", 59, 48, 3)).toBe(true);
  });

  it("draws an edit-source draft in the edited route's corridor slot", () => {
    // Two routes share the (1,1)->(5,1) corridor at -2/+2 px offsets.
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
    const previewLegs = [routeLeg("a", "b", "connected", linePath())];
    const draftPreview = {
      generation: 1,
      legs: previewLegs,
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
      initialFleet: null,
    };

    // A new draft has no corridor slot: drawn centered on the corridor.
    const fresh = draftLegVertices(state, {
      ...createUiState(),
      routeDraft: {
        ...emptyLineDraft(),
        waypointIds: ["a", "b"],
        generation: 1,
        preview: draftPreview,
      },
    });
    expect(hasVertexNear(fresh, "#f4d35e", 48, 46.5, 0.01)).toBe(true);

    // Editing route-0002 inherits its +2px corridor offset -> centerline 50.
    const editing = draftLegVertices(state, {
      ...createUiState(),
      routeDraft: {
        ...emptyLineDraft(),
        source: {
          kind: "edit" as const,
          routeId: "route-0002",
          expectedRevision: 1,
        },
        waypointIds: ["a", "b"],
        generation: 1,
        preview: draftPreview,
      },
    });
    expect(hasVertexNear(editing, "#f4d35e", 48, 48.5, 0.01)).toBe(true);
    expect(hasVertexNear(editing, "#f4d35e", 48, 46.5, 0.01)).toBe(false);
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
          initialFleet: null,
        },
      },
    };
    const { vertices } = buildTransitBatch(state, ui, 1);

    expect(verticesOfColor(vertices, "#f4d35e")).toEqual([]);
  });
});
