import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import App from "../../src/App.svelte";
import {
  addTestBusRoute,
  addTestBusStop,
  createTestGameState,
} from "../helpers/gameState";
import { withRoads } from "../helpers/mapFixtures";
import { createDraft } from "../../src/ui/routeDraft";
import { createUiState } from "../../src/ui/uiState";
import { selectShellState } from "../../src/runtime/runtimeSelectors";
import type {
  RuntimeController,
  RuntimeSnapshot,
} from "../../src/runtime/types";

function createRuntimeHarness(
  options: {
    state?: ReturnType<typeof createTestGameState>;
    ui?: ReturnType<typeof createUiState>;
  } = {},
): { runtime: RuntimeController; getSnapshot: () => RuntimeSnapshot } {
  const state = options.state ?? createTestGameState();
  let ui = options.ui ?? createUiState();
  const listeners = new Set<(snapshot: RuntimeSnapshot) => void>();
  const persistence = {
    activeCity: {
      id: "city-1",
      name: "Harbour City",
      createdAt: "2026-01-01T00:00:00.000Z",
      savedAt: "2026-01-01T00:00:00.000Z",
    },
    busy: false,
    dirty: false,
    error: null,
  } as const;
  const snapshot = (): RuntimeSnapshot => ({
    state,
    ui,
    shell: selectShellState(state, ui),
    persistence,
    backendError: null,
    rejection: null,
    sandboxResetError: null,
  });
  const publish = (): RuntimeSnapshot => {
    const next = snapshot();
    for (const listener of listeners) listener(next);
    return next;
  };
  const runtime = {
    persistence: {
      listCities: vi.fn(),
      save: vi.fn(),
      load: vi.fn(),
      createCity: vi.fn(),
      renameCity: vi.fn(),
      deleteCity: vi.fn(),
    },
    getSnapshot: snapshot,
    subscribe: vi.fn((listener: (next: RuntimeSnapshot) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    start: vi.fn(),
    stop: vi.fn(),
    dispose: vi.fn(),
    isRunning: vi.fn(() => false),
    setCommandDestination: vi.fn((destination) => {
      ui = {
        ...ui,
        activeCommandDestination:
          destination === ui.activeCommandDestination ? null : destination,
        activeBuildGroup:
          destination === "build" && destination !== ui.activeCommandDestination
            ? ui.activeBuildGroup
            : null,
      };
      return publish();
    }),
    setBuildGroup: vi.fn((group) => {
      ui = { ...ui, activeBuildGroup: group };
      return publish();
    }),
    setTool: vi.fn((tool) => {
      ui = {
        ...ui,
        activeTool: tool,
        activeCommandDestination:
          tool === "busRoute" || tool === "metroLine" ? "lines" : null,
        routeDraft:
          tool === "busRoute" || tool === "metroLine"
            ? createDraft(tool === "busRoute" ? "bus" : "metro", 1)
            : null,
      };
      return publish();
    }),
    setArea: vi.fn(() => publish()),
    setBuilding: vi.fn(() => publish()),
    setRoadPreset: vi.fn(() => publish()),
    armRoad: vi.fn(() => publish()),
    armRoundabout: vi.fn(() => publish()),
    rotateBuilding: vi.fn(() => publish()),
    setOverlay: vi.fn((overlay) => {
      ui = { ...ui, activeOverlay: overlay };
      return publish();
    }),
    handleEscape: vi.fn(() => publish()),
    togglePause: vi.fn(() => publish()),
    setSpeed: vi.fn(() => publish()),
    assignRouteToPlatform: vi.fn(() => publish()),
    selectRouteWaypoint: vi.fn(() => publish()),
    removeRouteWaypoint: vi.fn(() => publish()),
    undoRouteDraft: vi.fn(() => publish()),
    redoRouteDraft: vi.fn(() => publish()),
    moveRouteWaypoint: vi.fn(() => publish()),
    reverseRouteDraft: vi.fn(() => publish()),
    setRoutePattern: vi.fn(() => publish()),
    saveRouteDraft: vi.fn(async () => publish()),
    cancelRouteDraft: vi.fn(() => {
      ui = {
        ...ui,
        activeTool: "inspect",
        activeCommandDestination: "lines",
        routeDraft: null,
      };
      return publish();
    }),
    reloadRouteDraft: vi.fn(() => publish()),
    startRouteEdit: vi.fn(() => publish()),
    renameRoute: vi.fn(async () => publish()),
    recolorRoute: vi.fn(async () => publish()),
    toggleRouteActive: vi.fn(async () => publish()),
    deleteRoute: vi.fn(async () => publish()),
    selectRoute: vi.fn(() => publish()),
    focusRouteFailure: vi.fn(() => publish()),
    setHoverTile: vi.fn(() => publish()),
    previewRoadMutation: vi.fn(() => publish()),
    dismissRejection: vi.fn(() => publish()),
    tick: vi.fn(async () => publish()),
    reset: vi.fn(async () => publish()),
    resetUi: vi.fn(() => publish()),
    startDrag: vi.fn(() => publish()),
    setDragCurrent: vi.fn(() => publish()),
    commitDrag: vi.fn(async () => publish()),
    cancelDrag: vi.fn(() => publish()),
    handleTileClick: vi.fn(async () => publish()),
    mountCanvas: vi.fn(() => () => {}),
  } as unknown as RuntimeController;
  return { runtime, getSnapshot: snapshot };
}

describe("App command shell", () => {
  it("starts in Select with no command panel open", () => {
    const { runtime } = createRuntimeHarness();
    render(App, { props: { runtime } });
    expect(screen.getByTestId("command-shelf")).toBeVisible();
    expect(screen.queryByTestId("command-panel")).toBeNull();
    expect(screen.queryByTestId("panel-inspect")).toBeNull();
    expect(screen.getByTestId("command-tool-select")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("shows one command panel at a time and contextual Inspect only when no destination is open", async () => {
    let state = createTestGameState();
    state = withRoads(state, [{ x: 7, y: 7 }]);
    state = addTestBusStop(state, { x: 7, y: 7 });
    const { runtime } = createRuntimeHarness({
      state,
      ui: { ...createUiState(), selectedId: "7,7" },
    });
    render(App, { props: { runtime } });
    expect(screen.getByTestId("panel-inspect")).toBeVisible();
    await fireEvent.click(screen.getByTestId("command-destination-build"));
    expect(screen.getByTestId("command-panel")).toHaveAttribute(
      "data-command-panel",
      "build",
    );
    expect(screen.queryByTestId("panel-inspect")).toBeNull();
    await fireEvent.click(screen.getByTestId("command-destination-data"));
    expect(screen.getByTestId("command-panel")).toHaveAttribute(
      "data-command-panel",
      "data",
    );
    expect(screen.queryByTestId("command-panel-build")).toBeNull();
  });

  it("invokes contextual Inspect reassignment controls", async () => {
    let state = createTestGameState();
    state = withRoads(state, [{ x: 7, y: 7 }]);
    state = addTestBusStop(state, { x: 7, y: 7 }, "busTerminal");
    const stopId = state.transit.stops[0].id;
    state = addTestBusRoute(state, [stopId]);
    const { runtime } = createRuntimeHarness({
      state,
      ui: {
        ...createUiState(),
        selectedId: "7,7",
        selectedNodeKind: "stop",
      },
    });
    render(App, { props: { runtime } });

    const move = screen.getByRole("button", {
      name: "Move Bus 1 to Platform B",
    });
    await fireEvent.click(move);

    expect(runtime.assignRouteToPlatform).toHaveBeenCalledWith(
      stopId,
      "route-001",
      `${stopId}-p1`,
    );
  });

  it("keeps route-draft gate IDs unique and scopes shelf descriptions", () => {
    const { runtime } = createRuntimeHarness({
      ui: {
        ...createUiState(),
        activeTool: "busRoute",
        activeCommandDestination: "lines",
        routeDraft: createDraft("bus", 1),
      },
    });
    render(App, { props: { runtime } });

    const gates = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[data-testid^="route-draft-"][data-testid$="gate"]',
      ),
    );
    expect(gates.map((gate) => gate.id)).toEqual([
      "route-draft-panel-gate",
      "route-draft-shelf-gate",
    ]);
    for (const control of screen
      .getByTestId("command-shelf")
      .querySelectorAll("button")) {
      expect(control).toHaveAttribute(
        "aria-describedby",
        "route-draft-shelf-gate",
      );
    }
  });

  it("renders a fatal shell error without game chrome", async () => {
    const { runtime } = createRuntimeHarness();
    runtime.togglePause = vi.fn(async () => ({
      ...runtime.getSnapshot(),
      backendError: "Rust backend failed",
      rejection: null,
    }));
    render(App, { props: { runtime } });
    await fireEvent.click(screen.getByRole("button", { name: "Resume" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Rust backend failed",
    );
    expect(screen.queryByTestId("topbar")).toBeNull();
    expect(screen.queryByTestId("game-canvas-host")).toBeNull();
    expect(screen.queryByTestId("command-shelf")).toBeNull();
    expect(runtime.stop).toHaveBeenCalled();
  });

  it("renders Data's four overlays, empty hint, and metrics", async () => {
    const { runtime } = createRuntimeHarness();
    render(App, { props: { runtime } });
    await fireEvent.click(screen.getByTestId("command-destination-data"));
    expect(
      screen.getAllByRole("button", {
        name: /coverage|crowding|demand|lateness/i,
      }),
    ).toHaveLength(4);
    expect(
      screen.getByText("Choose an overlay to inspect the network."),
    ).toBeVisible();
    expect(screen.getAllByText("Late").at(-1)).toBeVisible();
    expect(screen.getAllByText("Unserved").at(-1)).toBeVisible();
    expect(screen.getAllByText("Avg Wait").at(-1)).toBeVisible();
  });

  it("passes the active city name to City and pins Lines for a draft", async () => {
    const { runtime } = createRuntimeHarness();
    render(App, { props: { runtime } });
    await fireEvent.click(screen.getByTestId("command-destination-city"));
    expect(screen.getByText("Harbour City")).toBeVisible();
    await fireEvent.click(screen.getByTestId("command-destination-lines"));
    await fireEvent.click(screen.getByRole("button", { name: "New Bus" }));
    expect(runtime.setTool).toHaveBeenCalledWith("busRoute");
    expect(screen.getByTestId("command-panel")).toHaveAttribute(
      "data-command-panel",
      "lines",
    );
  });

  it("routes B/R/T/X/V and road presets through guarded runtime methods", async () => {
    const { runtime } = createRuntimeHarness();
    render(App, { props: { runtime } });
    await fireEvent.keyDown(window, { key: "b" });
    expect(runtime.setCommandDestination).toHaveBeenCalledWith("build");
    await fireEvent.keyDown(window, { key: "r" });
    expect(runtime.setTool).toHaveBeenCalledWith("road");
    await fireEvent.keyDown(window, { key: "1" });
    expect(runtime.setRoadPreset).toHaveBeenCalledWith("twoWay");
    await fireEvent.keyDown(window, { key: "t" });
    expect(runtime.setTool).toHaveBeenCalledWith("track");
    await fireEvent.keyDown(window, { key: "x" });
    expect(runtime.setTool).toHaveBeenCalledWith("remove");
    await fireEvent.keyDown(window, { key: "v" });
    expect(runtime.setTool).toHaveBeenCalledWith("inspect");
  });

  it("calls runtime Escape once and disposes on unmount", async () => {
    const { runtime } = createRuntimeHarness();
    const view = render(App, { props: { runtime } });
    await fireEvent.keyDown(window, { key: "Escape" });
    expect(runtime.handleEscape).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(runtime.dispose).toHaveBeenCalledTimes(1);
  });
});
