import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import App from "../../src/App.svelte";
import type { GameState, Overlay, Point, Tool } from "../../src/domain/types";
import { createInitialGameState } from "../../src/simulation/gameState";
import { selectShellState } from "../../src/runtime/runtimeSelectors";
import type { RuntimeController, RuntimeListener, RuntimeSnapshot } from "../../src/runtime/types";
import { createUiState, type UiState } from "../../src/ui/uiState";

function createRuntimeHarness(options: { state?: GameState; ui?: UiState } = {}): { runtime: RuntimeController } {
  let state = options.state ?? createInitialGameState();
  let ui = options.ui ?? createUiState();
  const listeners = new Set<RuntimeListener>();

  const getSnapshot = (): RuntimeSnapshot => ({
    state,
    ui,
    shell: selectShellState(state, ui)
  });

  const publish = (): RuntimeSnapshot => {
    const snapshot = getSnapshot();
    listeners.forEach((listener) => listener(snapshot));
    return snapshot;
  };

  const runtime: RuntimeController = {
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
        draftStopIds: tool === "busRoute" ? ui.draftStopIds : [],
        draftStationIds: tool === "metroLine" ? ui.draftStationIds : []
      };
      return publish();
    }),
    setOverlay: vi.fn((overlay: Overlay | null) => {
      ui = overlay === ui.activeOverlay ? ui : { ...ui, activeOverlay: overlay };
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
    toggleControlTower: vi.fn(() => {
      ui = { ...ui, controlTowerOpen: !ui.controlTowerOpen };
      return publish();
    }),
    handleTileClick: vi.fn((_point: Point) => publish()),
    setHoverTile: vi.fn((point: Point | null) => {
      ui = { ...ui, hoverTile: point };
      return publish();
    }),
    mountCanvas: vi.fn(() => () => {})
  };

  return { runtime };
}

describe("App shell bootstrap", () => {
  it("renders runtime-driven topbar, canvas host, and control tower", () => {
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
          state: "running"
        }
      },
      ui: {
        ...createUiState(),
        activeTool: "busRoute",
        activeOverlay: "growth",
        selectedId: "route-001"
      }
    });

    render(App, { props: { runtime } });

    expect(screen.getByTestId("game-shell")).toHaveAttribute("data-tower-open", "true");
    expect(screen.getByTestId("game-canvas-host")).toBeVisible();
    expect(screen.getByText("CAELUM")).toBeVisible();
    expect(screen.getByText("Transit Ops")).toBeVisible();
    expect(screen.getByText("$123,456")).toBeVisible();
    expect(screen.getByText("T+02:05")).toBeVisible();
    expect(screen.getByText("Growing Suburb")).toBeVisible();
    expect(screen.getByText(/Hold late trips below 25%, unserved below 20%, average wait under 180s\./)).toBeVisible();
    expect(screen.getByText("North homes open")).toBeVisible();
    expect(screen.getByText("BUSROUTE")).toBeVisible();
    expect(screen.getByText("route-001")).toBeVisible();
    expect(screen.getByText("Live")).toBeVisible();

    const controlTower = screen.getByTestId("control-tower");
    expect(controlTower).toHaveAttribute("aria-hidden", "false");
    expect(within(controlTower).getByRole("button", { name: "Bus Route" })).toHaveAttribute("data-tool", "busRoute");
    expect(within(controlTower).getByRole("button", { name: "Bus Route" })).toHaveAttribute("aria-pressed", "true");
    expect(within(controlTower).getByRole("button", { name: "Growth" })).toHaveAttribute("data-overlay", "growth");
    expect(within(controlTower).getByRole("button", { name: "Growth" })).toHaveAttribute("aria-pressed", "true");
  });

  it("wires topbar controls into the runtime and reflects subscription updates", async () => {
    const { runtime } = createRuntimeHarness();
    render(App, { props: { runtime } });

    await fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(runtime.togglePause).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Live")).toBeVisible();
    expect(screen.getByRole("button", { name: "Pause" })).toHaveAttribute("aria-pressed", "false");

    await fireEvent.click(screen.getByRole("button", { name: "4x" }));
    expect(runtime.setSpeed).toHaveBeenCalledWith(4);
    expect(screen.getByRole("button", { name: "4x" })).toHaveAttribute("aria-pressed", "true");

    await fireEvent.click(screen.getByRole("button", { name: "Control Tower" }));
    expect(runtime.toggleControlTower).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("game-shell")).toHaveAttribute("data-tower-open", "false");
    expect(screen.getByTestId("control-tower")).toHaveAttribute("aria-hidden", "true");

    await fireEvent.click(screen.getByRole("button", { name: "Control Tower" }));
    expect(runtime.toggleControlTower).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("game-shell")).toHaveAttribute("data-tower-open", "true");
    expect(screen.getByTestId("control-tower")).toHaveAttribute("aria-hidden", "false");
  });

  it("wires tool, overlay, and close interactions with exact runtime ids", async () => {
    const { runtime } = createRuntimeHarness();
    render(App, { props: { runtime } });

    await fireEvent.click(screen.getByRole("button", { name: "Metro Station" }));
    expect(runtime.setTool).toHaveBeenCalledWith("metroStation");
    expect(screen.getByRole("button", { name: "Metro Station" })).toHaveAttribute("data-tool", "metroStation");
    expect(screen.getByRole("button", { name: "Metro Station" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("METROSTATION")).toBeVisible();

    await fireEvent.click(screen.getByRole("button", { name: "Coverage" }));
    expect(runtime.setOverlay).toHaveBeenCalledWith("coverage");
    expect(screen.getByRole("button", { name: "Coverage" })).toHaveAttribute("data-overlay", "coverage");
    expect(screen.getByRole("button", { name: "Coverage" })).toHaveAttribute("aria-pressed", "true");

    await fireEvent.click(screen.getByRole("button", { name: "Coverage" }));
    expect(runtime.setOverlay).toHaveBeenLastCalledWith(null);
    expect(screen.getByRole("button", { name: "Coverage" })).toHaveAttribute("aria-pressed", "false");

    await fireEvent.click(screen.getByRole("button", { name: "Close Control Tower" }));
    expect(runtime.toggleControlTower).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("control-tower")).toHaveAttribute("aria-hidden", "true");
  });

  it("renders error state when bootstrap fails", () => {
    render(App, { props: { runtime: createRuntimeHarness().runtime, error: "Bootstrap failed" } });

    const alert = screen.getByRole("alert");
    expect(alert).toBeVisible();
    expect(alert).toHaveTextContent("Bootstrap failed");

    expect(screen.getByTestId("game-shell")).toBeVisible();
    expect(screen.queryByTestId("topbar")).toBeNull();
    expect(screen.queryByTestId("game-canvas-host")).toBeNull();
    expect(screen.queryByTestId("control-tower")).toBeNull();
  });
});
