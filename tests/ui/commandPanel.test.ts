import { fireEvent, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { describe, expect, it, vi } from "vitest";
import CommandPanel from "../../src/components/hud/CommandPanel.svelte";

describe("CommandPanel", () => {
  it("renders a labelled region and focuses it after opening", async () => {
    render(CommandPanel, {
      props: {
        destination: "build",
        title: "Build",
        canClose: true,
        onClose: vi.fn(),
      },
    });

    const region = screen.getByRole("region", { name: "Build" });
    expect(region).toHaveAttribute("id", "command-panel-build");
    await tick();
    expect(region).toHaveFocus();
  });

  it("calls close and disables the close control when closing is unavailable", async () => {
    const onClose = vi.fn();
    const { rerender } = render(CommandPanel, {
      props: {
        destination: "lines",
        title: "Lines",
        canClose: true,
        onClose,
      },
    });

    const close = screen.getByRole("button", { name: "Close Lines" });
    await fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);

    await rerender({
      destination: "lines",
      title: "Lines",
      canClose: false,
      onClose,
    });
    expect(screen.getByRole("button", { name: "Close Lines" })).toBeDisabled();
  });
});
