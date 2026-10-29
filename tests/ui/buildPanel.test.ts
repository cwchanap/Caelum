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

  it("shows the Track shortcut without changing its accessible name", () => {
    renderPanel({ activeBuildGroup: "transit" });
    const track = screen.getByRole("button", { name: "Track" });
    expect(track).toHaveAccessibleName("Track");
    expect(track).toHaveAttribute("aria-keyshortcuts", "t");
    expect(track).toHaveAttribute("title", "Track (T)");
    expect(track.querySelector(".shortcut-chip")).toHaveTextContent("T");
    expect(track.querySelector(".shortcut-chip")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });

  it("claims road preset shortcuts only while the Road tool is armed", () => {
    renderPanel({ activeBuildGroup: "roads" });
    for (const [id, ordinal] of [
      ["road-twoWay", "01"],
      ["road-oneWay", "02"],
      ["road-dual", "03"],
    ]) {
      const button = screen.getByTestId(`build-item-${id}`);
      expect(button).not.toHaveAttribute("aria-keyshortcuts");
      expect(button).not.toHaveAttribute("title");
      expect(button.querySelector(".tool-num")).toHaveTextContent(ordinal);
    }
  });

  it("sets Road preset shortcut attributes without adding visible chips", () => {
    renderPanel({ activeBuildGroup: "roads", activeTool: "road" });
    for (const [id, ordinal, key, title] of [
      ["road-twoWay", "01", "1", "1-Lane (1)"],
      ["road-oneWay", "02", "2", "1-Lane One-Way (2)"],
      ["road-dual", "03", "3", "2-Lane (3)"],
    ]) {
      const button = screen.getByTestId(`build-item-${id}`);
      expect(button).toHaveAttribute("aria-keyshortcuts", key);
      expect(button).toHaveAttribute("title", title);
      expect(button).toHaveAccessibleName(
        title.slice(0, title.lastIndexOf(" (")),
      );
      expect(button.querySelector(".shortcut-chip")).toBeNull();
      expect(button.querySelector(".tool-num")).toHaveTextContent(ordinal);
    }
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

  it("explains in Zones that served land builds up on its own", () => {
    renderPanel({ activeBuildGroup: "zones" });
    expect(screen.getByTestId("build-hint")).toHaveTextContent(
      /near a stop or station on a running line builds up on its own/,
    );

    renderPanel({ activeBuildGroup: "roads" });
    expect(screen.getAllByTestId("build-hint")).toHaveLength(1);
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

  it("exposes Rotate R only when a building is armed", () => {
    renderPanel({ activeBuildGroup: "buildings" });
    const disabledRotate = screen.getByRole("button", {
      name: /rotate building/i,
    });
    expect(disabledRotate).toBeDisabled();
    expect(disabledRotate).not.toHaveAttribute("aria-keyshortcuts");
    expect(disabledRotate).not.toHaveAttribute("title");
    expect(disabledRotate.querySelector(".shortcut-chip")).toBeNull();
    renderPanel({
      activeBuildGroup: "buildings",
      selectedBuilding: "smallHouse",
    });
    const enabledRotate = screen
      .getAllByRole("button", { name: /rotate building/i })
      .at(-1)!;
    expect(enabledRotate).toBeEnabled();
    expect(enabledRotate).toHaveAccessibleName(
      "Rotate building, current rotation 0 degrees",
    );
    expect(enabledRotate).toHaveAttribute("aria-keyshortcuts", "r");
    expect(enabledRotate).toHaveAttribute("title", "Rotate (R)");
    expect(enabledRotate.querySelector(".shortcut-chip")).toHaveTextContent(
      "R",
    );
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
