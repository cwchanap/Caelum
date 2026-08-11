# HPA-346 City Library and Working-Save Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the browser Phase 1 working-save loop with city listing, Continue/Load, Save Now, Rename, Delete, and New City entry while keeping the existing six-operation persistence runtime unchanged.

**Architecture:** `workingSaveRuntime` remains the single owner of active-city identity, busy state, dirty state, and persistence mutation errors. `App.svelte` adds only a UI-local `CitySummary[] | null` read projection plus a list-read error, refreshes it through `runtime.persistence.listCities()`, and passes explicit callbacks to a shared city list, a full-screen library, and the existing City panel. Browser persistence stays on IndexedDB; HPA-344 still owns replacing Tauri's temporary memory store with native files.

**Tech Stack:** TypeScript 5.8, Svelte 5, existing `RuntimePersistenceController`, existing `CitySaveStore` / `CitySummary`, Vitest + Testing Library, Playwright/Chromium, Rust/WASM gameplay backend, browser IndexedDB.

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
- A Retry control is shown only for a failed `listCities()` read. Save/Load/Rename/Delete failures remain retryable through their original action buttons.
- A successful empty city list routes directly to `NewCityScreen`; do not build unreachable empty-library chrome.
- The browser E2E proof must mutate gameplay before Save and assert the post-save mutation after reload/Continue; create-time persistence alone is not sufficient evidence.
- Do not require local `bun run tauri:build` for HPA-346. HPA-344 owns native durability and HPA-349 owns the representative native workflow.
- Add no autosave, checkpoints, recovery, duplicate-city, folders, tags, search, thumbnails, import/export, cloud sync, migration, compatibility, multi-instance ownership, security hardening, or new dependency.

---

## Task 1: Add the reusable city list and thin library screen

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

`App.svelte` calls `CityLibraryScreen` only for `cities === null` (loading/list error) or a non-empty list. A successful `[]` bypasses the component and renders `NewCityScreen` directly.

### Steps

- [ ] **Step 1: Write CityList behavior tests red-first**

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

- [ ] **Step 2: Run the CityList test red**

```bash
bun run test -- tests/ui/cityList.test.ts
```

Expected: FAIL because `CityList.svelte` does not exist.

- [ ] **Step 3: Implement CityList with row-local state only**

Use exactly three transient values:

```ts
let editingCityId = $state<string | null>(null);
let renameValue = $state("");
let confirmingDeleteId = $state<string | null>(null);
```

Rename submission:

```ts
function submitRename(cityId: string, event: SubmitEvent): void {
  event.preventDefault();
  const name = renameValue.trim();
  if (busy || name.length === 0) return;
  onRename(cityId, name);
  editingCityId = null;
  renameValue = "";
}
```

Delete confirmation:

```ts
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
```

For every row render:

- city name;
- `<time datetime={city.savedAt}>` with compact `Intl.DateTimeFormat` display;
- `Active` for `activeCityId`, otherwise accessible `Load ${city.name}`;
- Rename;
- Delete -> Confirm delete.

Do not sort `cities` and do not add created-time/template/economy metadata.

- [ ] **Step 4: Implement CityLibraryScreen without empty-list chrome**

Render only two meaningful states:

```svelte
{#if cities === null}
  {#if error === null}<p>Loading cities…</p>{/if}
{:else if cities[0] !== undefined}
  {@const firstCity = cities[0]}
  <div class="city-library-actions">
    <button type="button" disabled={busy} onclick={() => onContinue(firstCity.id)}>
      Continue
    </button>
    <button type="button" disabled={busy} onclick={onNewCity}>New City</button>
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
```

Above that, show `error` and optional `Retry city list` when `onRetry` is supplied.

Do **not** render:

- disabled Continue for `cities.length === 0`;
- `No saved cities`;
- a second New City empty-state flow.

Successful empty storage is an App concern and goes straight to `NewCityScreen`.

- [ ] **Step 5: Extend NewCityScreen with optional Cancel only**

```ts
interface Props {
  busy: boolean;
  error: string | null;
  onCreate: (request: NewCityRequest) => void;
  onCancel?: () => void;
}
```

After the existing Create City button:

```svelte
{#if onCancel !== undefined}
  <button type="button" disabled={busy} onclick={onCancel}>Cancel</button>
{/if}
```

Do not change New City defaults or request shape.

- [ ] **Step 6: Add only scoped styles**

Add styles for:

```text
.city-library-screen
.city-library-card
.city-library-actions
.city-list
.city-list-row
.city-list-meta
.city-list-actions
.city-list-rename
```

Reuse existing New City / Signal Console tokens and spacing. Do not extract a design system.

- [ ] **Step 7: Run focused UI verification and commit Task 1**

```bash
bun run test -- tests/ui/cityList.test.ts
bun run check
bun run format:check
git add \
  src/components/city/CityList.svelte \
  src/components/city/CityLibraryScreen.svelte \
  src/components/NewCityScreen.svelte \
  tests/ui/cityList.test.ts \
  src/styles.css
git commit -m "feat: add city library components"
```

Expected: PASS before commit.

---

## Task 2: Add App-local city-list loading and Continue/Load orchestration

**Files:**
- Modify: `src/App.svelte`
- Modify: `tests/ui/appShell.test.ts`

**Interfaces:**

Reuse only:

```ts
runtime.persistence.listCities()
runtime.persistence.load(cityId)
runtime.persistence.createCity(request)
```

Task 2 intentionally does **not** commit by itself. Task 3 completes the City-panel mutations and Tasks 2-3 commit together so App never lands with partial working-save wiring.

### Steps

- [ ] **Step 1: Add deterministic CitySummary fixtures to the App harness**

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

Extend harness options:

```ts
cities?: CitySummary[];
listCitiesResult?: WorkingSaveResult<CitySummary[]>;
```

Default `listCities` to the supplied list, or to `[activeCity]` when active, otherwise `[]`:

```ts
const defaultCities =
  options.cities ?? (persistence.activeCity === null ? [] : [persistence.activeCity]);

listCities: vi.fn(async () =>
  options.listCitiesResult ?? { ok: true as const, value: defaultCities },
),
```

Keep Save/Load/Rename/Delete as explicit spies; do not make the harness implement the persistence runtime.

- [ ] **Step 2: Migrate existing HPA-345 no-city tests to await the initial list read**

The old test may synchronously query `new-city-screen`; HPA-346 adds one async `listCities()` step first.

Use:

```ts
render(App, { props: { runtime } });
expect(await screen.findByTestId("new-city-screen")).toBeVisible();
```

Update the existing submit/busy/error/activation tests similarly wherever they start with `activeCity: null`.

- [ ] **Step 3: Add red App tests for saved-library and Continue behavior**

```ts
it("shows City Library when saved cities exist and no city is active", async () => {
  const { runtime } = createRuntimeHarness({
    persistence: { activeCity: null },
    cities: [CITY_NEW, CITY_OLD],
  });
  render(App, { props: { runtime } });

  expect(await screen.findByTestId("city-library-screen")).toBeVisible();
  expect(screen.getByText("Maple Junction")).toBeVisible();
  expect(screen.queryByTestId("new-city-screen")).toBeNull();
});

it("continues the first store-ordered city", async () => {
  const harness = createRuntimeHarness({
    persistence: { activeCity: null },
    cities: [CITY_NEW, CITY_OLD],
  });
  harness.runtime.persistence.load = vi.fn(async () => ({
    ok: true as const,
    value: CITY_NEW,
  }));

  render(App, { props: { runtime: harness.runtime } });
  await fireEvent.click(await screen.findByRole("button", { name: "Continue" }));

  expect(harness.runtime.persistence.load).toHaveBeenCalledWith("city-new");
});
```

- [ ] **Step 4: Add list failure / Retry coverage**

Use a mutable list spy so Retry can succeed:

```ts
it("shows concise list failure and retries only the list read", async () => {
  const harness = createRuntimeHarness({ persistence: { activeCity: null } });
  harness.runtime.persistence.listCities = vi
    .fn()
    .mockResolvedValueOnce({
      ok: false as const,
      error: {
        kind: "store" as const,
        error: {
          operation: "listCities" as const,
          code: "failed" as const,
          diagnostic: "private IndexedDB detail",
        },
      },
    })
    .mockResolvedValueOnce({ ok: true as const, value: [CITY_NEW] });

  render(App, { props: { runtime: harness.runtime } });

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("Could not load the city list.");
  expect(alert).not.toHaveTextContent("private IndexedDB detail");

  await fireEvent.click(screen.getByRole("button", { name: "Retry city list" }));
  expect(await screen.findByText("Maple Junction")).toBeVisible();
  expect(harness.runtime.persistence.listCities).toHaveBeenCalledTimes(2);
});
```

- [ ] **Step 5: Add App-local read/presentation state**

In `App.svelte` import `CitySummary` and `CityLibraryScreen`, then add:

```ts
let cities = $state<CitySummary[] | null>(null);
let cityListError = $state<string | null>(null);
let showNewCity = $state(false);
```

Add:

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

Call `void refreshCities()` from the existing successful `onMount` runtime setup after subscription/start initialization.

- [ ] **Step 6: Make create/load handlers explicit**

Replace the fire-and-forget New City handler with:

```ts
async function handleCreateCity(request: NewCityRequest): Promise<void> {
  if (runtime === null) return;
  cityListError = null;
  const result = await runtime.persistence.createCity(request);
  if (result.ok) {
    showNewCity = false;
    await refreshCities();
  }
}

async function handleLoadCity(cityId: string): Promise<void> {
  if (runtime === null) return;
  cityListError = null;
  await runtime.persistence.load(cityId);
}
```

No generic persistence action runner.

- [ ] **Step 7: Replace the no-active render branch**

Use the following priority:

```text
fatal/runtime unavailable
showNewCity
active city
no active + cities === null -> CityLibrary loading/error
no active + cities.length === 0 -> NewCityScreen
no active + cities.length > 0 -> CityLibraryScreen
```

The successful empty case must render only the existing New City experience.

For `CityLibraryScreen`, pass:

```svelte
<CityLibraryScreen
  {cities}
  activeCityId={snapshot?.persistence.activeCity?.id ?? null}
  busy={snapshot?.persistence.busy ?? false}
  error={cityListError ?? runtimePersistenceError}
  onContinue={(cityId) => void handleLoadCity(cityId)}
  onLoad={(cityId) => void handleLoadCity(cityId)}
  onRename={(cityId, name) => void handleRenameCity(cityId, name)}
  onDelete={(cityId) => void handleDeleteCity(cityId)}
  onNewCity={() => (showNewCity = true)}
  onRetry={cityListError === null ? undefined : () => void refreshCities()}
/>
```

`handleRenameCity` / `handleDeleteCity` are added in Task 3 before the combined commit.

- [ ] **Step 8: Run App tests red/partially green but do not commit yet**

```bash
bun run test -- tests/ui/appShell.test.ts
bun run check
```

Expected before Task 3: library/Continue tests can pass, but the complete file may remain red until CityPanel mutations are wired. Continue directly to Task 3.

---

## Task 3: Add Save/Rename/Delete/New City controls to the active City panel

**Files:**
- Modify: `src/App.svelte`
- Modify: `src/components/hud/panels/CityPanel.svelte`
- Modify: `tests/ui/appShell.test.ts`
- Modify: `src/styles.css`

### Steps

- [ ] **Step 1: Add active-panel tests before implementation**

Cover the current active city and one inactive city with `[CITY_NEW, CITY_OLD]`.

Save + dirty:

```ts
it("shows dirty state and invokes Save Now", async () => {
  const harness = createRuntimeHarness({
    persistence: { activeCity: CITY_NEW, dirty: true },
    cities: [CITY_NEW, CITY_OLD],
  });
  harness.runtime.persistence.save = vi.fn(async () => ({
    ok: true as const,
    value: CITY_NEW,
  }));

  render(App, { props: { runtime: harness.runtime } });
  await fireEvent.click(screen.getByTestId("command-destination-city"));

  expect(screen.getByText("Unsaved changes")).toBeVisible();
  await fireEvent.click(screen.getByRole("button", { name: "Save Now" }));
  expect(harness.runtime.persistence.save).toHaveBeenCalledTimes(1);
});
```

New City + Cancel:

```ts
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
```

Rename/delete selected ID:

```ts
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
```

- [ ] **Step 2: Keep the two active-delete destination branches distinct**

First, preserve a test with another city remaining:

```ts
it("returns to City Library after deleting the active city when another city remains", async () => {
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
    within(activeRow).getByRole("button", { name: "Confirm delete Maple Junction" }),
  );

  harness.setPersistence({ activeCity: null, busy: false, dirty: false });
  expect(await screen.findByTestId("city-library-screen")).toBeVisible();
});
```

Then add the missing last-slot branch. Override the list spy **before render** so the initial read returns the sole city and the post-delete refresh returns empty:

```ts
it("returns directly to New City after deleting the final active city", async () => {
  const harness = createRuntimeHarness({
    persistence: { activeCity: CITY_NEW },
    cities: [CITY_NEW],
  });
  harness.runtime.persistence.listCities = vi
    .fn()
    .mockResolvedValueOnce({ ok: true as const, value: [CITY_NEW] })
    .mockResolvedValueOnce({ ok: true as const, value: [] });
  harness.runtime.persistence.deleteCity = vi.fn(async () => ({
    ok: true as const,
    value: undefined,
  }));

  render(App, { props: { runtime: harness.runtime } });
  await fireEvent.click(screen.getByTestId("command-destination-city"));

  const row = await screen.findByTestId("city-row-city-new");
  await fireEvent.click(
    within(row).getByRole("button", { name: "Delete Maple Junction" }),
  );
  await fireEvent.click(
    within(row).getByRole("button", { name: "Confirm delete Maple Junction" }),
  );

  await waitFor(() => {
    expect(harness.runtime.persistence.listCities).toHaveBeenCalledTimes(2);
  });
  harness.setPersistence({ activeCity: null, busy: false, dirty: false });

  expect(await screen.findByTestId("new-city-screen")).toBeVisible();
  expect(screen.queryByTestId("city-library-screen")).toBeNull();
});
```

Import `waitFor` in `appShell.test.ts` if it is not already present.

- [ ] **Step 3: Add busy and failed-load UI coverage**

Busy should disable:

- Save Now / Working…;
- New City;
- inactive Load;
- Rename/Delete controls.

For failed Load, mock `runtime.persistence.load()` to return a backend error, publish the same persistence error through the harness, and assert:

```ts
expect(screen.getByTestId("game-canvas-host")).toBeVisible();
expect(screen.getByRole("alert")).toHaveTextContent(
  "Could not apply the city state.",
);
expect(
  screen.queryByRole("button", { name: "Retry city list" }),
).toBeNull();
```

- [ ] **Step 4: Add explicit mutation handlers to App**

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

No optimistic list edits and no generic action runner.

- [ ] **Step 5: Expand CityPanel props**

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

Render:

```svelte
<h2 data-testid="active-city-name">{activeCity.name}</h2>
<p class="brief-id">{shell.title}</p>

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

Keep the existing overview `<dl>`. After it, render `CityList` when `cities !== null`.

- [ ] **Step 6: Pass non-null active data/callbacks from App**

Inside the already-active shell branch:

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

- [ ] **Step 7: Run the combined UI gate and commit Tasks 2-3 together**

```bash
bun run test -- tests/ui/cityList.test.ts tests/ui/appShell.test.ts
bun run test:unit
bun run check
bun run lint
bun run format:check
```

Expected: PASS.

Then:

```bash
git add \
  src/App.svelte \
  src/components/hud/panels/CityPanel.svelte \
  tests/ui/appShell.test.ts \
  src/styles.css
git commit -m "feat: add city working-save workflow"
```

---

## Task 4: Prove a changed snapshot survives Save/reload/Continue

**Files:**
- Create: `tests/e2e/cityLibrary.spec.ts`
- Modify: `docs/architecture.md`

**Interfaces:**

Reuse the existing E2E helpers:

```ts
createDefaultCity(page, name)
selectBuildLeaf(page, group, item)
dragMapTiles(page, canvas, from, to)
clickMapTile(canvas, tile)
openCommandDestination(page, destination)
```

Do not create a direct IndexedDB inspection helper; HPA-343/HPA-345 already cover adapter-level persistence acceptance.

### Steps

- [ ] **Step 1: Write the real Save proof**

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
  await expect(cityPanel.getByText("Unsaved changes")).toBeVisible();

  await cityPanel.getByRole("button", { name: "Save Now" }).click();
  await expect(cityPanel.getByText("Saved")).toBeVisible();

  await page.reload();

  await expect(page.getByTestId("city-library-screen")).toBeVisible();
  await expect(page.getByText("Reload Junction")).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByTestId("game-canvas-host")).toBeVisible();
  await expect(page.getByTestId("topbar").getByText("$116,000")).toBeVisible();

  await openCommandDestination(page, "city");
  await expect(page.getByTestId("active-city-name")).toHaveText(
    "Reload Junction",
  );
});
```

Why this is the required proof:

- New City already stores the initial `$120,000` snapshot.
- The small house creates a known post-create gameplay state at `$116,000` and marks the runtime dirty.
- If Save Now is a no-op, reload/Continue restores `$120,000`, so the final assertion fails.
- The test also proves dirty -> Saved UI transition around the real runtime save.

Use the coordinates already exercised by `tests/e2e/smoke.spec.ts`; do not invent a new scenario fixture.

- [ ] **Step 2: Run the focused E2E test**

```bash
bun run test:e2e -- tests/e2e/cityLibrary.spec.ts
```

Expected: PASS.

- [ ] **Step 3: Update architecture documentation**

In `docs/architecture.md`, describe:

```text
startup
  -> runtime.persistence.listCities()
  -> empty: New City
  -> existing: City Library
       -> Continue / Load / Rename / Delete / New City
  -> active game shell
       -> City panel: Save Now / city list / New City
```

Keep:

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

Do **not** add `bun run tauri:build` as a required local HPA-346 gate. No Rust, Tauri command, native store, or host-selection code changes in this slice. An existing CI packaging job may still run independently.

- [ ] **Step 5: Verify scope and commit**

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
```

Then:

```bash
git add tests/e2e/cityLibrary.spec.ts docs/architecture.md
git commit -m "test: prove city working-save reload flow"
```

---

## Plan Self-Review

### Spec coverage

- City list: Tasks 1-3.
- Continue/Load: Task 2 plus Task 4 browser proof.
- Save Now: Task 3 plus the mutate/save/reload proof in Task 4.
- Rename active/inactive: shared CityList in Tasks 1 and 3.
- Delete active/inactive with one confirmation: shared CityList in Tasks 1 and 3.
- Last active city deletion -> New City: dedicated Task 3 test.
- New City from saved-library/active-game surfaces: Tasks 2-3, reusing `NewCityScreen`.
- Busy behavior: Tasks 1 and 3.
- Dirty presentation: Task 3 plus real dirty->Saved E2E proof.
- List/runtime error copy: Tasks 2-3 reuse `workingSaveErrorMessage`; only list failures expose a list Retry control.
- Real browser changed-snapshot persistence: Task 4.
- Native persistence: explicitly remains HPA-344.
- Native representative workflow: explicitly remains HPA-349.

### Review amendments incorporated

1. **Save proof strengthened:** Task 4 now paints residential area, builds a small house, proves `Unsaved changes`, saves to `Saved`, reloads, Continues, and verifies `$116,000`. Create-time persistence cannot false-pass this test.
2. **Dead empty-library UI removed:** successful `[]` is App-owned and renders New City; City Library has no `No saved cities`/disabled-Continue branch.
3. **Last-slot deletion covered:** a dedicated App test returns `listCities() -> []` after deleting the sole active city and asserts `new-city-screen`.
4. **Native packaging gate trimmed:** `tauri:build` is not a required HPA-346 local gate; HPA-344/HPA-349 retain native responsibilities.

### Placeholder scan

Every new behavior has a concrete file, test, and action. There are no `TBD`/`TODO` markers, compatibility shims, generic “add error handling” steps, or incomplete test bodies.

### Type and fixture consistency

- `CitySummary` is reused from `src/persistence/citySaveStore.ts`.
- `RuntimePersistenceController` remains unchanged.
- Active-panel tests explicitly include the active city in their list fixtures.
- The final-city delete test controls both initial and refreshed `listCities()` results.
- Existing no-active New City tests await the initial list read.
- `CityPanel.activeCity` is passed only under an explicit non-null guard.
- `cities: CitySummary[] | null` uses `null` only for initial/pending list reads; it is not a second persistence lifecycle state.
