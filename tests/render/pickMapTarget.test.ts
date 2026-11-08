import { describe, expect, it } from "vitest";
import {
  pickMapTarget,
  type MapPickTargets,
} from "../../src/render/webgpu/pickMapTarget";
import {
  VEHICLE_INSTANCE_FLOATS,
  VEHICLE_LANE_OFFSET_PX,
} from "../../src/render/webgpu/renderer";
import {
  VEHICLE_HALF_LENGTH,
  VEHICLE_HALF_WIDTH,
} from "../../src/render/webgpu/vehicleInstances";
import type {
  GameState,
  Point,
  RouteLegPath,
  TransitPath,
} from "../../src/domain/types";
import {
  addTestBusRoute,
  addTestBusStop,
  addTestMetroLine,
  addTestMetroStation,
  createTestGameState,
  placeTestBuilding,
} from "../helpers/gameState";
import { pointsOnRow, withRoads, withTracks } from "../helpers/mapFixtures";

/** Drawn-frame pick input in the shape encodeVehicleInstances leaves it:
 *  post-cull ids in instance order, centers in the world-space buffer. */
function pickTargets(
  samples: { id: string; point: Point }[],
  state: GameState,
): MapPickTargets {
  const positions = new Float32Array(samples.length * VEHICLE_INSTANCE_FLOATS);
  samples.forEach((sample, index) => {
    positions[index * VEHICLE_INSTANCE_FLOATS] = sample.point.x;
    positions[index * VEHICLE_INSTANCE_FLOATS + 1] = sample.point.y;
  });
  return {
    vehicleIds: samples.map((sample) => sample.id),
    positions,
    state,
  };
}

function corridorState(routeCount = 1): GameState {
  let state = createTestGameState();
  state = withRoads(state, pointsOnRow(8, 7, 15));
  state = addTestBusStop(state, { x: 7, y: 8 });
  state = addTestBusStop(state, { x: 15, y: 8 });
  for (let index = 0; index < routeCount; index += 1) {
    state = addTestBusRoute(state, ["stop-001", "stop-002"]);
  }
  return state;
}

function metroCorridorState(lineCount: number): GameState {
  let state = createTestGameState();
  state = withTracks(state, pointsOnRow(8, 7, 15));
  state = addTestMetroStation(state, { x: 7, y: 8 });
  state = addTestMetroStation(state, { x: 15, y: 8 });
  for (let index = 0; index < lineCount; index += 1) {
    state = addTestMetroLine(state, ["station-001", "station-002"]);
  }
  return state;
}

function uTurnTerminalLeg(terminal: Point): RouteLegPath {
  const path: TransitPath = {
    kind: "road",
    steps: [
      {
        position: { x: terminal.x, y: terminal.y },
        enteringHeading: "east",
        leavingHeading: "west",
        movement: "uTurn",
        geometry: {
          kind: "quadraticBezier",
          from: { x: terminal.x, y: terminal.y },
          control: { x: terminal.x + 0.5, y: terminal.y - 1 },
          to: { x: terminal.x, y: terminal.y },
        },
        travelSeconds: 0.5,
      },
    ],
    totalTravelSeconds: 0.5,
  };
  return {
    fromWaypointId: "stop-002",
    toWaypointId: "stop-002",
    direction: "loop",
    kind: "terminalReversal",
    status: "connected",
    currentPath: path,
    lastValidPath: path,
    estimatedSeconds: 0.5,
    failureReason: null,
  };
}

function withTerminalUTurn(state: GameState, terminal: Point): GameState {
  return {
    ...state,
    transit: {
      ...state.transit,
      routes: state.transit.routes.map((route) => ({
        ...route,
        legs: [...route.legs, uTurnTerminalLeg(terminal)],
      })),
    },
  };
}

function staleLegEndingAt(to: Point): RouteLegPath {
  const from = { x: to.x - 1, y: to.y };
  const path: TransitPath = {
    kind: "road",
    steps: [
      {
        position: { x: from.x, y: from.y },
        enteringHeading: "east",
        leavingHeading: "east",
        movement: "straight",
        geometry: {
          kind: "line",
          from: { x: from.x, y: from.y },
          to: { x: to.x, y: to.y },
        },
        travelSeconds: 1.25,
      },
    ],
    totalTravelSeconds: 1.25,
  };
  return {
    fromWaypointId: "stop-001",
    toWaypointId: "stop-002",
    direction: "outbound",
    kind: "service",
    status: "networkDisconnected",
    currentPath: null,
    lastValidPath: path,
    estimatedSeconds: null,
    failureReason: "networkDisconnected",
  };
}

function reconnectingLeg(from: Point): RouteLegPath {
  const path: TransitPath = {
    kind: "road",
    steps: [
      {
        position: { x: from.x, y: from.y },
        enteringHeading: "west",
        leavingHeading: "west",
        movement: "straight",
        geometry: {
          kind: "line",
          from: { x: from.x, y: from.y },
          to: { x: from.x - 1, y: from.y },
        },
        travelSeconds: 1.25,
      },
    ],
    totalTravelSeconds: 1.25,
  };
  return {
    fromWaypointId: "stop-002",
    toWaypointId: "stop-001",
    direction: "return",
    kind: "service",
    status: "connected",
    currentPath: path,
    lastValidPath: path,
    estimatedSeconds: 1.25,
    failureReason: null,
  };
}

function turningLeg(): RouteLegPath {
  const path: TransitPath = {
    kind: "road",
    steps: [
      {
        position: { x: 9, y: 8 },
        enteringHeading: "east",
        leavingHeading: "south",
        movement: "rightTurn",
        geometry: {
          kind: "quadraticBezier",
          from: { x: 9, y: 8 },
          control: { x: 9.5, y: 8 },
          to: { x: 9, y: 9 },
        },
        travelSeconds: 0.5,
      },
      {
        position: { x: 9, y: 9 },
        enteringHeading: "south",
        leavingHeading: "south",
        movement: "straight",
        geometry: {
          kind: "line",
          from: { x: 9, y: 9 },
          to: { x: 9, y: 10 },
        },
        travelSeconds: 1.25,
      },
    ],
    totalTravelSeconds: 1.75,
  };
  return {
    fromWaypointId: "stop-001",
    toWaypointId: "stop-002",
    direction: "outbound",
    kind: "service",
    status: "connected",
    currentPath: path,
    lastValidPath: path,
    estimatedSeconds: 1.75,
    failureReason: null,
  };
}

describe("pickMapTarget", () => {
  it("misses before any frame has been drawn", () => {
    expect(pickMapTarget(null, { x: 80, y: 80 }, { x: 2, y: 2 })).toBeNull();
  });

  it("picks the vehicle drawn on the clicked tile", () => {
    const pick = pickMapTarget(
      pickTargets(
        [{ id: "vehicle-001", point: { x: 80, y: 80 } }],
        createTestGameState(),
      ),
      { x: 90, y: 88 },
      { x: 2, y: 2 },
    );

    expect(pick).toEqual({ vehicleId: "vehicle-001", lineId: null });
  });

  it("does not let a vehicle drawn on a neighboring tile steal a building click", () => {
    let state = createTestGameState();
    state = placeTestBuilding(state, "smallHouse", { x: 9, y: 7 }, 0);
    // The bus is 12px from the click — inside the pick radius — but it was
    // drawn on tile (9,8), not the clicked building tile (9,7).
    const pick = pickMapTarget(
      pickTargets([{ id: "vehicle-001", point: { x: 300, y: 259 } }], state),
      { x: 300, y: 247 },
      { x: 9, y: 7 },
    );

    expect(pick).toBeNull();
  });

  it("picks the vehicle at its rendered body center and visible edge", () => {
    const origin = { x: 304, y: 272 };
    const targets = pickTargets(
      [{ id: "vehicle-001", point: origin }],
      createTestGameState(),
    );

    expect(
      pickMapTarget(
        targets,
        { x: origin.x, y: origin.y - VEHICLE_LANE_OFFSET_PX },
        { x: 9, y: 8 },
      ),
    ).toEqual({ vehicleId: "vehicle-001", lineId: null });
    expect(
      pickMapTarget(
        targets,
        {
          x: origin.x + VEHICLE_HALF_LENGTH - 2,
          y: origin.y - VEHICLE_LANE_OFFSET_PX - VEHICLE_HALF_WIDTH + 1,
        },
        { x: 9, y: 8 },
      ),
    ).toEqual({ vehicleId: "vehicle-001", lineId: null });
  });

  it("does not let the enlarged body steal a click on the adjacent building tile", () => {
    let state = createTestGameState();
    state = placeTestBuilding(state, "smallHouse", { x: 9, y: 7 }, 0);
    const origin = { x: 304, y: 260 };
    const targets = pickTargets([{ id: "vehicle-001", point: origin }], state);

    expect(
      pickMapTarget(
        targets,
        {
          x: origin.x,
          y: origin.y - VEHICLE_LANE_OFFSET_PX - VEHICLE_HALF_WIDTH,
        },
        { x: 9, y: 7 },
      ),
    ).toBeNull();
    expect(
      pickMapTarget(targets, { x: origin.x, y: origin.y - 3 }, { x: 9, y: 8 }),
    ).toEqual({ vehicleId: "vehicle-001", lineId: null });
  });

  it("picks the nearest of two samples", () => {
    const pick = pickMapTarget(
      pickTargets(
        [
          { id: "vehicle-001", point: { x: 80, y: 80 } },
          { id: "vehicle-002", point: { x: 84, y: 80 } },
        ],
        createTestGameState(),
      ),
      { x: 83, y: 80 },
      { x: 2, y: 2 },
    );

    expect(pick).toEqual({ vehicleId: "vehicle-002", lineId: null });
  });
});

describe("pickMapTarget line paths", () => {
  it("hits a line whose presented step is on the clicked tile", () => {
    const state = corridorState();

    const pick = pickMapTarget(
      pickTargets([], state),
      { x: 300, y: 272 },
      { x: 9, y: 8 },
    );

    expect(pick).toEqual({ vehicleId: null, lineId: "route-001" });
  });

  it("stays pickable up to the path end tile", () => {
    const state = corridorState();

    const pick = pickMapTarget(
      pickTargets([], state),
      { x: 491, y: 272 },
      { x: 15, y: 8 },
    );

    expect(pick).toEqual({ vehicleId: null, lineId: "route-001" });
  });

  it("does not let a shared-corridor proximity radius steal an adjacent building tile", () => {
    let state = corridorState(2);
    state = placeTestBuilding(state, "smallHouse", { x: 9, y: 7 }, 0);

    expect(
      pickMapTarget(pickTargets([], state), { x: 300, y: 255 }, { x: 9, y: 7 }),
    ).toBeNull();
  });

  it("picks the nearest of two lines sharing the corridor, then the stable id", () => {
    const state = corridorState(2);

    expect(
      pickMapTarget(pickTargets([], state), { x: 300, y: 271 }, { x: 9, y: 8 }),
    ).toEqual({ vehicleId: null, lineId: "route-001" });
    expect(
      pickMapTarget(pickTargets([], state), { x: 300, y: 273 }, { x: 9, y: 8 }),
    ).toEqual({ vehicleId: null, lineId: "route-002" });
    expect(
      pickMapTarget(pickTargets([], state), { x: 300, y: 272 }, { x: 9, y: 8 }),
    ).toEqual({ vehicleId: null, lineId: "route-001" });
  });

  it("returns both candidates when a vehicle and a line share the click", () => {
    const state = corridorState();

    const pick = pickMapTarget(
      pickTargets([{ id: "vehicle-001", point: { x: 300, y: 272 } }], state),
      { x: 300, y: 272 },
      { x: 9, y: 8 },
    );

    expect(pick).toEqual({ vehicleId: "vehicle-001", lineId: "route-001" });
  });

  it("does not let an offset terminal U-turn curve claim the neighboring tile", () => {
    let state = corridorState(2);
    state = withTerminalUTurn(state, { x: 15, y: 8 });
    state = placeTestBuilding(state, "smallHouse", { x: 15, y: 7 }, 0);

    expect(
      pickMapTarget(
        pickTargets([], state),
        { x: 502, y: 255 },
        { x: 15, y: 7 },
      ),
    ).toBeNull();
    expect(
      pickMapTarget(
        pickTargets([], state),
        { x: 502, y: 258 },
        { x: 15, y: 8 },
      ),
    ).toEqual({ vehicleId: null, lineId: "route-001" });
  });

  it("does not let a wide shared bus corridor's offset lane claim the neighboring tile", () => {
    let state = corridorState(10);
    state = placeTestBuilding(state, "smallHouse", { x: 9, y: 7 }, 0);

    expect(
      pickMapTarget(pickTargets([], state), { x: 300, y: 255 }, { x: 9, y: 7 }),
    ).toBeNull();
    expect(
      pickMapTarget(pickTargets([], state), { x: 300, y: 256 }, { x: 9, y: 8 }),
    ).toEqual({ vehicleId: null, lineId: "route-001" });
  });

  it("keeps a wide shared metro corridor off the neighboring tile too", () => {
    let state = metroCorridorState(10);
    state = placeTestBuilding(state, "smallHouse", { x: 9, y: 7 }, 0);

    expect(
      pickMapTarget(pickTargets([], state), { x: 300, y: 255 }, { x: 9, y: 7 }),
    ).toBeNull();
    expect(
      pickMapTarget(pickTargets([], state), { x: 300, y: 256 }, { x: 9, y: 8 }),
    ).toEqual({ vehicleId: null, lineId: "metro-001" });
  });

  it("does not let a retained last-valid endpoint claim a tile with no presented step", () => {
    let state = corridorState();
    state = {
      ...state,
      transit: {
        ...state.transit,
        routes: state.transit.routes.map((route) => ({
          ...route,
          legs: [
            staleLegEndingAt({ x: 14, y: 8 }),
            reconnectingLeg({ x: 15, y: 9 }),
          ],
        })),
      },
    };
    state = placeTestBuilding(state, "smallHouse", { x: 14, y: 7 }, 90);

    expect(
      pickMapTarget(
        pickTargets([], state),
        { x: 464, y: 272 },
        { x: 14, y: 8 },
      ),
    ).toBeNull();
    expect(
      pickMapTarget(
        pickTargets([], state),
        { x: 432, y: 272 },
        { x: 13, y: 8 },
      ),
    ).toEqual({ vehicleId: null, lineId: "route-001" });
    expect(
      pickMapTarget(
        pickTargets([], state),
        { x: 490, y: 304 },
        { x: 15, y: 9 },
      ),
    ).toEqual({ vehicleId: null, lineId: "route-001" });
  });

  it("measures an eligible line's displayed geometry across incoming step curves", () => {
    let state = corridorState();
    state = {
      ...state,
      transit: {
        ...state.transit,
        routes: state.transit.routes.map((route) => ({
          ...route,
          legs: [turningLeg()],
        })),
      },
    };

    expect(
      pickMapTarget(pickTargets([], state), { x: 311, y: 289 }, { x: 9, y: 9 }),
    ).toEqual({ vehicleId: null, lineId: "route-001" });
  });
});
