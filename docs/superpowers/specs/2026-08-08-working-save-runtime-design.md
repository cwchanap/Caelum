# HPA-543 Working Save Runtime Design

**Issue:** HPA-543  
**Status:** Proposed  
**Decision date:** 2026-08-08  
**Prerequisites:** HPA-547, HPA-548  
**Downstream:** HPA-343, HPA-345, HPA-346, HPA-344

## 1. Decision

Replace the generalized TypeScript persistence coordinator with one focused `workingSaveRuntime.ts` module built around the current player workflow:

- one active city or no active city;
- one `busy` boolean for mutating persistence;
- one `dirty` boolean;
- one current mutating-persistence error;
- one read-only `listCities` pass-through;
- Save, Load, New City, Rename, and Delete mutations;
- the existing gameplay serialized queue only to drain gameplay admitted before a persistence mutation begins.

Delete leases, persistence FIFOs, city fences, session/load tokens, revision baselines, superseded outcomes, lifecycle reservation flags, rollback/reconciliation state, and coordinator ownership tests. Do not replace them with another manager, scheduler, mutex abstraction, command bus, state machine, registry, or service layer.

This is an active-development breaking change. Update all direct call sites in the same implementation PR. No compatibility aliases or transitional controller methods remain.

## 2. Why now

HPA-547 and HPA-548 are complete:

- `GameBackend` exposes pure sandbox candidate construction and candidate-first restore through one small host contract;
- `CitySaveStore` has only the six working-city operations required by Phase 1.

The remaining runtime still carries complexity introduced before those simplifications: `SharedPersistenceCoordinator`, lease handoff, per-city FIFO tails, city fences, current/persisted revisions, session/load tokens, supersession, foreground admission, and several lifecycle reservation flags.

The real IndexedDB/native adapters and city-library UI have not landed yet. HPA-543 removes that coordination tax before downstream features depend on it.

## 3. Scope boundary

### HPA-543 owns

- `src/runtime/workingSaveRuntime.ts` as the only persistence orchestration module;
- the minimal persistence view and controller types;
- one synchronous busy admission gate for mutating persistence;
- a read-only city-list path that stays behind the runtime boundary;
- dirty tracking as a boolean;
- runtime integration that blocks new gameplay mutations and backend previews while persistence is busy;
- Save, Load, New City, Rename, and Delete semantics;
- a small ambiguous-restore safety rule that detaches active identity instead of rolling back;
- synchronous disposal that stops publication without waiting for uncancellable work;
- removal of `persistenceCoordinator.ts` and its architecture-specific test suite;
- removal of revision/session/supersession/fence/lease code and debug seams;
- deletion of obsolete coordinator design/plan documents;
- cleanup of stale HPA-548 runtime-bridge prose and rollback/coordinator comments.

### HPA-543 does not own

- IndexedDB persistence — HPA-343;
- native Tauri application-data storage — HPA-344;
- New City form/UI and no-city entry screen — HPA-345;
- city list/Continue/delete-confirmation UI — HPA-346;
- a “Save As current anonymous sandbox” workflow;
- autosave, checkpoints, duplicate city, import/export, recovery, cloud sync, migrations, or multi-window ownership;
- pre-release transport certification or repair — HPA-544 if observed failures justify it;
- broad gameplay/runtime refactoring unrelated to persistence.

## 4. Target public state

Reuse `CitySummary` as active-city metadata instead of keeping a second identity shape:

```ts
export interface RuntimePersistenceView {
  activeCity: CitySummary | null;
  busy: boolean;
  dirty: boolean;
  error: WorkingSaveError | null;
}
```

`CitySummary` already contains exactly the needed fields:

```ts
export interface CitySummary {
  id: string;
  name: string;
  createdAt: string;
  savedAt: string;
}
```

Delete:

- `ActiveCityIdentity`;
- `NewCityIdentity`;
- `lastSavedAt` as separate runtime state;
- `saveStatus`;
- `loadStatus`;
- `lifecycleStatus`;
- `currentRevision`;
- `persistedRevision`;
- `sessionToken`;
- `loadRequestToken`;
- any queued/capturing/writing/reading/restoring/rolling-back status.

A caller that needs progress knows only that a mutating persistence operation is busy. That is sufficient to disable conflicting actions.

`listCities()` is intentionally not represented in the view. It returns its list/error directly and does not create a second loading-status model.

## 5. Target controller

Expose the six current save-boundary operations through the runtime because they are already required by the known Phase 1 city-library workflow. This is not a compatibility hedge or generic future surface.

```ts
export interface NewCityRequest {
  name: string;
  sandbox: SandboxCreationRequest;
}

export type WorkingSaveError =
  | { kind: "busy" }
  | { kind: "unavailable" }
  | { kind: "noActiveCity" }
  | { kind: "store"; error: CitySaveStoreError }
  | { kind: "backend"; error: SnapshotError | SandboxHostError }
  | { kind: "sandbox"; error: SandboxCreationError };

export type WorkingSaveResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: WorkingSaveError };

export interface RuntimePersistenceController {
  listCities(): Promise<WorkingSaveResult<CitySummary[]>>;
  save(): Promise<WorkingSaveResult<CitySummary>>;
  load(cityId: string): Promise<WorkingSaveResult<CitySummary>>;
  createCity(request: NewCityRequest): Promise<WorkingSaveResult<CitySummary>>;
  renameCity(
    cityId: string,
    name: string,
  ): Promise<WorkingSaveResult<CitySummary>>;
  deleteCity(cityId: string): Promise<WorkingSaveResult<void>>;
}
```

Keep `sandbox` required. HPA-345 already defines the no-city flow as “choose name + Standard/Creative + Blank Grid/Crossroads, build a pure candidate, persist, activate.” Do not add an unrequested second creation mode that adopts the currently running anonymous bootstrap engine.

The error union remains small and reuses HPA-547 backend errors plus the HPA-548 store error. Do not create operation tokens, status objects, recovery errors, or an error-state machine.

A `busy` result is an admission result only; it does not replace the currently displayed persistence error.

## 6. Module boundary

`workingSaveRuntime.ts` is a closure-based helper, not a class or framework. It owns only persistence state and operations.

```ts
export interface WorkingSaveRuntimeHost {
  backend: GameBackend;
  saveStore?: CitySaveStore;
  initialCity: CitySummary | null;
  now: () => string;
  createCityId: () => string;
  awaitGameplayIdle: () => Promise<void>;
  installRestoredGameplay: (snapshot: RustGameSnapshot) => void;
  publish: () => void;
  isRuntimeDead: () => boolean;
}

export interface WorkingSaveRuntime {
  readonly controller: RuntimePersistenceController;
  getView(): RuntimePersistenceView;
  isBusy(): boolean;
  markDirty(): void;
  dispose(): void;
}
```

`installRestoredGameplay` mutates the runtime gameplay/UI closure without publishing. The working-save module then updates active-city/dirty/error state and publishes one coherent snapshot.

The module does not import Svelte components, IndexedDB, Tauri commands, gameplay entity types, route-editor types, or rendering code.

## 7. Read-only city listing

`listCities()` is a direct runtime-to-store read:

1. if the runtime is already dead/disposed or no store is configured, return `unavailable`;
2. call `saveStore.listCities()`;
3. map a store failure/throw to `{ kind: "store" }`;
4. return the result without changing `busy`, `dirty`, `activeCity`, or the shared mutating-persistence `error` field.

Do not put list behind the exclusive busy gate. A list read racing an atomic local write may observe either committed version; that is acceptable for the single-user city library.

Do not re-check liveness after the read. `listCities` never publishes or mutates shared runtime state, so converting a completed read into `unavailable` during teardown adds ceremony without protecting anything.

The future city-library component still calls the runtime, never IndexedDB/Tauri/store adapters directly.

## 8. One busy gate

Every **mutating** persistence action goes through one local exclusive runner:

1. If disposed/dead, return `unavailable`.
2. If `busy`, return `busy` immediately without changing state.
3. Set `busy = true` synchronously and clear the previous mutating-persistence error.
4. Publish so downstream UI can disable conflicting actions.
5. Await `gameplayQueue.drain()` through `awaitGameplayIdle`.
6. Re-check live/disposed state.
7. Perform the requested persistence workflow directly.
8. Convert expected store/backend failures into `WorkingSaveResult` values.
9. Catch any remaining throw at the exclusive-runner boundary and map it to the existing `backend.hostFailure` shape.
10. Set final success/error state only while the module is still live.
11. Clear `busy` in `finally`.
12. Publish final state only while the runtime is still live.

No persistence queue is needed. JavaScript’s synchronous assignment of `busy = true` closes mutation admission before the first `await`. Gameplay work admitted before that point drains; gameplay work attempted afterward is not admitted.

Store calls use a small local helper that catches a throwing adapter and maps it to that operation’s existing `CitySaveStoreError { code: "failed" }`. The outer runner catch is defense in depth, not another taxonomy.

## 9. Gameplay and preview ordering

Keep `createSerializedQueue` for gameplay because it already serializes dispatch/tick mutations and exposes `drain()`.

While mutating persistence is busy:

- `queueBackend` does not admit new dispatch/tick/reset mutations;
- do not start new route previews;
- do not start new road-mutation previews;
- preview-producing local UI actions must not transition into a pending preview state that cannot run.

This intentionally freezes simulation mutations during **all manual persistence mutations**, including Save, Rename, and Delete. That is wider than today’s New-City-only reservation, but it is deliberate: manual persistence is short, single-user, and the simpler rule removes all race-specific coordination.

Use `workingSave.isBusy()` directly at the existing admission/check sites. Do not preserve `previewAdmissionSuspended`, `backendAdmissionReserved`, or add a persistence-operation-kind flag merely to keep some previews alive.

A frame callback can fire while busy, drop its tick, and leave no RAF scheduled because the frame clears its own ID before calling the runtime. The final live publication from the exclusive runner must therefore continue to call the existing `canvasHost.syncAnimationLoop()` path. Focused integration coverage must prove the animation loop is re-armed after a delayed Save finishes.

Already-started preview work may settle while gameplay drains. Successful Load/New City bumps `previewRuntimeEpoch` and invalidates preview coordinators before installing the replacement gameplay view, so an old-city response cannot publish after the swap.

## 10. Dirty state

Dirty becomes a literal boolean.

```ts
markDirty(): void {
  if (activeCity !== null) dirty = true;
}
```

Call `markDirty()` before publishing an applied gameplay mutation/tick/reset result.

Rules:

- no active city: gameplay does not create a saveable dirty state;
- applied gameplay mutation/tick/reset: `dirty = true`;
- UI-only transitions and rejected gameplay actions: unchanged;
- successful Save: `dirty = false`;
- failed Save: unchanged;
- successful Load: `dirty = false`;
- definite failed Load: unchanged;
- successful New City: `dirty = false`;
- Rename: unchanged;
- deleting the active city: active city becomes `null` and `dirty = false`;
- deleting an inactive city: unchanged;
- ambiguous thrown restore: active city becomes `null` and `dirty = false` as a narrow overwrite-prevention measure.

No revision arithmetic or monotonic persisted baseline remains.

## 11. Anonymous bootstrap state

Today `src/main.ts` creates a runtime without a store or active city, so the Rust default sandbox is playable during development.

That anonymous sandbox is **not** a save-backed city contract. HPA-543 does not add “adopt current sandbox” or Save As semantics. When HPA-345 lands the real browser persistence entry flow, its existing `no-city startup` requirement owns the UX that asks the player to create a named Standard/Creative Blank Grid/Crossroads city before entering save-backed play.

Until then:

- anonymous gameplay remains disposable development state;
- `dirty` stays false without an active city;
- `save()` returns `noActiveCity`;
- `createCity()` always creates the explicitly requested fresh sandbox candidate.

This avoids adding a second creation path solely to preserve the temporary pre-persistence bootstrap experience.

## 12. Save

1. Enter the busy gate and drain gameplay.
2. Require an active city and configured store.
3. Call `backend.snapshotForSave()`.
4. Generate one save timestamp.
5. Call:

```ts
saveStore.updateCity(activeCity.id, {
  savedAt,
  snapshot: capture.snapshot,
});
```

6. On success, replace `activeCity` with the returned `CitySummary` and clear dirty.
7. On store/backend failure, keep the previous active summary and dirty value.

Save never creates a missing city and never re-reads storage after a definite failure.

## 13. Load

1. Enter the busy gate and drain gameplay.
2. Read `CitySaveRecord` with `saveStore.readCity(cityId)`.
3. Pass `record.snapshot` directly to `backend.restoreSnapshot`.
4. If restore returns `{ ok: false }`, leave public gameplay and active identity unchanged.
5. On success, invalidate old previews, install the restored gameplay snapshot without publishing, set:

```ts
activeCity = {
  ...record.city,
  savedAt: record.savedAt,
};
dirty = false;
```

6. Publish gameplay and persistence state together.

There is no per-city FIFO or source-city fence. The busy gate prevents Save/Rename/Delete/New City from overlapping this Load.

## 14. New City

`createCity({ name, sandbox })` owns ID/time generation so the HPA-345 UI submits only player choices.

1. Enter the busy gate and drain gameplay.
2. Generate one opaque ID with `createCityId()`.
3. Generate one timestamp with `now()` and use it for both `createdAt` and initial `savedAt`.
4. Call `backend.buildSandboxSnapshot(sandbox)`. This is pure and does not change active gameplay.
5. Build one `CitySaveRecord` and call `saveStore.createCity(record)`.
6. If create returns conflict/failure, current gameplay remains untouched.
7. Activate the already-persisted candidate with `backend.restoreSnapshot(candidate)`.
8. On success, install the returned gameplay snapshot, publish the returned `CitySummary` as active, and clear dirty.
9. If activation returns `{ ok: false }`, keep previous public gameplay/identity and leave the created city record available for later Load.

Do not auto-delete the new record, finalize it, inspect it, repair it, or enter recovery.

A create conflict is returned to the caller. A later New City attempt naturally receives a new generated ID; do not add an automatic retry loop.

## 15. Ambiguous thrown restore safety

HPA-547 distinguishes a definite `{ ok: false }` restore from a thrown host/transport failure. The current runtime performs canonical rollback because completion may be ambiguous. HPA-543 removes that rollback/reconciliation machinery, but it must not leave a stale city ID attached to an engine that may already have swapped.

For **Load and New City activation only**:

- returned `{ ok: false }` means definite non-mutation and preserves current gameplay/identity;
- a thrown `restoreSnapshot` maps to the concise `backend.hostFailure` result;
- on that thrown path, set `activeCity = null` and `dirty = false` before final publication;
- do not capture a prior canonical snapshot solely for rollback;
- do not auto-restore, re-read storage, auto-delete, finalize, repair, or enter fatal recovery.

Detaching identity is a narrow safety invariant, not a recovery state. If the host actually completed the swap, the next tick may expose target-city gameplay, but Save cannot overwrite the previous city because no city ID is active. If the host did not complete the swap, the player still needs to Load a city again before saving. Both outcomes prefer an explicit retry over silent cross-city overwrite.

Focused tests must prove:

- thrown Load restore resolves `hostFailure` and leaves `activeCity === null`;
- thrown New City activation leaves the newly created record available and `activeCity === null`;
- a subsequent `save()` returns `noActiveCity` rather than updating the formerly active city.

HPA-544 may harden an observed transport failure later. Do not retain the current rollback state machine for active development.

## 16. Rename

Expose `renameCity(cityId, name)` because HPA-346 already needs renaming from the city library.

1. Enter the busy gate and drain gameplay.
2. Call `saveStore.renameCity(cityId, name)`.
3. If the renamed ID is active, replace `activeCity` with the returned summary.
4. If inactive, leave current gameplay/persistence identity unchanged.
5. Dirty is unchanged.

## 17. Delete

Expose `deleteCity(cityId)` because HPA-346 already needs deleting active and inactive cities.

1. Enter the busy gate and drain gameplay.
2. Call `saveStore.deleteCity(cityId)`.
3. If the deleted ID is inactive, no gameplay state changes.
4. If active, set `activeCity = null` and `dirty = false` only after storage success.
5. Leave the in-memory engine snapshot untouched; the future city-library UI stops presenting it as an active city until another Load/New City succeeds.

Delete confirmation belongs to HPA-346. HPA-543 implements only runtime semantics and busy exclusion.

Remove `detachActiveCity`; Delete owns the current workflow that intentionally clears active identity without replacing gameplay.

## 18. Runtime integration

`createGameRuntime.ts` remains the gameplay/runtime composition root. Refactor today’s `commitLoadedSnapshot` into one no-publish installation helper:

```ts
const installRestoredGameplay = (snapshot: RustGameSnapshot): void => {
  clearHoverPreviewTimer();
  previewRuntimeEpoch += 1;
  previewCoordinator.invalidateRoute();
  invalidateRoadPreview();
  activeRouteSaveTokens.clear();
  nextRouteDraftInstanceId = 1;
  state = normalizeRustSnapshot(snapshot);
  ui = createUiState();
  backendError = null;
  rejection = null;
  sandboxResetError = null;
};
```

The exact body follows current successful Load/New City cleanup that has a real UI consumer. Keep the `previewRuntimeEpoch` bump: current ordinary Load does not bump it, and the HPA-543 installation boundary should close that staleness gap rather than preserve it.

Runtime construction provides simple defaults unless tests inject deterministic functions:

```ts
const now = options.now ?? (() => new Date().toISOString());
const createCityId =
  options.createCityId ?? (() => globalThis.crypto.randomUUID());
```

No ID service or dependency-injection framework is introduced.

## 19. Disposal and fatal runtime shutdown

Disposal is synchronous and intentionally does **not** wait for uncancellable gameplay/store/backend work.

`workingSave.dispose()`:

- sets `disposed = true` synchronously;
- prevents new persistence admission;
- returns `void`;
- does not track or await an in-flight mutation;
- late completions may settle their own promises but cannot publish or commit persistence view state after disposal.

`createGameRuntime.dispose()`:

- sets `dead = true` synchronously;
- calls `workingSave.dispose()`;
- stops canvas/preview work;
- returns `void`;
- does not drain `gameplayQueue` or persistence work;
- has no lease, ownership handoff, or replacement-runtime guarantee.

This matches the project’s explicit single-runtime scope. If a future supported workflow needs two runtimes to share one native engine safely, HPA-544 or a concrete feature can add the minimum observed handoff rule then.

A late backend failure after disposal must still not render or notify subscribers. Architecture-only tests that assert disposal waits for work or that a replacement runtime immediately reuses the same backend are deleted.

## 20. Error/throw discipline

The public persistence controller resolves `WorkingSaveResult` for ordinary runtime/store/backend failures; it does not leak raw promise rejections from expected call sites.

Use two levels only:

1. narrow wrappers around `CitySaveStore` calls convert a throwing adapter to the matching `{ operation, code: "failed" }` store error;
2. backend calls convert thrown transport/host errors to `{ code: "hostFailure", diagnostic }`.

The exclusive-runner outer `catch` is defense in depth for a gameplay-drain throw or missed call site and maps it to the same generic host-failure result. Do not add another error taxonomy.

## 21. Testing strategy

Keep tests proportional to player-visible behavior.

### Direct working-save tests

Cover:

- list cities: empty/populated, store failure, no-store unavailable, and successful read result retained even if disposal happens while reading;
- busy suppresses a second conflicting mutation while one store call is deferred;
- Save success clears dirty and updates saved time;
- Save failure preserves dirty and the prior record;
- Load success installs state and active summary;
- failed read/definite restore preserves current public gameplay and identity;
- thrown Load restore resolves backend failure, clears active identity, and prevents a later Save from targeting the old ID;
- New City success;
- create conflict/failure leaves current gameplay unchanged;
- definite activation failure leaves the created record available and current public gameplay/identity unchanged;
- thrown New City activation leaves the created record available and clears active identity;
- Rename active and inactive city;
- Delete active and inactive city;
- synchronous disposal during a delayed mutation causes no late publication/state commit.

### Runtime integration tests

Cover only wiring that the standalone module cannot prove:

- busy blocks new gameplay mutation admission until persistence completes;
- manual Save/Rename/Delete freeze mutation admission by design;
- a frame tick dropped while busy is followed by a re-armed animation loop after persistence completes;
- busy blocks new route/road preview admission without leaving pending preview state;
- a preview started before Load/New City cannot publish after successful engine swap;
- applied dispatch/tick/reset marks dirty for an active city;
- successful restore installs gameplay and persistence identity in one publication;
- disposal is synchronous and suppresses post-disposal render/subscriber publication without waiting for blocked backend work.

### Delete architecture-only tests

Remove tests whose sole subject is:

- lease ownership/handoff;
- closed-lease errors;
- foreground admission counters;
- per-city FIFO ordering;
- city fence reference counts;
- session/load token supersession;
- same-city/cross-city race matrices;
- runtime recreation ownership;
- disposal waiting for uncancellable work;
- rollback/fatal-coherence after ambiguous host completion.

Retain `delayedCitySaveStore.ts` only as a small helper for focused busy/disposal tests. Remove unused mutation-order or multi-operation machinery if rewritten tests no longer need it.

## 22. Documentation cleanup

HPA-548’s store contract remains authoritative for `CitySaveRecord`, `CitySummary`, six operations, atomicity, and error codes. Its old runtime-bridge section describes the temporary coordinator-era consumer and is superseded by this HPA-543 design.

The implementation stamps that HPA-548 runtime section as superseded rather than letting downstream work copy the obsolete controller.

Delete the obsolete HPA-499 coordinator plan/design documents because their architecture is intentionally removed. Keep Git history as the archive.

## 23. File impact

### Create

- `src/runtime/workingSaveRuntime.ts`;
- `tests/runtime/workingSaveRuntime.test.ts`.

### Modify

- `src/runtime/createGameRuntime.ts`;
- `src/runtime/types.ts`;
- `src/persistence/citySaveStore.ts` — remove stale rollback-dependent contract comments only;
- `src/App.svelte` — replace lease/drain teardown commentary with synchronous terminal disposal;
- `tests/runtime/citySaveRuntime.test.ts`;
- `tests/runtime/gameRuntime.test.ts`;
- `tests/runtime/postDisposalBackendFailure.test.ts` — retain only current live-failure/no-late-publication behavior and remove wait/replacement-runtime assertions;
- `tests/runtime/persistence/citySaveStoreContract.ts` — remove stale `rollbackNewCity`/`saveWorking`/`renameActiveCity` prose while preserving store atomicity assertions;
- `tests/ui/appShell.test.ts` and other direct persistence-type fixtures;
- `tests/runtime/delayedCitySaveStore.ts` if its helper surface can shrink;
- `docs/architecture.md` / `CLAUDE.md` where they describe the removed coordinator/rollback/disposal semantics;
- `docs/superpowers/specs/2026-08-05-six-operation-city-save-store-design.md` — keep the existing supersession note for the runtime bridge.

### Delete

- `src/runtime/persistenceCoordinator.ts`;
- `tests/runtime/persistenceCoordinator.test.ts`;
- `docs/superpowers/plans/2026-08-01-runtime-persistence-coordinator.md`;
- `docs/superpowers/specs/2026-07-31-save-envelope-store-runtime-persistence-design.md`.

Do not delete store contract tests or host-backend tests that still protect the two current implementations.

## 24. Acceptance criteria

- `RuntimePersistenceController` exposes `listCities`, Save, Load, New City, Rename, and Delete; UI never needs direct `CitySaveStore` access.
- The six methods are justified by current HPA-345/HPA-346 workflows, not future compatibility.
- `RuntimePersistenceView` contains only active city, busy, dirty, and one mutating-persistence error.
- Mutating persistence uses one busy gate, not a coordinator/queue framework.
- `listCities` is read-only and does not add loading/busy lifecycle state or post-read liveness ceremony.
- New gameplay mutations and backend previews are not admitted while persistence is busy.
- Manual Save/Rename/Delete intentionally freeze simulation mutation admission and the animation loop resumes afterward.
- Successful engine swap invalidates old preview epochs before publishing the new city.
- Dirty is a literal boolean and no revision baseline remains.
- The anonymous bootstrap sandbox remains disposable; HPA-345 owns named-city entry and no Save-As-current mode is added.
- New City persists a pure candidate before activation and needs no rollback.
- Definite failed Save/Load preserves prior committed/public state as applicable.
- A thrown restore clears active identity before publication so a later Save cannot overwrite the wrong city.
- Thrown host failures resolve through the small error union and do not trigger rollback/reconciliation.
- Disposal is synchronous, never waits for uncancellable work, and suppresses late publication.
- Rename/Delete operate on arbitrary city IDs because they are current HPA-346 operations.
- No module-global ownership or storage registry remains.
- No revision/session/supersession/pending/finalize/generation machinery remains.
- Persistence orchestration is isolated in one small current-feature module.
- HPA-548 runtime-bridge prose is clearly marked superseded while its store contract remains authoritative.
- Unrelated runtime code is not broadly refactored.
- Production/test code shows material net deletion without removing multi-city behavior.

## 25. Non-goals

- Checkpoints, autosave, background persistence, recovery, import/export, cloud sync, migrations, or multi-instance correctness.
- Save As/adopt-current anonymous bootstrap gameplay.
- Broad UI/runtime redesign.
- Formal architecture frameworks.
- Per-operation busy state solely to keep previews alive during some persistence mutations.
- Pre-release certification of ambiguous native transport completion.

## 26. Review guardrails

Reject an implementation that:

- replaces `SharedPersistenceCoordinator` with a differently named manager/lock/service framework;
- lets Svelte call a save-store adapter directly for city listing;
- adds a second persistence queue or operation-kind state machine;
- makes `NewCityRequest.sandbox` optional to add an unrequested bootstrap-adoption mode;
- preserves session/revision/supersession/fence machinery under new names;
- lets previews enter the backend while a persistence mutation is active;
- leaves a city ID active after a thrown ambiguous restore;
- makes disposal wait for uncancellable work or preserves replacement-runtime ownership tests;
- leaks ordinary backend/store throws past the `WorkingSaveResult` boundary;
- reintroduces rollback/reconciliation for host ambiguity;
- adds compatibility, migration, recovery, security, or multi-window work;
- ports architecture-only race matrices into the new module;
- broadens this ticket into IndexedDB/Tauri/UI implementation.