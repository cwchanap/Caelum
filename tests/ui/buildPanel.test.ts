import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import BuildPanel from "../../src/components/hud/panels/BuildPanel.svelte";

function renderPanel(onSetTool = vi.fn()) {
  render(BuildPanel, {
    props: {
      activeTool: "inspect" as const,
      selectedArea: null,
      selectedBuilding: null,
      buildingRotation: 0 as const,
      roadPreset: "twoWay" as const,
      onSetTool,
      onSetArea: vi.fn(),
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
        selectedArea: null,
        selectedBuilding: null,
        buildingRotation: 0 as const,
        roadPreset: "twoWay" as const,
        onSetTool: vi.fn(),
        onSetArea: vi.fn(),
        onSetBuilding: vi.fn(),
        onRotateBuilding: vi.fn(),
        onSetRoadPreset,
      },
    });
    expect(screen.getByRole("button", { name: "1-Lane" })).toBeVisible();
    expect(
      screen.getByRole("button", { name: "1-Lane One-Way" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "2-Lane" })).toBeVisible();

    await fireEvent.click(screen.getByRole("button", { name: "2-Lane" }));
    expect(onSetRoadPreset).toHaveBeenCalledWith("dualBidirectional");
  });
});

describe("BuildPanel area tools", () => {
  it("renders area buttons and reports selection", async () => {
    const onSetArea = vi.fn();
    render(BuildPanel, {
      props: {
        activeTool: "inspect" as const,
        selectedArea: null,
        selectedBuilding: null,
        buildingRotation: 0 as const,
        roadPreset: "twoWay" as const,
        onSetTool: vi.fn(),
        onSetArea,
        onSetBuilding: vi.fn(),
        onRotateBuilding: vi.fn(),
        onSetRoadPreset: vi.fn(),
      },
    });

    await fireEvent.click(screen.getByRole("button", { name: "Residential" }));

    expect(screen.getByRole("button", { name: "Commercial" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Industrial" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Office" })).toBeVisible();
    expect(onSetArea).toHaveBeenCalledWith("residential");
  });

  it("marks the selected area active", () => {
    render(BuildPanel, {
      props: {
        activeTool: "area" as const,
        selectedArea: "office" as const,
        selectedBuilding: null,
        buildingRotation: 0 as const,
        roadPreset: "twoWay" as const,
        onSetTool: vi.fn(),
        onSetArea: vi.fn(),
        onSetBuilding: vi.fn(),
        onRotateBuilding: vi.fn(),
        onSetRoadPreset: vi.fn(),
      },
    });

    expect(screen.getByRole("button", { name: "Office" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
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

describe("BuildPanel building catalog", () => {
  it("exposes the destination building catalog entries", () => {
    renderPanel();

    [
      "Supermarket",
      "Cinema",
      "Factory",
      "Warehouse",
      "Office Tower",
      "Business Park",
      "Clinic",
      "School",
      "Park Plaza",
    ].forEach((label) => {
      expect(screen.getByRole("button", { name: label })).toBeVisible();
    });
  });
});
