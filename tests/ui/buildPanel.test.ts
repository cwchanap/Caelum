import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import BuildPanel from "../../src/components/hud/panels/BuildPanel.svelte";
import type { BuildCategoryId } from "../../src/domain/catalog/buildMenu";
import type { BuildingType } from "../../src/domain/types";

type Overrides = Partial<{
  buildCategory: BuildCategoryId | null;
  activeTool: "inspect" | "road" | "track";
  selectedBuilding: BuildingType | null;
  roadPreset: "twoWay" | "oneWay" | "dualBidirectional";
}>;

function renderPanel(overrides: Overrides = {}) {
  const props = {
    buildCategory: null as BuildCategoryId | null,
    activeTool: "inspect" as const,
    selectedBuilding: null,
    roadPreset: "twoWay" as const,
    buildingRotation: 0 as const,
    onSetBuildCategory: vi.fn(),
    onSelectItem: vi.fn(),
    onRotateBuilding: vi.fn(),
    ...overrides,
  };
  render(BuildPanel, { props });
  return props;
}

describe("BuildPanel root view", () => {
  it("lists the ten categories and drills in on click", async () => {
    const props = renderPanel();
    for (const label of [
      "Road",
      "Rail",
      "Bus",
      "Metro",
      "Residential",
      "Commercial",
      "Industrial",
      "Office",
      "Civic",
      "Park",
    ]) {
      expect(screen.getByRole("button", { name: label })).toBeVisible();
    }
    await fireEvent.click(screen.getByRole("button", { name: "Bus" }));
    expect(props.onSetBuildCategory).toHaveBeenCalledWith("bus");
  });

  it("disables Rotate when no building is selected", () => {
    renderPanel();
    expect(
      screen.getByRole("button", { name: /Rotate building/i }),
    ).toBeDisabled();
  });
});

describe("BuildPanel detail view", () => {
  it("shows the category's items with a back control", async () => {
    const props = renderPanel({ buildCategory: "bus" });
    expect(screen.getByRole("button", { name: "Bus Stop" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Bus Terminal" })).toBeVisible();
    await fireEvent.click(screen.getByRole("button", { name: /back/i }));
    expect(props.onSetBuildCategory).toHaveBeenCalledWith(null);
  });

  it("dispatches a building action for a building item", async () => {
    const props = renderPanel({ buildCategory: "residential" });
    await fireEvent.click(screen.getByRole("button", { name: "Small House" }));
    expect(props.onSelectItem).toHaveBeenCalledWith({
      kind: "building",
      building: "smallHouse",
    });
  });

  it("dispatches a road action carrying the preset", async () => {
    const props = renderPanel({ buildCategory: "road" });
    await fireEvent.click(screen.getByRole("button", { name: "2-Lane" }));
    expect(props.onSelectItem).toHaveBeenCalledWith({
      kind: "road",
      roadPreset: "dualBidirectional",
    });
  });

  it("dispatches a track action", async () => {
    const props = renderPanel({ buildCategory: "rail" });
    await fireEvent.click(screen.getByRole("button", { name: "Track" }));
    expect(props.onSelectItem).toHaveBeenCalledWith({ kind: "track" });
  });

  it("marks the selected building active and enables Rotate", () => {
    renderPanel({
      buildCategory: "residential",
      selectedBuilding: "smallHouse",
    });
    expect(screen.getByRole("button", { name: "Small House" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      screen.getByRole("button", { name: /Rotate building/i }),
    ).toBeEnabled();
  });

  it("marks the active road preset when the road tool is armed", () => {
    renderPanel({
      buildCategory: "road",
      activeTool: "road",
      roadPreset: "oneWay",
    });
    expect(
      screen.getByRole("button", { name: "1-Lane One-Way" }),
    ).toHaveAttribute("aria-pressed", "true");
  });
});
