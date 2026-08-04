import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import App from "../../src/App.svelte";
import type {
  AreaKind,
  BuildingType,
  GameState,
  GameplayRejection,
  Overlay,
  Point,
  RoadPreset,
  RoundaboutSize,
  Tool,
} from "../../src/domain/types";
import {
  createTestGameState,
  addTestBusStop,
  addTestBusRoute,
} from "../helpers/gameState";
import { applyUiTileClick } from "../../src/ui/actions";
import { selectShellState } from "../../src/runtime/runtimeSelectors";
import type {
  RuntimeController,
  RuntimeListener,
  RuntimeCommandResult,
  RuntimeSnapshot,
} from "../../src/runtime/types";
import { createUiState, type UiState } from "../../src/ui/uiState";
import { createDraft } from "../../src/ui/routeDraft";
import { ROUTE_COLOR_PALETTE } from "../../src/ui/routePalette";
import {
  runtimeUnavailable,
  type RuntimePersistenceController,
  type RuntimePersistenceView,
} from "../../src/runtime/persistenceCoordinator";

const persistenceView: RuntimePersistenceView = {
  activeCity: null,
  dirty: false,
  saveStatus: { state: "idle" },
  loadStatus: { state: "idle" },
  lifecycleStatus: { state: "idle" },
  lastSavedAt: null,
  error: null,
};

const persistenceController: RuntimePersistenceController = {
  saveWorking: async () => runtimeUnavailable("saveWorking"),
  renameActiveCity: async () => runtimeUnavailable("renameActiveCity"),
  load: async (source) =>
    runtimeUnavailable(
      source.kind === "working"
        ? "loadWorking"
        : source.kind === "checkpoint"
          ? "loadCheckpoint"
          : "loadAutosave",
    ),
  detachActiveCity: async () => runtimeUnavailable("detachActiveCity"),
  activateNewCity: async () => runtimeUnavailable("activateNewCity"),
  runGameplayWrite: async (request) =>
    runtimeUnavailable(
      request.kind === "checkpoint" ? "createCheckpoint" : "createAutosave",
    ),
};

async function openCategory(name: string): Promise<void> {
  await fireEvent.click(screen.getByTestId(`hud-cat-${name}`));
}

function busDraft(waypointIds: string[], ready = false) {
  const generation = waypointIds.length;
  return {
    ...createDraft("bus", 1),
    waypointIds,
    generation,
    previewPending: false,
    preview: ready
      ? {
          generation,
          legs: waypointIds.map((id, index) => ({
            fromWaypointId: id,
            toWaypointId: waypointIds[(index + 1) % waypointIds.length],
            direction: "loop" as const,
            kind: "service" as const,
            status: "connected" as const,
            currentPath: null,
            lastValidPath: null,
            estimatedSeconds: 1,
            failureReason: null,
          })),
          totalTravelSeconds: waypointIds.length,
          initialVehicleCost: 8_000,
          affordable: true,
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
        }
      : null,
  };
}

function createRuntimeHarness(
  options: {
    state?: GameState;
    ui?: UiState;
    backendError?: string | null;
    rejection?: GameplayRejection | null;
  } = {},
): { runtime: RuntimeController } {
  let state = options.state ?? createTestGameState();
  let ui = options.ui ?? createUiState();
  const backendError = options.backendError ?? null;
  let rejection = options.rejection ?? null;
  const listeners = new Set<RuntimeListener>();

  const getSnapshot = (): RuntimeSnapshot => ({
    state,
    ui,
    shell: selectShellState(state, ui, rejection),
    persistence: persistenceView,
    backendError,
    rejection,
    sandboxResetError: null,
    recovery: { state: "ok" as const },
  });

  const publish = (): RuntimeSnapshot => {
    const snapshot = getSnapshot();
    listeners.forEach((listener) => listener(snapshot));
    return snapshot;
  };

  const resetUi = vi.fn(() => {
    ui = createUiState();
    return publish();
  });
  const rotations = [0, 90, 180, 270] as const;

  const runtime: RuntimeController & { resetUi: typeof resetUi } = {
    persistence: persistenceController,
    getSnapshot,
    subscribe: vi.fn((listener: RuntimeListener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    start: vi.fn(),
    stop: vi.fn(),
    dispose: vi.fn(() => Promise.resolve({ status: "released" } as const)),
    isRunning: vi.fn(() => false),
    tick: vi.fn((_deltaSeconds: number) => publish()),
    reset: vi.fn(() => {
      state = createTestGameState();
      ui = createUiState();
      return publish();
    }),
    setTool: vi.fn((tool: Tool) => {
      ui = {
        ...ui,
        activeTool: tool,
        selectedNodeKind: null,
        selectedBuilding: null,
        selectedArea: null,
        buildCategory: null,
        buildingRotation: 0,
        routeDraft:
          tool === "busRoute"
            ? createDraft("bus", 1)
            : tool === "metroLine"
              ? createDraft("metro", 1)
              : null,
        routePreviewError: null,
        selectedRouteId: null,
        drag: null,
        activeHudCategory: null,
      };
      return publish();
    }),
    setBuilding: vi.fn((building: BuildingType) => {
      ui = {
        ...ui,
        activeTool: "inspect",
        selectedId: null,
        selectedNodeKind: null,
        selectedBuilding: building,
        selectedArea: null,
        buildCategory: null,
        buildingRotation: 0,
        routeDraft: null,
        routePreviewError: null,
        selectedRouteId: null,
        drag: null,
        activeHudCategory: null,
      };
      return publish();
    }),
    setArea: vi.fn((area: AreaKind) => {
      ui = {
        ...ui,
        activeTool: "area",
        selectedId: null,
        selectedNodeKind: null,
        selectedBuilding: null,
        selectedArea: area,
        buildCategory: null,
        buildingRotation: 0,
        routeDraft: null,
        routePreviewError: null,
        selectedRouteId: null,
        drag: null,
        activeHudCategory: null,
      };
      return publish();
    }),
    setRoadPreset: vi.fn((preset: RoadPreset) => {
      ui = { ...ui, roadPreset: preset };
      return publish();
    }),
    setBuildCategory: vi.fn((category) => {
      ui = { ...ui, buildCategory: category };
      return publish();
    }),
    armRoad: vi.fn((preset: RoadPreset) => {
      ui = {
        ...ui,
        activeTool: "road",
        selectedBuilding: null,
        selectedArea: null,
        buildCategory: null,
        buildingRotation: 0,
        roadPreset: preset,
        activeHudCategory: null,
      };
      return publish();
    }),
    armRoundabout: vi.fn((size: RoundaboutSize) => {
      ui = {
        ...ui,
        activeTool: "roundabout",
        selectedBuilding: null,
        selectedArea: null,
        buildCategory: null,
        buildingRotation: 0,
        roundaboutSize: size,
        drag: null,
        activeHudCategory: null,
      };
      return publish();
    }),
    startDrag: vi.fn((point: Point) => {
      const tool = ui.activeTool;
      if (tool === "road" || tool === "track" || tool === "remove") {
        ui = { ...ui, drag: { tool, start: point, current: point } };
      }
      return publish();
    }),
    setDragCurrent: vi.fn((point: Point | null) => {
      if (point !== null && ui.drag !== null) {
        ui = { ...ui, drag: { ...ui.drag, current: point } };
      }
      return publish();
    }),
    commitDrag: vi.fn(() => {
      ui = { ...ui, drag: null };
      return publish();
    }),
    cancelDrag: vi.fn(() => {
      ui = { ...ui, drag: null };
      return publish();
    }),
    rotateBuilding: vi.fn(() => {
      const currentIndex = rotations.indexOf(ui.buildingRotation);
      ui = {
        ...ui,
        buildingRotation: rotations[(currentIndex + 1) % rotations.length],
      };
      return publish();
    }),
    setOverlay: vi.fn((overlay: Overlay | null) => {
      ui =
        overlay === ui.activeOverlay ? ui : { ...ui, activeOverlay: overlay };
      return publish();
    }),
    togglePause: vi.fn(() => {
      state = { ...state, paused: !state.paused };
      return publish();
    }),
    setSpeed: vi.fn((speed: GameState["speed"]) => {
      state = { ...state, speed };
      return publish();
    }),
    setHudCategory: vi.fn((category) => {
      ui = { ...ui, activeHudCategory: category };
      return publish();
    }),
    resetUi,
    handleTileClick: vi.fn((point: Point) => {
      const result = applyUiTileClick(state, ui, point);
      state = result.state;
      ui = result.ui;
      return publish();
    }),
    assignRouteToPlatform: vi.fn(
      (_nodeId: string, _routeId: string, _platformId: string) => publish(),
    ),
    startRouteEdit: vi.fn((_routeId: string) => publish()),
    selectRouteWaypoint: vi.fn((index, interaction) => {
      if (ui.routeDraft !== null) {
        ui = {
          ...ui,
          routeDraft: { ...ui.routeDraft, selectedIndex: index, interaction },
        };
      }
      return publish();
    }),
    removeRouteWaypoint: vi.fn(() => {
      if (ui.routeDraft?.selectedIndex !== null && ui.routeDraft !== null) {
        const selectedIndex = ui.routeDraft.selectedIndex;
        const waypointIds = ui.routeDraft.waypointIds.filter(
          (_, index) => index !== selectedIndex,
        );
        ui = {
          ...ui,
          routeDraft: {
            ...ui.routeDraft,
            waypointIds,
            selectedIndex: null,
          },
        };
      }
      return publish();
    }),
    moveRouteWaypoint: vi.fn((_delta) => publish()),
    reverseRouteDraft: vi.fn(() => publish()),
    setRoutePattern: vi.fn((_pattern) => publish()),
    undoRouteDraft: vi.fn(() => publish()),
    redoRouteDraft: vi.fn(() => publish()),
    saveRouteDraft: vi.fn(async () => publish()),
    cancelRouteDraft: vi.fn(() => publish()),
    reloadRouteDraft: vi.fn(() => publish()),
    handleEscape: vi.fn(() => {
      ui =
        ui.routeDraft === null
          ? createUiState()
          : { ...ui, routeDraft: null, routePreviewError: null };
      return publish();
    }),
    renameRoute: vi.fn((_routeId: string, _name: string) => publish()),
    recolorRoute: vi.fn((_routeId: string, _color: string) => publish()),
    toggleRouteActive: vi.fn((_routeId: string) => publish()),
    deleteRoute: vi.fn((_routeId: string) => publish()),
    selectRoute: vi.fn((_routeId: string | null) => publish()),
    focusRouteFailure: vi.fn((_routeId: string, _legIndex: number) =>
      publish(),
    ),
    setHoverTile: vi.fn((point: Point | null) => {
      ui = { ...ui, hoverTile: point };
      return publish();
    }),
    previewRoadMutation: vi.fn((_mutation) => publish()),
    dismissRejection: vi.fn(() => {
      rejection = null;
      return publish();
    }),
    debugSetBudget: vi.fn(() => publish()),
    debugEnqueueCityPersistence: vi.fn(
      <T>(_cityId: string, work: () => Promise<T>): Promise<T> => work(),
    ) as unknown as <T>(cityId: string, work: () => Promise<T>) => Promise<T>,
    mountCanvas: vi.fn(() => () => {}),
  };

  return { runtime };
}

function deferredRuntimeResult(): {
  promise: Promise<RuntimeSnapshot>;
  resolve: (snapshot: RuntimeSnapshot) => void;
} {
  let resolve!: (snapshot: RuntimeSnapshot) => void;
  const promise = new Promise<RuntimeSnapshot>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("App shell bootstrap", () => {
  it("renders runtime-driven topbar, canvas host, and bottom HUD", async () => {
    const baseState = createTestGameState();
    const { runtime } = createRuntimeHarness({
      state: {
        ...baseState,
        budget: 123_456,
        time: 125,
        clockMinutes: 125,
        paused: false,
        speed: 2,
        metrics: {
          ...baseState.metrics,
          lateTrips: 3,
          unservedTrips: 1,
          averageWaitSeconds: 19,
          state: "running",
        },
      },
      ui: {
        ...createUiState(),
        activeTool: "busRoute",
        activeOverlay: "growth",
        selectedId: "route-001",
      },
    });

    render(App, { props: { runtime } });

    expect(screen.getByTestId("game-shell")).toHaveAttribute(
      "data-hud-category",
      "brief",
    );
    expect(screen.getByTestId("game-canvas-host")).toBeVisible();
    expect(screen.getByText("CAELUM")).toBeVisible();
    expect(screen.getByText("Transit Ops")).toBeVisible();
    expect(screen.getByText("$123,456")).toBeVisible();
    expect(screen.getByText("Day 1 02:05")).toBeVisible();
    expect(screen.getByText("Standard Sandbox")).toBeVisible();
    expect(screen.getByText("Template · Crossroads")).toBeVisible();
    expect(
      screen.getByText("Open-ended city — no campaign objective."),
    ).toBeVisible();
    expect(
      screen.getByText("Metrics continue without win/loss."),
    ).toBeVisible();
    expect(screen.getByText("No automatic growth")).toBeVisible();
    expect(screen.getByTestId("hud-tool-chip")).toHaveTextContent("BUSROUTE");
    expect(screen.getByText("route-001")).toBeVisible();
    expect(screen.getByText("Live")).toBeVisible();

    const drawer = screen.getByTestId("hud-drawer");
    await openCategory("routes");
    expect(
      within(drawer).getByRole("button", { name: "Bus Route" }),
    ).toHaveAttribute("data-tool", "busRoute");
    expect(
      within(drawer).getByRole("button", { name: "Bus Route" }),
    ).toHaveAttribute("aria-pressed", "true");
    await openCategory("data");
    expect(
      within(drawer).getByRole("button", { name: "Growth" }),
    ).toHaveAttribute("data-overlay", "growth");
    expect(
      within(drawer).getByRole("button", { name: "Growth" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("wires topbar controls into the runtime and reflects subscription updates", async () => {
    const { runtime } = createRuntimeHarness();
    render(App, { props: { runtime } });

    await fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(runtime.togglePause).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Live")).toBeVisible();
    expect(screen.getByRole("button", { name: "Pause" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    await fireEvent.click(screen.getByRole("button", { name: "4x" }));
    expect(runtime.setSpeed).toHaveBeenCalledWith(4);
    expect(screen.getByRole("button", { name: "4x" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("applies promise-based runtime command results when they resolve", async () => {
    const { runtime } = createRuntimeHarness();
    const deferred = deferredRuntimeResult();
    runtime.setSpeed = vi.fn(
      (_speed: GameState["speed"]): RuntimeCommandResult => deferred.promise,
    );

    render(App, { props: { runtime } });

    await fireEvent.click(screen.getByRole("button", { name: "4x" }));
    expect(runtime.setSpeed).toHaveBeenCalledWith(4);
    expect(screen.getByRole("button", { name: "4x" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    const nextState: GameState = { ...createTestGameState(), speed: 4 };
    const nextUi = createUiState();
    deferred.resolve({
      state: nextState,
      ui: nextUi,
      shell: selectShellState(nextState, nextUi),
      persistence: persistenceView,
      backendError: null,
      rejection: null,
      sandboxResetError: null,
      recovery: { state: "ok" },
    });

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "4x" })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
  });

  it("keeps the selected speed visually active while paused", () => {
    const { runtime } = createRuntimeHarness({
      state: { ...createTestGameState(), paused: true, speed: 2 },
    });

    render(App, { props: { runtime } });

    const selectedSpeed = screen.getByRole("button", { name: "2x" });
    expect(selectedSpeed).toHaveAttribute("aria-pressed", "true");
    expect(selectedSpeed).toHaveClass("active");
  });

  it("wires the Build drill-down and persists the building selection", async () => {
    const { runtime } = createRuntimeHarness();
    render(App, { props: { runtime } });

    await openCategory("build");
    expect(
      screen.getByRole("button", {
        name: /Rotate building, current rotation 0 degrees/i,
      }),
    ).toBeDisabled();

    await fireEvent.click(screen.getByRole("button", { name: "Residential" }));
    await fireEvent.click(screen.getByRole("button", { name: "Large House" }));
    expect(runtime.setBuilding).toHaveBeenCalledWith("largeHouse");

    // Selecting a building closes the drawer and resets buildCategory; reopen and
    // re-drill to assert the selection persisted in the panel.
    await openCategory("build");
    await fireEvent.click(screen.getByRole("button", { name: "Residential" }));
    const largeHouse = screen.getByRole("button", { name: "Large House" });
    expect(largeHouse).toHaveAttribute("data-building", "largeHouse");
    expect(largeHouse).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByRole("button", {
        name: /Rotate building, current rotation 0 degrees/i,
      }),
    ).toBeEnabled();
  });

  it("arms bus stops as a road-node tool from the Build drill-down", async () => {
    const { runtime } = createRuntimeHarness();
    render(App, { props: { runtime } });

    await openCategory("build");
    await fireEvent.click(screen.getByRole("button", { name: "Bus" }));
    await fireEvent.click(screen.getByRole("button", { name: "Bus Stop" }));

    expect(runtime.setTool).toHaveBeenCalledWith("busStop");
    expect(runtime.setBuilding).not.toHaveBeenCalledWith("busStop");
  });

  it("wires area selection into the runtime", async () => {
    const { runtime } = createRuntimeHarness();
    render(App, { props: { runtime } });

    await openCategory("area");
    await fireEvent.click(screen.getByRole("button", { name: "Commercial" }));

    expect(runtime.setArea).toHaveBeenCalledWith("commercial");
    expect(screen.getByText("AREA COMMERCIAL")).toBeVisible();
  });

  it("selects the remove tool from the persistent HUD cluster", async () => {
    const { runtime } = createRuntimeHarness();
    render(App, { props: { runtime } });
    await fireEvent.click(screen.getByTestId("hud-tool-remove"));
    expect(runtime.setTool).toHaveBeenCalledWith("remove");
  });

  it("arms the road tool with a preset from Build → Road → 2-Lane", async () => {
    const { runtime } = createRuntimeHarness();
    render(App, { props: { runtime } });
    await openCategory("build");
    await fireEvent.click(screen.getByRole("button", { name: "Road" }));
    await fireEvent.click(screen.getByRole("button", { name: "2-Lane" }));
    expect(runtime.armRoad).toHaveBeenCalledWith("dualBidirectional");
  });

  it("arms the standard click tool from Build → Road", async () => {
    const { runtime } = createRuntimeHarness();
    render(App, { props: { runtime } });
    await openCategory("build");
    await fireEvent.click(screen.getByRole("button", { name: "Road" }));
    await fireEvent.click(
      screen.getByRole("button", { name: "Standard Roundabout" }),
    );
    expect(runtime.armRoundabout).toHaveBeenCalledWith("standard3x3");
  });

  it("paints a zone from the Area category", async () => {
    const { runtime } = createRuntimeHarness();
    render(App, { props: { runtime } });
    await openCategory("area");
    await fireEvent.click(screen.getByRole("button", { name: "Industrial" }));
    expect(runtime.setArea).toHaveBeenCalledWith("industrial");
  });

  it("wires tool, overlay, and close interactions with exact runtime ids", async () => {
    const { runtime } = createRuntimeHarness();
    render(App, { props: { runtime } });

    await openCategory("routes");
    await fireEvent.click(screen.getByRole("button", { name: "Metro Line" }));
    expect(runtime.setTool).toHaveBeenCalledWith("metroLine");
    expect(screen.getByText("METROLINE")).toBeVisible();
    // Selecting a tool resets activeHudCategory to null (matching production's
    // nextToolUiState), closing the drawer. Re-open Routes to assert the tool
    // selection persisted in the panel.
    await openCategory("routes");
    expect(screen.getByRole("button", { name: "Metro Line" })).toHaveAttribute(
      "data-tool",
      "metroLine",
    );
    expect(screen.getByRole("button", { name: "Metro Line" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await openCategory("data");
    await fireEvent.click(screen.getByRole("button", { name: "Coverage" }));
    expect(runtime.setOverlay).toHaveBeenCalledWith("coverage");
    expect(screen.getByRole("button", { name: "Coverage" })).toHaveAttribute(
      "data-overlay",
      "coverage",
    );
    expect(screen.getByRole("button", { name: "Coverage" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await fireEvent.click(screen.getByRole("button", { name: "Coverage" }));
    expect(runtime.setOverlay).toHaveBeenLastCalledWith(null);
    expect(screen.getByRole("button", { name: "Coverage" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    await fireEvent.click(screen.getByRole("button", { name: "Close drawer" }));
    expect(runtime.setHudCategory).toHaveBeenLastCalledWith(null);
    expect(screen.getByTestId("hud-drawer")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });

  it("collapses the drawer when the already-active category button is clicked", async () => {
    const { runtime } = createRuntimeHarness();
    render(App, { props: { runtime } });

    // Brief is the default-open drawer.
    const drawer = screen.getByTestId("hud-drawer");
    expect(drawer).toHaveAttribute("data-hud-category", "brief");
    expect(drawer).toHaveAttribute("aria-hidden", "false");

    await openCategory("brief");

    expect(runtime.setHudCategory).toHaveBeenLastCalledWith(null);
    expect(drawer).toHaveAttribute("data-hud-category", "none");
    expect(drawer).toHaveAttribute("aria-hidden", "true");
  });

  it("cancels only the active route draft when Escape is pressed", async () => {
    const { runtime } = createRuntimeHarness({
      ui: {
        ...createUiState(),
        activeTool: "busRoute",
        activeOverlay: "growth",
        selectedId: "route-001",
        routeDraft: busDraft(["stop-001"]),
        activeHudCategory: "routes",
      },
    });

    render(App, { props: { runtime } });

    await fireEvent.keyDown(window, { key: "Escape" });

    expect(runtime.handleEscape).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("game-shell")).toHaveAttribute(
      "data-hud-category",
      "routes",
    );
    expect(screen.getByTestId("hud-tool-chip")).toHaveTextContent("BUSROUTE");
    expect(screen.queryByTestId("route-draft")).toBeNull();
  });

  it("gives Cancel · Esc the same draft-only semantics as keyboard Escape", async () => {
    const { runtime } = createRuntimeHarness({
      ui: {
        ...createUiState(),
        activeTool: "busRoute",
        activeOverlay: "growth",
        selectedId: "route-001",
        routeDraft: busDraft(["stop-001"]),
        activeHudCategory: "routes",
      },
    });

    render(App, { props: { runtime } });
    await fireEvent.click(screen.getByTestId("hud-cancel"));

    expect(runtime.handleEscape).toHaveBeenCalledTimes(1);
    expect(runtime.resetUi).not.toHaveBeenCalled();
    expect(runtime.getSnapshot().ui).toMatchObject({
      activeTool: "busRoute",
      activeOverlay: "growth",
      selectedId: "route-001",
      activeHudCategory: "routes",
      routeDraft: null,
    });
  });

  it("does not reset on Escape when Cancel is disabled (bare inspect)", async () => {
    // canCancel is false when activeTool === "inspect" with no draft and no
    // selected building. Escape shares the Cancel button's label, so it must
    // share its disabled state too — otherwise Escape silently jumps the
    // drawer to "Brief" while the button looks dead.
    const { runtime } = createRuntimeHarness({
      ui: {
        ...createUiState(),
        activeTool: "inspect",
        activeHudCategory: "manage",
      },
    });

    render(App, { props: { runtime } });

    expect(screen.getByTestId("hud-cancel")).toBeDisabled();

    await fireEvent.keyDown(window, { key: "Escape" });

    expect(runtime.handleEscape).not.toHaveBeenCalled();
    expect(screen.getByTestId("game-shell")).toHaveAttribute(
      "data-hud-category",
      "manage",
    );
  });

  it("resets on Escape when an overlay is active on the inspect tool", async () => {
    // An overlay-only state (inspect tool, no draft/building) still has
    // something to clear, so Cancel is enabled and Escape must fire resetUi —
    // otherwise the overlay badge shows but the player can't dismiss it via
    // the keyboard shortcut the Cancel button advertises.
    const { runtime } = createRuntimeHarness({
      ui: {
        ...createUiState(),
        activeTool: "inspect",
        activeOverlay: "coverage",
      },
    });

    render(App, { props: { runtime } });

    expect(screen.getByTestId("hud-cancel")).toBeEnabled();
    expect(screen.getByTestId("hud-badge-overlay")).toBeVisible();

    await fireEvent.keyDown(window, { key: "Escape" });

    expect(runtime.handleEscape).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("hud-badge-overlay")).toBeNull();
  });

  it("abandons an in-flight drag on Escape without resetting the tool", async () => {
    // Spec §C/§G: Escape first abandons an active drag — clearing the preview
    // line but keeping the active tool and drawer — so the player can resume
    // building. Only a second Escape (no drag in flight) does the full resetUi.
    const { runtime } = createRuntimeHarness({
      ui: {
        ...createUiState(),
        activeTool: "road",
        activeHudCategory: "build",
        roadPreset: "oneWay",
        drag: { tool: "road", start: { x: 2, y: 3 }, current: { x: 5, y: 3 } },
      },
    });

    render(App, { props: { runtime } });

    await fireEvent.keyDown(window, { key: "Escape" });

    expect(runtime.cancelDrag).toHaveBeenCalledTimes(1);
    expect(runtime.handleEscape).not.toHaveBeenCalled();
    // Tool + preset survive; only the drag is dropped.
    expect(screen.getByTestId("hud-tool-chip")).toHaveTextContent("ROAD");
    expect(screen.getByTestId("game-shell")).toHaveAttribute(
      "data-hud-category",
      "build",
    );

    // A second Escape now performs the full reset.
    await fireEvent.keyDown(window, { key: "Escape" });

    expect(runtime.handleEscape).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("hud-tool-chip")).toHaveTextContent("INSPECT");
    expect(screen.getByTestId("game-shell")).toHaveAttribute(
      "data-hud-category",
      "brief",
    );
  });

  it("renders a shell error when the canvas host fails to attach", () => {
    const { runtime } = createRuntimeHarness();
    runtime.mountCanvas = vi.fn(() => {
      throw new Error("Canvas 2D context unavailable");
    });

    render(App, { props: { runtime } });

    const alert = screen.getByRole("alert");
    expect(alert).toBeVisible();
    expect(alert).toHaveTextContent("Canvas 2D context unavailable");
    expect(screen.queryByTestId("topbar")).toBeNull();
    expect(screen.queryByTestId("game-canvas-host")).toBeNull();
    expect(screen.queryByTestId("bottom-hud")).toBeNull();
  });

  it("renders error state when bootstrap fails", () => {
    render(App, {
      props: {
        runtime: null,
        error: "Bootstrap failed",
      },
    });

    const alert = screen.getByRole("alert");
    expect(alert).toBeVisible();
    expect(alert).toHaveTextContent("Bootstrap failed");

    expect(screen.getByTestId("game-shell")).toBeVisible();
    expect(screen.queryByTestId("topbar")).toBeNull();
    expect(screen.queryByTestId("game-canvas-host")).toBeNull();
    expect(screen.queryByTestId("bottom-hud")).toBeNull();
  });

  it("explains that bootstrap recovery needs storage repair before retrying", () => {
    render(App, {
      props: {
        runtime: null,
        error: {
          reason: "bootstrapReconciliationFailed",
          cityId: "city-pending",
        },
      },
    });

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(
      "Close other realms and use owner-authorized or manual storage repair",
    );
    expect(alert).toHaveTextContent("Reload alone only retries reconciliation");
  });

  it("surfaces backendError from resolved runtime commands", async () => {
    const { runtime } = createRuntimeHarness();
    const deferred = deferredRuntimeResult();
    runtime.togglePause = vi.fn((): RuntimeCommandResult => deferred.promise);

    render(App, { props: { runtime } });
    await fireEvent.click(screen.getByRole("button", { name: "Resume" }));

    const current = runtime.getSnapshot();
    deferred.resolve({
      ...current,
      backendError: "Rust backend failed",
      rejection: null,
    });

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Rust backend failed");
    expect(runtime.stop).toHaveBeenCalled();
  });

  it("surfaces persistence recovery state from resolved runtime commands", async () => {
    const { runtime } = createRuntimeHarness();
    const deferred = deferredRuntimeResult();
    runtime.togglePause = vi.fn((): RuntimeCommandResult => deferred.promise);

    render(App, { props: { runtime } });
    await fireEvent.click(screen.getByRole("button", { name: "Resume" }));

    const current = runtime.getSnapshot();
    deferred.resolve({
      ...current,
      rejection: null,
      recovery: {
        state: "recoveryRequired",
        reason: "lateSuccessCleanupFailed",
        cityId: "city-orphan",
      },
    });

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Persistence recovery required");
    expect(alert).toHaveTextContent("lateSuccessCleanupFailed");
    expect(alert).toHaveTextContent("city-orphan");
    expect(alert).toHaveTextContent(
      "Reload alone may repeat the cleanup failure",
    );
    expect(runtime.stop).toHaveBeenCalled();
  });

  it("surfaces a synchronous throw from a runtime command as a shell error", async () => {
    // The command invocation must happen inside `applyRuntimeResult`'s
    // try/catch (via a thunk), not at the call site — otherwise a guard that
    // throws before returning a promise escapes unhandled and the shell keeps
    // rendering as if nothing went wrong.
    const { runtime } = createRuntimeHarness();
    runtime.togglePause = vi.fn((): RuntimeCommandResult => {
      throw new Error("Synchronous guard failure");
    });

    render(App, { props: { runtime } });
    await fireEvent.click(screen.getByRole("button", { name: "Resume" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Synchronous guard failure");
  });

  it("surfaces gameplay rejection as a dismissible banner without stopping the runtime", async () => {
    const insufficientBudget: GameplayRejection = {
      code: "insufficientBudget",
      context: {
        requiredBudget: 8_000,
        availableBudget: 7_999,
        affectedRouteIds: [],
      },
    };
    const { runtime } = createRuntimeHarness({
      rejection: insufficientBudget,
    });

    render(App, { props: { runtime } });

    const banner = await screen.findByTestId("rejection-banner");
    expect(banner).toHaveTextContent("Needs $8,000; only $7,999 is available.");
    expect(banner).toHaveAttribute("role", "status");
    // A rejection must not stop the runtime (unlike a fatal backendError).
    expect(runtime.stop).not.toHaveBeenCalled();
    // The shell should still render the game, not the fatal error overlay.
    expect(screen.queryByRole("alert")).toBeNull();

    await fireEvent.click(screen.getByLabelText("Dismiss"));
    expect(runtime.dismissRejection).toHaveBeenCalled();
  });

  it("presents roundabout cost and route impacts in an accessible status notice", () => {
    let state = createTestGameState();
    state = addTestBusStop(state, { x: 7, y: 8 });
    state = addTestBusStop(state, { x: 15, y: 8 });
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
      activeTool: "roundabout" as const,
      roadPreviewGeneration: 1,
      roadMutationPreview: {
        generation: 1,
        changedTiles: [
          { x: 8, y: 8 },
          { x: 9, y: 8 },
          { x: 8, y: 9 },
          { x: 9, y: 9 },
        ],
        authoredTiles: [],
        generatedStructures: [
          {
            kind: "roundabout" as const,
            id: "roundabout-001",
            origin: { x: 8, y: 8 },
            size: "compact2x2" as const,
            footprint: [
              { x: 8, y: 8 },
              { x: 9, y: 8 },
              { x: 8, y: 9 },
              { x: 9, y: 9 },
            ],
            ports: [],
          },
        ],
        cost: 2_000,
        skippedTiles: [],
        routeImpacts: [{ routeId: "route-001", kind: "broken" as const }],
        warnings: [],
        rejection: null,
      },
    };
    const { runtime } = createRuntimeHarness({ state, ui });

    render(App, { props: { runtime } });

    expect(screen.getByTestId("road-mutation-notice")).toHaveAttribute(
      "role",
      "status",
    );
    expect(screen.getByTestId("road-mutation-notice")).toHaveTextContent(
      "Route 1 will become broken",
    );
    expect(screen.getByTestId("road-mutation-notice")).toHaveTextContent(
      "$2,000",
    );
  });

  it("surfaces a road preview gameplay rejection in the notice", () => {
    const ui = {
      ...createUiState(),
      activeTool: "roundabout" as const,
      roadPreviewGeneration: 1,
      roadMutationPreview: {
        generation: 1,
        changedTiles: [],
        authoredTiles: [],
        generatedStructures: [],
        cost: 0,
        skippedTiles: [],
        routeImpacts: [],
        warnings: [],
        rejection: {
          code: "insufficientBudget" as const,
          context: {
            requiredBudget: 8_000,
            availableBudget: 1_000,
            affectedRouteIds: [],
          },
        },
      },
    };
    const { runtime } = createRuntimeHarness({ ui });

    render(App, { props: { runtime } });

    expect(screen.getByTestId("road-mutation-notice")).toHaveTextContent(
      "Needs $8,000",
    );
  });

  it("surfaces a recoverable road preview host error without replacing the shell", () => {
    const ui = {
      ...createUiState(),
      activeTool: "roundabout" as const,
      roadMutationPreviewError: "preview host offline",
    };
    const { runtime } = createRuntimeHarness({ ui });

    render(App, { props: { runtime } });

    expect(screen.getByTestId("game-shell")).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("road-mutation-notice")).toHaveAttribute(
      "role",
      "status",
    );
    expect(screen.getByTestId("road-mutation-notice")).toHaveTextContent(
      "Road preview unavailable: preview host offline",
    );
    expect(screen.getByTestId("hud-tool-chip")).toHaveTextContent("ROUNDABOUT");
  });
});

describe("App hotkeys", () => {
  function routeDraftRuntime(selectedIndex: number | null = null) {
    return createRuntimeHarness({
      ui: {
        ...createUiState(),
        activeTool: "busRoute",
        routeDraft: { ...busDraft(["stop-001"]), selectedIndex },
        activeHudCategory: "routes",
      },
    });
  }

  it.each([
    { modifier: "metaKey", label: "Cmd" },
    { modifier: "ctrlKey", label: "Ctrl" },
  ])("uses $label+Z to undo an active route draft", async ({ modifier }) => {
    const { runtime } = routeDraftRuntime();
    render(App, { props: { runtime } });

    const event = new KeyboardEvent("keydown", {
      key: "z",
      [modifier]: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(event);

    expect(runtime.undoRouteDraft).toHaveBeenCalledTimes(1);
    expect(runtime.redoRouteDraft).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it.each([
    { key: "z", shiftKey: true, modifier: "metaKey", label: "Cmd+Shift+Z" },
    { key: "z", shiftKey: true, modifier: "ctrlKey", label: "Ctrl+Shift+Z" },
    { key: "y", shiftKey: false, modifier: "metaKey", label: "Cmd+Y" },
    { key: "y", shiftKey: false, modifier: "ctrlKey", label: "Ctrl+Y" },
  ])(
    "uses $label to redo an active route draft",
    async ({ key, shiftKey, modifier }) => {
      const { runtime } = routeDraftRuntime();
      render(App, { props: { runtime } });

      const event = new KeyboardEvent("keydown", {
        key,
        [modifier]: true,
        shiftKey,
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(event);

      expect(runtime.redoRouteDraft).toHaveBeenCalledTimes(1);
      expect(runtime.undoRouteDraft).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(true);
    },
  );

  it.each(["Delete", "Backspace"])(
    "uses %s to remove the selected route waypoint",
    async (key) => {
      const { runtime } = routeDraftRuntime(0);
      render(App, { props: { runtime } });

      const event = new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(event);

      expect(runtime.removeRouteWaypoint).toHaveBeenCalledTimes(1);
      expect(event.defaultPrevented).toBe(true);
    },
  );

  it.each(["Delete", "Backspace"])(
    "does not consume %s when no route waypoint is selected",
    async (key) => {
      const { runtime } = routeDraftRuntime();
      render(App, { props: { runtime } });

      const event = new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(event);

      expect(runtime.removeRouteWaypoint).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
    },
  );

  it("leaves native undo and deletion behavior alone in a focused input", async () => {
    const { runtime } = routeDraftRuntime();
    render(App, { props: { runtime } });

    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();

    for (const init of [
      { key: "z", metaKey: true },
      { key: "y", ctrlKey: true },
      { key: "Delete" },
      { key: "Backspace" },
    ]) {
      const event = new KeyboardEvent("keydown", {
        ...init,
        bubbles: true,
        cancelable: true,
      });
      input.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }

    expect(runtime.undoRouteDraft).not.toHaveBeenCalled();
    expect(runtime.redoRouteDraft).not.toHaveBeenCalled();
    expect(runtime.removeRouteWaypoint).not.toHaveBeenCalled();
    input.remove();
  });

  it("leaves native undo and deletion behavior alone in a focused textarea", async () => {
    const { runtime } = routeDraftRuntime();
    render(App, { props: { runtime } });

    const textarea = document.createElement("textarea");
    document.body.appendChild(textarea);
    textarea.focus();

    for (const init of [
      { key: "z", metaKey: true },
      { key: "z", metaKey: true, shiftKey: true },
      { key: "y", ctrlKey: true },
      { key: "Delete" },
      { key: "Backspace" },
    ]) {
      const event = new KeyboardEvent("keydown", {
        ...init,
        bubbles: true,
        cancelable: true,
      });
      textarea.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }

    expect(runtime.undoRouteDraft).not.toHaveBeenCalled();
    expect(runtime.redoRouteDraft).not.toHaveBeenCalled();
    expect(runtime.removeRouteWaypoint).not.toHaveBeenCalled();
    textarea.remove();
  });

  it("selects the road tool on 'r' when no building is selected", async () => {
    const { runtime } = createRuntimeHarness();
    render(App, { props: { runtime } });
    await fireEvent.keyDown(window, { key: "r" });
    expect(runtime.setTool).toHaveBeenCalledWith("road");
  });

  it("toggles the build drawer on 'b'", async () => {
    const { runtime } = createRuntimeHarness();
    render(App, { props: { runtime } });
    await fireEvent.keyDown(window, { key: "b" });
    expect(runtime.setHudCategory).toHaveBeenCalledWith("build");
  });

  it("rotates the building on 'r' when a building is selected", async () => {
    const { runtime } = createRuntimeHarness({
      ui: { ...createUiState(), selectedBuilding: "smallHouse" },
    });
    render(App, { props: { runtime } });
    await fireEvent.keyDown(window, { key: "r" });
    expect(runtime.rotateBuilding).toHaveBeenCalled();
    expect(runtime.setTool).not.toHaveBeenCalledWith("road");
  });

  it("selects a road preset on '2' while the road tool is active", async () => {
    const { runtime } = createRuntimeHarness({
      ui: { ...createUiState(), activeTool: "road" },
    });
    render(App, { props: { runtime } });
    await fireEvent.keyDown(window, { key: "2" });
    expect(runtime.setRoadPreset).toHaveBeenCalledWith("oneWay");
  });

  it("ignores hotkeys typed into an input field", async () => {
    const { runtime } = createRuntimeHarness();
    render(App, { props: { runtime } });
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    await fireEvent.keyDown(input, { key: "r" });
    expect(runtime.setTool).not.toHaveBeenCalledWith("road");
    input.remove();
  });

  it("selects the track tool on 't'", async () => {
    const { runtime } = createRuntimeHarness();
    render(App, { props: { runtime } });
    await fireEvent.keyDown(window, { key: "t" });
    expect(runtime.setTool).toHaveBeenCalledWith("track");
  });

  it("selects the remove tool on 'x'", async () => {
    const { runtime } = createRuntimeHarness();
    render(App, { props: { runtime } });
    await fireEvent.keyDown(window, { key: "x" });
    expect(runtime.setTool).toHaveBeenCalledWith("remove");
  });

  it("selects the inspect tool on 'v'", async () => {
    const { runtime } = createRuntimeHarness();
    render(App, { props: { runtime } });
    await fireEvent.keyDown(window, { key: "v" });
    expect(runtime.setTool).toHaveBeenCalledWith("inspect");
  });

  it("selects the twoWay road preset on '1' while the road tool is active", async () => {
    const { runtime } = createRuntimeHarness({
      ui: { ...createUiState(), activeTool: "road" },
    });
    render(App, { props: { runtime } });
    await fireEvent.keyDown(window, { key: "1" });
    expect(runtime.setRoadPreset).toHaveBeenCalledWith("twoWay");
  });

  it("selects the dualBidirectional road preset on '3' while the road tool is active", async () => {
    const { runtime } = createRuntimeHarness({
      ui: { ...createUiState(), activeTool: "road" },
    });
    render(App, { props: { runtime } });
    await fireEvent.keyDown(window, { key: "3" });
    expect(runtime.setRoadPreset).toHaveBeenCalledWith("dualBidirectional");
  });

  it("closes the build drawer on 'b' when it is already open", async () => {
    const { runtime } = createRuntimeHarness({
      ui: { ...createUiState(), activeHudCategory: "build" },
    });
    render(App, { props: { runtime } });
    await fireEvent.keyDown(window, { key: "b" });
    expect(runtime.setHudCategory).toHaveBeenCalledWith(null);
  });

  it("ignores 'b' when a meta modifier is held", async () => {
    const { runtime } = createRuntimeHarness();
    render(App, { props: { runtime } });
    await fireEvent.keyDown(window, { key: "b", metaKey: true });
    expect(runtime.setHudCategory).not.toHaveBeenCalled();
  });

  it("ignores 'b' when a ctrl modifier is held", async () => {
    const { runtime } = createRuntimeHarness();
    render(App, { props: { runtime } });
    await fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    expect(runtime.setHudCategory).not.toHaveBeenCalled();
  });

  it("ignores 'b' when an alt modifier is held", async () => {
    const { runtime } = createRuntimeHarness();
    render(App, { props: { runtime } });
    await fireEvent.keyDown(window, { key: "b", altKey: true });
    expect(runtime.setHudCategory).not.toHaveBeenCalled();
  });

  it("surfaces a non-Error throw from a runtime command as a generic shell error", async () => {
    // applyRuntimeResult falls back to "Runtime command failed" when the
    // thrown value is not an Error instance (e.g. a string or plain object).
    const { runtime } = createRuntimeHarness();
    runtime.togglePause = vi.fn((): RuntimeCommandResult => {
      throw "string error";
    });

    render(App, { props: { runtime } });
    await fireEvent.click(screen.getByRole("button", { name: "Resume" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Runtime command failed");
  });

  it("subscribes to the runtime and starts it on mount", () => {
    const { runtime } = createRuntimeHarness();
    render(App, { props: { runtime } });
    expect(runtime.subscribe).toHaveBeenCalled();
    expect(runtime.start).toHaveBeenCalled();
  });
});

describe("App manage-panel route handlers", () => {
  function routeState() {
    let state = createTestGameState();
    state = addTestBusStop(state, { x: 7, y: 8 });
    state = addTestBusStop(state, { x: 12, y: 8 });
    state = addTestBusRoute(state, ["stop-001", "stop-002"]);
    return state;
  }

  it("wires renameRoute through the ManagePanel input blur", async () => {
    const { runtime } = createRuntimeHarness({ state: routeState() });
    render(App, { props: { runtime } });

    await openCategory("manage");
    const input = screen.getByTestId("route-name-route-001");
    await fireEvent.input(input, { target: { value: "Commuter Express" } });
    await fireEvent.blur(input);

    expect(runtime.renameRoute).toHaveBeenCalledWith(
      "route-001",
      "Commuter Express",
    );
  });

  it("wires recolorRoute through the ManagePanel color swatch", async () => {
    const { runtime } = createRuntimeHarness({ state: routeState() });
    render(App, { props: { runtime } });

    await openCategory("manage");
    const palette = ROUTE_COLOR_PALETTE;
    const targetColor = palette[1] ?? palette[0];
    const swatch = screen.getByTestId(`route-color-route-001-${targetColor}`);
    await fireEvent.click(swatch);

    expect(runtime.recolorRoute).toHaveBeenCalledWith("route-001", targetColor);
  });

  it("wires toggleRouteActive through the ManagePanel toggle button", async () => {
    const { runtime } = createRuntimeHarness({ state: routeState() });
    render(App, { props: { runtime } });

    await openCategory("manage");
    await fireEvent.click(screen.getByTestId("route-toggle-route-001"));

    expect(runtime.toggleRouteActive).toHaveBeenCalledWith("route-001");
  });

  it("wires selectRoute through the ManagePanel route select button", async () => {
    const { runtime } = createRuntimeHarness({ state: routeState() });
    render(App, { props: { runtime } });

    await openCategory("manage");
    await fireEvent.click(screen.getByTestId("route-select-route-001"));

    expect(runtime.selectRoute).toHaveBeenCalledWith("route-001");
  });

  it("focuses the exact broken leg from Manage", async () => {
    const source = routeState();
    const state = {
      ...source,
      transit: {
        ...source.transit,
        stops: source.transit.stops.map((stop) =>
          stop.id === "stop-002"
            ? { ...stop, status: "missing" as const }
            : stop,
        ),
        routes: source.transit.routes.map((route) => ({
          ...route,
          pathBroken: true,
          legs: route.legs.map((leg, legIndex) =>
            legIndex === 0
              ? { ...leg, status: "missingNode" as const, currentPath: null }
              : leg,
          ),
        })),
      },
    };
    const { runtime } = createRuntimeHarness({ state });
    render(App, { props: { runtime } });

    await openCategory("manage");
    await fireEvent.click(
      screen.getByRole("button", {
        name: "Focus Stop A to Missing Bus Stop",
      }),
    );

    expect(runtime.focusRouteFailure).toHaveBeenCalledWith("route-001", 0);
  });

  it("wires deleteRoute through the ManagePanel two-click delete confirm", async () => {
    const { runtime } = createRuntimeHarness({ state: routeState() });
    render(App, { props: { runtime } });

    await openCategory("manage");
    const deleteBtn = screen.getByTestId("route-delete-route-001");
    // First click arms the confirm state.
    await fireEvent.click(deleteBtn);
    expect(deleteBtn).toHaveTextContent("Delete?");
    expect(runtime.deleteRoute).not.toHaveBeenCalled();
    // Second click confirms and dispatches.
    await fireEvent.click(deleteBtn);
    expect(runtime.deleteRoute).toHaveBeenCalledWith("route-001");
  });

  it("wires cancelRouteDraft through the shared editor Cancel button", async () => {
    const { runtime } = createRuntimeHarness({
      state: routeState(),
      ui: {
        ...createUiState(),
        activeTool: "busRoute",
        routeDraft: busDraft(["stop-001"]),
        activeHudCategory: "routes",
      },
    });
    render(App, { props: { runtime } });

    const cancelBtn = screen.getByRole("button", { name: "Cancel" });
    await fireEvent.click(cancelBtn);
    expect(runtime.cancelRouteDraft).toHaveBeenCalledTimes(1);
  });

  it("renders the duplicate insertion notice after a route interaction", async () => {
    let state = createTestGameState();
    state = addTestBusStop(state, { x: 7, y: 8 });
    state = addTestBusStop(state, { x: 15, y: 8 });
    const { runtime } = createRuntimeHarness({
      state,
      ui: {
        ...createUiState(),
        activeTool: "busRoute",
        routeDraft: busDraft(["stop-001", "stop-002"], true),
        activeHudCategory: "routes",
      },
    });
    render(App, { props: { runtime } });

    await fireEvent.click(screen.getByTestId("route-waypoint-0"));
    await fireEvent.click(screen.getByRole("button", { name: "Insert after" }));
    runtime.handleTileClick({ x: 7, y: 8 });

    await waitFor(() =>
      expect(screen.getByTestId("route-draft-notice")).toHaveAttribute(
        "aria-live",
        "polite",
      ),
    );
    expect(screen.getByTestId("route-draft-notice")).toHaveTextContent(
      "Already on this route.",
    );
  });

  it("wires saveRouteDraft through the Save route button during a draft", async () => {
    let state = routeState();
    // Add roads so the closing loop is pathable.
    state = {
      ...state,
      map: {
        ...state.map,
        tiles: state.map.tiles.map((tile) =>
          tile.y === 8 && tile.x >= 7 && tile.x <= 12
            ? { ...tile, kind: "road" as const }
            : tile,
        ),
      },
    };
    const { runtime } = createRuntimeHarness({
      state,
      ui: {
        ...createUiState(),
        activeTool: "busRoute",
        routeDraft: busDraft(["stop-001", "stop-002"], true),
        activeHudCategory: "routes",
      },
    });
    render(App, { props: { runtime } });

    const finishBtn = screen.getByRole("button", { name: "Save route" });
    await fireEvent.click(finishBtn);
    expect(runtime.saveRouteDraft).toHaveBeenCalledTimes(1);
  });

  it("wires selected waypoint removal through the shared editor", async () => {
    const { runtime } = createRuntimeHarness({
      state: routeState(),
      ui: {
        ...createUiState(),
        activeTool: "busRoute",
        routeDraft: busDraft(["stop-001", "stop-002"], true),
        activeHudCategory: "routes",
      },
    });
    render(App, { props: { runtime } });

    await fireEvent.click(screen.getByTestId("route-waypoint-1"));
    expect(runtime.selectRouteWaypoint).toHaveBeenCalledWith(1, "append");
    await fireEvent.click(
      within(screen.getByTestId("route-draft")).getByRole("button", {
        name: "Remove",
      }),
    );
    expect(runtime.removeRouteWaypoint).toHaveBeenCalledTimes(1);
  });
});
