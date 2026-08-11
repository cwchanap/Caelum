import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import CityList from "../../src/components/city/CityList.svelte";
import type { CitySummary } from "../../src/persistence/citySaveStore";

const CITIES = [
  {
    id: "city-new",
    name: "Maple Junction",
    createdAt: "2026-08-10T12:00:00.000Z",
    savedAt: "2026-08-10T13:00:00.000Z",
  },
  {
    id: "city-old",
    name: "Harbour City",
    createdAt: "2026-08-09T12:00:00.000Z",
    savedAt: "2026-08-09T13:00:00.000Z",
  },
] satisfies CitySummary[];

function renderList(busy = false) {
  const onLoad = vi.fn();
  const onRename = vi.fn();
  const onDelete = vi.fn();
  render(CityList, {
    props: {
      cities: CITIES,
      activeCityId: "city-new",
      busy,
      onLoad,
      onRename,
      onDelete,
    },
  });
  return { onLoad, onRename, onDelete };
}

describe("CityList", () => {
  it("marks the active row and loads an inactive city by ID", async () => {
    const { onLoad } = renderList();
    const active = screen.getByTestId("city-row-city-new");
    const inactive = screen.getByTestId("city-row-city-old");

    expect(within(active).getByText("Active")).toBeVisible();
    expect(
      within(active).queryByRole("button", { name: "Load Maple Junction" }),
    ).toBeNull();

    await fireEvent.click(
      within(inactive).getByRole("button", { name: "Load Harbour City" }),
    );
    expect(onLoad).toHaveBeenCalledWith("city-old");
  });

  it("trims an inline rename and commits once on Enter followed by blur", async () => {
    const { onRename } = renderList();
    const input = screen.getByTestId("city-name-city-new");

    await fireEvent.input(input, { target: { value: "  Maple Central  " } });
    await fireEvent.keyDown(input, { key: "Enter" });
    await fireEvent.blur(input);

    expect(onRename).toHaveBeenCalledTimes(1);
    expect(onRename).toHaveBeenCalledWith("city-new", "Maple Central");
  });

  it("rejects a whitespace-only city name", async () => {
    const { onRename } = renderList();
    const input = screen.getByTestId("city-name-city-new");

    await fireEvent.input(input, { target: { value: "   " } });
    await fireEvent.blur(input);

    expect(onRename).not.toHaveBeenCalled();
    expect(input).toHaveValue("Maple Junction");
  });

  it("restores the canonical city name and contains Escape", async () => {
    const { onRename } = renderList();
    const input = screen.getByTestId("city-name-city-new");
    const parentEscape = vi.fn();
    window.addEventListener("keydown", parentEscape);

    await fireEvent.input(input, { target: { value: "Unsaved name" } });
    await fireEvent.keyDown(input, { key: "Escape" });

    expect(input).toHaveValue("Maple Junction");
    expect(onRename).not.toHaveBeenCalled();
    expect(parentEscape).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(input);
    window.removeEventListener("keydown", parentEscape);
  });

  it("requires two Delete clicks", async () => {
    const { onDelete } = renderList();
    const row = screen.getByTestId("city-row-city-old");
    const del = within(row).getByRole("button", { name: "Delete" });

    await fireEvent.click(del);
    expect(del).toHaveTextContent("Delete?");
    expect(onDelete).not.toHaveBeenCalled();
    await fireEvent.click(del);
    expect(onDelete).toHaveBeenCalledWith("city-old");
  });

  it("disables city mutations while persistence is busy", () => {
    renderList(true);
    expect(
      screen.getByRole("button", { name: "Load Harbour City" }),
    ).toBeDisabled();
    for (const input of screen.getAllByRole("textbox", { name: /^Rename / })) {
      expect(input).toBeDisabled();
    }
    for (const button of screen.getAllByRole("button", { name: "Delete" })) {
      expect(button).toBeDisabled();
    }
  });
});
