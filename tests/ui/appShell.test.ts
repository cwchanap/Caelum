import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import App from "../../src/App.svelte";
import type {
  AreaKind,
  BuildingType,
  GameState,
  Overlay,
  Point,
  RoadPreset,
  Tool,
} from "../../src/domain/types";
import { createInitialGameState } from "../../src/simulation/gameState";
import { selectShellState } from "../../src/runtime/runtimeSelectors";
import type {
  RuntimeController,
  RuntimeListener,
  RuntimeSnapshot,
} from "../../src/runtime/types";
import { createUiState, type UiState } from "../../src/ui/uiState";

async function openCategory(name: string): Promise<void> {
  await fireEvent.click(screen.getByTestId(`hud-cat-${name}`));
}

function createRuntimeHarness(
  options: { state?: GameState; ui?: UiState } = {},
): { runtime: RuntimeController } {
  let state = options.state ?? createInitialGameState();
  let ui = options.ui ?? createUiState();
  const listeners = new Set<RuntimeListener>();

  const getSnapshot = (): RuntimeSnapshot => ({
    state,
    ui,
    shell: selectShellState(state, ui),
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
    getSnapshot,
    subscribe: vi.fn((listener: RuntimeListener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    start: vi.fn(),
    stop: vi.fn(),
    isRunning: vi.fn(() => false),
    tick: vi.fn((_deltaSeconds: number) => publish()),
    reset: vi.fn(() => {
      state = createInitialGameState();
      ui = createUiState();
      return publish();
    }),
    setTool: vi.fn((tool: Tool) => {
      ui = {
        ...ui,
        activeTool: tool,
        selectedBuilding: null,
        selectedArea: null,
        buildingRotation: 0,
        draftStopIds: tool === "busRoute" ? ui.draftStopIds : [],
        draftStationIds: tool === "metroLine" ? ui.draftStationIds : [],
      };
      return publish();
    }),
    setBuilding: vi.fn((building: BuildingType) => {
      ui = {
        ...ui,
        activeTool: "inspect",
        selectedId: null,
        selectedBuilding: building,
        selectedArea: null,
        buildingRotation: 0,
        draftStopIds: [],
        draftStationIds: [],
      };
      return publish();
    }),
    setArea: vi.fn((area: AreaKind) => {
      ui = {
        ...ui,
        activeTool: "area",
        selectedId: null,
        selectedBuilding: null,
        selectedArea: area,
        buildingRotation: 0,
        draftStopIds: [],
        draftStationIds: [],
      };
      return publish();
    }),
    setRoadPreset: vi.fn((preset: RoadPreset) => {
      ui = { ...ui, roadPreset: preset };
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
    handleTileClick: vi.fn((_point: Point) => publish()),
    assignRouteToPlatform: vi.fn(
      (_nodeId: string, _routeId: string, _platformId: string) => publish(),
    ),
    removeDraftStop: vi.fn((_index: number) => publish()),
    finishRoute: vi.fn(() => publish()),
    cancelRoute: vi.fn(() => publish()),
    renameRoute: vi.fn((_routeId: string, _name: string) => publish()),
    recolorRoute: vi.fn((_routeId: string, _color: string) => publish()),
    toggleRouteActive: vi.fn((_routeId: string) => publish()),
    deleteRoute: vi.fn((_routeId: string) => publish()),
    selectRoute: vi.fn((_routeId: string | null) => publish()),
    setHoverTile: vi.fn((point: Point | null) => {
      ui = { ...ui, hoverTile: point };
      return publish();
    }),
    mountCanvas: vi.fn(() => () => {}),
  };

  return { runtime };
}

describe("App shell bootstrap", () => {
  it("renders runtime-driven topbar, canvas host, and bottom HUD", async () => {
    const baseState = createInitialGameState();
    const { runtime } = createRuntimeHarness({
      state: {
        ...baseState,
        budget: 123_456,
        time: 125,
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
    expect(screen.getByText("T+02:05")).toBeVisible();
    expect(screen.getByText("Growing Suburb")).toBeVisible();
    expect(
      screen.getByText(
        /Hold late trips below 25%, unserved below 20%, average wait under 180s\./,
      ),
    ).toBeVisible();
    expect(screen.getByText("North homes open")).toBeVisible();
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

  it("keeps the selected speed visually active while paused", () => {
    const { runtime } = createRuntimeHarness({
      state: { ...createInitialGameState(), paused: true, speed: 2 },
    });

    render(App, { props: { runtime } });

    const selectedSpeed = screen.getByRole("button", { name: "2x" });
    expect(selectedSpeed).toHaveAttribute("aria-pressed", "true");
    expect(selectedSpeed).toHaveClass("active");
  });

  it("wires Build and Route Planning menus separately", async () => {
    const { runtime } = createRuntimeHarness();
    render(App, { props: { runtime } });

    await openCategory("build");

    expect(
      screen.getByRole("button", {
        name: /Rotate building, current rotation 0 degrees/i,
      }),
    ).toBeDisabled();

    await fireEvent.click(screen.getByRole("button", { name: "Large House" }));
    expect(runtime.setBuilding).toHaveBeenCalledWith("largeHouse");
    expect(screen.getByRole("button", { name: "Large House" })).toHaveAttribute(
      "data-building",
      "largeHouse",
    );
    expect(screen.getByRole("button", { name: "Large House" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByText("LARGE HOUSE 0")).toBeVisible();

    expect(
      screen.getByRole("button", {
        name: /Rotate building, current rotation 0 degrees/i,
      }),
    ).toBeEnabled();

    await fireEvent.click(
      screen.getByRole("button", {
        name: /Rotate building, current rotation 0 degrees/i,
      }),
    );
    expect(runtime.rotateBuilding).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("button", {
        name: /Rotate building, current rotation 90 degrees/i,
      }),
    ).toBeEnabled();

    await openCategory("routes");
    await fireEvent.click(
      within(screen.getByTestId("hud-drawer")).getByRole("button", {
        name: "Bus Route",
      }),
    );
    expect(runtime.setTool).toHaveBeenCalledWith("busRoute");
  });

  it("wires tool, overlay, and close interactions with exact runtime ids", async () => {
    const { runtime } = createRuntimeHarness();
    render(App, { props: { runtime } });

    await openCategory("routes");
    await fireEvent.click(screen.getByRole("button", { name: "Metro Line" }));
    expect(runtime.setTool).toHaveBeenCalledWith("metroLine");
    expect(screen.getByRole("button", { name: "Metro Line" })).toHaveAttribute(
      "data-tool",
      "metroLine",
    );
    expect(screen.getByRole("button", { name: "Metro Line" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByText("METROLINE")).toBeVisible();

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

  it("resets transient ui state when Escape is pressed", async () => {
    const { runtime } = createRuntimeHarness({
      ui: {
        ...createUiState(),
        activeTool: "busRoute",
        activeOverlay: "growth",
        selectedId: "route-001",
        draftStopIds: ["stop-001"],
        activeHudCategory: "routes",
      },
    });

    render(App, { props: { runtime } });

    await fireEvent.keyDown(window, { key: "Escape" });

    expect(runtime.resetUi).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("game-shell")).toHaveAttribute(
      "data-hud-category",
      "brief",
    );
    expect(screen.getByTestId("hud-tool-chip")).toHaveTextContent("INSPECT");
    expect(screen.getByText("—")).toBeVisible();
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

    expect(runtime.resetUi).not.toHaveBeenCalled();
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

    expect(runtime.resetUi).toHaveBeenCalledTimes(1);
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
    expect(runtime.resetUi).not.toHaveBeenCalled();
    // Tool + preset survive; only the drag is dropped.
    expect(screen.getByTestId("hud-tool-chip")).toHaveTextContent("ROAD");
    expect(screen.getByTestId("game-shell")).toHaveAttribute(
      "data-hud-category",
      "build",
    );

    // A second Escape now performs the full reset.
    await fireEvent.keyDown(window, { key: "Escape" });

    expect(runtime.resetUi).toHaveBeenCalledTimes(1);
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
        runtime: createRuntimeHarness().runtime,
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
});

describe("App hotkeys", () => {
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
});
