import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import InspectPanel from "../../src/components/hud/panels/InspectPanel.svelte";
import { BUILDING_CATALOG } from "../../src/domain/catalog/buildings";
import type {
  ShellBuildingInspectorState,
  ShellInspectorState,
  ShellTransitInspectorState,
  ShellVehicleInspectorState,
} from "../../src/runtime/types";

// jsdom ships no ResizeObserver; Svelte's clientWidth/Height bindings only
// need a mountable one. Sizes stay 0, so the card keeps its fallback corner.
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  },
);

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

function renderPanel(
  inspector: ShellInspectorState,
  callbacks: {
    onAssignRouteToPlatform?: (
      nodeId: string,
      routeId: string,
      platformId: string,
    ) => void;
    onOpenServiceControls?: (routeId: string) => void;
  } = {},
) {
  render(InspectPanel, {
    props: {
      inspector,
      selectedId: "7,7",
      map: { width: 28, height: 18 },
      camera: null,
      stageWidth: 0,
      stageHeight: 0,
      onAssignRouteToPlatform: callbacks.onAssignRouteToPlatform ?? vi.fn(),
      onOpenServiceControls: callbacks.onOpenServiceControls ?? vi.fn(),
    },
  });
}

function transitInspector(
  overrides: Partial<ShellTransitInspectorState> = {},
): ShellTransitInspectorState {
  return {
    kind: "transit",
    nodeId: "stop-001",
    nodeLabel: "Bus Stop",
    canReassign: true,
    platforms: [
      {
        id: "stop-001-p0",
        label: "A",
        occupancy: 4,
        capacity: 30,
        routes: [
          {
            id: "route-001",
            name: "Bus 1",
            color: "#2563eb",
            waitingCount: 2,
            longestWaitSeconds: 192,
            moveTargets: [{ platformId: "stop-001-p1", label: "B" }],
          },
        ],
      },
      {
        id: "stop-001-p1",
        label: "B",
        occupancy: 0,
        capacity: 30,
        routes: [],
      },
    ],
    ...overrides,
  };
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
    expect(screen.getByText("Jobs 1 / 4")).toBeInTheDocument();
  });
});

describe("InspectPanel platform wait evidence", () => {
  it("labels the platform queue/capacity total separately from per-line waits", () => {
    renderPanel(transitInspector());

    expect(screen.getByTestId("platform-queue-stop-001-p0")).toHaveTextContent(
      "Queue 4/30",
    );
    const wait = screen.getByTestId("route-wait-route-001");
    expect(wait).toHaveTextContent("2 waiting");
    expect(wait).toHaveTextContent("3.2 min");
  });

  it("shows a serving line with zero wait as present but without a current wait", () => {
    renderPanel(
      transitInspector({
        platforms: [
          {
            id: "stop-001-p0",
            label: "A",
            occupancy: 0,
            capacity: 30,
            routes: [
              {
                id: "route-001",
                name: "Bus 1",
                color: "#2563eb",
                waitingCount: 0,
                longestWaitSeconds: null,
                moveTargets: [],
              },
            ],
          },
        ],
      }),
    );

    const wait = screen.getByTestId("route-wait-route-001");
    expect(wait).toHaveTextContent("0 waiting");
    expect(wait).toHaveTextContent("No current wait");
  });

  it("opens service controls with only the route id", async () => {
    const onOpenServiceControls = vi.fn();
    const onAssignRouteToPlatform = vi.fn();
    renderPanel(transitInspector(), { onOpenServiceControls });

    await fireEvent.click(
      screen.getByRole("button", { name: "Open service controls for Bus 1" }),
    );

    expect(onOpenServiceControls).toHaveBeenCalledTimes(1);
    expect(onOpenServiceControls).toHaveBeenCalledWith("route-001");
    expect(onAssignRouteToPlatform).not.toHaveBeenCalled();
  });

  it("keeps platform reassignment controls working", async () => {
    const onAssignRouteToPlatform = vi.fn();
    renderPanel(transitInspector(), { onAssignRouteToPlatform });

    await fireEvent.click(
      screen.getByRole("button", { name: "Move Bus 1 to Platform B" }),
    );

    expect(onAssignRouteToPlatform).toHaveBeenCalledWith(
      "stop-001",
      "route-001",
      "stop-001-p1",
    );
  });
});

describe("InspectPanel vehicle", () => {
  function vehicleInspector(
    overrides: Partial<ShellVehicleInspectorState> = {},
  ): ShellVehicleInspectorState {
    return {
      kind: "vehicle",
      vehicleId: "vehicle-001",
      vehicleLabel: "Bus",
      lineId: "route-001",
      lineName: "Bus 1",
      lineColor: "#2563eb",
      riders: 4,
      capacity: 30,
      destinationLabel: "Stop B",
      ...overrides,
    };
  }

  it("shows the bus line, live load and next stop", () => {
    renderPanel(vehicleInspector());

    expect(screen.getByTestId("vehicle-panel")).toHaveTextContent("Bus");
    expect(
      screen.getByRole("button", { name: "Open service controls for Bus 1" }),
    ).toHaveTextContent("Bus 1");
    expect(screen.getByTestId("vehicle-load")).toHaveTextContent("4 / 30");
    expect(screen.getByTestId("vehicle-destination")).toHaveTextContent(
      "Stop B",
    );
  });

  it("shows metro display", () => {
    renderPanel(
      vehicleInspector({
        vehicleLabel: "Metro",
        lineId: "metro-001",
        lineName: "Metro 1",
        destinationLabel: "Station B",
      }),
    );

    expect(screen.getByTestId("vehicle-panel")).toHaveTextContent("Metro");
    expect(screen.getByTestId("vehicle-destination")).toHaveTextContent(
      "Station B",
    );
  });

  it("shows an em dash for an unavailable destination", () => {
    renderPanel(vehicleInspector({ destinationLabel: "—" }));

    expect(screen.getByTestId("vehicle-destination")).toHaveTextContent("—");
  });

  it("opens Lines via the line chip", async () => {
    const onOpenServiceControls = vi.fn();
    renderPanel(vehicleInspector(), { onOpenServiceControls });

    await fireEvent.click(
      screen.getByRole("button", { name: "Open service controls for Bus 1" }),
    );

    expect(onOpenServiceControls).toHaveBeenCalledTimes(1);
    expect(onOpenServiceControls).toHaveBeenCalledWith("route-001");
  });
});
