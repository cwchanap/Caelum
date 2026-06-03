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
    state = addBusStop(state, { x: 7, y: 2 }, "busTerminal");
    state = addBusStop(state, { x: 22, y: 2 });
    state = addBusRoute(
      state,
      state.transit.stops.map((s) => s.id),
    );
    const terminal = state.transit.stops.find(
      (s) => s.kind === "busTerminal",
    )!;
    const routeId = state.transit.routes[0].id;

    const ui = {
      ...createUiState(),
      activeTool: "inspect" as const,
      selectedId: "7,2",
    };
    const shell = selectShellState(state, ui);

    expect(shell.inspector).not.toBeNull();
    expect(shell.inspector!.nodeId).toBe(terminal.id);
    expect(shell.inspector!.canReassign).toBe(true);
    const routeIds = shell.inspector!.platforms.flatMap((p) =>
      p.routes.map((r) => r.id),
    );
    expect(routeIds).toContain(routeId);
    const routeChip = shell.inspector!.platforms
      .flatMap((p) => p.routes)
      .find((r) => r.id === routeId)!;
    expect(routeChip.moveTargets.map((t) => t.label).sort()).toEqual([
      "B",
      "C",
    ]);
  });

  it("reports platform occupancy from waiting citizens", () => {
    let state = { ...createInitialGameState(), budget: 1_000_000 };
    state = addBusStop(state, { x: 7, y: 2 }, "busTerminal");
    state = addBusStop(state, { x: 22, y: 2 });
    state = addBusRoute(
      state,
      state.transit.stops.map((s) => s.id),
    );
    const terminal = state.transit.stops.find(
      (s) => s.kind === "busTerminal",
    )!;
    const routeId = state.transit.routes[0].id;

    const waiter = waitingBusCitizen("c-wait", terminal.position, routeId);
    state = { ...state, citizens: [...state.citizens, waiter] };

    const ui = {
      ...createUiState(),
      activeTool: "inspect" as const,
      selectedId: "7,2",
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

    const lineChip = shell.inspector!.platforms
      .flatMap((p) => p.routes)
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
