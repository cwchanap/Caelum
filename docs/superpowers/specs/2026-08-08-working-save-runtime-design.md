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
- the existing gameplay serialized queue only to drain already-admitted gameplay before a persistence mutation begins.

Delete leases, persistence FIFOs, city fences, session/load tokens, revision baselines, superseded outcomes, lifecycle reservation flags, rollback/reconciliation state, and coordinator ownership tests. Do not replace them with another manager, scheduler, mutex abstraction, command bus, state machine, registry, or service layer.

This is an active-development breaking change. Update all direct call sites in the same implementation PR. No compatibility aliases or transitional controller methods remain.

## 2. Why now

HPA-547 and HPA-548 are complete:

- `GameBackend` exposes pure sandbox candidate construction and candidate-first restore through one small host contract;
- `CitySaveStore` has only the six working-city operations required by Phase 1.

The remaining runtime still carries the complexity introduced before those simplifications: `SharedPersistenceCoordinator`, lease handoff, per-city FIFO tails, city fences, current/persisted revisions, session and load tokens, supersession, foreground admission, and several lifecycle reservation flags.

The real IndexedDB/native adapters and city-library UI have not landed yet. HPA-543 removes that coordination tax before downstream features depend on it.

## 3. Scope boundary

### HPA-543 owns

- `src/runtime/workingSaveRuntime.ts` as the only persistence orchestration module;
- the minimal persistence view and controller types;
- one synchronous busy admission gate for mutating persistence;
- a read-only city-list path that stays behind the runtime boundary;
- dirty tracking as a boolean;
- runtime integration that blocks new gameplay mutations and new backend previews while persistence is busy;
- Save, Load, New City, Rename, and Delete semantics;
- removal of `persistenceCoordinator.ts` and its architecture-specific test suite;
- removal of revision/session/supersession/fence/lease code and debug seams;
- deletion of obsolete coordinator design/plan documents;
- cleanup of stale HPA-548 runtime-bridge prose and rollback/coordinator comments.

### HPA-543 does not own

- IndexedDB persistence — HPA-343;
- native Tauri application-data storage — HPA-344;
- New City form/UI — HPA-345;
- city list/Continue/delete-confirmation UI — HPA-346;
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

A caller that needs progress knows only that a mutating persistence operation is busy. That is sufficient to disable conflicting actions.

`listCities()` is intentionally not represented in the view. It returns its list/error directly and does not create a second loading-status model.

## 5. Target controller

Expose all six current save-boundary operations through the runtime so HPA-346 never needs direct store access or another controller API break:

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

The error union remains small and reuses the already-reduced HPA-547 backend errors plus the HPA-548 store error. Do not create operation tokens, status objects, recovery errors, or an error-state machine.

A `busy` result is an admission result only; it does not replace the currently displayed persistence error.

## 6. Module boundary

`workingSaveRuntime.ts` is a closure-based helper, not a class or framework. It owns only persistence state and operations.

Conceptual dependencies:

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

## 7. Read-only city listing

`listCities()` is a direct runtime-to-store read:

1. if the runtime is dead/disposed or no store is configured, return `unavailable`;
2. call `saveStore.listCities()`;
3. map a store failure to `{ kind: "store" }`;
4. return the summaries without changing `busy`, `dirty`, `activeCity`, or the shared mutating-persistence `error` field.

Do not put list behind the exclusive busy gate. A list read racing an atomic local write may observe either committed version; that is acceptable for the single-user city library and avoids inventing read coordination.

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
9. Catch any remaining throw at the exclusive-runner boundary and convert it to the existing generic `backend.hostFailure` shape so controller promises stay closed over `WorkingSaveResult`.
10. Set final success/error state.
11. Clear `busy` in `finally`.
12. Publish final state only while the runtime is still live.

No persistence queue is needed. JavaScript's synchronous assignment of `busy = true` closes mutation admission before the first `await`. Gameplay work admitted before that point drains; gameplay work attempted afterward is not admitted.

Store calls should still use a small local helper that catches a throwing adapter and maps it to that operation's existing `CitySaveStoreError { code: "failed" }`. The outer runner catch is last-line defense, not a substitute for correct store/backend mapping.

## 9. Gameplay and preview ordering

Keep `createSerializedQueue` for gameplay because it already serializes dispatch/tick mutations and exposes `drain()`.

While mutating persistence is busy:

- `queueBackend` does not admit new dispatch/tick/reset mutations;
- do not start new route previews;
- do not start new road-mutation previews;
- preview-producing local UI actions must not transition the UI into a pending preview state that cannot run.

Use `workingSave.isBusy()` directly at the existing admission/check sites. Do not preserve `previewAdmissionSuspended`, `backendAdmissionReserved`, or introduce a persistence-operation-kind flag merely to let previews run during Save/Rename/Delete. A brief preview freeze during any manual persistence action is the simpler active-development behavior.

Already-started preview work may settle while gameplay drains. Successful Load/New City performs the existing preview invalidation/epoch bump before installing the restored gameplay view, so a response from the old city cannot publish into the new city.

This preserves the real safety purpose of today's `previewAdmissionSuspended`/`previewRuntimeEpoch` behavior without keeping another lifecycle state machine.

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
- failed Load: unchanged;
- successful New City: `dirty = false`;
- Rename: unchanged;
- deleting the active city: active city becomes `null` and `dirty = false`;
- deleting an inactive city: unchanged.

No revision arithmetic or monotonic persisted baseline remains.

## 11. Save

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

## 12. Load

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

6. Publish gameplay and persistence state together.

There is no per-city FIFO or source-city fence. The busy gate prevents Save/Rename/Delete/New City from overlapping this Load.

## 13. New City

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

## 14. Ambiguous thrown host failures

HPA-547 intentionally distinguishes a definite `{ ok: false }` restore from a thrown host/transport failure. The current runtime rolls back after a thrown restore because completion is ambiguous.

HPA-543 deliberately removes that rollback/reconciliation branch.

For both Load and New City:

- a returned `{ ok: false }` is treated as definite non-mutation and preserves current gameplay;
- a thrown backend/IPC failure becomes the current concise `backend.hostFailure` result;
- do not capture a prior canonical snapshot solely for rollback;
- do not auto-restore, re-read storage, auto-delete, enter fatal recovery, or reconcile identities.

The public TypeScript snapshot/active-city identity is not changed on the thrown path. The host's actual completion is not certified after a transport exception. If real testing shows this matters, HPA-544 may harden the observed failure mode. Do not retain a large active-development state machine for hypothetical transport ambiguity.

## 15. Rename

Expose `renameCity(cityId, name)`, not active-only rename.

1. Enter the busy gate and drain gameplay.
2. Call `saveStore.renameCity(cityId, name)`.
3. If the renamed ID is active, replace `activeCity` with the returned summary.
4. If inactive, leave current gameplay/persistence identity unchanged.
5. Dirty is unchanged.

This directly supports the later city library without another runtime API break.

## 16. Delete

Expose `deleteCity(cityId)`.

1. Enter the busy gate and drain gameplay.
2. Call `saveStore.deleteCity(cityId)`.
3. If the deleted ID is inactive, no gameplay state changes.
4. If active, set `activeCity = null` and `dirty = false` only after storage success.
5. Leave the in-memory engine snapshot untouched; the future city-library UI stops presenting it as an active city until another Load/New City succeeds.

The one-confirmation UI belongs to HPA-346. HPA-543 implements only runtime semantics and busy exclusion.

Remove `detachActiveCity`; Delete owns the current workflow that intentionally clears active identity without replacing gameplay.

## 17. Runtime integration

`createGameRuntime.ts` remains the gameplay/runtime composition root. Refactor today's `commitLoadedSnapshot` into one small no-publish installation helper:

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

The exact body follows the current successful Load/New City cleanup that has a real UI consumer. Do not preserve active-city identity, revision/token resets, or exact transient rollback behavior inside this helper.

Runtime construction provides defaults unless tests inject deterministic functions:

```ts
const now = options.now ?? (() => new Date().toISOString());
const createCityId =
  options.createCityId ?? (() => globalThis.crypto.randomUUID());
```

No ID service or dependency-injection framework is introduced.

## 18. Disposal and fatal runtime shutdown

The working-save runtime tracks at most one in-flight mutating persistence promise.

`dispose()`:

- marks the working-save module disposed synchronously;
- prevents new mutating persistence admission;
- waits for the one in-flight mutation if present;
- never publishes completion/error after disposal.

A read-only `listCities()` may finish after disposal, but it never publishes shared runtime state. It re-checks liveness before returning a successful result and otherwise returns `unavailable`.

`createGameRuntime.dispose()`:

- marks gameplay runtime dead;
- stops canvas/preview work;
- awaits gameplay drain and working-save disposal;
- has no persistence lease to close or release.

If fatal gameplay backend failure begins while a persistence request is waiting for already-admitted gameplay to drain, the working-save operation observes dead/disposed after the drain and exits without starting the next store/backend persistence step.

No outstanding counter, foreground admission registry, lease handoff, pinned state, or drain-all coordinator is retained.

## 19. Error/throw discipline

The public persistence controller resolves `WorkingSaveResult` for ordinary runtime/store/backend failures; it does not leak raw promise rejections from expected call sites.

Use two levels only:

1. narrow wrappers around `CitySaveStore` calls convert a throwing adapter to the matching `{ operation, code: "failed" }` store error;
2. backend calls convert thrown transport/host errors to the existing `{ code: "hostFailure", diagnostic }` backend error.

The exclusive-runner outer `catch` is defense in depth for any remaining throw from gameplay drain or a missed call site and maps it to the same generic backend host-failure result. Do not add another error taxonomy solely for this fallback.

## 20. Testing strategy

Keep tests proportional to player-visible behavior.

### Direct working-save tests

Cover:

- list cities: empty/populated, store failure, and no-store unavailable;
- busy suppresses a second conflicting mutation while one store call is deferred;
- applied gameplay marks dirty through runtime integration;
- Save success clears dirty and updates saved time;
- Save failure preserves dirty and the prior record;
- Load success installs state and active summary;
- failed read/definite restore preserves current public gameplay and identity;
- thrown restore resolves a backend failure, clears busy, and does not reject the controller promise;
- New City success;
- create conflict/failure leaves current gameplay unchanged;
- definite activation failure leaves the created record available and current public gameplay/identity unchanged;
- Rename active and inactive city;
- Delete active and inactive city;
- disposal during one delayed mutation produces no late publication.

### Runtime integration tests

Cover only wiring that the standalone module cannot prove:

- busy blocks new gameplay mutation admission until persistence completes;
- busy blocks new route/road preview admission without leaving a pending preview state;
- a preview started before Load/New City cannot publish after successful engine swap;
- applied dispatch/tick/reset marks dirty for an active city;
- successful restore installs gameplay and persistence identity in one publication.

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

Retain `delayedCitySaveStore.ts` only as a small test helper for focused busy/disposal cases. Remove unused mutation-order or multi-operation machinery if rewritten tests no longer need it.

## 21. Documentation cleanup

HPA-548's store contract remains authoritative for `CitySaveRecord`, `CitySummary`, six operations, atomicity, and error codes. Its old runtime-bridge section describes the temporary coordinator-era consumer and is superseded by this HPA-543 design.

The implementation must stamp that HPA-548 runtime section as superseded rather than letting HPA-343/HPA-345/HPA-346 copy the obsolete controller.

Delete the obsolete HPA-499 coordinator plan/design documents because their architecture is intentionally removed. Keep historical Git history as the archive.

## 22. File impact

### Create

- `src/runtime/workingSaveRuntime.ts`
- `tests/runtime/workingSaveRuntime.test.ts`

### Modify

- `src/runtime/createGameRuntime.ts`
- `src/runtime/types.ts`
- `src/persistence/citySaveStore.ts` — remove stale rollback-dependent contract comments only;
- `src/App.svelte` — remove lease-oriented teardown comments only if still present;
- direct runtime/UI test fixtures using persistence types;
- `tests/runtime/delayedCitySaveStore.ts` if its helper surface can shrink;
- `docs/architecture.md` / `CLAUDE.md` where they describe the removed coordinator;
- `docs/superpowers/specs/2026-08-05-six-operation-city-save-store-design.md` — mark runtime bridge superseded by HPA-543.

### Delete

- `src/runtime/persistenceCoordinator.ts`;
- `tests/runtime/persistenceCoordinator.test.ts`;
- `docs/superpowers/plans/2026-08-01-runtime-persistence-coordinator.md`;
- `docs/superpowers/specs/2026-07-31-save-envelope-store-runtime-persistence-design.md`.

Do not delete store contract tests or host-backend tests that still protect the two current implementations.

## 23. Acceptance criteria

- `RuntimePersistenceController` exposes `listCities`, Save, Load, New City, Rename, and Delete; UI never needs direct `CitySaveStore` access.
- `RuntimePersistenceView` contains only active city, busy, dirty, and one mutating-persistence error.
- Mutating persistence uses one busy gate, not a coordinator/queue framework.
- `listCities` is read-only and does not add loading/busy lifecycle state.
- New gameplay mutations and new backend previews are not admitted while persistence is busy.
- Successful engine swap invalidates old preview epochs before publishing the new city.
- Dirty is a literal boolean and no revision baseline remains.
- New City persists a pure candidate before activation and needs no rollback.
- Definite failed Save/Load preserves prior committed/public state as applicable.
- Thrown host failures resolve through the small error union and do not trigger rollback/reconciliation.
- Rename/Delete operate on any city ID.
- No module-global ownership or storage registry remains.
- No revision/session/supersession/pending/finalize/generation machinery remains.
- Persistence orchestration is isolated in one small current-feature module.
- HPA-548 runtime-bridge prose is clearly marked superseded while its store contract remains authoritative.
- Unrelated runtime code is not broadly refactored.
- Production/test code shows material net deletion without removing multi-city behavior.

## 24. Non-goals

- Checkpoints, autosave, background persistence, recovery, import/export, cloud sync, migrations, or multi-instance correctness.
- Broad UI/runtime redesign.
- Formal architecture frameworks.
- Per-operation busy state solely to keep previews alive during some persistence mutations.
- Pre-release certification of ambiguous native transport completion.

## 25. Review guardrails

Reject an implementation that:

- replaces `SharedPersistenceCoordinator` with a differently named manager/lock/service framework;
- lets Svelte call a save-store adapter directly for city listing;
- adds a second persistence queue or operation-kind state machine;
- preserves session/revision/supersession/fence machinery under new names;
- lets previews enter the backend while a persistence mutation is active;
- leaks ordinary backend/store throws past the `WorkingSaveResult` boundary;
- reintroduces rollback/reconciliation for hypothetical host ambiguity;
- adds compatibility, migration, recovery, security, or multi-window work;
- ports architecture-only race matrices into the new module;
- broadens this ticket into IndexedDB/Tauri/UI implementation.
