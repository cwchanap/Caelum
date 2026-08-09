# HPA-543 Working Save Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the generalized persistence coordinator and replace it with one small working-save runtime that uses active city + one synchronous mutating busy gate + one dirty boolean for the six current city-save operations.

**Architecture:** Keep the existing serialized gameplay queue because it has a current mutation-ordering purpose. Mutating persistence uses no queue of its own: set `busy` synchronously, drain already-admitted gameplay, block new gameplay/backend-preview admission, and run one store/backend workflow. `listCities` is a read-only runtime-to-store pass-through outside the gate. A thrown ambiguous restore detaches active city identity so a later Save cannot overwrite the wrong city; it does not trigger rollback/reconciliation. Disposal is synchronous and suppresses late publication rather than waiting for uncancellable work.

**Tech Stack:** TypeScript 5.8, Svelte 5, Vitest 3, Bun, Rust-backed `GameBackend`, Playwright, Cargo.

## Global Constraints

- Breaking change only: no old persistence controller aliases, compatibility adapter, migration, or dual API.
- `RuntimePersistenceView` contains only `activeCity`, `busy`, `dirty`, and `error`.
- Reuse `CitySummary` as the active-city shape; do not keep `ActiveCityIdentity`, `NewCityIdentity`, or separate `lastSavedAt`.
- Persistence controller exposes exactly `listCities`, `save`, `load`, `createCity`, `renameCity`, and `deleteCity` because HPA-345/HPA-346 already require those operations.
- Keep `NewCityRequest.sandbox` required. Do not add Save As/adopt-current bootstrap semantics.
- `listCities` stays behind the runtime boundary but is not serialized behind mutating persistence and has no post-read liveness check.
- Keep the existing gameplay `createSerializedQueue`; do not create a persistence queue, mutex service, scheduler, manager class, command bus, registry, or state machine.
- While mutating persistence is busy, do not admit new gameplay mutations or new route/road backend previews.
- Manual Save/Rename/Delete intentionally freeze simulation mutation admission for the duration of the operation.
- New City persists the pure sandbox candidate before activation.
- Returned `{ ok: false }` restore failures preserve current public gameplay/identity.
- A thrown `restoreSnapshot` resolves `hostFailure`, sets active city to `null`, and clears dirty so no stale city ID can be saved against a possibly swapped engine.
- Do not capture/restore canonical rollback snapshots for thrown host failures.
- Disposal is synchronous. Do not wait for an in-flight persistence or gameplay operation.
- Delete leases, persistence FIFOs, city fences, revision/session/load tokens, superseded outcomes, lifecycle reservation flags, and rollback-coherence machinery.
- Delete tests whose only purpose is proving removed architecture. Do not preserve test counts.
- IndexedDB/Tauri adapters and city UI remain downstream work.
- Every implementation task below ends in a green compile/test state.

---

## File Map

### Create

- `src/runtime/workingSaveRuntime.ts`
- `tests/runtime/workingSaveRuntime.test.ts`

### Modify

- `src/runtime/createGameRuntime.ts`
- `src/runtime/types.ts`
- `src/persistence/citySaveStore.ts`
- `src/App.svelte`
- `tests/runtime/citySaveRuntime.test.ts`
- `tests/runtime/gameRuntime.test.ts`
- `tests/runtime/postDisposalBackendFailure.test.ts`
- `tests/runtime/persistence/citySaveStoreContract.ts`
- `tests/ui/appShell.test.ts`
- `tests/runtime/delayedCitySaveStore.ts` only to trim helper surface if the focused busy/disposal tests need less
- `docs/architecture.md` and/or `CLAUDE.md` only where they describe removed coordinator/rollback/disposal behavior
- `docs/superpowers/specs/2026-08-05-six-operation-city-save-store-design.md` only to retain/verify the HPA-543 supersession note on its historical runtime bridge

### Delete

- `src/runtime/persistenceCoordinator.ts`
- `tests/runtime/persistenceCoordinator.test.ts`
- `docs/superpowers/plans/2026-08-01-runtime-persistence-coordinator.md`
- `docs/superpowers/specs/2026-07-31-save-envelope-store-runtime-persistence-design.md`

### Initial search

Run before editing:

```bash
rg -n \
  "persistenceCoordinator|SharedPersistenceCoordinator|PersistenceLease|ActiveCityIdentity|NewCityIdentity|saveWorking|renameActiveCity|detachActiveCity|activateNewCity|PersistenceOperationResult|currentRevision|persistedRevision|sessionToken|loadRequestToken|backendAdmissionReserved|previewAdmissionSuspended|lifecycleTransitionReserved|detachReserving|saveStatus|loadStatus|lifecycleStatus|lastSavedAt|commitLoadedSnapshot|debugEnqueueCityPersistence|rollbackNewCity" \
  src tests docs CLAUDE.md
```

Change only direct HPA-543 consumers. Do not refactor unrelated route-editing `revision` or `superseded` concepts.

---

## Task 1: Add the Standalone Working-Save Runtime

Build the complete new persistence module beside the current coordinator. This task proves the new contract without touching `createGameRuntime` yet.

**Files:**
- Create: `src/runtime/workingSaveRuntime.ts`
- Create: `tests/runtime/workingSaveRuntime.test.ts`
- Reuse: `src/persistence/citySaveStore.ts`
- Reuse/trim: `tests/runtime/delayedCitySaveStore.ts`

**Interfaces:**
- Consumes: `GameBackend`, `RustGameSnapshot`, `SandboxCreationRequest`, `SnapshotError`, `SandboxHostError`, `SandboxCreationError`, `CitySaveStore`, `CitySaveStoreError`, `CitySaveStoreOperation`, `CitySaveStoreResult`, `CitySummary`
- Produces: `RuntimePersistenceView`, `WorkingSaveError`, `WorkingSaveResult<T>`, `RuntimePersistenceController`, `WorkingSaveRuntime`, `createWorkingSaveRuntime(...)`

- [ ] **Step 1: Add the target public types**

Create `src/runtime/workingSaveRuntime.ts` with these exact public shapes:

```ts
export interface RuntimePersistenceView {
  activeCity: CitySummary | null;
  busy: boolean;
  dirty: boolean;
  error: WorkingSaveError | null;
}

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
  controller: RuntimePersistenceController;
  getView(): RuntimePersistenceView;
  isBusy(): boolean;
  markDirty(): void;
  dispose(): void;
}
```

Do not add an optional `sandbox`, an operation-kind enum, or a generic `Result<T, E>` abstraction.

- [ ] **Step 2: Add minimal state tests**

Build a direct host fixture with the memory city store and backend stub.

```ts
expect(runtime.getView()).toEqual({
  activeCity: ACTIVE_CITY,
  busy: false,
  dirty: false,
  error: null,
});

runtime.markDirty();
expect(runtime.getView().dirty).toBe(true);
```

Also prove `markDirty()` is a no-op when `initialCity` is `null`.

Run:

```bash
bunx vitest run --project runtime tests/runtime/workingSaveRuntime.test.ts
```

Expected: FAIL until the module/state implementation exists.

- [ ] **Step 3: Implement closure-local state and synchronous disposal**

Use only:

```ts
let activeCity = host.initialCity;
let busy = false;
let dirty = false;
let error: WorkingSaveError | null = null;
let disposed = false;

const isLive = (): boolean => !disposed && !host.isRuntimeDead();

const publishIfLive = (): void => {
  if (isLive()) host.publish();
};

const dispose = (): void => {
  disposed = true;
};
```

Do **not** add `inFlightMutation`, outstanding counters, or a promise-returning `dispose()`.

`getView()` returns the four fields. `isBusy()` returns `busy`. `markDirty()` sets `dirty = true` only when `activeCity !== null`.

- [ ] **Step 4: Add narrow store/backend throw mappers**

Use one store helper so a throwing adapter remains a store failure:

```ts
const callStore = async <T>(
  operation: CitySaveStoreOperation,
  cityId: string | undefined,
  call: () => Promise<CitySaveStoreResult<T>>,
): Promise<WorkingSaveResult<T>> => {
  try {
    const result = await call();
    return result.ok
      ? { ok: true, value: result.value }
      : { ok: false, error: { kind: "store", error: result.error } };
  } catch (thrown: unknown) {
    return {
      ok: false,
      error: {
        kind: "store",
        error: {
          operation,
          code: "failed",
          ...(cityId === undefined ? {} : { cityId }),
          diagnostic: thrown instanceof Error ? thrown.message : String(thrown),
        },
      },
    };
  }
};
```

Use a backend-host mapper:

```ts
const backendHostFailure = (thrown: unknown): WorkingSaveError => ({
  kind: "backend",
  error: {
    code: "hostFailure",
    diagnostic: thrown instanceof Error ? thrown.message : String(thrown),
  },
});
```

Do not add another error taxonomy.

- [ ] **Step 5: Implement the mutating exclusive runner**

The runner owns `busy`, gameplay drain, final publication, and a closed result surface:

```ts
const runExclusive = async <T>(
  work: () => Promise<WorkingSaveResult<T>>,
): Promise<WorkingSaveResult<T>> => {
  if (!isLive()) return { ok: false, error: { kind: "unavailable" } };
  if (busy) return { ok: false, error: { kind: "busy" } };

  busy = true;
  error = null;
  publishIfLive();

  try {
    await host.awaitGameplayIdle();
    if (!isLive()) return { ok: false, error: { kind: "unavailable" } };

    const result = await work();
    if (isLive()) {
      error = result.ok ? null : result.error;
    }
    return result;
  } catch (thrown: unknown) {
    const result: WorkingSaveResult<T> = isLive()
      ? { ok: false, error: backendHostFailure(thrown) }
      : { ok: false, error: { kind: "unavailable" } };
    if (isLive() && !result.ok) error = result.error;
    return result;
  } finally {
    busy = false;
    publishIfLive();
  }
};
```

Add a regression where `awaitGameplayIdle` throws and assert the controller promise resolves `hostFailure` and `busy` returns to false.

No controller method may leak an ordinary expected rejection.

- [ ] **Step 6: Add `listCities` outside the busy gate**

Tests:

- empty list;
- populated list;
- store `failed` result;
- throwing store maps to store `failed`;
- no store returns `unavailable`;
- a deferred Save may be busy while `listCities()` still resolves;
- disposal after the read starts does not rewrite a successful read result to `unavailable`.

Implementation:

```ts
const listCities = async (): Promise<WorkingSaveResult<CitySummary[]>> => {
  if (!isLive() || host.saveStore === undefined) {
    return { ok: false, error: { kind: "unavailable" } };
  }

  return callStore(
    "listCities",
    undefined,
    () => host.saveStore!.listCities(),
  );
};
```

Do not set `busy` or shared `error` from this read path. Do not add a post-read liveness check.

- [ ] **Step 7: Add and implement Save**

Success:

```ts
runtime.markDirty();
const result = await runtime.controller.save();
expect(result).toMatchObject({ ok: true, value: { id: ACTIVE_CITY.id } });
expect(runtime.getView().dirty).toBe(false);
expect(runtime.getView().activeCity?.savedAt).toBe(NEXT_SAVED_AT);
```

Failure:

```ts
runtime.markDirty();
failures.failNext("updateCity", "failed");
await expect(runtime.controller.save()).resolves.toMatchObject({
  ok: false,
  error: { kind: "store", error: { operation: "updateCity" } },
});
expect(runtime.getView().dirty).toBe(true);
```

Inside `runExclusive`:

1. require active city then configured store — `noActiveCity` takes precedence when both are absent;
2. call `backend.snapshotForSave()`; thrown backend -> `hostFailure`;
3. generate `savedAt = host.now()`;
4. call `updateCity(activeCity.id, { savedAt, snapshot })`;
5. after the await, stop state publication/commit if `!isLive()`;
6. on success assign returned summary and clear dirty;
7. on failure keep active city/dirty unchanged.

Save never creates on `notFound` and never re-reads after a definite failure.

- [ ] **Step 8: Add and implement Load, including ambiguous-restore detachment**

Success records the snapshot passed to `installRestoredGameplay` and verifies the stored city summary becomes active and clean.

Failure tests:

- `readCity` failure;
- returned `{ ok: false }` restore preserves active identity;
- thrown `restoreSnapshot` resolves `hostFailure`, sets `activeCity` to `null`, clears dirty, and does not reject;
- thrown `installRestoredGameplay` resolves `hostFailure`, sets `activeCity` to `null`, clears dirty, and does not reject;
- after thrown restore or install, `save()` returns `noActiveCity` and `updateCity` is not called.

Implementation:

```ts
const stored = await callStore(
  "readCity",
  cityId,
  () => saveStore.readCity(cityId),
);
if (!stored.ok) return stored;

const installed = await restoreAndInstall(stored.value.snapshot);
if (!installed.ok) return installed;

activeCity = { ...stored.value.city, savedAt: stored.value.savedAt };
dirty = false;
return { ok: true, value: activeCity };
```

`restoreAndInstall` wraps `restoreSnapshot` and `installRestoredGameplay` in one
shared try/catch: a thrown failure from either step detaches `activeCity` and
clears dirty before returning `backendHostFailure`. A returned `{ ok: false }`
restore preserves identity (definite non-mutation). An `!isLive()` check after a
successful restore returns `unavailable` before installing.

Do not capture/restore a rollback snapshot.

- [ ] **Step 9: Add and implement New City**

Keep `sandbox` required and use deterministic generators:

```ts
createCityId: () => "city-new",
now: () => "2026-08-08T12:00:00.000Z",
```

Success order:

```text
buildSandboxSnapshot -> createCity -> restoreSnapshot -> installRestoredGameplay
```

The record uses the same timestamp for `createdAt` and initial `savedAt`.

Cover:

- success;
- sandbox candidate failure;
- create conflict;
- definite create failure;
- returned activation failure after create preserves prior active identity and keeps created record;
- thrown activation or install failure keeps the created record, resolves `hostFailure`, and sets `activeCity = null` / `dirty = false`.

For a returned activation failure:

```ts
expect(await store.readCity("city-new")).toMatchObject({ ok: true });
expect(runtime.getView().activeCity).toEqual(ACTIVE_CITY);
expect(installedSnapshot).toBeNull();
```

For a thrown activation failure:

```ts
expect(await store.readCity("city-new")).toMatchObject({ ok: true });
expect(runtime.getView().activeCity).toBeNull();
await expect(runtime.controller.save()).resolves.toEqual({
  ok: false,
  error: { kind: "noActiveCity" },
});
```

Do not auto-delete the created record. Do not add an “adopt current anonymous sandbox” branch.

- [ ] **Step 10: Add generic Rename/Delete for the known city-library workflow**

Rename:

- active city: returned summary replaces `activeCity`, dirty unchanged;
- inactive city: store changes, active summary/dirty unchanged.

Delete:

- inactive city: active summary/dirty unchanged;
- active city: only after successful store deletion set `activeCity = null` and `dirty = false`;
- failed active delete keeps identity/dirty unchanged.

No gameplay snapshot is cleared by Delete.

- [ ] **Step 11: Prove one busy gate and synchronous disposal suppression**

Busy:

```ts
const saving = runtime.controller.save();
await delayed.waitForActive("updateCity");
expect(runtime.getView().busy).toBe(true);

await expect(
  runtime.controller.renameCity(ACTIVE_CITY.id, "Other"),
).resolves.toEqual({
  ok: false,
  error: { kind: "busy" },
});

delayed.releaseNext("updateCity");
await saving;
```

Disposal:

```ts
const saving = runtime.controller.save();
await delayed.waitForActive("updateCity");
const publicationsBeforeDispose = publications;

runtime.dispose();
expect(publications).toBe(publicationsBeforeDispose);

delayed.releaseNext("updateCity");
await saving;
expect(publications).toBe(publicationsBeforeDispose);
```

Do not await disposal and do not add in-flight tracking solely for teardown.

- [ ] **Step 12: Run Task 1 gate**

```bash
bunx vitest run --project runtime tests/runtime/workingSaveRuntime.test.ts
bun run check
bun run format:check
```

Expected: all pass.

- [ ] **Step 13: Commit**

```bash
git add \
  src/runtime/workingSaveRuntime.ts \
  tests/runtime/workingSaveRuntime.test.ts \
  tests/runtime/delayedCitySaveStore.ts
git commit -m "refactor: add minimal working save runtime"
```

---

## Task 2: Atomically Cut `createGameRuntime` to Busy + Dirty

Replace current inline coordinator workflows with the new module. This is the highest-risk implementation step, so it gets the full unit and lint gate before its commit.

**Files:**
- Modify: `src/runtime/createGameRuntime.ts`
- Modify: `src/runtime/types.ts`
- Modify: `src/App.svelte`
- Modify: `tests/runtime/citySaveRuntime.test.ts`
- Modify: `tests/runtime/gameRuntime.test.ts`
- Modify: `tests/runtime/postDisposalBackendFailure.test.ts`
- Modify: `tests/ui/appShell.test.ts`
- Modify: any direct fixture found by the initial search

**Interfaces:**
- Consumes: `createWorkingSaveRuntime`, `RuntimePersistenceController`, `RuntimePersistenceView`
- Produces: runtime controller with `persistence.listCities/save/load/createCity/renameCity/deleteCity`
- Removes: `saveWorking`, `renameActiveCity`, `activateNewCity`, `detachActiveCity`, `debugEnqueueCityPersistence`, promise-based disposal ownership semantics

- [ ] **Step 1: Update runtime construction options**

Use:

```ts
export interface CreateGameRuntimeOptions {
  backend: GameBackend;
  saveStore?: CitySaveStore;
  initialCity?: CitySummary | null;
  now?: () => string;
  createCityId?: () => string;
  hoverPreviewDebounceMs?: number;
}
```

Delete `lastSavedAt`.

Resolve simple defaults:

```ts
const now = options.now ?? (() => new Date().toISOString());
const createCityId =
  options.createCityId ?? (() => globalThis.crypto.randomUUID());
```

Tests inject both when deterministic values matter.

- [ ] **Step 2: Remove coordinator acquisition and lease cleanup**

Delete:

- `lease`;
- coordinator acquisition;
- `drainAndReleasePromise` / `startDrainAndRelease`;
- city fence wrappers;
- `cityQueues`;
- foreground admission/closing/release comments.

Runtime initialization remains direct:

```ts
let state = normalizeRustSnapshot(await backend.snapshot());
let ui = createUiState();
let backendError: string | null = null;
let rejection: GameplayRejection | null = null;
let sandboxResetError: SandboxResetError | null = null;
let dead = false;
const gameplayQueue = createSerializedQueue(() => dead);
```

- [ ] **Step 3: Refactor `commitLoadedSnapshot` into no-publish gameplay installation**

Create:

```ts
const installRestoredGameplay = (rawSnapshot: RustGameSnapshot): void => {
  clearHoverPreviewTimer();
  previewRuntimeEpoch += 1;
  previewCoordinator.invalidateRoute();
  invalidateRoadPreview();
  activeRouteSaveTokens.clear();
  nextRouteDraftInstanceId = 1;
  state = normalizeRustSnapshot(rawSnapshot);
  ui = createUiState();
  backendError = null;
  rejection = null;
  sandboxResetError = null;
};
```

Delete identity/session/revision/status publication from the old helper. Keep the epoch bump even though current ordinary Load does not have it; HPA-543 makes successful Load/New City share the safe installation boundary.

- [ ] **Step 4: Instantiate the working-save module**

After `publish`, gameplay queue, and install callback exist:

```ts
const workingSave = createWorkingSaveRuntime({
  backend,
  saveStore,
  initialCity: options.initialCity ?? null,
  now,
  createCityId,
  awaitGameplayIdle: () => gameplayQueue.drain(),
  installRestoredGameplay,
  publish: () => {
    publish();
  },
  isRuntimeDead: () => dead,
});
```

`getSnapshot()` reads:

```ts
persistence: workingSave.getView(),
```

Expose:

```ts
persistence: workingSave.controller,
```

- [ ] **Step 5: Replace revision-based dirty tracking**

In `commitDispatchResult`:

```ts
if (result.applied) {
  workingSave.markDirty();
}
```

Apply the same rule to successful reset if reset bypasses `commitDispatchResult`.

Delete `currentRevision`, `persistedRevision`, and their updates/assertions.

- [ ] **Step 6: Replace gameplay mutation reservation flags with `workingSave.isBusy()`**

At `queueBackend` admission:

```ts
if (workingSave.isBusy()) return Promise.resolve(getSnapshot());
```

This intentionally freezes ticks/dispatch/reset during Save, Rename, Delete, Load, and New City.

Delete `backendAdmissionReserved`, `lifecycleTransitionReserved`, `detachReserving`, `detachAdmissionLoadToken`, and their branches. Do not replace them with an operation-kind enum.

- [ ] **Step 7: Block preview admission with the same busy boolean**

Use `workingSave.isBusy()` at current backend preview-admission points:

- `requestRoutePreview`;
- `sendRoadMutationPreviewRequest`;
- `requestRoadMutationPreview`;
- `commitWithRoadPreview` and route-draft paths that would otherwise mark preview pending before a blocked request.

While busy, a preview-producing public action returns the current snapshot before creating pending preview UI, or explicitly clears pending state. Do not leave route/road preview stuck pending.

Delete `previewAdmissionSuspended` and `allowWhileSuspended` plumbing.

Keep `previewRuntimeEpoch` plus invalidation on successful Load/New City installation.

- [ ] **Step 8: Add runtime integration coverage for preview safety and RAF resumption**

### Preview safety

Use a backend stub with delayed `restoreSnapshot`:

1. start Load/New City and wait until persistence is busy;
2. attempt route/road preview-producing interaction;
3. verify no new backend preview call is admitted and UI is not stranded in `previewPending`;
4. release restore;
5. verify an older preview response cannot publish after the epoch bump.

### Animation resumption after manual Save

Use a controllable `requestAnimationFrame` stub:

```ts
let scheduledFrame: FrameRequestCallback | null = null;
vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
  scheduledFrame = callback;
  return 1;
}));
```

Test sequence:

1. create an active, unpaused runtime with delayed `updateCity`;
2. call `runtime.start()` and capture the scheduled frame;
3. start Save and wait until `busy === true`;
4. invoke the captured frame so its tick is dropped by busy admission and the canvas host clears its current RAF ID;
5. assert no replacement RAF is scheduled yet;
6. release `updateCity` and await Save;
7. assert the final live publication re-enters `canvasHost.syncAnimationLoop()` and schedules another RAF callback;
8. optionally invoke the new frame and verify a backend tick is admitted.

This pins the otherwise implicit dependency on the final publish re-arming animation.

- [ ] **Step 9: Update runtime persistence tests to the six operations**

Rewrite `tests/runtime/citySaveRuntime.test.ts` around current behavior:

- `listCities` empty/populated via runtime;
- Save success/failure + dirty;
- Load success/definite failure;
- thrown Load restore -> `hostFailure`, `activeCity === null`, later Save does not update old ID;
- New City success/conflict/definite activation failure;
- thrown New City activation -> created record retained + active identity cleared;
- Rename active/inactive;
- Delete active/inactive;
- duplicate mutating action -> `busy`;
- disposal -> no late publication.

Delete same-city/cross-city FIFO, fence, token, supersession, rollback-coherence, and detach-precedence tests.

- [ ] **Step 10: Update `RuntimeController` and UI test harnesses**

In `src/runtime/types.ts`, import persistence types from `workingSaveRuntime.ts` and delete `RuntimeTestSeam.debugEnqueueCityPersistence`.

Change disposal type to synchronous:

```ts
export interface RuntimeController {
  // ...
  dispose: () => void;
  // ...
}
```

Update `tests/ui/appShell.test.ts`:

```ts
const persistenceView: RuntimePersistenceView = {
  activeCity: null,
  busy: false,
  dirty: false,
  error: null,
};
```

The persistence-controller harness implements all six methods. It does not import the deleted coordinator.

- [ ] **Step 11: Make runtime disposal synchronous**

Use the smallest terminal sequence:

```ts
const dispose = (): void => {
  disposalRequested = true;
  if (dead) return;
  dead = true;
  workingSave.dispose();
  stopRuntime();
};
```

Keep any existing one-shot terminal-publication latch needed for a **live** backend failure, but remove:

- gameplay queue drain on disposal;
- working-save await;
- persistence lease release;
- ownership handoff;
- session/load/status resets whose only role was stale completion classification.

Already-running operations may settle internally. Because `dead`/`disposed` are set synchronously, they must not render, publish, or commit persistence identity afterward.

Update the `App.svelte` teardown comment to describe terminal synchronous disposal, not lease draining.

- [ ] **Step 12: Rewrite post-disposal backend-failure tests around supported semantics**

In `tests/runtime/postDisposalBackendFailure.test.ts`:

Keep:

- a delayed backend operation rejecting after `runtime.dispose()` does not notify subscribers or render;
- the comparable failure on a live runtime still publishes the terminal error exactly once.

Change:

- call `runtime.dispose()` synchronously;
- do not assert disposal stays pending;
- release/reject the delayed operation afterward and assert no late UI publication.

Delete:

- “replacement runtime sees coherent backend state after post-disposal backend failure” — multi-runtime/backend handoff is outside HPA-543 scope.

- [ ] **Step 13: Run Task 2 focused + broad gate**

Run focused files first:

```bash
bunx vitest run --project runtime \
  tests/runtime/workingSaveRuntime.test.ts \
  tests/runtime/citySaveRuntime.test.ts \
  tests/runtime/gameRuntime.test.ts \
  tests/runtime/postDisposalBackendFailure.test.ts
bunx vitest run --project ui tests/ui/appShell.test.ts
```

Then run the full unit/lint gate **before this commit**:

```bash
bun run test:unit
bun run check
bun run lint
bun run format:check
```

Expected: all pass.

- [ ] **Step 14: Run reservation/preview/disposal absence scan before commit**

```bash
rg -n \
  "backendAdmissionReserved|previewAdmissionSuspended|lifecycleTransitionReserved|detachReserving|detachAdmissionLoadToken|commitLoadedSnapshot|PersistenceOperationResult|debugEnqueueCityPersistence|drainAndReleasePromise|startDrainAndRelease" \
  src tests
```

Expected: zero HPA-543-owned matches. If `commitLoadedSnapshot` remains, the target cutover helper has not landed.

- [ ] **Step 15: Commit**

```bash
git add src/runtime src/App.svelte tests/runtime tests/ui
git commit -m "refactor: cut runtime persistence to busy and dirty"
```

---

## Task 3: Delete Coordinator Machinery and Stale Documentation

Delete architecture that no longer has current behavior to protect and clean prose that would fail the final absence scan.

**Files:**
- Delete: `src/runtime/persistenceCoordinator.ts`
- Delete: `tests/runtime/persistenceCoordinator.test.ts`
- Delete: `docs/superpowers/plans/2026-08-01-runtime-persistence-coordinator.md`
- Delete: `docs/superpowers/specs/2026-07-31-save-envelope-store-runtime-persistence-design.md`
- Modify: `src/persistence/citySaveStore.ts`
- Modify: `tests/runtime/persistence/citySaveStoreContract.ts`
- Modify: `src/App.svelte` if any stale teardown prose remains
- Modify: `docs/superpowers/specs/2026-08-05-six-operation-city-save-store-design.md`
- Modify: `docs/architecture.md` / `CLAUDE.md` only where stale

- [ ] **Step 1: Delete coordinator source and architecture-only tests/docs**

```bash
rm src/runtime/persistenceCoordinator.ts
rm tests/runtime/persistenceCoordinator.test.ts
rm docs/superpowers/plans/2026-08-01-runtime-persistence-coordinator.md
rm docs/superpowers/specs/2026-07-31-save-envelope-store-runtime-persistence-design.md
```

Do not translate lease/fence/FIFO/handoff tests to `workingSaveRuntime`.

- [ ] **Step 2: Remove stale rollback/runtime-name comments from store contract and tests**

In `src/persistence/citySaveStore.ts`, retain only the storage atomicity contract:

- failed create commits nothing;
- failed update/rename preserves prior record;
- no reference to `rollbackNewCity`, `saveWorking`, leases, or runtime algorithms.

In `tests/runtime/persistence/citySaveStoreContract.ts`, keep the assertions but rewrite comments such as:

```text
rollbackNewCity
saveWorking
renameActiveCity
```

into storage-only statements. Do not alter the store behavior tests merely to satisfy the absence scan.

- [ ] **Step 3: Keep HPA-548 runtime bridge explicitly superseded**

Verify `docs/superpowers/specs/2026-08-05-six-operation-city-save-store-design.md` contains directly under `## 6. Runtime bridge`:

```md
> **Superseded by HPA-543 (2026-08-08).** Sections 3–5 remain the authoritative
> `CitySaveStore` contract. The controller/coordinator workflow below describes
> the temporary HPA-548 cutover state and must not be used for new runtime work.
> See `2026-08-08-working-save-runtime-design.md` for the current runtime contract.
```

Do not rewrite HPA-548’s store model or historical implementation sequence.

- [ ] **Step 4: Update architecture guidance only where now false**

Remove statements that describe as current:

- rollback on thrown restore;
- persistence lease draining/release;
- coordinator ownership;
- revision/session/fence machinery.

Keep:

- Rust gameplay authority;
- thin native/WASM hosts;
- six-operation save boundary;
- one busy gate preference;
- single-runtime/no-multi-window active-development scope.

Document the narrow thrown-restore rule: no rollback, active identity is cleared to prevent wrong-city Save.

- [ ] **Step 5: Run full HPA-543 absence scan**

```bash
rg -n \
  "persistenceCoordinator|SharedPersistenceCoordinator|PersistenceLease|createCityPersistenceQueues|resolveWorkingSaveCompletion|resolvePersistenceSessionCompletion|ActiveCityIdentity|NewCityIdentity|saveWorking|renameActiveCity|detachActiveCity|activateNewCity|PersistenceOperationResult|currentRevision|persistedRevision|sessionToken|loadRequestToken|backendAdmissionReserved|previewAdmissionSuspended|lifecycleTransitionReserved|detachReserving|saveStatus|loadStatus|lifecycleStatus|lastSavedAt|commitLoadedSnapshot|debugEnqueueCityPersistence|rollbackNewCity" \
  src tests docs CLAUDE.md
```

Expected:

- zero production/test matches for deleted architecture;
- historical HPA-548 runtime prose is allowed only inside its explicitly superseded section;
- unrelated historical Git references do not justify keeping production symbols.

- [ ] **Step 6: Run Task 3 gate**

```bash
bun run test:unit
bun run check
bun run lint
bun run format:check
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add -A src tests docs CLAUDE.md
git commit -m "refactor: delete persistence coordinator machinery"
```

---

## Task 4: Full Verification and Net-Deletion Review

No new behavior belongs in this task. It re-runs the complete repository gates and verifies the deletion target.

**Files:**
- Modify only if verification finds a real defect in Tasks 1–3

- [ ] **Step 1: Run frontend unit tests**

```bash
bun run test:unit
```

Expected: PASS.

- [ ] **Step 2: Run type/lint/format/build**

```bash
bun run check
bun run lint
bun run format:check
bun run build
```

Expected: all pass.

- [ ] **Step 3: Run Playwright**

```bash
bun run test:e2e
```

Expected: PASS.

- [ ] **Step 4: Run Rust workspace verification**

```bash
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all --check
```

Expected: all pass.

- [ ] **Step 5: Repeat final architecture absence scan**

```bash
rg -n \
  "SharedPersistenceCoordinator|PersistenceLease|createCityPersistenceQueues|resolveWorkingSaveCompletion|resolvePersistenceSessionCompletion|backendAdmissionReserved|previewAdmissionSuspended|lifecycleTransitionReserved|detachReserving|PersistenceOperationResult|debugEnqueueCityPersistence|drainAndReleasePromise|startDrainAndRelease" \
  src tests
```

Expected: zero matches.

Confirm the new controller surface:

```bash
rg -n "listCities\(|save\(|load\(|createCity\(|renameCity\(|deleteCity\(" \
  src/runtime/workingSaveRuntime.ts
```

Confirm no Save-As bootstrap branch slipped in:

```bash
rg -n "sandbox\?:|adopt.*sandbox|save as" \
  src/runtime tests/runtime
```

Expected: no HPA-543 implementation matches.

- [ ] **Step 6: Review diff for YAGNI/KISS**

```bash
git diff --stat main...HEAD
git diff --numstat main...HEAD -- src tests
```

Required outcome:

- production + test code is materially net-negative;
- no new manager/service/scheduler/mutex/registry/state-machine abstraction appeared;
- only one mutating persistence busy boolean exists;
- no in-flight/disposal ownership tracker replaced the lease;
- `listCities` did not add read lifecycle state;
- no operation-kind state was added solely for previews;
- ambiguous restore safety is only “clear active identity,” not rollback/reconciliation;
- tests target player-visible behavior rather than rebuilding the removed race matrix.

If production/test diff is net-positive because of orchestration/test scaffolding, simplify before finishing.

- [ ] **Step 7: Review public behavior against HPA-543**

Confirm from code/tests:

- city listing stays behind the runtime boundary;
- anonymous bootstrap state is not saveable/adopted by HPA-543;
- Save failure leaves dirty and prior record;
- definite Load failure leaves public gameplay/identity;
- thrown Load/New City restore clears active identity and prevents later wrong-city Save;
- New City persists before activation;
- definite activation failure leaves created record available;
- active Delete clears identity only after store success;
- mutating persistence blocks gameplay + backend preview admission;
- animation scheduling resumes after manual persistence completes;
- old preview responses cannot publish after successful engine swap;
- disposal returns synchronously and suppresses late publication;
- thrown host/store failures resolve through `WorkingSaveResult`.

- [ ] **Step 8: Commit verification-only fixes if needed**

If verification required a real correction:

```bash
git add <corrected-files>
git commit -m "fix: finish working save runtime cutover"
```

Do not create an empty verification commit.

---

## Execution Notes

- Use one implementation PR for Tasks 1–4. The public runtime API is intentionally breaking, so a compatibility branch adds no value.
- Task 1 may coexist temporarily with the old coordinator only to keep an independently green commit. Task 2 must cut all runtime consumers atomically.
- Task 2 gets `bun run test:unit` and `bun run lint` because it is where preview admission, dirty tracking, disposal, and fatal cleanup change.
- Task 3 deletes the old architecture instead of preserving tests for it.
- HPA-343/HPA-344 implement store adapters only after this runtime contract is stable.
- HPA-345 owns the no-city entry UI and always creates an explicit named sandbox; HPA-543 does not add Save-As-current behavior.
- HPA-346 consumes the six runtime operations for the known city-library workflow and never receives direct store access.
- HPA-544 remains the intended place for pre-release hardening only if real host-ambiguity behavior warrants more than identity detachment.