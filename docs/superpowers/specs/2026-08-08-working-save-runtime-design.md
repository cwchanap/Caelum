# HPA-543 Working Save Runtime Design

**Issue:** HPA-543  
**Status:** Proposed  
**Decision date:** 2026-08-08  
**Prerequisites:** HPA-547, HPA-548  
**Downstream:** HPA-343, HPA-345, HPA-346, HPA-344

## 1. Decision

Replace the generalized TypeScript persistence coordinator with one focused `workingSaveRuntime.ts` module built around the current player workflow:

- one active city or no active city;
- one `busy` boolean;
- one `dirty` boolean;
- one current persistence error;
- Save, Load, New City, Rename, and Delete;
- the existing gameplay serialized queue only to drain already-admitted gameplay before persistence begins.

Delete leases, persistence FIFOs, city fences, session/load tokens, revision baselines, superseded outcomes, lifecycle reservation flags, rollback/reconciliation state, and coordinator ownership tests. Do not replace them with another manager, scheduler, mutex abstraction, command bus, state machine, registry, or service layer.

This is an active-development breaking change. Update all direct call sites in the same implementation PR. No compatibility aliases or transitional controller methods remain.

## 2. Why now

HPA-547 and HPA-548 are complete:

- `GameBackend` now exposes pure sandbox candidate construction and candidate-first restore through the same small host contract;
- `CitySaveStore` now has only the six working-city operations required by Phase 1.

The remaining runtime still carries the complexity introduced before those simplifications: `SharedPersistenceCoordinator`, lease handoff, per-city FIFO tails, city fences, current/persisted revisions, session and load tokens, supersession, foreground admission, and several lifecycle reservation flags.

The real IndexedDB/native adapters and city-library UI have not landed yet. HPA-543 should remove that coordination tax before downstream features depend on it.

## 3. Scope boundary

### HPA-543 owns

- `src/runtime/workingSaveRuntime.ts` as the only persistence orchestration module;
- the minimal persistence view and controller types;
- one synchronous busy admission gate;
- dirty tracking as a boolean;
- runtime integration that blocks new gameplay mutations while persistence is active;
- Save, Load, New City, Rename, and Delete semantics;
- removal of `persistenceCoordinator.ts` and its architecture-specific test suite;
- removal of revision/session/supersession/fence/lease code and debug seams;
- deletion of obsolete coordinator design/plan documents;
- cleanup of stale comments that still describe rollback/coordinator behavior.

### HPA-543 does not own

- IndexedDB persistence — HPA-343;
- native Tauri application-data storage — HPA-344;
- New City form/UI — HPA-345;
- city list/Continue/confirmation UI — HPA-346;
- autosave, checkpoints, duplicate city, import/export, recovery, cloud sync, migrations, or multi-window ownership;
- additional snapshot hardening for hypothetical transport failures — HPA-544 if an observed problem justifies it;
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
- any published queued/capturing/writing/reading/restoring/rolling-back status.

A caller that needs progress knows only that persistence is busy. That is sufficient to disable conflicting actions.

## 5. Target controller

Use direct current-feature names and remove the temporary `detachActiveCity` surface:

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

The error union remains small and reuses the already-reduced HPA-547 backend errors plus the HPA-548 store error. Do not create operation tokens, status objects, recovery errors, or an error-state machine.

A `busy` result is an admission result only; it does not replace the currently displayed persistence error.

## 6. Module boundary

`workingSaveRuntime.ts` is a closure-based helper, not a class or framework. It owns only persistence state and operations.

Conceptual dependencies:

```ts
export interface WorkingSaveRuntimeHost {
  backend: GameBackend;
  saveStore?: CitySaveStore;
  now: () => string;
  createCityId: () => string;
  awaitGameplayIdle: () => Promise<void>;
  installRestoredGameplay: (snapshot: RustGameSnapshot) => void;
  publish: () => void;
  isRuntimeDead: () => boolean;
}
```

Conceptual returned surface:

```ts
export interface WorkingSaveRuntime {
  readonly controller: RuntimePersistenceController;
  getView(): RuntimePersistenceView;
  isBusy(): boolean;
  markDirty(): void;
  dispose(): Promise<void>;
}
```

`installRestoredGameplay` mutates the runtime's gameplay/UI closure without publishing. The working-save module then updates active-city/dirty/error state and publishes one coherent snapshot.

The module does not import Svelte components, IndexedDB, Tauri commands, gameplay entity types, route-editor types, or rendering code.

## 7. One busy gate

Every persistence action goes through one local exclusive runner:

1. If disposed/dead, return `unavailable`.
2. If `busy`, return `busy` immediately without changing state.
3. Set `busy = true` synchronously and clear the previous persistence error.
4. Publish so downstream UI can disable conflicting actions.
5. Await `gameplayQueue.drain()` through `awaitGameplayIdle`.
6. Perform the one requested persistence workflow directly.
7. After every awaited backend/store call, stop if the runtime was disposed/dead.
8. Set the final success/error state.
9. Clear `busy` in `finally`.
10. Publish the final state only while the runtime is still live.

No persistence queue is needed. JavaScript's synchronous assignment of `busy = true` closes admission before the first `await`. Gameplay work admitted before that point drains; gameplay work attempted afterward is rejected/no-op'd by the runtime admission check.

## 8. Gameplay ordering

Keep `createSerializedQueue` for gameplay because it already serializes dispatch/tick mutations and exposes `drain()`.

Change runtime mutation admission so new backend-mutating gameplay work does not enter the gameplay queue while persistence is busy. Existing queued work is allowed to finish, then persistence proceeds.

Read-only route/road previews may continue while Save/Rename/Delete are busy. Successful Load/New City invalidates existing preview epochs before installing the restored gameplay snapshot so an old preview cannot publish into the new city.

Do not add a second queue, mutex, scheduler, command bus, or general lock abstraction.

## 9. Dirty state

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
- failed Load: unchanged;
- successful New City: `dirty = false`;
- Rename: unchanged;
- deleting the active city: active city becomes `null` and `dirty = false`;
- deleting an inactive city: unchanged.

No revision arithmetic or monotonic persisted baseline remains.

## 10. Save

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

## 11. Load

1. Enter the busy gate and drain gameplay.
2. Read `CitySaveRecord` with `saveStore.readCity(cityId)`.
3. Pass `record.snapshot` directly to `backend.restoreSnapshot`.
4. If restore returns `{ ok: false }`, leave the public gameplay snapshot and active city unchanged.
5. On success, invalidate old previews, install the restored gameplay snapshot without publishing, set:

```ts
activeCity = {
  ...record.city,
  savedAt: record.savedAt,
};
dirty = false;
```

6. Publish the gameplay and persistence state together.

There is no per-city FIFO or source-city fence. The busy gate prevents a Save/Rename/Delete from overlapping this Load.

## 12. New City

`createCity({ name, sandbox })` owns ID/time generation so the future UI submits only player choices.

1. Enter the busy gate and drain gameplay.
2. Generate one opaque ID with `createCityId()`.
3. Generate one timestamp with `now()` and use it for both `createdAt` and initial `savedAt`.
4. Call `backend.buildSandboxSnapshot(sandbox)`. This is pure and does not change active gameplay.
5. Build one `CitySaveRecord` and call `saveStore.createCity(record)`.
6. If create returns conflict/failure, current gameplay remains untouched.
7. Activate the already-persisted candidate with `backend.restoreSnapshot(candidate)`.
8. On success, install the returned gameplay snapshot, publish the returned `CitySummary` as active, and clear dirty.
9. If activation returns `{ ok: false }`, keep the previous public gameplay/active city and leave the created city record available for a later Load.

Do not auto-delete the new record, finalize it, inspect it, repair it, or enter recovery.

A create conflict is returned to the caller. The next New City attempt naturally receives a newly generated ID; do not add an automatic retry loop.

## 13. Ambiguous thrown host failures

HPA-547 intentionally distinguishes a definite `{ ok: false }` restore from a thrown host/transport failure. The current runtime rolls back after a thrown restore because completion is ambiguous.

HPA-543 deliberately removes that rollback/reconciliation branch.

For both Load and New City:

- a returned `{ ok: false }` is treated as definite non-mutation and preserves current gameplay;
- a thrown backend/IPC failure becomes the current concise backend error;
- do not capture a prior canonical snapshot solely for rollback;
- do not auto-restore, re-read storage, auto-delete, enter fatal recovery, or reconcile identities.

The public TypeScript snapshot/active-city identity is not changed on the thrown path. The host's actual completion is not certified after a transport exception. If real testing shows this matters, HPA-544 may harden the observed failure mode. Do not retain a large active-development state machine for a hypothetical transport ambiguity.

## 14. Rename

Expose `renameCity(cityId, name)`, not active-only rename.

1. Enter the busy gate and drain gameplay.
2. Call `saveStore.renameCity(cityId, name)`.
3. If the renamed ID is active, replace `activeCity` with the returned summary.
4. If inactive, leave current gameplay/persistence identity unchanged.
5. Dirty is unchanged.

This directly supports the later city library without another runtime API break.

## 15. Delete

Expose `deleteCity(cityId)`.

1. Enter the busy gate and drain gameplay.
2. Call `saveStore.deleteCity(cityId)`.
3. If the deleted ID is inactive, no gameplay state changes.
4. If active, set `activeCity = null` and `dirty = false` only after storage success.
5. Leave the in-memory engine snapshot untouched; the future city-library UI stops presenting it as an active city until another Load/New City succeeds.

The one-confirmation UI belongs to HPA-346. HPA-543 implements only the runtime semantics and busy exclusion.

Remove `detachActiveCity`; Delete now owns the only current workflow that intentionally clears active identity without replacing gameplay.

## 16. Runtime integration

`createGameRuntime.ts` remains the gameplay/runtime composition root. Add one small helper for successful persistence activation:

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

The exact body follows the current successful Load/New City cleanup that has a real UI consumer. Do not preserve exact transient hover/selection/drawer rollback state after a failed candidate because the candidate is never installed before a definite success.

Runtime construction provides defaults unless tests inject deterministic functions:

```ts
const now = options.now ?? (() => new Date().toISOString());
const createCityId =
  options.createCityId ?? (() => globalThis.crypto.randomUUID());
```

No ID service or dependency-injection framework is introduced.

## 17. Disposal and fatal runtime shutdown

The working-save runtime tracks at most one in-flight promise.

`dispose()`:

- marks the working-save module disposed synchronously;
- prevents new persistence admission;
- waits for the one in-flight persistence operation if present;
- never publishes completion/error after disposal.

`createGameRuntime.dispose()`:

- marks the gameplay runtime dead;
- stops canvas/preview work;
- awaits gameplay drain and working-save disposal;
- has no persistence lease to close or release.

If fatal gameplay backend failure begins while a persistence request is waiting for already-admitted gameplay to drain, the working-save operation observes dead/disposed after the drain and exits without starting the store/backend persistence step.

No outstanding counter, foreground admission registry, lease handoff, pinned state, or drain-all coordinator is retained.

## 18. Testing strategy

Keep tests proportional to player-visible behavior.

### Direct working-save tests

Cover:

- busy suppresses a second conflicting action while one store call is deferred;
- applied gameplay marks dirty through runtime integration;
- Save success clears dirty and updates saved time;
- Save failure preserves dirty and the prior record;
- Load success installs state and active summary;
- failed read/definite restore preserves current public gameplay and identity;
- New City success;
- create conflict/failure leaves current gameplay unchanged;
- definite activation failure leaves the created record available and current public gameplay/identity unchanged;
- Rename active and inactive city;
- Delete active and inactive city;
- disposal during one delayed operation produces no late publication.

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
- rollback/fatal-coherence after ambiguous host completion.

Retain `delayedCitySaveStore.ts` only as a small test helper for the focused busy/disposal cases. Remove unused mutation-order or multi-operation machinery if the rewritten tests no longer need it.

## 19. File impact

### Create

- `src/runtime/workingSaveRuntime.ts`
- `tests/runtime/workingSaveRuntime.test.ts`

### Modify

- `src/runtime/createGameRuntime.ts`
- `src/runtime/types.ts`
- `src/persistence/citySaveStore.ts` — remove stale rollback-specific contract comments
- `src/App.svelte` — remove lease-specific disposal commentary
- `tests/runtime/citySaveRuntime.test.ts` — either fold remaining integration coverage into `workingSaveRuntime.test.ts` or reduce to runtime-integration-only cases
- `tests/runtime/gameRuntime.test.ts`
- `tests/ui/appShell.test.ts`
- `tests/runtime/delayedCitySaveStore.ts` only if the focused tests justify keeping it
- architecture documentation that describes the current runtime boundary

### Delete

- `src/runtime/persistenceCoordinator.ts`
- `tests/runtime/persistenceCoordinator.test.ts`
- `docs/superpowers/plans/2026-08-01-runtime-persistence-coordinator.md`
- `docs/superpowers/specs/2026-07-31-save-envelope-store-runtime-persistence-design.md` if no remaining current contract depends on it

Use repository-wide searches before deletion to identify any additional imports. Do not refactor unrelated runtime consumers merely because `createGameRuntime.ts` is large.

## 20. Sequencing

Use green, reviewable commits:

1. add the standalone working-save module and focused unit tests beside the current coordinator;
2. atomically cut `createGameRuntime`, runtime types, and direct tests to the busy/dirty controller;
3. delete the old coordinator, architecture-only tests, debug seams, and obsolete docs/comments;
4. run full verification and absence scans.

Do not introduce a compatibility layer to make the intermediate commits easier. Each commit should either be independently green or keep source/test changes that cannot compile independently in one atomic commit.

## 21. Acceptance criteria

- `RuntimePersistenceView` contains only active city, busy, dirty, and one error.
- Active city reuses `CitySummary`; no duplicate active/new-city identity type remains.
- Persistence controller exposes only Save, Load, Create, Rename, and Delete.
- New City generates ID/timestamps inside the runtime and persists the pure candidate before activation.
- A returned restore failure preserves the current public gameplay and active identity without rollback.
- Save failure leaves dirty and the previous record intact.
- Rename/Delete share the same busy gate.
- Applied gameplay marks one dirty boolean; no revision baseline remains.
- No `SharedPersistenceCoordinator`, persistence lease, per-city FIFO, city fence, session/load token, superseded outcome, lifecycle reservation, or rollback-coherence machinery remains.
- No module-global ownership/storage registry remains.
- Disposal suppresses late persistence publication without a drain-all ownership framework.
- Production/test code shows material net deletion.
- HPA-343/HPA-345/HPA-346 can consume the resulting runtime/store boundary without reintroducing persistence coordination abstractions.

## 22. Review guardrails

Reject an implementation that:

- replaces the coordinator with a differently named manager/service/mutex/scheduler framework;
- keeps old controller methods or statuses as deprecated aliases;
- retains revision/session/supersession state for hypothetical races;
- adds an automatic New City retry/reconciliation loop;
- auto-deletes a persisted New City after activation failure;
- reintroduces snapshot validation in TypeScript;
- blocks on pre-release security, migration, multi-window, timeout, or recovery work;
- broad-refactors unrelated gameplay/UI code;
- preserves architecture-only tests simply to maintain a test count;
- removes the existing gameplay queue even though it still has a current mutation-serialization purpose.
