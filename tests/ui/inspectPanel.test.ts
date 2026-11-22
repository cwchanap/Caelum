import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import InspectPanel from "../../src/components/hud/panels/InspectPanel.svelte";
import { BUILDING_CATALOG } from "../../src/domain/catalog/buildings";
import type {
  ShellBuildingInspectorState,
  ShellInspectorState,
  ShellTransitInspectorState,
  ShellVehicleInspectorState,
  ShellZoneInspectorState,
} from "../../src/runtime/types";

// jsdom ships no ResizeObserver; Svelte's offsetWidth/Height bindings only
// need a mountable one.
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
    onClose?: () => void;
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
      onClose: callbacks.onClose ?? vi.fn(),
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

function zoneInspector(
  overrides: Partial<ShellZoneInspectorState> = {},
): ShellZoneInspectorState {
  return {
    kind: "zone",
    zoneLabel: "Residential Zone",
    runningHint: {
      nodeKind: "stop",
      routeName: "Bus 1",
      routeColor: "#2563eb",
    },
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

describe("InspectPanel header, close and queue bar", () => {
  it("presents the inspector label as the header without numbered headings", () => {
    renderPanel(transitInspector());

    expect(screen.getByTestId("inspect-title")).toHaveTextContent("Bus Stop");
    expect(screen.queryByText(/07/)).toBeNull();
  });

  it("closes the inspector from the card button", async () => {
    const onClose = vi.fn();
    renderPanel(transitInspector(), { onClose });

    await fireEvent.click(screen.getByTestId("inspect-close"));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("scales one queue bar to the node's occupancy over total platform capacity", () => {
    renderPanel(transitInspector());

    const bar = screen.getByTestId("inspect-queue-bar");
    expect(bar).toHaveAttribute("aria-label", "Queue 4/60");
    expect(screen.getByTestId("inspect-queue-fill").style.width).toBe(
      `${(4 / 60) * 100}%`,
    );
  });
});

describe("InspectPanel vacant zone", () => {
  it("labels the zone and hints at the nearby running service", () => {
    renderPanel(zoneInspector());

    expect(screen.getByTestId("inspect-title")).toHaveTextContent(
      "Residential Zone",
    );
    expect(screen.getByTestId("zone-hint-route")).toHaveTextContent("Bus 1");
    expect(screen.getByTestId("zone-hint")).toHaveTextContent("Bus stop");
    expect(screen.getByTestId("zone-hint")).toHaveTextContent(
      /proximity hint, growth not guaranteed/i,
    );
  });

  it("names a metro station hint for station coverage", () => {
    renderPanel(
      zoneInspector({
        runningHint: {
          nodeKind: "station",
          routeName: "Metro 1",
          routeColor: "#111827",
        },
      }),
    );

    expect(screen.getByTestId("zone-hint")).toHaveTextContent("Metro station");
  });

  it("stays quiet when no running line covers the zone", () => {
    renderPanel(zoneInspector({ runningHint: null }));

    expect(screen.queryByTestId("zone-hint-route")).toBeNull();
    expect(screen.getByTestId("zone-quiet")).toHaveTextContent(
      /no running line serves this land yet/i,
    );
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

describe("InspectPanel visibility and placement", () => {
  it("shows and positions the card once stage and card dimensions are measured", () => {
    const offsetWidthSpy = vi
      .spyOn(HTMLElement.prototype, "offsetWidth", "get")
      .mockReturnValue(240);
    const offsetHeightSpy = vi
      .spyOn(HTMLElement.prototype, "offsetHeight", "get")
      .mockReturnValue(160);
    try {
      render(InspectPanel, {
        props: {
          inspector: buildingInspector(),
          selectedId: "7,7",
          map: { width: 28, height: 18 },
          camera: null,
          stageWidth: 1000,
          stageHeight: 800,
          onAssignRouteToPlatform: vi.fn(),
          onOpenServiceControls: vi.fn(),
          onClose: vi.fn(),
        },
      });

      const card = screen.getByTestId("panel-inspect");
      expect(card).toBeVisible();
      expect(card).not.toHaveClass("inspection-card--hidden");
      expect(card.style.left).not.toBe("");
      expect(card.style.top).not.toBe("");
    } finally {
      offsetWidthSpy.mockRestore();
      offsetHeightSpy.mockRestore();
    }
  });

  it("keeps scrolling on an inner region so the card itself never clips the arrow", () => {
    renderPanel(transitInspector());
    const card = screen.getByTestId("panel-inspect");
    const scrollRegion = card.querySelector(".inspection-scroll");
    expect(scrollRegion).not.toBeNull();
    // All card content — header, queue bar and sections — lives inside the
    // scroll region; the non-scrolling card carries only the placement and
    // the arrow pseudo-element outside its edge.
    expect(scrollRegion).toContainElement(screen.getByTestId("inspect-title"));
    expect(scrollRegion).toContainElement(
      screen.getByTestId("inspect-queue-bar"),
    );
    expect(scrollRegion).toContainElement(screen.getByTestId("platform-panel"));
  });

  it("stays hidden when card dimensions are not measured yet", () => {
    render(InspectPanel, {
      props: {
        inspector: buildingInspector(),
        selectedId: "7,7",
        map: { width: 28, height: 18 },
        camera: null,
        stageWidth: 1000,
        stageHeight: 800,
        onAssignRouteToPlatform: vi.fn(),
        onOpenServiceControls: vi.fn(),
        onClose: vi.fn(),
      },
    });

    const card = screen.getByTestId("panel-inspect");
    expect(card).toHaveClass("inspection-card--hidden");
    expect(card.style.left).toBe("");
    expect(card.style.top).toBe("");
  });
});
