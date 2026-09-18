import { render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import InspectPanel from "../../src/components/hud/panels/InspectPanel.svelte";
import { BUILDING_CATALOG } from "../../src/domain/catalog/buildings";
import type {
  ShellBuildingInspectorState,
  ShellInspectorState,
} from "../../src/runtime/types";

const OFFICE_PATTERN = BUILDING_CATALOG.officeTower.workPattern ?? null;

function buildingInspector(
  overrides: Partial<ShellBuildingInspectorState> = {},
): ShellBuildingInspectorState {
  return {
    kind: "building",
    buildingId: "building-01",
    buildingLabel: "Office Tower",
    metricLabel: "Jobs",
    occupancy: 0,
    capacity: 4,
    workPattern: null,
    currentDestinationDemand: null,
    ...overrides,
  };
}

function renderPanel(inspector: ShellInspectorState) {
  render(InspectPanel, {
    props: { inspector, onAssignRouteToPlatform: vi.fn() },
  });
}

describe("InspectPanel workplace status", () => {
  it("describes an unstaffed workplace without praising zero demand", () => {
    renderPanel(
      buildingInspector({
        occupancy: 0,
        workPattern: OFFICE_PATTERN,
        currentDestinationDemand: 0,
      }),
    );
    const status = screen.getByTestId("workplace-status");
    expect(status).toHaveTextContent("Unstaffed");
    expect(status).not.toHaveTextContent(/well-served|no future demand/i);
    expect(screen.getByText("Jobs 0 / 4")).not.toContainElement(status);
    expect(
      screen.getByTestId("building-panel").querySelector(".workplace-pattern"),
    ).toHaveTextContent(OFFICE_PATTERN!);
  });

  it("describes a staffed workplace with no current demand as quiet", () => {
    renderPanel(
      buildingInspector({
        occupancy: 3,
        workPattern: OFFICE_PATTERN,
        currentDestinationDemand: 0,
      }),
    );
    const status = screen.getByTestId("workplace-status");
    expect(status).toHaveTextContent("Staffed · quiet now");
    expect(screen.getByText("Jobs 3 / 4")).not.toContainElement(status);
    expect(
      screen.getByTestId("building-panel").querySelector(".workplace-pattern"),
    ).toHaveTextContent(OFFICE_PATTERN!);
  });

  it("reports the current destination demand when staffed", () => {
    renderPanel(
      buildingInspector({
        occupancy: 2,
        workPattern: OFFICE_PATTERN,
        currentDestinationDemand: 3,
      }),
    );
    const status = screen.getByTestId("workplace-status");
    expect(status).toHaveTextContent("Staffed · current destination demand 3");
    expect(screen.getByText("Jobs 2 / 4")).not.toContainElement(status);
    expect(
      screen.getByTestId("building-panel").querySelector(".workplace-pattern"),
    ).toHaveTextContent(OFFICE_PATTERN!);
  });

  it("omits workplace metadata for buildings without a pattern", () => {
    renderPanel(
      buildingInspector({
        buildingLabel: "Supermarket",
        occupancy: 1,
        workPattern: null,
        currentDestinationDemand: null,
      }),
    );
    expect(screen.queryByTestId("workplace-status")).toBeNull();
    expect(
      screen.getByTestId("building-panel").querySelector(".workplace-pattern"),
    ).toBeNull();
    expect(screen.getByText("Jobs 1 / 4")).toBeVisible();
  });
});
