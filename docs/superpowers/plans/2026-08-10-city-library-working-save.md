# HPA-346 City Library and Working-Save Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the browser Phase 1 working-save loop with city listing, Continue/Load, Save Now, Rename, Delete, and New City entry while keeping the existing six-operation persistence runtime unchanged.

**Architecture:** `workingSaveRuntime` remains the single owner of active-city identity, busy state, dirty state, and persistence mutation errors. `App.svelte` adds only a UI-local `CitySummary[] | null` read projection plus a list-read error, refreshes it through `runtime.persistence.listCities()`, and passes explicit callbacks to a shared city list, a full-screen library, and the existing City panel. Browser persistence stays on IndexedDB; HPA-344 still owns replacing Tauri's temporary memory store with native files.

**Tech Stack:** TypeScript 5.8, Svelte 5, existing `RuntimePersistenceController`, existing `CitySaveStore` / `CitySummary`, Vitest + Testing Library, Playwright/Chromium, Rust/WASM gameplay backend, browser IndexedDB, Tauri 2 shared UI build.

## Global Constraints

- Do not change `RuntimePersistenceController` or `RuntimePersistenceView`.
- Do not add `cities` to runtime state; city summaries are UI-local read state only.
- Reuse store ordering (`savedAt` descending, ID tie-breaker); never sort summaries again in Svelte.
- Reuse `workingSaveErrorMessage()` for list and mutation errors; never surface diagnostics.
- Components invoke only callbacks supplied by `App.svelte`; no UI component imports a store adapter or Tauri command.
- Keep the existing runtime busy gate authoritative and disable all city mutations while it is true.
- Keep the existing dirty boolean; expose only `Saved` / `Unsaved changes` and explicit `Save Now`.
- Delete uses one inline confirmation step; no modal framework.
- Reuse `NewCityScreen.svelte`; add only optional Cancel behavior.
- A Retry control is shown only for a failed `listCities()` read. Save/Load/Rename/Delete failures remain retryable through their original action buttons and must not relabel a list refresh as an operation retry.
- Add no autosave, checkpoints, recovery, duplicate-city, folders, tags, search, thumbnails, import/export, cloud sync, migration, compatibility, multi-instance ownership, security hardening, or new dependency.
- HPA-344 remains native durability. HPA-349 remains final cross-host smoke.

---

## Task 1: Add the reusable city list and full-screen library components

**Files:**
- Create: `src/components/city/CityList.svelte`
- Create: `src/components/city/CityLibraryScreen.svelte`
- Modify: `src/components/NewCityScreen.svelte`
- Create: `tests/ui/cityList.test.ts`
- Modify: `src/styles.css`

**Interfaces:**

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
  onRetry?: () => void;
}
```

### Steps

- [ ] **Step 1: Write the CityList behavior tests red-first**

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

  it("trims rename input and rejects an empty name", async () => {
    const { onRename } = renderList();
    const row = screen.getByTestId("city-row-city-new");

    await fireEvent.click(
      within(row).getByRole("button", { name: "Rename Maple Junction" }),
    );
    const input = within(row).getByRole("textbox", {
      name: "City name for Maple Junction",
    });
    const submit = within(row).getByRole("button", { name: "Save name" });

    await fireEvent.input(input, { target: { value: "   " } });
    expect(submit).toBeDisabled();
    expect(onRename).not.toHaveBeenCalled();

    await fireEvent.input(input, { target: { value: "  Maple Central  " } });
    await fireEvent.click(submit);
    expect(onRename).toHaveBeenCalledWith("city-new", "Maple Central");
  });

  it("requires one inline delete confirmation", async () => {
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

  it("disables city mutations while persistence is busy", () => {
    renderList(true);
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

- [ ] **Step 2: Verify the test fails because the component does not exist**

```bash
bun run test -- tests/ui/cityList.test.ts
```

Expected: FAIL on the missing `CityList.svelte` import.

- [ ] **Step 3: Implement `CityList.svelte` with row-local edit state only**

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

  let { cities, activeCityId, busy, onLoad, onRename, onDelete }: Props =
    $props();
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
    const name = renameValue.trim();
    if (busy || name.length === 0) return;
    onRename(cityId, name);
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
          >Save name</button>
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
            >Load</button>
          {/if}
          <button
            type="button"
            aria-label={`Rename ${city.name}`}
            disabled={busy}
            onclick={() => startRename(city)}
          >Rename</button>
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

- [ ] **Step 4: Implement the thin full-screen library wrapper**

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
    onRetry?: () => void;
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
        {#if onRetry !== undefined}
          <button type="button" onclick={onRetry}>Retry city list</button>
        {/if}
      </div>
    {/if}

    {#if cities === null}
      {#if error === null}<p>Loading cities…</p>{/if}
    {:else}
      <div class="city-library-actions">
        <button
          type="button"
          disabled={busy || cities.length === 0}
          onclick={() => cities[0] && onContinue(cities[0].id)}
        >Continue</button>
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

In `src/components/NewCityScreen.svelte`, extend the props only:

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
  <button type="button" disabled={busy} onclick={onCancel}>Cancel</button>
{/if}
```

- [ ] **Step 6: Add minimal layout styles**

Append to `src/styles.css`:

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
  flex-wrap: wrap;
  gap: 0.5rem;
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

.city-list-meta span,
.city-list-active {
  font-size: 0.8rem;
}

.city-list-active {
  font-weight: 700;
}
```

- [ ] **Step 7: Verify and commit Task 1**

```bash
bun run test -- tests/ui/cityList.test.ts
bun run check
git add src/components/city src/components/NewCityScreen.svelte tests/ui/cityList.test.ts src/styles.css
git commit -m "feat: add city library components"
```

Expected: test/check PASS before commit.

---

## Task 2: Add UI-local list orchestration and the no-active-city library flow

**Files:**
- Modify: `src/App.svelte`
- Modify: `tests/ui/appShell.test.ts`

**Interfaces:**

No runtime interface changes. App adds only:

```ts
let cities = $state<CitySummary[] | null>(null);
let cityListError = $state<string | null>(null);
let showNewCity = $state(false);
```

### Steps

- [ ] **Step 1: Make the App harness return valid persistence promises**

In `tests/ui/appShell.test.ts`, add:

```ts
import type { CitySummary } from "../../src/persistence/citySaveStore";
import type {
  NewCityRequest,
  WorkingSaveResult,
} from "../../src/runtime/workingSaveRuntime";

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

Extend the harness options with:

```ts
cities?: CitySummary[];
```

After the current `persistence` snapshot is initialized, add:

```ts
const defaultCities =
  options.cities ?? (persistence.activeCity === null ? [] : [persistence.activeCity]);
const findCity = (cityId: string): CitySummary | undefined =>
  defaultCities.find((city) => city.id === cityId);
```

Replace the six persistence spies with:

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
    async (cityId: string, name: string): Promise<WorkingSaveResult<CitySummary>> => {
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

- [ ] **Step 2: Migrate every existing no-active-city test to wait for the list read**

The HPA-345 tests currently assume `NewCityScreen` is synchronous. After HPA-346, the first render is a city-list loading state. For every existing `createRuntimeHarness({ persistence: { activeCity: null } })` test that interacts with the New City form, await the form before the first query:

```ts
render(App, { props: { runtime } });
await screen.findByTestId("new-city-screen");
```

Specifically update the existing tests for:

```text
shows New City instead of game chrome
submits only trimmed name, economy, and template
disables repeat New City submission while persistence is busy
shows runtime-mapped persistence copy without diagnostics
```

The first becomes:

```ts
it("shows New City when no city is active and storage is empty", async () => {
  const { runtime } = createRuntimeHarness({
    persistence: { activeCity: null },
    cities: [],
  });
  render(App, { props: { runtime } });

  expect(await screen.findByTestId("new-city-screen")).toBeVisible();
  expect(screen.queryByTestId("game-canvas-host")).toBeNull();
});
```

For the submit test, insert:

```ts
await screen.findByTestId("new-city-screen");
const create = screen.getByRole("button", { name: "Create City" });
```

For the busy test, insert:

```ts
await screen.findByTestId("new-city-screen");
await fireEvent.input(screen.getByLabelText("City name"), {
  target: { value: "Busy City" },
});
```

For the mapped-error test, wait for the form before calling `setPersistence()`:

```ts
await screen.findByTestId("new-city-screen");
harness.setPersistence({
  error: {
    kind: "store",
    error: {
      operation: "createCity",
      code: "failed",
      diagnostic: "QuotaExceededError: private browser detail",
    },
  },
});
```

- [ ] **Step 3: Add saved-list/Continue/list-error tests**

Add:

```ts
it("shows the library when saved cities exist and no city is active", async () => {
  const { runtime } = createRuntimeHarness({
    persistence: { activeCity: null },
    cities: [CITY_NEW, CITY_OLD],
  });
  render(App, { props: { runtime } });

  expect(await screen.findByTestId("city-library-screen")).toBeVisible();
  expect(screen.getByText("Maple Junction")).toBeVisible();
  expect(screen.getByText("Harbour City")).toBeVisible();
});

it("continues the first already-sorted city", async () => {
  const harness = createRuntimeHarness({
    persistence: { activeCity: null },
    cities: [CITY_NEW, CITY_OLD],
  });
  render(App, { props: { runtime: harness.runtime } });

  await fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
  expect(harness.runtime.persistence.load).toHaveBeenCalledWith("city-new");
});

it("maps a list failure and retries without exposing diagnostics", async () => {
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
          diagnostic: "private storage detail",
        },
      },
    })
    .mockResolvedValueOnce({ ok: true, value: [CITY_NEW] });

  render(App, { props: { runtime: harness.runtime } });
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("Could not load the city list.");
  expect(alert).not.toHaveTextContent("private storage detail");

  await fireEvent.click(
    screen.getByRole("button", { name: "Retry city list" }),
  );
  expect(await screen.findByText("Maple Junction")).toBeVisible();
  expect(listCities).toHaveBeenCalledTimes(2);
});
```

- [ ] **Step 4: Run the App tests red**

```bash
bun run test -- tests/ui/appShell.test.ts
```

Expected: the new library assertions FAIL before App orchestration is added.

- [ ] **Step 5: Add the UI-local city-list state and read helper**

In `src/App.svelte`, import:

```ts
import CityLibraryScreen from "./components/city/CityLibraryScreen.svelte";
import type { CitySummary } from "./persistence/citySaveStore";
```

Add:

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

- [ ] **Step 6: Make New City and Load handlers await their existing runtime operations**

Replace the current fire-and-forget create handler and add load:

```ts
async function handleCreateCity(request: NewCityRequest): Promise<void> {
  if (runtime === null) return;
  cityListError = null;
  const result = await runtime.persistence.createCity(request);
  if (!result.ok) return;
  showNewCity = false;
  await refreshCities();
}

async function handleLoadCity(cityId: string): Promise<void> {
  if (runtime === null) return;
  cityListError = null;
  const result = await runtime.persistence.load(cityId);
  if (result.ok) showNewCity = false;
}
```

- [ ] **Step 7: Start one initial list read in the existing mount lifecycle**

Keep the current subscribe/start/dispose sequence and add only:

```ts
runtime.start();
void refreshCities();
```

- [ ] **Step 8: Replace the no-active-city branch**

Keep the fatal branch first. Before the existing active game-shell branch, use:

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
      onRetry={cityListError === null ? undefined : () => void refreshCities()}
    />
  {/if}
{:else}
```

The active game-shell body after that final `{:else}` remains unchanged in Task 2.

Task 3 adds the referenced rename/delete handlers before this branch is committed. Implement Tasks 2 and 3 on the same working branch and commit only after the combined App/CityPanel slice passes its tests.

- [ ] **Step 9: Continue directly into Task 3 without committing a broken intermediate App**

No production commit is made between Tasks 2 and 3. The reviewable commit boundary is the complete working-save UI after the missing callbacks and City panel are in place.

---

## Task 3: Add Save/Rename/Delete/New City controls to the active City panel

**Files:**
- Modify: `src/App.svelte`
- Modify: `src/components/hud/panels/CityPanel.svelte`
- Modify: `tests/ui/appShell.test.ts`
- Modify: `src/styles.css`

**Interfaces:**

```ts
interface CityPanelProps {
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
  onRetryList?: () => void;
}
```

### Steps

- [ ] **Step 1: Add active-panel tests with fixtures whose list contains the active city**

Add to `tests/ui/appShell.test.ts`:

```ts
it("saves the active city and shows dirty state", async () => {
  const harness = createRuntimeHarness({
    persistence: { activeCity: CITY_NEW, dirty: true },
    cities: [CITY_NEW, CITY_OLD],
  });
  render(App, { props: { runtime: harness.runtime } });

  await fireEvent.click(screen.getByTestId("command-destination-city"));
  expect(screen.getByText("Unsaved changes")).toBeVisible();
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
  expect(harness.runtime.persistence.createCity).not.toHaveBeenCalled();
});

it("renames and deletes an inactive city by ID", async () => {
  const harness = createRuntimeHarness({
    persistence: { activeCity: CITY_NEW },
    cities: [CITY_NEW, CITY_OLD],
  });
  render(App, { props: { runtime: harness.runtime } });
  await fireEvent.click(screen.getByTestId("command-destination-city"));

  const row = await screen.findByTestId("city-row-city-old");
  await fireEvent.click(
    within(row).getByRole("button", { name: "Rename Harbour City" }),
  );
  await fireEvent.input(
    within(row).getByRole("textbox", { name: "City name for Harbour City" }),
    { target: { value: "  Old Harbour  " } },
  );
  await fireEvent.click(within(row).getByRole("button", { name: "Save name" }));
  expect(harness.runtime.persistence.renameCity).toHaveBeenCalledWith(
    "city-old",
    "Old Harbour",
  );

  await fireEvent.click(
    within(row).getByRole("button", { name: "Delete Harbour City" }),
  );
  await fireEvent.click(
    within(row).getByRole("button", { name: "Confirm delete Harbour City" }),
  );
  expect(harness.runtime.persistence.deleteCity).toHaveBeenCalledWith("city-old");
});

it("disables active and inactive city mutations while busy", async () => {
  const harness = createRuntimeHarness({
    persistence: { activeCity: CITY_NEW, busy: true },
    cities: [CITY_NEW, CITY_OLD],
  });
  render(App, { props: { runtime: harness.runtime } });
  await fireEvent.click(screen.getByTestId("command-destination-city"));

  expect(screen.getByRole("button", { name: "Working…" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "New City" })).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "Load Harbour City" }),
  ).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "Rename Maple Junction" }),
  ).toBeDisabled();
});

it("returns to the library after the runtime publishes active deletion", async () => {
  const harness = createRuntimeHarness({
    persistence: { activeCity: CITY_NEW },
    cities: [CITY_NEW, CITY_OLD],
  });
  render(App, { props: { runtime: harness.runtime } });
  await fireEvent.click(screen.getByTestId("command-destination-city"));

  const activeRow = await screen.findByTestId("city-row-city-new");
  await fireEvent.click(
    within(activeRow).getByRole("button", { name: "Delete Maple Junction" }),
  );
  await fireEvent.click(
    within(activeRow).getByRole("button", {
      name: "Confirm delete Maple Junction",
    }),
  );
  expect(harness.runtime.persistence.deleteCity).toHaveBeenCalledWith("city-new");

  harness.setPersistence({ activeCity: null, busy: false, dirty: false });
  expect(await screen.findByTestId("city-library-screen")).toBeVisible();
});

it("keeps the active game visible when Load fails", async () => {
  const harness = createRuntimeHarness({
    persistence: { activeCity: CITY_NEW },
    cities: [CITY_NEW, CITY_OLD],
  });
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
  expect(
    screen.queryByRole("button", { name: "Retry city list" }),
  ).toBeNull();
});
```

- [ ] **Step 2: Add explicit Save/Rename/Delete handlers to App**

Alongside `handleLoadCity` from Task 2:

```ts
async function handleSaveCity(): Promise<void> {
  if (runtime === null) return;
  cityListError = null;
  const result = await runtime.persistence.save();
  if (result.ok) await refreshCities();
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

Do not optimistically mutate `cities`; the existing store remains authoritative.

- [ ] **Step 3: Expand CityPanel props and render the working-save controls**

In `src/components/hud/panels/CityPanel.svelte`, import:

```ts
import type { CitySummary } from "../../../persistence/citySaveStore";
import type { ShellCityState } from "../../../runtime/types";
import CityList from "../../city/CityList.svelte";
```

Use:

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
  onRetryList?: () => void;
}
```

Replace the current city name with:

```svelte
<h2 data-testid="active-city-name">{activeCity.name}</h2>
<p class="brief-id">{shell.title}</p>
```

Immediately below it add:

```svelte
<div class="city-save-status" data-dirty={dirty}>
  {dirty ? "Unsaved changes" : "Saved"}
</div>
<div class="city-actions">
  <button type="button" disabled={busy} onclick={onSave}>
    {busy ? "Working…" : "Save Now"}
  </button>
  <button type="button" disabled={busy} onclick={onNewCity}>New City</button>
</div>
{#if error !== null}
  <p class="city-action-error" role="alert">{error}</p>
{/if}
{#if onRetryList !== undefined}
  <button type="button" onclick={onRetryList}>Retry city list</button>
{/if}
```

Keep the existing city overview `<dl>` unchanged. After it add:

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

- [ ] **Step 4: Pass the non-null active city and callbacks from App**

At the existing CityPanel call inside the active game-shell branch, use an explicit non-null guard:

```svelte
{#if currentSnapshot.persistence.activeCity !== null}
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
    onRetryList={cityListError === null ? undefined : () => void refreshCities()}
  />
{/if}
```

- [ ] **Step 5: Add compact City-panel spacing**

Append:

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

.city-action-error {
  margin: 0.5rem 0 0;
}
```

- [ ] **Step 6: Run the combined UI gate, then commit Tasks 2-3 together**

```bash
bun run test -- tests/ui/cityList.test.ts tests/ui/appShell.test.ts
bun run test:unit
bun run check
bun run lint
bun run format:check
git add src/App.svelte src/components/hud/panels/CityPanel.svelte tests/ui/appShell.test.ts src/styles.css
git commit -m "feat: add city working-save workflow"
```

Expected: every verification command PASS before commit.

---

## Task 4: Prove browser reload/Continue and update architecture docs

**Files:**
- Create: `tests/e2e/cityLibrary.spec.ts`
- Modify: `docs/architecture.md`

### Steps

- [ ] **Step 1: Add the real WASM + IndexedDB player-flow smoke**

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

This proves the browser's player-visible create/save/reload/restore path. HPA-343/HPA-345 already prove direct IndexedDB record acceptance, so do not add another IndexedDB inspection helper here.

- [ ] **Step 2: Run the focused and complete Playwright gates**

```bash
bun run test:e2e -- tests/e2e/cityLibrary.spec.ts
bun run test:e2e
```

Expected: PASS. Keep HPA-345's `createDefaultCity()` helper unconditional for fresh Playwright contexts.

- [ ] **Step 3: Update architecture documentation**

In `docs/architecture.md`, describe the browser flow exactly as:

```text
startup
  -> runtime.persistence.listCities()
  -> empty: New City
  -> existing: City Library
       -> Continue / Load / Rename / Delete / New City
  -> active game shell
       -> City panel: Save Now / city list / New City
```

Keep the boundary summary:

```text
UI -> RuntimePersistenceController -> CitySaveStore
browser store: IndexedDB
native Tauri store: temporary memory adapter until HPA-344
final cross-host smoke: HPA-349
```

- [ ] **Step 4: Run the final repository verification**

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

- [ ] **Step 5: Verify scope and commit**

```bash
git diff --name-only main...HEAD
```

Expected production/test/doc scope:

```text
docs/architecture.md
src/App.svelte
src/components/NewCityScreen.svelte
src/components/city/CityLibraryScreen.svelte
src/components/city/CityList.svelte
src/components/hud/panels/CityPanel.svelte
src/styles.css
tests/e2e/cityLibrary.spec.ts
tests/ui/appShell.test.ts
tests/ui/cityList.test.ts
```

Then commit:

```bash
git add tests/e2e/cityLibrary.spec.ts docs/architecture.md
git commit -m "test: cover city library reload flow"
```

---

## Plan Self-Review

### Spec coverage

- City list: Tasks 1-3.
- Continue/Load: Task 2 plus Task 4 browser proof.
- Save Now: Task 3 plus Task 4 invocation.
- Rename active/inactive: shared CityList in Tasks 1 and 3.
- Delete active/inactive with one confirmation: shared CityList in Tasks 1 and 3.
- New City from saved-library/active-game surfaces: Tasks 2-3, reusing `NewCityScreen`.
- Busy behavior: Tasks 1 and 3.
- Dirty presentation: Task 3.
- List/runtime error copy: Tasks 2-3 reuse `workingSaveErrorMessage`; only list failures expose a list Retry control.
- Real browser reload/Continue: Task 4.
- Native persistence: explicitly remains HPA-344.

### Placeholder scan

Every new test and production branch has concrete code or a precise modification target. There are no unfinished test bodies, generic error-handling directives, compatibility shims, or deferred implementation markers inside HPA-346.

### Type and fixture consistency

- `CitySummary` is reused from `src/persistence/citySaveStore.ts`.
- `RuntimePersistenceController` remains unchanged.
- Every active-panel test explicitly sets `activeCity: CITY_NEW` and supplies `[CITY_NEW, CITY_OLD]`, so the active summary is present in the rendered list.
- Every existing no-active New City test waits for the initial `listCities()` read before querying the form.
- `CityPanel.activeCity` is non-null through an explicit template guard.
- `cities: CitySummary[] | null` uses `null` only for initial/pending list reads; it is not a second persistence lifecycle state.
