import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import ManagePanel from "../../src/components/hud/panels/ManagePanel.svelte";
import { ROUTE_COLOR_PALETTE } from "../../src/ui/routePalette";
import type { ShellRouteListState } from "../../src/runtime/types";

function routes(
  overrides: Partial<ShellRouteListState[number]>[] = [],
): ShellRouteListState {
  const base: ShellRouteListState = [
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
  ];
  return base.map((r, i) => ({ ...r, ...overrides[i] }));
}

function callbacks() {
  return {
    onRenameRoute: vi.fn(),
    onRecolorRoute: vi.fn(),
    onToggleRouteActive: vi.fn(),
    onDeleteRoute: vi.fn(),
    onSelectRoute: vi.fn(),
    onFocusRouteFailure: vi.fn(),
    onEditRoute: vi.fn(),
  };
}

describe("ManagePanel route-name draft buffering", () => {
  it("renders the canonical name before any editing", () => {
    render(ManagePanel, { props: { routes: routes(), ...callbacks() } });

    expect(screen.getByTestId("route-name-route-001")).toHaveValue("Bus 1");
  });

  it("buffers keystrokes in a local draft without committing mid-edit", async () => {
    const cb = callbacks();
    render(ManagePanel, { props: { routes: routes(), ...cb } });

    const input = screen.getByTestId("route-name-route-001");
    await fireEvent.input(input, { target: { value: "Bus 1 edited" } });

    // Draft is shown, but no commit has fired.
    expect(input).toHaveValue("Bus 1 edited");
    expect(cb.onRenameRoute).not.toHaveBeenCalled();
  });

  it("commits the draft on blur and clears the buffer", async () => {
    const cb = callbacks();
    render(ManagePanel, { props: { routes: routes(), ...cb } });

    const input = screen.getByTestId("route-name-route-001");
    await fireEvent.input(input, { target: { value: "Committed" } });
    await fireEvent.blur(input);

    expect(cb.onRenameRoute).toHaveBeenCalledWith("route-001", "Committed");
    // Draft cleared: the input falls back to the (unchanged) canonical name.
    expect(input).toHaveValue("Bus 1");
  });

  it("commits the draft on Enter", async () => {
    const cb = callbacks();
    render(ManagePanel, { props: { routes: routes(), ...cb } });

    const input = screen.getByTestId("route-name-route-001");
    await fireEvent.input(input, { target: { value: "Enter commit" } });
    await fireEvent.keyDown(input, { key: "Enter" });

    expect(cb.onRenameRoute).toHaveBeenCalledWith("route-001", "Enter commit");
    // Verify no double-fire from blur after Enter.
    expect(cb.onRenameRoute).toHaveBeenCalledTimes(1);
  });

  it("does not clobber an in-flight draft when the parent rerenders the same canonical name", async () => {
    const cb = callbacks();
    const { rerender } = render(ManagePanel, {
      props: { routes: routes(), ...cb },
    });

    const input = screen.getByTestId("route-name-route-001");
    await fireEvent.input(input, { target: { value: "mid-keystroke" } });

    // Parent pushes a fresh snapshot (new array identity, same canonical name)
    // — e.g. a sim tick republished state. The unsaved draft must survive.
    await rerender({ routes: routes(), ...callbacks() });

    expect(input).toHaveValue("mid-keystroke");
  });

  it("skips commit when Enter is pressed without changing the name", async () => {
    const cb = callbacks();
    render(ManagePanel, { props: { routes: routes(), ...cb } });

    const input = screen.getByTestId("route-name-route-001");
    // Focus + Enter without typing: no draft was created, so commit is skipped.
    await fireEvent.keyDown(input, { key: "Enter" });

    expect(cb.onRenameRoute).not.toHaveBeenCalled();
  });
});

describe("ManagePanel route controls", () => {
  it("wires toggle, recolor, and select callbacks", async () => {
    const cb = callbacks();
    render(ManagePanel, { props: { routes: routes(), ...cb } });

    await fireEvent.click(screen.getByTestId("route-toggle-route-001"));
    expect(cb.onToggleRouteActive).toHaveBeenCalledWith("route-001");

    const nextColor = ROUTE_COLOR_PALETTE[1];
    await fireEvent.click(
      screen.getByTestId(`route-color-route-001-${nextColor}`),
    );
    expect(cb.onRecolorRoute).toHaveBeenCalledWith("route-001", nextColor);

    await fireEvent.click(screen.getByTestId("route-select-route-001"));
    expect(cb.onSelectRoute).toHaveBeenCalledWith("route-001");
  });

  it("requires a second click to confirm delete", async () => {
    const cb = callbacks();
    render(ManagePanel, { props: { routes: routes(), ...cb } });

    const del = screen.getByTestId("route-delete-route-001");
    await fireEvent.click(del);
    expect(del).toHaveTextContent("Delete?");
    expect(cb.onDeleteRoute).not.toHaveBeenCalled();

    await fireEvent.click(del);
    expect(cb.onDeleteRoute).toHaveBeenCalledWith("route-001");
  });

  it("clears a pending delete when the route is selected", async () => {
    const cb = callbacks();
    render(ManagePanel, { props: { routes: routes(), ...cb } });

    const del = screen.getByTestId("route-delete-route-001");
    await fireEvent.click(del);
    expect(del).toHaveTextContent("Delete?");

    await fireEvent.click(screen.getByTestId("route-select-route-001"));

    // Selecting disarms the delete; the button reverts to its resting label.
    expect(del).toHaveTextContent("Delete");
    expect(cb.onDeleteRoute).not.toHaveBeenCalled();
  });

  it("renders the empty state when there are no routes", () => {
    render(ManagePanel, { props: { routes: [], ...callbacks() } });

    expect(screen.getByText("No routes yet")).toBeVisible();
  });

  it("shows broken repair state and focuses the exact failed leg", async () => {
    const cb = callbacks();
    render(ManagePanel, {
      props: {
        routes: routes([
          {
            active: false,
            status: { primary: "broken", pausedAfterRepair: true },
            failures: [
              {
                legIndex: 1,
                fromWaypointId: "stop-002",
                toWaypointId: "stop-003",
                fromLabel: "Stop B",
                toLabel: "Stop C",
                reason: "missingNode",
                legKind: "service",
                isLoopClosing: false,
                guidance: "Restore the missing node at its former location.",
              },
            ],
          },
        ]),
        ...cb,
      },
    });

    expect(screen.getByTestId("route-status-route-001")).toHaveTextContent(
      "Broken",
    );
    expect(screen.getByText("Paused after repair")).toBeVisible();
    expect(screen.getByText("Stop B → Stop C")).toBeVisible();
    const focus = screen.getByRole("button", {
      name: "Focus Stop B to Stop C",
    });
    expect(focus).toHaveAttribute(
      "aria-describedby",
      "route-repair-route-001-1",
    );
    expect(
      document.getElementById("route-repair-route-001-1"),
    ).toHaveTextContent("Restore the missing node at its former location.");
    await fireEvent.click(focus);
    expect(cb.onFocusRouteFailure).toHaveBeenCalledWith("route-001", 1);
  });

  it("renders typed route guidance supplied by the selector", () => {
    render(ManagePanel, {
      props: {
        routes: routes([
          {
            status: { primary: "broken", pausedAfterRepair: false },
            failures: [
              {
                legIndex: 0,
                fromWaypointId: "stop-001",
                toWaypointId: "stop-002",
                fromLabel: "Stop A",
                toLabel: "Stop B",
                reason: "noLegalTurnaround",
                legKind: "terminalReversal",
                isLoopClosing: false,
                guidance: "No legal U-turn here; add a junction or roundabout.",
              },
            ],
          },
        ]),
        ...callbacks(),
      },
    });

    expect(
      screen.getByText("No legal U-turn here; add a junction or roundabout."),
    ).toBeVisible();
    expect(screen.queryByText("Repair the former road alignment.")).toBeNull();
  });

  it("launches Edit from a broken route", async () => {
    const cb = callbacks();
    render(ManagePanel, {
      props: {
        routes: routes([
          {
            status: { primary: "broken", pausedAfterRepair: false },
            failures: [
              {
                legIndex: 0,
                fromWaypointId: "stop-001",
                toWaypointId: "stop-002",
                fromLabel: "Stop A",
                toLabel: "Missing Bus Stop",
                reason: "missingNode",
                legKind: "service",
                isLoopClosing: false,
                guidance: "Restore the missing node at its former location.",
              },
            ],
          },
        ]),
        ...cb,
      },
    });

    await fireEvent.click(screen.getByRole("button", { name: "Edit Bus 1" }));
    expect(cb.onEditRoute).toHaveBeenCalledWith("route-001");
  });
});
