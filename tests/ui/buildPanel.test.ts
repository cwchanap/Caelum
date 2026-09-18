import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import BuildPanel from "../../src/components/hud/panels/BuildPanel.svelte";
import { BUILDING_CATALOG } from "../../src/domain/catalog/buildings";
import type {
  BuildGroup,
  BuildItemAction,
} from "../../src/domain/catalog/buildGroups";
import type {
  AreaKind,
  BuildingRotation,
  BuildingType,
  Tool,
} from "../../src/domain/types";

type Overrides = Partial<{
  activeBuildGroup: BuildGroup | null;
  activeTool: Tool;
  selectedArea: AreaKind | null;
  selectedBuilding: BuildingType | null;
  roadPreset: "twoWay" | "oneWay" | "dualBidirectional";
  roundaboutSize: "compact2x2" | "standard3x3";
  buildingRotation: BuildingRotation;
}>;

function renderPanel(overrides: Overrides = {}) {
  const props = {
    activeBuildGroup: null as BuildGroup | null,
    activeTool: "inspect" as Tool,
    selectedArea: null,
    selectedBuilding: null as BuildingType | null,
    roadPreset: "twoWay" as const,
    roundaboutSize: "compact2x2" as const,
    buildingRotation: 0 as const,
    onSetBuildGroup: vi.fn(),
    onSelectItem: vi.fn<(action: BuildItemAction) => void>(),
    onRotateBuilding: vi.fn(),
    ...overrides,
  };
  render(BuildPanel, { props });
  return props;
}

describe("BuildPanel root view", () => {
  it("renders exactly four command plates in the approved order", () => {
    renderPanel();
    const grid = screen.getByTestId("command-plate-grid");
    const plates = within(grid).getAllByRole("button");
    expect(plates).toHaveLength(4);
    expect(plates.map((plate) => plate.textContent?.trim())).toEqual([
      "Roads",
      "Transit",
      "Zones",
      "Buildings",
    ]);
    for (const group of ["roads", "transit", "zones", "buildings"] as const) {
      const plate = screen.getByTestId(`command-plate-${group}`);
      expect(plate).toBeVisible();
      expect(
        within(plate).getByRole("presentation", { hidden: true }),
      ).toHaveAttribute("src");
      expect(
        within(plate)
          .getByRole("presentation", { hidden: true })
          .getAttribute("src"),
      ).toMatch(/\.webp$/);
    }
  });

  it("selects a root plate and reveals the corresponding leaf inventory", async () => {
    const props = renderPanel();
    await fireEvent.click(screen.getByTestId("command-plate-roads"));
    expect(props.onSetBuildGroup).toHaveBeenCalledWith("roads");

    renderPanel({ activeBuildGroup: "transit" });
    expect(screen.getByRole("button", { name: "Track" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Bus Stop" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Metro Station" })).toBeVisible();
  });

  it("returns to the four-plate root from a detail group", async () => {
    const props = renderPanel({ activeBuildGroup: "roads" });
    await fireEvent.click(
      screen.getByRole("button", { name: /back to build/i }),
    );
    expect(props.onSetBuildGroup).toHaveBeenCalledWith(null);
  });
});

describe("BuildPanel detail view", () => {
  it("selects a leaf action exactly once", async () => {
    const props = renderPanel({ activeBuildGroup: "roads" });
    await fireEvent.click(screen.getByRole("button", { name: "2-Lane" }));
    expect(props.onSelectItem).toHaveBeenCalledTimes(1);
    expect(props.onSelectItem).toHaveBeenCalledWith({
      kind: "road",
      roadPreset: "dualBidirectional",
    });
  });

  it("includes all six area actions in Zones", () => {
    renderPanel({ activeBuildGroup: "zones" });
    for (const label of [
      "Residential",
      "Commercial",
      "Industrial",
      "Office",
      "Civic",
      "Park",
    ]) {
      expect(screen.getByRole("button", { name: label })).toBeVisible();
    }
  });

  it("keeps buildings grouped under visible area headings", () => {
    renderPanel({ activeBuildGroup: "buildings" });
    for (const label of [
      "Residential",
      "Commercial",
      "Industrial",
      "Office",
      "Civic",
      "Park",
    ]) {
      expect(screen.getByRole("heading", { name: label })).toBeVisible();
    }
    expect(screen.getByRole("button", { name: "Small House" })).toBeVisible();
  });

  it("enables Rotate only when a building is armed", () => {
    renderPanel({ activeBuildGroup: "buildings" });
    expect(
      screen.getByRole("button", { name: /rotate building/i }),
    ).toBeDisabled();
    renderPanel({
      activeBuildGroup: "buildings",
      selectedBuilding: "smallHouse",
    });
    expect(
      screen.getAllByRole("button", { name: /rotate building/i }).at(-1),
    ).toBeEnabled();
  });
});

describe("BuildPanel armed-building facts", () => {
  it("summarizes an armed residential building outside the leaf grid", () => {
    renderPanel({
      activeBuildGroup: "buildings",
      selectedBuilding: "smallHouse",
    });
    expect(screen.getByTestId("armed-building-facts")).toHaveTextContent(
      "2 × 1 · $4,000 · 4 residents",
    );
  });

  it("shows the current rotated footprint", () => {
    renderPanel({
      activeBuildGroup: "buildings",
      selectedBuilding: "smallHouse",
      buildingRotation: 90,
    });
    expect(screen.getByTestId("armed-building-facts")).toHaveTextContent(
      "1 × 2 · $4,000 · 4 residents",
    );
  });

  it("summarizes office jobs and the standard shift pattern", () => {
    renderPanel({
      activeBuildGroup: "buildings",
      selectedBuilding: "officeTower",
    });
    const facts = screen.getByTestId("armed-building-facts");
    expect(facts).toHaveTextContent("2 × 2 · $18,000 · 4 jobs");
    expect(facts).toHaveTextContent(BUILDING_CATALOG.officeTower.workPattern!);
  });

  it("summarizes factory jobs and the early/late shift pattern", () => {
    renderPanel({
      activeBuildGroup: "buildings",
      selectedBuilding: "factory",
    });
    const facts = screen.getByTestId("armed-building-facts");
    expect(facts).toHaveTextContent("3 × 2 · $16,000 · 6 jobs");
    expect(facts).toHaveTextContent(BUILDING_CATALOG.factory.workPattern!);
  });

  it("omits the capacity segment for a zero-capacity transit building", () => {
    renderPanel({
      activeBuildGroup: "transit",
      selectedBuilding: "busTerminal",
    });
    const facts = screen.getByTestId("armed-building-facts");
    expect(facts).toHaveTextContent("3 × 2 · $12,000");
    expect(facts).not.toHaveTextContent("jobs");
    expect(facts).not.toHaveTextContent("residents");
  });

  it("keeps the long schedule prose out of the leaf buttons", () => {
    renderPanel({
      activeBuildGroup: "buildings",
      selectedBuilding: "factory",
    });
    const leafButton = screen.getByTestId("build-item-factory");
    expect(leafButton).not.toHaveTextContent("05:30");
    expect(leafButton).not.toHaveTextContent("19:30");
  });
});
