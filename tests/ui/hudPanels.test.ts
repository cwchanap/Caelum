import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import HudDrawer from "../../src/components/hud/HudDrawer.svelte";
import RouteEditor from "../../src/components/hud/panels/RouteEditor.svelte";
import type {
  RouteEditorView,
  ShellBriefState,
  ShellInspectorState,
  ShellRouteListState,
} from "../../src/runtime/types";

function createDraftView(
  overrides: Partial<RouteEditorView> = {},
): RouteEditorView {
  return {
    source: "create",
    title: "New Bus Route",
    mode: "bus",
    pattern: "loop",
    waypoints: [
      {
        id: "stop-001",
        index: 0,
        label: "Stop A",
        status: "present",
        selected: true,
      },
      {
        id: "stop-002",
        index: 1,
        label: "Stop B",
        status: "present",
        selected: false,
      },
    ],
    selectedIndex: 0,
    interaction: "replace",
    previewPending: false,
    previewStatus: "connected",
    previewMessage: "Connected",
    previewWarnings: [],
    canSave: true,
    canReload: false,
    canUndo: false,
    canRedo: false,
    notice: null,
    failures: [],
    ...overrides,
  };
}

function editDraftView(
  overrides: Partial<RouteEditorView> = {},
): RouteEditorView {
  return createDraftView({
    source: "edit",
    title: "Editing Route 1",
    ...overrides,
  });
}

function editorProps(editor: RouteEditorView) {
  return {
    editor,
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
  };
}

const brief: ShellBriefState = {
  title: "Scenario",
  context: "Template · Crossroads",
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
    roundaboutSize: "compact2x2" as const,
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
    onSelectRouteWaypoint: vi.fn(),
    onRemoveRouteWaypoint: vi.fn(),
    onUndoRouteDraft: vi.fn(),
    onRedoRouteDraft: vi.fn(),
    onMoveRouteWaypoint: vi.fn(),
    onReverseRouteDraft: vi.fn(),
    onSetRoutePattern: vi.fn(),
    onSaveRouteDraft: vi.fn(),
    onCancelRouteDraft: vi.fn(),
    onReloadRouteDraft: vi.fn(),
    onStartRouteEdit: vi.fn(),
    onRenameRoute: vi.fn(),
    onRecolorRoute: vi.fn(),
    onToggleRouteActive: vi.fn(),
    onDeleteRoute: vi.fn(),
    onSelectRoute: vi.fn(),
    onFocusRouteFailure: vi.fn(),
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
            status: { primary: "running", pausedAfterRepair: false },
            failures: [],
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

  it("renders the selector-provided brief title and context", () => {
    render(HudDrawer, { props: drawerProps({ category: "brief" }) });
    const panel = screen.getByTestId("panel-brief");
    expect(within(panel).getByText("Scenario")).toBeVisible();
    expect(within(panel).getByText("Template · Crossroads")).toBeVisible();
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

describe("RouteEditor", () => {
  it("offers history controls, disabled states, and duplicate notices", async () => {
    const onUndo = vi.fn();
    const onRedo = vi.fn();
    const editor = {
      ...createDraftView(),
      canUndo: false,
      canRedo: true,
      notice: { kind: "alreadyOnRoute" as const, waypointId: "stop-001" },
    };

    render(RouteEditor, {
      props: {
        ...editorProps(editor),
        onUndo,
        onRedo,
      },
    });

    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Redo" })).toBeEnabled();
    expect(screen.getByTestId("route-draft-notice")).toHaveAttribute(
      "aria-live",
      "polite",
    );
    expect(screen.getByTestId("route-draft-notice")).toHaveTextContent(
      "Already on this route",
    );

    await fireEvent.click(screen.getByRole("button", { name: "Redo" }));
    expect(onRedo).toHaveBeenCalledTimes(1);
    expect(onUndo).not.toHaveBeenCalled();
  });

  it("renders typed route guidance supplied by the selector", () => {
    const guidance =
      "Loop can't close here; remove a stop or switch to Shuttle.";
    render(RouteEditor, {
      props: {
        ...editorProps(
          createDraftView({
            failures: [
              {
                legIndex: 1,
                fromWaypointId: "stop-002",
                toWaypointId: "stop-001",
                fromLabel: "Stop B",
                toLabel: "Stop A",
                reason: "networkDisconnected",
                legKind: "service",
                isLoopClosing: true,
                guidance,
              },
            ],
          }),
        ),
      },
    });

    expect(screen.getByText(guidance)).toBeVisible();
  });

  it("renders the same editor controls for creation and committed edits", async () => {
    const editorControls = [
      "Loop",
      "Shuttle",
      "Append",
      "Replace",
      "Insert after",
      "Move up",
      "Move down",
      "Reverse",
      "Remove",
      "Save route",
      "Cancel",
    ];

    const { rerender } = render(RouteEditor, {
      props: editorProps(createDraftView()),
    });
    for (const name of editorControls) {
      expect(
        screen.getByRole(
          name === "Loop" || name === "Shuttle" ? "radio" : "button",
          { name },
        ),
      ).toBeVisible();
    }

    await rerender(editorProps(editDraftView()));
    expect(screen.getByText("Editing Route 1")).toBeVisible();
    expect(
      screen.getByText("Saved service stays live until Save."),
    ).toBeVisible();
    for (const name of editorControls) {
      expect(
        screen.getByRole(
          name === "Loop" || name === "Shuttle" ? "radio" : "button",
          { name },
        ),
      ).toBeVisible();
    }
  });

  it("offers Reload after a stale revision and keeps Cancel available", () => {
    render(RouteEditor, {
      props: editorProps(
        editDraftView({
          canReload: true,
          canSave: false,
          previewStatus: "rejected",
          previewMessage:
            "This route changed while you were editing it. Reload the saved route.",
        }),
      ),
    });
    expect(
      screen.getByRole("button", { name: "Reload saved route" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Save route" })).toBeDisabled();
    expect(screen.getByTestId("route-preview-status")).toHaveTextContent(
      "This route changed while you were editing it. Reload the saved route.",
    );
    expect(screen.getByRole("button", { name: "Cancel" })).toBeVisible();
  });

  it("renders retained missing waypoints in the Manage editor", () => {
    render(HudDrawer, {
      props: drawerProps({
        category: "manage",
        routeDraft: editDraftView({
          waypoints: [
            {
              id: "stop-001",
              index: 0,
              label: "Stop A",
              status: "present",
              selected: false,
            },
            {
              id: "stop-002",
              index: 1,
              label: "Missing Bus Stop",
              status: "missing",
              selected: true,
            },
          ],
          selectedIndex: 1,
          previewStatus: "broken",
          previewMessage:
            "Stop A → Missing Bus Stop includes a missing waypoint.",
        }),
      }),
    });

    expect(screen.getByTestId("route-waypoint-1")).toHaveTextContent(
      "Missing Bus Stop",
    );
    expect(screen.getByTestId("route-waypoint-1")).toHaveClass("missing");
  });
});
