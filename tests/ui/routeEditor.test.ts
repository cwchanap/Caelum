import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import RouteEditor from "../../src/components/hud/panels/RouteEditor.svelte";
import type { RouteEditorView } from "../../src/runtime/types";
import { createDraftView } from "../helpers/routeEditor";

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
});
