import { describe, expect, it, vi } from "vitest";
import { render, fireEvent, within } from "@testing-library/svelte";
import ControlTower from "../../src/components/ControlTower.svelte";
import type {
  ShellControlTowerState,
  ShellInspectorState,
} from "../../src/runtime/types";

const baseShell: ShellControlTowerState = {
  title: "Scenario",
  status: "RUNNING",
  objective: "obj",
  lossNote: "note",
  nextGrowth: "wave",
  selectedId: "2,2",
  activeTool: "INSPECT",
  controlTowerOpen: true,
};

const inspector: ShellInspectorState = {
  nodeId: "stop-001",
  nodeLabel: "Bus Terminal",
  canReassign: true,
  platforms: [
    {
      id: "stop-001-p0",
      label: "A",
      occupancy: 3,
      capacity: 50,
      routes: [
        {
          id: "route-001",
          name: "Bus 1",
          color: "#e04f39",
          moveTargets: [{ platformId: "stop-001-p1", label: "B" }],
        },
      ],
    },
    { id: "stop-001-p1", label: "B", occupancy: 0, capacity: 50, routes: [] },
  ],
};

function props(overrides = {}) {
  return {
    shell: baseShell,
    inspector,
    activeTool: "inspect" as const,
    activeOverlay: null,
    selectedBuilding: null,
    buildingRotation: 0 as const,
    onToggleControlTower: vi.fn(),
    onSetTool: vi.fn(),
    onSetBuilding: vi.fn(),
    onRotateBuilding: vi.fn(),
    onSetOverlay: vi.fn(),
    onAssignRouteToPlatform: vi.fn(),
    ...overrides,
  };
}

describe("ControlTower platform panel", () => {
  it("renders platforms with occupancy and a move button", () => {
    const { getByTestId } = render(ControlTower, props());
    const panel = within(getByTestId("platform-panel"));
    expect(panel.getByText("Bus Terminal")).toBeTruthy();
    expect(panel.getByText("3/50")).toBeTruthy();
    expect(getByTestId("move-route-001-stop-001-p1")).toBeTruthy();
  });

  it("calls onAssignRouteToPlatform when a move button is clicked", async () => {
    const onAssignRouteToPlatform = vi.fn();
    const { getByTestId } = render(
      ControlTower,
      props({ onAssignRouteToPlatform }),
    );
    await fireEvent.click(getByTestId("move-route-001-stop-001-p1"));
    expect(onAssignRouteToPlatform).toHaveBeenCalledWith(
      "stop-001",
      "route-001",
      "stop-001-p1",
    );
  });

  it("hides move buttons when canReassign is false", () => {
    const { getByTestId, queryByTestId } = render(
      ControlTower,
      props({ inspector: { ...inspector, canReassign: false } }),
    );
    expect(getByTestId("platform-panel")).toBeTruthy();
    expect(queryByTestId("move-route-001-stop-001-p1")).toBeNull();
  });

  it("shows a No routes state for empty platforms", () => {
    const { getByTestId } = render(ControlTower, props());
    const panel = within(getByTestId("platform-panel"));
    expect(panel.getByText("No routes")).toBeTruthy();
  });
});
