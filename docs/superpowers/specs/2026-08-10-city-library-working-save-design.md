# HPA-346 City Library and Working-Save Workflow Design

## Decision

HPA-346 remains the next player-facing Phase 1 slice after HPA-345.

HPA-345 already provides the no-city New City screen, browser IndexedDB wiring, the six-operation `RuntimePersistenceController`, active-city identity, one persistence busy gate, one dirty boolean, and shared player-facing persistence error copy. HPA-346 completes the first useful browser loop without widening those foundations:

> New City -> play -> mutate -> Save Now -> reload -> City Library -> Continue/Load

HPA-344 remains the separate native Tauri durability task. HPA-349 remains the final representative browser/native smoke after HPA-344 and HPA-346 are complete.

The architecture stays UI over the existing runtime. No persistence service, repository, router, view-model, runtime city-list cache, polling layer, or optimistic save model is added.

## Reuse survey

### Persistence runtime — reuse unchanged

Reuse `RuntimePersistenceController` and `RuntimePersistenceView` from `src/runtime/workingSaveRuntime.ts` unchanged:

```ts
export interface RuntimePersistenceController {
  listCities(): Promise<WorkingSaveResult<CitySummary[]>>;
  save(): Promise<WorkingSaveResult<CitySummary>>;
  load(cityId: string): Promise<WorkingSaveResult<CitySummary>>;
  createCity(request: NewCityRequest): Promise<WorkingSaveResult<CitySummary>>;
  renameCity(cityId: string, name: string): Promise<WorkingSaveResult<CitySummary>>;
  deleteCity(cityId: string): Promise<WorkingSaveResult<void>>;
}

export interface RuntimePersistenceView {
  activeCity: CitySummary | null;
  busy: boolean;
  dirty: boolean;
  error: WorkingSaveError | null;
}
```

City summaries are store-read presentation data, not gameplay/runtime state. Do not add `cities` to `RuntimePersistenceView`.

### Error copy — reuse unchanged

Reuse `workingSaveErrorMessage()` from `src/runtime/rejectionMessages.ts` for both list and mutation failures. Diagnostics never cross into Svelte copy.

### Ordering — reuse unchanged

`CitySaveStore.listCities()` already returns `sortCitySummaries(...)` ordering: `savedAt` descending, then ID. Svelte never sorts again.

### New City — extend only

Reuse `src/components/NewCityScreen.svelte`; add only optional `onCancel?: () => void`.

### City panel — extend

Extend `src/components/hud/panels/CityPanel.svelte` with Save/dirty state and the shared local-city list.

### City row interaction vocabulary — copy the existing Lines pattern

`src/components/hud/panels/LinesPanel.svelte` already establishes the interaction vocabulary for renaming/deleting list rows:

- an always-visible inline text input labelled `Rename <name>`;
- draft value stored separately from canonical data;
- Enter/blur commits once;
- Escape restores the canonical name and contains the key event;
- one delete button toggles `Delete` -> `Delete?` before the second click commits.

`CityList.svelte` should copy that interaction shape rather than inventing a Rename button + edit mode + Save-name form. City rename adds one stricter current rule: trim the submitted name and reject an empty trimmed value.

### Existing tests/helpers — extend/reuse

- Extend `tests/ui/appShell.test.ts`.
- Migrate `tests/ui/cityPanel.test.ts`; its current persistence-controls-absent and null-city fallback tests become obsolete when CityPanel's contract changes.
- Reuse `tests/e2e/helpers.ts` (`createDefaultCity`, `selectBuildLeaf`, `dragMapTiles`, `clickMapTile`, `openCommandDestination`).
- Reuse current IndexedDB/Tauri-memory bootstrap wiring in `src/main.ts`; HPA-346 does not change host selection.

## App-local presentation state

Keep only current UI concerns in `App.svelte`:

```ts
let cities = $state<CitySummary[] | null>(null);
let cityListError = $state<string | null>(null);
let showNewCity = $state(false);
let cityListRequestId = 0;
```

Meanings:

- `cities === null`: no current trustworthy list projection is ready;
- `cities !== null`: latest successful summary list;
- `cityListError`: latest `listCities()` failure only;
- `showNewCity`: local presentation choice;
- `cityListRequestId`: latest-wins guard for overlapping read-only list refreshes.

No interval, storage event, cross-tab listener, metadata cache, or persistence lifecycle state is added.

## One derived player-facing error

Use one derived value for both the full-screen library and City panel:

```ts
const cityError = $derived(
  cityListError ??
    (snapshot?.persistence.error == null
      ? null
      : workingSaveErrorMessage(snapshot.persistence.error)),
);
```

Mutation handlers clear `cityListError` before invoking the runtime, so an old list-read failure cannot mask a newer Save/Load/Rename/Delete/Create failure.

A `Retry city list` button is keyed specifically from `cityListError !== null`, not from `cityError !== null`.

### Create-specific error for New City

The New City form uses a separate `newCityError` state, not the shared `cityError`, so only Create failures appear there:

```ts
let newCityError = $state<string | null>(null);
```

- `handleShowNewCity()` clears `newCityError` and bumps `cityListRequestId` to invalidate any in-flight list read, preventing a late list error from injecting "Could not load the city list" into the form.
- `handleCreateCity()` sets `newCityError = workingSaveErrorMessage(result.error)` on failure.
- `handleCancelNewCity()` clears `newCityError`.
- Both `NewCityScreen` instances receive `error={newCityError}`.

This keeps the fix local to App presentation state; `RuntimePersistenceController` is unchanged.

## Latest-wins list reads

`listCities()` deliberately remains outside the runtime busy gate. UI retries and post-mutation refreshes can therefore overlap. Protect the presentation projection with one request counter:

```ts
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

This is not a queue/cancellation framework. It only prevents an older read response from overwriting a newer list response.

## Initial/no-active-city flow

Fatal shell failure remains first.

After runtime subscription/start, App calls `refreshCities()` once.

When no city is active:

1. `cities === null` with no list error -> `CityLibraryScreen` loading state;
2. successful `cities.length === 0` -> existing `NewCityScreen` directly;
3. successful non-empty list -> `CityLibraryScreen`;
4. Continue loads `cities[0]`, using store ordering;
5. rows offer Load, inline Rename, and two-click Delete;
6. New City opens the existing form with Cancel back to the library.

### Failed list read must not remove New City access

A list read can fail while no city is active. In that state `CityLibraryScreen` shows:

- mapped list error;
- `Retry city list`;
- `New City`.

New City remains available because the existing product already exposes it whenever no city is active. The player can attempt creation independently; if storage itself is unavailable, the existing create error is shown normally.

Do not add an empty-library `No saved cities`/disabled-Continue branch. Successful empty storage bypasses the library and renders `NewCityScreen`.

## Active-city flow

The normal shell remains intact. `CityPanel.svelte` gains:

- active city name;
- `Saved` / `Unsaved changes` from `persistence.dirty`;
- Save Now;
- New City;
- current city list when available;
- Load for inactive cities;
- inline Rename for all cities;
- two-click Delete;
- mapped `cityError`;
- `Retry city list` only when `cityListError !== null`.

### Dirty gating for city switching

Load and New City are disabled while `dirty` is true (`disabled={busy || dirty}`), preventing silent data loss when switching away from an unsaved city. Save Now remains available so the player can clear dirty state.

Because applied simulation ticks call `markDirty()`, an unpaused city is continuously dirty — Save Now clears dirty only until the next applied tick. The effective workflow to switch cities is therefore Pause → Save → switch. When `dirty` is true, CityPanel shows a hint:

```svelte
{#if dirty}
  <p class="city-switch-hint" data-testid="city-switch-hint">
    Pause and Save before switching cities.
  </p>
{/if}
```

`CityList.svelte` receives a `dirty?: boolean` prop (default `false`) so inactive-row Load buttons are also gated. The library screen does not pass `dirty` (no active city means no unsaved changes).

All other mutation controls (Save Now, Rename, Delete) use only the existing single `snapshot.persistence.busy` gate. No per-row pending state or mutation queue is added.

## Explicit App handlers

Keep per-operation handlers rather than a generic action runner because post-success behavior differs. Each mutation handler calls `beginPersistenceMutation()` before invoking the runtime, which bumps `cityListRequestId` (invalidating any in-flight list read) and clears `cityListError` so the mutation's own result owns the alert:

```ts
function beginPersistenceMutation(): void {
  cityListRequestId += 1;
  cityListError = null;
}
```

- Create -> `beginPersistenceMutation()`, clear `newCityError`, create through runtime, set `newCityError` on failure, close New City + refresh list on success;
- Save -> `beginPersistenceMutation()`, save through runtime, refresh list on success;
- Load -> `beginPersistenceMutation()`, load through runtime, no list refresh;
- Rename -> `beginPersistenceMutation()`, rename through runtime, refresh list on success;
- Delete -> `beginPersistenceMutation()`, delete through runtime, refresh list on success.

`handleShowNewCity()` also bumps `cityListRequestId` and clears both `cityListError` and `newCityError`, so a late list error cannot inject into the form and no stale mutation error carries over.

No handler writes a synthetic city summary into the list.

## Active delete: never render a known-stale row

`workingSaveRuntime.deleteCity()` clears active identity and publishes before the caller's `await` resumes. If App kept the pre-delete `cities` projection, the no-active branch could briefly render the deleted city and a Continue action that can only fail `readCity`.

For an active-city deletion, App therefore invalidates the read projection **before invoking the delete**:

```ts
async function handleDeleteCity(cityId: string): Promise<void> {
  if (runtime === null) return;
  beginPersistenceMutation();

  const deletingActive = snapshot?.persistence.activeCity?.id === cityId;
  if (deletingActive) {
    cities = null;
  }

  const result = await runtime.persistence.deleteCity(cityId);
  if (!result.ok) {
    if (deletingActive) await refreshCities();
    return;
  }

  await refreshCities();
}
```

This is not optimistic list editing: App invalidates any in-flight list read (via `beginPersistenceMutation()`), discards a projection it knows is about to become invalid, and waits for the store to provide the next authoritative list. If deletion fails, a read restores the projection.

For inactive deletion, keep the current list visible until the successful post-delete refresh.

## `CityList.svelte`

Add `src/components/city/CityList.svelte` with:

```ts
interface Props {
  cities: CitySummary[];
  activeCityId: string | null;
  busy: boolean;
  dirty?: boolean;
  onLoad: (cityId: string) => void;
  onRename: (cityId: string, name: string) => void;
  onDelete: (cityId: string) => void;
}
```

Use LinesPanel-style transient state:

```ts
let pendingDeleteId = $state<string | null>(null);
let cityNameDrafts = $state<Record<string, string>>({});
```

Each row explicitly includes:

```svelte
<article data-testid={`city-row-${city.id}`}>
```

Rename input:

```svelte
<input
  data-testid={`city-name-${city.id}`}
  aria-label={`Rename ${city.name}`}
  ...
/>
```

Commit rules:

- update only the draft record on input;
- on blur or Enter, trim the current value;
- if the trimmed value is empty, restore canonical name and do not call `onRename`;
- otherwise clear draft state and call `onRename(city.id, trimmed)` exactly once;
- Escape clears the draft, restores canonical name, stops propagation, prevents default, and blurs.

Delete rules:

- first click sets `pendingDeleteId` and shows `Delete?`;
- second click clears it and invokes `onDelete(city.id)`;
- selecting another city action clears pending delete when practical.

The active row shows `Active` instead of Load. Inactive rows show Load. Load is disabled while `busy` or `dirty` is true; all other mutation controls are disabled while `busy` is true.

Display only city name and last-saved time.

## `CityLibraryScreen.svelte`

Add a thin `<main>`-level screen, following the existing New City precedent:

```ts
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

The root is explicitly:

```svelte
<main class="city-library-screen" data-testid="city-library-screen">
```

States:

- `cities === null && error === null`: Loading cities…;
- list failure (`onRetry` present): show mapped copy + Retry + New City, hiding the list;
- mutation error (`onRetry` absent): show mapped copy above the existing city controls (Continue + New City + `CityList`);
- non-empty list, no error: Continue + New City + `CityList`.

The retry-only error state applies solely to list failures. Mutation errors retain the existing city controls so the player can still continue, load, rename, or delete cities while seeing the error. App never intentionally passes a successful empty list to this screen.

## City panel test contract

`tests/ui/cityPanel.test.ts` is part of HPA-346 because its current tests encode the old `CityPanel` interface and explicitly assert persistence controls do not exist.

Delete with the old implementation contract:

- `falls back to the shell title when no city name is active`;
- `does not expose campaign or persistence controls`.

Keep and migrate the overview-fields test to the new props, including a real `CitySummary` active city and no-op callbacks. The active branch guarantees a non-null city, so the old null fallback is not a supported CityPanel responsibility after HPA-346.

## Dirty and save status

City panel save state uses an explicit test hook:

```svelte
<div
  class="city-save-status"
  data-testid="city-save-status"
  data-dirty={dirty}
>
  {dirty ? "Unsaved changes" : "Saved"}
</div>
```

This supports exact state assertions without relying on substring text matching.

## Browser persistence proof

The Chromium test must make Save observable. New City already commits its creation snapshot, so create -> Save -> reload can false-pass if Save is a no-op.

Use the existing Crossroads flow/helpers:

1. create `Reload Junction`;
2. assert starting budget `$120,000`;
3. paint residential zoning at the coordinates already used by `tests/e2e/smoke.spec.ts`;
4. build one small house at `{ x: 1, y: 1 }`;
5. assert budget `$116,000`;
6. open City and assert `city-save-status[data-dirty="true"]`;
7. click Save Now;
8. assert `city-save-status[data-dirty="false"]` — do **not** use `getByText("Saved")`, because Playwright string text matching defaults to non-exact substring matching;
9. reload;
10. verify City Library + `Reload Junction`;
11. Continue;
12. assert budget is still `$116,000` and active city name is `Reload Junction`.

If Save is a no-op, Continue restores the create-time `$120,000` snapshot and the test fails.

No direct IndexedDB inspection helper is added; HPA-343/HPA-345 already own adapter acceptance evidence.

## Focused UI tests

### `tests/ui/cityList.test.ts`

Cover:

- active row has no Load; inactive row loads correct ID;
- inline rename trims and commits once on Enter/blur;
- whitespace-only rename is rejected/restored;
- Escape restores canonical name and does not leak to parent;
- Delete toggles `Delete` -> `Delete?` and commits on second click;
- busy disables Load/rename/delete.

### `tests/ui/appShell.test.ts`

Update the harness so all six persistence methods have valid default resolved `WorkingSaveResult`s, overridable per test. This prevents new explicit async handlers from dereferencing `undefined` results.

Cover:

- existing HPA-345 no-city tests await initial list read;
- successful empty list -> New City;
- saved list + no active city -> City Library;
- list error -> error + Retry city list + New City;
- Continue uses first store-ordered ID;
- Save invokes runtime and dirty state is shown;
- active City panel opens/cancels New City;
- Rename/Delete use selected IDs;
- busy disables city mutations;
- failed Load preserves active game and does not show list Retry;
- active delete with another city remaining: runtime publishes `activeCity: null` while the post-delete list refresh is unresolved, library shows loading/no phantom deleted row, then refresh yields the remaining city;
- final active delete: runtime publishes `activeCity: null` while refresh is unresolved, then refreshed `[]` leads directly to New City.

Tests must model production order: active identity changes before the post-delete `listCities()` response lands.

### `tests/ui/cityPanel.test.ts`

Keep one migrated overview test. Remove the two tests tied to the old interface/absence of persistence UI.

## Styling/testing commands

Task-local CSS changes run Stylelint through:

```bash
bun run lint
```

For single Vitest files use the repository-prescribed command form:

```bash
bunx vitest run tests/ui/cityList.test.ts
bunx vitest run tests/ui/appShell.test.ts
bunx vitest run tests/ui/cityPanel.test.ts
```

Full gates continue to use the package scripts.

## Documentation

Update `docs/architecture.md` to show:

```text
startup
  -> runtime.persistence.listCities()
  -> empty: New City
  -> list failure: Retry city list OR New City
  -> existing: City Library
       -> Continue / Load / Rename / Delete / New City
  -> active game shell
       -> City panel: Save Now / city list / New City
```

Keep HPA-344 marked as native durability and HPA-349 as the final cross-host smoke.

## Scope boundaries

HPA-346 includes only:

- list cities;
- Continue / Load;
- Save Now;
- Rename;
- Delete with one confirmation;
- New City entry from library/active City panel/list-read failure;
- one real browser changed-snapshot Save/reload/Continue proof.

HPA-346 excludes:

- native Tauri save files;
- autosave/checkpoints/recovery;
- duplicate city;
- folders/tags/search/thumbnails;
- import/export/cloud sync;
- migration/legacy readers/compatibility badges;
- multi-tab/window ownership;
- save managers/repositories/view models/routers/state machines;
- mutation queues or cancellation systems;
- security-hardening frameworks;
- new dependencies.

## Risks and controls

### Stale list response

Risk: overlapping read-only list refreshes can resolve out of order.

Control: one latest-wins request ID; no queue or polling.

### Active-delete phantom row

Risk: runtime publishes `activeCity: null` before the caller refreshes summaries.

Control: invalidate the App list projection before active deletion; repopulate from the store afterward or after failure.

### Save proof false positive

Risk: New City already persisted a record, so reload alone does not prove Save.

Control: mutate to a known `$116,000` state and assert that exact state after Continue; use `data-dirty` for the dirty->saved transition.

### Development save incompatibility

Risk: current development records may become invalid after future schema changes.

Control: existing generic load error + Delete path only; no migration/recovery framework.

## Acceptance criteria

- [ ] `RuntimePersistenceController` and `RuntimePersistenceView` remain unchanged.
- [ ] Summaries remain App-local presentation state.
- [ ] List ordering is reused, not reimplemented.
- [ ] `workingSaveErrorMessage()` remains the single player-copy mapper.
- [ ] A latest-wins request ID prevents older `listCities()` results from replacing newer results.
- [ ] Successful empty storage renders New City directly.
- [ ] Failed list read still offers both Retry city list and New City.
- [ ] Existing cities render City Library with Continue, Load, inline Rename, Delete?, and New City.
- [ ] City row rename/delete interaction matches the established LinesPanel vocabulary and rejects blank city names.
- [ ] Active City panel exposes Save Now, dirty state, New City, and the shared city list.
- [ ] Load and New City are disabled while `dirty` is true; a switching hint explains the Pause → Save → switch workflow.
- [ ] `CityList.svelte` accepts a `dirty?: boolean` prop for gating inactive-row Load.
- [ ] New City form uses a create-specific `newCityError` state, not the shared `cityError`, so only Create failures appear there.
- [ ] Opening New City invalidates in-flight list reads and clears stale errors.
- [ ] Active deletion never intentionally renders the known-deleted city from a stale list projection.
- [ ] Final-slot deletion transitions to New City; another-city-remains deletion transitions to City Library after refresh.
- [ ] `tests/ui/cityPanel.test.ts` is migrated with obsolete old-contract tests removed.
- [ ] All six persistence methods in the App test harness resolve valid default results.
- [ ] One derived `cityError` is passed consistently to library and panel; `newCityError` is passed to both New City form instances.
- [ ] `city-library-screen`, `city-row-${id}`, `city-name-${id}`, `city-save-status`, `city-switch-hint`, and `active-city-name` test hooks are specified in implementation.
- [ ] Chromium proves mutate -> dirty -> Save -> clean -> reload -> Continue -> changed state through real WASM + IndexedDB.
- [ ] HPA-344 and HPA-349 remain separate downstream work.
- [ ] No autosave, recovery, migration, compatibility, multi-instance, security, or generic save-management framework is introduced.
