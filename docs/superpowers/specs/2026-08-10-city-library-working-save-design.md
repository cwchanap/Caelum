# HPA-346 City Library and Working-Save Workflow Design

## Decision

HPA-346 is the next player-facing Phase 1 slice after HPA-345.

HPA-345 is merged and already provides the no-city New City screen, browser IndexedDB wiring, the six-operation runtime persistence controller, and shared player-facing persistence error copy. HPA-346 should now complete the first useful browser loop:

> New City -> play -> Save Now -> reload -> city library -> Continue/Load

HPA-344 remains a separate required Phase 1 task for native Tauri durability. It does not need to block HPA-346 because the same Svelte/runtime workflow can be completed and exercised against the already-real browser IndexedDB path first. HPA-349 remains the final cross-host smoke after both HPA-346 and HPA-344 are complete.

The implementation should reuse the current runtime contract unchanged. No new persistence service, repository, navigation state machine, store cache, or runtime city-list state is needed.

## Approaches considered

### 1. UI-local city list on top of the existing runtime — chosen

Keep `RuntimePersistenceView` as active city + busy + dirty + error. `App.svelte` loads summaries through `runtime.persistence.listCities()` and keeps only the current list/read error as UI-local state. Mutating actions continue to go through the existing runtime controller.

This is the smallest design because:

- all six required operations already exist;
- the runtime already owns mutation ordering, active identity, dirty state, and error publication;
- the stores already own deterministic summary ordering;
- the UI only needs a current list projection and explicit action callbacks.

### 2. Add `cities` to `RuntimePersistenceView` — rejected

This would turn the runtime into a second cache of store summaries and require refresh rules after create/save/load/rename/delete. That state is not needed by gameplay and would duplicate data already available from `listCities()`.

### 3. Add a generic save manager/router/view-model layer — rejected

HPA-346 has one concrete workflow and one current UI. A new repository, command bus, route state machine, or generic view-model abstraction would add more code than behavior and make later feature iteration slower.

## Existing contracts to reuse

HPA-346 does not change these interfaces:

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

`CitySaveStore.listCities()` already returns summaries ordered by `savedAt` descending with the city ID as the deterministic tie-breaker. HPA-346 must not add a second sort implementation in Svelte.

`workingSaveErrorMessage()` already maps all six store operations plus runtime/backend failures to concise copy. HPA-346 reuses it instead of adding component-local error taxonomies.

## Product flow

### Initial bootstrap

After the runtime is mounted, `App.svelte` performs one `runtime.persistence.listCities()` refresh.

UI-local state is intentionally small:

```ts
let cities = $state<CitySummary[] | null>(null);
let cityListError = $state<string | null>(null);
let showNewCity = $state(false);
```

`null` means the first list read has not completed yet. A successful read replaces the summaries and clears `cityListError`. A failed read preserves any already-rendered summaries and shows the mapped error with a Retry action.

No interval, subscription to storage, cross-tab listener, metadata cache, or background refresh is added. The Phase 1 assumption is one application runtime at a time.

### No active city

The fatal shell branch remains first.

When `snapshot.persistence.activeCity === null`:

1. while the first city-list read is pending, show the city-library loading state;
2. when the list is empty, keep the current focused `NewCityScreen` as the primary experience;
3. when saved cities exist, show `CityLibraryScreen`;
4. `Continue` loads `cities[0]`, which is already the most recently saved city according to the store contract;
5. every row may Load, Rename, or Delete;
6. `New City` opens the existing `NewCityScreen` and provides a Cancel action back to the library.

A failed Load leaves the player on the library because the runtime changes active identity only after restore succeeds. The same row remains deletable, which is the minimal current-development escape hatch for invalid or obsolete data. There is no repair/migration flow.

### Active city

The normal game shell stays unchanged except for the existing City command panel.

`CityPanel.svelte` gains the working-save controls:

- current city name;
- Saved / Unsaved changes state from `dirty`;
- Save Now;
- New City;
- the current city list;
- Load for inactive cities;
- Rename for active or inactive cities;
- Delete for active or inactive cities.

Save, Load, Rename, Delete, and New City creation all remain runtime calls. The panel never accesses IndexedDB or Tauri commands.

Deleting the active city already clears active identity only after storage success. The normal App branch therefore returns to the city library automatically after a successful active delete.

Loading another city already installs the candidate before changing active identity. The game shell remains on the current city after a failed read/restore.

### Starting a second city

HPA-345 only exposed New City while no city was active. HPA-346 must expose the same form from both the city library and the active City panel so multiple slots are actually usable.

Do not add a second New City form. Extend `NewCityScreen.svelte` with one optional callback:

```ts
onCancel?: () => void;
```

When `onCancel` is supplied, render a Cancel button. The original empty-storage path omits it.

`showNewCity` is UI-local presentation state only. It is not added to `RuntimeSnapshot`, `UiState`, or a router because it has no gameplay meaning.

## Shared city-list component

Add one focused presentational component:

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

The component owns only transient row-edit state:

- which city is being renamed;
- the current rename input;
- which city is awaiting delete confirmation.

Name rules remain simple:

- trim on submit;
- reject an empty trimmed name;
- normal Svelte escaping only.

Delete uses one inline confirmation step (`Delete` -> `Confirm delete`) rather than browser dialogs or a modal framework. Changing rows or completing the action clears the confirmation state.

The active row shows `Active` instead of a Load button. Other rows show `Load`.

The list displays only the city name and last-saved time. `createdAt` stays in the summary contract but is not added merely to fill UI space.

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
  onRetry: () => void;
}
```

Behavior:

- `cities === null`: show `Loading cities…`;
- non-null/non-empty: show Continue for `cities[0]`, New City, and `CityList`;
- list/read error: show the existing mapped player copy and Retry;
- no active city is expected here, but `activeCityId` remains explicit so the component can share `CityList` without hidden assumptions.

The empty-list experience remains `NewCityScreen`; `CityLibraryScreen` does not duplicate the form.

## App orchestration

`App.svelte` remains the one place that bridges runtime actions to UI callbacks, matching the current command-shell pattern.

Add a small `refreshCities()` helper:

```ts
async function refreshCities(): Promise<void> {
  if (runtime === null) return;
  const result = await runtime.persistence.listCities();
  if (result.ok) {
    cities = result.value;
    cityListError = null;
  } else {
    cityListError = workingSaveErrorMessage(result.error);
  }
}
```

Do not create a generic action runner. Keep the six handlers explicit because their post-success behavior differs:

- Create: refresh list, close New City presentation;
- Save: refresh list so the saved timestamp updates;
- Load: active snapshot publication changes the shell; list data does not need a write-through cache;
- Rename: refresh list so both full-screen and panel names stay current;
- Delete: refresh list; active delete naturally returns to the library;
- list retry: call `refreshCities()`.

The initial `refreshCities()` runs from the existing `onMount` block after runtime subscription/start setup.

## Busy behavior

The runtime busy gate remains authoritative.

All mutating controls receive `snapshot.persistence.busy` and are disabled while it is true. Do not add overlapping-action queues, per-row loading maps, optimistic mutation state, or cancellation machinery.

`listCities()` remains a read-only operation and is not pushed into the mutating busy gate. UI refreshes occur after mutating promises settle.

## Dirty behavior

HPA-346 exposes the existing dirty boolean but does not create a second unsaved-changes state machine.

The City panel displays either:

- `Unsaved changes`; or
- `Saved`.

Save Now remains explicit. HPA-346 does not add autosave, navigation guards, unload prompts, or draft recovery.

Loading/New City are explicit player actions and continue to use the existing runtime behavior. Delete keeps the required one-step confirmation.

## Error behavior

There are two error sources at the UI boundary:

1. `snapshot.persistence.error` for mutating runtime operations;
2. `cityListError` for the read-only `listCities()` call, because listing intentionally does not mutate runtime persistence state.

The rendered copy is:

```ts
cityListError ??
(snapshot.persistence.error === null
  ? null
  : workingSaveErrorMessage(snapshot.persistence.error))
```

Diagnostics never cross into component text.

A failed Save keeps dirty state and the prior committed record because the runtime/store contracts already guarantee that behavior.

A failed Load keeps the current gameplay and active identity for definite read/restore failures.

No new error codes, recovery states, or host-specific branches are added.

## Browser persistence proof

Add one focused Chromium test for the first complete browser workflow:

1. start with a fresh Playwright context;
2. create a named city through the real New City screen;
3. open City and click Save Now;
4. reload the page;
5. verify the city library appears instead of the empty New City screen;
6. verify the city row is present;
7. click Continue;
8. verify the game shell returns and the active city name matches.

This test uses the existing real WASM runtime and real IndexedDB adapter. It does not use `fake-indexeddb`.

Do not expand this into the HPA-349 cross-host matrix. HPA-349 still owns the representative second-city + gameplay-mutation flow across browser and native Tauri.

## Focused tests

### Shared CityList

Cover:

- active row does not offer Load;
- inactive row invokes Load with the correct ID;
- rename trims the value and rejects empty names;
- Delete requires the second confirmation click;
- busy disables Load/Rename/Delete controls.

### App / screen integration

Extend `tests/ui/appShell.test.ts` to cover:

- empty list keeps the existing New City experience;
- saved cities + no active city render the library;
- Continue loads the first summary ID;
- list failure shows concise copy and Retry;
- active City panel invokes Save Now;
- active City panel can open and cancel New City;
- Rename/Delete callbacks use the selected city ID;
- busy disables conflicting city actions;
- active delete publication returns to the library;
- failed Load leaves the current game shell active.

Runtime save/load/rename/delete correctness is already covered by the working-save runtime tests. HPA-346 should not duplicate those branch matrices in UI tests.

## Styling

Reuse the existing Signal Console visual language and current New City card styles.

Add only the classes needed for:

- city library layout;
- city rows/actions;
- compact save status/actions in the City panel;
- inline rename and delete confirmation.

No design-system extraction or generic button/form component work is part of HPA-346.

## Documentation

Update `docs/architecture.md` to replace the HPA-345-only no-city flow with the completed browser working-save workflow:

```text
startup
  -> list cities
  -> empty: New City
  -> existing: Continue / Load / Rename / Delete
  -> active game
  -> Save Now / switch city / New City
```

Keep HPA-344 clearly marked as the remaining native durability task and HPA-349 as the final cross-host smoke.

## Scope boundaries

HPA-346 includes only:

- city list;
- Continue / Load;
- Save Now;
- Rename;
- Delete with one confirmation;
- New City entry from the library/active City panel;
- one real-browser reload/Continue persistence smoke.

HPA-346 does **not** add:

- native Tauri save files (HPA-344);
- autosave/checkpoints/recovery;
- duplicate city;
- folders/tags/search/thumbnails;
- import/export/cloud sync;
- migration, legacy readers, compatibility badges;
- multi-tab/window ownership;
- optimistic writes or background refresh;
- save repositories/managers/view models/routers/state machines;
- new dependencies;
- security-hardening or hostile-input frameworks.

## Acceptance criteria

- [ ] HPA-346 reuses the existing six-operation runtime controller without widening its interface.
- [ ] City summaries remain UI-local read state rather than a new runtime/store cache.
- [ ] Empty storage still leads directly to the existing New City form.
- [ ] Existing cities lead to a full-screen city library with Continue, Load, Rename, Delete, and New City.
- [ ] Continue uses the first already-sorted `CitySummary`.
- [ ] The active City panel exposes Save Now, dirty state, New City, and the same list-management actions.
- [ ] New City uses the existing form with only an optional Cancel callback.
- [ ] Rename trims and rejects empty names without adding a validation framework.
- [ ] Delete requires one inline confirmation.
- [ ] All mutating actions are disabled while the existing runtime busy gate is active.
- [ ] List errors and runtime errors both reuse `workingSaveErrorMessage` and never expose diagnostics.
- [ ] Failed Save keeps dirty state/prior storage through existing runtime/store behavior.
- [ ] Failed Load preserves current gameplay/identity through existing runtime behavior.
- [ ] One real Chromium test proves create -> Save Now -> reload -> city library -> Continue using IndexedDB + WASM.
- [ ] HPA-344 remains separate for native durability; HPA-349 remains separate for cross-host smoke.
- [ ] No autosave, recovery, migration, compatibility, multi-instance, security, or generic save-management framework is introduced.
