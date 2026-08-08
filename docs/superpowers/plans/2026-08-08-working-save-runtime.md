# HPA-543 Working Save Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the generalized persistence coordinator and replace it with one small working-save runtime that uses active city + busy + dirty for the six current city-save operations.

**Architecture:** Keep the existing serialized gameplay queue because it has a current mutation-ordering purpose. Mutating persistence uses no queue of its own: one synchronous `busy` gate blocks new gameplay/backend-preview admission, drains already-admitted gameplay, and runs exactly one store/backend workflow. `listCities` is a read-only runtime-to-store pass-through and does not participate in the exclusive gate. `workingSaveRuntime.ts` owns only `CitySummary | null`, `busy`, `dirty`, one mutating-persistence error, and one in-flight mutation promise for disposal.

**Tech Stack:** TypeScript 5.8, Svelte 5, Vitest 3, Bun, Rust-backed `GameBackend`, Playwright, Cargo.

## Global Constraints

- Breaking change only: no old persistence controller aliases, compatibility adapter, migration, or dual API.
- `RuntimePersistenceView` contains only `activeCity`, `busy`, `dirty`, and `error`.
- Reuse `CitySummary` as the active-city shape; do not keep `ActiveCityIdentity` or `NewCityIdentity`.
- Persistence controller exposes exactly `listCities`, `save`, `load`, `createCity`, `renameCity`, and `deleteCity`.
- `listCities` stays behind the runtime boundary but is not serialized behind mutating persistence.
- Keep the existing gameplay `createSerializedQueue`; do not create a persistence queue, mutex service, scheduler, manager class, command bus, registry, or state machine.
- While mutating persistence is busy, do not admit new gameplay mutations or new route/road backend previews.
- New City persists the pure sandbox candidate before activation.
- Returned `{ ok: false }` restore failures preserve the current public runtime; thrown host failures resolve through `WorkingSaveResult` without rollback/reconciliation.
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
- `tests/ui/appShell.test.ts`
- `tests/runtime/delayedCitySaveStore.ts` if the focused busy/disposal tests can use a smaller helper
- `docs/architecture.md` and/or `CLAUDE.md` only where they describe the removed persistence coordinator
- `docs/superpowers/specs/2026-08-05-six-operation-city-save-store-design.md` to mark its runtime bridge superseded by HPA-543

### Delete

- `src/runtime/persistenceCoordinator.ts`
- `tests/runtime/persistenceCoordinator.test.ts`
- `docs/superpowers/plans/2026-08-01-runtime-persistence-coordinator.md`
- `docs/superpowers/specs/2026-07-31-save-envelope-store-runtime-persistence-design.md`

### Initial search

Run before editing:

```bash
rg -n \
  "persistenceCoordinator|SharedPersistenceCoordinator|PersistenceLease|ActiveCityIdentity|NewCityIdentity|saveWorking|renameActiveCity|detachActiveCity|activateNewCity|PersistenceOperationResult|currentRevision|persistedRevision|sessionToken|loadRequestToken|backendAdmissionReserved|previewAdmissionSuspended|lifecycleTransitionReserved|detachReserving|saveStatus|loadStatus|lifecycleStatus|lastSavedAt|commitLoadedSnapshot|debugEnqueueCityPersistence" \
  src tests docs CLAUDE.md
```

Change only direct HPA-543 consumers. Do not refactor unrelated `revision`/`superseded` concepts used by route editing or other gameplay features.

---

## Task 1: Add the Standalone Working-Save Runtime

Build the complete new persistence module beside the current coordinator. Do not integrate it into `createGameRuntime` yet.

**Files:**
- Create: `src/runtime/workingSaveRuntime.ts`
- Create: `tests/runtime/workingSaveRuntime.test.ts`
- Reuse: `src/persistence/citySaveStore.ts`
- Reuse/trim: `tests/runtime/delayedCitySaveStore.ts`

**Interfaces:**
- Consumes: `GameBackend`, `RustGameSnapshot`, `SandboxCreationRequest`, `SnapshotError`, `SandboxHostError`, `SandboxCreationError`, `CitySaveStore`, `CitySaveStoreError`, `CitySaveStoreOperation`, `CitySummary`
- Produces: `RuntimePersistenceView`, `WorkingSaveError`, `WorkingSaveResult<T>`, `RuntimePersistenceController`, `WorkingSaveRuntime`, `createWorkingSaveRuntime(...)`

- [ ] **Step 1: Add the target public types**

Create `src/runtime/workingSaveRuntime.ts` with these public shapes:

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
  dispose(): Promise<void>;
}
```

- [ ] **Step 2: Add minimal state tests**

In `tests/runtime/workingSaveRuntime.test.ts`, build a direct host fixture with a memory store and backend stub.

First assertions:

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

- [ ] **Step 3: Implement closure-local state and liveness**

Use only:

```ts
let activeCity = host.initialCity;
let busy = false;
let dirty = false;
let error: WorkingSaveError | null = null;
let disposed = false;
let inFlightMutation: Promise<void> | null = null;

const isLive = (): boolean => !disposed && !host.isRuntimeDead();

const publishIfLive = (): void => {
  if (isLive()) host.publish();
};
```

`getView()` returns detached references as needed; `isBusy()` returns `busy`; `markDirty()` sets `dirty = true` only when `activeCity !== null`.

- [ ] **Step 4: Add narrow store/backend throw mappers**

Use one store helper so a throwing adapter stays a store failure:

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

Use a backend-host-failure mapper for thrown backend/runtime calls:

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

- [ ] **Step 5: Implement the mutating exclusive runner with an outer catch**

The runner owns `busy`, gameplay drain, final publication, and closed result behavior:

```ts
const runExclusive = <T>(
  work: () => Promise<WorkingSaveResult<T>>,
): Promise<WorkingSaveResult<T>> => {
  if (!isLive()) {
    return Promise.resolve({ ok: false, error: { kind: "unavailable" } });
  }
  if (busy) {
    return Promise.resolve({ ok: false, error: { kind: "busy" } });
  }

  busy = true;
  error = null;
  publishIfLive();

  const operation = (async (): Promise<WorkingSaveResult<T>> => {
    try {
      await host.awaitGameplayIdle();
      if (!isLive()) {
        return { ok: false, error: { kind: "unavailable" } };
      }
      return await work();
    } catch (thrown: unknown) {
      if (!isLive()) {
        return { ok: false, error: { kind: "unavailable" } };
      }
      return { ok: false, error: backendHostFailure(thrown) };
    }
  })();

  inFlightMutation = operation.then(
    () => undefined,
    () => undefined,
  );

  return operation
    .then((result) => {
      if (!result.ok && result.error.kind !== "busy") error = result.error;
      if (result.ok) error = null;
      return result;
    })
    .finally(() => {
      busy = false;
      inFlightMutation = null;
      publishIfLive();
    });
};
```

Add a regression test where a host callback throws and assert:

```ts
await expect(operation).resolves.toMatchObject({
  ok: false,
  error: { kind: "backend", error: { code: "hostFailure" } },
});
expect(runtime.getView().busy).toBe(false);
```

No public controller method may leak an ordinary expected rejection.

- [ ] **Step 6: Add `listCities` outside the busy gate**

Tests:

- empty list;
- populated list;
- store `failed` result;
- throwing store maps to store `failed`;
- no store returns `unavailable`;
- a deferred Save may be busy while `listCities()` still resolves.

Implementation:

```ts
const listCities = async (): Promise<WorkingSaveResult<CitySummary[]>> => {
  if (!isLive() || host.saveStore === undefined) {
    return { ok: false, error: { kind: "unavailable" } };
  }

  const result = await callStore(
    "listCities",
    undefined,
    () => host.saveStore!.listCities(),
  );

  return isLive()
    ? result
    : { ok: false, error: { kind: "unavailable" } };
};
```

Do not set `busy` or shared `error` from this read path.

- [ ] **Step 7: Add and implement Save behavior**

Tests:

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

Implement inside `runExclusive`:

1. require store + active city;
2. call `backend.snapshotForSave()` with thrown backend -> `hostFailure`;
3. generate `savedAt = host.now()`;
4. `callStore("updateCity", activeCity.id, ...)`;
5. on success assign returned summary and clear dirty;
6. on failure leave active city/dirty unchanged.

Save never creates on `notFound` and never re-reads after a definite failure.

- [ ] **Step 8: Add and implement Load behavior**

Success test records the snapshot passed to `installRestoredGameplay` and verifies the record summary becomes active and clean.

Failure tests:

- `readCity` failure;
- returned `{ ok: false }` restore;
- thrown `restoreSnapshot` resolves `{ ok: false, error: { kind: "backend", ... } }` and does not reject.

Implementation:

```ts
const stored = await callStore("readCity", cityId, () => saveStore.readCity(cityId));
if (!stored.ok) return stored;

let restored: Awaited<ReturnType<GameBackend["restoreSnapshot"]>>;
try {
  restored = await host.backend.restoreSnapshot(stored.value.snapshot);
} catch (thrown: unknown) {
  return { ok: false, error: backendHostFailure(thrown) };
}
if (!restored.ok) {
  return { ok: false, error: { kind: "backend", error: restored.error } };
}
if (!isLive()) return { ok: false, error: { kind: "unavailable" } };

host.installRestoredGameplay(restored.snapshot);
activeCity = { ...stored.value.city, savedAt: stored.value.savedAt };
dirty = false;
return { ok: true, value: activeCity };
```

Do not capture/restore a rollback snapshot.

- [ ] **Step 9: Add and implement New City behavior**

Use deterministic generators:

```ts
createCityId: () => "city-new",
now: () => "2026-08-08T12:00:00.000Z",
```

Success must prove ordering:

```text
buildSandboxSnapshot -> createCity -> restoreSnapshot -> installRestoredGameplay
```

The record uses the same timestamp for `createdAt` and initial `savedAt`.

Cover:

- success;
- sandbox candidate failure;
- create conflict;
- definite create failure;
- returned activation failure after create;
- thrown activation failure resolves backend host failure.

For activation failure after create:

```ts
expect(await store.readCity("city-new")).toMatchObject({ ok: true });
expect(runtime.getView().activeCity).toEqual(ACTIVE_CITY);
expect(installedSnapshot).toBeNull();
```

Do not auto-delete the created record.

- [ ] **Step 10: Add and implement generic Rename/Delete**

Rename:

- active city: returned summary replaces `activeCity`, dirty unchanged;
- inactive city: store changes, active summary/dirty unchanged.

Delete:

- inactive city: active summary/dirty unchanged;
- active city: only after successful store deletion set `activeCity = null` and `dirty = false`;
- failed active delete keeps identity/dirty unchanged.

No gameplay snapshot is cleared by Delete.

- [ ] **Step 11: Prove one busy gate and disposal suppression**

Use `createDelayedCitySaveStore` to defer `updateCity`:

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
const dispose = runtime.dispose();
const publicationsBeforeRelease = publications;

delayed.releaseNext("updateCity");
await Promise.all([saving, dispose]);

expect(publications).toBe(publicationsBeforeRelease);
```

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

Replace current inline coordinator workflows with the new module. Runtime types and direct tests change together; do not keep compatibility aliases.

**Files:**
- Modify: `src/runtime/createGameRuntime.ts`
- Modify: `src/runtime/types.ts`
- Modify: `tests/runtime/citySaveRuntime.test.ts`
- Modify: `tests/runtime/gameRuntime.test.ts`
- Modify: `tests/ui/appShell.test.ts`
- Modify: any direct fixture found by the initial search

**Interfaces:**
- Consumes: `createWorkingSaveRuntime`, `RuntimePersistenceController`, `RuntimePersistenceView`
- Produces: runtime controller with `persistence.listCities/save/load/createCity/renameCity/deleteCity`
- Removes: `saveWorking`, `renameActiveCity`, `activateNewCity`, `detachActiveCity`, `debugEnqueueCityPersistence`

- [ ] **Step 1: Update runtime construction options**

Replace the identity/save-time split:

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

Resolve defaults inside `createGameRuntime`:

```ts
const now = options.now ?? (() => new Date().toISOString());
const createCityId =
  options.createCityId ?? (() => globalThis.crypto.randomUUID());
```

Tests inject both functions when deterministic values matter.

- [ ] **Step 2: Remove coordinator acquisition and lease cleanup**

Delete runtime construction of `SharedPersistenceCoordinator`/`PersistenceLease`, including:

- `lease`;
- `drainAndReleasePromise`;
- `startDrainAndRelease`;
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

Delete identity/session/revision/status publication from the old helper. The working-save module owns active city/dirty/error and performs the single final publication.

- [ ] **Step 4: Instantiate the working-save module**

After `publish`, gameplay queue, and install callback exist, construct:

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

The runtime exposes:

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

Apply the same rule to successful reset if reset currently bypasses `commitDispatchResult`.

Delete `currentRevision`, `persistedRevision`, and their updates/assertions.

- [ ] **Step 6: Replace mutation admission flags with `workingSave.isBusy()`**

`queueBackend` must reject/no-op new gameplay mutation admission while persistence is busy:

```ts
if (workingSave.isBusy()) return Promise.resolve(getSnapshot());
```

Delete `backendAdmissionReserved`, `lifecycleTransitionReserved`, `detachReserving`, `detachAdmissionLoadToken`, and their branches.

Do not replace them with an operation-kind enum.

- [ ] **Step 7: Block preview admission with the same busy boolean**

Use `workingSave.isBusy()` at all existing backend preview-admission points:

- `requestRoutePreview`;
- `sendRoadMutationPreviewRequest`;
- `requestRoadMutationPreview`;
- `commitWithRoadPreview` / route-draft paths that would otherwise mark preview pending then call a blocked request.

Rule: while busy, a preview-producing public action either returns the current snapshot before creating pending preview UI, or clears pending state immediately. Do not leave a route/road preview stuck in a pending state with no request.

Delete `previewAdmissionSuspended` and `allowWhileSuspended` plumbing.

Keep `previewRuntimeEpoch` plus invalidation on successful Load/New City installation; they still protect already-started preview responses from publishing into the replacement city.

- [ ] **Step 8: Add runtime integration tests for preview safety**

Use a backend stub with delayed `restoreSnapshot`.

Prove:

1. start Load/New City and wait until persistence is busy;
2. attempt route/road preview-producing interaction;
3. verify no new backend preview call is admitted and UI is not stranded in `previewPending`;
4. release restore;
5. verify an older preview response cannot publish into the post-load UI after `previewRuntimeEpoch` advances.

Do not build a full concurrency matrix.

- [ ] **Step 9: Update runtime persistence tests to the six operations**

Rewrite `tests/runtime/citySaveRuntime.test.ts` around current player behavior:

- `listCities` empty/populated via runtime;
- Save success/failure + dirty;
- Load success/failure;
- New City success/conflict/activation failure;
- Rename active/inactive;
- Delete active/inactive;
- duplicate mutating action -> `busy`;
- throwing restore -> resolved backend failure, no bare rejection;
- disposal -> no late publication.

Delete same-city/cross-city FIFO, fence, token, supersession, rollback-coherence, and detach precedence tests.

- [ ] **Step 10: Update `RuntimeController` / test harnesses**

In `src/runtime/types.ts` import persistence types from `workingSaveRuntime.ts`.

Delete `RuntimeTestSeam.debugEnqueueCityPersistence`.

Update `tests/ui/appShell.test.ts` harness:

```ts
const persistenceView: RuntimePersistenceView = {
  activeCity: null,
  busy: false,
  dirty: false,
  error: null,
};
```

Controller harness contains all six methods and returns `unavailable`/fixture results without importing the deleted coordinator.

- [ ] **Step 11: Simplify disposal and fatal cleanup**

`dispose()`:

```ts
dead = true;
stopRuntime();
await gameplayQueue.drain();
await workingSave.dispose();
```

Preserve existing terminal snapshot publication behavior for fatal backend failure, but remove session/load/status resets and lease release.

If ordering needs to avoid a mutating persistence operation waiting on gameplay while disposal waits on persistence, mark `dead = true` first, then drain gameplay, then await `workingSave.dispose()` as specified in the design.

- [ ] **Step 12: Run Task 2 focused gate**

```bash
bunx vitest run --project runtime \
  tests/runtime/workingSaveRuntime.test.ts \
  tests/runtime/citySaveRuntime.test.ts \
  tests/runtime/gameRuntime.test.ts
bunx vitest run --project ui tests/ui/appShell.test.ts
bun run check
bun run format:check
```

Expected: all pass.

- [ ] **Step 13: Run the reservation/preview absence scan before commit**

```bash
rg -n \
  "backendAdmissionReserved|previewAdmissionSuspended|lifecycleTransitionReserved|detachReserving|detachAdmissionLoadToken|commitLoadedSnapshot|PersistenceOperationResult|debugEnqueueCityPersistence" \
  src tests
```

Expected: zero HPA-543-owned matches. If `commitLoadedSnapshot` remains, the cutover is incomplete; the target helper is `installRestoredGameplay`.

- [ ] **Step 14: Commit**

```bash
git add src/runtime src/App.svelte tests/runtime tests/ui
git commit -m "refactor: cut runtime persistence to busy and dirty"
```

---

## Task 3: Delete the Coordinator and Superseded Runtime Documentation

Delete architecture that no longer has a current behavior to protect, and prevent HPA-548's historical runtime bridge from becoming downstream guidance.

**Files:**
- Delete: `src/runtime/persistenceCoordinator.ts`
- Delete: `tests/runtime/persistenceCoordinator.test.ts`
- Delete: `docs/superpowers/plans/2026-08-01-runtime-persistence-coordinator.md`
- Delete: `docs/superpowers/specs/2026-07-31-save-envelope-store-runtime-persistence-design.md`
- Modify: `src/persistence/citySaveStore.ts`
- Modify: `src/App.svelte`
- Modify: `docs/superpowers/specs/2026-08-05-six-operation-city-save-store-design.md`
- Modify: `docs/architecture.md` / `CLAUDE.md` only where stale

- [ ] **Step 1: Delete coordinator source and architecture-only tests**

```bash
rm src/runtime/persistenceCoordinator.ts
rm tests/runtime/persistenceCoordinator.test.ts
rm docs/superpowers/plans/2026-08-01-runtime-persistence-coordinator.md
rm docs/superpowers/specs/2026-07-31-save-envelope-store-runtime-persistence-design.md
```

Do not translate lease/fence/FIFO/handoff tests to `workingSaveRuntime`.

- [ ] **Step 2: Remove stale rollback-dependent store comments**

In `src/persistence/citySaveStore.ts`, retain only the storage atomicity contract:

- failed create commits nothing;
- failed update/rename preserves the prior record;
- no reference to `rollbackNewCity`, leases, or current runtime algorithms.

Do not change the six-operation store API.

- [ ] **Step 3: Mark the HPA-548 runtime bridge superseded**

In `docs/superpowers/specs/2026-08-05-six-operation-city-save-store-design.md`, add immediately under `## 6. Runtime bridge`:

```md
> **Superseded by HPA-543 (2026-08-08).** Sections 3–5 remain the authoritative
> `CitySaveStore` contract. The controller/coordinator workflow below describes
> the temporary HPA-548 cutover state and must not be used for new runtime work.
> See `2026-08-08-working-save-runtime-design.md` for the current runtime contract.
```

Do not rewrite HPA-548's store model or pretend its historical implementation sequence never existed.

- [ ] **Step 4: Clean App/architecture comments**

Delete comments that say App disposal drains/releases a persistence lease.

Update `docs/architecture.md` / `CLAUDE.md` only if they still describe the coordinator as current after HPA-543. Keep the working rules and two-host/six-store contracts intact.

- [ ] **Step 5: Run the full HPA-543 absence scan**

```bash
rg -n \
  "persistenceCoordinator|SharedPersistenceCoordinator|PersistenceLease|createCityPersistenceQueues|resolveWorkingSaveCompletion|resolvePersistenceSessionCompletion|ActiveCityIdentity|NewCityIdentity|saveWorking|renameActiveCity|detachActiveCity|activateNewCity|PersistenceOperationResult|currentRevision|persistedRevision|sessionToken|loadRequestToken|backendAdmissionReserved|previewAdmissionSuspended|lifecycleTransitionReserved|detachReserving|saveStatus|loadStatus|lifecycleStatus|lastSavedAt|commitLoadedSnapshot|debugEnqueueCityPersistence" \
  src tests docs CLAUDE.md
```

Expected: no production/test matches for deleted architecture. Historical HPA-548 prose is allowed only inside the explicitly superseded runtime-bridge section.

- [ ] **Step 6: Run Task 3 gate**

```bash
bunx vitest run --project runtime
bunx vitest run --project ui
bun run check
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

No new behavior belongs in this task. It proves the finished implementation is small, current, and green.

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

Expected: all pass.

- [ ] **Step 4: Run Rust workspace tests**

```bash
cargo test --workspace
```

Expected: PASS. No Rust behavior should have changed, but this is part of the repository completion gate.

- [ ] **Step 5: Repeat the final architecture absence scan**

```bash
rg -n \
  "SharedPersistenceCoordinator|PersistenceLease|createCityPersistenceQueues|resolveWorkingSaveCompletion|resolvePersistenceSessionCompletion|backendAdmissionReserved|previewAdmissionSuspended|lifecycleTransitionReserved|detachReserving|PersistenceOperationResult|debugEnqueueCityPersistence" \
  src tests
```

Expected: zero matches.

Also confirm the new controller surface:

```bash
rg -n "listCities\(|save\(|load\(|createCity\(|renameCity\(|deleteCity\(" \
  src/runtime/workingSaveRuntime.ts
```

- [ ] **Step 6: Review diff for YAGNI/KISS**

```bash
git diff --stat main...HEAD
git diff --numstat main...HEAD -- src tests
```

Required review outcome:

- production + test code is materially net-negative;
- no new manager/service/scheduler/mutex/registry/state-machine abstraction appeared;
- only one mutating persistence busy boolean exists;
- `listCities` did not add read lifecycle state;
- no operation-kind state was added solely for previews;
- tests target player-visible behavior rather than rebuilding the removed race matrix.

If the diff is net-positive because of new orchestration/test scaffolding, stop and simplify before finishing.

- [ ] **Step 7: Review public behavior against HPA-543**

Confirm manually from code/tests:

- city listing stays behind the runtime boundary;
- Save failure leaves dirty and prior record;
- Load failure leaves public gameplay/identity;
- New City persists before activation;
- activation failure leaves the created record available;
- active Delete clears identity only after store success;
- mutating persistence blocks gameplay + backend preview admission;
- old preview responses cannot publish after successful engine swap;
- disposal suppresses late mutating-persistence publication;
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

- Prefer one implementation PR for Tasks 1–4. The public runtime API is intentionally breaking, so a compatibility branch adds no value.
- Task 1 may coexist temporarily with the old coordinator only to keep an independently green commit. Task 2 must cut all runtime consumers atomically.
- Task 3 deletes the old architecture instead of preserving tests for it.
- HPA-343/HPA-344 implement store adapters only after this runtime contract is stable.
- HPA-345/HPA-346 consume the six-operation runtime controller and never receive direct store access.
- HPA-544 remains the only intended place for pre-release hardening of an observed ambiguous-host failure.
