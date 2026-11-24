import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import RouteEditor from "../../src/components/hud/panels/RouteEditor.svelte";
import type { RouteEditorView } from "../../src/runtime/types";
import { ROUTE_COLOR_PALETTE } from "../../src/ui/routePalette";
import { createDraftView, FLEET_QUOTE } from "../helpers/routeEditor";

function editDraftView(
  overrides: Partial<RouteEditorView> = {},
): RouteEditorView {
  return createDraftView({
    source: "edit",
    title: "Editing Route 1",
    initialFleet: null,
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

function rowProps(
  editor: RouteEditorView,
  overrides: Partial<ReturnType<typeof editorProps>> = {},
) {
  return { ...editorProps(editor), ...overrides };
}

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
    const toolbarControls = [
      "Append",
      "Replace",
      "Insert after",
      "Reverse",
      "Undo",
      "Redo",
      "Cancel",
    ];
    const rowActionNames = (label: string) => [
      `Move up ${label}`,
      `Move down ${label}`,
      `Remove ${label}`,
    ];

    const { rerender } = render(RouteEditor, {
      props: editorProps(createDraftView()),
    });
    for (const name of toolbarControls) {
      expect(screen.getByRole("button", { name })).toBeVisible();
    }
    expect(screen.getByRole("radio", { name: "Loop" })).toBeVisible();
    expect(screen.getByRole("radio", { name: "Shuttle" })).toBeVisible();
    // Row actions name their waypoint, so identical controls across rows
    // stay distinguishable to assistive technology.
    for (const name of [
      ...rowActionNames("Stop A"),
      ...rowActionNames("Stop B"),
    ]) {
      expect(screen.getByRole("button", { name })).toBeVisible();
    }

    await rerender(editorProps(editDraftView()));
    expect(screen.getByText("Editing Route 1")).toBeVisible();
    expect(
      screen.getByText("Saved service stays live until Save."),
    ).toBeVisible();
    for (const name of toolbarControls) {
      expect(screen.getByRole("button", { name })).toBeVisible();
    }
    expect(screen.getByRole("button", { name: "Save route" })).toBeVisible();
  });

  it("keeps the native pattern radio group for keyboard arrow navigation", async () => {
    const onPattern = vi.fn();
    render(RouteEditor, {
      props: rowProps(createDraftView({ pattern: "shuttle" }), { onPattern }),
    });

    const loop = screen.getByRole("radio", { name: "Loop" });
    const shuttle = screen.getByRole("radio", { name: "Shuttle" });
    expect(loop).not.toBeChecked();
    expect(shuttle).toBeChecked();

    await fireEvent.click(loop);
    expect(onPattern).toHaveBeenCalledWith("loop");
  });

  it("moves and removes through per-row controls that select their row first", async () => {
    const onSelectWaypoint = vi.fn();
    const onMove = vi.fn();
    const onRemove = vi.fn();
    const waypoints = [
      {
        id: "stop-001",
        index: 0,
        label: "Stop A",
        status: "present" as const,
        selected: false,
      },
      {
        id: "stop-002",
        index: 1,
        label: "Stop B",
        status: "present" as const,
        selected: true,
      },
      {
        id: "stop-003",
        index: 2,
        label: "Stop C",
        status: "present" as const,
        selected: false,
      },
    ];
    render(RouteEditor, {
      props: rowProps(createDraftView({ waypoints, selectedIndex: 1 }), {
        onSelectWaypoint,
        onMove,
        onRemove,
      }),
    });

    expect(screen.getByTestId("route-waypoint-move-up-0")).toBeDisabled();
    expect(screen.getByTestId("route-waypoint-move-down-2")).toBeDisabled();
    expect(screen.getByTestId("route-waypoint-move-up-1")).toBeEnabled();
    expect(screen.getByTestId("route-waypoint-remove-1")).toBeEnabled();

    // Acting on an unselected waypoint selects that row before invoking the
    // move/remove handler so it cannot operate on the previously selected row.
    await fireEvent.click(screen.getByTestId("route-waypoint-move-down-0"));
    expect(onSelectWaypoint).toHaveBeenNthCalledWith(1, 0, "replace");
    expect(onMove).toHaveBeenNthCalledWith(1, 1);
    expect(onSelectWaypoint.mock.invocationCallOrder[0]).toBeLessThan(
      onMove.mock.invocationCallOrder[0]!,
    );

    await fireEvent.click(screen.getByTestId("route-waypoint-move-up-2"));
    expect(onSelectWaypoint).toHaveBeenNthCalledWith(2, 2, "replace");
    expect(onMove).toHaveBeenNthCalledWith(2, -1);
    expect(onSelectWaypoint.mock.invocationCallOrder[1]).toBeLessThan(
      onMove.mock.invocationCallOrder[1]!,
    );

    await fireEvent.click(screen.getByTestId("route-waypoint-remove-2"));
    expect(onSelectWaypoint).toHaveBeenNthCalledWith(3, 2, "replace");
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onSelectWaypoint.mock.invocationCallOrder[2]).toBeLessThan(
      onRemove.mock.invocationCallOrder[0]!,
    );
  });

  it("combines the drafting actions into one labelled group", () => {
    render(RouteEditor, { props: editorProps(createDraftView()) });

    // A plain group, not a toolbar: arrow keys do not move between buttons,
    // so the landmark must not promise toolbar keyboard behavior.
    const toolbar = screen.getByRole("group", {
      name: "Route drafting tools",
    });
    for (const name of [
      "Append",
      "Replace",
      "Insert after",
      "Reverse",
      "Undo",
      "Redo",
    ]) {
      expect(within(toolbar).getByRole("button", { name })).toBeVisible();
    }
    expect(
      within(toolbar).queryByRole("button", { name: "Move up" }),
    ).toBeNull();
  });

  it("renders the After saving quote for an affordable new draft", () => {
    render(RouteEditor, { props: editorProps(createDraftView()) });

    expect(screen.getByTestId("route-after-save")).toBeVisible();
    expect(screen.getByRole("heading", { name: "After saving" })).toBeVisible();
    expect(screen.getByTestId("route-after-save-fleet")).toHaveTextContent(
      "2 buses",
    );
    expect(screen.getByTestId("route-after-save-target")).toHaveTextContent(
      "Every 10.0 min",
    );
    expect(screen.getByTestId("route-after-save-running")).toHaveTextContent(
      "$800/day",
    );
    expect(screen.getByTestId("route-after-save-qualifier")).toHaveTextContent(
      /Estimate from the current quote/,
    );
    expect(screen.queryByTestId("route-shortfall-reason")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Save & run · $16,000" }),
    ).toBeEnabled();
  });

  it("phrases the quoted fleet singular and mode-aware", () => {
    render(RouteEditor, {
      props: editorProps(
        createDraftView({
          mode: "metro",
          initialFleet: { ...FLEET_QUOTE, vehicles: 1 },
        }),
      ),
    });

    expect(screen.getByTestId("route-after-save-fleet")).toHaveTextContent(
      "1 train",
    );
  });

  it("shows the low-money After saving summary and Save without fleet", () => {
    render(RouteEditor, {
      props: editorProps(
        createDraftView({
          initialFleet: {
            ...FLEET_QUOTE,
            shortfall: true,
            shortfallReason: "Needs $16,000; only $12,000 is available.",
          },
        }),
      ),
    });

    expect(screen.getByTestId("route-after-save-fleet")).toHaveTextContent(
      "None yet",
    );
    expect(screen.getByTestId("route-after-save-target")).toHaveTextContent(
      "Every 10.0 min",
    );
    expect(screen.getByTestId("route-after-save-running")).toHaveTextContent(
      "$0/day",
    );
    expect(screen.getByTestId("route-shortfall-reason")).toHaveTextContent(
      "Needs $16,000; only $12,000 is available.",
    );
    const save = screen.getByRole("button", { name: "Save without fleet" });
    expect(save).toBeEnabled();
  });

  it("hides After saving for edits and without a quote", () => {
    const { rerender } = render(RouteEditor, {
      props: editorProps(editDraftView()),
    });
    expect(screen.queryByTestId("route-after-save")).toBeNull();
    expect(screen.getByRole("button", { name: "Save route" })).toBeVisible();

    void rerender(editorProps(createDraftView({ initialFleet: null })));
    expect(screen.queryByTestId("route-after-save")).toBeNull();
    expect(screen.getByRole("button", { name: "Save & run" })).toBeEnabled();
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

  it("renders retained missing waypoints directly in the editor", () => {
    render(RouteEditor, {
      props: editorProps(
        editDraftView({
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
      ),
    });

    expect(screen.getByTestId("route-waypoint-1")).toHaveTextContent(
      "Missing Bus Stop",
    );
    expect(screen.getByTestId("route-waypoint-1")).toHaveClass("missing");
  });

  it("paints the waypoint rail in the edited route colour and stays neutral for a new draft", async () => {
    const onSelectWaypoint = vi.fn();
    const color = ROUTE_COLOR_PALETTE[0];
    const { rerender } = render(RouteEditor, {
      props: {
        ...editorProps(editDraftView()),
        color,
        onSelectWaypoint,
      },
    });

    const rail = screen
      .getByTestId("route-draft")
      .querySelector(".route-waypoints");
    expect(rail).not.toBeNull();
    expect(rail!.getAttribute("style")).toContain(`--route-color: ${color}`);
    expect(within(rail as HTMLElement).getAllByRole("button")).toHaveLength(8);
    expect(screen.getByTestId("route-waypoint-0")).toHaveTextContent("1");
    // Each row li owns its selectable row button and three row actions.
    const firstRow = screen
      .getByTestId("route-waypoint-0")
      .closest("li") as HTMLElement;
    for (const name of [
      `Move up Stop A`,
      `Move down Stop A`,
      `Remove Stop A`,
    ]) {
      expect(within(firstRow).getByRole("button", { name })).toBeVisible();
    }

    await fireEvent.click(screen.getByTestId("route-waypoint-1"));
    expect(onSelectWaypoint).toHaveBeenCalledWith(1, "replace");

    await rerender({ ...editorProps(createDraftView()), color: null });
    const neutralRail = screen
      .getByTestId("route-draft")
      .querySelector(".route-waypoints");
    expect(neutralRail!.getAttribute("style") ?? "").not.toContain(
      "--route-color",
    );
  });
});
