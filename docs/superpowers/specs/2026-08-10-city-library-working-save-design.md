# HPA-346 City Library and Working-Save Workflow Design

## Decision

HPA-346 remains the next player-facing Phase 1 slice after HPA-345.

HPA-345 is merged and already provides:

- the no-city New City screen;
- the real browser IndexedDB store;
- the six-operation `RuntimePersistenceController`;
- one persistence busy gate;
- active-city and dirty state;
- shared player-facing `WorkingSaveError` copy.

HPA-346 completes the first useful browser loop without widening those foundations:

> New City -> play -> Save Now -> reload -> City Library -> Continue/Load

HPA-344 remains the separate native Tauri durability task. HPA-349 remains the final representative cross-host smoke after HPA-344 and HPA-346 are complete.

## Reuse survey

Reuse the existing boundaries rather than adding a save-management layer:

- `RuntimePersistenceController` / `RuntimePersistenceView` — unchanged in `src/runtime/workingSaveRuntime.ts`;
- `workingSaveErrorMessage()` — reuse `src/runtime/rejectionMessages.ts` for list and mutation copy;
- store ordering / `listCities()` — reuse `src/persistence/citySaveStore.ts` and runtime `listCities()`;
- `NewCityScreen.svelte` — extend only with optional `onCancel`;
- `CityPanel.svelte` — extend with working-save controls;
- `tests/ui/appShell.test.ts` — extend the existing App harness and no-city tests;
- `tests/e2e/helpers.ts` — reuse `createDefaultCity`, `selectBuildLeaf`, `dragMapTiles`, and the existing canvas helpers;
- `src/main.ts` — leave the current IndexedDB-vs-memory host wiring unchanged;
- `CityList.svelte` — new, because no city-list UI exists today;
- `CityLibraryScreen.svelte` — new thin screen with one App consumer;
- App-local `cities`, `cityListError`, and `showNewCity` — new presentation state instead of adding summaries to runtime state.

## Approaches considered

### Chosen: UI-local city list over the existing runtime

`App.svelte` loads summaries through `runtime.persistence.listCities()` and stores only the current list/read error as presentation state. All mutations continue through the existing runtime controller.

```text
City UI
  -> RuntimePersistenceController
       -> workingSaveRuntime
            -> CitySaveStore
```

The runtime already owns the hard behavior: mutation exclusion, active identity, dirty state, candidate-first restore, save ordering, and mutation errors. The UI only needs a current list projection and explicit callbacks.

### Rejected: put `cities` in `RuntimePersistenceView`

That would turn the runtime into a second summary cache and require synchronization after create/save/load/rename/delete even though city summaries are not gameplay state.

### Rejected: save manager / repository / router / view-model layer

There is one current workflow and one Svelte application. A generic manager, command bus, navigation state machine, repository, metadata cache, or view-model framework would add more code than behavior and slow iteration.

## Existing contracts remain authoritative

HPA-346 does not change:

```ts
export interface RuntimePersistenceController {
  listCities(): Promise<WorkingSaveResult<CitySummary[]>>;
  save(): Promise<WorkingSaveResult<CitySummary>>;
  load(cityId: string): Promise<WorkingSaveResult<CitySummary>>;
  createCity(request: NewCityRequest): Promise<WorkingSaveResult<CitySummary>>;
  renameCity(cityId: string, name: string): Promise<WorkingSaveResult<CitySummary>>;
  deleteCity(cityId: string): Promise<WorkingSaveResult<void>>;
}
```

```ts
export interface RuntimePersistenceView {
  activeCity: CitySummary | null;
  busy: boolean;
  dirty: boolean;
  error: WorkingSaveError | null;
}
```

`CitySaveStore.listCities()` already orders summaries by `savedAt` descending with ID as a deterministic tie-breaker. Svelte must not add another sort.

`workingSaveErrorMessage()` already maps all six store operations plus runtime/backend failures to concise copy and remains the only UI-facing persistence error mapper.

## App-level presentation state

Add only:

```ts
let cities = $state<CitySummary[] | null>(null);
let cityListError = $state<string | null>(null);
let showNewCity = $state(false);
```

Meanings:

- `cities === null`: first list read has not completed;
- `cities !== null`: last successful summary list;
- `cityListError`: latest `listCities()` failure only;
- `showNewCity`: local presentation choice, not gameplay/navigation state.

No polling, storage events, cross-tab listener, background refresh, metadata cache, or runtime list state is introduced.

## Initial list behavior

After the existing runtime subscription/start setup, `App.svelte` performs one `runtime.persistence.listCities()` call.

A successful read replaces `cities` and clears `cityListError`.

A failed read:

- preserves any previously loaded summaries;
- stores only mapped player copy in `cityListError`;
- exposes `Retry city list`;
- does not modify runtime busy/error state because listing remains read-only.

Refresh the list only after successful create/save/rename/delete operations or an explicit list retry. Load does not change summary metadata and does not need a refresh.

Before every explicit mutation, clear stale `cityListError` so an old list failure cannot mask a newer runtime operation error.

## No-active-city flow

Fatal shell failure remains the first render branch.

When no city is active:

1. `cities === null` and no list error -> show the City Library loading state;
2. successful empty list -> show the existing `NewCityScreen` directly;
3. non-empty list -> show `CityLibraryScreen`;
4. Continue loads `cities[0]` because store ordering is already authoritative;
5. every city row supports Load, Rename, and Delete;
6. New City opens the existing New City form with a Cancel button back to the library.

A failed Load keeps the player on the library. The same city row stays available for Delete, which is the current-development escape hatch for obsolete/invalid data. No migration, repair, or recovery flow is added.

A Load failure does **not** display `Retry city list`; the player retries Load by pressing Load/Continue again. List Retry is reserved for `cityListError` so the UI never implies a list refresh will retry a restore.

### Empty-library invariant

A successfully loaded empty array is never rendered by `CityLibraryScreen`: App routes it directly to `NewCityScreen`.

Therefore `CityLibraryScreen` owns only:

- the initial `cities === null` loading state; and
- the non-empty saved-city state.

Do not add disabled Continue chrome or a `No saved cities` branch that App cannot reach.

## Active-city flow

The normal game shell remains intact. The existing City command panel gains:

- active city name;
- `Saved` / `Unsaved changes` from `persistence.dirty`;
- Save Now;
- New City;
- current local city list;
- Load for inactive cities;
- Rename for active/inactive cities;
- Delete for active/inactive cities;
- `Retry city list` only when the latest list read failed.

The panel receives data and callbacks; it does not own a runtime or store.

Save semantics remain the runtime's current behavior:

```text
busy gate
  -> wait gameplay idle
  -> snapshotForSave
  -> atomic updateCity
  -> update active summary
  -> dirty = false
```

A failed Save leaves dirty state and prior committed storage intact through the existing runtime/store contract.

Load remains read -> candidate-first restore/install -> active identity update. A failed Load leaves current gameplay and identity unchanged.

Deleting the active city already clears active identity only after storage success. After the successful delete handler refreshes summaries:

- remaining cities -> App renders City Library;
- no remaining cities -> App renders New City directly.

Both branches receive focused UI coverage; the second is important because deleting the final slot is the only path from an active game back to truly empty storage.

## Starting another city

HPA-345 exposed New City only when no city was active. HPA-346 makes multiple slots usable by exposing the same form from:

- `CityLibraryScreen`;
- the active City panel.

Do not duplicate the form. Extend `NewCityScreen.svelte` only with:

```ts
onCancel?: () => void;
```

`showNewCity` remains App-local presentation state. It is not added to `RuntimeSnapshot`, `UiState`, a router, or a navigation state machine.

No unsaved-change navigation guard is added in this phase; Load/New City remain explicit player actions and Save Now remains explicit.

## Shared city list

Add:

```text
src/components/city/CityList.svelte
```

Props:

```ts
interface Props {
  cities: CitySummary[];
  activeCityId: string | null;
  busy: boolean;
  onLoad: (cityId: string) => void;
  onRename: (cityId: string, name: string) => void;
  onDelete: (cityId: string) => void;
}
```

The component owns only transient row state:

- current rename row/input;
- current delete-confirmation row.

Rules:

- active row shows `Active` instead of Load;
- rename trims input and rejects empty trimmed names;
- Delete requires one inline `Delete -> Confirm delete` step;
- all mutation controls are disabled while runtime persistence is busy;
- display city name and last-saved time only;
- normal Svelte escaping only.

Do not add created-time display merely to fill space, nor tags, thumbnails, search, folders, or duplicate-city controls.

## Full-screen city library

Add:

```text
src/components/city/CityLibraryScreen.svelte
```

Props:

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

`cities === null` renders loading. When `cities` is non-null, App guarantees at least one summary; the screen renders Continue for the first summary plus `CityList` and New City.

`onRetry` is present only for a `listCities()` failure. Runtime Load/Rename/Delete errors still render mapped copy but no misleading list-retry button.

## App action orchestration

Keep one small read helper:

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

Keep mutation handlers explicit rather than creating a generic action runner:

- Create -> clear stale list error, create through runtime, refresh list on success;
- Save -> clear stale list error, save through runtime, refresh list on success;
- Load -> clear stale list error, load through runtime;
- Rename -> clear stale list error, rename through runtime, refresh list on success;
- Delete -> clear stale list error, delete through runtime, refresh list on success.

Do not optimistically edit the local summary list; the store remains authoritative.

## Busy and dirty behavior

The existing runtime busy gate remains authoritative. No queue, cancellation token, per-row pending map, optimistic mutation, or overlapping workflow model is added.

The UI receives one `busy` boolean and disables conflicting persistence controls.

The existing dirty boolean is only presented as:

- `Unsaved changes`; or
- `Saved`.

HPA-346 does not add autosave, unload prompts, navigation guards, recovery drafts, or additional dirty states.

## Error behavior

There are two UI error sources:

1. `cityListError` for `listCities()`;
2. `snapshot.persistence.error` for mutating runtime operations.

Rendered copy may use list-error precedence:

```ts
cityListError ??
(snapshot?.persistence.error == null
  ? null
  : workingSaveErrorMessage(snapshot.persistence.error))
```

But the Retry control is keyed specifically from `cityListError !== null`, not from the combined message.

Diagnostics never cross into Svelte text.

No new error union, host-specific error branch, recovery state, or detailed diagnostic UI is added.

## Browser persistence proof

The Chromium proof must demonstrate that **Save Now**, not merely New City creation, persists a changed gameplay snapshot.

New City already writes a complete initial city record, so `create -> Save -> reload -> Continue` would still pass if Save were accidentally a no-op. The test therefore performs a deterministic post-create mutation before saving.

Use the same known-valid Crossroads locations already exercised by `tests/e2e/smoke.spec.ts`:

1. fresh Playwright context;
2. create a Standard Crossroads city named `Reload Junction` through `createDefaultCity()`;
3. paint a small residential zone around `(1,1)` using existing build/drag helpers;
4. build one `smallHouse` at `(1,1)`, producing a durable budget change from `$120,000` to `$116,000`;
5. open City and assert `Unsaved changes`;
6. click Save Now and assert the status becomes `Saved`;
7. reload;
8. verify City Library appears and contains `Reload Junction`;
9. click Continue;
10. verify the active city is `Reload Junction` and the restored topbar budget is `$116,000` (optionally also population `4`).

If Save Now is removed or becomes a no-op, reload restores the initial create-time snapshot at `$120,000`, so the test fails.

This uses real WASM gameplay + real IndexedDB without adding another direct IndexedDB inspection helper. HPA-349 still owns the broader representative browser/native flow.

## Focused tests

### `CityList`

Cover:

- active vs inactive Load behavior;
- correct ID callbacks;
- trimmed rename / empty-name rejection;
- one-step delete confirmation;
- busy disables city mutations.

### `App.svelte` / City panel

Cover:

- existing HPA-345 no-city form tests now wait for initial list read;
- empty list -> New City;
- saved list + no active city -> City Library;
- Continue selects first store-ordered summary;
- list error maps copy, hides diagnostics, and exposes list Retry;
- Save Now invokes runtime save;
- New City opens/cancels from an active city;
- Rename/Delete use selected city IDs;
- active city is present in test list fixtures;
- busy disables controls;
- dirty state is visible;
- active delete with another slot remaining -> City Library;
- deleting the sole active city and refreshing to `[]` -> New City directly;
- failed Load preserves active game and does not show a list Retry control.

Do not duplicate runtime save/load branch matrices already covered by working-save runtime tests.

## Styling

Reuse the current Signal Console / New City visual language. Add only scoped styles for:

- city-library layout;
- city rows/actions;
- rename/delete-confirmation controls;
- Save/dirty status in City panel.

No design-system extraction is part of HPA-346.

## Documentation

Update `docs/architecture.md` to show:

```text
startup
  -> runtime.persistence.listCities()
  -> empty: New City
  -> existing: City Library
       -> Continue / Load / Rename / Delete / New City
  -> active game shell
       -> City panel: Save Now / city list / New City
```

Keep HPA-344 identified as the remaining native-durability slice and HPA-349 as final cross-host smoke.

## Verification boundary

HPA-346 changes shared Svelte UI plus browser E2E behavior but does not change Rust, Tauri commands, native persistence, or bootstrap host selection.

Required local gate:

```text
bun run test
bun run check
bun run lint
bun run format:check
bun run build
bun run test:e2e
```

Do not require a local `bun run tauri:build` for HPA-346. Native save packaging/durability is HPA-344 and representative native workflow verification is HPA-349. If CI already runs a Tauri packaging job, it may continue to do so without making it an HPA-346 implementation-plan gate.

## Scope boundaries

HPA-346 includes only:

- list cities;
- Continue / Load;
- Save Now;
- Rename;
- Delete with one confirmation;
- New City entry from library/active City panel;
- one real-browser **mutate -> Save -> reload -> Continue** proof.

HPA-346 excludes:

- native Tauri files (HPA-344);
- autosave/checkpoints/recovery;
- duplicate city;
- folders/tags/search/thumbnails;
- import/export/cloud sync;
- migration/legacy readers/compatibility badges;
- multi-tab/window ownership;
- optimistic writes/background polling;
- save repositories/managers/view models/routers/state machines;
- new dependencies;
- security-hardening/hostile-input frameworks.

## Acceptance criteria

- [ ] Existing six-operation runtime controller/view remain unchanged.
- [ ] City summaries stay UI-local instead of becoming runtime cache state.
- [ ] Empty storage leads directly to the existing New City form; City Library does not implement unreachable empty-list chrome.
- [ ] Existing cities lead to City Library with Continue, Load, Rename, Delete, and New City.
- [ ] Continue uses the first store-ordered summary.
- [ ] Active City panel exposes Save Now, dirty state, New City, and the shared city list.
- [ ] New City reuses the existing form with optional Cancel only.
- [ ] Rename trims/rejects empty names without a validation framework.
- [ ] Delete requires one inline confirmation.
- [ ] Deleting the final active city returns directly to New City after the refreshed list becomes empty.
- [ ] Existing runtime busy state disables city mutations.
- [ ] List and mutation failures use `workingSaveErrorMessage` without diagnostics.
- [ ] `Retry city list` appears only for list-read failure, never as a fake retry for Load/Save/Rename/Delete.
- [ ] Failed Save and Load behavior remains the existing runtime behavior.
- [ ] One Chromium smoke proves a post-create gameplay mutation is dirty, Save Now clears dirty, and the saved mutation survives reload/Continue through real WASM + IndexedDB.
- [ ] HPA-344 and HPA-349 remain separate downstream work.
- [ ] Local HPA-346 verification does not require `tauri:build` unless an existing CI job runs it independently.
- [ ] No autosave, recovery, migration, compatibility, multi-instance, security, or generic save-management framework is introduced.
