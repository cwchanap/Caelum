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
- Modify: `tests/ui/appShell.test.ts`
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

- [ ] **Step 1: Write the CityList interaction tests first**

Create `tests/ui/cityList.test.ts` with two deterministic summaries:

```ts
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
```

Cover these behaviors with Testing Library:

```ts
it("loads only inactive rows", async () => {
  const onLoad = vi.fn();
  render(CityList, {
    props: {
      cities: CITIES,
      activeCityId: "city-new",
      busy: false,
      onLoad,
      onRename: vi.fn(),
      onDelete: vi.fn(),
    },
  });

  expect(screen.getByText("Active")).toBeVisible();
  await fireEvent.click(screen.getByRole("button", { name: "Load Harbour City" }));
  expect(onLoad).toHaveBeenCalledWith("city-old");
});
```

```ts
it("trims rename and rejects an empty name", async () => {
  const onRename = vi.fn();
  // render, click Rename Maple Junction, clear/fill the input, submit
  // first submit with whitespace: expect no callback
  // second submit with "  Maple Central  ":
  expect(onRename).toHaveBeenCalledWith("city-new", "Maple Central");
});
```

```ts
it("requires a second click to confirm delete", async () => {
  const onDelete = vi.fn();
  // first click "Delete Harbour City": callback remains untouched
  // second click "Confirm delete Harbour City":
  expect(onDelete).toHaveBeenCalledWith("city-old");
});
```

```ts
it("disables mutating controls while busy", () => {
  // render with busy: true and assert Load/Rename/Delete buttons are disabled
});
```

- [ ] **Step 2: Run the new component tests red**

```bash
bun run test -- tests/ui/cityList.test.ts
```

Expected: FAIL because `CityList.svelte` does not exist.

- [ ] **Step 3: Implement `CityList.svelte` with only row-local transient state**

Use:

```ts
let editingCityId = $state<string | null>(null);
let renameValue = $state("");
let confirmingDeleteId = $state<string | null>(null);
```

Start rename with:

```ts
function startRename(city: CitySummary): void {
  editingCityId = city.id;
  renameValue = city.name;
  confirmingDeleteId = null;
}
```

Submit rename with:

```ts
function submitRename(cityId: string, event: SubmitEvent): void {
  event.preventDefault();
  const trimmed = renameValue.trim();
  if (busy || trimmed.length === 0) return;
  onRename(cityId, trimmed);
  editingCityId = null;
  renameValue = "";
}
```

Require inline delete confirmation:

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
}
```

For each row:

- render the name;
- render `<time datetime={city.savedAt}>` for last-saved time;
- render `Active` when `city.id === activeCityId`, otherwise an accessible `Load ${city.name}` button;
- render `Rename ${city.name}`;
- render `Delete ${city.name}` then `Confirm delete ${city.name}` when armed.

Use a small `Intl.DateTimeFormat` in the component for display only. Tests must target roles/`datetime`, not locale-specific rendered date text.

- [ ] **Step 4: Implement `CityLibraryScreen.svelte` as a thin wrapper around CityList**

Render:

```svelte
<main class="city-library-screen" data-testid="city-library-screen">
  <section class="city-library-card">
    <p class="new-city-kicker">CAELUM // LOCAL CITIES</p>
    <h1>City Library</h1>

    {#if error !== null}
      <p role="alert">{error}</p>
      <button type="button" onclick={onRetry}>Retry</button>
    {/if}

    {#if cities === null}
      <p>Loading cities…</p>
    {:else}
      <div class="city-library-actions">
        <button
          type="button"
          disabled={busy || cities.length === 0}
          onclick={() => cities[0] && onContinue(cities[0].id)}
        >Continue</button>
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
  </section>
</main>
```

Do not put list fetching or runtime/store imports into this component.

- [ ] **Step 5: Add optional Cancel to the existing NewCityScreen**

Change props to:

```ts
let { busy, error, onCreate, onCancel }: Props = $props();
```

Below Create City render:

```svelte
{#if onCancel !== undefined}
  <button type="button" disabled={busy} onclick={onCancel}>Cancel</button>
{/if}
```

Do not change the current name/economy/template request shape or defaults.

- [ ] **Step 6: Add focused New City cancel coverage to `appShell.test.ts`**

Keep the existing no-city tests. Add a direct `NewCityScreen`/App path assertion later in Task 2 once `showNewCity` is wired; at this task boundary, only update any prop typings needed for the optional callback.

- [ ] **Step 7: Add minimal city-library/list styles**

In `src/styles.css`, reuse the existing New City card spacing/typography where practical. Add only scoped selectors for:

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

Keep the command-panel footprint compact. Do not extract a new design system.

- [ ] **Step 8: Run focused UI verification**

```bash
bun run test -- tests/ui/cityList.test.ts tests/ui/appShell.test.ts
bun run check
```

Expected: PASS.

- [ ] **Step 9: Commit the reusable city-library UI**

```bash
git add \
  src/components/city/CityList.svelte \
  src/components/city/CityLibraryScreen.svelte \
  src/components/NewCityScreen.svelte \
  tests/ui/cityList.test.ts \
  tests/ui/appShell.test.ts \
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

Consumes existing runtime methods only:

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

- [ ] **Step 1: Make the App test harness return a real list result by default**

Extend `createRuntimeHarness` options:

```ts
cities?: CitySummary[];
listCitiesResult?: WorkingSaveResult<CitySummary[]>;
```

Default to the current active city summary when one exists, otherwise `[]`:

```ts
const defaultCities =
  options.cities ?? (persistence.activeCity === null ? [] : [persistence.activeCity]);
```

Change the persistence mock from a bare `vi.fn()` to:

```ts
listCities: vi.fn(async () =>
  options.listCitiesResult ?? { ok: true as const, value: defaultCities },
),
```

Keep the other persistence methods as spies unless a test needs a resolved value.

This prevents the new initial App refresh from calling `.ok` on `undefined` in unrelated shell tests.

- [ ] **Step 2: Add failing App integration tests for the no-active-city branches**

Add:

```ts
it("shows the library when saved cities exist but no city is active", async () => {
  const { runtime } = createRuntimeHarness({
    persistence: { activeCity: null },
    cities: [CITY_NEW, CITY_OLD],
  });

  render(App, { props: { runtime } });
  await screen.findByTestId("city-library-screen");

  expect(screen.getByText("Maple Junction")).toBeVisible();
  expect(screen.queryByTestId("new-city-screen")).toBeNull();
});
```

```ts
it("continues the first already-sorted city", async () => {
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

Add a list failure/Retry test using:

```ts
listCitiesResult: {
  ok: false,
  error: {
    kind: "store",
    error: { operation: "listCities", code: "failed", diagnostic: "private" },
  },
}
```

Assert the alert contains `Could not load the city list.` and excludes `private`; Retry calls `listCities` again.

- [ ] **Step 3: Add failing active-panel action tests**

Cover:

- Save Now invokes `runtime.persistence.save()`;
- clicking New City hides the game shell and shows `NewCityScreen` with Cancel;
- Cancel returns to the game shell without a persistence call;
- Load/Rename/Delete from the City panel use the selected city ID;
- busy disables city mutation controls;
- `dirty: true` displays `Unsaved changes`;
- publishing `activeCity: null` after active delete returns to the library;
- a failed Load result plus unchanged active persistence state leaves `game-canvas-host` visible and shows mapped error copy in the City panel.

Use the existing `setPersistence()` harness method to publish runtime state transitions rather than teaching the mock persistence methods a second runtime implementation.

- [ ] **Step 4: Run the App tests red**

```bash
bun run test -- tests/ui/appShell.test.ts
```

Expected: FAIL because App still renders New City whenever no active city exists and CityPanel has no persistence actions.

- [ ] **Step 5: Add UI-local list state and imports to App**

Import:

```ts
import CityLibraryScreen from "./components/city/CityLibraryScreen.svelte";
import type { CitySummary } from "./persistence/citySaveStore";
```

Add state:

```ts
let cities = $state<CitySummary[] | null>(null);
let cityListError = $state<string | null>(null);
let showNewCity = $state(false);
```

Add a derived player error:

```ts
const cityActionError = $derived(
  cityListError ??
    (snapshot?.persistence.error == null
      ? null
      : workingSaveErrorMessage(snapshot.persistence.error)),
);
```

- [ ] **Step 6: Add the one read helper without a generic action framework**

Implement:

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

Do not call `sortCitySummaries()` here; the store contract already owns ordering.

- [ ] **Step 7: Make the existing New City handler await the result and refresh on success**

Replace the fire-and-forget handler with:

```ts
async function handleCreateCity(request: NewCityRequest): Promise<void> {
  if (runtime === null) return;
  const result = await runtime.persistence.createCity(request);
  if (!result.ok) return;
  showNewCity = false;
  await refreshCities();
}
```

Pass it as:

```svelte
onCreate={(request) => void handleCreateCity(request)}
```

- [ ] **Step 8: Add explicit Save/Load/Rename/Delete handlers**

Use separate functions:

```ts
async function handleSaveCity(): Promise<void> {
  if (runtime === null) return;
  const result = await runtime.persistence.save();
  if (result.ok) await refreshCities();
}
```

```ts
async function handleLoadCity(cityId: string): Promise<void> {
  if (runtime === null) return;
  const result = await runtime.persistence.load(cityId);
  if (result.ok) showNewCity = false;
}
```

```ts
async function handleRenameCity(cityId: string, name: string): Promise<void> {
  if (runtime === null) return;
  const result = await runtime.persistence.renameCity(cityId, name);
  if (result.ok) await refreshCities();
}
```

```ts
async function handleDeleteCity(cityId: string): Promise<void> {
  if (runtime === null) return;
  const result = await runtime.persistence.deleteCity(cityId);
  if (result.ok) await refreshCities();
}
```

No optimistic list edits are needed.

- [ ] **Step 9: Refresh the list from the existing mount lifecycle**

In the current `onMount` block, after subscribing and calling `runtime.start()`, add:

```ts
void refreshCities();
```

Keep the existing unsubscribe + synchronous `runtime.dispose()` cleanup unchanged.

Do not add polling, storage events, or a second lifecycle hook.

- [ ] **Step 10: Replace the no-active-city render branch with loading/library/empty behavior**

Preserve the fatal branch first, then use:

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
  <!-- existing game shell -->
```

The initial `cities === null` state therefore renders `CityLibraryScreen`'s loading state instead of flashing the empty New City form.

- [ ] **Step 11: Expand CityPanel props without giving it the runtime/store**

Change `CityPanel.svelte` to import:

```ts
import type { CitySummary } from "../../../persistence/citySaveStore";
import CityList from "../../city/CityList.svelte";
```

Replace `cityName` with the explicit active summary and callbacks defined in this task's interface.

Keep the existing city overview, then add:

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
```

Render runtime error copy when non-null and render `CityList` when `cities !== null`:

```svelte
{#if error !== null}
  <p class="city-action-error" role="alert">{error}</p>
{/if}

{#if cities !== null}
  <CityList
    {cities}
    activeCityId={activeCity.id}
    {busy}
    {onLoad}
    {onRename}
    {onDelete}
  />
{/if}
```

Do not add another fetch layer inside CityPanel.

- [ ] **Step 12: Pass the city workflow into the existing City command panel**

At the existing `CityPanel` call in `App.svelte`, pass:

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

The active branch proves `activeCity` is non-null; do not add a duplicate null fallback inside CityPanel.

- [ ] **Step 13: Add compact City-panel styles only**

In `src/styles.css`, add scoped rules for:

```text
.city-save-status
.city-actions
.city-action-error
```

Reuse the CityList styles from Task 1.

- [ ] **Step 14: Run focused tests and the complete frontend unit/type gate**

```bash
bun run test -- tests/ui/cityList.test.ts tests/ui/appShell.test.ts
bun run test:unit
bun run check
```

Expected: PASS.

- [ ] **Step 15: Commit the working-save UI wiring**

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

Reuses:

```ts
createDefaultCity(page, name)
```

from `tests/e2e/helpers.ts` for the initial fresh-context New City bootstrap.

The test must use the production browser path already wired by HPA-345:

```text
WASM GameBackend -> workingSaveRuntime -> IndexedDbCitySaveStore
```

### Steps

- [ ] **Step 1: Add the real-browser persistence smoke**

Create `tests/e2e/cityLibrary.spec.ts`:

```ts
import { expect, test } from "@playwright/test";
import { createDefaultCity } from "./helpers";

test("created city survives reload and Continue restores it", async ({ page }) => {
  await createDefaultCity(page, "Reload Junction");

  await page.getByTestId("command-destination-city").click();
  await page.getByRole("button", { name: "Save Now" }).click();
  await expect(page.getByText("Saved")).toBeVisible();

  await page.reload();

  await expect(page.getByTestId("city-library-screen")).toBeVisible();
  await expect(page.getByText("Reload Junction")).toBeVisible();

  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByTestId("game-canvas-host")).toBeVisible();
  await page.getByTestId("command-destination-city").click();
  await expect(page.getByRole("heading", { name: "Reload Junction" })).toBeVisible();
});
```

If the City panel's name is not a semantic heading after Task 2, assert the visible city-name test ID added there instead; do not inspect IndexedDB directly in this test because HPA-343/HPA-345 already prove the adapter record path. This smoke proves the player-visible reload/restore path.

- [ ] **Step 2: Run the dedicated Chromium spec**

```bash
bun run test:e2e -- tests/e2e/cityLibrary.spec.ts
```

Expected: PASS.

- [ ] **Step 3: Verify existing gameplay e2e bootstrap remains valid**

Run:

```bash
bun run test:e2e
```

Expected: PASS. Existing tests still start in fresh contexts, so `createDefaultCity()` continues to encounter the empty New City screen on their first navigation.

Do not make `createDefaultCity()` conditionally accept a city library unless a real existing test context now needs it; conditional bootstrap would weaken the HPA-345 fresh-context assertion.

- [ ] **Step 4: Update the architecture flow**

In `docs/architecture.md`, document the browser UI flow as:

```text
startup
  -> runtime.persistence.listCities()
  -> empty: New City
  -> existing: City Library
       -> Continue / Load / Rename / Delete / New City
  -> active game shell
       -> City panel: Save Now / city list / New City
```

Keep these boundaries explicit:

- UI calls the runtime controller, never a store adapter;
- browser uses IndexedDB;
- Tauri still uses the temporary memory store until HPA-344;
- HPA-349 owns final cross-host smoke;
- no autosave/recovery/migration/multi-instance framework exists.

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

Expected: all commands PASS.

`bun run lint` already includes the repository's Rust lint gate. No Rust source changes are expected in HPA-346, so a separate new Rust test matrix is unnecessary.

- [ ] **Step 6: Review the final diff for scope creep**

Run:

```bash
git diff --stat main...HEAD
git diff --name-only main...HEAD
rg -n "autosave|checkpoint|recovery|migration|repository|view.?model|state machine|storage event" \
  src/components/city src/App.svelte src/components/hud/panels/CityPanel.svelte docs/architecture.md
```

Expected:

- production changes are limited to the city UI/App orchestration/styles;
- no new persistence abstraction or deferred feature appears;
- no `src/runtime/workingSaveRuntime.ts` or store-adapter change is required.

- [ ] **Step 7: Commit the browser smoke and architecture update**

```bash
git add tests/e2e/cityLibrary.spec.ts docs/architecture.md
git commit -m "test: cover city library reload flow"
```

---

## Plan self-review

### Spec coverage

- City list: Tasks 1-2.
- Continue/Load: Task 2 plus real browser proof in Task 3.
- Save Now: Task 2 plus browser proof in Task 3.
- Rename active/inactive: shared CityList in Tasks 1-2.
- Delete active/inactive with one confirmation: Tasks 1-2.
- New City from existing library/active shell: Tasks 1-2, reusing the existing form.
- Busy behavior: Tasks 1-2.
- Error copy: Task 2 reuses `workingSaveErrorMessage` for read and mutation failures.
- Real IndexedDB + reload + Continue: Task 3.
- Architecture documentation: Task 3.
- Native persistence: explicitly excluded for HPA-344.

### Placeholder scan

The plan contains no `TBD`, `TODO`, compatibility shim, generic error-handling instruction, or unspecified implementation step. Every production behavior has an owning file and focused test path.

### Type consistency

- `CitySummary` comes only from `src/persistence/citySaveStore.ts`.
- `RuntimePersistenceController` remains unchanged.
- `CityList` callbacks use `cityId: string` and trimmed rename `name: string` consistently in both library and panel surfaces.
- `cities: CitySummary[] | null` uses `null` only for the initial/pending list read, not as a second persistence state.
