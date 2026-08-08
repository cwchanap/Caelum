# HPA-543 Working Save Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the generalized persistence coordinator and replace it with one small working-save runtime that uses active city + busy + dirty for Save, Load, New City, Rename, and Delete.

**Architecture:** Keep the existing serialized gameplay queue because it has a current mutation-ordering purpose. Persistence uses no queue of its own: one synchronous `busy` gate blocks new gameplay mutation admission, drains already-admitted gameplay, and runs exactly one store/backend workflow. `workingSaveRuntime.ts` owns only `CitySummary | null`, `busy`, `dirty`, one error, and one in-flight promise for disposal. Successful Load/New City installs the Rust snapshot through a narrow callback back into `createGameRuntime`.

**Tech Stack:** TypeScript 5.8, Svelte 5, Vitest 3, Bun, Rust-backed `GameBackend`, Playwright, Cargo.

## Global Constraints

- Breaking change only: no old persistence controller aliases, compatibility adapter, migration, or dual API.
- `RuntimePersistenceView` contains only `activeCity`, `busy`, `dirty`, and `error`.
- Reuse `CitySummary` as the active-city shape; do not keep `ActiveCityIdentity` or `NewCityIdentity`.
- Persistence controller exposes only `save`, `load`, `createCity`, `renameCity`, and `deleteCity`.
- Keep the existing gameplay `createSerializedQueue`; do not create a persistence queue, mutex service, scheduler, manager class, command bus, registry, or state machine.
- New City persists the pure sandbox candidate before activation.
- Returned `{ ok: false }` restore failures preserve the current public runtime; thrown host failures are surfaced without rollback/reconciliation.
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
- `tests/runtime/delayedCitySaveStore.ts` only if focused busy/disposal tests still need the helper
- `docs/architecture.md` and/or `CLAUDE.md` only where they describe the removed persistence coordinator

### Delete

- `src/runtime/persistenceCoordinator.ts`
- `tests/runtime/persistenceCoordinator.test.ts`
- `docs/superpowers/plans/2026-08-01-runtime-persistence-coordinator.md`
- `docs/superpowers/specs/2026-07-31-save-envelope-store-runtime-persistence-design.md`

### Search-only consumers

Run before editing:

```bash
rg -n \
  "persistenceCoordinator|SharedPersistenceCoordinator|PersistenceLease|ActiveCityIdentity|NewCityIdentity|saveWorking|renameActiveCity|detachActiveCity|currentRevision|persistedRevision|sessionToken|loadRequestToken|backendAdmissionReserved|lifecycleTransitionReserved|detachReserving|saveStatus|loadStatus|lifecycleStatus|lastSavedAt|debugEnqueueCityPersistence" \
  src tests docs CLAUDE.md
```

Change only direct HPA-543 consumers. Do not refactor unrelated files because a broad search mentions words such as `superseded` or `revision` for route editing.

---

## Task 1: Add the Standalone Working-Save Runtime

Build the complete new persistence module beside the current coordinator. Do not integrate it into `createGameRuntime` yet.

**Files:**
- Create: `src/runtime/workingSaveRuntime.ts`
- Create: `tests/runtime/workingSaveRuntime.test.ts`
- Reuse: `src/persistence/citySaveStore.ts`
- Reuse: `tests/runtime/delayedCitySaveStore.ts`

**Interfaces:**
- Consumes: `GameBackend`, `RustGameSnapshot`, `SandboxCreationRequest`, `SnapshotError`, `SandboxHostError`, `SandboxCreationError`, `CitySaveStore`, `CitySaveStoreError`, `CitySummary`
- Produces: `RuntimePersistenceView`, `WorkingSaveError`, `WorkingSaveResult<T>`, `RuntimePersistenceController`, `WorkingSaveRuntime`, `createWorkingSaveRuntime(...)`

- [ ] **Step 1: Write the target public contract and test fixture imports**

Create the module with these exact public shapes:

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

Define the host boundary:

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
  controller: RuntimePersistenceController;
  getView(): RuntimePersistenceView;
  isBusy(): boolean;
  markDirty(): void;
  dispose(): Promise<void>;
}
```

- [ ] **Step 2: Add failing tests for the minimal state model**

In `tests/runtime/workingSaveRuntime.test.ts`, build a direct host fixture with a memory store and backend stub. Add these first assertions:

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
bun run test -- tests/runtime/workingSaveRuntime.test.ts
```

Expected: FAIL because `workingSaveRuntime.ts` is not implemented yet.

- [ ] **Step 3: Implement one local exclusive runner**

Use closure-local state only:

```ts
let activeCity = host.initialCity;
let busy = false;
let dirty = false;
let error: WorkingSaveError | null = null;
let disposed = false;
let inFlight: Promise<void> | null = null;

const isLive = (): boolean => !disposed && !host.isRuntimeDead();

const publishIfLive = (): void => {
  if (isLive()) host.publish();
};
```

Implement the admission skeleton:

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
    await host.awaitGameplayIdle();
    if (!isLive()) {
      return { ok: false, error: { kind: "unavailable" } };
    }
    return work();
  })();

  inFlight = operation.then(
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
      inFlight = null;
      publishIfLive();
    });
};
```

`getView()` returns the four fields. `markDirty()` sets `dirty = true` only when `activeCity !== null`. `dispose()` sets `disposed = true` synchronously and awaits the current `inFlight` promise if one exists.

- [ ] **Step 4: Add and implement Save behavior**

Add tests for:

```ts
runtime.markDirty();
const result = await runtime.controller.save();
expect(result).toMatchObject({ ok: true, value: { id: ACTIVE_CITY.id } });
expect(runtime.getView().dirty).toBe(false);
expect(runtime.getView().activeCity?.savedAt).toBe(NEXT_SAVED_AT);
```

and failure:

```ts
runtime.markDirty();
failures.failNext("updateCity", "failed");
await expect(runtime.controller.save()).resolves.toMatchObject({
  ok: false,
  error: { kind: "store", error: { operation: "updateCity" } },
});
expect(runtime.getView().dirty).toBe(true);
```

Implement Save exactly as:

1. reject `unavailable` when no store;
2. reject `noActiveCity` when detached;
3. `await backend.snapshotForSave()`;
4. convert thrown backend errors to the existing `hostFailure` backend shape;
5. generate `savedAt = host.now()`;
6. call `saveStore.updateCity(activeCity.id, { savedAt, snapshot })`;
7. on success assign the returned `CitySummary` to `activeCity` and `dirty = false`;
8. on failure keep active city and dirty unchanged.

Do not create on `notFound` and do not re-read after failure.

- [ ] **Step 5: Add and implement Load behavior**

Add a success test that records the snapshot passed to `installRestoredGameplay` and verifies the returned summary becomes active and clean.

Add failure tests for `readCity` and returned `{ ok: false }` restore. In both cases assert the previous active city and installed gameplay remain unchanged.

Implement:

```ts
const stored = await saveStore.readCity(cityId);
if (!stored.ok) return storeFailure(stored.error);

const restored = await host.backend.restoreSnapshot(stored.value.snapshot);
if (!restored.ok) return backendFailure(restored.error);
if (!isLive()) return unavailable();

host.installRestoredGameplay(restored.snapshot);
activeCity = {
  ...stored.value.city,
  savedAt: stored.value.savedAt,
};
dirty = false;
return { ok: true, value: activeCity };
```

A thrown restore becomes a backend host failure. Do not capture/restore a rollback snapshot.

- [ ] **Step 6: Add and implement New City behavior**

Use deterministic fixture generators:

```ts
createCityId: () => "city-new",
now: () => "2026-08-08T12:00:00.000Z",
```

Success must prove the ordering:

```text
buildSandboxSnapshot -> createCity -> restoreSnapshot -> installRestoredGameplay
```

The record uses the same generated timestamp for `createdAt` and initial `savedAt`.

Add tests for:

- success;
- `createCity` conflict;
- pure sandbox candidate failure;
- returned activation failure after create.

For activation failure, assert:

```ts
expect(await store.readCity("city-new")).toMatchObject({ ok: true });
expect(runtime.getView().activeCity).toEqual(ACTIVE_CITY);
expect(installedSnapshot).toBeNull();
```

Do not delete the newly created record.

- [ ] **Step 7: Add and implement generic Rename/Delete**

Rename tests:

- active city: returned summary replaces `activeCity`, dirty unchanged;
- inactive city: store changes, active summary/dirty unchanged.

Delete tests:

- inactive city: active summary/dirty unchanged;
- active city: only after successful store deletion set `activeCity = null` and `dirty = false`.

No gameplay snapshot is cleared by Delete.

- [ ] **Step 8: Prove one busy gate and disposal suppression**

Use `createDelayedCitySaveStore` to defer `updateCity`:

```ts
const saving = runtime.controller.save();
await delayed.waitForActive("updateCity");
expect(runtime.getView().busy).toBe(true);
await expect(runtime.controller.renameCity(ACTIVE_CITY.id, "Other")).resolves.toEqual({
  ok: false,
  error: { kind: "busy" },
});
delayed.releaseNext("updateCity");
await saving;
```

Add disposal coverage:

```ts
const saving = runtime.controller.save();
await delayed.waitForActive("updateCity");
const dispose = runtime.dispose();
const publicationsBeforeRelease = publications;
delayed.releaseNext("updateCity");
await Promise.all([saving, dispose]);
expect(publications).toBe(publicationsBeforeRelease);
```

- [ ] **Step 9: Run Task 1 gate**

```bash
bun run test -- tests/runtime/workingSaveRuntime.test.ts
bun run check
bun run format:check
```

Expected: all pass.

- [ ] **Step 10: Commit**

```bash
git add src/runtime/workingSaveRuntime.ts tests/runtime/workingSaveRuntime.test.ts tests/runtime/delayedCitySaveStore.ts
git commit -m "refactor: add minimal working save runtime"
```

---

## Task 2: Atomically Cut `createGameRuntime` to Busy + Dirty

Replace the current inline coordinator workflows with the new module. This task changes runtime types and direct runtime tests together; do not keep compatibility aliases.

**Files:**
- Modify: `src/runtime/createGameRuntime.ts`
- Modify: `src/runtime/types.ts`
- Modify: `tests/runtime/citySaveRuntime.test.ts`
- Modify: `tests/runtime/gameRuntime.test.ts`
- Modify: `tests/ui/appShell.test.ts`
- Modify: any direct test fixture found by the initial search

**Interfaces:**
- Consumes: `createWorkingSaveRuntime`, `RuntimePersistenceController`, `RuntimePersistenceView`
- Produces: runtime controller with `persistence.save/load/createCity/renameCity/deleteCity`
- Removes from runtime public/test API: `saveWorking`, `renameActiveCity`, `activateNewCity`, `detachActiveCity`, `debugEnqueueCityPersistence`

- [ ] **Step 1: Update runtime construction options**

Replace the current identity/save-time split:

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

Resolve simple defaults inside `createGameRuntime`:

```ts
const now = options.now ?? (() => new Date().toISOString());
const createCityId =
  options.createCityId ?? (() => globalThis.crypto.randomUUID());
```

Tests inject both functions when deterministic values matter.

- [ ] **Step 2: Remove coordinator acquisition from runtime construction**

Replace the lease/try construction with direct initialization:

```ts
let state = normalizeRustSnapshot(await backend.snapshot());
let ui = createUiState();
let backendError: string | null = null;
let rejection: GameplayRejection | null = null;
let sandboxResetError: SandboxResetError | null = null;
let dead = false;
const gameplayQueue = createSerializedQueue(() => dead);
```

Delete:

- `PersistenceLease`;
- `createSharedPersistenceCoordinator()`;
- `acquireLease()`;
- `startDrainAndRelease()`;
- `cityQueues`;
- fence helpers;
- foreground admission;
- all coordinator lifecycle comments.

- [ ] **Step 3: Add one non-publishing restored-gameplay installer**

Near the runtime state/preview variables, add:

```ts
const installRestoredGameplay = (snapshot: RustGameSnapshot): void => {
  if (hoverPreviewTimer !== null) {
    clearTimeout(hoverPreviewTimer);
    hoverPreviewTimer = null;
  }
  previewRuntimeEpoch += 1;
  previewCoordinator.invalidateRoute();
  previewCoordinator.invalidateRoadMutation();
  activeRoadMutation = null;
  activeRouteSaveTokens.clear();
  nextRouteDraftInstanceId = 1;
  state = normalizeRustSnapshot(snapshot);
  ui = createUiState();
  backendError = null;
  rejection = null;
  sandboxResetError = null;
};
```

Do not publish from this helper. The working-save operation publishes after it has also updated active-city/dirty/error state.

- [ ] **Step 4: Construct the working-save runtime and publish its view**

Replace `getPersistenceView()` and inline persistence variables with:

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

`getSnapshot()` becomes:

```ts
const getSnapshot = (): RuntimeSnapshot => ({
  state,
  ui,
  shell: selectShellState(state, ui, rejection),
  persistence: workingSave.getView(),
  backendError,
  rejection,
  sandboxResetError,
});
```

It is acceptable for the `publish` callback to close over the later-declared `publish` function because no persistence action runs during construction. Do not add an event bus or callback registry to avoid this ordinary closure.

- [ ] **Step 5: Mark dirty before applied gameplay publication**

Replace revision arithmetic in `commitDispatchResult`:

```ts
if (result.applied) {
  workingSave.markDirty();
}
```

Keep the existing normalization/commit behavior unchanged.

For successful `reset()`, remove revision/session/status resets and call:

```ts
workingSave.markDirty();
```

before publishing the reset snapshot.

Do not mark dirty for UI-only transitions or rejected/no-op dispatches.

- [ ] **Step 6: Block new gameplay mutation admission while persistence is busy**

Change `queueBackend` admission from the old New City reservation gate to:

```ts
if (workingSave.isBusy()) return Promise.resolve(getSnapshot());
```

Because `enqueueDispatch`, computed dispatch, tick, reset, route save, and other backend-mutating commands flow through `queueBackend`, this is the only general gameplay mutation gate.

Remove `backendAdmissionReserved` checks from UI-only methods. Read-only previews may continue. Successful Load/New City invalidates their epochs via `installRestoredGameplay`.

- [ ] **Step 7: Delete inline persistence workflows from `createGameRuntime.ts`**

Remove the complete current blocks for:

- `unavailableStoreResult`;
- `isCurrentPersistenceSession`;
- save capture/completion helpers;
- `saveWorking`;
- `renameActiveCity`;
- load transition/token helpers;
- `loadCity`;
- rollback helpers and prior-state capture/restore helpers;
- `activateNewCity`;
- `detachActiveCity`;
- city fence/drain logic;
- `PersistenceOperationResult`/superseded logic.

Set the public controller directly:

```ts
const persistence = workingSave.controller;
```

- [ ] **Step 8: Simplify stop/fatal/dispose paths**

`stop()` becomes the ordinary canvas/preview stop again; remove reservation-specific deferred stop state.

In `failBackend`, after setting `dead = true` and clearing preview UI, suppress late persistence publication with:

```ts
void workingSave.dispose();
```

Do not reset persistence tokens/statuses because they no longer exist.

Replace lease drain/release disposal with:

```ts
const dispose = async (): Promise<void> => {
  disposalRequested = true;
  if (!dead) dead = true;
  stopRuntime();
  await Promise.all([gameplayQueue.drain(), workingSave.dispose()]);
};
```

Retain the existing terminal-snapshot behavior for a live fatal backend failure. Do not broaden HPA-543 into a shell-error redesign.

- [ ] **Step 9: Update runtime public/test types**

In `src/runtime/types.ts` import the new persistence types from `workingSaveRuntime.ts`.

Keep:

```ts
export interface RuntimeSnapshot {
  state: GameState;
  ui: UiState;
  shell: ShellState;
  persistence: RuntimePersistenceView;
  backendError: string | null;
  rejection: GameplayRejection | null;
  sandboxResetError: SandboxResetError | null;
}
```

Delete `debugEnqueueCityPersistence` from `RuntimeTestSeam`. Keep only debug seams with a current gameplay-test purpose such as `debugSetBudget`.

- [ ] **Step 10: Rewrite direct runtime persistence tests to the new API**

Update fixtures from:

```ts
initialCity: ACTIVE_CITY,
lastSavedAt: "...",
```

to one `CitySummary`:

```ts
initialCity: {
  ...ACTIVE_CITY,
  savedAt: "2026-08-01T09:30:00.000Z",
},
createCityId: () => "city-002",
now: () => "2026-08-01T10:00:00.000Z",
```

Rename calls:

```ts
runtime.persistence.save()
runtime.persistence.load(cityId)
runtime.persistence.createCity({ name: "New City", sandbox: SANDBOX_REQUEST })
runtime.persistence.renameCity(cityId, "Renamed City")
runtime.persistence.deleteCity(cityId)
```

Delete expectations for `{ status: "completed" | "failed" | "superseded" }`; assert `{ ok: true }` / `{ ok: false }`.

Keep only integration cases that prove `createGameRuntime` wiring rather than duplicating Task 1's module tests:

- applied `debugSetBudget` makes persistence dirty;
- Save waits for an already-admitted gameplay mutation and captures the resulting state;
- gameplay mutation attempted while delayed Save is busy does not reach the backend;
- successful Load/New City resets stale UI/preview state and publishes the new active city;
- active Delete clears active identity but leaves the engine snapshot untouched.

- [ ] **Step 11: Update App/test harness persistence fixtures**

Replace the old status-heavy harness view with:

```ts
const persistenceView: RuntimePersistenceView = {
  activeCity: null,
  busy: false,
  dirty: false,
  error: null,
};
```

Replace the harness controller with five direct methods returning `{ ok: false, error: { kind: "unavailable" } }`.

Remove the `debugEnqueueCityPersistence` stub.

- [ ] **Step 12: Run Task 2 gate**

```bash
bun run test -- \
  tests/runtime/workingSaveRuntime.test.ts \
  tests/runtime/citySaveRuntime.test.ts \
  tests/runtime/gameRuntime.test.ts \
  tests/ui/appShell.test.ts
bun run check
bun run lint:svelte
bun run format:check
```

Expected: all pass.

- [ ] **Step 13: Commit**

```bash
git add src/runtime src/App.svelte tests/runtime tests/ui

git commit -m "refactor: cut runtime to one persistence busy gate"
```

---

## Task 3: Delete the Coordinator Architecture and Stale Contracts

With runtime consumers cut over, remove the dead framework and tests/docs that only describe it.

**Files:**
- Delete: `src/runtime/persistenceCoordinator.ts`
- Delete: `tests/runtime/persistenceCoordinator.test.ts`
- Delete: `docs/superpowers/plans/2026-08-01-runtime-persistence-coordinator.md`
- Delete: `docs/superpowers/specs/2026-07-31-save-envelope-store-runtime-persistence-design.md`
- Modify: `src/persistence/citySaveStore.ts`
- Modify: `src/App.svelte`
- Modify: `tests/runtime/delayedCitySaveStore.ts` if unused helper surface remains
- Modify: `docs/architecture.md` / `CLAUDE.md` only for current architecture statements

**Interfaces:**
- Removes all coordinator/lease/fence/FIFO/session/supersession architecture
- Keeps the six-operation `CitySaveStore` and gameplay serialized queue

- [ ] **Step 1: Delete the coordinator source and ownership suite**

```bash
rm src/runtime/persistenceCoordinator.ts
rm tests/runtime/persistenceCoordinator.test.ts
```

Do not port lease, queue, fence, foreground-admission, or handoff tests to another module.

- [ ] **Step 2: Delete superseded persistence design/plan docs**

```bash
rm docs/superpowers/plans/2026-08-01-runtime-persistence-coordinator.md
rm docs/superpowers/specs/2026-07-31-save-envelope-store-runtime-persistence-design.md
```

The new HPA-543 spec/plan plus the HPA-547/HPA-548 documents are the current architecture trail.

- [ ] **Step 3: Remove stale rollback-specific store documentation**

In `src/persistence/citySaveStore.ts`, replace the paragraph that says the runtime relies on `rollbackNewCity` with a current statement:

```ts
/**
 * Atomicity guarantee: a mutation that returns an error (or rejects) must not
 * have committed that mutation. A failed create cannot overwrite/create a city;
 * a failed update or rename leaves the prior record intact. The working-save
 * runtime relies on this for retryable Save/New City failures and does not add
 * a repair or read-back layer.
 */
```

Do not change the six-operation API in HPA-543.

- [ ] **Step 4: Simplify App disposal commentary**

Replace lease-specific teardown wording with the current behavior:

```ts
// Dispose (not just stop) so an in-flight persistence operation can finish
// without publishing after unmount and the gameplay queue drains cleanly.
void runtime.dispose();
```

No UI behavior change belongs in this task.

- [ ] **Step 5: Trim the delayed-store helper to actual test needs**

Search:

```bash
rg -n "mutationOrder|activeCount|releaseAll|defer\(|waitForActive|releaseNext" tests/runtime
```

Keep only helper methods used by focused busy/disposal tests. If the rewritten suite uses only `defer`, `waitForActive`, and `releaseNext`, delete `mutationOrder`, `activeCount`, and `releaseAll` plus their bookkeeping.

Do not replace this test helper with a production scheduler abstraction.

- [ ] **Step 6: Update current architecture docs only**

Search:

```bash
rg -n "SharedPersistenceCoordinator|PersistenceLease|per-city FIFO|city fence|persistedRevision|sessionToken|loadRequestToken|superseded|rollbackNewCity" docs/architecture.md CLAUDE.md
```

For current architecture statements, describe:

- Rust `GameBackend` candidate-first restore;
- six-operation `CitySaveStore`;
- one `workingSaveRuntime` busy/dirty gate;
- existing gameplay queue retained only for gameplay mutation serialization.

Do not rewrite historical PR/spec prose outside the explicitly deleted obsolete documents.

- [ ] **Step 7: Run absence scans**

```bash
rg -n \
  "SharedPersistenceCoordinator|PersistenceLease|createSharedPersistenceCoordinator|PersistenceLeaseClosedError|debugEnqueueCityPersistence|resolveWorkingSaveCompletion|resolvePersistenceSessionCompletion|detachActiveCity|saveWorking|renameActiveCity|backendAdmissionReserved|lifecycleTransitionReserved|detachReserving|currentRevision|persistedRevision|sessionToken|loadRequestToken|saveStatus|loadStatus|lifecycleStatus|lastSavedAt" \
  src tests docs/architecture.md CLAUDE.md
```

Expected: zero HPA-543 architecture matches. Investigate any residual match; do not blindly rename unrelated domain `revision` concepts.

Also verify the new boundary is not becoming another framework:

```bash
rg -n "PersistenceManager|PersistenceService|PersistenceScheduler|PersistenceMutex|command bus|event bus|lock manager" src/runtime
```

Expected: zero matches.

- [ ] **Step 8: Run Task 3 gate**

```bash
bun run test:unit
bun run check
bun run lint:svelte
bun run format:check
```

Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add -A src tests docs CLAUDE.md
git commit -m "refactor: delete persistence coordinator machinery"
```

---

## Task 4: Full Verification and Deletion Review

Do not add new behavior in this task. Fix only issues exposed by the full gate or stale references discovered by the final review.

**Files:**
- Modify only files required by failing checks or stale HPA-543 references

**Interfaces:**
- Confirms the final busy/dirty working-save boundary across frontend and Rust hosts

- [ ] **Step 1: Run focused persistence/runtime tests**

```bash
bun run test -- \
  tests/runtime/workingSaveRuntime.test.ts \
  tests/runtime/citySaveRuntime.test.ts \
  tests/runtime/gameRuntime.test.ts \
  tests/ui/appShell.test.ts
```

Expected: all pass.

- [ ] **Step 2: Run full frontend/unit verification**

```bash
bun run test:unit
bun run check
bun run lint:svelte
bun run format:check
bun run build
```

Expected: all pass.

- [ ] **Step 3: Run end-to-end verification**

```bash
bun run test:e2e
```

Expected: all current Playwright tests pass. HPA-543 does not add city-library/New City UI e2e flows; those belong to HPA-345/HPA-346.

- [ ] **Step 4: Run Rust verification**

```bash
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all --check
```

Expected: all pass. No Rust behavior change is expected, but both native/WASM host consumers still depend on the same Rust core.

- [ ] **Step 5: Review the diff for material deletion**

```bash
git diff --stat main...HEAD
git diff --numstat main...HEAD
```

Verify the implementation is materially net-negative across production/test code after adding `workingSaveRuntime.ts` and its focused tests.

Reject the branch if it recreated equivalent complexity under new names.

- [ ] **Step 6: Final symbol scan**

```bash
rg -n \
  "SharedPersistenceCoordinator|PersistenceLease|createSharedPersistenceCoordinator|PersistenceLeaseClosedError|debugEnqueueCityPersistence|resolveWorkingSaveCompletion|resolvePersistenceSessionCompletion|detachActiveCity|saveWorking|renameActiveCity|backendAdmissionReserved|lifecycleTransitionReserved|detachReserving|currentRevision|persistedRevision|sessionToken|loadRequestToken|saveStatus|loadStatus|lifecycleStatus|lastSavedAt" \
  src tests docs/architecture.md CLAUDE.md
```

Expected: zero current-architecture matches.

- [ ] **Step 7: Commit verification-only fixes if needed**

If the full gate required source/test/doc changes:

```bash
git add -A
git commit -m "test: finish HPA-543 verification"
```

If no files changed, do not create an empty commit.

---

## Final Review Checklist

Before marking HPA-543 complete, verify all of these directly against the final tree:

- [ ] `RuntimePersistenceView` has exactly active city, busy, dirty, error.
- [ ] Active city is `CitySummary | null`; no duplicate identity type remains.
- [ ] Controller has only Save, Load, Create, Rename, Delete.
- [ ] New City ID/timestamp generation is runtime-owned and injectable for tests.
- [ ] Persistence sets busy synchronously before its first await.
- [ ] Persistence drains the existing gameplay queue and blocks new gameplay mutations until completion.
- [ ] No persistence queue or lock framework exists.
- [ ] Applied gameplay uses one dirty boolean.
- [ ] Save failure preserves dirty and the prior record.
- [ ] Load returned failure preserves current public gameplay/identity.
- [ ] New City storage commits before activation; activation failure leaves the record available.
- [ ] Thrown host restore does not trigger rollback/reconciliation machinery.
- [ ] Rename/Delete work for inactive IDs and update active metadata only when IDs match.
- [ ] Active Delete clears active identity only after storage success.
- [ ] Disposal waits for at most one in-flight persistence action and suppresses late publication.
- [ ] `persistenceCoordinator.ts` and its ownership suite are deleted.
- [ ] Revision/session/load tokens, fences, leases, FIFOs, superseded results, reservation flags, and rollback helpers are absent.
- [ ] The final code/test diff is materially smaller rather than an abstraction rename.
