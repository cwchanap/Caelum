import { fireEvent, render, screen } from "@testing-library/svelte";
import { flushSync, tick } from "svelte";
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
import type { GameplayRejection } from "../../src/domain/types";
import type {
  RuntimeController,
  RuntimeSnapshot,
} from "../../src/runtime/types";

function createRuntimeHarness(
  options: {
    state?: ReturnType<typeof createTestGameState>;
    ui?: ReturnType<typeof createUiState>;
    rejection?: GameplayRejection | null;
    persistence?: Partial<RuntimeSnapshot["persistence"]>;
  } = {},
): {
  runtime: RuntimeController;
  getSnapshot: () => RuntimeSnapshot;
  setPersistence: (
    next: Partial<RuntimeSnapshot["persistence"]>,
  ) => RuntimeSnapshot;
} {
  const state = options.state ?? createTestGameState();
  let ui = options.ui ?? createUiState();
  let rejection = options.rejection ?? null;
  const listeners = new Set<(snapshot: RuntimeSnapshot) => void>();
  let persistence: RuntimeSnapshot["persistence"] = {
    activeCity: {
      id: "city-1",
      name: "Harbour City",
      createdAt: "2026-01-01T00:00:00.000Z",
      savedAt: "2026-01-01T00:00:00.000Z",
    },
    busy: false,
    dirty: false,
    error: null,
    ...options.persistence,
  };
  const snapshot = (): RuntimeSnapshot => ({
    state,
    ui,
    shell: selectShellState(state, ui, rejection),
    persistence,
    backendError: null,
    rejection,
    sandboxResetError: null,
  });
  const publish = (): RuntimeSnapshot =>
    flushSync(() => {
      const next = snapshot();
      for (const listener of listeners) listener(next);
      return next;
    });
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
    handleEscape: vi.fn(() => {
      ui = {
        ...ui,
        activeCommandDestination:
          ui.routeDraft === null ? null : ui.activeCommandDestination,
      };
      return publish();
    }),
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
    dismissRejection: vi.fn(() => {
      rejection = null;
      return publish();
    }),
    tick: vi.fn(async () => publish()),
    reset: vi.fn(async () => publish()),
    resetUi: vi.fn(() => publish()),
    startDrag: vi.fn(() => publish()),
    setDragCurrent: vi.fn(() => publish()),
    commitDrag: vi.fn(async () => publish()),
    cancelDrag: vi.fn(() => publish()),
    handleTileClick: vi.fn(async () => publish()),
    mountCanvas: vi.fn(() => () => {}),
  } satisfies RuntimeController;
  return {
    runtime,
    getSnapshot: snapshot,
    setPersistence(next: Partial<RuntimeSnapshot["persistence"]>) {
      persistence = { ...persistence, ...next };
      return publish();
    },
  };
}

describe("App command shell", () => {
  it("shows New City instead of game chrome when no city is active", () => {
    const { runtime } = createRuntimeHarness({
      persistence: { activeCity: null },
    });

    render(App, { props: { runtime } });

    expect(screen.getByTestId("new-city-screen")).toBeVisible();
    expect(screen.queryByTestId("game-canvas-host")).toBeNull();
    expect(screen.queryByTestId("command-shelf")).toBeNull();
    expect(screen.queryByTestId("topbar")).toBeNull();
  });

  it("submits only trimmed name, economy, and template", async () => {
    const { runtime } = createRuntimeHarness({
      persistence: { activeCity: null },
    });
    render(App, { props: { runtime } });

    const create = screen.getByRole("button", { name: "Create City" });
    expect(create).toBeDisabled();

    await fireEvent.input(screen.getByLabelText("City name"), {
      target: { value: "  Maple Junction  " },
    });
    await fireEvent.change(screen.getByLabelText("Economy"), {
      target: { value: "creative" },
    });
    await fireEvent.change(screen.getByLabelText("Template"), {
      target: { value: "blankGrid" },
    });
    await fireEvent.click(create);

    expect(runtime.persistence.createCity).toHaveBeenCalledWith({
      name: "Maple Junction",
      economyPreset: "creative",
      templateId: "blankGrid",
    });
  });

  it("disables repeat New City submission while persistence is busy", async () => {
    const harness = createRuntimeHarness({
      persistence: { activeCity: null },
    });
    render(App, { props: { runtime: harness.runtime } });

    await fireEvent.input(screen.getByLabelText("City name"), {
      target: { value: "Busy City" },
    });
    harness.setPersistence({ busy: true });

    expect(screen.getByRole("button", { name: "Creating…" })).toBeDisabled();
  });

  it("shows runtime-mapped persistence copy without diagnostics", () => {
    const harness = createRuntimeHarness({
      persistence: { activeCity: null },
    });
    render(App, { props: { runtime: harness.runtime } });

    harness.setPersistence({
      error: {
        kind: "store",
        error: {
          operation: "createCity",
          code: "failed",
          diagnostic: "QuotaExceededError: private browser detail",
        },
      },
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Could not save the new city.",
    );
    expect(screen.getByRole("alert")).not.toHaveTextContent(
      "QuotaExceededError",
    );
  });

  it("returns to the normal game shell after a city becomes active", () => {
    const harness = createRuntimeHarness({
      persistence: { activeCity: null },
    });
    render(App, { props: { runtime: harness.runtime } });

    harness.setPersistence({
      activeCity: {
        id: "city-new",
        name: "Maple Junction",
        createdAt: "2026-08-10T17:00:00.000Z",
        savedAt: "2026-08-10T17:00:00.000Z",
      },
      busy: false,
      dirty: false,
      error: null,
    });

    expect(screen.queryByTestId("new-city-screen")).toBeNull();
    expect(screen.getByTestId("game-canvas-host")).toBeVisible();
    expect(screen.getByTestId("command-shelf")).toBeVisible();
  });

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

  it("returns focus to the canvas after selecting a Build leaf", async () => {
    const { runtime } = createRuntimeHarness();
    render(App, { props: { runtime } });

    await fireEvent.click(screen.getByTestId("command-destination-build"));
    await fireEvent.click(screen.getByTestId("command-plate-roads"));
    await fireEvent.click(screen.getByRole("button", { name: "2-Lane" }));
    await tick();

    expect(screen.getByTestId("game-canvas-host")).toHaveFocus();
  });

  it("returns focus to the Data shelf button after Escape closes Data", async () => {
    const { runtime } = createRuntimeHarness();
    render(App, { props: { runtime } });

    const dataButton = screen.getByTestId("command-destination-data");
    await fireEvent.click(dataButton);
    await fireEvent.keyDown(window, { key: "Escape" });
    await tick();

    expect(dataButton).toHaveFocus();
  });

  it("returns focus to the City shelf button after closing City", async () => {
    const { runtime } = createRuntimeHarness();
    render(App, { props: { runtime } });

    const cityButton = screen.getByTestId("command-destination-city");
    await fireEvent.click(cityButton);
    await fireEvent.click(screen.getByRole("button", { name: "Close City" }));
    await tick();

    expect(cityButton).toHaveFocus();
  });

  it("returns focus to the Lines list when a route draft is cancelled", async () => {
    const { runtime } = createRuntimeHarness();
    render(App, { props: { runtime } });

    await fireEvent.click(screen.getByTestId("command-destination-lines"));
    await fireEvent.click(screen.getByRole("button", { name: "New Bus" }));
    await fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await tick();

    expect(screen.getByTestId("lines-list")).toHaveFocus();
    expect(screen.getByTestId("command-destination-lines")).not.toHaveFocus();
  });

  it("renders the compact Signal Console topbar contract", () => {
    const baseState = createTestGameState();
    const state = {
      ...baseState,
      paused: false,
      metrics: { ...baseState.metrics, lateTrips: 4, unservedTrips: 2 },
    };
    const { runtime } = createRuntimeHarness({ state });
    render(App, { props: { runtime } });

    expect(screen.getByText("Money")).toBeVisible();
    expect(screen.getByText("Time")).toBeVisible();
    expect(screen.getByText("Network")).toBeVisible();
    expect(screen.getByText("Population")).toBeVisible();
    expect(screen.getByText("Avg Wait")).toBeVisible();
    expect(screen.getByText("4 late · 2 unserved")).toBeVisible();
    expect(screen.getByRole("button", { name: "Pause" })).toBeVisible();
    expect(screen.getByRole("button", { name: "1x" })).toBeVisible();
    expect(screen.getByRole("button", { name: "2x" })).toBeVisible();
    expect(screen.getByRole("button", { name: "4x" })).toBeVisible();
    expect(screen.queryByText("Live")).toBeNull();
    expect(screen.queryByText("Hold")).toBeNull();
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

  it("renders selector-owned gameplay feedback and dismisses it", async () => {
    const { runtime } = createRuntimeHarness({
      rejection: {
        code: "insufficientBudget",
        context: { requiredBudget: 1_200, availableBudget: 0 },
      },
    });
    render(App, { props: { runtime } });

    const feedback = screen.getByTestId("action-feedback");
    expect(feedback).toHaveAttribute("data-source", "rejection");
    expect(feedback).toHaveAttribute("data-tone", "error");
    expect(screen.getByTestId("action-feedback-announce")).toHaveAttribute(
      "role",
      "status",
    );
    expect(feedback).toHaveTextContent("Needs $1,200; only $0 is available.");

    await fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(runtime.dismissRejection).toHaveBeenCalledTimes(1);
  });
});
