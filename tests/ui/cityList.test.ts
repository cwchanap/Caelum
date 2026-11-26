import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import CityList from "../../src/components/city/CityList.svelte";
import CityLibraryScreen from "../../src/components/city/CityLibraryScreen.svelte";
import type { CitySummary } from "../../src/persistence/citySaveStore";

const CITIES = [
  {
    id: "city-new",
    name: "Maple Junction",
    createdAt: "2026-08-10T12:00:00.000Z",
    templateId: "crossroads",
    savedAt: "2026-08-10T13:00:00.000Z",
  },
  {
    id: "city-old",
    name: "Harbour City",
    createdAt: "2026-08-09T12:00:00.000Z",
    templateId: "blankGrid",
    savedAt: "2026-08-09T13:00:00.000Z",
  },
] satisfies CitySummary[];

function renderList(busy = false, dirty = false, activeNameReadOnly = false) {
  const onLoad = vi.fn();
  const onRename = vi.fn(async () => true);
  const onDelete = vi.fn();
  render(CityList, {
    props: {
      cities: CITIES,
      activeCityId: "city-new",
      busy,
      dirty,
      activeNameReadOnly,
      onLoad,
      onRename,
      onDelete,
    },
  });
  return { onLoad, onRename, onDelete };
}

/** Activate a row's pencil-activated name editor and return its input. */
async function openRowEditor(cityId: string, name: string) {
  await fireEvent.click(
    screen.getByRole("button", { name: `Rename ${name}` }),
  );
  return screen.getByTestId(`city-name-${cityId}`) as HTMLInputElement;
}

describe("CityList", () => {
  it("marks the active row and loads an inactive city by ID", async () => {
    const { onLoad } = renderList();
    const active = screen.getByTestId("city-row-city-new");
    const inactive = screen.getByTestId("city-row-city-old");

    expect(within(active).getByText("Active")).toBeVisible();
    expect(within(active).getByText("Crossroads")).toBeVisible();
    expect(within(inactive).getByText("Blank Grid")).toBeVisible();
    expect(
      within(active).queryByRole("button", { name: "Load Maple Junction" }),
    ).toBeNull();

    await fireEvent.click(
      within(inactive).getByRole("button", { name: "Load Harbour City" }),
    );
    await waitFor(() => expect(onLoad).toHaveBeenCalledWith("city-old"));
  });

  it("shows the city name as row text with a pencil, not an always-open input", () => {
    renderList();
    const row = screen.getByTestId("city-row-city-old");

    // The name is visible text; the editor opens only through the pencil.
    expect(within(row).getByTestId("city-name-city-old")).toHaveTextContent(
      "Harbour City",
    );
    expect(
      within(row).getByRole("button", { name: "Rename Harbour City" }),
    ).toBeVisible();
    expect(within(row).queryByRole("textbox")).toBeNull();
  });

  it("renders a colored initial avatar in every row", () => {
    renderList();
    const avatarNew = within(
      screen.getByTestId("city-row-city-new"),
    ).getByTestId("city-avatar");
    const avatarOld = within(
      screen.getByTestId("city-row-city-old"),
    ).getByTestId("city-avatar");

    expect(avatarNew).toHaveTextContent(/^M$/);
    expect(avatarOld).toHaveTextContent(/^H$/);
    // The color is derived from the stable city id as an inline style.
    expect(avatarNew.style.backgroundColor).not.toBe("");
    expect(avatarOld.style.backgroundColor).not.toBe("");
  });

  it("preserves surrogate-pair initials in the city avatar", () => {
    render(CityList, {
      props: {
        cities: [{ ...CITIES[0], name: " 𐐷 Town" }],
        activeCityId: null,
        busy: false,
        onLoad: vi.fn(),
        onRename: vi.fn(async () => true),
        onDelete: vi.fn(),
      },
    });
    expect(screen.getByTestId("city-avatar").textContent).toBe("𐐷");
  });

  it("derives the avatar color from city.id, not the editable name", () => {
    const baseProps = {
      activeCityId: "city-new",
      busy: false,
      onLoad: vi.fn(),
      onRename: vi.fn(async () => true),
      onDelete: vi.fn(),
    };
    const first = render(CityList, { props: { cities: CITIES, ...baseProps } });
    const avatarNew = within(
      screen.getByTestId("city-row-city-new"),
    ).getByTestId("city-avatar");
    const avatarOld = within(
      screen.getByTestId("city-row-city-old"),
    ).getByTestId("city-avatar");
    const colorNew = avatarNew.style.backgroundColor;
    expect(colorNew).not.toBe("");
    expect(avatarOld.style.backgroundColor).not.toBe(colorNew);
    first.unmount();

    // A different name on the same id keeps the id-derived color while the
    // initial follows the new name.
    render(CityList, {
      props: {
        cities: [{ ...CITIES[0], name: "Zephyr Junction" }, CITIES[1]],
        ...baseProps,
      },
    });
    const renamed = within(screen.getByTestId("city-row-city-new")).getByTestId(
      "city-avatar",
    );
    expect(renamed.style.backgroundColor).toBe(colorNew);
    expect(renamed).toHaveTextContent(/^Z$/);
  });

  it("trims an inline rename and commits once on Enter followed by blur", async () => {
    const { onRename } = renderList();
    const input = await openRowEditor("city-new", "Maple Junction");

    await fireEvent.input(input, { target: { value: "  Maple Central  " } });
    await fireEvent.keyDown(input, { key: "Enter" });
    await fireEvent.blur(input);

    expect(onRename).toHaveBeenCalledTimes(1);
    expect(onRename).toHaveBeenCalledWith("city-new", "Maple Central");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("rejects a whitespace-only city name", async () => {
    const { onRename } = renderList();
    const input = await openRowEditor("city-new", "Maple Junction");

    await fireEvent.input(input, { target: { value: "   " } });
    await fireEvent.blur(input);

    expect(onRename).not.toHaveBeenCalled();
    expect(screen.getByTestId("city-name-city-new")).toHaveTextContent(
      "Maple Junction",
    );
  });

  it("restores the canonical city name and contains Escape", async () => {
    const { onRename } = renderList();
    const input = await openRowEditor("city-new", "Maple Junction");
    const parentEscape = vi.fn();
    window.addEventListener("keydown", parentEscape);

    await fireEvent.input(input, { target: { value: "Unsaved name" } });
    await fireEvent.keyDown(input, { key: "Escape" });

    expect(onRename).not.toHaveBeenCalled();
    expect(parentEscape).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByTestId("city-name-city-new")).toHaveTextContent(
      "Maple Junction",
    );
    window.removeEventListener("keydown", parentEscape);
  });

  it("commits a pending rename before loading the city", async () => {
    const { onLoad, onRename } = renderList();
    const input = await openRowEditor("city-old", "Harbour City");

    await fireEvent.input(input, { target: { value: "Harbour Reef" } });
    // mousedown.preventDefault keeps the press from blur-committing the
    // draft, so the click itself must flush it before firing onLoad.
    await fireEvent.click(
      screen.getByRole("button", { name: "Load Harbour City" }),
    );

    expect(onRename).toHaveBeenCalledWith("city-old", "Harbour Reef");
    await waitFor(() => expect(onLoad).toHaveBeenCalledWith("city-old"));
  });

  it("keeps the draft and skips the load when the rename is refused", async () => {
    const onLoad = vi.fn();
    const onRename = vi.fn(async () => false);
    render(CityList, {
      props: {
        cities: CITIES,
        activeCityId: "city-new",
        busy: false,
        onLoad,
        onRename,
        onDelete: vi.fn(),
      },
    });
    const input = await openRowEditor("city-old", "Harbour City");

    await fireEvent.input(input, { target: { value: "Harbour Reef" } });
    await fireEvent.click(
      screen.getByRole("button", { name: "Load Harbour City" }),
    );

    // The refused rename re-opens the draft so a retry can commit it; the
    // load must not discard it by replacing the library.
    await waitFor(() =>
      expect(
        screen.getByRole("textbox", { name: "Rename Harbour City" }),
      ).toHaveValue("Harbour Reef"),
    );
    expect(onRename).toHaveBeenCalledWith("city-old", "Harbour Reef");
    expect(onLoad).not.toHaveBeenCalled();
  });

  it("re-opens the draft when a blur-committed rename is refused", async () => {
    const onRename = vi.fn(async () => false);
    render(CityList, {
      props: {
        cities: CITIES,
        activeCityId: "city-new",
        busy: false,
        onLoad: vi.fn(),
        onRename,
        onDelete: vi.fn(),
      },
    });
    const input = await openRowEditor("city-old", "Harbour City");

    await fireEvent.input(input, { target: { value: "Harbour Reef" } });
    await fireEvent.blur(input);

    expect(onRename).toHaveBeenCalledWith("city-old", "Harbour Reef");
    await waitFor(() =>
      expect(
        screen.getByRole("textbox", { name: "Rename Harbour City" }),
      ).toHaveValue("Harbour Reef"),
    );
  });

  it("requires two Delete clicks", async () => {
    const { onDelete } = renderList();
    const row = screen.getByTestId("city-row-city-old");
    const del = within(row).getByRole("button", { name: "Delete Harbour City" });

    await fireEvent.click(del);
    expect(del).toHaveTextContent("Delete?");
    // Arming also moves the accessible name so the confirm press is
    // announced instead of reading as a plain "Delete" button.
    expect(del).toHaveAccessibleName("Confirm delete Harbour City");
    expect(onDelete).not.toHaveBeenCalled();
    await fireEvent.click(
      within(row).getByRole("button", { name: "Confirm delete Harbour City" }),
    );
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith("city-old"));
  });

  it("disambiguates duplicate city names with the saved timestamp", () => {
    const riversideA = { ...CITIES[0], id: "river-a", name: "Riverside" };
    const riversideB = {
      ...CITIES[1],
      id: "river-b",
      name: "Riverside",
      savedAt: "2026-08-11T09:30:00.000Z",
    };
    render(CityList, {
      props: {
        cities: [riversideA, riversideB],
        activeCityId: null,
        busy: false,
        onLoad: vi.fn(),
        onRename: vi.fn(async () => true),
        onDelete: vi.fn(),
      },
    });

    // Same-named cities must not share control names; the saved timestamp
    // keeps each Rename/Load/Delete unique while the visible labels stay put.
    const names = [
      ...screen.getAllByRole("button", { name: /^Rename / }),
      ...screen.getAllByRole("button", { name: /^Load / }),
      ...screen.getAllByRole("button", { name: /^Delete / }),
    ].map((button) => button.getAttribute("aria-label"));
    for (const name of names) expect(name).toContain("saved");
    expect(new Set(names).size).toBe(names.length);
    expect(
      screen.getAllByRole("button", { name: /^Load Riverside saved / }),
    ).toHaveLength(2);
    expect(
      screen.getAllByRole("button", { name: /^Delete Riverside saved / }),
    ).toHaveLength(2);
  });

  it("keeps control names unique for same-minute duplicate saves", () => {
    // Two saves in the same formatted minute share the timestamp label, so
    // a per-row ordinal must still disambiguate every control — and a city
    // literally named like a generated label reserves that label, pushing
    // the duplicates to the next free suffixes.
    const stamp = new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(CITIES[0].savedAt));
    const riversideA = { ...CITIES[0], id: "river-a", name: "Riverside" };
    const riversideB = { ...CITIES[1], id: "river-b", name: "Riverside" };
    riversideB.savedAt = riversideA.savedAt;
    const literalCollision = {
      ...CITIES[0],
      id: "river-c",
      name: `Riverside saved ${stamp} (1)`,
    };
    render(CityList, {
      props: {
        cities: [riversideA, riversideB, literalCollision],
        activeCityId: null,
        busy: false,
        onLoad: vi.fn(),
        onRename: vi.fn(async () => true),
        onDelete: vi.fn(),
      },
    });

    // The literal row keeps its own name as context; the generated
    // "...(1)" label belongs to it, so the dups move to (2) and (3).
    expect(
      screen.getByRole("button", {
        name: `Load Riverside saved ${stamp} (1)`,
      }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", {
        name: `Load Riverside saved ${stamp} (2)`,
      }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", {
        name: `Load Riverside saved ${stamp} (3)`,
      }),
    ).toBeVisible();

    const names = [
      ...screen.getAllByRole("button", { name: /^Rename / }),
      ...screen.getAllByRole("button", { name: /^Load / }),
      ...screen.getAllByRole("button", { name: /^Delete / }),
    ].map((button) => button.getAttribute("aria-label"));
    expect(names).toHaveLength(9);
    expect(new Set(names).size).toBe(names.length);
  });

  it("disables city mutations while persistence is busy", () => {
    renderList(true);
    expect(
      screen.getByRole("button", { name: "Load Harbour City" }),
    ).toBeDisabled();
    for (const pencil of screen.getAllByRole("button", { name: /^Rename / })) {
      expect(pencil).toBeDisabled();
    }
    for (const button of screen.getAllByRole("button", { name: /^Delete / })) {
      expect(button).toBeDisabled();
    }
  });

  it("disables Load while the active city has unsaved changes", () => {
    renderList(false, true);
    expect(
      screen.getByRole("button", { name: "Load Harbour City" }),
    ).toBeDisabled();
  });

  describe("with activeNameReadOnly (the City dock)", () => {
    it("keeps the active row name read-only and labels it Playing", () => {
      renderList(false, false, true);

      const activeRow = screen.getByTestId("city-row-city-new");
      const rowName = within(activeRow).getByTestId("city-name-city-new");
      expect(rowName).toHaveTextContent("Maple Junction");
      expect(within(activeRow).queryByRole("textbox")).toBeNull();
      expect(
        within(activeRow).queryByRole("button", {
          name: "Rename Maple Junction",
        }),
      ).toBeNull();
      expect(within(activeRow).getByText("Playing")).toBeVisible();
      expect(within(activeRow).queryByText("Active")).toBeNull();

      // Inactive rows keep the pencil-activated editor, Load and Delete.
      const inactiveRow = screen.getByTestId("city-row-city-old");
      expect(
        within(inactiveRow).getByRole("button", {
          name: "Rename Harbour City",
        }),
      ).toBeVisible();
      expect(
        within(inactiveRow).getByRole("button", { name: "Load Harbour City" }),
      ).toBeVisible();
    });

    it("retains two-click Delete on the read-only active row", async () => {
      const { onDelete } = renderList(false, false, true);

      const del = within(screen.getByTestId("city-row-city-new")).getByRole(
        "button",
        { name: "Delete Maple Junction" },
      );
      await fireEvent.click(del);
      expect(del).toHaveTextContent("Delete?");
      expect(onDelete).not.toHaveBeenCalled();
      await fireEvent.click(del);
      expect(onDelete).toHaveBeenCalledWith("city-new");
    });

    it("keeps the read-only name and Delete available while busy only disables Delete", () => {
      renderList(true, false, true);

      const activeRow = screen.getByTestId("city-row-city-new");
      // The read-only name is plain text, not a disabled control.
      expect(
        within(activeRow).getByTestId("city-name-city-new"),
      ).toHaveTextContent("Maple Junction");
      expect(
        within(activeRow).getByRole("button", {
          name: "Delete Maple Junction",
        }),
      ).toBeDisabled();
    });
  });
});

describe("CityLibraryScreen", () => {
  function renderLibrary(
    onRename: (id: string, name: string) => Promise<boolean>,
  ) {
    const onContinue = vi.fn();
    const onNewCity = vi.fn();
    render(CityLibraryScreen, {
      props: {
        cities: CITIES,
        activeCityId: null,
        busy: false,
        error: null,
        onContinue,
        onLoad: vi.fn(),
        onRename,
        onDelete: vi.fn(),
        onNewCity,
      },
    });
    return { onContinue, onNewCity };
  }

  it("renders the Continue card with name and saved time, plus Your cities count", () => {
    renderLibrary(vi.fn(async () => true));

    const continueButton = screen.getByRole("button", {
      name: /^Continue Maple Junction/,
    });
    expect(continueButton).toBeVisible();
    expect(
      continueButton.querySelector("time[datetime]"),
    ).toHaveAttribute("datetime", CITIES[0].savedAt);
    expect(screen.getByText("Your cities")).toBeVisible();
    expect(screen.getByText("Your cities")).toHaveTextContent("2");
    expect(
      screen.getByRole("button", { name: /^New City/ }),
    ).toBeVisible();
  });

  it("commits a pending row rename before continuing", async () => {
    const onRename = vi.fn(async () => true);
    const { onContinue } = renderLibrary(onRename);
    const input = await openRowEditor("city-new", "Maple Junction");

    await fireEvent.input(input, { target: { value: "Maple Central" } });
    // Continue uses the same prevented mousedown as a row Load, so the click
    // itself flushes the draft before the continue swaps out the library.
    await fireEvent.click(
      screen.getByRole("button", { name: /^Continue Maple Junction/ }),
    );

    expect(onRename).toHaveBeenCalledWith("city-new", "Maple Central");
    await waitFor(() => expect(onContinue).toHaveBeenCalledWith("city-new"));
  });

  it("waits for an in-flight row rename before continuing", async () => {
    let resolveRename!: (ok: boolean) => void;
    const onRename = vi.fn(
      () => new Promise<boolean>((done) => (resolveRename = done)),
    );
    const { onContinue } = renderLibrary(onRename);
    const input = await openRowEditor("city-old", "Harbour City");

    await fireEvent.input(input, { target: { value: "Harbour Reef" } });
    await fireEvent.click(
      screen.getByRole("button", { name: /^Continue Maple Junction/ }),
    );
    expect(onContinue).not.toHaveBeenCalled();

    resolveRename(true);
    await waitFor(() => expect(onContinue).toHaveBeenCalledWith("city-new"));
  });

  it("keeps the draft and skips New City when the rename is refused", async () => {
    const onRename = vi.fn(async () => false);
    const { onNewCity } = renderLibrary(onRename);
    const input = await openRowEditor("city-old", "Harbour City");

    await fireEvent.input(input, { target: { value: "Harbour Reef" } });
    await fireEvent.click(screen.getByRole("button", { name: /^New City/ }));

    await waitFor(() =>
      expect(
        screen.getByRole("textbox", { name: "Rename Harbour City" }),
      ).toHaveValue("Harbour Reef"),
    );
    expect(onNewCity).not.toHaveBeenCalled();
  });

  it("retains loaded city controls for a non-list operation error", () => {
    const { container } = render(CityLibraryScreen, {
      props: {
        cities: CITIES,
        activeCityId: "city-new",
        busy: false,
        error: "Could not rename city.",
        onContinue: vi.fn(),
        onLoad: vi.fn(),
        onRename: vi.fn(async () => true),
        onDelete: vi.fn(),
        onNewCity: vi.fn(),
      },
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Could not rename city.",
    );
    expect(
      screen.getByRole("button", { name: /^Continue Maple Junction/ }),
    ).toBeVisible();
    // Live brand wordmark and the shipped brand icon on the key-art card.
    expect(screen.getByText("Caelum", { exact: true })).toBeVisible();
    expect(container.querySelector("img[src*='app-icon']")).not.toBeNull();
    expect(screen.getAllByTestId("city-avatar")).toHaveLength(2);
    expect(
      screen.getByRole("button", { name: "Load Harbour City" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Rename Maple Junction" }),
    ).toBeVisible();
    expect(
      screen.getAllByRole("button", { name: /^Delete / }),
    ).toHaveLength(2);
    expect(screen.getByRole("button", { name: /^New City/ })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Retry city list" }),
    ).toBeNull();
  });
});
