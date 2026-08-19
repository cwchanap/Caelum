import { describe, expect, it } from "vitest";
import { COSTS } from "../../src/domain/catalog/transit";
import type {
  ActiveTrip,
  ServiceMetrics,
  LegFailureReason,
  RouteLegPath,
} from "../../src/domain/types";
import {
  selectRouteFailures,
  selectShellState,
} from "../../src/runtime/runtimeSelectors";
import { normalizeRoutePreviewResponse } from "../../src/runtime/backend/shared";
import { routeFailureGuidance } from "../../src/runtime/rejectionMessages";
import { normalizeRustSnapshot } from "../../src/runtime/snapshotView";
import type { RoadMutationPreviewResponse } from "../../src/runtime/backend/types";
import { createUiState } from "../../src/ui/uiState";
import {
  canSaveRouteDraft,
  createDraft,
  editDraft,
} from "../../src/ui/routeDraft";
import type { RoutePreviewResponse } from "../../src/runtime/backend/types";
import { createRustSnapshot } from "../fixtures/rustSnapshot";
import {
  addTestBusRoute,
  addTestBusStop,
  assignTestVehicle,
  addTestMetroLine,
  addTestMetroStation,
  createTestGameState,
  placeTestBuilding,
} from "../helpers/gameState";
import {
  pointsOnColumn,
  pointsOnRow,
  withRoads,
  withTracks,
} from "../helpers/mapFixtures";

// Waiting commuters live in `state.activeTrips` in the Rust-backed runtime,
// so the occupancy selector reads `activeTrips`. Build a waiting trip.
function waitingBusTrip(
  id: string,
  position: { x: number; y: number },
  lineId: string,
): ActiveTrip {
  return {
    id,
    simId: `sim-${id}`,
    purpose: "commuteOutbound",
    origin: position,
    destination: { x: 0, y: 0 },
    position,
    status: "waiting",
    deadline: 9_999,
    routePlan: {
      estimatedSeconds: 100,
      legs: [
        {
          mode: "bus",
          from: position,
          to: { x: 0, y: 0 },
          lineId,
          serviceDirection: "loop",
          boardItineraryIndex: 0,
          alightItineraryIndex: 0,
        },
      ],
    },
    currentLegIndex: 0,
    patienceRemaining: 100,
    currentLegWaitSeconds: 0,
    privateCarTrip: null,
  };
}

describe("selectShellState inspector", () => {
  function inspectAt(selectedId: string) {
    return {
      ...createUiState(),
      activeTool: "inspect" as const,
      selectedId,
    };
  }

  function testSim(
    id: string,
    home: { x: number; y: number },
    workplace?: { x: number; y: number },
  ) {
    return {
      id,
      home,
      position: home,
      workerProfile: "worker" as const,
      shiftTemplate: null,
      workplace,
      commuteDay: 0,
      outboundResolvedToday: false,
      outboundArrivedToday: false,
      returnResolvedToday: false,
      returnedHomeToday: false,
    };
  }

  it("emits a residents building inspector from snapshot membership", () => {
    let state = createTestGameState();
    state = placeTestBuilding(state, "smallHouse", { x: 1, y: 1 }, 0);
    const building = state.buildings[0];
    state = {
      ...state,
      sims: [testSim("sim-001", { x: 2, y: 1 })],
    };

    const inspector = selectShellState(state, inspectAt("1,1")).inspector;

    expect(inspector).toEqual({
      kind: "building",
      buildingId: building.id,
      buildingLabel: "Small House",
      metricLabel: "Residents",
      occupancy: 1,
      capacity: 4,
    });
  });

  it("emits a jobs building inspector from snapshot membership", () => {
    let state = createTestGameState();
    state = placeTestBuilding(state, "supermarket", { x: 5, y: 1 }, 0);
    const building = state.buildings[0];
    state = {
      ...state,
      sims: [testSim("sim-001", { x: 1, y: 1 }, { x: 6, y: 2 })],
    };

    const inspector = selectShellState(state, inspectAt("5,1")).inspector;

    expect(inspector).toEqual({
      kind: "building",
      buildingId: building.id,
      buildingLabel: "Supermarket",
      metricLabel: "Jobs",
      occupancy: 1,
      capacity: 4,
    });
  });

  it("returns no inspector for a zero-capacity building without a node", () => {
    let state = createTestGameState();
    state = placeTestBuilding(state, "busStop", { x: 4, y: 4 }, 0);
    state = { ...state, transit: { ...state.transit, stops: [] } };

    expect(selectShellState(state, inspectAt("4,4")).inspector).toBeNull();
  });

  it("emits an inspector block for a selected terminal with route chips", () => {
    let state = { ...createTestGameState(), budget: 1_000_000 };
    state = withRoads(state, pointsOnColumn(14, 7, 8));
    state = addTestBusStop(state, { x: 14, y: 7 }, "busTerminal");
    state = addTestBusStop(state, { x: 14, y: 8 });
    state = addTestBusRoute(
      state,
      state.transit.stops.map((s) => s.id),
    );
    const terminal = state.transit.stops.find((s) => s.kind === "busTerminal")!;
    const routeId = state.transit.routes[0].id;

    const ui = {
      ...createUiState(),
      activeTool: "inspect" as const,
      selectedId: "14,7",
    };
    const shell = selectShellState(state, ui);

    const inspector = shell.inspector;
    if (inspector?.kind !== "transit") {
      throw new Error("expected transit inspector");
    }
    expect(inspector.nodeId).toBe(terminal.id);
    expect(inspector.canReassign).toBe(true);
    const routeIds = inspector.platforms.flatMap((p) =>
      p.routes.map((r) => r.id),
    );
    expect(routeIds).toContain(routeId);
    const routeChip = inspector.platforms
      .flatMap((p) => p.routes)
      .find((r) => r.id === routeId)!;
    expect(routeChip.moveTargets.map((t) => t.label).sort()).toEqual([
      "B",
      "C",
    ]);
  });

  it("reports platform occupancy from waiting trips", () => {
    let state = { ...createTestGameState(), budget: 1_000_000 };
    state = withRoads(state, pointsOnColumn(14, 7, 8));
    state = addTestBusStop(state, { x: 14, y: 7 }, "busTerminal");
    state = addTestBusStop(state, { x: 14, y: 8 });
    state = addTestBusRoute(
      state,
      state.transit.stops.map((s) => s.id),
    );
    const terminal = state.transit.stops.find((s) => s.kind === "busTerminal")!;
    const routeId = state.transit.routes[0].id;

    const waiter = waitingBusTrip("c-wait", terminal.position, routeId);
    state = {
      ...state,
      activeTrips: [...(state.activeTrips ?? []), waiter],
    };

    const ui = {
      ...createUiState(),
      activeTool: "inspect" as const,
      selectedId: "14,7",
    };
    const shell = selectShellState(state, ui);

    const inspector = shell.inspector;
    if (inspector?.kind !== "transit") {
      throw new Error("expected transit inspector");
    }
    const routedPlatforms = inspector.platforms.filter((p) =>
      p.routes.some((r) => r.id === routeId),
    );
    // Non-vacuous: the route lives on exactly one platform.
    expect(routedPlatforms).toHaveLength(1);
    expect(routedPlatforms[0].occupancy).toBe(1);
  });

  it("emits a metro-station inspector with line route chips", () => {
    let state = { ...createTestGameState(), budget: 1_000_000 };
    state = withTracks(state, pointsOnRow(2, 7, 22));
    state = addTestMetroStation(state, { x: 7, y: 2 });
    state = addTestMetroStation(state, { x: 22, y: 2 });
    state = addTestMetroLine(
      state,
      state.transit.stations.map((s) => s.id),
    );

    // Non-vacuous preconditions.
    expect(state.transit.stations).toHaveLength(2);
    expect(state.transit.metroLines).toHaveLength(1);

    const station = state.transit.stations[0];
    const line = state.transit.metroLines[0];

    const ui = {
      ...createUiState(),
      activeTool: "inspect" as const,
      selectedId: "7,2",
    };
    const shell = selectShellState(state, ui);

    const inspector = shell.inspector;
    if (inspector?.kind !== "transit") {
      throw new Error("expected transit inspector");
    }
    expect(inspector.nodeId).toBe(station.id);
    expect(inspector.nodeLabel).toBe("Metro Station");
    expect(inspector.canReassign).toBe(true);

    const lineChip = inspector.platforms
      .flatMap((p) => p.routes)
      .find((r) => r.id === line.id);
    expect(lineChip).toBeDefined();
    expect(lineChip!.name).toBe(line.name);
    expect(lineChip!.color).toBe(line.color);
  });

  it("keeps transit inspection first when a building overlaps its tile", () => {
    let state = createTestGameState();
    state = placeTestBuilding(state, "busTerminal", { x: 14, y: 7 }, 0);
    state = placeTestBuilding(state, "smallHouse", { x: 14, y: 7 }, 0);
    const terminal = state.transit.stops[0];

    const inspector = selectShellState(state, inspectAt("14,7")).inspector;

    if (inspector?.kind !== "transit") {
      throw new Error("expected transit inspector");
    }
    expect(inspector.nodeId).toBe(terminal.id);
  });

  it("emits null inspector for an empty tile", () => {
    const state = createTestGameState();
    const ui = { ...createUiState(), selectedId: "0,0" };
    expect(selectShellState(state, ui).inspector).toBeNull();
  });
});

describe("route selectors", () => {
  function routePreview(waypointIds: string[]): RoutePreviewResponse {
    return {
      generation: 1,
      legs: waypointIds.map((id, index) => ({
        fromWaypointId: id,
        toWaypointId: waypointIds[(index + 1) % waypointIds.length],
        direction: "loop",
        kind: "service",
        status: "connected",
        currentPath: null,
        lastValidPath: null,
        estimatedSeconds: 1,
        failureReason: null,
      })),
      totalTravelSeconds: waypointIds.length,
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
    };
  }

  function busDraft(waypointIds: string[], preview = false) {
    return {
      ...createDraft("bus", 1),
      waypointIds,
      generation: 1,
      previewPending: false,
      preview: preview ? routePreview(waypointIds) : null,
    };
  }

  function twoStops() {
    let state = createTestGameState();
    state = withRoads(state, pointsOnRow(8, 7, 15));
    state = addTestBusStop(state, { x: 7, y: 8 });
    state = addTestBusStop(state, { x: 15, y: 8 });
    return state;
  }

  function twoStations() {
    let state = createTestGameState();
    state = withTracks(state, pointsOnRow(2, 7, 15));
    state = addTestMetroStation(state, { x: 7, y: 2 });
    state = addTestMetroStation(state, { x: 15, y: 2 });
    return state;
  }

  function failedLeg(
    fromWaypointId: string,
    toWaypointId: string,
    status: RouteLegPath["status"],
    failureReason: RouteLegPath["failureReason"],
    kind: RouteLegPath["kind"] = "service",
  ): RouteLegPath {
    return {
      fromWaypointId,
      toWaypointId,
      direction: "loop",
      kind,
      status,
      currentPath: null,
      lastValidPath: null,
      estimatedSeconds: null,
      failureReason,
    };
  }

  it.each([
    {
      reason: "noRoadAccess" as const,
      pattern: "shuttle" as const,
      legKind: "service" as const,
      isLoopClosing: false,
      guidance: "Stop has no adjacent road.",
    },
    {
      reason: "networkDisconnected" as const,
      pattern: "loop" as const,
      legKind: "service" as const,
      isLoopClosing: true,
      guidance: "Loop can't close here; remove a stop or switch to Shuttle.",
    },
    {
      reason: "noLegalEntryHeading" as const,
      pattern: "shuttle" as const,
      legKind: "service" as const,
      isLoopClosing: false,
      guidance: "Road direction doesn't allow serving this stop here.",
    },
    {
      reason: "noLegalExitHeading" as const,
      pattern: "shuttle" as const,
      legKind: "service" as const,
      isLoopClosing: false,
      guidance: "Road direction doesn't allow serving this stop here.",
    },
    {
      reason: "noLegalTurnaround" as const,
      pattern: "shuttle" as const,
      legKind: "terminalReversal" as const,
      isLoopClosing: false,
      guidance: "No legal U-turn here; add a junction or roundabout.",
    },
  ] satisfies Array<{
    reason: LegFailureReason;
    pattern: "loop" | "shuttle";
    legKind: RouteLegPath["kind"];
    isLoopClosing: boolean;
    guidance: string;
  }>)(
    "projects $reason with endpoint labels, leg context, and guidance",
    (failure) => {
      const rows = selectRouteFailures(
        twoStops(),
        failure.pattern,
        ["stop-001", "stop-002"],
        [
          failedLeg(
            "stop-002",
            "stop-001",
            "networkDisconnected",
            failure.reason,
            failure.legKind,
          ),
        ],
      );

      expect(rows).toEqual([
        {
          legIndex: 0,
          fromWaypointId: "stop-002",
          toWaypointId: "stop-001",
          fromLabel: "Stop B",
          toLabel: "Stop A",
          reason: failure.reason,
          legKind: failure.legKind,
          isLoopClosing: failure.isLoopClosing,
          guidance: failure.guidance,
        },
      ]);
    },
  );

  it.each([
    {
      kind: "stop" as const,
      state: () => {
        const state = twoStops();
        return {
          ...state,
          transit: {
            ...state.transit,
            stops: state.transit.stops.map((stop) =>
              stop.id === "stop-002"
                ? { ...stop, status: "missing" as const }
                : stop,
            ),
          },
        };
      },
      waypointIds: ["stop-001", "stop-002"],
      fromWaypointId: "stop-001",
      toWaypointId: "stop-002",
      fromLabel: "Stop A",
      toLabel: "Missing Bus Stop",
    },
    {
      kind: "station" as const,
      state: () => {
        const state = twoStations();
        return {
          ...state,
          transit: {
            ...state.transit,
            stations: state.transit.stations.map((station) =>
              station.id === "station-002"
                ? { ...station, status: "missing" as const }
                : station,
            ),
          },
        };
      },
      waypointIds: ["station-001", "station-002"],
      fromWaypointId: "station-001",
      toWaypointId: "station-002",
      fromLabel: "Station A",
      toLabel: "Missing Metro Station",
    },
  ])("projects missing $kind labels and missingNodeKind", (failure) => {
    const rows = selectRouteFailures(
      failure.state(),
      "loop",
      failure.waypointIds,
      [
        failedLeg(
          failure.fromWaypointId,
          failure.toWaypointId,
          "missingNode",
          null,
        ),
      ],
    );

    expect(rows).toEqual([
      {
        legIndex: 0,
        fromWaypointId: failure.fromWaypointId,
        toWaypointId: failure.toWaypointId,
        fromLabel: failure.fromLabel,
        toLabel: failure.toLabel,
        reason: "missingNode",
        legKind: "service",
        isLoopClosing: false,
        guidance: "Restore the missing node at its former location.",
        missingNodeKind: failure.kind,
      },
    ]);
  });

  it("returns null draft when not drafting", () => {
    const shell = selectShellState(createTestGameState(), createUiState());
    expect(shell.routeDraft).toBe(null);
  });

  it("derives a bus editor with waypoint labels and a Save gate", () => {
    const state = twoStops();
    const ui = {
      ...createUiState(),
      activeTool: "busRoute" as const,
      routeDraft: {
        ...createDraft("bus", 1),
        waypointIds: ["stop-001"],
      },
    };
    const shell = selectShellState(state, ui);
    expect(shell.routeDraft?.mode).toBe("bus");
    expect(shell.routeDraft?.waypoints).toEqual([
      {
        id: "stop-001",
        index: 0,
        label: "Stop A",
        status: "present",
        selected: false,
      },
    ]);
    expect(shell.routeDraft?.canSave).toBe(false);
    expect(shell.routeDraft?.previewMessage).toBe(
      "Add at least two waypoints.",
    );
  });

  it("derives route history controls and notices into the editor view", () => {
    const state = createTestGameState();
    const checkpoint = {
      waypointIds: ["stop-001"],
      pattern: "loop" as const,
      selectedIndex: null,
      interaction: "append" as const,
      mode: "bus" as const,
      source: { kind: "create" as const },
    };
    const ui = {
      ...createUiState(),
      activeTool: "busRoute" as const,
      routeDraft: createDraft("bus", 1),
      routeDraftHistory: {
        past: [checkpoint],
        future: [checkpoint],
      },
      routeDraftNotice: {
        kind: "alreadyOnRoute" as const,
        waypointId: "stop-001",
      },
    };

    expect(selectShellState(state, ui).routeDraft).toMatchObject({
      canUndo: true,
      canRedo: true,
      notice: { kind: "alreadyOnRoute", waypointId: "stop-001" },
    });
  });

  it("enables Save at two connected stops", () => {
    const state = twoStops();
    const ui = {
      ...createUiState(),
      activeTool: "busRoute" as const,
      routeDraft: busDraft(["stop-001", "stop-002"], true),
    };
    expect(selectShellState(state, ui).routeDraft?.canSave).toBe(true);
  });

  it("keeps the selector Save gate in parity with the shared predicate", () => {
    const state = twoStops();
    const routeDraft = busDraft(["stop-001", "stop-002"], true);
    const ui = {
      ...createUiState(),
      activeTool: "busRoute" as const,
      routeDraft,
    };

    expect(selectShellState(state, ui).routeDraft?.canSave).toBe(
      canSaveRouteDraft(routeDraft),
    );
  });

  it("allows Save for a free Metro creation", () => {
    const state = { ...twoStations(), budget: 1_000 };
    const ui = {
      ...createUiState(),
      activeTool: "metroLine" as const,
      routeDraft: {
        ...createDraft("metro", 1),
        waypointIds: ["station-001", "station-002"],
        generation: 1,
        previewPending: false,
        preview: {
          ...routePreview(["station-001", "station-002"]),
        },
      },
    };
    const draft = selectShellState(state, ui).routeDraft;
    expect(draft?.canSave).toBe(true);
    expect(draft?.previewMessage).toBe("Connected");
  });

  it("offers Reload after a stale edit rejection", () => {
    const state = twoStops();
    const ui = {
      ...createUiState(),
      activeTool: "busRoute" as const,
      routeDraft: {
        ...editDraft(
          {
            routeId: "route-001",
            expectedRevision: 0,
            mode: "bus",
            pattern: "loop",
            waypointIds: ["stop-001", "stop-002"],
          },
          1,
        ),
        generation: 1,
        previewPending: false,
        preview: routePreview(["stop-001", "stop-002"]),
      },
    };

    const draft = selectShellState(state, ui, {
      code: "routeChangedWhileEditing",
      context: { routeId: "route-001", affectedRouteIds: ["route-001"] },
    }).routeDraft;

    expect(draft).toMatchObject({
      canReload: true,
      canSave: false,
      previewStatus: "rejected",
      previewMessage:
        "This route changed while you were editing it. Reload the saved route.",
    });
  });

  it("does not apply another route's stale rejection to the active editor", () => {
    const state = twoStops();
    const ui = {
      ...createUiState(),
      activeTool: "busRoute" as const,
      routeDraft: {
        ...editDraft(
          {
            routeId: "route-001",
            expectedRevision: 0,
            mode: "bus",
            pattern: "loop",
            waypointIds: ["stop-001", "stop-002"],
          },
          1,
        ),
        generation: 1,
        previewPending: false,
        preview: routePreview(["stop-001", "stop-002"]),
      },
    };

    expect(
      selectShellState(state, ui, {
        code: "routeChangedWhileEditing",
        context: {
          routeId: "route-999",
          affectedRouteIds: ["route-999"],
        },
      }).routeDraft,
    ).toMatchObject({
      canReload: false,
      canSave: true,
      previewStatus: "connected",
      previewMessage: "Connected",
    });
  });

  it("builds an edit view that retains missing-node labels and names rejected endpoints", () => {
    let state = twoStops();
    state = addTestBusRoute(state, ["stop-001", "stop-002"]);
    state = {
      ...state,
      transit: {
        ...state.transit,
        stops: state.transit.stops.map((node) =>
          node.id === "stop-002"
            ? { ...node, status: "missing" as const }
            : node,
        ),
      },
    };
    const preview = routePreview(["stop-001", "stop-002"]);
    preview.legs[0] = {
      ...preview.legs[0],
      status: "missingNode",
      currentPath: null,
    };
    preview.missingWaypointIds = ["stop-002"];
    const ui = {
      ...createUiState(),
      activeTool: "busRoute" as const,
      routeDraft: {
        ...editDraft(
          {
            routeId: "route-001",
            expectedRevision: 0,
            mode: "bus",
            pattern: "loop",
            waypointIds: ["stop-001", "stop-002"],
          },
          1,
        ),
        previewPending: false,
        preview,
      },
    };

    const editor = selectShellState(state, ui).routeDraft;
    expect(editor).toMatchObject({
      source: "edit",
      title: "Editing Bus 1",
      previewStatus: "broken",
    });
    expect(editor?.waypoints[1]).toMatchObject({
      id: "stop-002",
      status: "missing",
      label: "Missing Bus Stop",
    });
    expect(editor?.previewMessage).toContain("Stop A");
    expect(editor?.previewMessage).toContain("Missing Bus Stop");
    expect(editor?.failures).toMatchObject([
      {
        legIndex: 0,
        reason: "missingNode",
        legKind: "service",
        isLoopClosing: false,
        guidance: "Restore the missing node at its former location.",
      },
    ]);
  });

  it("projects normalized loop-closing failures into draft and persisted views", () => {
    let state = twoStops();
    const preview = routePreview(["stop-001", "stop-002"]);
    preview.legs[1] = {
      ...preview.legs[1],
      status: "networkDisconnected",
      failureReason: undefined as unknown as null,
      currentPath: null,
    };
    const normalizedPreview = normalizeRoutePreviewResponse(preview);
    const draft = selectShellState(state, {
      ...createUiState(),
      activeTool: "busRoute" as const,
      routeDraft: {
        ...busDraft(["stop-001", "stop-002"]),
        preview: normalizedPreview,
      },
    }).routeDraft;

    expect(draft?.failures).toMatchObject([
      {
        legIndex: 1,
        fromWaypointId: "stop-002",
        toWaypointId: "stop-001",
        fromLabel: "Stop B",
        toLabel: "Stop A",
        reason: "networkDisconnected",
        legKind: "service",
        isLoopClosing: true,
        guidance: routeFailureGuidance("networkDisconnected", {
          isLoopClosing: true,
          legKind: "service",
        }),
      },
    ]);

    state = addTestBusRoute(state, ["stop-001", "stop-002"]);
    state = {
      ...state,
      transit: {
        ...state.transit,
        routes: state.transit.routes.map((route) => ({
          ...route,
          pathBroken: true,
          legs: route.legs.map((leg, index) =>
            index === 1
              ? {
                  ...leg,
                  status: "networkDisconnected" as const,
                  currentPath: null,
                  failureReason: null,
                }
              : leg,
          ),
        })),
      },
    };

    const persisted = selectShellState(state, createUiState()).routes[0];
    expect(persisted.failures[0]).toMatchObject({
      legIndex: 1,
      reason: "networkDisconnected",
      legKind: "service",
      isLoopClosing: true,
      guidance: draft?.failures[0].guidance,
    });
  });

  it("keeps terminal reversal failures out of loop-closing guidance", () => {
    const state = twoStops();
    const preview = routePreview(["stop-001", "stop-002"]);
    preview.legs[1] = {
      ...preview.legs[1],
      kind: "terminalReversal",
      status: "networkDisconnected",
      failureReason: "noLegalTurnaround",
      currentPath: null,
    };
    const editor = selectShellState(state, {
      ...createUiState(),
      activeTool: "busRoute" as const,
      routeDraft: {
        ...busDraft(["stop-001", "stop-002"]),
        pattern: "shuttle",
        preview,
      },
    }).routeDraft;

    expect(editor?.failures[0]).toMatchObject({
      reason: "noLegalTurnaround",
      legKind: "terminalReversal",
      isLoopClosing: false,
      guidance: "No legal U-turn here; add a junction or roundabout.",
    });
  });

  it("lists routes and metro lines with selection state", () => {
    let state = twoStops();
    state = addTestBusRoute(state, ["stop-001", "stop-002"]);
    state = withTracks(state, pointsOnRow(0, 3, 9));
    state = addTestMetroStation(state, { x: 3, y: 0 });
    state = addTestMetroStation(state, { x: 9, y: 0 });
    state = addTestMetroLine(state, ["station-001", "station-002"]);
    const ui = { ...createUiState(), selectedRouteId: "route-001" };
    const shell = selectShellState(state, ui);
    expect(shell.routes).toEqual([
      {
        id: "route-001",
        name: "Bus 1",
        color: "#e04f39",
        mode: "bus",
        stopCount: 2,
        active: true,
        selected: true,
        status: { primary: "noFleet", pausedAfterRepair: false },
        service: {
          targetHeadwaySeconds: null,
          roundTripSeconds: null,
          assignedFleet: 0,
          requiredFleet: null,
          estimatedDeploymentCost: null,
          nextVehicleCost: null,
          nominalHeadwaySeconds: null,
          waitingAtRiskCount: 0,
          longestWaitSeconds: null,
        },
        failures: [],
      },
      {
        id: "metro-001",
        name: "Metro 1",
        color: "#2867b2",
        mode: "metro",
        stopCount: 2,
        active: true,
        selected: false,
        status: { primary: "noFleet", pausedAfterRepair: false },
        service: {
          targetHeadwaySeconds: null,
          roundTripSeconds: null,
          assignedFleet: 0,
          requiredFleet: null,
          estimatedDeploymentCost: null,
          nextVehicleCost: null,
          nominalHeadwaySeconds: null,
          waitingAtRiskCount: 0,
          longestWaitSeconds: null,
        },
        failures: [],
      },
    ]);
  });

  function busRouteWithMetrics(
    metrics: ServiceMetrics | null,
    targetHeadwaySeconds: number | null = null,
  ) {
    let state = twoStops();
    state = addTestBusRoute(state, ["stop-001", "stop-002"]);
    return {
      ...state,
      transit: {
        ...state.transit,
        routes: state.transit.routes.map((route) => ({
          ...route,
          targetHeadwaySeconds,
          serviceMetrics: metrics,
        })),
      },
    };
  }

  it("flags an active connected bus with zero assigned fleet as noFleet", () => {
    const state = busRouteWithMetrics(null);
    expect(selectShellState(state, createUiState()).routes[0]).toMatchObject({
      status: { primary: "noFleet", pausedAfterRepair: false },
      service: {
        targetHeadwaySeconds: null,
        roundTripSeconds: null,
        assignedFleet: 0,
        requiredFleet: null,
        estimatedDeploymentCost: null,
        nextVehicleCost: null,
        nominalHeadwaySeconds: null,
        waitingAtRiskCount: 0,
        longestWaitSeconds: null,
      },
    });
  });

  it("uses route vehicle IDs for fleet lifecycle when service metrics are unavailable", () => {
    let state = busRouteWithMetrics(null);
    state = assignTestVehicle(state, "bus", "route-001");

    expect(selectShellState(state, createUiState()).routes[0]).toMatchObject({
      status: { primary: "running", pausedAfterRepair: false },
      service: {
        assignedFleet: 1,
        roundTripSeconds: null,
        requiredFleet: null,
        estimatedDeploymentCost: null,
        nextVehicleCost: null,
        nominalHeadwaySeconds: null,
        waitingAtRiskCount: 0,
        longestWaitSeconds: null,
      },
    });
  });

  it("keeps noFleet below paused and broken in status precedence", () => {
    const base = busRouteWithMetrics(null);
    const paused = {
      ...base,
      transit: {
        ...base.transit,
        routes: base.transit.routes.map((route) => ({
          ...route,
          active: false,
        })),
      },
    };
    expect(selectShellState(paused, createUiState()).routes[0]).toMatchObject({
      status: { primary: "paused", pausedAfterRepair: false },
    });

    const broken = {
      ...base,
      transit: {
        ...base.transit,
        routes: base.transit.routes.map((route) => ({
          ...route,
          pathBroken: true,
        })),
      },
    };
    expect(selectShellState(broken, createUiState()).routes[0]).toMatchObject({
      status: { primary: "broken", pausedAfterRepair: false },
    });
  });

  it("exposes target headway and required fleet before deployment", () => {
    const state = busRouteWithMetrics(
      {
        roundTripSeconds: 600,
        assignedFleet: 0,
        requiredFleet: 2,
        estimatedDeploymentCost: null,
        nextVehicleCost: null,
        nominalHeadwaySeconds: null,
        waitingAtRiskCount: 0,
        longestWaitSeconds: null,
      },
      300,
    );
    expect(selectShellState(state, createUiState()).routes[0]).toMatchObject({
      status: { primary: "noFleet", pausedAfterRepair: false },
      service: {
        targetHeadwaySeconds: 300,
        roundTripSeconds: 600,
        assignedFleet: 0,
        requiredFleet: 2,
        estimatedDeploymentCost: null,
        nextVehicleCost: null,
        nominalHeadwaySeconds: null,
        waitingAtRiskCount: 0,
        longestWaitSeconds: null,
      },
    });
  });

  it("exposes nominal headway and assigned fleet after deployment", () => {
    let state = busRouteWithMetrics(
      {
        roundTripSeconds: 600,
        assignedFleet: 2,
        requiredFleet: 2,
        estimatedDeploymentCost: null,
        nextVehicleCost: null,
        nominalHeadwaySeconds: 300,
        waitingAtRiskCount: 0,
        longestWaitSeconds: null,
      },
      300,
    );
    state = assignTestVehicle(state, "bus", "route-001");
    state = assignTestVehicle(state, "bus", "route-001");
    expect(selectShellState(state, createUiState()).routes[0]).toMatchObject({
      status: { primary: "running", pausedAfterRepair: false },
      service: {
        targetHeadwaySeconds: 300,
        roundTripSeconds: 600,
        assignedFleet: 2,
        requiredFleet: 2,
        estimatedDeploymentCost: null,
        nextVehicleCost: null,
        nominalHeadwaySeconds: 300,
        waitingAtRiskCount: 0,
        longestWaitSeconds: null,
      },
    });
  });

  it("flags an active connected metro with zero assigned fleet as noFleet", () => {
    let state = twoStations();
    state = addTestMetroLine(state, ["station-001", "station-002"]);
    expect(selectShellState(state, createUiState()).routes[0]).toMatchObject({
      mode: "metro",
      status: { primary: "noFleet", pausedAfterRepair: false },
      service: {
        targetHeadwaySeconds: null,
        roundTripSeconds: null,
        assignedFleet: 0,
        requiredFleet: null,
        estimatedDeploymentCost: null,
        nextVehicleCost: null,
        nominalHeadwaySeconds: null,
        waitingAtRiskCount: 0,
        longestWaitSeconds: null,
      },
    });
  });

  it("passes Metro Rust service metrics through the generic service row", () => {
    let state = twoStations();
    state = addTestMetroLine(state, ["station-001", "station-002"]);
    state = {
      ...state,
      transit: {
        ...state.transit,
        metroLines: state.transit.metroLines.map((line) => ({
          ...line,
          targetHeadwaySeconds: 300,
          serviceMetrics: {
            roundTripSeconds: 900,
            assignedFleet: 0,
            requiredFleet: 3,
            estimatedDeploymentCost: 150_000,
            nextVehicleCost: null,
            nominalHeadwaySeconds: null,
            waitingAtRiskCount: 0,
            longestWaitSeconds: null,
          },
        })),
      },
    };

    expect(selectShellState(state, createUiState()).routes[0]).toMatchObject({
      mode: "metro",
      status: { primary: "noFleet", pausedAfterRepair: false },
      service: {
        targetHeadwaySeconds: 300,
        roundTripSeconds: 900,
        assignedFleet: 0,
        requiredFleet: 3,
        estimatedDeploymentCost: 150_000,
        nextVehicleCost: null,
        nominalHeadwaySeconds: null,
        waitingAtRiskCount: 0,
        longestWaitSeconds: null,
      },
    });
  });

  it("shows a Metro row running with Rust nominal headway after vehicles exist", () => {
    let state = twoStations();
    state = addTestMetroLine(state, ["station-001", "station-002"]);
    state = {
      ...state,
      transit: {
        ...state.transit,
        metroLines: state.transit.metroLines.map((line) => ({
          ...line,
          targetHeadwaySeconds: 300,
          serviceMetrics: {
            roundTripSeconds: 900,
            assignedFleet: 2,
            requiredFleet: 3,
            estimatedDeploymentCost: 150_000,
            nextVehicleCost: null,
            nominalHeadwaySeconds: 300,
            waitingAtRiskCount: 0,
            longestWaitSeconds: null,
          },
        })),
      },
    };
    state = assignTestVehicle(state, "metro", "metro-001");
    state = assignTestVehicle(state, "metro", "metro-001");

    expect(selectShellState(state, createUiState()).routes[0]).toMatchObject({
      mode: "metro",
      status: { primary: "running", pausedAfterRepair: false },
      service: {
        targetHeadwaySeconds: 300,
        assignedFleet: 2,
        nominalHeadwaySeconds: 300,
        estimatedDeploymentCost: 150_000,
        nextVehicleCost: null,
        waitingAtRiskCount: 0,
        longestWaitSeconds: null,
      },
    });
  });

  it("displays supplied Rust service metrics verbatim even when leg timing disagrees", () => {
    // Deliberate disagreement fixture: cached leg timing (`estimatedSeconds`)
    // sums to 2s while Rust reports a 600s round trip. The row must show the
    // Rust-derived timing and required values — TypeScript must not recompute
    // path timing or derive the fleet from serviceMetrics.
    let state = twoStops();
    state = addTestBusRoute(state, ["stop-001", "stop-002"]);
    state = assignTestVehicle(state, "bus", "route-001");
    state = {
      ...state,
      transit: {
        ...state.transit,
        routes: state.transit.routes.map((route) => ({
          ...route,
          targetHeadwaySeconds: 120,
          legs: route.legs.map((leg) => ({ ...leg, estimatedSeconds: 1 })),
          serviceMetrics: {
            roundTripSeconds: 600,
            assignedFleet: 1,
            requiredFleet: 5,
            estimatedDeploymentCost: null,
            nextVehicleCost: 42_000,
            nominalHeadwaySeconds: 600,
            waitingAtRiskCount: 2,
            longestWaitSeconds: 95,
          },
        })),
      },
    };
    const service = selectShellState(state, createUiState()).routes[0].service;
    expect(service).toMatchObject({
      targetHeadwaySeconds: 120,
      roundTripSeconds: 600,
      assignedFleet: 1,
      requiredFleet: 5,
      estimatedDeploymentCost: null,
      nextVehicleCost: 42_000,
      nominalHeadwaySeconds: 600,
      waitingAtRiskCount: 2,
      longestWaitSeconds: 95,
    });
    expect(service.waitingAtRiskCount).toBe(2);
    expect(service.longestWaitSeconds).toBe(95);
  });

  it("prioritizes Broken while preserving paused-after-repair state", () => {
    let state = createTestGameState();
    state = withRoads(state, pointsOnRow(8, 7, 15));
    state = addTestBusStop(state, { x: 7, y: 8 });
    state = addTestBusStop(state, { x: 11, y: 8 });
    state = addTestBusStop(state, { x: 15, y: 8 });
    state = addTestBusRoute(state, ["stop-001", "stop-002", "stop-003"]);
    state = {
      ...state,
      transit: {
        ...state.transit,
        stops: state.transit.stops.map((stop) =>
          stop.id === "stop-003" ? { ...stop, status: "missing" } : stop,
        ),
        routes: state.transit.routes.map((route) => ({
          ...route,
          active: false,
          pathBroken: true,
          legs: route.legs.map((leg, legIndex) =>
            legIndex === 1
              ? { ...leg, status: "missingNode", currentPath: null }
              : leg,
          ),
        })),
      },
    };

    expect(selectShellState(state, createUiState()).routes[0]).toMatchObject({
      status: { primary: "broken", pausedAfterRepair: true },
      failures: [
        {
          legIndex: 1,
          fromWaypointId: "stop-002",
          toWaypointId: "stop-003",
          fromLabel: "Stop B",
          toLabel: "Missing Bus Stop",
          reason: "missingNode",
        },
      ],
    });
  });

  it("maps authoritative road preview cost and route impacts for accessible UI", () => {
    let state = twoStops();
    state = addTestBusRoute(state, ["stop-001", "stop-002"]);
    state = {
      ...state,
      transit: {
        ...state.transit,
        routes: state.transit.routes.map((route) => ({
          ...route,
          name: "Route 1",
        })),
      },
    };
    const ui = {
      ...createUiState(),
      roadPreviewGeneration: 4,
      roadMutationPreview: {
        generation: 4,
        changedTiles: [{ x: 9, y: 8 }],
        authoredTiles: [],
        generatedStructures: [],
        cost: 1_250,
        skippedTiles: [],
        routeImpacts: [{ routeId: "route-001", kind: "broken" as const }],
        warnings: [],
        rejection: null,
      },
    };

    expect(selectShellState(state, ui).roadMutationPreview).toEqual({
      generation: 4,
      changedTiles: [{ x: 9, y: 8 }],
      skippedTiles: [],
      authoredTiles: [],
      generatedStructures: [],
      cost: 1_250,
      costLabel: "$1,250",
      routeImpacts: [
        { routeId: "route-001", routeName: "Route 1", kind: "broken" },
      ],
      rejection: null,
    });
  });

  it("shows an incompatibleRouteNode click error before a stale host error", () => {
    // When a prior preview request failed (host error) and the user then
    // clicks an incompatible node, the click error must surface first so
    // the user gets feedback about the wrong click. The host error remains
    // in state (Save stays disabled) and resurfaces once the click error
    // is cleared.
    const state = twoStops();
    const ui = {
      ...createUiState(),
      activeTool: "busRoute" as const,
      routeDraft: busDraft(["stop-001", "stop-002"], true),
      routePreviewError: {
        code: "incompatibleRouteNode" as const,
        context: { nodeId: "station-001", affectedRouteIds: [] },
      },
      routePreviewHostError: "backend unreachable",
    };

    const draft = selectShellState(state, ui).routeDraft;
    expect(draft?.previewStatus).toBe("rejected");
    expect(draft?.previewMessage).toBe(
      "Choose a stop or station that matches this route.",
    );
    expect(draft?.canSave).toBe(false);
  });

  it("shows a missingRouteNode click error before a stale host error", () => {
    const state = twoStops();
    const ui = {
      ...createUiState(),
      activeTool: "busRoute" as const,
      routeDraft: busDraft(["stop-001", "stop-002"], true),
      routePreviewError: {
        code: "missingRouteNode" as const,
        context: { nodeId: "stop-999", affectedRouteIds: [] },
      },
      routePreviewHostError: "backend unreachable",
    };

    const draft = selectShellState(state, ui).routeDraft;
    expect(draft?.previewStatus).toBe("rejected");
    expect(draft?.previewMessage).toBe("That route node is missing.");
  });

  it("surfaces the host error once a transient click error is cleared", () => {
    const state = twoStops();
    const ui = {
      ...createUiState(),
      activeTool: "busRoute" as const,
      routeDraft: busDraft(["stop-001", "stop-002"], true),
      routePreviewError: null,
      routePreviewHostError: "backend unreachable",
    };

    const draft = selectShellState(state, ui).routeDraft;
    expect(draft?.previewStatus).toBe("rejected");
    expect(draft?.previewMessage).toBe("backend unreachable");
  });

  it("keeps surfacing a preview-level missingRouteNode rejection after a generation-stable selection clears the click error", () => {
    // Deferred-preview regression: Rust returns `missingRouteNode` during
    // validate_waypoints with an empty leg list. The runtime stores that
    // authoritative rejection in both `draft.preview.rejection` and
    // `routePreviewError`. A subsequent successful selection-only click is
    // generation-stable (no new preview request), so `applyUiTileClick` /
    // `commitRouteDraft` clear `routePreviewError` (the code is classified
    // transient), but `draft.preview.rejection` stays non-null. The selector
    // must derive the persistent failure from `draft.preview.rejection` —
    // not show "Add at least two waypoints" while Save is disabled.
    const state = twoStops();
    const previewRejection = {
      code: "missingRouteNode" as const,
      context: { nodeId: "stop-999", affectedRouteIds: [] },
    };
    const previewWithRejection: RoutePreviewResponse = {
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
      missingWaypointIds: ["stop-999"],
      warnings: [],
      rejection: previewRejection,
    };
    const ui = {
      ...createUiState(),
      activeTool: "busRoute" as const,
      routeDraft: {
        ...busDraft(["stop-001", "stop-002"]),
        preview: previewWithRejection,
      },
      // The successful generation-stable selection cleared the click error;
      // the preview rejection lives on in `draft.preview.rejection`.
      routePreviewError: null,
      routePreviewHostError: null,
    };

    const draft = selectShellState(state, ui).routeDraft;
    expect(draft?.previewStatus).toBe("rejected");
    expect(draft?.previewMessage).not.toBe("Add at least two waypoints.");
    expect(draft?.canSave).toBe(false);
  });
});

describe("action feedback selector", () => {
  function roadPreview(
    overrides: Partial<RoadMutationPreviewResponse> = {},
  ): RoadMutationPreviewResponse {
    return {
      generation: 3,
      changedTiles: [{ x: 9, y: 8 }],
      skippedTiles: [],
      authoredTiles: [],
      generatedStructures: [],
      cost: 0,
      routeImpacts: [],
      warnings: [],
      rejection: null,
      ...overrides,
    };
  }

  it.each([
    [
      { code: "invalidHeadway" as const, context: {} },
      "Headway must be at least 1 minute.",
    ],
    [
      { code: "headwayNotSet" as const, context: {} },
      "Set a target headway before deploying buses.",
    ],
    [
      { code: "fleetAlreadyAssigned" as const, context: {} },
      "This route already has a bus fleet.",
    ],
  ])("maps bus service rejection %s to player copy", (rejection, message) => {
    const shell = selectShellState(
      createTestGameState(),
      createUiState(),
      rejection,
    );
    expect(shell.actionFeedback).toEqual({
      source: "rejection",
      tone: "error",
      message,
      details: [],
      dismissible: true,
      announce: true,
    });
  });

  it("prioritizes a global gameplay rejection over every road outcome", () => {
    const state = createTestGameState();
    const rejection = {
      code: "insufficientBudget" as const,
      context: { requiredBudget: 1_200, availableBudget: 0 },
    };
    const outcomes = [
      {
        roadMutationPreviewError: "host timed out",
        roadMutationPreview: roadPreview({
          cost: 1_200,
          routeImpacts: [{ routeId: "route-001", kind: "rerouted" as const }],
          rejection: {
            code: "blockedTile" as const,
            context: { point: { x: 9, y: 8 } },
          },
        }),
      },
      {
        roadMutationPreviewError: null,
        roadMutationPreview: roadPreview({ cost: 1_200 }),
      },
    ];

    for (const outcome of outcomes) {
      const shell = selectShellState(
        state,
        {
          ...createUiState(),
          roadPreviewGeneration: 3,
          ...outcome,
        },
        rejection,
      );
      expect(shell.actionFeedback).toEqual({
        source: "rejection",
        tone: "error",
        message: "Needs $1,200; only $0 is available.",
        details: [],
        dismissible: true,
        announce: true,
      });
    }
  });

  it("keeps a current route Save rejection inside its reloadable editor", () => {
    const state = addTestBusStop(
      addTestBusStop(createTestGameState(), { x: 7, y: 7 }),
      { x: 11, y: 7 },
    );
    const ui = {
      ...createUiState(),
      routeDraft: {
        ...editDraft(
          {
            routeId: "route-001",
            expectedRevision: 0,
            mode: "bus",
            pattern: "loop",
            waypointIds: ["stop-001", "stop-002"],
          },
          1,
        ),
        generation: 1,
        previewPending: false,
        preview: null,
      },
    };
    const shell = selectShellState(state, ui, {
      code: "routeChangedWhileEditing",
      context: { routeId: "route-001", affectedRouteIds: ["route-001"] },
    });

    expect(shell.routeDraft?.canReload).toBe(true);
    expect(shell.actionFeedback).toBeNull();
  });

  it("keeps a matching non-reloadable route-save rejection inside the editor", () => {
    const state = addTestBusStop(
      addTestBusStop(createTestGameState(), { x: 7, y: 7 }),
      { x: 11, y: 7 },
    );
    const rejection = {
      code: "routeRevisionExhausted" as const,
      context: { routeId: "route-001", actualRevision: 9 },
    };
    const ui = {
      ...createUiState(),
      routeDraft: {
        ...editDraft(
          {
            routeId: "route-001",
            expectedRevision: 0,
            mode: "bus",
            pattern: "loop",
            waypointIds: ["stop-001", "stop-002"],
          },
          1,
        ),
        generation: 1,
        previewPending: false,
        preview: null,
      },
      routePreviewError: rejection,
    };
    const shell = selectShellState(state, ui, rejection);

    expect(shell.routeDraft?.canReload).toBe(false);
    expect(shell.actionFeedback).toBeNull();
  });

  it("prioritizes a road host error over road rejection and impact", () => {
    const shell = selectShellState(createTestGameState(), {
      ...createUiState(),
      roadPreviewGeneration: 3,
      roadMutationPreviewError: "host timed out",
      roadMutationPreview: roadPreview({
        cost: 1_200,
        routeImpacts: [{ routeId: "route-001", kind: "rerouted" as const }],
        rejection: {
          code: "blockedTile" as const,
          context: { point: { x: 9, y: 8 } },
        },
      }),
    });

    expect(shell.actionFeedback).toEqual({
      source: "roadHostError",
      tone: "warning",
      message: "Road preview unavailable: host timed out",
      details: [],
      dismissible: false,
      announce: false,
    });
  });

  it("prioritizes a road rejection over cost and route impacts", () => {
    const shell = selectShellState(createTestGameState(), {
      ...createUiState(),
      roadPreviewGeneration: 3,
      roadMutationPreview: roadPreview({
        cost: 1_200,
        routeImpacts: [{ routeId: "route-001", kind: "rerouted" as const }],
        rejection: {
          code: "blockedTile" as const,
          context: { point: { x: 9, y: 8 } },
        },
      }),
    });

    expect(shell.actionFeedback).toEqual({
      source: "roadRejection",
      tone: "warning",
      message: "That tile is blocked.",
      details: [],
      dismissible: false,
      announce: false,
    });
  });

  it("formats material road cost and every affected route", () => {
    let state = addTestBusStop(
      addTestBusStop(createTestGameState(), { x: 7, y: 7 }),
      { x: 11, y: 7 },
    );
    state = addTestBusRoute(state, ["stop-001", "stop-002"]);
    state = addTestMetroStation(state, { x: 7, y: 2 });
    state = addTestMetroStation(state, { x: 11, y: 2 });
    state = addTestMetroLine(state, ["station-001", "station-002"]);
    state = {
      ...state,
      transit: {
        ...state.transit,
        routes: state.transit.routes.map((route) => ({
          ...route,
          name: "Loop 1",
        })),
        metroLines: state.transit.metroLines.map((line) => ({
          ...line,
          name: "Metro A",
        })),
      },
    };
    const shell = selectShellState(state, {
      ...createUiState(),
      roadPreviewGeneration: 3,
      roadMutationPreview: roadPreview({
        cost: 1_200,
        routeImpacts: [
          { routeId: "route-001", kind: "rerouted" as const },
          { routeId: "metro-001", kind: "broken" as const },
        ],
      }),
    });

    expect(shell.actionFeedback).toEqual({
      source: "roadImpact",
      tone: "info",
      message: "Preview cost $1,200",
      details: ["Loop 1 will reroute", "Metro A will become broken"],
      dismissible: false,
      announce: false,
    });
  });

  it("returns no feedback for empty or stale road previews", () => {
    const state = createTestGameState();
    expect(selectShellState(state, createUiState()).actionFeedback).toBeNull();

    expect(
      selectShellState(state, {
        ...createUiState(),
        roadPreviewGeneration: 4,
        roadMutationPreview: roadPreview({ generation: 3, cost: 1_200 }),
      }).actionFeedback,
    ).toBeNull();
  });
});

describe("ShellCommandState and ShellCityState", () => {
  it("exposes bus terminal cost from the shared transit catalog", () => {
    expect(COSTS.busTerminal).toBe(12_000);
  });

  it("formats Rust snapshot clock and population from sims", () => {
    const state = normalizeRustSnapshot(
      createRustSnapshot({
        day: 1,
        clockMinutes: 9 * 60 + 5,
        sims: [
          {
            id: "sim-001",
            home: { x: 1, y: 1 },
            position: { x: 1, y: 1 },
            workerProfile: "worker",
            shiftTemplate: "standard",
            workplace: { x: 8, y: 2 },
            commuteDay: 1,
            outboundResolvedToday: false,
            outboundArrivedToday: false,
            returnResolvedToday: false,
            returnedHomeToday: false,
          },
          {
            id: "sim-002",
            home: { x: 2, y: 1 },
            position: { x: 2, y: 1 },
            workerProfile: "nonWorker",
            commuteDay: 1,
            outboundResolvedToday: false,
            outboundArrivedToday: false,
            returnResolvedToday: false,
            returnedHomeToday: false,
          },
        ],
      }),
    );

    const shell = selectShellState(state, createUiState());

    expect(shell.topbar.time).toBe("Day 2 09:05");
    expect(shell.topbar.population).toBe("2");
  });

  it("starts in Select with no command destination", () => {
    const state = createTestGameState();
    const ui = createUiState();
    const shell = selectShellState(state, ui);

    expect(shell.command).toMatchObject({
      activeDestination: null,
      activeModeLabel: "SELECT",
      routeDraftActive: false,
      selectActive: true,
      demolishActive: false,
      lineCount: 0,
      activeOverlayLabel: null,
    });
    expect("brief" in shell).toBe(false);
    expect("hud" in shell).toBe(false);
  });

  it("derives Select and Demolish command labels and active overlays", () => {
    const state = createTestGameState();
    expect(
      selectShellState(state, {
        ...createUiState(),
        activeOverlay: "coverage",
      }).command,
    ).toMatchObject({
      activeModeLabel: "SELECT",
      activeOverlayLabel: "Coverage",
    });
    expect(
      selectShellState(state, {
        ...createUiState(),
        activeTool: "remove",
      }).command,
    ).toMatchObject({
      activeModeLabel: "DEMOLISH",
      demolishActive: true,
      selectActive: false,
    });
  });

  it("pins a route draft to Lines and counts bus plus metro lines", () => {
    const state = createTestGameState();
    const ui = {
      ...createUiState(),
      activeTool: "busRoute" as const,
      activeCommandDestination: "lines" as const,
      routeDraft: {
        ...createDraft("bus", 1),
        waypointIds: ["stop-001"],
      },
    };
    expect(selectShellState(state, ui).command).toMatchObject({
      activeDestination: "lines",
      routeDraftActive: true,
    });
  });

  it("formats a single active placement label", () => {
    const state = createTestGameState();
    const ui = {
      ...createUiState(),
      activeTool: "area" as const,
      selectedArea: "commercial" as const,
    };
    expect(selectShellState(state, ui).command.activeModeLabel).toBe(
      "AREA COMMERCIAL",
    );
  });

  it("returns city summary values from the current sandbox snapshot", () => {
    const base = createTestGameState();
    const state = {
      ...base,
      rules: {
        ...base.rules,
        economyPreset: "creative" as const,
        sandbox: { ...base.rules.sandbox, templateId: "blankGrid" as const },
      },
      paused: true,
      metrics: { ...base.metrics, lateTrips: 4, unservedTrips: 2 },
    };
    expect(selectShellState(state, createUiState()).city).toMatchObject({
      title: "Creative Sandbox",
      template: "Blank Grid",
      simulation: "Paused",
      population: "0",
      lineCount: "0",
      networkSummary: "4 late · 2 unserved",
    });

    expect(selectShellState(state, createUiState()).topbar).toMatchObject({
      late: "4",
      unserved: "2",
      networkSummary: "4 late · 2 unserved",
    });
  });
});
