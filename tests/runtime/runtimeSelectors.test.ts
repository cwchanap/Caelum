import { describe, expect, it } from "vitest";
import { COSTS } from "../../src/domain/catalog/transit";
import type { ActiveTrip } from "../../src/domain/types";
import { selectShellState } from "../../src/runtime/runtimeSelectors";
import { normalizeRustSnapshot } from "../../src/runtime/snapshotView";
import { createUiState } from "../../src/ui/uiState";
import { createDraft } from "../../src/ui/routeDraft";
import type { RoutePreviewResponse } from "../../src/runtime/backend/types";
import { createRustSnapshot } from "../fixtures/rustSnapshot";
import {
  addTestBusRoute,
  addTestBusStop,
  addTestMetroLine,
  addTestMetroStation,
  createTestGameState,
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
      legs: [{ mode: "bus", from: position, to: { x: 0, y: 0 }, lineId }],
    },
    currentLegIndex: 0,
    patienceRemaining: 100,
  };
}

describe("selectShellState inspector", () => {
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

    expect(shell.inspector).not.toBeNull();
    expect(shell.inspector!.nodeId).toBe(terminal.id);
    expect(shell.inspector!.canReassign).toBe(true);
    const routeIds = shell.inspector!.platforms.flatMap((p) =>
      p.routes.map((r) => r.id),
    );
    expect(routeIds).toContain(routeId);
    const routeChip = shell
      .inspector!.platforms.flatMap((p) => p.routes)
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

    expect(shell.inspector).not.toBeNull();
    const routedPlatforms = shell.inspector!.platforms.filter((p) =>
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

    expect(shell.inspector).not.toBeNull();
    expect(shell.inspector!.nodeId).toBe(station.id);
    expect(shell.inspector!.nodeLabel).toBe("Metro Station");
    expect(shell.inspector!.canReassign).toBe(true);

    const lineChip = shell
      .inspector!.platforms.flatMap((p) => p.routes)
      .find((r) => r.id === line.id);
    expect(lineChip).toBeDefined();
    expect(lineChip!.name).toBe(line.name);
    expect(lineChip!.color).toBe(line.color);
  });

  it("emits null inspector for an empty tile", () => {
    const state = createTestGameState();
    const ui = { ...createUiState(), selectedId: "0,0" };
    expect(selectShellState(state, ui).inspector).toBeNull();
  });
});

describe("route selectors", () => {
  function routePreview(
    waypointIds: string[],
    affordable = true,
  ): RoutePreviewResponse {
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
      })),
      totalTravelSeconds: waypointIds.length,
      initialVehicleCost: COSTS.bus,
      affordable,
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

  it("returns null draft when not drafting", () => {
    const shell = selectShellState(createTestGameState(), createUiState());
    expect(shell.routeDraft).toBe(null);
  });

  it("derives a bus draft with stop labels and a finish gate", () => {
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
    expect(shell.routeDraft?.stops).toEqual([
      { index: 0, label: "Bus Stop", coord: "(7,8)" },
    ]);
    expect(shell.routeDraft?.canFinish).toBe(false);
    expect(shell.routeDraft?.finishHint).toBe("Add another stop");
  });

  it("enables finish at two affordable stops", () => {
    const state = twoStops();
    const ui = {
      ...createUiState(),
      activeTool: "busRoute" as const,
      routeDraft: busDraft(["stop-001", "stop-002"], true),
    };
    expect(selectShellState(state, ui).routeDraft?.canFinish).toBe(true);
  });

  it("blocks finish when unaffordable with a cost hint", () => {
    const state = { ...twoStops(), budget: 1_000 };
    const ui = {
      ...createUiState(),
      activeTool: "busRoute" as const,
      routeDraft: {
        ...busDraft(["stop-001", "stop-002"], true),
        preview: routePreview(["stop-001", "stop-002"], false),
      },
    };
    const draft = selectShellState(state, ui).routeDraft;
    expect(draft?.canFinish).toBe(false);
    expect(draft?.finishHint).toBe("Need $8,000");
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
        status: { primary: "running", pausedAfterRepair: false },
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
        status: { primary: "running", pausedAfterRepair: false },
        failures: [],
      },
    ]);
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
          toLabel: "Stop C",
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
});

describe("ShellHudState", () => {
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

  it("derives the active tool chip and default cancel state", () => {
    const state = createTestGameState();
    const ui = createUiState();
    const shell = selectShellState(state, ui);

    expect(shell.hud.activeCategory).toBe("brief");
    expect(shell.hud.activeToolChip).toBe("INSPECT");
    expect(shell.hud.canCancel).toBe(false);
    expect(shell.hud.badges.routeDraftActive).toBe(false);
    expect(shell.hud.badges.routeCount).toBe(0);
    expect(shell.hud.badges.activeOverlayLabel).toBeNull();
    expect(shell.hud.badges.inspectActive).toBe(false);
  });

  it("treats an overlay-only inspect state as cancellable", () => {
    // Enabling a data overlay while staying on the inspect tool must still
    // arm Cancel/Escape so the player can clear the overlay without diving
    // back into the Data drawer. resetUi() clears activeOverlay, so the gate
    // must let it through.
    const state = createTestGameState();
    const ui = { ...createUiState(), activeOverlay: "coverage" as const };
    const shell = selectShellState(state, ui);

    expect(shell.hud.canCancel).toBe(true);
    expect(shell.hud.badges.activeOverlayLabel).toBe("Coverage");
  });

  it("flags cancellable state and overlay label", () => {
    const state = createTestGameState();
    const ui = {
      ...createUiState(),
      activeTool: "busRoute" as const,
      activeOverlay: "coverage" as const,
      routeDraft: {
        ...createDraft("bus", 1),
        waypointIds: ["stop-001"],
      },
    };
    const shell = selectShellState(state, ui);

    expect(shell.hud.canCancel).toBe(true);
    expect(shell.hud.badges.routeDraftActive).toBe(true);
    expect(shell.hud.badges.activeOverlayLabel).toBe("Coverage");
  });

  // Lock the full OVERLAY_LABELS map so a new overlay or a renamed label is
  // caught here rather than rendering as `undefined` in the bottom-bar badge.
  it.each([
    ["coverage", "Coverage"],
    ["crowding", "Crowding"],
    ["demand", "Demand"],
    ["lateness", "Lateness"],
    ["growth", "Growth"],
  ] as const)(
    "derives the badge label for the %s overlay",
    (overlay, label) => {
      const state = createTestGameState();
      const ui = { ...createUiState(), activeOverlay: overlay };
      const shell = selectShellState(state, ui);

      expect(shell.hud.badges.activeOverlayLabel).toBe(label);
    },
  );

  it("treats a selected route (no draft/building/overlay) as cancellable", () => {
    // When only selectedRouteId is set — no draft, no building, no overlay,
    // tool === "inspect" — the player must still be able to dismiss the route
    // halo via Cancel/Escape. resetUi() clears selectedRouteId, so the gate
    // must let it through.
    const state = createTestGameState();
    const ui = { ...createUiState(), selectedRouteId: "route-001" };
    const shell = selectShellState(state, ui);

    expect(shell.hud.canCancel).toBe(true);
  });

  it("formats a selected area as the active tool and allows cancel", () => {
    const state = createTestGameState();
    const ui = {
      ...createUiState(),
      activeTool: "area" as const,
      selectedArea: "commercial" as const,
    };
    const shell = selectShellState(state, ui);

    expect(shell.hud.activeToolChip).toBe("AREA COMMERCIAL");
    expect(shell.hud.canCancel).toBe(true);
  });

  it("counts routes and metro lines together", () => {
    let state = createTestGameState();
    state = withRoads(state, pointsOnRow(2, 7, 15));
    state = addTestBusStop(state, { x: 7, y: 2 });
    state = addTestBusStop(state, { x: 15, y: 2 });
    const stopIds = state.transit.stops.map((s) => s.id);
    state = addTestBusRoute(state, stopIds);
    state = withTracks(state, pointsOnRow(0, 3, 9));
    state = addTestMetroStation(state, { x: 3, y: 0 });
    state = addTestMetroStation(state, { x: 9, y: 0 });
    state = addTestMetroLine(state, ["station-001", "station-002"]);
    const shell = selectShellState(state, createUiState());

    expect(shell.hud.badges.routeCount).toBe(2);
  });
});

describe("selectShellState build HUD fields", () => {
  it("exposes buildCategory from ui", () => {
    const hud = selectShellState(createTestGameState(), {
      ...createUiState(),
      buildCategory: "bus",
    }).hud;
    expect(hud.buildCategory).toBe("bus");
  });

  it("marks inspect active only when inspect tool with no building/area", () => {
    const base = createTestGameState();
    expect(
      selectShellState(base, { ...createUiState(), activeTool: "inspect" }).hud
        .inspectToolActive,
    ).toBe(true);
    expect(
      selectShellState(base, {
        ...createUiState(),
        activeTool: "inspect",
        selectedBuilding: "smallHouse",
      }).hud.inspectToolActive,
    ).toBe(false);
    expect(
      selectShellState(base, {
        ...createUiState(),
        activeTool: "inspect",
        selectedArea: "residential",
      }).hud.inspectToolActive,
    ).toBe(false);
  });

  it("marks remove active when the remove tool is selected", () => {
    const hud = selectShellState(createTestGameState(), {
      ...createUiState(),
      activeTool: "remove",
    }).hud;
    expect(hud.removeToolActive).toBe(true);
    expect(hud.inspectToolActive).toBe(false);
  });
});
