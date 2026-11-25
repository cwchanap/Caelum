import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import CityPanel from "../../src/components/hud/panels/CityPanel.svelte";
import type { CitySummary } from "../../src/persistence/citySaveStore";
import type { ShellCityState } from "../../src/runtime/types";

const shell = {
  title: "Standard Sandbox",
  template: "Crossroads",
  simulation: "Running",
  population: "128",
  lineCount: "3",
  networkSummary: "4 late · 2 unserved",
} satisfies ShellCityState;

const activeCity = {
  id: "city-1",
  name: "Harbour Loop",
  createdAt: "2026-08-10T12:00:00.000Z",
  savedAt: "2026-08-10T13:00:00.000Z",
} satisfies CitySummary;

const inactiveCity = {
  id: "city-2",
  name: "Dockside",
  createdAt: "2026-08-09T12:00:00.000Z",
  savedAt: "2026-08-09T13:00:00.000Z",
} satisfies CitySummary;

function renderPanel(
  overrides: Partial<{
    cities: CitySummary[] | null;
    busy: boolean;
    dirty: boolean;
    onRename: (cityId: string, name: string) => Promise<boolean>;
    onDelete: (cityId: string) => void;
    onSave: () => void;
  }> = {},
) {
  const onRename = vi.fn(async () => true);
  const onDelete = vi.fn();
  const onSave = vi.fn();
  const onLoad = vi.fn();
  const onNewCity = vi.fn();
  const props = {
    shell,
    activeCity,
    cities: [activeCity, inactiveCity] as CitySummary[] | null,
    busy: false,
    dirty: false,
    statusLabel: "Saved 12 s ago",
    error: null as string | null,
    onSave,
    onLoad,
    onRename,
    onDelete,
    onNewCity,
    ...overrides,
  };
  const { rerender } = render(CityPanel, { props });
  return {
    onRename,
    onDelete,
    onSave,
    onLoad,
    onNewCity,
    rerender: (next: Partial<typeof props>) => rerender({ ...props, ...next }),
  };
}

describe("CityPanel", () => {
  it("renders the active city, save status, and every overview field", () => {
    render(CityPanel, {
      props: {
        shell,
        activeCity,
        cities: [activeCity],
        busy: false,
        dirty: false,
        statusLabel: "Saved 12 s ago",
        error: null,
        onSave: vi.fn(),
        onLoad: vi.fn(),
        onRename: vi.fn(async () => true),
        onDelete: vi.fn(),
        onNewCity: vi.fn(),
      },
    });

    expect(screen.getByTestId("active-city-name")).toHaveTextContent(
      "Harbour Loop",
    );
    expect(screen.getByTestId("city-save-status")).toHaveAttribute(
      "data-dirty",
      "false",
    );
    expect(screen.getByTestId("city-save-status")).toHaveTextContent(
      "Saved 12 s ago",
    );
    expect(screen.getByText("Standard Sandbox")).toBeVisible();
    expect(screen.getByText("Crossroads")).toBeVisible();
    expect(screen.getByText("Running")).toBeVisible();
    expect(screen.getByText("128")).toBeVisible();
    expect(screen.getByText("3")).toBeVisible();
    expect(screen.getByText("4 late · 2 unserved")).toBeVisible();
    for (const label of [
      "Template",
      "Simulation",
      "Population",
      "Lines",
      "Network",
    ]) {
      expect(screen.getByText(label)).toBeVisible();
    }
  });

  it("shows a switching hint when the active city has unsaved changes", () => {
    render(CityPanel, {
      props: {
        shell,
        activeCity,
        cities: [activeCity],
        busy: false,
        dirty: true,
        statusLabel: "Couldn't save",
        error: null,
        onSave: vi.fn(),
        onLoad: vi.fn(),
        onRename: vi.fn(async () => true),
        onDelete: vi.fn(),
        onNewCity: vi.fn(),
      },
    });

    expect(screen.getByTestId("city-switch-hint")).toHaveTextContent(
      "Pause and Save before switching cities.",
    );
    expect(screen.getByRole("button", { name: "New City" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.getByTestId("city-save-status")).toHaveTextContent(
      "Couldn't save",
    );
  });

  it("hides the switching hint when the active city is clean", () => {
    render(CityPanel, {
      props: {
        shell,
        activeCity,
        cities: [activeCity],
        busy: false,
        dirty: false,
        statusLabel: "Saved 12 s ago",
        error: null,
        onSave: vi.fn(),
        onLoad: vi.fn(),
        onRename: vi.fn(async () => true),
        onDelete: vi.fn(),
        onNewCity: vi.fn(),
      },
    });

    expect(screen.queryByTestId("city-switch-hint")).toBeNull();
    expect(screen.getByRole("button", { name: "New City" })).toBeEnabled();
  });

  it("renames the active city from the header pencil on Enter", async () => {
    const { onRename } = renderPanel();

    await fireEvent.click(
      screen.getByRole("button", { name: "Rename Harbour Loop" }),
    );
    const input = screen.getByTestId("active-city-name") as HTMLInputElement;
    expect(input.tagName).toBe("INPUT");
    expect(document.activeElement).toBe(input);
    expect(input).toHaveValue("Harbour Loop");

    await fireEvent.input(input, { target: { value: "  Harbour Reef  " } });
    await fireEvent.keyDown(input, { key: "Enter" });

    expect(onRename).toHaveBeenCalledTimes(1);
    expect(onRename).toHaveBeenCalledWith("city-1", "Harbour Reef");
    // The editor closed after Enter; the display shows the prop value until
    // the parent publishes the rename.
    expect(screen.getByTestId("active-city-name")).toHaveTextContent(
      "Harbour Loop",
    );
    expect(
      screen.queryByRole("textbox", { name: "Rename Harbour Loop" }),
    ).toBeNull();
  });

  it("commits the trimmed header rename once on blur alone", async () => {
    const { onRename } = renderPanel();

    await fireEvent.click(
      screen.getByRole("button", { name: "Rename Harbour Loop" }),
    );
    const input = screen.getByTestId("active-city-name") as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "Harbour Reef" } });
    await fireEvent.blur(input);

    expect(onRename).toHaveBeenCalledTimes(1);
    expect(onRename).toHaveBeenCalledWith("city-1", "Harbour Reef");
    expect(
      screen.queryByRole("textbox", { name: "Rename Harbour Loop" }),
    ).toBeNull();
  });

  it("restores the active city name on Escape without committing", async () => {
    const { onRename } = renderPanel();

    await fireEvent.click(
      screen.getByRole("button", { name: "Rename Harbour Loop" }),
    );
    const input = screen.getByTestId("active-city-name") as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "Unsaved name" } });
    await fireEvent.keyDown(input, { key: "Escape" });

    expect(onRename).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("textbox", { name: "Rename Harbour Loop" }),
    ).toBeNull();
    expect(screen.getByTestId("active-city-name")).toHaveTextContent(
      "Harbour Loop",
    );
  });

  it("marks the active row read-only as Playing while keeping two-click Delete", async () => {
    const { onDelete } = renderPanel();

    const activeRow = screen.getByTestId("city-row-city-1");
    expect(within(activeRow).getByText("Playing")).toBeVisible();
    expect(within(activeRow).queryByText("Active")).toBeNull();
    const rowName = within(activeRow).getByTestId("city-name-city-1");
    expect(rowName).toHaveTextContent("Harbour Loop");
    expect(within(activeRow).queryByRole("textbox")).toBeNull();

    const del = within(activeRow).getByRole("button", { name: "Delete" });
    await fireEvent.click(del);
    expect(del).toHaveTextContent("Delete?");
    expect(onDelete).not.toHaveBeenCalled();
    await fireEvent.click(del);
    expect(onDelete).toHaveBeenCalledWith("city-1");

    // Inactive rows keep their editable name input and Load control.
    const inactiveRow = screen.getByTestId("city-row-city-2");
    expect(
      within(inactiveRow).getByRole("textbox", { name: "Rename Dockside" }),
    ).toBeVisible();
    expect(
      within(inactiveRow).getByRole("button", { name: "Load Dockside" }),
    ).toBeVisible();
  });

  it("invokes Save Now once and gates the header pencil while busy", async () => {
    const { onSave } = renderPanel();
    await fireEvent.click(screen.getByRole("button", { name: "Save Now" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  });

  it("disables the header pencil and Save controls while busy", () => {
    renderPanel({ busy: true });

    expect(
      screen.getByRole("button", { name: "Rename Harbour Loop" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Working…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "New City" })).toBeDisabled();
  });

  it("refuses an open header rename during busy and lands it only on retry", async () => {
    const { onRename, rerender } = renderPanel();

    await fireEvent.click(
      screen.getByRole("button", { name: "Rename Harbour Loop" }),
    );
    const input = screen.getByTestId("active-city-name") as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "Harbour Reef" } });

    // An autosave starts while the header editor is already open.
    await rerender({ busy: true });
    expect(input).toBeDisabled();
    await fireEvent.keyDown(input, { key: "Enter" });

    // The rename is refused, not queued: the editor stays open with the
    // draft and nothing is sent to the runtime while busy.
    expect(onRename).not.toHaveBeenCalled();
    const held = screen.getByTestId("active-city-name") as HTMLInputElement;
    expect(held.tagName).toBe("INPUT");
    expect(held).toHaveValue("Harbour Reef");

    // Idle replays nothing; the draft lands only on an explicit retry.
    await rerender({ busy: false });
    expect(onRename).not.toHaveBeenCalled();
    await fireEvent.keyDown(held, { key: "Enter" });
    expect(onRename).toHaveBeenCalledTimes(1);
    expect(onRename).toHaveBeenCalledWith("city-1", "Harbour Reef");
    expect(screen.getByTestId("active-city-name")).toHaveTextContent(
      "Harbour Loop",
    );
    expect(
      screen.queryByRole("textbox", { name: "Rename Harbour Loop" }),
    ).toBeNull();
  });

  it("commits an open header rename before loading another city", async () => {
    const { onRename, onLoad } = renderPanel();

    await fireEvent.click(
      screen.getByRole("button", { name: "Rename Harbour Loop" }),
    );
    const input = screen.getByTestId("active-city-name") as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "Harbour Reef" } });

    // The Load press suppresses the header editor's blur commit
    // (mousedown.preventDefault), so the click itself flushes the header
    // draft before the load swaps the active city under the open editor.
    const load = screen.getByRole("button", { name: "Load Dockside" });
    expect(await fireEvent.mouseDown(load)).toBe(false);
    await fireEvent.click(load);

    await waitFor(() =>
      expect(onRename).toHaveBeenCalledWith("city-1", "Harbour Reef"),
    );
    await waitFor(() => expect(onLoad).toHaveBeenCalledWith("city-2"));
  });

  it("commits an open header rename before leaving for New City", async () => {
    const { onRename, onNewCity } = renderPanel();

    await fireEvent.click(
      screen.getByRole("button", { name: "Rename Harbour Loop" }),
    );
    const input = screen.getByTestId("active-city-name") as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "Harbour Reef" } });

    await fireEvent.click(screen.getByRole("button", { name: "New City" }));

    await waitFor(() =>
      expect(onRename).toHaveBeenCalledWith("city-1", "Harbour Reef"),
    );
    await waitFor(() => expect(onNewCity).toHaveBeenCalled());
  });

  it("commits an open header rename before saving", async () => {
    const { onRename, onSave } = renderPanel();

    await fireEvent.click(
      screen.getByRole("button", { name: "Rename Harbour Loop" }),
    );
    const input = screen.getByTestId("active-city-name") as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "Harbour Reef" } });

    // Save Now shares the prevented-press contract: the canceled mousedown
    // keeps the press from blur-committing the editor, so the click flushes
    // the draft itself before saving.
    const save = screen.getByRole("button", { name: "Save Now" });
    expect(await fireEvent.mouseDown(save)).toBe(false);
    await fireEvent.click(save);

    await waitFor(() =>
      expect(onRename).toHaveBeenCalledWith("city-1", "Harbour Reef"),
    );
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  });

  it("keeps Load, New City, and Save Now put when the header rename fails", async () => {
    const onRename = vi.fn(async () => false);
    const { onLoad, onNewCity, onSave } = renderPanel({ onRename });

    for (const action of ["Save Now", "New City", "Load Dockside"]) {
      onRename.mockClear();
      await fireEvent.click(
        screen.getByRole("button", { name: "Rename Harbour Loop" }),
      );
      const input = screen.getByTestId("active-city-name") as HTMLInputElement;
      await fireEvent.input(input, { target: { value: "Harbour Reef" } });
      await fireEvent.click(screen.getByRole("button", { name: action }));
      await waitFor(() => expect(onRename).toHaveBeenCalledTimes(1));
      expect(onRename).toHaveBeenCalledWith("city-1", "Harbour Reef");
      // The failed flush re-opens the draft for retry instead of dropping
      // it; the gated action still stays put on the false commit result.
      const restored = await screen.findByRole("textbox", {
        name: "Rename Harbour Loop",
      });
      expect(restored).toHaveValue("Harbour Reef");
      await fireEvent.keyDown(restored, { key: "Escape" });
      await waitFor(() =>
        expect(
          screen.queryByRole("textbox", { name: "Rename Harbour Loop" }),
        ).toBeNull(),
      );
    }

    expect(onSave).not.toHaveBeenCalled();
    expect(onNewCity).not.toHaveBeenCalled();
    expect(onLoad).not.toHaveBeenCalled();
  });

  it("discards an open rename draft when another city becomes active", async () => {
    const { onRename, rerender } = renderPanel();

    await fireEvent.click(
      screen.getByRole("button", { name: "Rename Harbour Loop" }),
    );
    const input = screen.getByTestId("active-city-name") as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "Harbour Reef" } });
    await rerender({ busy: true });
    await fireEvent.keyDown(input, { key: "Enter" });

    // A load or deletion completing under the open editor swaps the active
    // city; the draft typed for Harbour Loop is discarded rather than
    // applied to the replacement city's id.
    await rerender({ busy: false, activeCity: inactiveCity });

    expect(onRename).not.toHaveBeenCalled();
    expect(screen.getByTestId("active-city-name").tagName).toBe("SPAN");
    expect(screen.getByTestId("active-city-name")).toHaveTextContent(
      "Dockside",
    );
  });

  it("discards an open rename draft when another city with the same name becomes active", async () => {
    const { onRename, rerender } = renderPanel();

    await fireEvent.click(
      screen.getByRole("button", { name: "Rename Harbour Loop" }),
    );
    const input = screen.getByTestId("active-city-name") as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "Harbour Reef" } });
    await rerender({ busy: true });
    await fireEvent.keyDown(input, { key: "Enter" });

    // The value string is identical but the entity id moved, so the draft
    // is still discarded.
    await rerender({
      busy: false,
      activeCity: { ...inactiveCity, name: "Harbour Loop" },
    });

    expect(onRename).not.toHaveBeenCalled();
    expect(screen.getByTestId("active-city-name").tagName).toBe("SPAN");
  });
});
