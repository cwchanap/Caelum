import { render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import GameCanvas from "../../src/components/GameCanvas.svelte";

describe("GameCanvas", () => {
  it("mounts the runtime canvas host and cleans up on destroy", () => {
    const detach = vi.fn();
    const runtime = {
      mountCanvas: vi.fn(() => detach)
    };
    const onShellError = vi.fn();

    const { unmount } = render(GameCanvas, {
      props: { runtime, onShellError }
    });
    const host = screen.getByTestId("game-canvas-host");

    expect(runtime.mountCanvas).toHaveBeenCalledWith(host);
    expect(onShellError).not.toHaveBeenCalled();

    unmount();

    expect(detach).toHaveBeenCalledTimes(1);
  });

  it("reports mount errors to the shell", () => {
    const runtime = {
      mountCanvas: vi.fn(() => {
        throw new Error("Canvas 2D context unavailable");
      })
    };
    const onShellError = vi.fn();

    render(GameCanvas, {
      props: { runtime, onShellError }
    });

    expect(onShellError).toHaveBeenCalledWith("Canvas 2D context unavailable");
  });
});
