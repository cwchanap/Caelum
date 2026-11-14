import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { tick } from "svelte";
import { describe, expect, it, vi } from "vitest";
import BuildPanel from "../../src/components/hud/panels/BuildPanel.svelte";
import { BUILDING_CATALOG } from "../../src/domain/catalog/buildings";
import {
  BUILD_GROUPS,
  type BuildGroup,
  type BuildItemAction,
  type BuildMenuGroup,
} from "../../src/domain/catalog/buildGroups";
import { ROAD_PRESET_KEYS } from "../../src/ui/shortcuts";
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

function panelProps(overrides: Overrides = {}) {
  return {
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
}

function renderView(overrides: Overrides = {}) {
  const props = panelProps(overrides);
  return { props, ...render(BuildPanel, { props }) };
}

function renderPanel(overrides: Overrides = {}) {
  return renderView(overrides).props;
}

function groupItems(group: BuildMenuGroup) {
  return group.sections.flatMap((section) => section.items);
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
      const image = within(plate).getByRole("presentation", {
        hidden: true,
      });
      expect(image.getAttribute("src")).toContain(
        `/build-categories/${group}.webp`,
      );
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

describe("BuildPanel category focus", () => {
  it("focuses Back when a group opens and returns to its plate on Back", async () => {
    const view = renderView();
    await fireEvent.click(screen.getByTestId("command-plate-roads"));
    expect(view.props.onSetBuildGroup).toHaveBeenCalledWith("roads");

    await view.rerender({ ...view.props, activeBuildGroup: "roads" });
    await tick();
    expect(screen.getByTestId("build-back")).toHaveFocus();

    await fireEvent.click(screen.getByTestId("build-back"));
    expect(view.props.onSetBuildGroup).toHaveBeenLastCalledWith(null);

    await view.rerender({ ...view.props, activeBuildGroup: null });
    await tick();
    expect(screen.getByTestId("command-plate-roads")).toHaveFocus();
  });
});

describe("BuildPanel item cards", () => {
  it("renders a building card with art, description, footprint and price", () => {
    renderPanel({ activeBuildGroup: "buildings" });
    const card = screen.getByTestId("build-item-smallHouse");
    expect(card).toHaveAccessibleName("Small House");
    expect(
      within(card)
        .getByRole("presentation", { hidden: true })
        .getAttribute("src"),
    ).toContain("/build-items/smallHouse.webp");
    expect(card).toHaveTextContent("Compact starter home.");
    expect(card).toHaveTextContent("2 × 1 · $4,000 each");
  });

  it("exposes price, footprint and description as the card description", () => {
    renderPanel({ activeBuildGroup: "buildings" });
    const card = screen.getByTestId("build-item-smallHouse");
    expect(card).toHaveAccessibleName("Small House");
    expect(card).toHaveAccessibleDescription(/2 × 1 · \$4,000 each/);
    expect(card).toHaveAccessibleDescription(/Compact starter home\./);
  });

  it("shows the rotated footprint only for the armed building", async () => {
    const view = renderView({
      activeBuildGroup: "buildings",
      selectedBuilding: "officeTower",
      buildingRotation: 90,
    });
    expect(screen.getByTestId("build-item-smallHouse")).toHaveTextContent(
      "2 × 1 · $4,000 each",
    );

    await view.rerender({
      ...view.props,
      selectedBuilding: "smallHouse",
      buildingRotation: 90,
    });
    expect(screen.getByTestId("build-item-smallHouse")).toHaveTextContent(
      "1 × 2 · $4,000 each",
    );
  });

  it("shows nominal road, track, roundabout, stop and zone hints", () => {
    renderPanel({ activeBuildGroup: "roads" });
    expect(screen.getByTestId("build-item-road-twoWay")).toHaveTextContent(
      "1 × 1 · $100/tile",
    );
    expect(screen.getByTestId("build-item-road-dual")).toHaveTextContent(
      "1 × 1 · $200/tile",
    );
    expect(
      screen.getByTestId("build-item-compactRoundabout"),
    ).toHaveTextContent("2 × 2 · $1,000 each");
    expect(
      screen.getByTestId("build-item-standardRoundabout"),
    ).toHaveTextContent("3 × 3 · $2,000 each");

    renderPanel({ activeBuildGroup: "transit" });
    expect(screen.getByTestId("build-item-track")).toHaveTextContent(
      "1 × 1 · $500/tile",
    );
    expect(screen.getByTestId("build-item-busStop")).toHaveTextContent(
      "1 × 1 · $2,000 each",
    );
    expect(screen.getByTestId("build-item-metroStation")).toHaveTextContent(
      "1 × 1 · $25,000 each",
    );

    renderPanel({ activeBuildGroup: "zones" });
    expect(screen.getByTestId("build-item-residential")).toHaveTextContent(
      "Paint · Free",
    );
  });

  it("renders each item card with its catalogue thumbnail", () => {
    for (const group of BUILD_GROUPS) {
      const view = renderView({ activeBuildGroup: group.id });
      for (const item of groupItems(group)) {
        const card = screen.getByTestId(`build-item-${item.id}`);
        expect(
          within(card)
            .getByRole("presentation", { hidden: true })
            .getAttribute("src"),
        ).toContain(`/build-items/${item.id}.webp`);
      }
      view.unmount();
    }
  });

  it("has art for every catalogue item and no orphaned item art", () => {
    const art = import.meta.glob<string>(
      "../../src/assets/sunny-diorama/build-items/*.webp",
      { eager: true, import: "default" },
    );
    const artIds = Object.keys(art)
      .map((path) => path.slice(path.lastIndexOf("/") + 1, -".webp".length))
      .sort();
    const itemIds = BUILD_GROUPS.flatMap((group) => groupItems(group))
      .map((item) => item.id)
      .sort();
    expect(artIds).toEqual(itemIds);
  });
});

describe("BuildPanel shortcuts", () => {
  it("badges the first nine visible items with 1–9", () => {
    renderPanel({ activeBuildGroup: "transit" });
    for (const [id, keyShortcuts, chip] of [
      ["track", "1 t", "1 / T"],
      ["busStop", "2", "2"],
      ["busTerminal", "3", "3"],
      ["metroStation", "4", "4"],
    ]) {
      const card = screen.getByTestId(`build-item-${id}`);
      expect(card).toHaveAttribute("aria-keyshortcuts", keyShortcuts);
      expect(card.querySelector(".build-item__key")).toHaveTextContent(chip);
    }

    renderPanel({ activeBuildGroup: "zones" });
    for (const [id, key] of [
      ["residential", "1"],
      ["commercial", "2"],
      ["industrial", "3"],
      ["office", "4"],
      ["civic", "5"],
      ["park", "6"],
    ]) {
      expect(screen.getByTestId(`build-item-${id}`)).toHaveAttribute(
        "aria-keyshortcuts",
        key,
      );
    }
  });

  it("leaves items past the ninth without a badge", () => {
    renderPanel({ activeBuildGroup: "buildings" });
    expect(screen.getByTestId("build-item-clinic")).toHaveAttribute(
      "aria-keyshortcuts",
      "9",
    );
    for (const id of ["school", "parkPlaza"]) {
      const card = screen.getByTestId(`build-item-${id}`);
      expect(card).not.toHaveAttribute("aria-keyshortcuts");
      expect(card.querySelector(".build-item__key")).toBeNull();
      expect(card).not.toHaveAttribute("title");
    }
  });

  it("keeps Roads 1/2/3 in step with the global road presets", () => {
    renderPanel({ activeBuildGroup: "roads" });
    for (const preset of ["twoWay", "oneWay", "dualBidirectional"] as const) {
      const item = groupItems(BUILD_GROUPS[0]).find(
        (candidate) =>
          candidate.action.kind === "road" &&
          candidate.action.roadPreset === preset,
      );
      expect(item).toBeDefined();
      expect(screen.getByTestId(`build-item-${item!.id}`)).toHaveAttribute(
        "aria-keyshortcuts",
        ROAD_PRESET_KEYS[preset],
      );
    }
    expect(screen.getByTestId("build-item-compactRoundabout")).toHaveAttribute(
      "aria-keyshortcuts",
      "4",
    );
    expect(screen.getByTestId("build-item-standardRoundabout")).toHaveAttribute(
      "aria-keyshortcuts",
      "5",
    );
  });

  it("labels a shortcut in the card title without changing its name", () => {
    renderPanel({ activeBuildGroup: "transit" });
    const track = screen.getByRole("button", { name: "Track" });
    expect(track).toHaveAttribute("title", "Track (1 / T)");
    const busStop = screen.getByRole("button", { name: "Bus Stop" });
    expect(busStop).toHaveAttribute("aria-keyshortcuts", "2");
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

  it("explains in Zones that served land builds up on its own", () => {
    const zones = renderView({ activeBuildGroup: "zones" });
    expect(screen.getByTestId("build-hint")).toHaveTextContent(
      /near a stop or station on a running line builds up on its own/,
    );
    zones.unmount();

    renderPanel({ activeBuildGroup: "roads" });
    expect(screen.queryByTestId("build-hint")).toBeNull();
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
});

describe("BuildPanel footer", () => {
  it("moves Rotate and the active-item explanation into the footer", () => {
    renderPanel({ activeBuildGroup: "roads", activeTool: "road" });
    const footer = screen.getByTestId("build-footer");
    expect(footer).toContainElement(
      screen.getByRole("button", { name: /rotate building/i }),
    );
    expect(screen.getByTestId("active-item-description")).toHaveTextContent(
      "Two-way street with one lane each way.",
    );
  });

  it("explains the armed building and the group hint in the footer", () => {
    const building = renderView({
      activeBuildGroup: "buildings",
      selectedBuilding: "smallHouse",
    });
    expect(screen.getByTestId("active-item-description")).toHaveTextContent(
      "Compact starter home.",
    );
    building.unmount();

    renderPanel({ activeBuildGroup: "zones" });
    expect(screen.getByTestId("build-footer")).toContainElement(
      screen.getByTestId("build-hint"),
    );
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
    expect(enabledRotate.querySelector(".rotate-value")).toHaveTextContent(
      "0°",
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
