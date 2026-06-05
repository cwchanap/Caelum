import { describe, expect, it, vi } from "vitest";
import { render, fireEvent, within } from "@testing-library/svelte";
import ControlTower from "../../src/components/ControlTower.svelte";
import type {
  ShellControlTowerState,
  ShellInspectorState,
  ShellRouteDraftState,
  ShellRouteListState,
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
    routeDraft: null,
    routes: [] as ShellRouteListState,
    onRemoveDraftStop: vi.fn(),
    onFinishRoute: vi.fn(),
    onCancelRoute: vi.fn(),
    onRenameRoute: vi.fn(),
    onRecolorRoute: vi.fn(),
    onToggleRouteActive: vi.fn(),
    onDeleteRoute: vi.fn(),
    onSelectRoute: vi.fn(),
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

const busDraft: ShellRouteDraftState = {
  mode: "bus",
  stops: [
    { index: 0, label: "Bus Stop", coord: "(7,8)" },
    { index: 1, label: "Bus Stop", coord: "(15,8)" },
  ],
  distinctCount: 2,
  vehicleCost: 8000,
  canFinish: true,
  finishHint: "Ready",
};

describe("ControlTower route draft", () => {
  it("renders the draft stop list and fires finish/remove/cancel", () => {
    const onFinishRoute = vi.fn();
    const onRemoveDraftStop = vi.fn();
    const onCancelRoute = vi.fn();
    const { getByTestId, getByRole } = render(ControlTower, {
      props: props({
        routeDraft: busDraft,
        activeTool: "busRoute",
        onFinishRoute,
        onRemoveDraftStop,
        onCancelRoute,
      }),
    });

    fireEvent.click(getByRole("button", { name: /finish route/i }));
    expect(onFinishRoute).toHaveBeenCalled();

    fireEvent.click(getByTestId("remove-draft-stop-0"));
    expect(onRemoveDraftStop).toHaveBeenCalledWith(0);

    fireEvent.click(getByRole("button", { name: /cancel route/i }));
    expect(onCancelRoute).toHaveBeenCalled();
  });

  it("shows a live readout of placed stops and vehicle cost", () => {
    const { getByTestId } = render(ControlTower, {
      props: props({ routeDraft: busDraft, activeTool: "busRoute" }),
    });
    const readout = getByTestId("route-draft-readout");
    expect(readout).toHaveTextContent("2 stops");
    expect(readout).toHaveTextContent("$8,000");
  });

  it("readout reflects the placed stop list, not the distinct count", () => {
    // Drafts may legally contain non-consecutive duplicates (e.g. a route
    // that revisits a stop). The readout must match the visible list length
    // so the player isn't told a smaller number than the list above shows.
    const draft: ShellRouteDraftState = {
      mode: "bus",
      stops: [
        { index: 0, label: "Bus Stop", coord: "(7,8)" },
        { index: 1, label: "Bus Stop", coord: "(15,8)" },
        { index: 2, label: "Bus Stop", coord: "(7,8)" },
      ],
      distinctCount: 2,
      vehicleCost: 8000,
      canFinish: true,
      finishHint: "Ready",
    };
    const { getByTestId } = render(ControlTower, {
      props: props({ routeDraft: draft, activeTool: "busRoute" }),
    });
    expect(getByTestId("route-draft-readout")).toHaveTextContent("3 stops");
  });

  it("disables finish with the hint when not finishable", () => {
    const { getByRole } = render(ControlTower, {
      props: props({
        routeDraft: {
          ...busDraft,
          canFinish: false,
          finishHint: "Add another stop",
        },
        activeTool: "busRoute",
      }),
    });
    const finish = getByRole("button", { name: /finish route/i });
    expect(finish).toBeDisabled();
    expect(finish).toHaveTextContent(/add another stop/i);
  });
});

const routeList: ShellRouteListState = [
  {
    id: "route-001",
    name: "Bus 1",
    color: "#e04f39",
    mode: "bus",
    stopCount: 3,
    active: true,
    selected: false,
  },
];

describe("ControlTower route management", () => {
  it("lists routes and fires select / toggle / recolor", () => {
    const onSelectRoute = vi.fn();
    const onToggleRouteActive = vi.fn();
    const onRecolorRoute = vi.fn();
    const { getByTestId } = render(ControlTower, {
      props: props({
        routes: routeList,
        onSelectRoute,
        onToggleRouteActive,
        onRecolorRoute,
      }),
    });

    fireEvent.click(getByTestId("route-select-route-001"));
    expect(onSelectRoute).toHaveBeenCalledWith("route-001");

    fireEvent.click(getByTestId("route-toggle-route-001"));
    expect(onToggleRouteActive).toHaveBeenCalledWith("route-001");

    fireEvent.click(getByTestId("route-color-route-001-#2867b2"));
    expect(onRecolorRoute).toHaveBeenCalledWith("route-001", "#2867b2");
  });

  it("renames on blur and requires confirm before delete", () => {
    const onRenameRoute = vi.fn();
    const onDeleteRoute = vi.fn();
    const { getByTestId } = render(ControlTower, {
      props: props({ routes: routeList, onRenameRoute, onDeleteRoute }),
    });

    const input = getByTestId("route-name-route-001") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "Loop" } });
    fireEvent.blur(input);
    expect(onRenameRoute).toHaveBeenCalledWith("route-001", "Loop");

    // First click arms confirm; second confirms.
    fireEvent.click(getByTestId("route-delete-route-001"));
    expect(onDeleteRoute).not.toHaveBeenCalled();
    fireEvent.click(getByTestId("route-delete-route-001"));
    expect(onDeleteRoute).toHaveBeenCalledWith("route-001");
  });

  it("commits a rename when Enter is pressed", () => {
    const onRenameRoute = vi.fn();
    const { getByTestId } = render(ControlTower, {
      props: props({ routes: routeList, onRenameRoute }),
    });
    const input = getByTestId("route-name-route-001") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "Express" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRenameRoute).toHaveBeenCalledWith("route-001", "Express");
  });

  it("preserves an in-progress rename across a fresh routes snapshot", async () => {
    // While the player is typing, the runtime may publish a new snapshot
    // (e.g. vehicles advancing). The input must keep the typed text instead
    // of snapping back to the canonical route name from the new snapshot.
    const onRenameRoute = vi.fn();
    const { rerender, getByTestId } = render(ControlTower, {
      props: props({ routes: routeList, onRenameRoute }),
    });
    const input = getByTestId("route-name-route-001") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "Exp" } });

    // New snapshot arrives mid-edit: same id, same canonical name, fresh ref.
    const freshSnapshot: ShellRouteListState = [
      { ...routeList[0]!, name: "Bus 1" },
    ];
    await rerender(props({ routes: freshSnapshot, onRenameRoute }));

    expect(
      (getByTestId("route-name-route-001") as HTMLInputElement).value,
    ).toBe("Exp");

    fireEvent.blur(getByTestId("route-name-route-001"));
    expect(onRenameRoute).toHaveBeenCalledWith("route-001", "Exp");
  });

  it("restores the canonical name after a rename is committed", async () => {
    const onRenameRoute = vi.fn();
    const { rerender, getByTestId } = render(ControlTower, {
      props: props({ routes: routeList, onRenameRoute }),
    });
    const input = getByTestId("route-name-route-001") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "Loop" } });
    fireEvent.blur(input);
    expect(onRenameRoute).toHaveBeenCalledWith("route-001", "Loop");

    // After commit, a fresh snapshot with the new canonical name should
    // render the canonical name (no leftover draft).
    const updated: ShellRouteListState = [{ ...routeList[0]!, name: "Loop" }];
    await rerender(props({ routes: updated, onRenameRoute }));
    expect(
      (getByTestId("route-name-route-001") as HTMLInputElement).value,
    ).toBe("Loop");
  });

  it("renders an inactive metro row with resume label and selected state", () => {
    const metroRow: ShellRouteListState = [
      {
        id: "metro-001",
        name: "Metro 1",
        color: "#2867b2",
        mode: "metro",
        stopCount: 4,
        active: false,
        selected: true,
      },
    ];
    const { getByTestId, getByText } = render(ControlTower, {
      props: props({ routes: metroRow }),
    });
    expect(getByText("Metro")).toBeInTheDocument();
    expect(getByTestId("route-toggle-metro-001")).toHaveTextContent("Resume");
    const select = getByTestId("route-select-metro-001");
    expect(select).toHaveAttribute("aria-pressed", "true");
  });

  it("shows an empty hint when there are no routes", () => {
    const { getByText } = render(ControlTower, {
      props: props({ routes: [] }),
    });
    expect(getByText(/no routes yet/i)).toBeInTheDocument();
  });
});
