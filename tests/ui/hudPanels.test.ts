import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import HudDrawer from "../../src/components/hud/HudDrawer.svelte";
import type {
  ShellBriefState,
  ShellInspectorState,
  ShellRouteListState,
} from "../../src/runtime/types";

const brief: ShellBriefState = {
  title: "Scenario",
  status: "RUNNING",
  objective: "obj",
  lossNote: "note",
  nextGrowth: "wave",
  selectedId: "2,2",
  activeTool: "INSPECT",
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

function drawerProps(overrides: Record<string, unknown> = {}) {
  return {
    category: "build" as const,
    brief,
    activeTool: "inspect" as const,
    activeOverlay: null,
    selectedArea: null,
    selectedBuilding: null,
    buildingRotation: 0 as const,
    roadPreset: "twoWay" as const,
    buildCategory: null,
    inspector: null,
    routeDraft: null,
    routes: [] as ShellRouteListState,
    onCloseDrawer: vi.fn(),
    onSetTool: vi.fn(),
    onSetArea: vi.fn(),
    onRotateBuilding: vi.fn(),
    onSetBuildCategory: vi.fn(),
    onSelectBuildItem: vi.fn(),
    onSetOverlay: vi.fn(),
    onAssignRouteToPlatform: vi.fn(),
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

describe("HudDrawer panel routing", () => {
  it("renders the build panel and selects a building within a category", async () => {
    const onSelectBuildItem = vi.fn();
    render(HudDrawer, {
      props: drawerProps({ buildCategory: "residential", onSelectBuildItem }),
    });

    expect(screen.getByTestId("panel-build")).toBeVisible();
    await fireEvent.click(screen.getByRole("button", { name: "Small House" }));
    expect(onSelectBuildItem).toHaveBeenCalledWith({
      kind: "building",
      building: "smallHouse",
    });
  });

  it("routes the area category to the AreaPanel", () => {
    render(HudDrawer, { props: drawerProps({ category: "area" }) });
    expect(screen.getByTestId("panel-area")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Residential" })).toBeVisible();
  });

  it("shows Build categories then drills in", async () => {
    const onSetBuildCategory = vi.fn();
    render(HudDrawer, {
      props: drawerProps({ category: "build", onSetBuildCategory }),
    });
    await fireEvent.click(screen.getByRole("button", { name: "Bus" }));
    expect(onSetBuildCategory).toHaveBeenCalledWith("bus");
  });

  it("renders the data panel toggles", async () => {
    const onSetOverlay = vi.fn();
    render(HudDrawer, {
      props: drawerProps({ category: "data", onSetOverlay }),
    });

    expect(screen.getByTestId("panel-data")).toBeVisible();
    await fireEvent.click(screen.getByRole("button", { name: "Coverage" }));
    expect(onSetOverlay).toHaveBeenCalledWith("coverage");
  });

  it("renders the manage panel route list and delete confirm", async () => {
    const onDeleteRoute = vi.fn();
    render(HudDrawer, {
      props: drawerProps({
        category: "manage",
        onDeleteRoute,
        routes: [
          {
            id: "route-001",
            name: "Bus 1",
            color: "#e04f39",
            mode: "bus",
            stopCount: 3,
            active: true,
            selected: false,
          },
        ],
      }),
    });

    const del = screen.getByTestId("route-delete-route-001");
    await fireEvent.click(del);
    expect(del).toHaveTextContent("Delete?");
    await fireEvent.click(del);
    expect(onDeleteRoute).toHaveBeenCalledWith("route-001");
  });

  it("renders the inspect panel and wires platform reassignment", async () => {
    const onAssignRouteToPlatform = vi.fn();
    render(HudDrawer, {
      props: drawerProps({
        category: "inspect",
        inspector,
        onAssignRouteToPlatform,
      }),
    });

    const move = screen.getByTestId("move-route-001-stop-001-p1");
    await fireEvent.click(move);
    expect(onAssignRouteToPlatform).toHaveBeenCalledWith(
      "stop-001",
      "route-001",
      "stop-001-p1",
    );
  });

  it("renders the brief panel scenario text", () => {
    render(HudDrawer, { props: drawerProps({ category: "brief" }) });
    const panel = screen.getByTestId("panel-brief");
    expect(within(panel).getByText("Scenario")).toBeVisible();
  });

  it("hides the drawer when category is null", () => {
    render(HudDrawer, { props: drawerProps({ category: null }) });
    const drawer = screen.getByTestId("hud-drawer");
    expect(drawer).toHaveAttribute("aria-hidden", "true");
    // Closed drawer must be inert so its hidden controls stay out of the
    // keyboard tab order and accessibility tree (it is hidden via opacity,
    // not display:none). Svelte sets the `inert` IDL property; we assert on
    // the property because jsdom does not reflect it to the content attribute.
    expect((drawer as HTMLElement).inert).toBe(true);
  });

  it("leaves the drawer focusable when a category is active", () => {
    render(HudDrawer, { props: drawerProps({ category: "routes" }) });
    const drawer = screen.getByTestId("hud-drawer");
    expect(drawer).toHaveAttribute("aria-hidden", "false");
    expect((drawer as HTMLElement).inert).toBe(false);
  });
});
