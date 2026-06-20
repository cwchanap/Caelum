import { describe, expect, it } from "vitest";
import {
  addBusRoute,
  addBusStop,
  addMetroLine,
  addMetroStation,
} from "../../src/simulation/transit";
import { createInitialGameState } from "../../src/simulation/gameState";
import { selectShellState } from "../../src/runtime/runtimeSelectors";
import { createUiState } from "../../src/ui/uiState";
import type { Citizen } from "../../src/domain/types";
import {
  pointsOnColumn,
  pointsOnRow,
  withRoads,
  withTracks,
} from "../helpers/mapFixtures";

function waitingBusCitizen(
  id: string,
  position: { x: number; y: number },
  lineId: string,
): Citizen {
  return {
    id,
    home: position,
    destination: { x: 0, y: 0 },
    position,
    status: "waiting",
    patienceRemaining: 100,
    deadline: 9_999,
    routePlan: {
      estimatedSeconds: 100,
      legs: [{ mode: "bus", from: position, to: { x: 0, y: 0 }, lineId }],
    },
    currentLegIndex: 0,
  };
}

describe("selectShellState inspector", () => {
  it("emits an inspector block for a selected terminal with route chips", () => {
    let state = { ...createInitialGameState(), budget: 1_000_000 };
    state = withRoads(state, pointsOnColumn(14, 7, 8));
    state = addBusStop(state, { x: 14, y: 7 }, "busTerminal");
    state = addBusStop(state, { x: 14, y: 8 });
    state = addBusRoute(
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

  it("reports platform occupancy from waiting citizens", () => {
    let state = { ...createInitialGameState(), budget: 1_000_000 };
    state = withRoads(state, pointsOnColumn(14, 7, 8));
    state = addBusStop(state, { x: 14, y: 7 }, "busTerminal");
    state = addBusStop(state, { x: 14, y: 8 });
    state = addBusRoute(
      state,
      state.transit.stops.map((s) => s.id),
    );
    const terminal = state.transit.stops.find((s) => s.kind === "busTerminal")!;
    const routeId = state.transit.routes[0].id;

    const waiter = waitingBusCitizen("c-wait", terminal.position, routeId);
    state = { ...state, citizens: [...state.citizens, waiter] };

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
    let state = { ...createInitialGameState(), budget: 1_000_000 };
    state = withTracks(state, pointsOnRow(2, 7, 22));
    state = addMetroStation(state, { x: 7, y: 2 });
    state = addMetroStation(state, { x: 22, y: 2 });
    state = addMetroLine(
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
    const state = createInitialGameState();
    const ui = { ...createUiState(), selectedId: "0,0" };
    expect(selectShellState(state, ui).inspector).toBeNull();
  });
});

describe("route selectors", () => {
  function twoStops() {
    let state = createInitialGameState();
    state = withRoads(state, pointsOnRow(8, 7, 15));
    state = addBusStop(state, { x: 7, y: 8 });
    state = addBusStop(state, { x: 15, y: 8 });
    return state;
  }

  it("returns null draft when not drafting", () => {
    const shell = selectShellState(createInitialGameState(), createUiState());
    expect(shell.routeDraft).toBe(null);
  });

  it("derives a bus draft with stop labels and a finish gate", () => {
    const state = twoStops();
    const ui = {
      ...createUiState(),
      activeTool: "busRoute" as const,
      draftStopIds: ["stop-001"],
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
      draftStopIds: ["stop-001", "stop-002"],
    };
    expect(selectShellState(state, ui).routeDraft?.canFinish).toBe(true);
  });

  it("blocks finish when unaffordable with a cost hint", () => {
    const state = { ...twoStops(), budget: 1_000 };
    const ui = {
      ...createUiState(),
      activeTool: "busRoute" as const,
      draftStopIds: ["stop-001", "stop-002"],
    };
    const draft = selectShellState(state, ui).routeDraft;
    expect(draft?.canFinish).toBe(false);
    expect(draft?.finishHint).toBe("Need $8,000");
  });

  it("lists routes and metro lines with selection state", () => {
    let state = twoStops();
    state = addBusRoute(state, ["stop-001", "stop-002"]);
    state = withTracks(state, pointsOnRow(0, 3, 9));
    state = addMetroStation(state, { x: 3, y: 0 });
    state = addMetroStation(state, { x: 9, y: 0 });
    state = addMetroLine(state, ["station-001", "station-002"]);
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
      },
      {
        id: "metro-001",
        name: "Metro 1",
        color: "#2867b2",
        mode: "metro",
        stopCount: 2,
        active: true,
        selected: false,
      },
    ]);
  });
});

describe("ShellHudState", () => {
  it("derives the active tool chip and default cancel state", () => {
    const state = createInitialGameState();
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
    const state = createInitialGameState();
    const ui = { ...createUiState(), activeOverlay: "coverage" as const };
    const shell = selectShellState(state, ui);

    expect(shell.hud.canCancel).toBe(true);
    expect(shell.hud.badges.activeOverlayLabel).toBe("Coverage");
  });

  it("flags cancellable state and overlay label", () => {
    const state = createInitialGameState();
    const ui = {
      ...createUiState(),
      activeTool: "busRoute" as const,
      activeOverlay: "coverage" as const,
      draftStopIds: ["stop-001"],
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
      const state = createInitialGameState();
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
    const state = createInitialGameState();
    const ui = { ...createUiState(), selectedRouteId: "route-001" };
    const shell = selectShellState(state, ui);

    expect(shell.hud.canCancel).toBe(true);
  });

  it("formats a selected area as the active tool and allows cancel", () => {
    const state = createInitialGameState();
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
    let state = createInitialGameState();
    state = withRoads(state, pointsOnRow(2, 7, 15));
    state = addBusStop(state, { x: 7, y: 2 });
    state = addBusStop(state, { x: 15, y: 2 });
    const stopIds = state.transit.stops.map((s) => s.id);
    state = addBusRoute(state, stopIds);
    state = withTracks(state, pointsOnRow(0, 3, 9));
    state = addMetroStation(state, { x: 3, y: 0 });
    state = addMetroStation(state, { x: 9, y: 0 });
    state = addMetroLine(state, ["station-001", "station-002"]);
    const shell = selectShellState(state, createUiState());

    expect(shell.hud.badges.routeCount).toBe(2);
  });
});
