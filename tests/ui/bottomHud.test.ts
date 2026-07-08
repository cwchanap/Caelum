import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import BottomHud from "../../src/components/hud/BottomHud.svelte";
import type { ShellHudState } from "../../src/runtime/types";

function hud(overrides: Partial<ShellHudState> = {}): ShellHudState {
  return {
    activeCategory: "brief",
    activeToolChip: "INSPECT",
    canCancel: false,
    buildCategory: null,
    inspectToolActive: true,
    removeToolActive: false,
    badges: {
      routeDraftActive: false,
      routeCount: 0,
      activeOverlayLabel: null,
      inspectActive: false,
    },
    ...overrides,
  };
}

describe("BottomHud", () => {
  it("renders the five category buttons and the tool chip", () => {
    render(BottomHud, {
      props: {
        hud: hud(),
        onSetHudCategory: vi.fn(),
        onCancel: vi.fn(),
        onSetTool: vi.fn(),
      },
    });

    for (const id of ["build", "area", "routes", "manage", "data", "brief"]) {
      expect(screen.getByTestId(`hud-cat-${id}`)).toBeVisible();
    }
    expect(screen.getByTestId("hud-tool-chip")).toHaveTextContent("INSPECT");
  });

  it("toggles the active category to null when clicked again", async () => {
    const onSetHudCategory = vi.fn();
    render(BottomHud, {
      props: {
        hud: hud({ activeCategory: "build" }),
        onSetHudCategory,
        onCancel: vi.fn(),
        onSetTool: vi.fn(),
      },
    });

    await fireEvent.click(screen.getByTestId("hud-cat-build"));
    expect(onSetHudCategory).toHaveBeenCalledWith(null);

    await fireEvent.click(screen.getByTestId("hud-cat-data"));
    expect(onSetHudCategory).toHaveBeenLastCalledWith("data");
  });

  it("shows badges and the inspect chip from state", () => {
    render(BottomHud, {
      props: {
        hud: hud({
          badges: {
            routeDraftActive: true,
            routeCount: 3,
            activeOverlayLabel: "Coverage",
            inspectActive: true,
          },
        }),
        onSetHudCategory: vi.fn(),
        onCancel: vi.fn(),
        onSetTool: vi.fn(),
      },
    });

    expect(screen.getByTestId("hud-badge-draft")).toBeVisible();
    expect(screen.getByTestId("hud-badge-count")).toHaveTextContent("3");
    expect(screen.getByTestId("hud-badge-overlay")).toHaveTextContent(
      "Coverage",
    );
    expect(screen.getByTestId("hud-cat-inspect")).toBeVisible();
  });

  it("disables cancel unless cancellable", async () => {
    const onCancel = vi.fn();
    const { rerender } = render(BottomHud, {
      props: {
        hud: hud(),
        onSetHudCategory: vi.fn(),
        onCancel,
        onSetTool: vi.fn(),
      },
    });
    expect(screen.getByTestId("hud-cancel")).toBeDisabled();

    await rerender({
      hud: hud({ canCancel: true }),
      onSetHudCategory: vi.fn(),
      onCancel,
      onSetTool: vi.fn(),
    });
    await fireEvent.click(screen.getByTestId("hud-cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe("BottomHud persistent tools", () => {
  it("renders Inspect/Remove toggles and fires onSetTool", async () => {
    const onSetTool = vi.fn();
    render(BottomHud, {
      props: {
        hud: hud({ inspectToolActive: true, removeToolActive: false }),
        onSetHudCategory: vi.fn(),
        onCancel: vi.fn(),
        onSetTool,
      },
    });

    const inspect = screen.getByTestId("hud-tool-inspect");
    const remove = screen.getByTestId("hud-tool-remove");
    expect(inspect).toHaveClass("active");
    expect(remove).not.toHaveClass("active");

    await fireEvent.click(remove);
    expect(onSetTool).toHaveBeenCalledWith("remove");
    await fireEvent.click(inspect);
    expect(onSetTool).toHaveBeenLastCalledWith("inspect");
  });
});
