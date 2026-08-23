import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/svelte";
import { flushSync, tick } from "svelte";
import { describe, expect, it, vi } from "vitest";
import App from "../../src/App.svelte";
import {
  addTestBusRoute,
  addTestBusStop,
  addTestMetroLine,
  addTestMetroStation,
  assignTestVehicle,
  createTestGameState,
} from "../helpers/gameState";
import { pointsOnRow, withRoads, withTracks } from "../helpers/mapFixtures";
import { createDraft } from "../../src/ui/routeDraft";
import { createUiState } from "../../src/ui/uiState";
import { selectShellState } from "../../src/runtime/runtimeSelectors";
import type { GameplayRejection } from "../../src/domain/types";
import type {
  RuntimeController,
  RuntimeSnapshot,
} from "../../src/runtime/types";
import type { CitySummary } from "../../src/persistence/citySaveStore";

function createRuntimeHarness(
  options: {
    state?: ReturnType<typeof createTestGameState>;
    ui?: ReturnType<typeof createUiState>;
    rejection?: GameplayRejection | null;
    persistence?: Partial<RuntimeSnapshot["persistence"]>;
    cities?: CitySummary[];
  } = {},
): {
  runtime: RuntimeController;
  getSnapshot: () => RuntimeSnapshot;
  setPersistence: (
    next: Partial<RuntimeSnapshot["persistence"]>,
  ) => RuntimeSnapshot;
} {
  const state = options.state ?? createTestGameState();
  let ui = options.ui ?? createUiState();
  let rejection = options.rejection ?? null;
  const listeners = new Set<(snapshot: RuntimeSnapshot) => void>();
  let persistence: RuntimeSnapshot["persistence"] = {
    activeCity: {
      id: "city-1",
      name: "Harbour City",
      createdAt: "2026-01-01T00:00:00.000Z",
      savedAt: "2026-01-01T00:00:00.000Z",
    },
    busy: false,
    dirty: false,
    error: null,
    ...options.persistence,
  };
  const fallbackCity: CitySummary = {
    id: "city-fallback",
    name: "Fallback City",
    createdAt: "2026-01-01T00:00:00.000Z",
    savedAt: "2026-01-01T00:00:00.000Z",
  };
  const defaultCities =
    options.cities ??
    (persistence.activeCity === null ? [] : [persistence.activeCity]);
  const defaultSummary =
    persistence.activeCity ?? defaultCities[0] ?? fallbackCity;
  const snapshot = (): RuntimeSnapshot => ({
    state,
    ui,
    shell: selectShellState(state, ui, rejection),
    persistence,
    backendError: null,
    rejection,
    sandboxResetError: null,
  });
  const publish = (): RuntimeSnapshot =>
    flushSync(() => {
      const next = snapshot();
      for (const listener of listeners) listener(next);
      return next;
    });
  const runtime = {
    persistence: {
      listCities: vi.fn(async () => ({
        ok: true as const,
        value: defaultCities,
      })),
      save: vi.fn(async () => ({
        ok: true as const,
        value: defaultSummary,
      })),
      load: vi.fn(async () => ({
        ok: true as const,
        value: defaultSummary,
      })),
      createCity: vi.fn(async (request) => ({
        ok: true as const,
        value: { ...defaultSummary, name: request.name },
      })),
      renameCity: vi.fn(async (cityId, name) => ({
        ok: true as const,
        value: {
          ...(defaultCities.find((city) => city.id === cityId) ??
            defaultSummary),
          name,
        },
      })),
      deleteCity: vi.fn(async () => ({
        ok: true as const,
        value: undefined,
      })),
    },
    getSnapshot: snapshot,
    subscribe: vi.fn((listener: (next: RuntimeSnapshot) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    start: vi.fn(),
    stop: vi.fn(),
    dispose: vi.fn(),
    isRunning: vi.fn(() => false),
    setCommandDestination: vi.fn((destination) => {
      ui = {
        ...ui,
        activeCommandDestination:
          destination === ui.activeCommandDestination ? null : destination,
        activeBuildGroup:
          destination === "build" && destination !== ui.activeCommandDestination
            ? ui.activeBuildGroup
            : null,
      };
      return publish();
    }),
    setBuildGroup: vi.fn((group) => {
      ui = { ...ui, activeBuildGroup: group };
      return publish();
    }),
    setTool: vi.fn((tool) => {
      ui = {
        ...ui,
        activeTool: tool,
        activeCommandDestination:
          tool === "busRoute" || tool === "metroLine" ? "lines" : null,
        routeDraft:
          tool === "busRoute" || tool === "metroLine"
            ? createDraft(tool === "busRoute" ? "bus" : "metro", 1)
            : null,
      };
      return publish();
    }),
    setArea: vi.fn(() => publish()),
    setBuilding: vi.fn(() => publish()),
    setRoadPreset: vi.fn(() => publish()),
    armRoad: vi.fn(() => publish()),
    armRoundabout: vi.fn(() => publish()),
    rotateBuilding: vi.fn(() => publish()),
    setOverlay: vi.fn((overlay) => {
      ui = { ...ui, activeOverlay: overlay };
      return publish();
    }),
    handleEscape: vi.fn(() => {
      ui = {
        ...ui,
        activeCommandDestination:
          ui.routeDraft === null ? null : ui.activeCommandDestination,
      };
      return publish();
    }),
    togglePause: vi.fn(() => publish()),
    setSpeed: vi.fn(() => publish()),
    assignRouteToPlatform: vi.fn(() => publish()),
    selectRouteWaypoint: vi.fn(() => publish()),
    removeRouteWaypoint: vi.fn(() => publish()),
    undoRouteDraft: vi.fn(() => publish()),
    redoRouteDraft: vi.fn(() => publish()),
    moveRouteWaypoint: vi.fn(() => publish()),
    reverseRouteDraft: vi.fn(() => publish()),
    setRoutePattern: vi.fn(() => publish()),
    saveRouteDraft: vi.fn(async () => publish()),
    cancelRouteDraft: vi.fn(() => {
      ui = {
        ...ui,
        activeTool: "inspect",
        activeCommandDestination: "lines",
        routeDraft: null,
      };
      return publish();
    }),
    reloadRouteDraft: vi.fn(() => publish()),
    startRouteEdit: vi.fn(() => publish()),
    renameRoute: vi.fn(async () => publish()),
    recolorRoute: vi.fn(async () => publish()),
    setServiceTargetHeadway: vi.fn(async () => publish()),
    deployInitialFleet: vi.fn(async () => publish()),
    addServiceVehicle: vi.fn(async () => publish()),
    toggleRouteActive: vi.fn(async () => publish()),
    deleteRoute: vi.fn(async () => publish()),
    selectRoute: vi.fn(() => publish()),
    focusRouteFailure: vi.fn(() => publish()),
    setHoverTile: vi.fn(() => publish()),
    previewRoadMutation: vi.fn(() => publish()),
    dismissRejection: vi.fn(() => {
      rejection = null;
      return publish();
    }),
    tick: vi.fn(async () => publish()),
    reset: vi.fn(async () => publish()),
    resetUi: vi.fn(() => publish()),
    startDrag: vi.fn(() => publish()),
    setDragCurrent: vi.fn(() => publish()),
    commitDrag: vi.fn(async () => publish()),
    cancelDrag: vi.fn(() => publish()),
    handleTileClick: vi.fn(async () => publish()),
    mountCanvas: vi.fn(() => () => {}),
  } satisfies RuntimeController;
  return {
    runtime,
    getSnapshot: snapshot,
    setPersistence(next: Partial<RuntimeSnapshot["persistence"]>) {
      persistence = { ...persistence, ...next };
      return publish();
    },
  };
}

const CITY_NEW: CitySummary = {
  id: "city-new",
  name: "Maple Junction",
  createdAt: "2026-08-10T12:00:00.000Z",
  savedAt: "2026-08-10T13:00:00.000Z",
};

const CITY_OLD: CitySummary = {
  id: "city-old",
  name: "Harbour City",
  createdAt: "2026-08-09T12:00:00.000Z",
  savedAt: "2026-08-09T13:00:00.000Z",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("App command shell", () => {
  it("shows New City instead of game chrome when no city is active", async () => {
    const { runtime } = createRuntimeHarness({
      persistence: { activeCity: null },
    });

    render(App, { props: { runtime } });

    expect(await screen.findByTestId("new-city-screen")).toBeVisible();
    expect(screen.queryByTestId("game-canvas-host")).toBeNull();
    expect(screen.queryByTestId("command-shelf")).toBeNull();
    expect(screen.queryByTestId("topbar")).toBeNull();
  });

  it("submits only trimmed name, economy, and template", async () => {
    const { runtime } = createRuntimeHarness({
      persistence: { activeCity: null },
    });
    render(App, { props: { runtime } });

    const create = await screen.findByRole("button", { name: "Create City" });
    expect(create).toBeDisabled();

    const templateSelect = screen.getByLabelText("Template");
    expect(
      within(templateSelect)
        .getAllByRole("option")
        .map((option) => (option as HTMLOptionElement).value),
    ).toEqual(["crossroads", "blankGrid", "smallTown"]);

    await fireEvent.input(screen.getByLabelText("City name"), {
      target: { value: "  Maple Junction  " },
    });
    await fireEvent.change(screen.getByLabelText("Economy"), {
      target: { value: "creative" },
    });
    await fireEvent.change(templateSelect, {
      target: { value: "smallTown" },
    });
    await fireEvent.click(create);

    expect(runtime.persistence.createCity).toHaveBeenCalledWith({
      name: "Maple Junction",
      economyPreset: "creative",
      templateId: "smallTown",
    });
  });

  it("disables repeat New City submission while persistence is busy", async () => {
    const harness = createRuntimeHarness({
      persistence: { activeCity: null },
    });
    render(App, { props: { runtime: harness.runtime } });

    await fireEvent.input(await screen.findByLabelText("City name"), {
      target: { value: "Busy City" },
    });
    harness.setPersistence({ busy: true });

    expect(screen.getByRole("button", { name: "Creating…" })).toBeDisabled();
  });

  it("shows runtime-mapped persistence copy without diagnostics", async () => {
    const harness = createRuntimeHarness({
      persistence: { activeCity: null },
    });
    harness.runtime.persistence.createCity = vi.fn(async () => {
      const error = {
        kind: "store" as const,
        error: {
          operation: "createCity" as const,
          code: "failed" as const,
          diagnostic: "QuotaExceededError: private browser detail",
        },
      };
      harness.setPersistence({ error, busy: false });
      return { ok: false as const, error };
    });

    render(App, { props: { runtime: harness.runtime } });

    await fireEvent.input(await screen.findByLabelText("City name"), {
      target: { value: "Fail City" },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Create City" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not save the new city.",
    );
    expect(screen.getByRole("alert")).not.toHaveTextContent(
      "QuotaExceededError",
    );
  });

  it("returns to the normal game shell after a city becomes active", async () => {
    const harness = createRuntimeHarness({
      persistence: { activeCity: null },
    });
    render(App, { props: { runtime: harness.runtime } });

    await screen.findByTestId("new-city-screen");
    harness.setPersistence({
      activeCity: {
        id: "city-new",
        name: "Maple Junction",
        createdAt: "2026-08-10T17:00:00.000Z",
        savedAt: "2026-08-10T17:00:00.000Z",
      },
      busy: false,
      dirty: false,
      error: null,
    });

    expect(screen.queryByTestId("new-city-screen")).toBeNull();
    expect(screen.getByTestId("game-canvas-host")).toBeVisible();
    expect(screen.getByTestId("command-shelf")).toBeVisible();
  });

  it("shows City Library when saved cities exist but no city is active", async () => {
    const { runtime } = createRuntimeHarness({
      persistence: { activeCity: null },
      cities: [CITY_NEW, CITY_OLD],
    });

    render(App, { props: { runtime } });

    expect(await screen.findByTestId("city-library-screen")).toBeVisible();
    expect(screen.getByTestId("city-row-city-new")).toBeVisible();
    expect(screen.getByTestId("city-row-city-old")).toBeVisible();
  });

  it("Continues the first already-sorted city", async () => {
    const harness = createRuntimeHarness({
      persistence: { activeCity: null },
      cities: [CITY_NEW, CITY_OLD],
    });

    render(App, { props: { runtime: harness.runtime } });
    await fireEvent.click(
      await screen.findByRole("button", { name: "Continue" }),
    );

    expect(harness.runtime.persistence.load).toHaveBeenCalledWith("city-new");
  });

  it("shows dirty state and invokes Save Now", async () => {
    const harness = createRuntimeHarness({
      persistence: { activeCity: CITY_NEW, dirty: true },
      cities: [CITY_NEW, CITY_OLD],
    });

    render(App, { props: { runtime: harness.runtime } });
    await fireEvent.click(screen.getByTestId("command-destination-city"));

    expect(screen.getByTestId("city-save-status")).toHaveAttribute(
      "data-dirty",
      "true",
    );
    await fireEvent.click(screen.getByRole("button", { name: "Save Now" }));
    expect(harness.runtime.persistence.save).toHaveBeenCalledTimes(1);
  });

  it("opens and cancels New City from the active City panel", async () => {
    const harness = createRuntimeHarness({
      persistence: { activeCity: CITY_NEW },
      cities: [CITY_NEW, CITY_OLD],
    });
    render(App, { props: { runtime: harness.runtime } });

    await fireEvent.click(screen.getByTestId("command-destination-city"));
    await fireEvent.click(screen.getByRole("button", { name: "New City" }));
    expect(screen.getByTestId("new-city-screen")).toBeVisible();
    await fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByTestId("game-canvas-host")).toBeVisible();
  });

  it("aborts Create when the active city becomes dirty while the form is open", async () => {
    const harness = createRuntimeHarness({
      persistence: { activeCity: CITY_NEW, dirty: false },
      cities: [CITY_NEW, CITY_OLD],
    });
    render(App, { props: { runtime: harness.runtime } });

    await fireEvent.click(screen.getByTestId("command-destination-city"));
    await fireEvent.click(screen.getByRole("button", { name: "New City" }));
    expect(screen.getByTestId("new-city-screen")).toBeVisible();

    // A tick marks the active city dirty while the form is open. The Create
    // button is busy/name-gated, not dirty-gated, so it stays clickable.
    harness.setPersistence({ dirty: true });

    await fireEvent.input(await screen.findByLabelText("City name"), {
      target: { value: "Riverside" },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Create City" }));

    expect(harness.runtime.persistence.createCity).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Pause and Save before creating a new city.",
    );
    // The form stays open so the user can Save or cancel.
    expect(screen.getByTestId("new-city-screen")).toBeVisible();
  });

  it("renames and deletes an inactive city from the active City panel", async () => {
    const harness = createRuntimeHarness({
      persistence: { activeCity: CITY_NEW },
      cities: [CITY_NEW, CITY_OLD],
    });
    render(App, { props: { runtime: harness.runtime } });

    await fireEvent.click(screen.getByTestId("command-destination-city"));
    const row = await screen.findByTestId("city-row-city-old");
    const input = within(row).getByTestId("city-name-city-old");
    await fireEvent.input(input, { target: { value: "  Old Harbour  " } });
    await fireEvent.keyDown(input, { key: "Enter" });
    expect(harness.runtime.persistence.renameCity).toHaveBeenCalledWith(
      "city-old",
      "Old Harbour",
    );

    const del = within(row).getByRole("button", { name: "Delete" });
    await fireEvent.click(del);
    await fireEvent.click(del);
    expect(harness.runtime.persistence.deleteCity).toHaveBeenCalledWith(
      "city-old",
    );
  });

  it("does not show a deleted active city while refreshing the remaining library", async () => {
    const harness = createRuntimeHarness({
      persistence: { activeCity: CITY_NEW },
      cities: [CITY_NEW, CITY_OLD],
    });
    const refreshed = deferred<{ ok: true; value: CitySummary[] }>();
    harness.runtime.persistence.listCities = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true as const,
        value: [CITY_NEW, CITY_OLD],
      })
      .mockImplementationOnce(() => refreshed.promise);

    render(App, { props: { runtime: harness.runtime } });
    await fireEvent.click(screen.getByTestId("command-destination-city"));
    const row = await screen.findByTestId("city-row-city-new");
    const del = within(row).getByRole("button", { name: "Delete" });
    await fireEvent.click(del);
    await fireEvent.click(del);

    harness.setPersistence({ activeCity: null, busy: false, dirty: false });
    expect(await screen.findByTestId("city-library-screen")).toBeVisible();
    expect(screen.queryByTestId("city-row-city-new")).toBeNull();
    expect(screen.getByText("Loading cities…")).toBeVisible();

    refreshed.resolve({ ok: true, value: [CITY_OLD] });
    expect(await screen.findByTestId("city-row-city-old")).toBeVisible();
  });

  it("invalidates an older list read before active-delete refresh publishes", async () => {
    const harness = createRuntimeHarness({
      persistence: { activeCity: CITY_NEW },
      cities: [CITY_NEW, CITY_OLD],
    });
    const older = deferred<{ ok: true; value: CitySummary[] }>();
    const postDelete = deferred<{ ok: true; value: CitySummary[] }>();
    const deleteComplete = deferred<{ ok: true; value: undefined }>();
    harness.runtime.persistence.listCities = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true as const,
        value: [CITY_NEW, CITY_OLD],
      })
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => postDelete.promise);
    harness.runtime.persistence.deleteCity = vi.fn(
      () => deleteComplete.promise,
    );

    render(App, { props: { runtime: harness.runtime } });
    await fireEvent.click(screen.getByTestId("command-destination-city"));
    const row = await screen.findByTestId("city-row-city-new");

    await fireEvent.click(screen.getByRole("button", { name: "Save Now" }));
    await waitFor(() =>
      expect(harness.runtime.persistence.listCities).toHaveBeenCalledTimes(2),
    );

    const del = within(row).getByRole("button", { name: "Delete" });
    await fireEvent.click(del);
    await fireEvent.click(del);
    expect(harness.runtime.persistence.deleteCity).toHaveBeenCalledWith(
      "city-new",
    );

    older.resolve({ ok: true, value: [CITY_NEW, CITY_OLD] });
    await tick();
    harness.setPersistence({ activeCity: null, busy: false, dirty: false });
    expect(await screen.findByTestId("city-library-screen")).toBeVisible();
    expect(screen.queryByTestId("city-row-city-new")).toBeNull();
    expect(screen.getByText("Loading cities…")).toBeVisible();

    deleteComplete.resolve({ ok: true, value: undefined });
    await waitFor(() =>
      expect(harness.runtime.persistence.listCities).toHaveBeenCalledTimes(3),
    );
    postDelete.resolve({ ok: true, value: [CITY_OLD] });
    expect(await screen.findByTestId("city-row-city-old")).toBeVisible();
  });

  it("returns directly to New City after deleting the final active city", async () => {
    const harness = createRuntimeHarness({
      persistence: { activeCity: CITY_NEW },
      cities: [CITY_NEW],
    });
    const refreshed = deferred<{ ok: true; value: CitySummary[] }>();
    harness.runtime.persistence.listCities = vi
      .fn()
      .mockResolvedValueOnce({ ok: true as const, value: [CITY_NEW] })
      .mockImplementationOnce(() => refreshed.promise);

    render(App, { props: { runtime: harness.runtime } });
    await fireEvent.click(screen.getByTestId("command-destination-city"));
    const row = await screen.findByTestId("city-row-city-new");
    const del = within(row).getByRole("button", { name: "Delete" });
    await fireEvent.click(del);
    await fireEvent.click(del);

    harness.setPersistence({ activeCity: null, busy: false, dirty: false });
    expect(await screen.findByTestId("city-library-screen")).toBeVisible();
    expect(screen.queryByTestId("city-row-city-new")).toBeNull();

    refreshed.resolve({ ok: true, value: [] });
    expect(await screen.findByTestId("new-city-screen")).toBeVisible();
    expect(screen.queryByTestId("city-library-screen")).toBeNull();
  });

  it("disables active City actions and rows while persistence is busy", async () => {
    const harness = createRuntimeHarness({
      persistence: { activeCity: CITY_NEW },
      cities: [CITY_NEW, CITY_OLD],
    });
    render(App, { props: { runtime: harness.runtime } });

    await fireEvent.click(screen.getByTestId("command-destination-city"));
    await screen.findByTestId("city-row-city-old");
    harness.setPersistence({ busy: true });

    expect(screen.getByRole("button", { name: "Working…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "New City" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Load Harbour City" }),
    ).toBeDisabled();
    expect(screen.getByTestId("city-name-city-old")).toBeDisabled();
  });

  it("keeps the active shell and shows a mapped error after a failed Load", async () => {
    const harness = createRuntimeHarness({
      persistence: { activeCity: CITY_NEW },
      cities: [CITY_NEW, CITY_OLD],
    });
    harness.runtime.persistence.load = vi.fn(async () => {
      const error = {
        kind: "backend" as const,
        error: { code: "invalidSnapshot" as const },
      };
      harness.setPersistence({ error, busy: false });
      return { ok: false as const, error };
    });

    render(App, { props: { runtime: harness.runtime } });
    await fireEvent.click(screen.getByTestId("command-destination-city"));
    const row = await screen.findByTestId("city-row-city-old");
    await fireEvent.click(
      within(row).getByRole("button", { name: "Load Harbour City" }),
    );

    expect(screen.getByTestId("game-canvas-host")).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Could not apply the city state.",
    );
    expect(
      screen.queryByRole("button", { name: "Retry city list" }),
    ).toBeNull();
  });

  it("keeps New City reachable when the city list fails", async () => {
    const harness = createRuntimeHarness({
      persistence: { activeCity: null },
    });
    harness.runtime.persistence.listCities = vi.fn(async () => ({
      ok: false as const,
      error: {
        kind: "store" as const,
        error: {
          operation: "listCities" as const,
          code: "failed" as const,
          diagnostic: "private IndexedDB detail",
        },
      },
    }));

    render(App, { props: { runtime: harness.runtime } });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not load the city list.",
    );
    expect(screen.getByRole("alert")).not.toHaveTextContent("IndexedDB");
    expect(
      screen.getByRole("button", { name: "Retry city list" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "New City" })).toBeVisible();

    await fireEvent.click(screen.getByRole("button", { name: "New City" }));
    expect(screen.getByTestId("new-city-screen")).toBeVisible();
  });

  it("refreshes the library when Cancel follows a failed Create after list failure", async () => {
    const harness = createRuntimeHarness({
      persistence: { activeCity: null },
    });
    harness.runtime.persistence.listCities = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false as const,
        error: {
          kind: "store" as const,
          error: { operation: "listCities" as const, code: "failed" as const },
        },
      })
      .mockResolvedValueOnce({
        ok: true as const,
        value: [CITY_NEW],
      });
    harness.runtime.persistence.createCity = vi.fn(async () => {
      const error = {
        kind: "store" as const,
        error: {
          operation: "createCity" as const,
          code: "failed" as const,
        },
      };
      harness.setPersistence({ error, busy: false });
      return { ok: false as const, error };
    });

    render(App, { props: { runtime: harness.runtime } });

    await fireEvent.click(
      await screen.findByRole("button", { name: "New City" }),
    );
    await fireEvent.input(await screen.findByLabelText("City name"), {
      target: { value: "Failed City" },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Create City" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not save the new city.",
    );

    await fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByTestId("city-row-city-new")).toBeVisible();
  });

  it("does not show a stale mutation error when opening New City from the active panel", async () => {
    const harness = createRuntimeHarness({
      persistence: {
        activeCity: CITY_NEW,
        error: {
          kind: "store",
          error: { operation: "renameCity", code: "failed" },
        },
      },
      cities: [CITY_NEW, CITY_OLD],
    });

    render(App, { props: { runtime: harness.runtime } });
    await fireEvent.click(screen.getByTestId("command-destination-city"));
    // The active panel shows the stale rename error via the shared cityError.
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Could not rename the city.",
    );

    await fireEvent.click(screen.getByRole("button", { name: "New City" }));
    // The New City form uses a create-specific error state, so the stale
    // rename error must not leak into it.
    expect(screen.getByTestId("new-city-screen")).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not inject a late list error into the New City form", async () => {
    const harness = createRuntimeHarness({
      persistence: { activeCity: CITY_NEW },
      cities: [CITY_NEW, CITY_OLD],
    });
    const lateList = deferred<{
      ok: false;
      error: {
        kind: "store";
        error: { operation: "listCities"; code: "failed" };
      };
    }>();
    harness.runtime.persistence.listCities = vi
      .fn()
      .mockResolvedValueOnce({ ok: true as const, value: [CITY_NEW, CITY_OLD] })
      .mockImplementationOnce(() => lateList.promise);

    render(App, { props: { runtime: harness.runtime } });
    await fireEvent.click(screen.getByTestId("command-destination-city"));
    // Trigger a list refresh (Save Now refreshes on success), then immediately
    // open New City before the refresh resolves.
    await fireEvent.click(screen.getByRole("button", { name: "Save Now" }));
    await fireEvent.click(screen.getByRole("button", { name: "New City" }));

    expect(screen.getByTestId("new-city-screen")).toBeVisible();
    // The late list error resolves after New City opened; it must not inject
    // "Could not load the city list" into the form.
    lateList.resolve({
      ok: false,
      error: {
        kind: "store",
        error: { operation: "listCities", code: "failed" },
      },
    });
    await tick();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("ignores an older city-list response that resolves after a newer retry", async () => {
    const harness = createRuntimeHarness({
      persistence: { activeCity: null },
    });
    const older = deferred<{
      ok: true;
      value: CitySummary[];
    }>();
    const newer = deferred<{
      ok: true;
      value: CitySummary[];
    }>();

    harness.runtime.persistence.listCities = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false as const,
        error: {
          kind: "store" as const,
          error: { operation: "listCities" as const, code: "failed" as const },
        },
      })
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise);

    render(App, { props: { runtime: harness.runtime } });
    const retry = await screen.findByRole("button", {
      name: "Retry city list",
    });
    await fireEvent.click(retry);
    await fireEvent.click(retry);

    newer.resolve({ ok: true, value: [CITY_NEW] });
    expect(await screen.findByTestId("city-row-city-new")).toBeVisible();

    older.resolve({ ok: true, value: [CITY_OLD] });
    await tick();
    expect(screen.getByTestId("city-row-city-new")).toBeVisible();
    expect(screen.queryByTestId("city-row-city-old")).toBeNull();
  });

  it("disables Load and New City while the active city has unsaved changes", async () => {
    const harness = createRuntimeHarness({
      persistence: { activeCity: CITY_NEW, dirty: true },
      cities: [CITY_NEW, CITY_OLD],
    });
    render(App, { props: { runtime: harness.runtime } });

    await fireEvent.click(screen.getByTestId("command-destination-city"));
    expect(screen.getByRole("button", { name: "New City" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Load Harbour City" }),
    ).toBeDisabled();
    // Save Now stays available so the player can clear the dirty state.
    expect(screen.getByRole("button", { name: "Save Now" })).toBeEnabled();
    // The hint explains the required workflow.
    expect(screen.getByTestId("city-switch-hint")).toHaveTextContent(
      "Pause and Save before switching cities.",
    );
  });

  it("an applied tick marks the active city dirty and disables switching", async () => {
    const harness = createRuntimeHarness({
      persistence: { activeCity: CITY_NEW, dirty: false },
      cities: [CITY_NEW, CITY_OLD],
    });
    // Model the real runtime contract: an applied tick calls markDirty(),
    // so an unpaused simulation continuously marks the active city dirty.
    harness.runtime.tick = vi.fn(async () => {
      harness.setPersistence({ dirty: true });
      return harness.getSnapshot();
    });

    render(App, { props: { runtime: harness.runtime } });
    await fireEvent.click(screen.getByTestId("command-destination-city"));

    // Before any tick, switching is available and no hint is shown.
    expect(screen.getByRole("button", { name: "New City" })).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Load Harbour City" }),
    ).toBeEnabled();
    expect(screen.queryByTestId("city-switch-hint")).toBeNull();

    // An applied tick marks the city dirty, disabling switching.
    await harness.runtime.tick(0.016);
    expect(screen.getByRole("button", { name: "New City" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Load Harbour City" }),
    ).toBeDisabled();
    expect(screen.getByTestId("city-switch-hint")).toBeVisible();
  });

  it("restores the city list when Cancel returns to an active city panel", async () => {
    const harness = createRuntimeHarness({
      persistence: { activeCity: CITY_NEW },
    });
    harness.runtime.persistence.listCities = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false as const,
        error: {
          kind: "store" as const,
          error: { operation: "listCities" as const, code: "failed" as const },
        },
      })
      .mockResolvedValueOnce({
        ok: true as const,
        value: [CITY_NEW, CITY_OLD],
      });

    render(App, { props: { runtime: harness.runtime } });
    await fireEvent.click(screen.getByTestId("command-destination-city"));
    // The mount-time list read failed, so the active panel offers a Retry.
    expect(
      await screen.findByRole("button", { name: "Retry city list" }),
    ).toBeVisible();

    await fireEvent.click(screen.getByRole("button", { name: "New City" }));
    expect(screen.getByTestId("new-city-screen")).toBeVisible();
    await fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    // Cancel re-fetches the list even with an active city, restoring the rows.
    expect(await screen.findByTestId("city-row-city-old")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Retry city list" }),
    ).toBeNull();
  });

  it("a persistence mutation supersedes an in-flight city-list retry", async () => {
    const harness = createRuntimeHarness({
      persistence: { activeCity: CITY_NEW },
    });
    const retrying = deferred<{
      ok: false;
      error: {
        kind: "store";
        error: { operation: "listCities"; code: "failed" };
      };
    }>();
    harness.runtime.persistence.listCities = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false as const,
        error: {
          kind: "store" as const,
          error: { operation: "listCities" as const, code: "failed" as const },
        },
      })
      .mockImplementationOnce(() => retrying.promise);
    const saveError = {
      kind: "store" as const,
      error: { operation: "updateCity" as const, code: "failed" as const },
    };
    harness.runtime.persistence.save = vi.fn(async () => {
      harness.setPersistence({ error: saveError, busy: false });
      return { ok: false as const, error: saveError };
    });

    render(App, { props: { runtime: harness.runtime } });
    await fireEvent.click(screen.getByTestId("command-destination-city"));
    const retry = await screen.findByRole("button", {
      name: "Retry city list",
    });
    await fireEvent.click(retry);
    await fireEvent.click(screen.getByRole("button", { name: "Save Now" }));

    // The older retry fails after the save started; it must not mask the save
    // error, since the save superseded the list attempt.
    retrying.resolve({
      ok: false,
      error: {
        kind: "store",
        error: { operation: "listCities", code: "failed" },
      },
    });
    await tick();

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Could not save the city.",
    );
    expect(screen.getByRole("alert")).not.toHaveTextContent(
      "Could not load the city list.",
    );
  });

  it("starts in Select with no command panel open", () => {
    const { runtime } = createRuntimeHarness();
    render(App, { props: { runtime } });
    expect(screen.getByTestId("command-shelf")).toBeVisible();
    expect(screen.queryByTestId("command-panel")).toBeNull();
    expect(screen.queryByTestId("panel-inspect")).toBeNull();
    expect(screen.getByTestId("command-tool-select")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("shows one command panel at a time and contextual Inspect only when no destination is open", async () => {
    let state = createTestGameState();
    state = withRoads(state, [{ x: 7, y: 7 }]);
    state = addTestBusStop(state, { x: 7, y: 7 });
    const { runtime } = createRuntimeHarness({
      state,
      ui: { ...createUiState(), selectedId: "7,7" },
    });
    render(App, { props: { runtime } });
    expect(screen.getByTestId("panel-inspect")).toBeVisible();
    await fireEvent.click(screen.getByTestId("command-destination-build"));
    expect(screen.getByTestId("command-panel")).toHaveAttribute(
      "data-command-panel",
      "build",
    );
    expect(screen.queryByTestId("panel-inspect")).toBeNull();
    await fireEvent.click(screen.getByTestId("command-destination-data"));
    expect(screen.getByTestId("command-panel")).toHaveAttribute(
      "data-command-panel",
      "data",
    );
    expect(screen.queryByTestId("command-panel-build")).toBeNull();
  });

  it("returns focus to the canvas after selecting a Build leaf", async () => {
    const { runtime } = createRuntimeHarness();
    render(App, { props: { runtime } });

    await fireEvent.click(screen.getByTestId("command-destination-build"));
    await fireEvent.click(screen.getByTestId("command-plate-roads"));
    await fireEvent.click(screen.getByRole("button", { name: "2-Lane" }));
    await tick();

    expect(screen.getByTestId("game-canvas-host")).toHaveFocus();
  });

  it("returns focus to the Data shelf button after Escape closes Data", async () => {
    const { runtime } = createRuntimeHarness();
    render(App, { props: { runtime } });

    const dataButton = screen.getByTestId("command-destination-data");
    await fireEvent.click(dataButton);
    await fireEvent.keyDown(window, { key: "Escape" });
    await tick();

    expect(dataButton).toHaveFocus();
  });

  it("returns focus to the City shelf button after closing City", async () => {
    const { runtime } = createRuntimeHarness();
    render(App, { props: { runtime } });

    const cityButton = screen.getByTestId("command-destination-city");
    await fireEvent.click(cityButton);
    await fireEvent.click(screen.getByRole("button", { name: "Close City" }));
    await tick();

    expect(cityButton).toHaveFocus();
  });

  it("returns focus to the Lines list when a route draft is cancelled", async () => {
    const { runtime } = createRuntimeHarness();
    render(App, { props: { runtime } });

    await fireEvent.click(screen.getByTestId("command-destination-lines"));
    await fireEvent.click(screen.getByRole("button", { name: "New Bus" }));
    await fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await tick();

    expect(screen.getByTestId("lines-list")).toHaveFocus();
    expect(screen.getByTestId("command-destination-lines")).not.toHaveFocus();
  });

  it("renders the compact Signal Console topbar contract", () => {
    let state = createTestGameState();
    state = withRoads(state, [{ x: 7, y: 7 }]);
    state = addTestBusStop(state, { x: 7, y: 7 });
    state = addTestBusRoute(state, ["stop-001"]);
    state = withTracks(state, pointsOnRow(2, 7, 15));
    state = addTestMetroStation(state, { x: 7, y: 2 });
    state = addTestMetroStation(state, { x: 15, y: 2 });
    state = addTestMetroLine(state, ["station-001", "station-002"]);
    state = assignTestVehicle(state, "bus", "route-001");
    state = assignTestVehicle(state, "metro", "metro-001");
    state = {
      ...state,
      paused: false,
      metrics: { ...state.metrics, lateTrips: 4, unservedTrips: 2 },
      transit: {
        ...state.transit,
        routes: state.transit.routes.map((route) => ({
          ...route,
          serviceMetrics: {
            roundTripSeconds: 600,
            assignedFleet: 1,
            requiredFleet: 1,
            estimatedDeploymentCost: null,
            dailyOperatingCost: 400,
            estimatedDailyOperatingCost: null,
            nextVehicleCost: null,
            nominalHeadwaySeconds: 600,
            waitingAtRiskCount: 0,
            longestWaitSeconds: null,
          },
        })),
        metroLines: state.transit.metroLines.map((line) => ({
          ...line,
          serviceMetrics: {
            roundTripSeconds: 600,
            assignedFleet: 1,
            requiredFleet: 1,
            estimatedDeploymentCost: null,
            dailyOperatingCost: 2_500,
            estimatedDailyOperatingCost: null,
            nextVehicleCost: null,
            nominalHeadwaySeconds: 600,
            waitingAtRiskCount: 0,
            longestWaitSeconds: null,
          },
        })),
      },
    };
    const { runtime } = createRuntimeHarness({ state });
    render(App, { props: { runtime } });

    expect(screen.getByText("Money")).toBeVisible();
    expect(screen.getByText("Daily cost")).toBeVisible();
    expect(screen.getByText("$2,900")).toBeVisible();
    expect(screen.getByText("Time")).toBeVisible();
    expect(screen.getByText("Network")).toBeVisible();
    expect(screen.getByText("Population")).toBeVisible();
    expect(screen.getByText("Avg Wait")).toBeVisible();
    expect(screen.getByText("4 late · 2 unserved")).toBeVisible();
    expect(screen.getByRole("button", { name: "Pause" })).toBeVisible();
    expect(screen.getByRole("button", { name: "1x" })).toBeVisible();
    expect(screen.getByRole("button", { name: "2x" })).toBeVisible();
    expect(screen.getByRole("button", { name: "4x" })).toBeVisible();
    expect(screen.queryByText("Live")).toBeNull();
    expect(screen.queryByText("Hold")).toBeNull();
  });

  it("invokes contextual Inspect reassignment controls", async () => {
    let state = createTestGameState();
    state = withRoads(state, [{ x: 7, y: 7 }]);
    state = addTestBusStop(state, { x: 7, y: 7 }, "busTerminal");
    const stopId = state.transit.stops[0].id;
    state = addTestBusRoute(state, [stopId]);
    const { runtime } = createRuntimeHarness({
      state,
      ui: {
        ...createUiState(),
        selectedId: "7,7",
        selectedNodeKind: "stop",
      },
    });
    render(App, { props: { runtime } });

    const move = screen.getByRole("button", {
      name: "Move Bus 1 to Platform B",
    });
    await fireEvent.click(move);

    expect(runtime.assignRouteToPlatform).toHaveBeenCalledWith(
      stopId,
      "route-001",
      `${stopId}-p1`,
    );
  });

  it("sets a bus target headway and deploys a fleet from the Lines panel", async () => {
    let state = createTestGameState();
    state = withRoads(state, [{ x: 7, y: 7 }]);
    state = addTestBusStop(state, { x: 7, y: 7 }, "busTerminal");
    const stopId = state.transit.stops[0].id;
    state = addTestBusRoute(state, [stopId]);
    state = {
      ...state,
      transit: {
        ...state.transit,
        routes: state.transit.routes.map((route) => ({
          ...route,
          targetHeadwaySeconds: 360,
          serviceMetrics: {
            roundTripSeconds: 900,
            assignedFleet: 0,
            requiredFleet: 3,
            estimatedDeploymentCost: 150_000,
            dailyOperatingCost: 0,
            estimatedDailyOperatingCost: null,
            nextVehicleCost: null,
            nominalHeadwaySeconds: null,
            waitingAtRiskCount: 0,
            longestWaitSeconds: null,
          },
        })),
      },
    };
    const { runtime } = createRuntimeHarness({ state });
    render(App, { props: { runtime } });

    await fireEvent.click(screen.getByTestId("command-destination-lines"));
    const input = screen.getByTestId("route-headway-route-001");
    await fireEvent.input(input, { target: { value: "6" } });
    await fireEvent.click(screen.getByRole("button", { name: "Set" }));
    expect(runtime.setServiceTargetHeadway).toHaveBeenCalledWith(
      "route-001",
      360,
    );
    await fireEvent.click(
      screen.getByRole("button", { name: "Deploy fleet · est. $150,000" }),
    );
    expect(runtime.deployInitialFleet).toHaveBeenCalledWith("route-001");
  });

  it("adds a service vehicle from the Rust-priced Lines offer", async () => {
    let state = createTestGameState();
    state = withRoads(state, [{ x: 7, y: 7 }]);
    state = addTestBusStop(state, { x: 7, y: 7 }, "busTerminal");
    const stopId = state.transit.stops[0].id;
    state = addTestBusRoute(state, [stopId]);
    state = {
      ...state,
      transit: {
        ...state.transit,
        routes: state.transit.routes.map((route) => ({
          ...route,
          vehicleIds: ["vehicle-001", "vehicle-002"],
          targetHeadwaySeconds: 360,
          serviceMetrics: {
            roundTripSeconds: 900,
            assignedFleet: 2,
            requiredFleet: 4,
            estimatedDeploymentCost: null,
            dailyOperatingCost: 0,
            estimatedDailyOperatingCost: null,
            nextVehicleCost: 12_500,
            nominalHeadwaySeconds: 450,
            waitingAtRiskCount: 0,
            longestWaitSeconds: null,
          },
        })),
      },
    };
    const { runtime } = createRuntimeHarness({ state });
    render(App, { props: { runtime } });

    await fireEvent.click(screen.getByTestId("command-destination-lines"));
    await fireEvent.click(
      screen.getByRole("button", { name: "Add bus · $12,500" }),
    );

    expect(runtime.addServiceVehicle).toHaveBeenCalledTimes(1);
    expect(runtime.addServiceVehicle).toHaveBeenCalledWith("route-001");
  });

  it("sets a Metro target headway and deploys a fleet from the Lines panel", async () => {
    let state = createTestGameState();
    state = withTracks(state, pointsOnRow(2, 7, 15));
    state = addTestMetroStation(state, { x: 7, y: 2 });
    state = addTestMetroStation(state, { x: 15, y: 2 });
    state = addTestMetroLine(state, ["station-001", "station-002"]);
    state = {
      ...state,
      transit: {
        ...state.transit,
        metroLines: state.transit.metroLines.map((line) => ({
          ...line,
          targetHeadwaySeconds: 300,
          serviceMetrics: {
            roundTripSeconds: 900,
            assignedFleet: 0,
            requiredFleet: 2,
            estimatedDeploymentCost: 240_000,
            dailyOperatingCost: 0,
            estimatedDailyOperatingCost: null,
            nextVehicleCost: null,
            nominalHeadwaySeconds: null,
            waitingAtRiskCount: 0,
            longestWaitSeconds: null,
          },
        })),
      },
    };
    const { runtime } = createRuntimeHarness({ state });
    render(App, { props: { runtime } });

    await fireEvent.click(screen.getByTestId("command-destination-lines"));
    expect(screen.getByTestId("route-status-metro-001")).toHaveTextContent(
      "No fleet",
    );
    expect(screen.getByTestId("route-service-metro-001")).toHaveTextContent(
      "2 trains",
    );
    expect(
      screen.getByRole("button", {
        name: "Deploy fleet · est. $240,000",
      }),
    ).toBeVisible();

    const input = screen.getByTestId("route-headway-metro-001");
    await fireEvent.input(input, { target: { value: "5" } });
    await fireEvent.click(screen.getByRole("button", { name: "Set" }));
    expect(runtime.setServiceTargetHeadway).toHaveBeenCalledWith(
      "metro-001",
      300,
    );
    await fireEvent.click(
      screen.getByRole("button", {
        name: "Deploy fleet · est. $240,000",
      }),
    );
    expect(runtime.deployInitialFleet).toHaveBeenCalledWith("metro-001");
  });

  it("shows paused zero-fleet bus setup controls without enabling Deploy", async () => {
    let state = createTestGameState();
    state = withRoads(state, [{ x: 7, y: 7 }]);
    state = addTestBusStop(state, { x: 7, y: 7 }, "busTerminal");
    const stopId = state.transit.stops[0].id;
    state = addTestBusRoute(state, [stopId]);
    state = {
      ...state,
      transit: {
        ...state.transit,
        routes: state.transit.routes.map((route) => ({
          ...route,
          active: false,
          targetHeadwaySeconds: 360,
          serviceMetrics: {
            roundTripSeconds: 900,
            assignedFleet: 0,
            requiredFleet: 3,
            estimatedDeploymentCost: null,
            dailyOperatingCost: 0,
            estimatedDailyOperatingCost: null,
            nextVehicleCost: null,
            nominalHeadwaySeconds: null,
            waitingAtRiskCount: 0,
            longestWaitSeconds: null,
          },
        })),
      },
    };
    const { runtime } = createRuntimeHarness({ state });
    render(App, { props: { runtime } });

    await fireEvent.click(screen.getByTestId("command-destination-lines"));
    expect(screen.getByTestId("route-status-route-001")).toHaveTextContent(
      "Paused",
    );
    const service = screen.getByTestId("route-service-route-001");
    expect(service).toHaveTextContent("Target");
    expect(service).toHaveTextContent("Required");
    expect(screen.queryByTestId("route-deploy-route-001")).toBeNull();
  });

  it("keeps route-draft gate IDs unique and scopes shelf descriptions", () => {
    const { runtime } = createRuntimeHarness({
      ui: {
        ...createUiState(),
        activeTool: "busRoute",
        activeCommandDestination: "lines",
        routeDraft: createDraft("bus", 1),
      },
    });
    render(App, { props: { runtime } });

    const gates = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[data-testid^="route-draft-"][data-testid$="gate"]',
      ),
    );
    expect(gates.map((gate) => gate.id)).toEqual([
      "route-draft-panel-gate",
      "route-draft-shelf-gate",
    ]);
    const lines = screen.getByTestId("command-destination-lines");
    expect(lines).not.toHaveAttribute("aria-describedby");
    for (const control of screen
      .getByTestId("command-shelf")
      .querySelectorAll("button")) {
      if (control === lines) continue;
      expect(control).toHaveAttribute(
        "aria-describedby",
        "route-draft-shelf-gate",
      );
    }
  });

  it("renders a fatal shell error without game chrome", async () => {
    const { runtime } = createRuntimeHarness();
    runtime.togglePause = vi.fn(async () => ({
      ...runtime.getSnapshot(),
      backendError: "Rust backend failed",
      rejection: null,
    }));
    render(App, { props: { runtime } });
    await fireEvent.click(screen.getByRole("button", { name: "Resume" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Rust backend failed",
    );
    expect(screen.queryByTestId("topbar")).toBeNull();
    expect(screen.queryByTestId("game-canvas-host")).toBeNull();
    expect(screen.queryByTestId("command-shelf")).toBeNull();
    expect(runtime.stop).toHaveBeenCalled();
  });

  it("renders Data's five overlays, empty hint, and metrics", async () => {
    const { runtime } = createRuntimeHarness();
    render(App, { props: { runtime } });
    await fireEvent.click(screen.getByTestId("command-destination-data"));
    expect(
      screen.getAllByRole("button", {
        name: /coverage|crowding|demand|lateness|traffic/i,
      }),
    ).toHaveLength(5);
    expect(
      screen.getByText("Choose an overlay to inspect the network."),
    ).toBeVisible();
    expect(screen.getAllByText("Late").at(-1)).toBeVisible();
    expect(screen.getAllByText("Unserved").at(-1)).toBeVisible();
    expect(screen.getAllByText("Avg Wait").at(-1)).toBeVisible();
  });

  it("passes the active city name to City and lets Lines collapse during a draft", async () => {
    const { runtime } = createRuntimeHarness();
    render(App, { props: { runtime } });
    await fireEvent.click(screen.getByTestId("command-destination-city"));
    expect(screen.getByText("Harbour City")).toBeVisible();
    await fireEvent.click(screen.getByTestId("command-destination-lines"));
    await fireEvent.click(screen.getByRole("button", { name: "New Bus" }));
    expect(runtime.setTool).toHaveBeenCalledWith("busRoute");
    expect(screen.getByTestId("command-panel")).toHaveAttribute(
      "data-command-panel",
      "lines",
    );
    expect(screen.getByTestId("command-panel")).toHaveClass(
      "command-panel--pinned",
    );
    expect(
      screen.getByRole("button", { name: "Close Lines" }),
    ).toBeEnabled();

    const lines = screen.getByTestId("command-destination-lines");
    expect(lines).not.toHaveAttribute("aria-disabled", "true");
    await fireEvent.click(screen.getByRole("button", { name: "Close Lines" }));
    expect(screen.queryByTestId("command-panel")).toBeNull();
    expect(lines).toHaveAttribute("aria-expanded", "false");
    expect(lines).not.toHaveAttribute("aria-disabled", "true");

    await fireEvent.click(lines);
    expect(screen.getByTestId("command-panel")).toHaveAttribute(
      "data-command-panel",
      "lines",
    );
  });

  it("routes B/R/T/D/V and road presets through guarded runtime methods", async () => {
    const { runtime } = createRuntimeHarness();
    render(App, { props: { runtime } });
    await fireEvent.keyDown(window, { key: "b" });
    expect(runtime.setCommandDestination).toHaveBeenCalledWith("build");
    await fireEvent.keyDown(window, { key: "r" });
    expect(runtime.setTool).toHaveBeenCalledWith("road");
    await fireEvent.keyDown(window, { key: "1" });
    expect(runtime.setRoadPreset).toHaveBeenCalledWith("twoWay");
    await fireEvent.keyDown(window, { key: "t" });
    expect(runtime.setTool).toHaveBeenCalledWith("track");
    await fireEvent.keyDown(window, { key: "x" });
    expect(runtime.setTool).not.toHaveBeenCalledWith("remove");
    await fireEvent.keyDown(window, { key: "d" });
    expect(runtime.setTool).toHaveBeenCalledWith("remove");
    await fireEvent.keyDown(window, { key: "v" });
    expect(runtime.setTool).toHaveBeenCalledWith("inspect");

    vi.mocked(runtime.setTool).mockClear();
    await fireEvent.click(screen.getByTestId("command-destination-city"));
    await fireEvent.keyDown(
      screen.getByRole("textbox", { name: "Rename Harbour City" }),
      { key: "d" },
    );
    expect(runtime.setTool).not.toHaveBeenCalled();
  });

  it("calls runtime Escape once and disposes on unmount", async () => {
    const { runtime } = createRuntimeHarness();
    const view = render(App, { props: { runtime } });
    await fireEvent.keyDown(window, { key: "Escape" });
    expect(runtime.handleEscape).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(runtime.dispose).toHaveBeenCalledTimes(1);
  });

  it("renders selector-owned gameplay feedback and dismisses it", async () => {
    const { runtime } = createRuntimeHarness({
      rejection: {
        code: "insufficientBudget",
        context: { requiredBudget: 1_200, availableBudget: 0 },
      },
    });
    render(App, { props: { runtime } });

    const feedback = screen.getByTestId("action-feedback");
    expect(feedback).toHaveAttribute("data-source", "rejection");
    expect(feedback).toHaveAttribute("data-tone", "error");
    expect(screen.getByTestId("action-feedback-announce")).toHaveAttribute(
      "role",
      "status",
    );
    expect(feedback).toHaveTextContent("Needs $1,200; only $0 is available.");

    await fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(runtime.dismissRejection).toHaveBeenCalledTimes(1);
  });
});
