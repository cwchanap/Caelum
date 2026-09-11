import { describe, expect, it } from "vitest";
import type {
  GameState,
  PathGeometry,
  RoadPathStep,
  RouteLegPath,
  TransitPath,
  Vehicle,
} from "../../src/domain/types";
import {
  encodeVehicleInstances,
  interpolationAlpha,
  type WorldViewport,
} from "../../src/render/webgpu/vehicleInstances";
import {
  createWebGpuRenderer,
  VEHICLE_INSTANCE_FLOATS,
} from "../../src/render/webgpu/renderer";
import { createFakeCanvas, createFakeDevice } from "../helpers/fakeWebGpu";
import { pointAndTangentAt } from "../../src/render/pathGeometry";
import { tileSize } from "../../src/render/boardTransform";
import { createUiState } from "../../src/ui/uiState";
import { createDraft } from "../../src/ui/routeDraft";
import { UNRELATED_ROUTE_OPACITY } from "../../src/render/transitRenderer";
import { parseColor } from "../../src/render/webgpu/primitives";
import { buildRenderScaleState } from "../helpers/renderScaleState";
import { createTestGameState } from "../helpers/gameState";

const EPSILON = 1e-4;

function pixel(point: { x: number; y: number }): { x: number; y: number } {
  return {
    x: point.x * tileSize + tileSize / 2,
    y: point.y * tileSize + tileSize / 2,
  };
}

function legWithSteps(steps: TransitPath["steps"]): RouteLegPath[] {
  const totalTravelSeconds = steps.reduce(
    (total, step) => total + step.travelSeconds,
    0,
  );
  return [
    {
      fromWaypointId: "a",
      toWaypointId: "b",
      direction: "loop",
      kind: "service",
      status: "connected",
      currentPath: {
        kind: "road",
        steps: steps as Extract<TransitPath, { kind: "road" }>["steps"],
        totalTravelSeconds,
      } as TransitPath,
      lastValidPath: null,
      estimatedSeconds: totalTravelSeconds,
      failureReason: null,
    },
  ];
}

function busVehicle(overrides: Partial<Vehicle> = {}): Vehicle {
  return {
    id: "vehicle-001",
    mode: "bus",
    lineId: "route-001",
    itineraryIndex: 0,
    pathStepIndex: 0,
    stepProgress: 0,
    parkedPosition: null,
    ...overrides,
  };
}

function stateWithVehicles(
  legs: RouteLegPath[],
  vehicles: Vehicle[],
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
        position: { x: index, y: 0 },
        platforms: [],
      })),
      stations: ["s1", "s2"].map((id, index) => ({
        id,
        status: "present" as const,
        position: { x: index, y: 6 },
        platforms: [],
      })),
      routes: [
        {
          id: "route-001",
          name: "Route 1",
          color: "#e04f39",
          stopIds: ["a", "b"],
          vehicleIds: vehicles.map((vehicle) => vehicle.id),
          active: true,
          pattern: "loop" as const,
          revision: 1,
          legs,
          pathBroken: false,
          targetHeadwaySeconds: null,
          serviceMetrics: null,
        },
      ],
      metroLines: [
        {
          id: "metro-001",
          name: "Metro 1",
          color: "#2867b2",
          stationIds: ["s1", "s2"],
          vehicleIds: [],
          active: true,
          pattern: "loop" as const,
          revision: 1,
          legs,
          pathBroken: false,
          targetHeadwaySeconds: null,
          serviceMetrics: null,
        },
      ],
      vehicles,
    },
  };
}

const FULL_MAP: WorldViewport = {
  minX: -Infinity,
  minY: -Infinity,
  maxX: Infinity,
  maxY: Infinity,
};

function encode(options?: {
  previous?: GameState | null;
  latest?: GameState;
  alpha?: number;
  paused?: boolean;
  viewport?: WorldViewport;
}): Float32Array<ArrayBuffer> {
  return encodeVehicleInstances({
    previous: options?.previous ?? null,
    latest: options?.latest ?? createTestGameState(),
    ui: createUiState(),
    alpha: options?.alpha ?? 1,
    paused: options?.paused ?? false,
    viewport: options?.viewport ?? FULL_MAP,
  });
}

function instancesOf(data: Float32Array): number[][] {
  const rows: number[][] = [];
  for (let offset = 0; offset < data.length; offset += 9) {
    rows.push(Array.from(data.slice(offset, offset + 9)));
  }
  return rows;
}

function quadraticStep(travelSeconds = 4): RoadPathStep {
  return {
    position: { x: 1, y: 1 },
    enteringHeading: "east" as const,
    leavingHeading: "south" as const,
    movement: "rightTurn" as const,
    geometry: {
      kind: "quadraticBezier",
      from: { x: 1, y: 1 },
      control: { x: 3, y: 1 },
      to: { x: 3, y: 3 },
    },
    travelSeconds,
  };
}

function arcStep(travelSeconds = 2): RoadPathStep {
  return {
    position: { x: 2, y: 2 },
    enteringHeading: "east" as const,
    leavingHeading: "south" as const,
    movement: "rightTurn" as const,
    geometry: {
      kind: "arc",
      center: { x: 2, y: 2 },
      radius: 1,
      startRadians: 0,
      sweepRadians: Math.PI / 2,
    },
    travelSeconds,
  };
}

function lineStep(
  from: { x: number; y: number },
  to: { x: number; y: number },
  travelSeconds = 4,
): RoadPathStep {
  return {
    position: from,
    enteringHeading: "east" as const,
    leavingHeading: "east" as const,
    movement: "straight" as const,
    geometry: { kind: "line", from, to },
    travelSeconds,
  };
}

function expectNear(actual: number, expected: number): void {
  expect(Math.abs(actual - expected)).toBeLessThan(EPSILON);
}

describe("interpolationAlpha", () => {
  it("interpolates across a 100 ms observed interval", () => {
    expect(interpolationAlpha(0, 100, 100)).toBe(0);
    expect(interpolationAlpha(0, 100, 150)).toBeCloseTo(0.5);
    expect(interpolationAlpha(0, 100, 200)).toBe(1);
  });

  it("clamps before the latest observation and after one interval", () => {
    expect(interpolationAlpha(0, 100, 90)).toBe(0);
    expect(interpolationAlpha(0, 100, 350)).toBe(1);
  });

  it("does not reach alpha 1 after 100 ms of a 130 ms interval", () => {
    const alpha = interpolationAlpha(0, 130, 230);
    expect(alpha).toBeGreaterThan(0.7);
    expect(alpha).toBeLessThan(1);
    expect(alpha).toBeCloseTo(100 / 130);
    expect(interpolationAlpha(0, 130, 260)).toBe(1);
  });

  it("floors a degenerate zero interval to 1 ms", () => {
    expect(interpolationAlpha(1000, 1000, 1000)).toBe(0);
    expect(interpolationAlpha(1000, 1000, 1001)).toBe(1);
  });
});

describe("same-step path interpolation", () => {
  function sameStepState(
    step: ReturnType<typeof quadraticStep>,
    previousProgress: number,
    latestProgress: number,
  ): { previous: GameState; latest: GameState } {
    const legs = legWithSteps([step]);
    const previous = stateWithVehicles(legs, [
      busVehicle({ stepProgress: previousProgress }),
    ]);
    const latest = stateWithVehicles(legs, [
      busVehicle({ stepProgress: latestProgress }),
    ]);
    return { previous, latest };
  }

  it("samples the quadratic geometry at the lerped progress", () => {
    const step = quadraticStep();
    const { previous, latest } = sameStepState(step, 0.25, 0.75);
    const instances = instancesOf(encode({ previous, latest, alpha: 0.5 }));

    expect(instances).toHaveLength(1);
    const expected = pointAndTangentAt(step.geometry, 0.5);
    const expectedPixel = pixel(expected.point);
    expectNear(instances[0][0], expectedPixel.x);
    expectNear(instances[0][1], expectedPixel.y);
    expectNear(
      instances[0][2],
      Math.atan2(expected.tangent.y, expected.tangent.x),
    );
  });

  it("discriminates against world-space chord lerp on the quadratic", () => {
    const step = quadraticStep();
    const { previous, latest } = sameStepState(step, 0.25, 0.75);
    const instances = instancesOf(encode({ previous, latest, alpha: 0.5 }));

    const chordMidpoint = pixel({
      x:
        (pointAndTangentAt(step.geometry, 0.25).point.x +
          pointAndTangentAt(step.geometry, 0.75).point.x) /
        2,
      y:
        (pointAndTangentAt(step.geometry, 0.25).point.y +
          pointAndTangentAt(step.geometry, 0.75).point.y) /
        2,
    });
    const drift = Math.hypot(
      instances[0][0] - chordMidpoint.x,
      instances[0][1] - chordMidpoint.y,
    );
    expect(drift).toBeGreaterThan(1);
  });

  it("samples the arc geometry at the lerped progress", () => {
    const step = arcStep();
    const { previous, latest } = sameStepState(step, 0.1, 0.6);
    const instances = instancesOf(encode({ previous, latest, alpha: 0.5 }));

    expect(instances).toHaveLength(1);
    const expected = pointAndTangentAt(step.geometry, 0.35);
    const expectedPixel = pixel(expected.point);
    expectNear(instances[0][0], expectedPixel.x);
    expectNear(instances[0][1], expectedPixel.y);
    expectNear(
      instances[0][2],
      Math.atan2(expected.tangent.y, expected.tangent.x),
    );
  });

  it("pins alpha endpoints to the observed cursors", () => {
    const step = quadraticStep();
    const atZero = sameStepState(step, 0.2, 0.8);
    const zeroInstances = instancesOf(
      encode({ previous: atZero.previous, latest: atZero.latest, alpha: 0 }),
    );
    const previousPoint = pixel(
      pointAndTangentAt(step.geometry as PathGeometry, 0.2).point,
    );
    expectNear(zeroInstances[0][0], previousPoint.x);
    expectNear(zeroInstances[0][1], previousPoint.y);

    const atOne = sameStepState(step, 0.2, 0.8);
    const oneInstances = instancesOf(
      encode({ previous: atOne.previous, latest: atOne.latest, alpha: 1 }),
    );
    const latestPoint = pixel(
      pointAndTangentAt(step.geometry as PathGeometry, 0.8).point,
    );
    expectNear(oneInstances[0][0], latestPoint.x);
    expectNear(oneInstances[0][1], latestPoint.y);
  });
});

describe("adjacent-step rollover and snap rules", () => {
  const STEP_A = lineStep({ x: 1, y: 1 }, { x: 5, y: 1 });
  const STEP_B = lineStep({ x: 5, y: 1 }, { x: 5, y: 5 });

  function rolloverState(
    previousCursor: { pathStepIndex: number; stepProgress: number },
    latestCursor: { pathStepIndex: number; stepProgress: number },
    overrides: {
      previousVehicle?: Partial<Vehicle>;
      latestVehicle?: Partial<Vehicle>;
      previousLegs?: RouteLegPath[];
      latestLegs?: RouteLegPath[];
      previousLineId?: string;
    } = {},
  ): { previous: GameState; latest: GameState } {
    const legs = legWithSteps([STEP_A, STEP_B]);
    return {
      previous: stateWithVehicles(overrides.previousLegs ?? legs, [
        busVehicle({
          ...previousCursor,
          ...overrides.previousVehicle,
          lineId: overrides.previousLineId ?? "route-001",
        }),
      ]),
      latest: stateWithVehicles(overrides.latestLegs ?? legs, [
        busVehicle({ ...latestCursor, ...overrides.latestVehicle }),
      ]),
    };
  }

  function latestPixel(cursor: {
    pathStepIndex: number;
    stepProgress: number;
  }): { x: number; y: number } {
    const geometry =
      cursor.pathStepIndex === 0
        ? (STEP_A.geometry as PathGeometry)
        : (STEP_B.geometry as PathGeometry);
    return pixel(pointAndTangentAt(geometry, cursor.stepProgress).point);
  }

  it("rolls over within the previous step when target is small", () => {
    // remaining = 0.5*4 = 2, elapsed = 0.25*4 = 1, span = 3, target = 1.5.
    const cursors = {
      previousCursor: { pathStepIndex: 0, stepProgress: 0.5 },
      latestCursor: { pathStepIndex: 1, stepProgress: 0.25 },
    };
    const { previous, latest } = rolloverState(
      cursors.previousCursor,
      cursors.latestCursor,
    );
    const instances = instancesOf(encode({ previous, latest, alpha: 0.5 }));

    const expected = pixel(
      pointAndTangentAt(STEP_A.geometry as PathGeometry, 1 - (2 - 1.5) / 4)
        .point,
    );
    expectNear(instances[0][0], expected.x);
    expectNear(instances[0][1], expected.y);
  });

  it("rolls over into the latest step when target passes the boundary", () => {
    // remaining = 2, elapsed = 1, span = 3, target = 2.7 -> latest at 0.7/4.
    const { previous, latest } = rolloverState(
      { pathStepIndex: 0, stepProgress: 0.5 },
      { pathStepIndex: 1, stepProgress: 0.25 },
    );
    const instances = instancesOf(encode({ previous, latest, alpha: 0.9 }));

    const expected = pixel(
      pointAndTangentAt(STEP_B.geometry as PathGeometry, 0.7 / 4).point,
    );
    expectNear(instances[0][0], expected.x);
    expectNear(instances[0][1], expected.y);
  });

  it("snaps to latest on pause", () => {
    const { previous, latest } = rolloverState(
      { pathStepIndex: 0, stepProgress: 0.5 },
      { pathStepIndex: 1, stepProgress: 0.25 },
    );
    const instances = instancesOf(
      encode({ previous, latest, alpha: 0.5, paused: true }),
    );
    const expected = latestPixel({ pathStepIndex: 1, stepProgress: 0.25 });
    expectNear(instances[0][0], expected.x);
    expectNear(instances[0][1], expected.y);
  });

  it("snaps to latest when the previous vehicle is missing (scene change)", () => {
    const { latest } = rolloverState(
      { pathStepIndex: 0, stepProgress: 0.5 },
      { pathStepIndex: 1, stepProgress: 0.25 },
    );
    const instances = instancesOf(
      encode({ previous: null, latest, alpha: 0.5 }),
    );
    const expected = latestPixel({ pathStepIndex: 1, stepProgress: 0.25 });
    expectNear(instances[0][0], expected.x);
    expectNear(instances[0][1], expected.y);
  });

  it("snaps to latest on a line change", () => {
    const otherLegs = legWithSteps([STEP_A, STEP_B]);
    const { previous, latest } = rolloverState(
      { pathStepIndex: 0, stepProgress: 0.5 },
      { pathStepIndex: 1, stepProgress: 0.25 },
      { previousLineId: "route-002", previousLegs: otherLegs },
    );
    const instances = instancesOf(encode({ previous, latest, alpha: 0.5 }));
    const expected = latestPixel({ pathStepIndex: 1, stepProgress: 0.25 });
    expectNear(instances[0][0], expected.x);
    expectNear(instances[0][1], expected.y);
  });

  it("snaps to latest on an itinerary change", () => {
    const { previous, latest } = rolloverState(
      { pathStepIndex: 0, stepProgress: 0.5 },
      { pathStepIndex: 0, stepProgress: 0.25 },
      { previousVehicle: { itineraryIndex: 1 } },
    );
    const instances = instancesOf(encode({ previous, latest, alpha: 0.5 }));
    const expected = latestPixel({ pathStepIndex: 0, stepProgress: 0.25 });
    expectNear(instances[0][0], expected.x);
    expectNear(instances[0][1], expected.y);
  });

  it("snaps to latest on a parked-to-path transition", () => {
    const { previous, latest } = rolloverState(
      { pathStepIndex: 0, stepProgress: 0.5 },
      { pathStepIndex: 0, stepProgress: 0.25 },
      { previousVehicle: { parkedPosition: { x: 2, y: 2 } } },
    );
    const instances = instancesOf(encode({ previous, latest, alpha: 0.5 }));
    const expected = latestPixel({ pathStepIndex: 0, stepProgress: 0.25 });
    expectNear(instances[0][0], expected.x);
    expectNear(instances[0][1], expected.y);
  });

  it("snaps to latest on a backward cursor jump", () => {
    const { previous, latest } = rolloverState(
      { pathStepIndex: 1, stepProgress: 0.5 },
      { pathStepIndex: 0, stepProgress: 0.25 },
    );
    const instances = instancesOf(encode({ previous, latest, alpha: 0.5 }));
    const expected = latestPixel({ pathStepIndex: 0, stepProgress: 0.25 });
    expectNear(instances[0][0], expected.x);
    expectNear(instances[0][1], expected.y);
  });

  it("snaps to latest on a non-adjacent cursor jump", () => {
    const stepC = lineStep({ x: 5, y: 5 }, { x: 1, y: 5 });
    const threeSteps = legWithSteps([STEP_A, STEP_B, stepC]);
    const { previous, latest } = rolloverState(
      { pathStepIndex: 0, stepProgress: 0.5 },
      { pathStepIndex: 2, stepProgress: 0.25 },
      { latestLegs: threeSteps },
    );
    const instances = instancesOf(encode({ previous, latest, alpha: 0.5 }));
    const expected = pixel(
      pointAndTangentAt(stepC.geometry as PathGeometry, 0.25).point,
    );
    expectNear(instances[0][0], expected.x);
    expectNear(instances[0][1], expected.y);
  });

  it("snaps to latest on a zero span", () => {
    // remaining = (1-1)*4 = 0, elapsed = 0*4 = 0 -> span 0.
    const { previous, latest } = rolloverState(
      { pathStepIndex: 0, stepProgress: 1 },
      { pathStepIndex: 1, stepProgress: 0 },
    );
    const instances = instancesOf(encode({ previous, latest, alpha: 0.5 }));
    const expected = latestPixel({ pathStepIndex: 1, stepProgress: 0 });
    expectNear(instances[0][0], expected.x);
    expectNear(instances[0][1], expected.y);
  });

  it("snaps to latest on invalid (zero travelSeconds) span", () => {
    const zeroLegs = legWithSteps([
      lineStep({ x: 1, y: 1 }, { x: 5, y: 1 }, 0),
      lineStep({ x: 5, y: 1 }, { x: 5, y: 5 }, 0),
    ]);
    const { previous, latest } = rolloverState(
      { pathStepIndex: 0, stepProgress: 0.5 },
      { pathStepIndex: 1, stepProgress: 0.25 },
      { previousLegs: zeroLegs, latestLegs: zeroLegs },
    );
    const instances = instancesOf(encode({ previous, latest, alpha: 0.5 }));
    const expected = latestPixel({ pathStepIndex: 1, stepProgress: 0.25 });
    expectNear(instances[0][0], expected.x);
    expectNear(instances[0][1], expected.y);
  });

  it("snaps to latest when the path geometry changed under the cursor", () => {
    const editedLegs = legWithSteps([lineStep({ x: 0, y: 0 }, { x: 2, y: 2 })]);
    const { previous, latest } = rolloverState(
      { pathStepIndex: 0, stepProgress: 0.5 },
      { pathStepIndex: 0, stepProgress: 0.25 },
      { previousLegs: editedLegs },
    );
    const instances = instancesOf(encode({ previous, latest, alpha: 0.5 }));
    const expected = latestPixel({ pathStepIndex: 0, stepProgress: 0.25 });
    expectNear(instances[0][0], expected.x);
    expectNear(instances[0][1], expected.y);
  });
});

describe("emphasis, culling, and instance encoding", () => {
  function uiSelecting(routeId: string | null) {
    return { ...createUiState(), selectedRouteId: routeId };
  }

  function uiEditing(routeId: string) {
    return {
      ...createUiState(),
      routeDraft: {
        ...createDraft("bus", 1),
        source: { kind: "edit", routeId, expectedRevision: 1 } as const,
      },
    };
  }

  it("dims vehicles of unrelated routes and keeps emphasized routes opaque", () => {
    const legs = legWithSteps([quadraticStep()]);
    const latest = stateWithVehicles(legs, [busVehicle({ stepProgress: 0.5 })]);

    const emphasized = instancesOf(
      encodeVehicleInstances({
        previous: null,
        latest,
        ui: uiSelecting("route-001"),
        alpha: 1,
        paused: false,
        viewport: FULL_MAP,
      }),
    );
    expect(emphasized[0][8]).toBe(1);

    const dimmed = instancesOf(
      encodeVehicleInstances({
        previous: null,
        latest,
        ui: uiSelecting("route-002"),
        alpha: 1,
        paused: false,
        viewport: FULL_MAP,
      }),
    );
    expect(dimmed[0][8]).toBeCloseTo(UNRELATED_ROUTE_OPACITY);
    // RGB stays the route-neutral vehicle color while alpha dims.
    const bus = parseColor("#e04f39");
    expect(dimmed[0][5]).toBeCloseTo(bus[0]);
    expect(dimmed[0][6]).toBeCloseTo(bus[1]);
    expect(dimmed[0][7]).toBeCloseTo(bus[2]);
  });

  it("dims vehicles against an edited route draft too", () => {
    const legs = legWithSteps([quadraticStep()]);
    const latest = stateWithVehicles(legs, [busVehicle({ stepProgress: 0.5 })]);
    const dimmed = instancesOf(
      encodeVehicleInstances({
        previous: null,
        latest,
        ui: uiEditing("route-002"),
        alpha: 1,
        paused: false,
        viewport: FULL_MAP,
      }),
    );
    expect(dimmed[0][8]).toBeCloseTo(UNRELATED_ROUTE_OPACITY);
  });

  it("encodes bus angle from the tangent and leaves metro unrotated", () => {
    const legs = legWithSteps([quadraticStep()]);
    const latest = stateWithVehicles(legs, [
      busVehicle({ stepProgress: 0.5 }),
      busVehicle({
        id: "vehicle-002",
        mode: "metro",
        lineId: "metro-001",
        stepProgress: 0.5,
      }),
    ]);
    const instances = instancesOf(encode({ latest, alpha: 1 }));
    expect(instances).toHaveLength(2);
    const tangent = pointAndTangentAt(
      legs[0].currentPath!.steps[0].geometry,
      0.5,
    ).tangent;
    expectNear(instances[0][2], Math.atan2(tangent.y, tangent.x));
    expect(instances[1][2]).toBe(0);
  });

  it("culls against the viewport plus a one-tile margin", () => {
    const legs = legWithSteps([lineStep({ x: 1, y: 1 }, { x: 40, y: 1 })]);
    // Samples at tile x = 11..15, pixel centers x = tile*32 + 16:
    // 368, 400, 432, 464, 496. Viewport [400, 432] plus its one-tile margin
    // keeps [368, 464]: boundary-exact neighbors survive, the tile one pixel
    // past the margin is culled.
    const vehicles = [11, 12, 13, 14, 15].map((tileX, index) =>
      busVehicle({
        id: `vehicle-${String(index).padStart(3, "0")}`,
        stepProgress: (tileX - 1) / 39,
      }),
    );
    const latest = stateWithVehicles(legs, vehicles);
    const instances = instancesOf(
      encodeVehicleInstances({
        previous: null,
        latest,
        ui: createUiState(),
        alpha: 1,
        paused: false,
        viewport: { minX: 400, minY: 0, maxX: 432, maxY: 64 },
      }),
    );
    expect(instances).toHaveLength(4);
    expectNear(instances[0][0], 368);
    expectNear(instances[3][0], 464);
  });

  it("drops every instance when the viewport misses the fleet", () => {
    const legs = legWithSteps([lineStep({ x: 1, y: 1 }, { x: 5, y: 1 })]);
    const latest = stateWithVehicles(legs, [busVehicle({ stepProgress: 0.5 })]);
    const instances = instancesOf(
      encodeVehicleInstances({
        previous: null,
        latest,
        ui: createUiState(),
        alpha: 1,
        paused: false,
        viewport: { minX: 5000, minY: 5000, maxX: 6000, maxY: 6000 },
      }),
    );
    expect(instances).toHaveLength(0);
  });

  it("encodes in presented order without re-sorting", () => {
    const legs = legWithSteps([lineStep({ x: 1, y: 1 }, { x: 5, y: 1 })]);
    const latest = stateWithVehicles(legs, [
      busVehicle({ id: "vehicle-002", stepProgress: 0.5 }),
      busVehicle({ id: "vehicle-001", stepProgress: 0 }),
    ]);
    const instances = instancesOf(encode({ latest, alpha: 1 }));
    expect(instances).toHaveLength(2);
    const midPixel = pixel(
      pointAndTangentAt(legs[0].currentPath!.steps[0].geometry, 0.5).point,
    );
    const startPixel = pixel(
      pointAndTangentAt(legs[0].currentPath!.steps[0].geometry, 0).point,
    );
    expectNear(instances[0][0], midPixel.x);
    expectNear(instances[1][0], startPixel.x);
  });

  it("encodes every vehicle of the 5000-vehicle scale fixture", () => {
    const state = buildRenderScaleState(5000);
    const instances = instancesOf(
      encodeVehicleInstances({
        previous: null,
        latest: state,
        ui: createUiState(),
        alpha: 1,
        paused: false,
        viewport: {
          minX: 0,
          minY: 0,
          maxX: state.map.width * tileSize,
          maxY: state.map.height * tileSize,
        },
      }),
    );
    expect(instances).toHaveLength(5000);
  });

  it("encodes exactly the 400 in-viewport vehicles of a 20000-vehicle fleet", () => {
    // One straight tile-per-vehicle line: vehicle i sits at tile x = 1 + i,
    // pixel x = 32*i + 48, y = 48. The viewport below (with its one-tile
    // margin) keeps exactly i in [109, 508].
    const legs = legWithSteps([
      lineStep({ x: 1, y: 1 }, { x: 20001, y: 1 }, 20000),
    ]);
    const vehicles = Array.from({ length: 20000 }, (_, index) =>
      busVehicle({ id: `vehicle-${index}`, stepProgress: index / 20000 }),
    );
    const latest = stateWithVehicles(legs, vehicles);
    const instances = instancesOf(
      encodeVehicleInstances({
        previous: null,
        latest,
        ui: createUiState(),
        alpha: 1,
        paused: false,
        viewport: { minX: 3568, minY: 0, maxX: 16272, maxY: 100 },
      }),
    );
    expect(instances).toHaveLength(400);
    // First kept vehicle is index 109: x = 32*109 + 48.
    expectNear(instances[0][0], 3536);
    expectNear(instances[399][0], 336 + 499 * 32);
  });

  it("draws 5k encoded instances with one vehicle writeBuffer and one instanced draw", () => {
    const state = buildRenderScaleState(5000);
    const instances = encodeVehicleInstances({
      previous: null,
      latest: state,
      ui: createUiState(),
      alpha: 1,
      paused: false,
      viewport: {
        minX: 0,
        minY: 0,
        maxX: state.map.width * tileSize,
        maxY: state.map.height * tileSize,
      },
    });
    expect(instances.length / VEHICLE_INSTANCE_FLOATS).toBe(5000);

    const { device, passes, writes } = createFakeDevice();
    const renderer = createWebGpuRenderer(device, "bgra8unorm");
    renderer.configure(createFakeCanvas().canvas);
    const stats = renderer.render({
      solids: [],
      vehicles: [{ key: "fleet", instances }],
    });

    // The static quad upload is 12 floats; only the one instance upload is a
    // multiple of the 9-float instance stride.
    const instanceWrites = writes.filter(
      (write) => write.data.length % VEHICLE_INSTANCE_FLOATS === 0,
    );
    expect(instanceWrites).toHaveLength(1);
    expect(Array.from(instanceWrites[0].data)).toEqual(Array.from(instances));
    expect(stats.vehicleInstances).toBe(5000);

    const vehicleDraws = passes[0].ops.filter(
      (op) =>
        op.kind === "draw" && op.vertexCount === 6 && op.instanceCount > 1,
    );
    expect(vehicleDraws).toHaveLength(1);
    expect(
      vehicleDraws.map((draw) =>
        draw.kind === "draw" ? draw.instanceCount : 0,
      ),
    ).toEqual([5000]);
  });
});
