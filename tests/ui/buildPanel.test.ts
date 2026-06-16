import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import BuildPanel from "../../src/components/hud/panels/BuildPanel.svelte";

function renderPanel(onSetTool = vi.fn()) {
  render(BuildPanel, {
    props: {
      activeTool: "inspect" as const,
      selectedBuilding: null,
      buildingRotation: 0 as const,
      roadPreset: "twoWay" as const,
      onSetTool,
      onSetBuilding: vi.fn(),
      onRotateBuilding: vi.fn(),
      onSetRoadPreset: vi.fn(),
    },
  });
  return onSetTool;
}

describe("BuildPanel road presets", () => {
  it("renders the three road presets and reports selection", async () => {
    const onSetRoadPreset = vi.fn();
    render(BuildPanel, {
      props: {
        activeTool: "road" as const,
        selectedBuilding: null,
        buildingRotation: 0 as const,
        roadPreset: "twoWay" as const,
        onSetTool: vi.fn(),
        onSetBuilding: vi.fn(),
        onRotateBuilding: vi.fn(),
        onSetRoadPreset,
      },
    });
    expect(screen.getByRole("button", { name: "1-Lane" })).toBeVisible();
    expect(screen.getByRole("button", { name: "1-Lane One-Way" })).toBeVisible();
    expect(screen.getByRole("button", { name: "2-Lane" })).toBeVisible();

    await fireEvent.click(screen.getByRole("button", { name: "2-Lane" }));
    expect(onSetRoadPreset).toHaveBeenCalledWith("dualBidirectional");
  });
});

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
