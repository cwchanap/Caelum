import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import App from "../../src/App.svelte";
import type {
  BuildingType,
  GameState,
  Overlay,
  Point,
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
        buildingRotation: 0,
        draftStopIds: [],
        draftStationIds: [],
      };
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
