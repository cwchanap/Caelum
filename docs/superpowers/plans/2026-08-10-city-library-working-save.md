# HPA-346 City Library and Working-Save Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the browser Phase 1 working-save loop by adding a city library, Continue/Load, Save Now, Rename, Delete, and access to the existing New City form without changing the six-operation runtime persistence contract.

**Architecture:** Keep active city, busy, dirty, and mutation errors in the existing `workingSaveRuntime`. `App.svelte` owns only the current `CitySummary[]` read projection and list-read error, refreshes it through `runtime.persistence.listCities()`, and passes explicit callbacks into one shared city-list component, a full-screen library, and the existing City command panel. Browser persistence remains IndexedDB; Tauri remains on HPA-345's temporary memory store until HPA-344 replaces it.

**Tech Stack:** TypeScript 5.8, Svelte 5 runes, existing `RuntimePersistenceController`, existing `CitySaveStore`/`CitySummary`, Vitest + Testing Library, Playwright/Chromium, browser IndexedDB, Rust/WASM gameplay backend, Tauri 2 shared UI build.

## Global Constraints

- Do not change `RuntimePersistenceController` or `RuntimePersistenceView` for HPA-346.
- Do not add `cities` to runtime state; the city list is UI-local read state loaded through `runtime.persistence.listCities()`.
- Reuse the existing store ordering (`savedAt` descending, `id` tie-breaker); do not sort again in Svelte.
- Reuse `workingSaveErrorMessage()` for all player-facing persistence copy; never surface diagnostics.
- UI may call only `runtime.persistence.*`; it never imports/uses IndexedDB, Tauri commands, or `CitySaveStore` implementations.
- Keep the existing runtime busy gate authoritative; disable mutating city controls while `busy` is true and add no per-row queue/loading state.
- Keep the existing dirty boolean; show Saved/Unsaved changes and an explicit Save Now action only.
- Delete requires one inline confirmation. Do not add a modal/dialog framework.
- Extend the existing New City form only with optional Cancel behavior; do not duplicate the form.
- No autosave, checkpoints, recovery, duplicate-city, folders, tags, search, thumbnails, import/export, cloud sync, migration, compatibility, multi-instance ownership, security-hardening, or new dependencies.
- HPA-344 remains the native Tauri durability task. HPA-349 remains the final browser/native cross-host smoke.

---

## Task 1: Add the reusable city list and full-screen library UI

**Files:**
- Create: `src/components/city/CityList.svelte`
- Create: `src/components/city/CityLibraryScreen.svelte`
- Modify: `src/components/NewCityScreen.svelte`
- Create: `tests/ui/cityList.test.ts`
- Modify: `src/styles.css`

**Interfaces:**

Consumes:

```ts
import type { CitySummary } from "../../persistence/citySaveStore";
```

Produces:

```ts
// CityList.svelte
interface Props {
  cities: CitySummary[];
  activeCityId: string | null;
  busy: boolean;
  onLoad: (cityId: string) => void;
  onRename: (cityId: string, name: string) => void;
  onDelete: (cityId: string) => void;
}
```

```ts
// CityLibraryScreen.svelte
interface Props {
  cities: CitySummary[] | null;
  activeCityId: string | null;
  busy: boolean;
  error: string | null;
  onContinue: (cityId: string) => void;
  onLoad: (cityId: string) => void;
  onRename: (cityId: string, name: string) => void;
  onDelete: (cityId: string) => void;
  onNewCity: () => void;
  onRetry: () => void;
}
```

Extends:

```ts
// NewCityScreen.svelte
interface Props {
  busy: boolean;
  error: string | null;
  onCreate: (request: NewCityRequest) => void;
  onCancel?: () => void;
}
```

### Steps

- [ ] **Step 1: Write the complete CityList interaction test file**

Create `tests/ui/cityList.test.ts`:

```ts
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

function renderList(options: { activeCityId?: string | null; busy?: boolean } = {}) {
  const onLoad = vi.fn();
  const onRename = vi.fn();
  const onDelete = vi.fn();

  render(CityList, {
    props: {
      cities: CITIES,
      activeCityId: options.activeCityId ?? "city-new",
      busy: options.busy ?? false,
      onLoad,
      onRename,
      onDelete,
    },
  });

  return { onLoad, onRename, onDelete };
}

describe("CityList", () => {
  it("marks the active city and loads only an inactive city", async () => {
    const { onLoad } = renderList();
    const activeRow = screen.getByTestId("city-row-city-new");
    const inactiveRow = screen.getByTestId("city-row-city-old");

    expect(within(activeRow).getByText("Active")).toBeVisible();
    expect(
      within(activeRow).queryByRole("button", { name: "Load Maple Junction" }),
    ).toBeNull();

    await fireEvent.click(
      within(inactiveRow).getByRole("button", { name: "Load Harbour City" }),
    );

    expect(onLoad).toHaveBeenCalledWith("city-old");
  });

  it("trims rename input and prevents an empty rename", async () => {
    const { onRename } = renderList();
    const row = screen.getByTestId("city-row-city-new");

    await fireEvent.click(
      within(row).getByRole("button", { name: "Rename Maple Junction" }),
    );

    const input = within(row).getByRole("textbox", {
      name: "City name for Maple Junction",
    });
    const saveName = within(row).getByRole("button", { name: "Save name" });

    await fireEvent.input(input, { target: { value: "   " } });
    expect(saveName).toBeDisabled();
    expect(onRename).not.toHaveBeenCalled();

    await fireEvent.input(input, { target: { value: "  Maple Central  " } });
    await fireEvent.click(saveName);

    expect(onRename).toHaveBeenCalledWith("city-new", "Maple Central");
  });

  it("requires a second delete click", async () => {
    const { onDelete } = renderList();
    const row = screen.getByTestId("city-row-city-old");

    await fireEvent.click(
      within(row).getByRole("button", { name: "Delete Harbour City" }),
    );
    expect(onDelete).not.toHaveBeenCalled();

    await fireEvent.click(
      within(row).getByRole("button", {
        name: "Confirm delete Harbour City",
      }),
    );
    expect(onDelete).toHaveBeenCalledWith("city-old");
  });

  it("disables persistence actions while busy", () => {
    renderList({ busy: true });

    expect(
      screen.getByRole("button", { name: "Load Harbour City" }),
    ).toBeDisabled();
    for (const button of screen.getAllByRole("button", { name: /^Rename / })) {
      expect(button).toBeDisabled();
    }
    for (const button of screen.getAllByRole("button", { name: /^Delete / })) {
      expect(button).toBeDisabled();
    }
  });
});
```

- [ ] **Step 2: Run the new component test red**

```bash
bun run test -- tests/ui/cityList.test.ts
```

Expected: FAIL with the missing `CityList.svelte` module.

- [ ] **Step 3: Implement the complete `CityList.svelte` component**

Create `src/components/city/CityList.svelte`:

```svelte
<script lang="ts">
  import type { CitySummary } from "../../persistence/citySaveStore";

  interface Props {
    cities: CitySummary[];
    activeCityId: string | null;
    busy: boolean;
    onLoad: (cityId: string) => void;
    onRename: (cityId: string, name: string) => void;
    onDelete: (cityId: string) => void;
  }

  let {
    cities,
    activeCityId,
    busy,
    onLoad,
    onRename,
    onDelete,
  }: Props = $props();

  let editingCityId = $state<string | null>(null);
  let renameValue = $state("");
  let confirmingDeleteId = $state<string | null>(null);

  const savedAtFormat = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });

  function startRename(city: CitySummary): void {
    if (busy) return;
    editingCityId = city.id;
    renameValue = city.name;
    confirmingDeleteId = null;
  }

  function cancelRename(): void {
    editingCityId = null;
    renameValue = "";
  }

  function submitRename(cityId: string, event: SubmitEvent): void {
    event.preventDefault();
    const trimmedName = renameValue.trim();
    if (busy || trimmedName.length === 0) return;
    onRename(cityId, trimmedName);
    cancelRename();
  }

  function requestDelete(cityId: string): void {
    if (busy) return;
    if (confirmingDeleteId === cityId) {
      onDelete(cityId);
      confirmingDeleteId = null;
      return;
    }
    confirmingDeleteId = cityId;
    editingCityId = null;
    renameValue = "";
  }
</script>

<div class="city-list" data-testid="city-list">
  {#each cities as city (city.id)}
    <article class="city-list-row" data-testid={`city-row-${city.id}`}>
      <div class="city-list-meta">
        <strong>{city.name}</strong>
        <span>
          Saved
          <time datetime={city.savedAt}>
            {savedAtFormat.format(new Date(city.savedAt))}
          </time>
        </span>
      </div>

      {#if editingCityId === city.id}
        <form
          class="city-list-rename"
          onsubmit={(event) => submitRename(city.id, event)}
        >
          <input
            aria-label={`City name for ${city.name}`}
            bind:value={renameValue}
            autocomplete="off"
          />
          <button
            type="submit"
            disabled={busy || renameValue.trim().length === 0}
          >
            Save name
          </button>
          <button type="button" disabled={busy} onclick={cancelRename}>
            Cancel rename
          </button>
        </form>
      {:else}
        <div class="city-list-actions">
          {#if city.id === activeCityId}
            <span class="city-list-active">Active</span>
          {:else}
            <button
              type="button"
              aria-label={`Load ${city.name}`}
              disabled={busy}
              onclick={() => onLoad(city.id)}
            >
              Load
            </button>
          {/if}
          <button
            type="button"
            aria-label={`Rename ${city.name}`}
            disabled={busy}
            onclick={() => startRename(city)}
          >
            Rename
          </button>
          <button
            type="button"
            aria-label={confirmingDeleteId === city.id
              ? `Confirm delete ${city.name}`
              : `Delete ${city.name}`}
            disabled={busy}
            onclick={() => requestDelete(city.id)}
          >
            {confirmingDeleteId === city.id ? "Confirm delete" : "Delete"}
          </button>
        </div>
      {/if}
    </article>
  {/each}
</div>
```

Do not add store/runtime imports or async state to this component.

- [ ] **Step 4: Implement the complete full-screen library wrapper**

Create `src/components/city/CityLibraryScreen.svelte`:

```svelte
<script lang="ts">
  import type { CitySummary } from "../../persistence/citySaveStore";
  import CityList from "./CityList.svelte";

  interface Props {
    cities: CitySummary[] | null;
    activeCityId: string | null;
    busy: boolean;
    error: string | null;
    onContinue: (cityId: string) => void;
    onLoad: (cityId: string) => void;
    onRename: (cityId: string, name: string) => void;
    onDelete: (cityId: string) => void;
    onNewCity: () => void;
    onRetry: () => void;
  }

  let {
    cities,
    activeCityId,
    busy,
    error,
    onContinue,
    onLoad,
    onRename,
    onDelete,
    onNewCity,
    onRetry,
  }: Props = $props();
</script>

<main class="city-library-screen" data-testid="city-library-screen">
  <section class="city-library-card">
    <p class="new-city-kicker">CAELUM // LOCAL CITIES</p>
    <h1>City Library</h1>

    {#if error !== null}
      <div class="city-library-error">
        <p role="alert">{error}</p>
        <button type="button" onclick={onRetry}>Retry</button>
      </div>
    {/if}

    {#if cities === null}
      {#if error === null}
        <p>Loading cities…</p>
      {/if}
    {:else}
      <div class="city-library-actions">
        <button
          type="button"
          disabled={busy || cities.length === 0}
          onclick={() => cities[0] && onContinue(cities[0].id)}
        >
          Continue
        </button>
        <button type="button" disabled={busy} onclick={onNewCity}>
          New City
        </button>
      </div>

      {#if cities.length > 0}
        <CityList
          {cities}
          {activeCityId}
          {busy}
          {onLoad}
          {onRename}
          {onDelete}
        />
      {:else}
        <p>No saved cities.</p>
      {/if}
    {/if}
  </section>
</main>
```

- [ ] **Step 5: Add optional Cancel to the existing New City form**

In `src/components/NewCityScreen.svelte`, extend `Props` and the props destructure:

```ts
interface Props {
  busy: boolean;
  error: string | null;
  onCreate: (request: NewCityRequest) => void;
  onCancel?: () => void;
}

let { busy, error, onCreate, onCancel }: Props = $props();
```

After the existing Create City button, add:

```svelte
{#if onCancel !== undefined}
  <button type="button" disabled={busy} onclick={onCancel}>
    Cancel
  </button>
{/if}
```

Keep the existing form fields, defaults, trimming, and submit behavior unchanged.

- [ ] **Step 6: Add only the required library/list layout styles**

Append to `src/styles.css` and adjust spacing only if an existing selector conflicts:

```css
.city-library-screen {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 2rem;
}

.city-library-card {
  width: min(56rem, 100%);
  display: grid;
  gap: 1rem;
}

.city-library-actions,
.city-list-actions,
.city-list-rename,
.city-actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
  align-items: center;
}

.city-list {
  display: grid;
  gap: 0.75rem;
}

.city-list-row {
  display: grid;
  gap: 0.75rem;
  padding: 0.875rem 0;
  border-top: 1px solid currentColor;
}

.city-list-meta {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  align-items: baseline;
}

.city-list-meta span {
  font-size: 0.8rem;
  opacity: 0.75;
}

.city-list-active {
  font-size: 0.8rem;
  font-weight: 700;
}

.city-library-error,
.city-action-error {
  display: grid;
  gap: 0.5rem;
}
```

- [ ] **Step 7: Run focused UI verification**

```bash
bun run test -- tests/ui/cityList.test.ts
bun run check
```

Expected: PASS.

- [ ] **Step 8: Commit the presentational UI**

```bash
git add \
  src/components/city/CityList.svelte \
  src/components/city/CityLibraryScreen.svelte \
  src/components/NewCityScreen.svelte \
  tests/ui/cityList.test.ts \
  src/styles.css
git commit -m "feat: add city library components"
```

---

## Task 2: Wire city-list orchestration and working-save actions into App and CityPanel

**Files:**
- Modify: `src/App.svelte`
- Modify: `src/components/hud/panels/CityPanel.svelte`
- Modify: `tests/ui/appShell.test.ts`
- Modify: `src/styles.css`

**Interfaces:**

Consumes only the existing runtime persistence controller:

```ts
runtime.persistence.listCities()
runtime.persistence.save()
runtime.persistence.load(cityId)
runtime.persistence.createCity(request)
runtime.persistence.renameCity(cityId, name)
runtime.persistence.deleteCity(cityId)
```

`CityPanel.svelte` receives explicit state/callbacks:

```ts
interface Props {
  shell: ShellCityState;
  activeCity: CitySummary;
  cities: CitySummary[] | null;
  busy: boolean;
  dirty: boolean;
  error: string | null;
  onSave: () => void;
  onLoad: (cityId: string) => void;
  onRename: (cityId: string, name: string) => void;
  onDelete: (cityId: string) => void;
  onNewCity: () => void;
}
```

### Steps

- [ ] **Step 1: Give the App test harness valid persistence promises**

In `tests/ui/appShell.test.ts`, add imports:

```ts
import type { CitySummary } from "../../src/persistence/citySaveStore";
import type {
  NewCityRequest,
  WorkingSaveResult,
} from "../../src/runtime/workingSaveRuntime";
```

Add shared summaries near the existing test helpers:

```ts
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
```

Extend the harness option type with:

```ts
cities?: CitySummary[];
```

After the current `persistence` snapshot value is created, add:

```ts
const defaultCities =
  options.cities ?? (persistence.activeCity === null ? [] : [persistence.activeCity]);

const findCity = (cityId: string): CitySummary | undefined =>
  defaultCities.find((city) => city.id === cityId);
```

Replace the six bare persistence spies with promises that satisfy the real controller shape:

```ts
persistence: {
  listCities: vi.fn(async (): Promise<WorkingSaveResult<CitySummary[]>> => ({
    ok: true,
    value: defaultCities,
  })),
  save: vi.fn(async (): Promise<WorkingSaveResult<CitySummary>> =>
    persistence.activeCity === null
      ? { ok: false, error: { kind: "noActiveCity" } }
      : { ok: true, value: persistence.activeCity },
  ),
  load: vi.fn(async (cityId: string): Promise<WorkingSaveResult<CitySummary>> => {
    const city = findCity(cityId);
    return city === undefined
      ? {
          ok: false,
          error: {
            kind: "store",
            error: { operation: "readCity", code: "notFound", cityId },
          },
        }
      : { ok: true, value: city };
  }),
  createCity: vi.fn(
    async (request: NewCityRequest): Promise<WorkingSaveResult<CitySummary>> => ({
      ok: true,
      value: {
        id: "city-created",
        name: request.name,
        createdAt: "2026-08-10T14:00:00.000Z",
        savedAt: "2026-08-10T14:00:00.000Z",
      },
    }),
  ),
  renameCity: vi.fn(
    async (
      cityId: string,
      name: string,
    ): Promise<WorkingSaveResult<CitySummary>> => {
      const city = findCity(cityId);
      return city === undefined
        ? {
            ok: false,
            error: {
              kind: "store",
              error: { operation: "renameCity", code: "notFound", cityId },
            },
          }
        : { ok: true, value: { ...city, name } };
    },
  ),
  deleteCity: vi.fn(
    async (cityId: string): Promise<WorkingSaveResult<void>> =>
      findCity(cityId) === undefined
        ? {
            ok: false,
            error: {
              kind: "store",
              error: { operation: "deleteCity", code: "notFound", cityId },
            },
          }
        : { ok: true, value: undefined },
  ),
},
```

Keep the rest of the runtime harness unchanged.

- [ ] **Step 2: Update the existing empty-storage New City test for the asynchronous list read**

Replace the synchronous test with:

```ts
it("shows New City instead of game chrome when no city is active and storage is empty", async () => {
  const { runtime } = createRuntimeHarness({
    persistence: { activeCity: null },
    cities: [],
  });

  render(App, { props: { runtime } });

  expect(await screen.findByTestId("new-city-screen")).toBeVisible();
  expect(screen.queryByTestId("game-canvas-host")).toBeNull();
  expect(screen.queryByTestId("command-shelf")).toBeNull();
  expect(screen.queryByTestId("topbar")).toBeNull();
});
```

- [ ] **Step 3: Add no-active-city library/Continue/list-error tests**

Add:

```ts
it("shows the city library when saved cities exist but no city is active", async () => {
  const { runtime } = createRuntimeHarness({
    persistence: { activeCity: null },
    cities: [CITY_NEW, CITY_OLD],
  });

  render(App, { props: { runtime } });

  expect(await screen.findByTestId("city-library-screen")).toBeVisible();
  expect(screen.getByText("Maple Junction")).toBeVisible();
  expect(screen.getByText("Harbour City")).toBeVisible();
  expect(screen.queryByTestId("new-city-screen")).toBeNull();
});

it("continues the first already-sorted city", async () => {
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

it("shows a mapped list failure and retries the read", async () => {
  const harness = createRuntimeHarness({
    persistence: { activeCity: null },
    cities: [CITY_NEW],
  });
  const listCities = vi.mocked(harness.runtime.persistence.listCities);
  listCities
    .mockResolvedValueOnce({
      ok: false,
      error: {
        kind: "store",
        error: {
          operation: "listCities",
          code: "failed",
          diagnostic: "private filesystem/browser detail",
        },
      },
    })
    .mockResolvedValueOnce({ ok: true, value: [CITY_NEW] });

  render(App, { props: { runtime: harness.runtime } });

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("Could not load the city list.");
  expect(alert).not.toHaveTextContent("private filesystem/browser detail");

  await fireEvent.click(screen.getByRole("button", { name: "Retry" }));

  expect(await screen.findByText("Maple Junction")).toBeVisible();
  expect(listCities).toHaveBeenCalledTimes(2);
});
```

- [ ] **Step 4: Add active City-panel persistence tests**

Add the following tests:

```ts
it("saves the active city from the City panel", async () => {
  const harness = createRuntimeHarness({ cities: [CITY_NEW, CITY_OLD] });
  render(App, { props: { runtime: harness.runtime } });

  await fireEvent.click(screen.getByTestId("command-destination-city"));
  await fireEvent.click(screen.getByRole("button", { name: "Save Now" }));

  expect(harness.runtime.persistence.save).toHaveBeenCalledTimes(1);
});

it("opens and cancels the existing New City form from an active city", async () => {
  const harness = createRuntimeHarness({ cities: [CITY_NEW, CITY_OLD] });
  render(App, { props: { runtime: harness.runtime } });

  await fireEvent.click(screen.getByTestId("command-destination-city"));
  await fireEvent.click(screen.getByRole("button", { name: "New City" }));

  expect(screen.getByTestId("new-city-screen")).toBeVisible();
  expect(screen.queryByTestId("game-canvas-host")).toBeNull();

  await fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

  expect(screen.queryByTestId("new-city-screen")).toBeNull();
  expect(screen.getByTestId("game-canvas-host")).toBeVisible();
  expect(harness.runtime.persistence.createCity).not.toHaveBeenCalled();
});

it("renames and deletes the selected inactive city by ID", async () => {
  const harness = createRuntimeHarness({ cities: [CITY_NEW, CITY_OLD] });
  render(App, { props: { runtime: harness.runtime } });

  await fireEvent.click(screen.getByTestId("command-destination-city"));
  const oldRow = await screen.findByTestId("city-row-city-old");

  await fireEvent.click(
    within(oldRow).getByRole("button", { name: "Rename Harbour City" }),
  );
  await fireEvent.input(
    within(oldRow).getByRole("textbox", { name: "City name for Harbour City" }),
    { target: { value: "  Old Harbour  " } },
  );
  await fireEvent.click(
    within(oldRow).getByRole("button", { name: "Save name" }),
  );

  expect(harness.runtime.persistence.renameCity).toHaveBeenCalledWith(
    "city-old",
    "Old Harbour",
  );

  await fireEvent.click(
    within(oldRow).getByRole("button", { name: "Delete Harbour City" }),
  );
  await fireEvent.click(
    within(oldRow).getByRole("button", {
      name: "Confirm delete Harbour City",
    }),
  );

  expect(harness.runtime.persistence.deleteCity).toHaveBeenCalledWith("city-old");
});

it("shows dirty state and disables conflicting city actions while busy", async () => {
  const harness = createRuntimeHarness({
    cities: [CITY_NEW, CITY_OLD],
    persistence: { dirty: true, busy: true },
  });
  render(App, { props: { runtime: harness.runtime } });

  await fireEvent.click(screen.getByTestId("command-destination-city"));

  expect(screen.getByText("Unsaved changes")).toBeVisible();
  expect(screen.getByRole("button", { name: "Working…" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "New City" })).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "Load Harbour City" }),
  ).toBeDisabled();
});

it("returns to the city library when the active city becomes deleted", async () => {
  const harness = createRuntimeHarness({ cities: [CITY_NEW, CITY_OLD] });
  render(App, { props: { runtime: harness.runtime } });

  await fireEvent.click(screen.getByTestId("command-destination-city"));
  const activeRow = await screen.findByTestId("city-row-city-1");
  await fireEvent.click(
    within(activeRow).getByRole("button", { name: "Delete Harbour City" }),
  );
  await fireEvent.click(
    within(activeRow).getByRole("button", {
      name: "Confirm delete Harbour City",
    }),
  );

  harness.setPersistence({ activeCity: null, busy: false, dirty: false });

  expect(await screen.findByTestId("city-library-screen")).toBeVisible();
});

it("keeps the active game visible when Load fails", async () => {
  const harness = createRuntimeHarness({ cities: [CITY_NEW, CITY_OLD] });
  harness.runtime.persistence.load = vi.fn(async () => ({
    ok: false as const,
    error: {
      kind: "backend" as const,
      error: { code: "invalidSnapshot" as const },
    },
  }));
  render(App, { props: { runtime: harness.runtime } });

  await fireEvent.click(screen.getByTestId("command-destination-city"));
  await fireEvent.click(
    await screen.findByRole("button", { name: "Load Harbour City" }),
  );
  harness.setPersistence({
    error: {
      kind: "backend",
      error: { code: "invalidSnapshot" },
    },
  });

  expect(screen.getByTestId("game-canvas-host")).toBeVisible();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Could not apply the city state.",
  );
});
```

The existing harness active city is `city-1` / `Harbour City`; keep those values for the active-delete test rather than changing unrelated shell fixtures.

- [ ] **Step 5: Run the App tests red**

```bash
bun run test -- tests/ui/appShell.test.ts
```

Expected: FAIL because App still selects New City solely from `activeCity === null` and CityPanel has no persistence controls.

- [ ] **Step 6: Add UI-local city-list state and one list refresh helper to App**

In `src/App.svelte`, import:

```ts
import CityLibraryScreen from "./components/city/CityLibraryScreen.svelte";
import type { CitySummary } from "./persistence/citySaveStore";
```

Add beside the current component state:

```ts
let cities = $state<CitySummary[] | null>(null);
let cityListError = $state<string | null>(null);
let showNewCity = $state(false);

const cityActionError = $derived(
  cityListError ??
    (snapshot?.persistence.error == null
      ? null
      : workingSaveErrorMessage(snapshot.persistence.error)),
);
```

Add the read helper:

```ts
async function refreshCities(): Promise<void> {
  if (runtime === null) return;
  const result = await runtime.persistence.listCities();
  if (result.ok) {
    cities = result.value;
    cityListError = null;
    return;
  }
  cityListError = workingSaveErrorMessage(result.error);
}
```

Do not call `sortCitySummaries()` here.

- [ ] **Step 7: Replace the fire-and-forget New City handler and add explicit persistence handlers**

Use:

```ts
async function handleCreateCity(request: NewCityRequest): Promise<void> {
  if (runtime === null) return;
  cityListError = null;
  const result = await runtime.persistence.createCity(request);
  if (!result.ok) return;
  showNewCity = false;
  await refreshCities();
}

async function handleSaveCity(): Promise<void> {
  if (runtime === null) return;
  cityListError = null;
  const result = await runtime.persistence.save();
  if (result.ok) await refreshCities();
}

async function handleLoadCity(cityId: string): Promise<void> {
  if (runtime === null) return;
  cityListError = null;
  const result = await runtime.persistence.load(cityId);
  if (result.ok) showNewCity = false;
}

async function handleRenameCity(cityId: string, name: string): Promise<void> {
  if (runtime === null) return;
  cityListError = null;
  const result = await runtime.persistence.renameCity(cityId, name);
  if (result.ok) await refreshCities();
}

async function handleDeleteCity(cityId: string): Promise<void> {
  if (runtime === null) return;
  cityListError = null;
  const result = await runtime.persistence.deleteCity(cityId);
  if (result.ok) await refreshCities();
}
```

These remain separate because their success behavior differs. Do not add an action-runner abstraction.

- [ ] **Step 8: Start exactly one initial list read in the existing mount lifecycle**

In the existing `onMount` block, keep subscription/start/disposal behavior and add only:

```ts
runtime.start();
void refreshCities();
```

The cleanup remains:

```ts
return () => {
  unsubscribe();
  runtime.dispose();
};
```

- [ ] **Step 9: Replace the pre-game branch with loading/library/empty/New-City presentation**

Keep the fatal branch first. Replace the current no-active branch with:

```svelte
{:else if showNewCity}
  <NewCityScreen
    busy={snapshot?.persistence.busy ?? false}
    error={cityActionError}
    onCreate={(request) => void handleCreateCity(request)}
    onCancel={() => (showNewCity = false)}
  />
{:else if snapshot?.persistence.activeCity == null}
  {#if cities !== null && cities.length === 0}
    <NewCityScreen
      busy={snapshot?.persistence.busy ?? false}
      error={cityActionError}
      onCreate={(request) => void handleCreateCity(request)}
    />
  {:else}
    <CityLibraryScreen
      {cities}
      activeCityId={null}
      busy={snapshot?.persistence.busy ?? false}
      error={cityActionError}
      onContinue={(cityId) => void handleLoadCity(cityId)}
      onLoad={(cityId) => void handleLoadCity(cityId)}
      onRename={(cityId, name) => void handleRenameCity(cityId, name)}
      onDelete={(cityId) => void handleDeleteCity(cityId)}
      onNewCity={() => (showNewCity = true)}
      onRetry={() => void refreshCities()}
    />
  {/if}
{:else}
  <!-- keep the existing active game shell -->
```

The sole retained template comment marks the unchanged existing game-shell body; it is not an implementation placeholder.

- [ ] **Step 10: Expand CityPanel with working-save state and callbacks**

In `src/components/hud/panels/CityPanel.svelte`, replace the current props with:

```ts
import type { CitySummary } from "../../../persistence/citySaveStore";
import type { ShellCityState } from "../../../runtime/types";
import CityList from "../../city/CityList.svelte";

interface Props {
  shell: ShellCityState;
  activeCity: CitySummary;
  cities: CitySummary[] | null;
  busy: boolean;
  dirty: boolean;
  error: string | null;
  onSave: () => void;
  onLoad: (cityId: string) => void;
  onRename: (cityId: string, name: string) => void;
  onDelete: (cityId: string) => void;
  onNewCity: () => void;
}

let {
  shell,
  activeCity,
  cities,
  busy,
  dirty,
  error,
  onSave,
  onLoad,
  onRename,
  onDelete,
  onNewCity,
}: Props = $props();
```

Replace the current city-name heading with:

```svelte
<h2 data-testid="active-city-name">{activeCity.name}</h2>
<p class="brief-id">{shell.title}</p>
```

Immediately after that heading block, add:

```svelte
<div class="city-save-status" data-dirty={dirty}>
  {dirty ? "Unsaved changes" : "Saved"}
</div>

<div class="city-actions">
  <button type="button" disabled={busy} onclick={onSave}>
    {busy ? "Working…" : "Save Now"}
  </button>
  <button type="button" disabled={busy} onclick={onNewCity}>
    New City
  </button>
</div>

{#if error !== null}
  <p class="city-action-error" role="alert">{error}</p>
{/if}
```

Keep the existing city-overview `<dl>` unchanged. After it, add:

```svelte
{#if cities !== null}
  <section class="city-local-list" aria-label="Local cities">
    <CityList
      {cities}
      activeCityId={activeCity.id}
      {busy}
      {onLoad}
      {onRename}
      {onDelete}
    />
  </section>
{/if}
```

- [ ] **Step 11: Pass App state/actions into the existing CityPanel call**

Inside the already-active game-shell branch, replace the old `CityPanel` props with:

```svelte
<CityPanel
  shell={currentSnapshot.shell.city}
  activeCity={currentSnapshot.persistence.activeCity}
  {cities}
  busy={currentSnapshot.persistence.busy}
  dirty={currentSnapshot.persistence.dirty}
  error={cityActionError}
  onSave={() => void handleSaveCity()}
  onLoad={(cityId) => void handleLoadCity(cityId)}
  onRename={(cityId, name) => void handleRenameCity(cityId, name)}
  onDelete={(cityId) => void handleDeleteCity(cityId)}
  onNewCity={() => (showNewCity = true)}
/>
```

If Svelte's type narrowing does not carry the enclosing non-null `activeCity` branch into this call, introduce one template-local constant immediately before the call:

```svelte
{@const activeCity = currentSnapshot.persistence.activeCity}
{#if activeCity !== null}
  <CityPanel
    shell={currentSnapshot.shell.city}
    {activeCity}
    {cities}
    busy={currentSnapshot.persistence.busy}
    dirty={currentSnapshot.persistence.dirty}
    error={cityActionError}
    onSave={() => void handleSaveCity()}
    onLoad={(cityId) => void handleLoadCity(cityId)}
    onRename={(cityId, name) => void handleRenameCity(cityId, name)}
    onDelete={(cityId) => void handleDeleteCity(cityId)}
    onNewCity={() => (showNewCity = true)}
  />
{/if}
```

Use the first form when `bun run check` accepts the existing branch narrowing; otherwise use the explicit local guard. Do not widen `CityPanel.activeCity` to nullable merely for the compiler.

- [ ] **Step 12: Add compact City-panel status spacing**

Append to `src/styles.css`:

```css
.city-save-status {
  font-size: 0.8rem;
  font-weight: 700;
}

.city-save-status[data-dirty="true"] {
  text-decoration: underline;
}

.city-local-list {
  margin-top: 1rem;
}
```

- [ ] **Step 13: Run the focused and full frontend verification gate**

```bash
bun run test -- tests/ui/cityList.test.ts tests/ui/appShell.test.ts
bun run test:unit
bun run check
bun run lint
bun run format:check
```

Expected: PASS.

- [ ] **Step 14: Commit the working-save UI orchestration**

```bash
git add \
  src/App.svelte \
  src/components/hud/panels/CityPanel.svelte \
  tests/ui/appShell.test.ts \
  src/styles.css
git commit -m "feat: add city working-save workflow"
```

---

## Task 3: Prove browser reload/Continue and align architecture documentation

**Files:**
- Create: `tests/e2e/cityLibrary.spec.ts`
- Modify: `docs/architecture.md`

**Interfaces:**

Reuses the HPA-345 Playwright helper:

```ts
createDefaultCity(page, name)
```

The browser path under test is already production-wired as:

```text
WASM GameBackend -> workingSaveRuntime -> IndexedDbCitySaveStore
```

### Steps

- [ ] **Step 1: Add the real-browser reload/Continue smoke**

Create `tests/e2e/cityLibrary.spec.ts`:

```ts
import { expect, test } from "@playwright/test";
import { createDefaultCity } from "./helpers";

test("created city survives reload and Continue restores it", async ({ page }) => {
  await createDefaultCity(page, "Reload Junction");

  await page.getByTestId("command-destination-city").click();
  await page.getByRole("button", { name: "Save Now" }).click();
  await expect(page.getByRole("button", { name: "Save Now" })).toBeEnabled();

  await page.reload();

  await expect(page.getByTestId("city-library-screen")).toBeVisible();
  await expect(page.getByText("Reload Junction")).toBeVisible();

  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByTestId("game-canvas-host")).toBeVisible();
  await page.getByTestId("command-destination-city").click();
  await expect(page.getByTestId("active-city-name")).toHaveText(
    "Reload Junction",
  );
});
```

This intentionally proves the player-visible reload/restore path. HPA-343/HPA-345 already cover direct IndexedDB record acceptance; do not duplicate direct IndexedDB inspection here.

- [ ] **Step 2: Run the dedicated Chromium spec**

```bash
bun run test:e2e -- tests/e2e/cityLibrary.spec.ts
```

Expected: PASS.

- [ ] **Step 3: Run all existing Playwright flows**

```bash
bun run test:e2e
```

Expected: PASS. Keep `createDefaultCity()` unconditional for fresh test contexts; HPA-346 does not weaken HPA-345's empty-storage bootstrap assertion.

- [ ] **Step 4: Update architecture documentation to the completed browser working-save flow**

In `docs/architecture.md`, replace the HPA-345-only no-city description with this flow:

```text
startup
  -> runtime.persistence.listCities()
  -> empty: New City
  -> existing: City Library
       -> Continue / Load / Rename / Delete / New City
  -> active game shell
       -> City panel: Save Now / city list / New City
```

Keep the surrounding persistence boundary text explicit:

```text
UI -> RuntimePersistenceController -> CitySaveStore
browser store: IndexedDB
native Tauri store: temporary memory adapter until HPA-344
final cross-host smoke: HPA-349
```

Do not add autosave, recovery, migration, compatibility, multi-instance, or native-file details that belong to other issues.

- [ ] **Step 5: Run the final repository gate**

```bash
bun run test
bun run check
bun run lint
bun run format:check
bun run build
bun run test:e2e
bun run tauri:build
```

Expected: every command exits successfully.

- [ ] **Step 6: Verify the final diff remains inside HPA-346**

```bash
git diff --stat main...HEAD
git diff --name-only main...HEAD
rg -n "autosave|checkpoint|recovery|migration|repository|view.?model|state machine|storage event" \
  src/components/city \
  src/App.svelte \
  src/components/hud/panels/CityPanel.svelte \
  docs/architecture.md
```

Expected file scope:

```text
src/App.svelte
src/components/NewCityScreen.svelte
src/components/city/CityList.svelte
src/components/city/CityLibraryScreen.svelte
src/components/hud/panels/CityPanel.svelte
src/styles.css
tests/ui/cityList.test.ts
tests/ui/appShell.test.ts
tests/e2e/cityLibrary.spec.ts
docs/architecture.md
```

Any source match from the scope scan must be either an explicit statement that the deferred feature is absent or removed before completion. No new persistence abstraction should appear.

- [ ] **Step 7: Commit the browser smoke and architecture update**

```bash
git add tests/e2e/cityLibrary.spec.ts docs/architecture.md
git commit -m "test: cover city library reload flow"
```

---

## Plan self-review

### Spec coverage

- City list: Tasks 1-2.
- Continue/Load: Task 2 plus the real-browser proof in Task 3.
- Save Now: Task 2 plus invocation in Task 3.
- Rename active/inactive: the shared `CityList` in Tasks 1-2.
- Delete active/inactive with one confirmation: Tasks 1-2.
- New City from an existing library or active game: Tasks 1-2, reusing `NewCityScreen`.
- Busy behavior: Tasks 1-2.
- Dirty presentation: Task 2.
- Error copy: Task 2 reuses `workingSaveErrorMessage` for list and mutation failures.
- Real IndexedDB + reload + Continue: Task 3.
- Architecture documentation: Task 3.
- Native persistence: explicitly excluded for HPA-344.

### Placeholder scan

The executable steps contain no unfinished test bodies, omitted implementation branches, generic error-handling instructions, or fill-in-later markers. The one template comment in the App render snippet explicitly preserves the already-existing game-shell body rather than standing in for new HPA-346 logic.

### Type consistency

- `CitySummary` comes only from `src/persistence/citySaveStore.ts`.
- `RuntimePersistenceController` remains unchanged.
- `CityList` callbacks use `cityId: string` and trimmed rename `name: string` consistently in both library and panel surfaces.
- `cities: CitySummary[] | null` uses `null` only for initial/pending list read, not as a second persistence lifecycle state.
- `CityPanel.activeCity` stays non-null by construction of the active game-shell branch.
