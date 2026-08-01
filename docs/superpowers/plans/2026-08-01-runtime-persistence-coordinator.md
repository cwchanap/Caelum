# Runtime Persistence Coordinator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement HPA-499’s typed persistence coordinator, dirty/session tracking, shared per-city persistence FIFO, source-aware loading, and foreground New City rollback without changing existing gameplay semantics.

**Architecture:** `createGameRuntime` remains the sole owner of frontend runtime state. Extract its current queue chaining into a typed internal serializer while preserving the existing `queueBackend` wrapper. A `RuntimePersistenceController` uses HPA-498’s `SaveStore`; gameplay-bearing writes enter gameplay ordering only for canonical `snapshotForSave` capture, then release it during normal storage I/O. Foreground New City is the sole admission-reserving transaction.

**Tech Stack:** TypeScript 5.8, Vitest runtime project, Bun, existing `GameBackend`, `normalizeRustSnapshot` from `src/runtime/snapshotView.ts`, `createUiState`, HPA-498 persistence modules.

## Global Constraints

- HPA-498 must land first; do not redefine envelope or store contracts in runtime files.
- Every gameplay-bearing write uses `backend.snapshotForSave()`; every load uses `backend.restoreSnapshot()`.
- Normalized `GameState` and `RuntimeSnapshot.state` are never persistence payloads.
- Existing gameplay `queueBackend` semantics remain unchanged, including dead-runtime resolution with the last `RuntimeSnapshot`.
- Persistence calls on a dead runtime return typed `runtimeUnavailable`, never a `RuntimeSnapshot` of the wrong type.
- Every coordinator call returns `completed | failed | superseded`.
- Working save, checkpoint, autosave, and active rename share one FIFO per city.
- Only working-save success updates `persistedRevision` and `lastSavedAt`.
- Loads inspect the envelope first, restore through Rust, normalize inside one runtime commit, and enter paused.
- Foreground New City drops ticks and no-ops backend dispatch attempts instead of buffering them.
- Exact rollback restores backend state, UI, identity, revisions, statuses, error, and save time; rollback failure is fatal.
- No frontend-only timeout is added over uncancellable storage writes.
- `src/main.ts` remains buildable before HPA-343/HPA-344: `createGameRuntime` accepts an optional `saveStore`; persistence operations return `SaveStoreError { code: "unavailable" }` when no store is composed.

---

## File Map

**Create**

- `src/runtime/persistenceCoordinator.ts`
- `tests/runtime/persistenceCoordinator.test.ts`

**Modify**

- `src/runtime/types.ts`
- `src/runtime/createGameRuntime.ts`
- `tests/runtime/gameRuntime.test.ts`
- `tests/fixtures/rustSnapshot.ts` — extend existing `previewBackendStubs`/snapshot helpers with deterministic persistence counters and delayed outcomes used by new tests.

**Read/Reuse**

- `src/persistence/envelope.ts`
- `src/persistence/envelopeInspection.ts`
- `src/persistence/saveStore.ts`
- `src/persistence/memorySaveStore.ts`
- `src/runtime/backend/types.ts`
- `src/runtime/backend/persistenceContract.ts`
- `src/runtime/snapshotView.ts`
- `src/ui/uiState.ts`
- Existing `backendSpy`, `deferredDispatchBackend`, `fullRustSnapshot`, and route helpers in `tests/runtime/gameRuntime.test.ts`.

## Test Harness Contract

`tests/runtime/persistenceCoordinator.test.ts` defines these local helpers before its first `describe` block; later tasks extend their behavior without changing their names:

```ts
interface CoordinatorHarness {
  runtime: RuntimeController;
  backend: GameBackend & {
    snapshotForSaveCalls: number;
    restoreSnapshotCalls: number;
    tickCalls: number;
  };
  store: MemorySaveStore;
  failures: MemorySaveStoreFailureControls;
}

async function createCoordinatorHarness(options: {
  activeCity?: ActiveCityIdentity | null;
  clean?: boolean;
} = {}): Promise<CoordinatorHarness>;

function cityIdentity(id = "city-1"): ActiveCityIdentity;
function sandboxRequest(): SandboxCreationRequest;
function newCityIdentity(): NewCityIdentity;
function checkpointRequest(): GameplayWriteRequest<CheckpointSummary>;
function autosaveRequest(): GameplayWriteRequest<AutosaveSummary>;
function generationRequest(
  kind: "checkpoint" | "autosave",
): GameplayWriteRequest<CheckpointSummary | AutosaveSummary>;
```

`tests/runtime/gameRuntime.test.ts` continues using its existing local backend helpers. Do not move unrelated route/road simulation helpers into the new coordinator test file.

---

### Task 1: Define coordinator contracts as a green standalone module

**Files:**
- Create: `src/runtime/persistenceCoordinator.ts`
- Create: `tests/runtime/persistenceCoordinator.test.ts`
- Modify: `tests/fixtures/rustSnapshot.ts`

**Interfaces:**
- Produces: operation/result/error types, `RuntimePersistenceView`, `RuntimePersistenceController`, `RuntimeGameplayWriteCoordinator`, pure helper constructors, and the base `createCoordinatorHarness`.

- [ ] **Step 1: Write the failing result-catalogue test**

```ts
it("keeps supersession separate from runtime errors", () => {
  const result: PersistenceOperationResult<{ savedAt: string }> = {
    status: "superseded",
  };
  expect(result.status).toBe("superseded");
});

it("builds a typed dead-runtime result", () => {
  expect(runtimeUnavailable("saveWorking")).toEqual({
    status: "failed",
    error: {
      kind: "precondition",
      error: { code: "runtimeUnavailable", operation: "saveWorking" },
    },
  });
});
```

- [ ] **Step 2: Run the test and confirm failure**

Run: `bunx vitest run --project runtime tests/runtime/persistenceCoordinator.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Define closed operations and results**

```ts
export type PersistenceCoordinatorOperation =
  | "saveWorking"
  | "renameActiveCity"
  | "createCheckpoint"
  | "createAutosave"
  | "loadWorking"
  | "loadCheckpoint"
  | "loadAutosave"
  | "activateNewCity"
  | "detachActiveCity";

export type PersistenceOperationResult<T> =
  | { status: "completed"; value: T }
  | { status: "failed"; error: PersistenceCoordinatorError }
  | { status: "superseded" };
```

Define exact preconditions from the spec, including `noActiveCity` for all four gameplay-bearing write operations and `runtimeUnavailable` for every coordinator operation.

- [ ] **Step 4: Define the public view and controller interfaces**

```ts
export interface RuntimePersistenceView {
  activeCity: ActiveCityIdentity | null;
  dirty: boolean;
  saveStatus: RuntimeSaveStatus;
  loadStatus: RuntimeLoadStatus;
  lifecycleStatus: RuntimeLifecycleStatus;
  lastSavedAt: string | null;
  error: PersistenceCoordinatorError | null;
}

export interface RuntimePersistenceController {
  saveWorking(): Promise<PersistenceOperationResult<SaveWorkingValue>>;
  renameActiveCity(name: string): Promise<PersistenceOperationResult<RenameActiveCityValue>>;
  load(source: LoadSource): Promise<PersistenceOperationResult<LoadCityValue>>;
  detachActiveCity(): PersistenceOperationResult<RuntimeSnapshot>;
  activateNewCity(
    request: SandboxCreationRequest,
    identity: NewCityIdentity,
  ): Promise<PersistenceOperationResult<LoadCityValue>>;
  runGameplayWrite<TSummary>(
    request: GameplayWriteRequest<TSummary>,
  ): Promise<PersistenceOperationResult<GenerationWriteValue<TSummary>>>;
}
```

This task defines types only; it does not yet add them to `RuntimeController` or `RuntimeSnapshot`.

- [ ] **Step 5: Add the base deterministic harness**

Extend `previewBackendStubs()` with counters that still return its existing successful persistence results. Instantiate `createMemorySaveStore` with deterministic failure controls. `createCoordinatorHarness` may construct the current runtime without a persistence controller until Task 3; Task 1 tests use only type helpers and the store/backend fixtures.

- [ ] **Step 6: Run tests and typecheck**

```bash
bunx vitest run --project runtime tests/runtime/persistenceCoordinator.test.ts
bun run check
```

Expected: both commands exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/runtime/persistenceCoordinator.ts tests/runtime/persistenceCoordinator.test.ts tests/fixtures/rustSnapshot.ts
git commit -m "feat: define runtime persistence contracts"
```

---

### Task 2: Extract a typed serial primitive while preserving queueBackend

**Files:**
- Modify: `src/runtime/createGameRuntime.ts`
- Modify: `tests/runtime/gameRuntime.test.ts`

**Interfaces:**
- Produces internal `enqueueSerialized<T>`; existing `queueBackend` remains `Promise<RuntimeSnapshot>`.

- [ ] **Step 1: Add regression tests around runtime death**

```ts
it("keeps existing gameplay calls resolving the last snapshot after death", async () => {
  const backend = deferredDispatchBackend();
  const runtime = await createGameRuntime({ backend });
  backend.failNextDispatch(new Error("fatal"));
  const fatal = runtime.togglePause();
  await backend.resolveNext();
  const failed = await fatal;
  expect(await runtime.tick(1)).toBe(failed);
});
```

Add a test-only hook around the internal serializer under `import.meta.env.DEV` or factor it into a small local function that can be unit-tested without exporting a production API. The typed test queues an operation behind the fatal dispatch and asserts `whenDead` is returned without invoking the operation.

- [ ] **Step 2: Run tests and confirm the new case fails**

Run: `bunx vitest run --project runtime tests/runtime/gameRuntime.test.ts`

Expected: existing death test passes; typed serializer case fails.

- [ ] **Step 3: Implement the typed serializer**

```ts
const enqueueSerialized = <T>(options: {
  operation: () => Promise<T>;
  whenDead: () => T;
  onThrown: (error: unknown) => T;
}): Promise<T> => {
  if (dead) return Promise.resolve(options.whenDead());
  const run = gameplayQueue.then(async () => {
    if (dead) return options.whenDead();
    try {
      return await options.operation();
    } catch (error: unknown) {
      return options.onThrown(error);
    }
  });
  gameplayQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
};
```

Rewrite `queueBackend` as a wrapper supplying `getSnapshot` for `whenDead` and `failBackend` for `onThrown`. Do not modify gameplay caller signatures.

- [ ] **Step 4: Run runtime tests**

```bash
bunx vitest run --project runtime tests/runtime/gameRuntime.test.ts
bun run check
```

Expected: both commands exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/createGameRuntime.ts tests/runtime/gameRuntime.test.ts
git commit -m "refactor: extract typed runtime serialization"
```

---

### Task 3: Integrate persistence view and revision accounting

**Files:**
- Modify: `src/runtime/types.ts`
- Modify: `src/runtime/createGameRuntime.ts`
- Modify: `tests/runtime/gameRuntime.test.ts`
- Modify: `tests/runtime/persistenceCoordinator.test.ts`

**Interfaces:**
- Adds `RuntimeSnapshot.persistence` and `RuntimeController.persistence`.
- Extends `createGameRuntime` options with optional `saveStore`, `now`, `appVersion`, `initialCity`, and `lastSavedAt`.

- [ ] **Step 1: Add failing revision tests**

```ts
it("marks applied gameplay dirty but not UI-only changes", async () => {
  const backend = backendSpy();
  const store = createMemorySaveStore();
  const runtime = await createGameRuntime({
    backend,
    saveStore: store,
    initialCity: cityIdentity(),
    now: () => "2026-08-01T10:00:00.000Z",
    appVersion: "0.1.0",
  });
  runtime.setTool("busStop");
  expect(runtime.getSnapshot().persistence.dirty).toBe(false);
  await runtime.debugSetBudget(100_000);
  expect(runtime.getSnapshot().persistence.dirty).toBe(true);
});
```

Add explicit tests for applied tick, route-draft save, reset, previews, rejected/no-op dispatches, and UI-only changes.

- [ ] **Step 2: Run tests and confirm failure**

Run: `bunx vitest run --project runtime tests/runtime/gameRuntime.test.ts -t "dirty"`

Expected: FAIL because persistence state is not integrated.

- [ ] **Step 3: Add internal state and public view**

```ts
let activeCity = options.initialCity ?? null;
let sessionToken = 0;
let currentRevision = 0;
let persistedRevision = 0;
let saveStatus: RuntimeSaveStatus = { state: "idle" };
let loadStatus: RuntimeLoadStatus = { state: "idle" };
let lifecycleStatus: RuntimeLifecycleStatus = { state: "idle" };
let lastSavedAt = options.lastSavedAt ?? null;
let persistenceError: PersistenceCoordinatorError | null = null;

const getPersistenceView = (): RuntimePersistenceView => ({
  activeCity,
  dirty: currentRevision !== persistedRevision,
  saveStatus,
  loadStatus,
  lifecycleStatus,
  lastSavedAt,
  error: persistenceError,
});
```

Add `persistence: getPersistenceView()` to every runtime snapshot.

- [ ] **Step 4: Factor mutation accounting**

Create one commit helper for `DispatchResult` and route ordinary dispatch, tick, route-draft save, and debug dispatch through it. Increment `currentRevision` exactly once when `result.applied` is true. Reset/load/New City use separate authoritative-replacement helpers.

- [ ] **Step 5: Compose available and unavailable persistence controllers**

When `options.saveStore` is absent, every storage-backed method returns a typed store `unavailable` result. When a store exists, create the real coordinator with injected clock/version dependencies.

- [ ] **Step 6: Complete `createCoordinatorHarness`**

Now construct `createGameRuntime` with the memory store, deterministic clock/version, initial identity, and instrumented backend. Expose the concrete runtime/store/backend/failure controls described in the Test Harness Contract.

- [ ] **Step 7: Run tests and typecheck**

```bash
bunx vitest run --project runtime tests/runtime/gameRuntime.test.ts tests/runtime/persistenceCoordinator.test.ts
bun run check
```

Expected: both commands exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/runtime/types.ts src/runtime/createGameRuntime.ts tests/runtime tests/fixtures/rustSnapshot.ts
git commit -m "feat: track runtime persistence state"
```

---

### Task 4: Implement the per-city FIFO and working save

**Files:**
- Modify: `src/runtime/persistenceCoordinator.ts`
- Modify: `src/runtime/createGameRuntime.ts`
- Modify: `tests/runtime/persistenceCoordinator.test.ts`

**Interfaces:**
- Implements `RuntimePersistenceController.saveWorking`.

- [ ] **Step 1: Add failing FIFO and captured-revision tests**

```ts
it("runs one persistence mutation per city in call order", async () => {
  const harness = await createCoordinatorHarness();
  harness.store.deferWorkingWrites();
  const first = harness.runtime.persistence.saveWorking();
  const second = harness.runtime.persistence.saveWorking();
  expect(harness.store.activeMutationCount()).toBe(1);
  harness.store.releaseNextMutation();
  await first;
  harness.store.releaseNextMutation();
  await second;
  expect(harness.store.mutationOrder()).toEqual(["working-1", "working-2"]);
});

it("advances persistence only through the captured revision", async () => {
  const harness = await createCoordinatorHarness();
  await harness.runtime.debugSetBudget(100_000);
  harness.store.deferWorkingWrites();
  const save = harness.runtime.persistence.saveWorking();
  await harness.store.waitForActiveMutation();
  await harness.runtime.debugSetBudget(90_000);
  harness.store.releaseNextMutation();
  expect((await save).status).toBe("completed");
  expect(harness.runtime.getSnapshot().persistence.dirty).toBe(true);
});
```

Extend the concrete memory-store test controls with `deferWorkingWrites`, `waitForActiveMutation`, `releaseNextMutation`, `activeMutationCount`, and `mutationOrder`; keep these controls test-only and outside `SaveStore`.

- [ ] **Step 2: Run tests and confirm failure**

Run: `bunx vitest run --project runtime tests/runtime/persistenceCoordinator.test.ts`

Expected: FAIL because working save is not implemented.

- [ ] **Step 3: Implement a correct FIFO tail**

```ts
const cityTails = new Map<string, Promise<void>>();

function enqueueCityPersistence<T>(
  cityId: string,
  work: () => Promise<T>,
): Promise<T> {
  const previous = cityTails.get(cityId) ?? Promise.resolve();
  const run = previous.then(work, work);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  cityTails.set(cityId, tail);
  return run.finally(() => {
    if (cityTails.get(cityId) === tail) cityTails.delete(cityId);
  });
}
```

- [ ] **Step 4: Implement working save at FIFO head**

Recheck active city/session, set status, call `snapshotForSave` through the typed serializer, build an envelope using injected `now`/`appVersion`, release gameplay ordering, then call `writeWorkingSave`. Apply `lastSavedAt` and `persistedRevision = Math.max(...)` only when city/session still match. Stale completion returns `superseded` and does not change current status/error.

- [ ] **Step 5: Add clean-save and dead-runtime tests**

A clean save still writes and refreshes `lastSavedAt`. A dead runtime returns `runtimeUnavailable` and never calls `snapshotForSave`.

- [ ] **Step 6: Run tests and commit**

```bash
bunx vitest run --project runtime tests/runtime/persistenceCoordinator.test.ts
git add src/runtime/persistenceCoordinator.ts src/runtime/createGameRuntime.ts tests/runtime/persistenceCoordinator.test.ts
git commit -m "feat: coordinate working saves"
```

---

### Task 5: Add checkpoint/autosave writes and active rename to the FIFO

**Files:**
- Modify: `src/runtime/persistenceCoordinator.ts`
- Modify: `src/runtime/createGameRuntime.ts`
- Modify: `tests/runtime/persistenceCoordinator.test.ts`

**Interfaces:**
- Implements `runGameplayWrite` and `renameActiveCity`.

- [ ] **Step 1: Add failing cross-kind FIFO tests**

```ts
it("serializes working, checkpoint, autosave, and rename", async () => {
  const harness = await createCoordinatorHarness();
  harness.store.deferAllMutations();
  const results = [
    harness.runtime.persistence.saveWorking(),
    harness.runtime.persistence.runGameplayWrite(checkpointRequest()),
    harness.runtime.persistence.runGameplayWrite(autosaveRequest()),
    harness.runtime.persistence.renameActiveCity("Renamed"),
  ];
  await harness.store.releaseAllMutations();
  await Promise.all(results);
  expect(harness.store.mutationKinds()).toEqual([
    "working",
    "checkpoint",
    "autosave",
    "rename",
  ]);
});

it.each(["checkpoint", "autosave"] as const)(
  "%s completion does not clear working dirty state",
  async (kind) => {
    const harness = await createCoordinatorHarness();
    await harness.runtime.debugSetBudget(50_000);
    const before = harness.runtime.getSnapshot().persistence;
    const result = await harness.runtime.persistence.runGameplayWrite(
      generationRequest(kind),
    );
    expect(result.status).toBe("completed");
    const after = harness.runtime.getSnapshot().persistence;
    expect(after.dirty).toBe(before.dirty);
    expect(after.lastSavedAt).toBe(before.lastSavedAt);
  },
);
```

Add the named request builders from the Test Harness Contract. Each request callback delegates to `writeCheckpoint` or `writeAutosave` with deterministic IDs/generation values.

- [ ] **Step 2: Run tests and confirm failure**

Run: `bunx vitest run --project runtime tests/runtime/persistenceCoordinator.test.ts`

Expected: FAIL for generation/rename operations.

- [ ] **Step 3: Implement `runGameplayWrite`**

Accept only `checkpoint` or `autosave`. Own active-city check, FIFO admission, canonical capture, status kind, and session supersession. Pass only `{ city, envelope }` to the workflow callback. Never modify working revision or `lastSavedAt` on success.

- [ ] **Step 4: Implement rename against live runtime state**

Call `store.renameCity` at FIFO head. On matching completion, change only `activeCity.name` and publish using current `state`/`ui`; do not replay captured state. Return `superseded` after a lineage change.

- [ ] **Step 5: Run tests and commit**

```bash
bunx vitest run --project runtime tests/runtime/persistenceCoordinator.test.ts
git add src/runtime/persistenceCoordinator.ts src/runtime/createGameRuntime.ts tests/runtime/persistenceCoordinator.test.ts
git commit -m "feat: serialize city persistence mutations"
```

---

### Task 6: Implement source-aware loads and one atomic restored-state commit

**Files:**
- Modify: `src/runtime/persistenceCoordinator.ts`
- Modify: `src/runtime/createGameRuntime.ts`
- Modify: `tests/runtime/persistenceCoordinator.test.ts`
- Modify: `tests/runtime/gameRuntime.test.ts`

**Interfaces:**
- Implements `load(source)`.

- [ ] **Step 1: Add failing load tests**

```ts
it("preserves the current runtime when header inspection fails", async () => {
  const harness = await createCoordinatorHarness();
  harness.store.seedRawWorking("other", { format: "broken" });
  const before = harness.runtime.getSnapshot();
  const result = await harness.runtime.persistence.load({
    kind: "working",
    cityId: "other",
  });
  expect(result.status).toBe("failed");
  expect(harness.runtime.getSnapshot()).toEqual(before);
});

it("loads a checkpoint paused, dirty, and in one publication", async () => {
  const harness = await createCoordinatorHarness();
  const publications: RuntimeSnapshot[] = [];
  const unsubscribe = harness.runtime.subscribe((value) => publications.push(value));
  const result = await harness.runtime.persistence.load({
    kind: "checkpoint",
    cityId: "city-1",
    checkpointId: "checkpoint-1",
  });
  unsubscribe();
  expect(result.status).toBe("completed");
  expect(harness.runtime.getSnapshot().state.paused).toBe(true);
  expect(harness.runtime.getSnapshot().persistence.dirty).toBe(true);
  expect(publications).toHaveLength(1);
});
```

Add a delayed two-load test proving only the later request restores.

- [ ] **Step 2: Run tests and confirm failure**

Run: `bunx vitest run --project runtime tests/runtime/persistenceCoordinator.test.ts`

Expected: FAIL for load operations.

- [ ] **Step 3: Implement read/inspection outside gameplay ordering**

Select the store read method from `LoadSource`, call `inspectSaveEnvelope`, and map non-candidate compatibility through `compatibilityToEnvelopeError`.

- [ ] **Step 4: Restore and commit atomically**

At typed queue head recheck the load token, call `restoreSnapshot`, then invoke one helper that calls `normalizeRustSnapshot` from `src/runtime/snapshotView.ts`, replaces UI with `createUiState()`, clears previews/gestures/drafts/notices/rejections/transient errors, updates identity/session/revisions, and publishes once.

- [ ] **Step 5: Apply source dirty semantics**

Working load becomes clean. Checkpoint/autosave load remains dirty. All restored snapshots remain paused.

- [ ] **Step 6: Run tests and commit**

```bash
bunx vitest run --project runtime tests/runtime/persistenceCoordinator.test.ts tests/runtime/gameRuntime.test.ts
git add src/runtime/persistenceCoordinator.ts src/runtime/createGameRuntime.ts tests/runtime
git commit -m "feat: restore cities through persistence coordinator"
```

---

### Task 7: Implement reset, detach, and active-delete guards

**Files:**
- Modify: `src/runtime/persistenceCoordinator.ts`
- Modify: `src/runtime/createGameRuntime.ts`
- Modify: `tests/runtime/gameRuntime.test.ts`
- Modify: `tests/runtime/persistenceCoordinator.test.ts`

- [ ] **Step 1: Add failing lifecycle tests**

```ts
it("reset preserves identity but starts a dirty new lineage", async () => {
  const backend = backendSpy();
  const runtime = await createGameRuntime({
    backend,
    saveStore: createMemorySaveStore(),
    initialCity: cityIdentity(),
    now: () => "2026-08-01T10:00:00.000Z",
    appVersion: "0.1.0",
  });
  const identity = runtime.getSnapshot().persistence.activeCity;
  await runtime.reset();
  expect(runtime.getSnapshot().persistence.activeCity).toEqual(identity);
  expect(runtime.getSnapshot().persistence.dirty).toBe(true);
});

it("detach supersedes an in-flight save and removes the target", async () => {
  const harness = await createCoordinatorHarness();
  harness.store.deferWorkingWrites();
  const save = harness.runtime.persistence.saveWorking();
  expect(harness.runtime.persistence.detachActiveCity().status).toBe("completed");
  harness.store.releaseNextMutation();
  expect((await save).status).toBe("superseded");
  expect(harness.runtime.getSnapshot().persistence.activeCity).toBeNull();
});
```

- [ ] **Step 2: Run tests and confirm failure**

Run: `bunx vitest run --project runtime tests/runtime/gameRuntime.test.ts tests/runtime/persistenceCoordinator.test.ts`

Expected: FAIL for lifecycle transitions.

- [ ] **Step 3: Implement reset lineage and detach**

Reset advances session, clears transient UI, keeps identity, establishes dirty baseline, and leaves working save metadata unchanged. Detach advances session, clears identity/status/error/save target, preserves detached gameplay state, and publishes once.

- [ ] **Step 4: Add active-delete guard**

Expose a pure coordinator check that returns `activeCityDeleteRequiresTransition` when the requested city matches the live active identity. Store deletion remains HPA-346.

- [ ] **Step 5: Run tests and commit**

```bash
bunx vitest run --project runtime tests/runtime/gameRuntime.test.ts tests/runtime/persistenceCoordinator.test.ts
git add src/runtime/persistenceCoordinator.ts src/runtime/createGameRuntime.ts tests/runtime
git commit -m "feat: add persistence lifecycle transitions"
```

---

### Task 8: Implement foreground New City activation and exact rollback

**Files:**
- Modify: `src/runtime/persistenceCoordinator.ts`
- Modify: `src/runtime/createGameRuntime.ts`
- Modify: `tests/runtime/persistenceCoordinator.test.ts`
- Modify: `tests/runtime/gameRuntime.test.ts`

- [ ] **Step 1: Add failing success, admission, rollback, and fatal tests**

```ts
it("restores a previously clean city exactly after initial write failure", async () => {
  const harness = await createCoordinatorHarness({ clean: true });
  const before = harness.runtime.getSnapshot();
  harness.failures.failNext("writeWorkingSave", "quotaExceeded");
  const result = await harness.runtime.persistence.activateNewCity(
    sandboxRequest(),
    newCityIdentity(),
  );
  expect(result.status).toBe("failed");
  expect(harness.runtime.getSnapshot()).toEqual(before);
});

it("drops ticks while foreground creation owns admission", async () => {
  const harness = await createCoordinatorHarness();
  harness.store.deferWorkingWrites();
  const creation = harness.runtime.persistence.activateNewCity(
    sandboxRequest(),
    newCityIdentity(),
  );
  await harness.store.waitForActiveMutation();
  const before = harness.runtime.getSnapshot();
  expect(await harness.runtime.tick(1)).toEqual(before);
  expect(harness.backend.tickCalls).toBe(0);
  harness.store.releaseNextMutation();
  await creation;
});
```

Add tests for successful clean paused activation, backend-dispatch no-op/no backlog, rollback restore failure, and pause-state restoration failure.

- [ ] **Step 2: Run tests and confirm failure**

Run: `bunx vitest run --project runtime tests/runtime/persistenceCoordinator.test.ts tests/runtime/gameRuntime.test.ts`

Expected: FAIL for New City lifecycle.

- [ ] **Step 3: Suspend backend-mutating admission**

Drain existing gameplay queue, then close backend-mutating admission. While closed, `tick` and backend-dispatching controller methods return the current snapshot immediately and are not queued. Local lifecycle status may publish.

- [ ] **Step 4: Capture exact rollback state**

Capture prior canonical save snapshot, raw running/paused state, active identity, session/revisions, `lastSavedAt`, statuses, persistence error, runtime state, and UI before calling `createSandbox`.

- [ ] **Step 5: Commit candidate only after storage**

Call `createSandbox`, call `snapshotForSave`, write initial working envelope, then bind/publish one clean paused city. Keep admission closed through the write.

- [ ] **Step 6: Roll back without ordinary dirty accounting**

Restore prior snapshot, restore running/paused state, restore every captured field exactly, and reopen admission. Publish no candidate intermediate state.

- [ ] **Step 7: Make rollback failure fatal**

Invoke fatal backend handling, invalidate session, clear active identity/save target, reset persistence activity, stop runtime, and make later persistence calls return `runtimeUnavailable`.

- [ ] **Step 8: Run tests and commit**

```bash
bunx vitest run --project runtime tests/runtime/persistenceCoordinator.test.ts tests/runtime/gameRuntime.test.ts
git add src/runtime/persistenceCoordinator.ts src/runtime/createGameRuntime.ts tests/runtime
git commit -m "feat: add transactional new city activation"
```

---

### Task 9: Final verification and adapter handoff

**Files:**
- Modify: `tests/runtime/persistenceCoordinator.test.ts`
- Modify: `tests/runtime/gameRuntime.test.ts`

- [ ] **Step 1: Add final catalogue tests**

Ensure named cases exist for all three operation outcomes, dead runtime before/after enqueue, defensive monotonic completion, all four FIFO mutation kinds, generation dirty isolation, all three load sources, detached startup, reset, active-delete guard, exact rollback, and fatal rollback.

- [ ] **Step 2: Search for prohibited save sources and frame-path calls**

```bash
rg 'JSON\.stringify\(.*state|RuntimeSnapshot.*write|normalizeRustSnapshot.*save' src/runtime
rg 'snapshotForSave' src/runtime
rg 'requestAnimationFrame' src/runtime/createGameRuntime.ts
```

Expected: all gameplay-bearing writes use backend capture; no normalized state is serialized; save capture is not called from the animation-frame callback.

- [ ] **Step 3: Run focused verification**

```bash
bunx vitest run --project runtime tests/runtime/persistenceCoordinator.test.ts
bunx vitest run --project runtime tests/runtime/gameRuntime.test.ts
```

Expected: both commands exit 0.

- [ ] **Step 4: Run full verification**

```bash
cargo test --workspace
bun run check
bun run format:check
bunx vitest run --project runtime
bun run test
bun run build
```

Expected: every command exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/runtime tests/runtime tests/fixtures/rustSnapshot.ts
git commit -m "test: verify runtime persistence coordination"
```

---

## HPA-499 Completion Gate

- [ ] Coordinator operations return only `completed | failed | superseded`.
- [ ] Dead runtime returns typed `runtimeUnavailable`; gameplay queue behavior is unchanged.
- [ ] Existing mutation paths account for dirty revisions exactly once.
- [ ] Working/checkpoint/autosave/rename share one FIFO per city.
- [ ] Generation writes never update working persistence baseline or save time.
- [ ] Loads inspect, restore, normalize, clear transients, publish once, and enter paused.
- [ ] Working load is clean; generation loads are dirty.
- [ ] Reset/detach invalidate stale work correctly.
- [ ] New City either commits cleanly or restores exact prior lineage.
- [ ] Rollback failure enters fatal unavailable state.
- [ ] Full Rust, TypeScript, runtime, and build verification exits 0.
