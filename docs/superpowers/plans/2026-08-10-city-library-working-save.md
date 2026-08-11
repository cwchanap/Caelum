# HPA-346 City Library and Working-Save Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the browser Phase 1 working-save loop with city listing, Continue/Load, Save Now, Rename, Delete, and New City entry while keeping the existing six-operation persistence runtime unchanged.

**Architecture:** `workingSaveRuntime` remains the single owner of active-city identity, busy state, dirty state, and persistence mutation errors. `App.svelte` owns only a latest-wins `CitySummary[] | null` read projection plus list-read error and New City presentation state. City rows reuse the established LinesPanel inline-rename/two-click-delete interaction vocabulary. Browser persistence remains IndexedDB; HPA-344 still owns native Tauri save files.

**Tech Stack:** TypeScript 5.8, Svelte 5, existing `RuntimePersistenceController`, existing `CitySaveStore` / `CitySummary`, Vitest + Testing Library, Playwright/Chromium, Rust/WASM gameplay backend, browser IndexedDB.

## Global Constraints

- Do not change `RuntimePersistenceController` or `RuntimePersistenceView`.
- Do not add `cities` to runtime state; summaries are UI-local read state only.
- Reuse store ordering (`savedAt` descending, ID tie-breaker); never sort in Svelte.
- Reuse `workingSaveErrorMessage()` for all persistence copy; never surface diagnostics.
- Use one derived `cityError` for both City Library and City panel.
- `Retry city list` exists only for `listCities()` failure; Save/Load/Rename/Delete retry through their original controls.
- Failed list read must still expose New City.
- Reuse LinesPanel's inline rename + `Delete` -> `Delete?` interaction vocabulary for city rows; add trim/reject-empty behavior.
- Keep the existing runtime busy gate authoritative. Do not add a mutation queue or per-row pending map.
- Add one latest-wins request counter around read-only list refreshes; no polling/cancellation framework.
- Invalidate the App city-list projection before deleting the active city so runtime publication cannot intentionally render a known-deleted row.
- Extend `NewCityScreen.svelte` only with optional Cancel.
- Delete obsolete CityPanel tests with the old interface; do not keep compatibility props.
- No autosave, checkpoints, recovery, duplicate city, folders, tags, search, thumbnails, import/export, cloud sync, migration, compatibility, multi-instance ownership, security-hardening framework, or new dependency.
- HPA-344 remains native durability. HPA-349 remains final cross-host smoke.

---

## Task 1: Add CityList, the thin City Library screen, and optional New City cancel

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

```ts
// NewCityScreen.svelte extension
interface Props {
  busy: boolean;
  error: string | null;
  onCreate: (request: NewCityRequest) => void;
  onCancel?: () => void;
}
```

### Steps

- [ ] **Step 1: Write CityList behavior tests red-first using the established Lines interaction shape**

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
```

- [ ] **Step 2: Verify the CityList test is red**

```bash
bunx vitest run tests/ui/cityList.test.ts
```

Expected: FAIL because `CityList.svelte` does not exist.

- [ ] **Step 3: Implement `CityList.svelte` by copying the LinesPanel interaction vocabulary**

Create `src/components/city/CityList.svelte` with row-local draft/delete state:

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
  let pendingDeleteId = $state<string | null>(null);
  let cityNameDrafts = $state<Record<string, string>>({});

  const savedAtFormat = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });

  function cityNameFor(cityId: string, canonical: string): string {
    return cityNameDrafts[cityId] ?? canonical;
  }

  function handleCityNameInput(
    cityId: string,
    event: Event & { currentTarget: HTMLInputElement },
  ): void {
    cityNameDrafts[cityId] = event.currentTarget.value;
  }

  function commitCityName(
    city: CitySummary,
    input: HTMLInputElement,
  ): void {
    if (!(city.id in cityNameDrafts)) return;
    const trimmed = input.value.trim();
    delete cityNameDrafts[city.id];
    if (trimmed.length === 0) {
      input.value = city.name;
      return;
    }
    input.value = trimmed;
    if (trimmed !== city.name) onRename(city.id, trimmed);
  }

  function cancelCityName(
    city: CitySummary,
    event: KeyboardEvent & { currentTarget: HTMLInputElement },
  ): void {
    delete cityNameDrafts[city.id];
    event.currentTarget.value = city.name;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.blur();
  }

  function handleDeleteClick(cityId: string): void {
    if (busy) return;
    if (pendingDeleteId === cityId) {
      pendingDeleteId = null;
      onDelete(cityId);
    } else {
      pendingDeleteId = cityId;
    }
  }
</script>

<div class="city-list" data-testid="city-list">
  {#each cities as city (city.id)}
    <article class="city-list-row" data-testid={`city-row-${city.id}`}>
      <div class="city-list-meta">
        <input
          type="text"
          class="city-name"
          data-testid={`city-name-${city.id}`}
          value={cityNameFor(city.id, city.name)}
          aria-label={`Rename ${city.name}`}
          disabled={busy}
          autocomplete="off"
          oninput={(event) =>
            handleCityNameInput(
              city.id,
              event as Event & { currentTarget: HTMLInputElement },
            )}
          onblur={(event) => commitCityName(city, event.currentTarget)}
          onkeydown={(event) => {
            if (event.key === "Escape") {
              cancelCityName(
                city,
                event as KeyboardEvent & {
                  currentTarget: HTMLInputElement;
                },
              );
            } else if (event.key === "Enter") {
              commitCityName(city, event.currentTarget);
              event.currentTarget.blur();
            }
          }}
        />
        <span>
          Saved
          <time datetime={city.savedAt}>
            {savedAtFormat.format(new Date(city.savedAt))}
          </time>
        </span>
      </div>

      <div class="city-list-actions">
        {#if city.id === activeCityId}
          <span class="city-list-active">Active</span>
        {:else}
          <button
            type="button"
            aria-label={`Load ${city.name}`}
            disabled={busy}
            onclick={() => {
              pendingDeleteId = null;
              onLoad(city.id);
            }}
          >Load</button>
        {/if}
        <button
          type="button"
          class:city-delete--armed={pendingDeleteId === city.id}
          data-testid={`city-delete-${city.id}`}
          disabled={busy}
          onclick={() => handleDeleteClick(city.id)}
        >
          {pendingDeleteId === city.id ? "Delete?" : "Delete"}
        </button>
      </div>
    </article>
  {/each}
</div>
```

- [ ] **Step 4: Implement `CityLibraryScreen.svelte` without an empty-list branch**

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
      <p role="alert">{error}</p>
      <div class="city-library-actions">
        {#if onRetry !== undefined}
          <button type="button" disabled={busy} onclick={onRetry}>
            Retry city list
          </button>
        {/if}
        <button type="button" disabled={busy} onclick={onNewCity}>
          New City
        </button>
      </div>
    {:else if cities === null}
      <p>Loading cities…</p>
    {:else if cities.length > 0}
      <div class="city-library-actions">
        <button
          type="button"
          disabled={busy}
          onclick={() => onContinue(cities[0].id)}
        >Continue</button>
        <button type="button" disabled={busy} onclick={onNewCity}>
          New City
        </button>
      </div>
      <CityList
        {cities}
        {activeCityId}
        {busy}
        {onLoad}
        {onRename}
        {onDelete}
      />
    {/if}
  </section>
</main>
```

App owns successful `[]` and never intentionally sends it to this screen.

- [ ] **Step 5: Add optional Cancel to `NewCityScreen.svelte`**

Extend props:

```ts
interface Props {
  busy: boolean;
  error: string | null;
  onCreate: (request: NewCityRequest) => void;
  onCancel?: () => void;
}

let { busy, error, onCreate, onCancel }: Props = $props();
```

After Create City:

```svelte
{#if onCancel !== undefined}
  <button type="button" disabled={busy} onclick={onCancel}>Cancel</button>
{/if}
```

- [ ] **Step 6: Add only the required city-list/library styles**

In `src/styles.css` add scoped layout for:

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
}

.city-list-meta {
  display: grid;
  gap: 0.25rem;
}
```

Do not extract a design system.

- [ ] **Step 7: Run Task 1 UI/type/style gates**

```bash
bunx vitest run tests/ui/cityList.test.ts
bun run check
bun run lint
bun run format:check
```

Expected: PASS.

- [ ] **Step 8: Commit Task 1**

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

## Task 2: Add App-local list orchestration, latest-wins refresh, Continue, and list-error New City access

**Files:**
- Modify: `src/App.svelte`
- Modify: `tests/ui/appShell.test.ts`

**Interfaces:**

Reuse only:

```ts
runtime.persistence.listCities()
runtime.persistence.createCity(request)
runtime.persistence.load(cityId)
```

Task 3 adds Save/Rename/Delete handlers before Tasks 2-3 are committed together.

### Steps

- [ ] **Step 1: Give the App harness valid default results for all six persistence methods**

In `tests/ui/appShell.test.ts`, import:

```ts
import type { CitySummary } from "../../src/persistence/citySaveStore";
```

Extend harness options:

```ts
cities?: CitySummary[];
```

Immediately after constructing the local `persistence: RuntimeSnapshot["persistence"]` value, derive defaults **before** constructing the `runtime` object:

```ts
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
```

Then construct `runtime.persistence` with valid async results instead of bare spies:

```ts
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
      ...(defaultCities.find((city) => city.id === cityId) ?? defaultSummary),
      name,
    },
  })),
  deleteCity: vi.fn(async () => ({
    ok: true as const,
    value: undefined,
  })),
},
```

Individual tests may replace any spy for failure or deferred completion.

- [ ] **Step 2: Add deterministic city fixtures used by App tests**

Near the harness:

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

- [ ] **Step 3: Migrate existing HPA-345 no-city tests to await the initial list read**

For tests with `activeCity: null`, use `findByTestId`/`findByRole` after render. Example:

```ts
render(App, { props: { runtime } });
expect(await screen.findByTestId("new-city-screen")).toBeVisible();
```

Keep the existing New City request/busy/error/active-city-return assertions otherwise unchanged.

- [ ] **Step 4: Add saved-list and Continue tests**

```ts
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
```

- [ ] **Step 5: Add failed-list coverage with both Retry and New City**

Override `listCities` before render:

```ts
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
```

- [ ] **Step 6: Add a latest-wins refresh regression test**

Add a tiny deferred helper in the test file:

```ts
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
```

Test two retries resolving newest-first:

```ts
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
  const retry = await screen.findByRole("button", { name: "Retry city list" });
  await fireEvent.click(retry);
  await fireEvent.click(retry);

  newer.resolve({ ok: true, value: [CITY_NEW] });
  expect(await screen.findByTestId("city-row-city-new")).toBeVisible();

  older.resolve({ ok: true, value: [CITY_OLD] });
  await tick();
  expect(screen.getByTestId("city-row-city-new")).toBeVisible();
  expect(screen.queryByTestId("city-row-city-old")).toBeNull();
});
```

- [ ] **Step 7: Add App-local state, one derived error, and latest-wins refresh**

In `src/App.svelte` import `CitySummary` and `CityLibraryScreen`, then add:

```ts
let cities = $state<CitySummary[] | null>(null);
let cityListError = $state<string | null>(null);
let showNewCity = $state(false);
let cityListRequestId = 0;

const cityError = $derived(
  cityListError ??
    (snapshot?.persistence.error == null
      ? null
      : workingSaveErrorMessage(snapshot.persistence.error)),
);

async function refreshCities(): Promise<void> {
  if (runtime === null) return;
  const requestId = ++cityListRequestId;
  const result = await runtime.persistence.listCities();
  if (requestId !== cityListRequestId) return;

  if (result.ok) {
    cities = result.value;
    cityListError = null;
  } else {
    cityListError = workingSaveErrorMessage(result.error);
  }
}
```

- [ ] **Step 8: Make Create and Load explicit async handlers**

Replace the fire-and-forget New City handler with:

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
  await runtime.persistence.load(cityId);
}
```

The runtime remains authoritative for active identity/error publication.

- [ ] **Step 9: Start the first list read from the existing mount lifecycle**

After `runtime.start()` in `onMount`:

```ts
void refreshCities();
```

Keep the existing unsubscribe/dispose teardown unchanged.

- [ ] **Step 10: Render New City / library / active shell with one error value**

After the fatal shell branch, use this ordering:

```svelte
{:else if showNewCity}
  <NewCityScreen
    busy={snapshot?.persistence.busy ?? false}
    error={cityError}
    onCreate={(request) => void handleCreateCity(request)}
    onCancel={() => (showNewCity = false)}
  />
{:else if snapshot?.persistence.activeCity == null}
  {#if cities !== null && cities.length === 0 && cityListError === null}
    <NewCityScreen
      busy={snapshot?.persistence.busy ?? false}
      error={cityError}
      onCreate={(request) => void handleCreateCity(request)}
    />
  {:else}
    <CityLibraryScreen
      {cities}
      activeCityId={null}
      busy={snapshot?.persistence.busy ?? false}
      error={cityError}
      onContinue={(cityId) => void handleLoadCity(cityId)}
      onLoad={(cityId) => void handleLoadCity(cityId)}
      onRename={(cityId, name) => void handleRenameCity(cityId, name)}
      onDelete={(cityId) => void handleDeleteCity(cityId)}
      onNewCity={() => (showNewCity = true)}
      onRetry={cityListError === null ? undefined : () => void refreshCities()}
    />
  {/if}
{:else}
  <!-- existing active game shell -->
```

`handleRenameCity`/`handleDeleteCity` are added in Task 3 before this combined App change is committed.

- [ ] **Step 11: Run Task 2 focused tests red/partially green, then continue directly to Task 3**

```bash
bunx vitest run tests/ui/appShell.test.ts
bun run check
```

Do not commit yet. Tasks 2-3 form one atomic App/CityPanel cutover.

---

## Task 3: Add Save/Rename/Delete/New City controls to CityPanel and migrate CityPanel tests

**Files:**
- Modify: `src/App.svelte`
- Modify: `src/components/hud/panels/CityPanel.svelte`
- Modify: `tests/ui/appShell.test.ts`
- Modify: `tests/ui/cityPanel.test.ts`
- Modify: `src/styles.css`

### Steps

- [ ] **Step 1: Add Save/dirty/New City/selected-row behavior tests to App**

Use active fixtures that include the active city in the list:

```ts
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
```

For inactive rename/delete use the inline city-name input and `Delete` button inside `city-row-city-old`:

```ts
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
expect(harness.runtime.persistence.deleteCity).toHaveBeenCalledWith("city-old");
```

- [ ] **Step 2: Model active-delete production ordering with a deferred post-delete list read**

For active deletion the App invalidates `cities` before invoking the delete. The runtime publishes `activeCity: null` before the caller's delete promise settles into the subsequent refresh.

Another city remains:

```ts
it("does not show a deleted active city while refreshing the remaining library", async () => {
  const harness = createRuntimeHarness({
    persistence: { activeCity: CITY_NEW },
    cities: [CITY_NEW, CITY_OLD],
  });
  const refreshed = deferred<{ ok: true; value: CitySummary[] }>();
  harness.runtime.persistence.listCities = vi
    .fn()
    .mockResolvedValueOnce({ ok: true as const, value: [CITY_NEW, CITY_OLD] })
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
```

Final slot:

```ts
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
```

These tests deliberately publish `activeCity: null` before the post-delete list response resolves.

- [ ] **Step 3: Add busy and failed-load coverage**

Busy test asserts:

```ts
expect(screen.getByRole("button", { name: "Working…" })).toBeDisabled();
expect(screen.getByRole("button", { name: "New City" })).toBeDisabled();
expect(
  screen.getByRole("button", { name: "Load Harbour City" }),
).toBeDisabled();
expect(screen.getByTestId("city-name-city-old")).toBeDisabled();
```

Failed Load overrides `runtime.persistence.load`, publishes the backend error through the harness, then asserts:

```ts
expect(screen.getByTestId("game-canvas-host")).toBeVisible();
expect(screen.getByRole("alert")).toHaveTextContent(
  "Could not apply the city state.",
);
expect(
  screen.queryByRole("button", { name: "Retry city list" }),
).toBeNull();
```

- [ ] **Step 4: Add Save/Rename/Delete handlers to App**

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

  const deletingActive = snapshot?.persistence.activeCity?.id === cityId;
  if (deletingActive) cities = null;

  const result = await runtime.persistence.deleteCity(cityId);
  if (!result.ok) {
    if (deletingActive) await refreshCities();
    return;
  }

  await refreshCities();
}
```

Do not optimistically remove/add summaries. Active deletion only invalidates a list projection that is known to become stale.

- [ ] **Step 5: Replace CityPanel's old two-prop interface**

In `src/components/hud/panels/CityPanel.svelte`:

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
  onRetryList?: () => void;
}
```

Render the heading and exact save-state test hook:

```svelte
<h2 data-testid="active-city-name">{activeCity.name}</h2>
<p class="brief-id">{shell.title}</p>

<div
  class="city-save-status"
  data-testid="city-save-status"
  data-dirty={dirty}
>
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
  <button type="button" disabled={busy} onclick={onRetryList}>
    Retry city list
  </button>
{/if}
```

Keep the existing overview `<dl>` unchanged. After it:

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

- [ ] **Step 6: Pass the same derived `cityError` into CityPanel**

Inside the existing active shell guard:

```svelte
{#if currentSnapshot.persistence.activeCity !== null}
  <CityPanel
    shell={currentSnapshot.shell.city}
    activeCity={currentSnapshot.persistence.activeCity}
    {cities}
    busy={currentSnapshot.persistence.busy}
    dirty={currentSnapshot.persistence.dirty}
    error={cityError}
    onSave={() => void handleSaveCity()}
    onLoad={(cityId) => void handleLoadCity(cityId)}
    onRename={(cityId, name) => void handleRenameCity(cityId, name)}
    onDelete={(cityId) => void handleDeleteCity(cityId)}
    onNewCity={() => (showNewCity = true)}
    onRetryList={cityListError === null ? undefined : () => void refreshCities()}
  />
{/if}
```

There is no separate `runtimePersistenceError` or `cityActionError` identifier.

- [ ] **Step 7: Migrate `tests/ui/cityPanel.test.ts` and delete obsolete old-contract tests**

Replace the current three tests with one migrated overview contract:

```ts
import { render, screen } from "@testing-library/svelte";
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

describe("CityPanel", () => {
  it("renders the active city, save status, and every overview field", () => {
    render(CityPanel, {
      props: {
        shell,
        activeCity,
        cities: [activeCity],
        busy: false,
        dirty: false,
        error: null,
        onSave: vi.fn(),
        onLoad: vi.fn(),
        onRename: vi.fn(),
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
});
```

Delete the old null-city fallback test and persistence-controls-absent test with the old CityPanel interface. Do not preserve `cityName` compatibility.

- [ ] **Step 8: Add compact CityPanel styles**

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

- [ ] **Step 9: Run the complete Tasks 2-3 UI gate**

```bash
bunx vitest run tests/ui/cityList.test.ts
bunx vitest run tests/ui/appShell.test.ts
bunx vitest run tests/ui/cityPanel.test.ts
bun run test:unit
bun run check
bun run lint
bun run format:check
```

Expected: PASS.

- [ ] **Step 10: Commit Tasks 2-3 atomically**

```bash
git add \
  src/App.svelte \
  src/components/hud/panels/CityPanel.svelte \
  tests/ui/appShell.test.ts \
  tests/ui/cityPanel.test.ts \
  src/styles.css
git commit -m "feat: add city working-save workflow"
```

---

## Task 4: Prove changed gameplay survives Save/reload/Continue and update architecture docs

**Files:**
- Create: `tests/e2e/cityLibrary.spec.ts`
- Modify: `docs/architecture.md`

**Interfaces:**

Reuse:

```ts
createDefaultCity(page, name)
selectBuildLeaf(page, group, item)
dragMapTiles(page, canvas, from, to)
clickMapTile(canvas, tile)
openCommandDestination(page, destination)
```

### Steps

- [ ] **Step 1: Add the real Save proof with an exact dirty-state assertion**

Create `tests/e2e/cityLibrary.spec.ts`:

```ts
import { expect, test } from "@playwright/test";
import {
  clickMapTile,
  createDefaultCity,
  dragMapTiles,
  openCommandDestination,
  selectBuildLeaf,
} from "./helpers";

test("Save Now persists changed gameplay through reload and Continue", async ({
  page,
}) => {
  await createDefaultCity(page, "Reload Junction");

  const topbar = page.getByTestId("topbar");
  await expect(topbar.getByText("$120,000")).toBeVisible();

  const canvas = page.locator("canvas[data-runtime-canvas='true']");
  await selectBuildLeaf(page, "zones", "residential");
  await dragMapTiles(page, canvas, { x: 1, y: 1 }, { x: 2, y: 1 });

  await selectBuildLeaf(page, "buildings", "smallHouse");
  await clickMapTile(canvas, { x: 1, y: 1 });
  await expect(topbar.getByText("$116,000")).toBeVisible();

  await openCommandDestination(page, "city");
  const cityPanel = page.getByTestId("panel-city");
  const saveStatus = cityPanel.getByTestId("city-save-status");
  await expect(saveStatus).toHaveAttribute("data-dirty", "true");

  await cityPanel.getByRole("button", { name: "Save Now" }).click();
  await expect(saveStatus).toHaveAttribute("data-dirty", "false");

  await page.reload();

  await expect(page.getByTestId("city-library-screen")).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Rename Reload Junction" }),
  ).toHaveValue("Reload Junction");
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByTestId("game-canvas-host")).toBeVisible();
  await expect(page.getByTestId("topbar").getByText("$116,000")).toBeVisible();

  await openCommandDestination(page, "city");
  await expect(page.getByTestId("active-city-name")).toHaveText(
    "Reload Junction",
  );
});
```

Why the proof is meaningful:

- New City already persists the initial `$120,000` snapshot.
- The small house creates a known `$116,000` post-create snapshot and marks dirty.
- `data-dirty="false"` proves the UI observed save success without substring matching `Saved` inside `Unsaved changes`.
- A no-op Save reloads `$120,000`, so the post-Continue budget assertion fails.
- The city is located by its accessible name, not by assuming an opaque generated city ID.

- [ ] **Step 2: Run the focused Playwright test**

```bash
bun run test:e2e -- tests/e2e/cityLibrary.spec.ts
```

Expected: PASS.

- [ ] **Step 3: Update architecture docs**

In `docs/architecture.md` record:

```text
startup
  -> runtime.persistence.listCities()
  -> empty: New City
  -> list failure: Retry city list OR New City
  -> existing: City Library
       -> Continue / Load / inline Rename / Delete? / New City
  -> active game shell
       -> City panel: Save Now / city list / New City
```

Also keep:

```text
UI -> RuntimePersistenceController -> CitySaveStore
browser store: IndexedDB
native Tauri store: temporary memory adapter until HPA-344
final cross-host smoke: HPA-349
```

- [ ] **Step 4: Run the final HPA-346 repository gate**

```bash
bun run test
bun run check
bun run lint
bun run format:check
bun run build
bun run test:e2e
```

Expected: every command exits successfully.

Do not add `bun run tauri:build` as a required HPA-346 local gate. No Rust, Tauri command, native-store, or host-selection code changes in this slice. Existing CI may package Tauri independently.

- [ ] **Step 5: Verify exact implementation scope**

```bash
git diff --name-only main...HEAD
```

Expected implementation scope:

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
tests/ui/cityPanel.test.ts
```

- [ ] **Step 6: Commit browser proof and docs**

```bash
git add tests/e2e/cityLibrary.spec.ts docs/architecture.md
git commit -m "test: prove city working-save reload flow"
```

---

## Risks and controls

### Risk: stale city-list response overwrites a newer refresh

`listCities()` is outside the mutation busy gate, so retries and post-mutation refreshes may overlap.

**Control:** one `cityListRequestId` latest-wins check in `refreshCities()`. No queue, abort controller, polling, or background synchronization.

### Risk: active delete briefly exposes a phantom deleted city

The runtime publishes `activeCity: null` before the delete caller starts its list refresh.

**Control:** if deleting the active city, set the App list projection to `null` before invoking delete. The no-active branch then shows loading until the store supplies the authoritative list. If delete fails, refresh the list to restore the projection.

### Risk: Save E2E passes on create-time persistence

New City already commits a save record.

**Control:** mutate to a known `$116,000` state before Save and assert `$116,000` after reload/Continue.

### Risk: dirty->saved text assertion matches the wrong status

Playwright string text locators are non-exact by default.

**Control:** assert `city-save-status[data-dirty="true|false"]`, not `getByText("Saved")`.

### Risk: old CityPanel tests preserve a removed contract

The current tests require `cityName` and assert persistence controls are absent.

**Control:** migrate the overview test and delete obsolete fallback/absence tests in the same cutover.

---

## Plan Self-Review

### Spec coverage

- City list and row interaction: Task 1.
- List error + New City fallback: Task 2.
- Latest-wins read concurrency: Task 2.
- Continue/Load: Task 2 plus Task 4 browser proof.
- Save Now/dirty state: Task 3 plus Task 4.
- Rename active/inactive: Task 1 shared row + Task 3 App handler.
- Delete active/inactive: Task 1 shared row + Task 3 handler/tests.
- Active-delete loading/no phantom row: Task 3.
- Final slot -> New City: Task 3.
- Existing city remains -> City Library: Task 3.
- CityPanel old-test cutover: Task 3.
- Real changed-snapshot persistence: Task 4.
- Native durability/cross-host flow: excluded for HPA-344/HPA-349.

### Placeholder scan

There are no `TBD`/`TODO` markers, compatibility shims, generic “add error handling” steps, or incomplete test bodies. All added test hooks and identifiers are specified in implementation steps.

### Type/identifier consistency

- `CitySummary` comes from `src/persistence/citySaveStore.ts`.
- `RuntimePersistenceController` remains unchanged.
- Harness default summary data is derived after the local `persistence` snapshot view is initialized and before the `runtime` object is constructed.
- `cityError` is the only combined error identifier used by library/panel.
- `cityListRequestId` is the only list-read race guard.
- `city-library-screen`, `city-row-${id}`, `city-name-${id}`, `city-save-status`, and `active-city-name` are explicitly implemented before tests use them.
- App harness persistence methods all resolve valid default `WorkingSaveResult`s.
- Active panel tests include the active city in their list fixtures.
- Active-delete tests publish `activeCity: null` before resolving the post-delete list read.

### Verification consistency

- Single Vitest files use `bunx vitest run <file>` per `CLAUDE.md`.
- Task 1 CSS changes run `bun run lint` immediately.
- Final local gate excludes `tauri:build` because HPA-346 changes no native host/storage code.
