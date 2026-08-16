import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import LinesPanel from "../../src/components/hud/panels/LinesPanel.svelte";
import type { BuildingType, Tool } from "../../src/domain/types";
import type {
  RouteEditorView,
  ShellRouteListState,
} from "../../src/runtime/types";
import { ROUTE_COLOR_PALETTE } from "../../src/ui/routePalette";
import { createDraftView } from "../helpers/routeEditor";

function callbacks() {
  return {
    onSetTool: vi.fn(),
    onSelectWaypoint: vi.fn(),
    onRemove: vi.fn(),
    onUndo: vi.fn(),
    onRedo: vi.fn(),
    onMove: vi.fn(),
    onReverse: vi.fn(),
    onPattern: vi.fn(),
    onSave: vi.fn(),
    onCancel: vi.fn(),
    onReload: vi.fn(),
    onRenameRoute: vi.fn(),
    onRecolorRoute: vi.fn(),
    onToggleRouteActive: vi.fn(),
    onDeleteRoute: vi.fn(),
    onFocusRouteFailure: vi.fn(),
    onEditRoute: vi.fn(),
    onSetBusTargetHeadway: vi.fn(),
    onDeployBusFleet: vi.fn(),
  };
}

function routeFixtures(): ShellRouteListState {
  return [
    {
      id: "route-bus-001",
      name: "Harbour Bus",
      color: ROUTE_COLOR_PALETTE[0],
      mode: "bus",
      stopCount: 3,
      active: true,
      selected: false,
      status: { primary: "running", pausedAfterRepair: false },
      busService: null,
      failures: [],
    },
    {
      id: "line-metro-001",
      name: "North Metro",
      color: ROUTE_COLOR_PALETTE[1],
      mode: "metro",
      stopCount: 5,
      active: false,
      selected: false,
      status: { primary: "broken", pausedAfterRepair: true },
      busService: null,
      failures: [
        {
          legIndex: 1,
          fromWaypointId: "station-001",
          toWaypointId: "station-002",
          fromLabel: "North Station",
          toLabel: "Harbour Station",
          reason: "missingNode",
          missingNodeKind: "station",
          legKind: "service",
          isLoopClosing: false,
          guidance: "Restore the missing station at its former location.",
        },
      ],
    },
  ];
}

function panelProps(
  overrides: Partial<{
    activeTool: Tool;
    selectedBuilding: BuildingType | null;
    routeDraft: RouteEditorView | null;
    routes: ShellRouteListState;
  }> = {},
) {
  return {
    activeTool: "inspect" as Tool,
    selectedBuilding: null,
    routeDraft: null,
    routes: routeFixtures(),
    ...callbacks(),
    ...overrides,
  };
}

describe("LinesPanel line workspace", () => {
  it("offers new line actions and shows both modes with status controls", async () => {
    const props = panelProps();
    render(LinesPanel, { props });

    expect(screen.getByRole("button", { name: "New Bus" })).toBeVisible();
    expect(screen.getByRole("button", { name: "New Metro" })).toBeVisible();
    expect(screen.getByTestId("route-name-route-bus-001")).toHaveValue(
      "Harbour Bus",
    );
    expect(screen.getByText("Bus")).toBeVisible();
    expect(screen.getByText("3 stops")).toBeVisible();
    expect(screen.getByText("Running")).toBeVisible();
    expect(screen.getByTestId("route-name-line-metro-001")).toHaveValue(
      "North Metro",
    );
    expect(screen.getByText("Metro")).toBeVisible();
    expect(screen.getByText("5 stops")).toBeVisible();
    expect(screen.getByText("Broken")).toBeVisible();
    expect(screen.getByText("Paused after repair")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Pause Harbour Bus" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Resume North Metro" }),
    ).toBeVisible();
    expect(screen.getAllByRole("group", { name: "Route color" })).toHaveLength(
      2,
    );
    expect(
      screen.getByRole("button", {
        name: "Focus North Station to Harbour Station",
      }),
    ).toBeVisible();
    expect(screen.getAllByRole("button", { name: "Delete" })).toHaveLength(2);

    await fireEvent.click(screen.getByRole("button", { name: "New Bus" }));
    expect(props.onSetTool).toHaveBeenCalledWith("busRoute");
    await fireEvent.click(screen.getByRole("button", { name: "New Metro" }));
    expect(props.onSetTool).toHaveBeenCalledWith("metroLine");
  });

  it("uses the labelled primary row to launch route editing", async () => {
    const props = panelProps();
    render(LinesPanel, { props });

    await fireEvent.click(
      screen.getByRole("button", { name: "Edit Harbour Bus" }),
    );
    expect(props.onEditRoute).toHaveBeenCalledTimes(1);
    expect(props.onEditRoute).toHaveBeenCalledWith("route-bus-001");
  });

  it("commits a route rename once when Enter is followed by blur", async () => {
    const props = panelProps();
    render(LinesPanel, { props });
    const input = screen.getByTestId("route-name-route-bus-001");

    await fireEvent.input(input, { target: { value: "Harbour Express" } });
    await fireEvent.keyDown(input, { key: "Enter" });
    await fireEvent.blur(input);

    expect(props.onRenameRoute).toHaveBeenCalledTimes(1);
    expect(props.onRenameRoute).toHaveBeenCalledWith(
      "route-bus-001",
      "Harbour Express",
    );
  });

  it("restores the canonical name and contains Escape in the route input", async () => {
    const props = panelProps();
    render(LinesPanel, { props });
    const input = screen.getByTestId("route-name-route-bus-001");
    const parentEscape = vi.fn();
    window.addEventListener("keydown", parentEscape);

    await fireEvent.input(input, { target: { value: "Unsaved name" } });
    await fireEvent.keyDown(input, { key: "Escape" });

    expect(input).toHaveValue("Harbour Bus");
    expect(props.onRenameRoute).not.toHaveBeenCalled();
    expect(parentEscape).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(input);
    window.removeEventListener("keydown", parentEscape);
  });

  it("requires two Delete clicks before removing a route", async () => {
    const props = panelProps();
    render(LinesPanel, { props });
    const del = screen.getByTestId("route-delete-route-bus-001");

    await fireEvent.click(del);
    expect(del).toHaveTextContent("Delete?");
    expect(props.onDeleteRoute).not.toHaveBeenCalled();
    await fireEvent.click(del);
    expect(props.onDeleteRoute).toHaveBeenCalledTimes(1);
    expect(props.onDeleteRoute).toHaveBeenCalledWith("route-bus-001");
  });

  it("pins the route editor behind an explicit draft gate", () => {
    render(LinesPanel, {
      props: panelProps({ routeDraft: createDraftView() }),
    });

    expect(screen.getByTestId("route-draft-panel-gate")).toBeVisible();
    expect(screen.getByTestId("route-draft-panel-gate")).toHaveTextContent(
      "Save or Cancel this line before changing commands",
    );
    expect(screen.getByTestId("route-draft")).toBeVisible();
    expect(screen.queryByRole("button", { name: "New Bus" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New Metro" })).toBeNull();
    expect(screen.queryByTestId("lines-list")).toBeNull();
    expect(screen.queryByText("Harbour Bus")).toBeNull();
  });

  it("shows the pre-deployment bus service block and dispatches target/fleet actions", async () => {
    const props = panelProps({
      routes: [
        {
          id: "route-bus-001",
          name: "Harbour Bus",
          color: ROUTE_COLOR_PALETTE[0],
          mode: "bus",
          stopCount: 3,
          active: true,
          selected: false,
          status: { primary: "noFleet", pausedAfterRepair: false },
          busService: {
            targetHeadwaySeconds: 360,
            roundTripSeconds: 900,
            assignedFleet: 0,
            requiredFleet: 3,
            nominalHeadwaySeconds: null,
          },
          failures: [],
        },
      ],
    });
    render(LinesPanel, { props });

    expect(screen.getByText("No fleet")).toBeVisible();
    const service = screen.getByTestId("route-service-route-bus-001");
    expect(service).toHaveTextContent("Target");
    expect(service).toHaveTextContent("6.0 min");
    expect(service).toHaveTextContent("Required");
    expect(service).toHaveTextContent("3 buses");
    const input = screen.getByTestId("route-headway-route-bus-001");
    expect(input).toHaveValue(6); // no draft: initialized from 360 / 60
    expect(input).toHaveAttribute("type", "number");
    expect(input).toHaveAttribute("min", "1");
    expect(input).toHaveAttribute("step", "1");
    expect(screen.getByRole("button", { name: "Set" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Deploy fleet" })).toBeVisible();

    await fireEvent.input(input, { target: { value: "6" } });
    await fireEvent.click(screen.getByRole("button", { name: "Set" }));
    expect(props.onSetBusTargetHeadway).toHaveBeenCalledTimes(1);
    expect(props.onSetBusTargetHeadway).toHaveBeenCalledWith(
      "route-bus-001",
      360,
    );
    // Set deleted the draft; the display falls back to the persisted target.
    expect(input).toHaveValue(6);

    await fireEvent.click(screen.getByRole("button", { name: "Deploy fleet" }));
    expect(props.onDeployBusFleet).toHaveBeenCalledTimes(1);
    expect(props.onDeployBusFleet).toHaveBeenCalledWith("route-bus-001");
  });

  it("shows setup controls for paused or broken zero-fleet bus routes without Deploy", () => {
    const props = panelProps({
      routes: [
        {
          id: "route-bus-paused",
          name: "Paused Bus",
          color: ROUTE_COLOR_PALETTE[0],
          mode: "bus",
          stopCount: 3,
          active: false,
          selected: false,
          status: { primary: "paused", pausedAfterRepair: false },
          busService: {
            targetHeadwaySeconds: 360,
            roundTripSeconds: 900,
            assignedFleet: 0,
            requiredFleet: 3,
            nominalHeadwaySeconds: null,
          },
          failures: [],
        },
        {
          id: "route-bus-broken",
          name: "Broken Bus",
          color: ROUTE_COLOR_PALETTE[1],
          mode: "bus",
          stopCount: 3,
          active: true,
          selected: false,
          status: { primary: "broken", pausedAfterRepair: false },
          busService: {
            targetHeadwaySeconds: 360,
            roundTripSeconds: 900,
            assignedFleet: 0,
            requiredFleet: 3,
            nominalHeadwaySeconds: null,
          },
          failures: [],
        },
      ],
    });
    render(LinesPanel, { props });

    for (const routeId of ["route-bus-paused", "route-bus-broken"]) {
      const service = screen.getByTestId(`route-service-${routeId}`);
      expect(service).toHaveTextContent("Target");
      expect(service).toHaveTextContent("Required");
      expect(screen.queryByTestId(`route-deploy-${routeId}`)).toBeNull();
    }
    expect(screen.getByText("Paused")).toBeVisible();
    expect(screen.getByText("Broken")).toBeVisible();
  });

  it("shows only Target/Nominal/Fleet after deployment and no setup controls", async () => {
    const props = panelProps({
      routes: [
        {
          id: "route-bus-002",
          name: "Harbour Bus",
          color: ROUTE_COLOR_PALETTE[0],
          mode: "bus",
          stopCount: 4,
          active: true,
          selected: false,
          status: { primary: "running", pausedAfterRepair: false },
          busService: {
            targetHeadwaySeconds: 360,
            roundTripSeconds: 900,
            assignedFleet: 3,
            requiredFleet: 3,
            nominalHeadwaySeconds: 348,
          },
          failures: [],
        },
        {
          id: "line-metro-001",
          name: "North Metro",
          color: ROUTE_COLOR_PALETTE[1],
          mode: "metro",
          stopCount: 5,
          active: false,
          selected: false,
          status: { primary: "broken", pausedAfterRepair: true },
          busService: null,
          failures: [],
        },
      ],
    });
    render(LinesPanel, { props });

    const service = screen.getByTestId("route-service-route-bus-002");
    expect(service).toHaveTextContent("Target");
    expect(service).toHaveTextContent("6.0 min");
    expect(service).toHaveTextContent("Nominal");
    expect(service).toHaveTextContent("5.8 min");
    expect(service).toHaveTextContent("Fleet");
    expect(service).toHaveTextContent("3");
    expect(service.textContent).not.toContain("Required");
    expect(service.textContent).not.toContain("assigned");
    expect(screen.queryByTestId("route-headway-route-bus-002")).toBeNull();
    expect(screen.queryByRole("button", { name: "Set" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Deploy/ })).toBeNull();
    expect(
      screen.queryByRole("button", { name: /AssignVehicle|Assign Vehicle/ }),
    ).toBeNull();
    expect(screen.queryByTestId("route-service-line-metro-001")).toBeNull();
  });

  it("focuses the Lines list after a draft is canceled", async () => {
    const { rerender } = render(LinesPanel, {
      props: panelProps({ routeDraft: createDraftView() }),
    });

    await rerender(panelProps({ routeDraft: null }));

    await waitFor(() => {
      expect(screen.getByTestId("lines-list")).toHaveFocus();
    });
    const list = screen.getByTestId("lines-list");
    expect(list).toHaveAttribute("aria-label", "Lines list");
    expect(list).toHaveAttribute("tabindex", "-1");
    expect(list.tagName).toBe("SECTION");
  });
});
