# HPA-346 City Library and Working-Save Workflow Design

## Decision

HPA-346 is the next player-facing Phase 1 slice after HPA-345.

HPA-345 is merged and already provides:

- the no-city New City screen;
- the browser IndexedDB store;
- the six-operation `RuntimePersistenceController`;
- one persistence busy gate;
- active-city and dirty state;
- shared player-facing `WorkingSaveError` copy.

HPA-346 should complete the first useful browser loop without widening those foundations:

> New City -> play -> Save Now -> reload -> city library -> Continue/Load

HPA-344 remains a separate required Phase 1 task for native Tauri durability. HPA-349 remains the final representative cross-host smoke after HPA-344 and HPA-346 are both complete.

## Approaches considered

### Chosen: UI-local city list over the existing runtime

`App.svelte` loads summaries through `runtime.persistence.listCities()` and stores only the current list/read error as presentation state. All mutations still go through the existing runtime controller.

This keeps responsibilities narrow:

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

There is one current workflow and one current Svelte application. A generic manager, command bus, navigation state machine, metadata cache, repository, or view-model framework would add more code than behavior and slow iteration.

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

`CitySaveStore.listCities()` already returns summaries by `savedAt` descending with ID as a deterministic tie-breaker. Svelte must not add another sort.

`workingSaveErrorMessage()` already maps all six store operations plus runtime/backend failures to concise copy and must remain the only UI-facing persistence error mapper.

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

- leaves any previously loaded summaries intact;
- stores only mapped player copy in `cityListError`;
- exposes a `Retry city list` control;
- does not modify runtime busy/error state because list remains a read-only operation.

UI refreshes the list again only after successful create/save/rename/delete operations or an explicit list retry. Load does not change summary metadata and does not need a refresh.

## No-active-city flow

Fatal shell failure remains the first render branch.

When no city is active:

1. `cities === null` and no list error -> show City Library loading state;
2. successful empty list -> show the existing `NewCityScreen` directly;
3. non-empty list -> show `CityLibraryScreen`;
4. Continue loads `cities[0]` because store ordering is already authoritative;
5. every city row supports Load, Rename, and Delete;
6. New City opens the existing New City form with a Cancel button back to the library.

A failed Load keeps the player on the library. The same city row stays available for Delete, which is the current-development escape hatch for obsolete/invalid data. No migration, repair, or recovery flow is added.

A Load failure does **not** display `Retry city list`; the player retries Load by pressing Load/Continue again. List Retry is reserved for `cityListError` so the UI never implies a list refresh will retry a restore.

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

Load semantics also remain unchanged: read, candidate-first restore/install, then change active identity. A failed Load leaves current gameplay and identity unchanged.

Deleting the active city already clears active identity only after storage success. App therefore naturally falls back to the city library after runtime publication.

## Starting another city

HPA-345 exposed New City only when no city was active. HPA-346 must make multiple slots usable by exposing the same form from:

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

Clearing `cityListError` before an explicit mutation prevents an old list-read failure from masking a newer runtime operation error.

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

Add one focused Chromium test using the production browser path:

1. fresh Playwright context;
2. create a named city through New City;
3. open City and invoke Save Now;
4. reload the page;
5. verify City Library appears and contains the city;
6. click Continue;
7. verify the game shell returns with that city active.

This uses real WASM gameplay + real IndexedDB. HPA-343/HPA-345 already prove direct adapter record acceptance, so HPA-346 should not add another direct IndexedDB inspection helper.

HPA-349 still owns the broader representative browser/native flow, including the native adapter once HPA-344 lands.

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
- active delete publication returns to library;
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

## Scope boundaries

HPA-346 includes only:

- list cities;
- Continue / Load;
- Save Now;
- Rename;
- Delete with one confirmation;
- New City entry from library/active City panel;
- one real-browser reload/Continue smoke.

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
- [ ] Empty storage still leads to the existing New City form.
- [ ] Existing cities lead to City Library with Continue, Load, Rename, Delete, and New City.
- [ ] Continue uses the first store-ordered summary.
- [ ] Active City panel exposes Save Now, dirty state, New City, and the shared city list.
- [ ] New City reuses the existing form with optional Cancel only.
- [ ] Rename trims/rejects empty names without a validation framework.
- [ ] Delete requires one inline confirmation.
- [ ] Existing runtime busy state disables city mutations.
- [ ] List and mutation failures use `workingSaveErrorMessage` without diagnostics.
- [ ] `Retry city list` appears only for list-read failure, never as a fake retry for Load/Save/Rename/Delete.
- [ ] Failed Save and Load behavior remains the existing runtime behavior.
- [ ] One Chromium smoke proves create -> Save -> reload -> City Library -> Continue through real WASM + IndexedDB.
- [ ] HPA-344 and HPA-349 remain separate downstream work.
- [ ] No autosave, recovery, migration, compatibility, multi-instance, security, or generic save-management framework is introduced.
