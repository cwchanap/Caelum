import { render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import GameCanvas from "../../src/components/GameCanvas.svelte";
import type { RuntimeSnapshot } from "../../src/runtime/types";
import { selectShellState } from "../../src/runtime/runtimeSelectors";
import { createTestGameState } from "../helpers/gameState";
import { createUiState } from "../../src/ui/uiState";

function snapshotFixture(): RuntimeSnapshot {
  const state = createTestGameState();
  const ui = createUiState();
  return {
    state,
    ui,
    shell: selectShellState(state, ui, null),
    persistence: {
      activeCity: null,
      busy: false,
      dirty: false,
      error: null,
    },
    backendError: null,
    rejection: null,
    sandboxResetError: null,
  };
}

describe("GameCanvas", () => {
  it("mounts the runtime canvas host and exposes deterministic focus", () => {
    const detach = vi.fn();
    const runtime = {
      mountCanvas: vi.fn((host: HTMLElement) => {
        host.innerHTML = "";
        host.append(document.createElement("canvas"));
        return detach;
      }),
    };
    const onShellError = vi.fn();

    const { component, unmount } = render(GameCanvas, {
      props: { runtime, snapshot: snapshotFixture(), onShellError },
    });
    const board = screen.getByTestId("game-canvas-host");
    const surface = board.querySelector(".board-surface") as HTMLElement;

    // The runtime mounts into the surface only, so the Svelte-owned map text
    // overlay sibling survives canvas replacement.
    expect(runtime.mountCanvas).toHaveBeenCalledWith(surface);
    expect(board).toHaveAttribute("tabindex", "-1");
    expect(board).toHaveAttribute("aria-label", "City map");
    expect(board).toHaveAttribute(
      "aria-describedby",
      "game-canvas-description",
    );
    expect(surface.querySelector("canvas")).not.toBeNull();
    const description = screen.getByText(
      "Build and inspect the transport sandbox on the city map.",
    );
    expect(description).toBeInTheDocument();
    expect(description).toBe(board.nextElementSibling);

    (component as unknown as { focus: () => void }).focus();
    expect(board).toHaveFocus();
    expect(onShellError).not.toHaveBeenCalled();

    unmount();

    expect(detach).toHaveBeenCalledTimes(1);
  });

  it("renders the map text overlay next to the runtime surface", () => {
    const runtime = {
      mountCanvas: vi.fn(() => () => {}),
    };

    render(GameCanvas, {
      props: { runtime, snapshot: snapshotFixture(), onShellError: vi.fn() },
    });

    const board = screen.getByTestId("game-canvas-host");
    const overlay = board.querySelector(".map-text-overlay");
    expect(overlay).not.toBeNull();
    expect(board.querySelector(".board-surface")!.nextElementSibling).toBe(
      overlay,
    );
  });

  it("reports mount errors to the shell", () => {
    const runtime = {
      mountCanvas: vi.fn(() => {
        throw new Error("Canvas 2D context unavailable");
      }),
    };
    const onShellError = vi.fn();

    render(GameCanvas, {
      props: { runtime, snapshot: snapshotFixture(), onShellError },
    });

    expect(onShellError).toHaveBeenCalledWith("Canvas 2D context unavailable");
  });
});
