import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import BuildPanel from "../../src/components/hud/panels/BuildPanel.svelte";

function renderPanel(onSetTool = vi.fn()) {
  render(BuildPanel, {
    props: {
      activeTool: "inspect" as const,
      selectedBuilding: null,
      buildingRotation: 0 as const,
      onSetTool,
      onSetBuilding: vi.fn(),
      onRotateBuilding: vi.fn(),
    },
  });
  return onSetTool;
}

describe("BuildPanel network tools", () => {
  it("renders Road and Track buttons", () => {
    renderPanel();
    expect(screen.getByRole("button", { name: "Road" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Track" })).toBeVisible();
  });

  it("activates the road and track tools on click", async () => {
    const onSetTool = renderPanel();
    await fireEvent.click(screen.getByRole("button", { name: "Road" }));
    expect(onSetTool).toHaveBeenCalledWith("road");
    await fireEvent.click(screen.getByRole("button", { name: "Track" }));
    expect(onSetTool).toHaveBeenLastCalledWith("track");
  });
});
