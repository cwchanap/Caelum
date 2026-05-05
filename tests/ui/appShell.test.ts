import { render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import App from "../../src/App.svelte";
import { createInitialGameState } from "../../src/simulation/gameState";
import { createUiState } from "../../src/ui/uiState";
import type { RuntimeController } from "../../src/runtime/types";

function createRuntimeStub(controlTowerOpen = true): RuntimeController {
  return {
    getSnapshot: () => ({
      state: createInitialGameState(),
      ui: createUiState(),
      shell: {
        topbar: {
          budget: "$120,000",
          signalState: "Live",
          time: "T+00:00",
          population: "36",
          late: "0",
          unserved: "0",
          avgWait: "0s"
        },
        controlTower: {
          title: "Growing Suburb",
          status: "RUNNING",
          objective: "Hold the line.",
          lossNote: "Within tolerances. Hold the line.",
          nextGrowth: "North homes open",
          selectedId: "—",
          activeTool: "INSPECT",
          controlTowerOpen
        }
      }
    }),
    subscribe: vi.fn(() => () => {}),
    start: vi.fn(),
    stop: vi.fn(),
    isRunning: vi.fn(() => false),
    tick: vi.fn(),
    reset: vi.fn(),
    setTool: vi.fn(),
    setOverlay: vi.fn(),
    togglePause: vi.fn(),
    setSpeed: vi.fn(),
    toggleControlTower: vi.fn(),
    handleTileClick: vi.fn(),
    setHoverTile: vi.fn(),
    mountCanvas: vi.fn(() => () => {})
  };
}

describe("App shell bootstrap", () => {
  it("renders the Svelte shell and canvas host", () => {
    render(App, { props: { runtime: createRuntimeStub() } });

    expect(screen.getByTestId("game-shell")).toBeVisible();
    expect(screen.getByTestId("game-canvas-host")).toBeVisible();
    expect(screen.getByText("$120,000")).toBeVisible();
    expect(screen.getByText("Growing Suburb")).toBeVisible();
  });

  it("reflects closed control tower state in the shell", () => {
    render(App, { props: { runtime: createRuntimeStub(false) } });

    expect(screen.getByTestId("control-tower")).toHaveAttribute("aria-hidden", "true");
  });

  it("renders error state when bootstrap fails", () => {
    render(App, { props: { runtime: createRuntimeStub(), error: "Bootstrap failed" } });

    const alert = screen.getByRole("alert");
    expect(alert).toBeVisible();
    expect(alert).toHaveTextContent("Bootstrap failed");

    expect(screen.getByTestId("game-shell")).toBeVisible();
    expect(screen.queryByTestId("topbar")).toBeNull();
    expect(screen.queryByTestId("game-canvas-host")).toBeNull();
    expect(screen.queryByTestId("control-tower")).toBeNull();
  });
});
