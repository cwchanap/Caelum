import { render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import GameCanvas from "../../src/components/GameCanvas.svelte";

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
      props: { runtime, onShellError },
    });
    const host = screen.getByTestId("game-canvas-host");

    expect(runtime.mountCanvas).toHaveBeenCalledWith(host);
    expect(host).toHaveAttribute("tabindex", "-1");
    expect(host).toHaveAttribute("aria-label", "City map");
    expect(host).toHaveAttribute("aria-describedby", "game-canvas-description");
    expect(host.querySelector("canvas")).not.toBeNull();
    const description = screen.getByText(
      "Build and inspect the transport sandbox on the city map.",
    );
    expect(description).toBeInTheDocument();
    expect(description).toBe(host.nextElementSibling);

    (component as unknown as { focus: () => void }).focus();
    expect(host).toHaveFocus();
    expect(onShellError).not.toHaveBeenCalled();

    unmount();

    expect(detach).toHaveBeenCalledTimes(1);
  });

  it("reports mount errors to the shell", () => {
    const runtime = {
      mountCanvas: vi.fn(() => {
        throw new Error("Canvas 2D context unavailable");
      }),
    };
    const onShellError = vi.fn();

    render(GameCanvas, {
      props: { runtime, onShellError },
    });

    expect(onShellError).toHaveBeenCalledWith("Canvas 2D context unavailable");
  });
});
