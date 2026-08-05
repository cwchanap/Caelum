# Runtime Persistence Coordinator Implementation Plan

> **SUPERSEDED — historical record only. DO NOT IMPLEMENT THIS PLAN.**
>
> The design this plan implements was reversed on 2026-08-05. It builds
> `SharedPersistenceCoordinator` with exclusive leases, per-city FIFO queues,
> reference-counted city fences, storage identity, and session/load/revision
> tokens — machinery that defends against a multi-runtime scenario production
> never creates, since `src/main.ts` mounts exactly one runtime.
>
> The replacement is **HPA-543**: active-city identity, one `persistenceBusy`
> gate, and one dirty boolean, in a focused `workingSaveRuntime.ts`. Candidate-first
> construction and storage-first New City carried over from this design and are
> the reason leases, rollback, and supersession are unnecessary rather than merely
> removed. Work HPA-543 instead, and see `CLAUDE.md` for the current contract.

**Issue:** HPA-499 (superseded by HPA-543)  
**Depends on:** HPA-498 (superseded by HPA-548)  
**Design source:** HPA-342 draft design PR #21 — superseded, see `docs/superpowers/specs/2026-07-31-save-envelope-store-runtime-persistence-design.md`  
**Status:** Implemented, then superseded 2026-08-05. The resulting `src/runtime/persistenceCoordinator.ts` is deleted by HPA-543; it was never reachable from `src/main.ts`.  
**Consumed by:** HPA-345, HPA-346, HPA-351, HPA-352  
**Execution order:** Implement after HPA-498.

**Goal:** Implement HPA-499’s typed persistence coordinator, dirty/session tracking, one per-city persistence FIFO, source-aware loading, and transactional New City activation without changing existing gameplay semantics.

**Architecture:** `createGameRuntime` remains the only owner of frontend runtime state. A focused `SerializedQueue` module preserves the existing gameplay ordering while allowing typed dead/error outcomes. The persistence coordinator uses HPA-498’s `SaveStore`; all active-city persistence mutations enter one city FIFO, and gameplay-bearing writes briefly enter `SerializedQueue` for canonical Rust capture before storage I/O. Foreground New City is the sole admission-reserving storage transaction.

**Tech Stack:** TypeScript 5.8, Vitest runtime project, Bun, `GameBackend`, `normalizeRustSnapshot` from `src/runtime/snapshotView.ts`, `createUiState`, HPA-498 persistence modules.

## Global Constraints

- HPA-498 lands first; runtime code imports its envelope/store types.
- Every gameplay-bearing write uses `backend.snapshotForSave()`; every load uses `backend.restoreSnapshot()`.
- `RuntimeSnapshot.state` and normalized `GameState` are never save payloads.
- Existing gameplay `queueBackend` behavior remains unchanged, including resolving the last snapshot after fatal death.
- Persistence work on a dead runtime returns typed `runtimeUnavailable`.
- Every coordinator call returns `completed | failed | superseded`.
- Working saves, checkpoints, autosaves, and active rename share one FIFO per city.
- Only working-save success changes `persistedRevision` and `lastSavedAt`.
- Loads inspect first, restore through Rust, normalize in one commit, clear transient UI, and enter paused.
- Foreground New City drops ticks and no-ops backend mutations instead of buffering them.
- Rollback restores exact backend/runtime/bookkeeping state; rollback failure is fatal.
- No frontend-only timeout is added over uncancellable storage.
- Until HPA-343/HPA-344 compose a production adapter, `saveStore` is optional and storage-backed calls return typed `unavailable` failures.

---

## File Map

**Create**

- `src/runtime/serializedQueue.ts` — typed serial execution with dead checks.
- `src/runtime/persistenceCoordinator.ts` — contracts and coordinator implementation.
- `tests/runtime/serializedQueue.test.ts` — queue ordering/death tests.
- `tests/runtime/persistenceCoordinator.test.ts` — coordinator tests.
- `tests/runtime/delayedSaveStore.ts` — test-only delegating store with deterministic deferred mutations.

**Modify**

- `src/runtime/types.ts`
- `src/runtime/createGameRuntime.ts`
- `tests/runtime/gameRuntime.test.ts`
- `tests/fixtures/rustSnapshot.ts`

**Reuse**

- `src/persistence/envelope.ts`
- `src/persistence/envelopeInspection.ts`
- `src/persistence/saveStore.ts`
- `src/persistence/memorySaveStore.ts`
- `src/runtime/backend/types.ts`
- `src/runtime/backend/persistenceContract.ts`
- `src/runtime/snapshotView.ts`
- `src/ui/uiState.ts`

## Shared Test Harness

`tests/runtime/persistenceCoordinator.test.ts` defines:

```ts
interface CoordinatorHarness {
  runtime: RuntimeController;
  backend: GameBackend & {
    snapshotForSaveCalls: number;
    restoreSnapshotCalls: number;
    tickCalls: number;
  };
  store: DelayedSaveStore;
  failures: MemorySaveStoreFailureControls;
}

async function createCoordinatorHarness(options?: {
  activeCity?: ActiveCityIdentity | null;
  clean?: boolean;
}): Promise<CoordinatorHarness>;

function cityIdentity(id?: string): ActiveCityIdentity;
function sandboxRequest(): SandboxCreationRequest;
function newCityIdentity(): NewCityIdentity;
function checkpointRequest(): GameplayWriteRequest<CheckpointSummary>;
function autosaveRequest(): GameplayWriteRequest<AutosaveSummary>;
```

`tests/runtime/delayedSaveStore.ts` delegates every `SaveStore` method to a wrapped store and exposes only test controls:

```ts
export interface DelayedSaveStore extends SaveStore {
  defer(operation: SaveStoreOperation): void;
  waitForActive(operation: SaveStoreOperation): Promise<void>;
  releaseNext(operation: SaveStoreOperation): void;
  releaseAll(): void;
  activeCount(): number;
  mutationOrder(): SaveStoreOperation[];
}

export function createDelayedSaveStore(delegate: SaveStore): DelayedSaveStore;
```

The wrapper records mutation calls, blocks selected operations before delegating, and never changes production `MemorySaveStore` APIs.

---

### Task 1: Define coordinator result, error, and public-view contracts

**Files:**
- Create: `src/runtime/persistenceCoordinator.ts`
- Create: `tests/runtime/persistenceCoordinator.test.ts`
- Modify: `tests/fixtures/rustSnapshot.ts`

**Interfaces:**
- Produces: `PersistenceOperationResult<T>`, operation/precondition unions, value types, `RuntimePersistenceView`, `RuntimePersistenceController`, `GameplayWriteRequest<T>`.

- [ ] **Step 1: Write failing catalogue tests**

```ts
it("represents supersession without a runtime error", () => {
  const result: PersistenceOperationResult<{ savedAt: string }> = {
    status: "superseded",
  };
  expect(result.status).toBe("superseded");
});

it("creates a typed unavailable result", () => {
  expect(runtimeUnavailable("saveWorking")).toEqual({
    status: "failed",
    error: {
      kind: "precondition",
      error: { code: "runtimeUnavailable", operation: "saveWorking" },
    },
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `bunx vitest run --project runtime tests/runtime/persistenceCoordinator.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Define the closed result contract**

```ts
export type PersistenceOperationResult<T> =
  | { status: "completed"; value: T }
  | { status: "failed"; error: PersistenceCoordinatorError }
  | { status: "superseded" };

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
```

Define `noActiveCity` for all four write operations, `activeCityDeleteRequiresTransition`, and `runtimeUnavailable` for every operation.

- [ ] **Step 4: Define the controller and view interfaces**

```ts
export interface RuntimePersistenceController {
  saveWorking(): Promise<PersistenceOperationResult<SaveWorkingValue>>;
  renameActiveCity(name: string): Promise<PersistenceOperationResult<RenameActiveCityValue>>;
  load(source: LoadSource): Promise<PersistenceOperationResult<LoadCityValue>>;
  detachActiveCity(): Promise<PersistenceOperationResult<RuntimeSnapshot>>;
  activateNewCity(
    request: SandboxCreationRequest,
    identity: NewCityIdentity,
  ): Promise<PersistenceOperationResult<LoadCityValue>>;
  runGameplayWrite<TSummary>(
    request: GameplayWriteRequest<TSummary>,
  ): Promise<PersistenceOperationResult<GenerationWriteValue<TSummary>>>;
}

export interface RuntimePersistenceView {
  activeCity: ActiveCityIdentity | null;
  dirty: boolean;
  saveStatus: RuntimeSaveStatus;
  loadStatus: RuntimeLoadStatus;
  lifecycleStatus: RuntimeLifecycleStatus;
  lastSavedAt: string | null;
  error: PersistenceCoordinatorError | null;
}
```

- [ ] **Step 5: Instrument backend fixtures**

Extend `previewBackendStubs()` with deterministic counters while preserving existing successful results:

```ts
export interface PersistenceBackendCounters {
  snapshotForSaveCalls: number;
  restoreSnapshotCalls: number;
  tickCalls: number;
}
```

Provide a helper returning `{ backend, counters }`; do not change existing callers of `previewBackendStubs()`.

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

### Task 2: Implement and verify the typed serialized queue

**Files:**
- Create: `src/runtime/serializedQueue.ts`
- Create: `tests/runtime/serializedQueue.test.ts`
- Modify: `src/runtime/createGameRuntime.ts`
- Modify: `tests/runtime/gameRuntime.test.ts`

**Interfaces:**
- Produces: `createSerializedQueue(isDead)` with `enqueue<T>()` and `drain()`.

- [ ] **Step 1: Write failing queue tests**

```ts
it("runs operations in enqueue order", async () => {
  let dead = false;
  const queue = createSerializedQueue(() => dead);
  const order: number[] = [];
  const first = queue.enqueue({
    operation: async () => { order.push(1); return 1; },
    whenDead: () => -1,
    onThrown: () => -2,
  });
  const second = queue.enqueue({
    operation: async () => { order.push(2); return 2; },
    whenDead: () => -1,
    onThrown: () => -2,
  });
  expect(await Promise.all([first, second])).toEqual([1, 2]);
  expect(order).toEqual([1, 2]);
});

it("rechecks death when an operation reaches the head", async () => {
  let dead = false;
  const queue = createSerializedQueue(() => dead);
  let release!: () => void;
  const first = queue.enqueue({
    operation: () => new Promise<number>((resolve) => { release = () => resolve(1); }),
    whenDead: () => -1,
    onThrown: () => -2,
  });
  let secondCalls = 0;
  const second = queue.enqueue({
    operation: async () => { secondCalls += 1; return 2; },
    whenDead: () => -1,
    onThrown: () => -2,
  });
  dead = true;
  release();
  expect(await first).toBe(1);
  expect(await second).toBe(-1);
  expect(secondCalls).toBe(0);
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `bunx vitest run --project runtime tests/runtime/serializedQueue.test.ts`

Expected: FAIL because `serializedQueue.ts` does not exist.

- [ ] **Step 3: Implement the queue**

```ts
export function createSerializedQueue(isDead: () => boolean) {
  let tail: Promise<void> = Promise.resolve();
  return {
    enqueue<T>(options: {
      operation: () => Promise<T>;
      whenDead: () => T;
      onThrown: (error: unknown) => T;
    }): Promise<T> {
      if (isDead()) return Promise.resolve(options.whenDead());
      const run = tail.then(async () => {
        if (isDead()) return options.whenDead();
        try {
          return await options.operation();
        } catch (error: unknown) {
          return options.onThrown(error);
        }
      });
      tail = run.then(() => undefined, () => undefined);
      return run;
    },
    drain(): Promise<void> {
      return tail;
    },
  };
}
```

- [ ] **Step 4: Replace local queue chaining without changing gameplay behavior**

Instantiate one queue in `createGameRuntime`. Rewrite `queueBackend` as a wrapper using `whenDead: getSnapshot` and `onThrown: failBackend`. Add a regression test using the existing `deferredDispatchBackend` proving a queued gameplay call after fatal failure resolves the last snapshot and does not invoke the backend.

- [ ] **Step 5: Run tests and typecheck**

```bash
bunx vitest run --project runtime tests/runtime/serializedQueue.test.ts
bunx vitest run --project runtime tests/runtime/gameRuntime.test.ts
bun run check
```

Expected: all commands exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/serializedQueue.ts src/runtime/createGameRuntime.ts tests/runtime/serializedQueue.test.ts tests/runtime/gameRuntime.test.ts
git commit -m "refactor: extract typed runtime serialization"
```

---

### Task 3: Integrate persistence view, optional store composition, and revision accounting

**Files:**
- Modify: `src/runtime/types.ts`
- Modify: `src/runtime/createGameRuntime.ts`
- Create: `tests/runtime/delayedSaveStore.ts`
- Modify: `tests/runtime/persistenceCoordinator.test.ts`
- Modify: `tests/runtime/gameRuntime.test.ts`

**Interfaces:**
- Adds `RuntimeSnapshot.persistence`, `RuntimeController.persistence`, and runtime options `saveStore?`, `now?`, `appVersion?`, `initialCity?`, `lastSavedAt?`.

- [ ] **Step 1: Write failing dirty-state tests**

```ts
it("marks applied gameplay dirty but not UI changes", async () => {
  const runtime = await createGameRuntime({
    backend: backendSpy(),
    saveStore: createMemorySaveStore(),
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

Add named tests for applied tick, route-draft save, reset, previews, rejected dispatch, no-op dispatch, and detached startup.

- [ ] **Step 2: Run and confirm failure**

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
```

Add `persistence: getPersistenceView()` to every runtime snapshot. Factor one `commitDispatchResult` used by dispatch, tick, route-draft save, and debug dispatch; increment revision once when `applied` is true.

- [ ] **Step 4: Implement optional store composition**

When no store is provided, storage-backed controller methods return:

```ts
{
  status: "failed",
  error: {
    kind: "store",
    error: {
      operation: "writeWorkingSave",
      code: "unavailable",
      retryable: true,
      diagnostic: "No SaveStore is configured",
    },
  },
}
```

Use the matching `SaveStoreOperation` for each method. Runtime startup/build remains unchanged.

- [ ] **Step 5: Implement the delayed test wrapper**

`createDelayedSaveStore(delegate)` stores one deferred gate queue per operation, records mutation order, and delegates immediately for operations not marked deferred. Its methods preserve exact `SaveStore` return types.

- [ ] **Step 6: Complete `createCoordinatorHarness`**

Compose the instrumented backend, memory store wrapped by `DelayedSaveStore`, deterministic clock/version, and initial identity. Return the exact Shared Test Harness shape.

- [ ] **Step 7: Run tests and typecheck**

```bash
bunx vitest run --project runtime tests/runtime/gameRuntime.test.ts tests/runtime/persistenceCoordinator.test.ts
bun run check
```

Expected: all commands exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/runtime/types.ts src/runtime/createGameRuntime.ts tests/runtime tests/fixtures/rustSnapshot.ts
git commit -m "feat: track runtime persistence state"
```

---

### Task 4: Implement the city FIFO and working save

**Files:**
- Modify: `src/runtime/persistenceCoordinator.ts`
- Modify: `src/runtime/createGameRuntime.ts`
- Modify: `tests/runtime/persistenceCoordinator.test.ts`

- [ ] **Step 1: Write failing FIFO and revision tests**

```ts
it("serializes two working saves", async () => {
  const harness = await createCoordinatorHarness();
  harness.store.defer("writeWorkingSave");
  const first = harness.runtime.persistence.saveWorking();
  const second = harness.runtime.persistence.saveWorking();
  await harness.store.waitForActive("writeWorkingSave");
  expect(harness.store.activeCount()).toBe(1);
  harness.store.releaseNext("writeWorkingSave");
  await first;
  await harness.store.waitForActive("writeWorkingSave");
  harness.store.releaseNext("writeWorkingSave");
  await second;
  expect(harness.store.mutationOrder()).toEqual([
    "writeWorkingSave",
    "writeWorkingSave",
  ]);
});
```

Add tests for mutation during save, clean explicit save, monotonic completion helper, dead runtime, and stale session.

- [ ] **Step 2: Run and confirm failure**

Run: `bunx vitest run --project runtime tests/runtime/persistenceCoordinator.test.ts`

Expected: FAIL because working save is not implemented.

- [ ] **Step 3: Implement the FIFO tail**

```ts
const cityTails = new Map<string, Promise<void>>();
function enqueueCityPersistence<T>(cityId: string, work: () => Promise<T>): Promise<T> {
  const previous = cityTails.get(cityId) ?? Promise.resolve();
  const run = previous.then(work, work);
  const tail = run.then(() => undefined, () => undefined);
  cityTails.set(cityId, tail);
  return run.finally(() => {
    if (cityTails.get(cityId) === tail) cityTails.delete(cityId);
  });
}
```

- [ ] **Step 4: Implement working save**

At FIFO head recheck active city/session, set status, call `snapshotForSave` through `SerializedQueue`, build the envelope, release gameplay ordering, then call `writeWorkingSave`. Update `lastSavedAt` and `persistedRevision = Math.max(...)` only for the same current city/session. Return `superseded` for stale completion.

- [ ] **Step 5: Run tests and commit**

```bash
bunx vitest run --project runtime tests/runtime/persistenceCoordinator.test.ts
git add src/runtime/persistenceCoordinator.ts src/runtime/createGameRuntime.ts tests/runtime/persistenceCoordinator.test.ts
git commit -m "feat: coordinate working saves"
```

---

### Task 5: Add checkpoint/autosave writes and active rename to the FIFO

**Files:**
- Modify: `src/runtime/persistenceCoordinator.ts`
- Modify: `tests/runtime/persistenceCoordinator.test.ts`

- [ ] **Step 1: Write failing cross-kind tests**

```ts
it("serializes every active-city persistence mutation", async () => {
  const harness = await createCoordinatorHarness();
  harness.store.defer("writeWorkingSave");
  harness.store.defer("writeCheckpoint");
  harness.store.defer("writeAutosave");
  harness.store.defer("renameCity");
  const results = [
    harness.runtime.persistence.saveWorking(),
    harness.runtime.persistence.runGameplayWrite(checkpointRequest()),
    harness.runtime.persistence.runGameplayWrite(autosaveRequest()),
    harness.runtime.persistence.renameActiveCity("Renamed"),
  ];
  for (const operation of [
    "writeWorkingSave",
    "writeCheckpoint",
    "writeAutosave",
    "renameCity",
  ] as const) {
    await harness.store.waitForActive(operation);
    harness.store.releaseNext(operation);
  }
  await Promise.all(results);
  expect(harness.store.mutationOrder()).toEqual([
    "writeWorkingSave",
    "writeCheckpoint",
    "writeAutosave",
    "renameCity",
  ]);
});
```

Add checkpoint/autosave dirty-isolation tests and rename-live-state/stale-session tests.

- [ ] **Step 2: Run and confirm failure**

Run: `bunx vitest run --project runtime tests/runtime/persistenceCoordinator.test.ts`

Expected: FAIL for generation/rename paths.

- [ ] **Step 3: Implement `runGameplayWrite`**

Accept only checkpoint/autosave kinds. Own active-city validation, FIFO admission, canonical capture, public status, and supersession. Pass only `{ city, envelope }` to the callback. Never update working persistence baseline or save time.

- [ ] **Step 4: Implement rename against live state**

Call `renameCity` at FIFO head. For a matching session, update only `activeCity.name` and publish with current state/UI. Return `superseded` after lineage changes.

- [ ] **Step 5: Run tests and commit**

```bash
bunx vitest run --project runtime tests/runtime/persistenceCoordinator.test.ts
git add src/runtime/persistenceCoordinator.ts tests/runtime/persistenceCoordinator.test.ts
git commit -m "feat: serialize city persistence mutations"
```

---

### Task 6: Implement source-aware load and atomic commit

**Files:**
- Modify: `src/runtime/persistenceCoordinator.ts`
- Modify: `src/runtime/createGameRuntime.ts`
- Modify: `tests/runtime/persistenceCoordinator.test.ts`
- Modify: `tests/runtime/gameRuntime.test.ts`

- [ ] **Step 1: Write failing load tests**

```ts
it("preserves runtime on inspection failure", async () => {
  const harness = await createCoordinatorHarness();
  harness.store.seedRawWorking("other", { format: "broken" });
  const before = harness.runtime.getSnapshot();
  const result = await harness.runtime.persistence.load({ kind: "working", cityId: "other" });
  expect(result.status).toBe("failed");
  expect(harness.runtime.getSnapshot()).toEqual(before);
});
```

Add tests for two-load supersession, restore failure, one publication, transient reset, working clean load, checkpoint/autosave dirty load, and paused state.

- [ ] **Step 2: Run and confirm failure**

Run: `bunx vitest run --project runtime tests/runtime/persistenceCoordinator.test.ts`

Expected: FAIL for load paths.

- [ ] **Step 3: Implement read and inspection outside gameplay ordering**

Choose the read method from `LoadSource`, call `inspectSaveEnvelope`, and map failures through `compatibilityToEnvelopeError`.

- [ ] **Step 4: Restore and commit once**

At serialized queue head recheck request token, call `restoreSnapshot`, then call a runtime helper that invokes `normalizeRustSnapshot`, uses `createUiState`, clears previews/drafts/gestures/notices/rejections/transient errors, updates identity/session/revisions, and publishes once.

- [ ] **Step 5: Run tests and commit**

```bash
bunx vitest run --project runtime tests/runtime/persistenceCoordinator.test.ts tests/runtime/gameRuntime.test.ts
git add src/runtime/persistenceCoordinator.ts src/runtime/createGameRuntime.ts tests/runtime
git commit -m "feat: restore cities through persistence coordinator"
```

---

### Task 7: Implement reset, detach, and active-delete guard

**Files:**
- Modify: `src/runtime/persistenceCoordinator.ts`
- Modify: `src/runtime/createGameRuntime.ts`
- Modify: `tests/runtime/persistenceCoordinator.test.ts`
- Modify: `tests/runtime/gameRuntime.test.ts`

- [ ] **Step 1: Write failing lifecycle tests**

```ts
it("reset preserves identity and becomes dirty", async () => {
  const harness = await createCoordinatorHarness();
  const identity = harness.runtime.getSnapshot().persistence.activeCity;
  await harness.runtime.reset();
  expect(harness.runtime.getSnapshot().persistence.activeCity).toEqual(identity);
  expect(harness.runtime.getSnapshot().persistence.dirty).toBe(true);
});
```

Add detach supersession and active-delete precondition tests.

- [ ] **Step 2: Run and confirm failure**

Run: `bunx vitest run --project runtime tests/runtime/persistenceCoordinator.test.ts tests/runtime/gameRuntime.test.ts`

Expected: FAIL for lifecycle paths.

- [ ] **Step 3: Implement transitions**

Reset advances lineage, clears transients, keeps identity, and establishes dirty baseline. Detach advances lineage, clears identity/status/error/save target, and publishes once. Add a pure delete guard returning `activeCityDeleteRequiresTransition` for the active city.

- [ ] **Step 4: Run tests and commit**

```bash
bunx vitest run --project runtime tests/runtime/persistenceCoordinator.test.ts tests/runtime/gameRuntime.test.ts
git add src/runtime/persistenceCoordinator.ts src/runtime/createGameRuntime.ts tests/runtime
git commit -m "feat: add persistence lifecycle transitions"
```

---

### Task 8: Implement transactional New City activation and exact rollback

**Files:**
- Modify: `src/runtime/persistenceCoordinator.ts`
- Modify: `src/runtime/createGameRuntime.ts`
- Modify: `tests/runtime/persistenceCoordinator.test.ts`
- Modify: `tests/runtime/gameRuntime.test.ts`

- [ ] **Step 1: Write failing transaction tests**

```ts
it("restores a clean prior city exactly after write failure", async () => {
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
```

Add successful activation, dropped tick, no-op dispatch, no backlog, rollback restore failure, and pause restoration failure tests.

- [ ] **Step 2: Run and confirm failure**

Run: `bunx vitest run --project runtime tests/runtime/persistenceCoordinator.test.ts tests/runtime/gameRuntime.test.ts`

Expected: FAIL for New City paths.

- [ ] **Step 3: Suspend admission after draining the serialized queue**

Use `queue.drain()`, then close backend-mutating admission. While closed, ticks and backend-dispatching controller methods return the unchanged current snapshot immediately and never enter the queue.

- [ ] **Step 4: Capture, create, and commit**

Capture prior canonical save snapshot, raw running/paused state, identity, session/revisions, save time, statuses, persistence error, state, and UI. Call `createSandbox`, capture the candidate with `snapshotForSave`, write the initial envelope, then publish one clean paused city.

- [ ] **Step 5: Roll back exactly or fail fatally**

On write failure, restore prior snapshot and running/paused state without dirty accounting, restore every captured field, and reopen admission. If either restoration fails, invoke fatal backend handling, invalidate lineage, clear active identity/save target, stop runtime, and make later persistence calls return `runtimeUnavailable`.

- [ ] **Step 6: Run tests and commit**

```bash
bunx vitest run --project runtime tests/runtime/persistenceCoordinator.test.ts tests/runtime/gameRuntime.test.ts
git add src/runtime/persistenceCoordinator.ts src/runtime/createGameRuntime.ts tests/runtime
git commit -m "feat: add transactional new city activation"
```

---

### Task 9: Final verification

**Files:**
- Modify: `tests/runtime/persistenceCoordinator.test.ts`
- Modify: `tests/runtime/gameRuntime.test.ts`

- [ ] **Step 1: Confirm named coverage**

The suite must contain named cases for all operation outcomes, death before/after enqueue, monotonic completion, four FIFO mutation kinds, generation dirty isolation, all load sources, detached startup, reset, active-delete guard, exact rollback, and fatal rollback.

- [ ] **Step 2: Search prohibited paths**

```bash
rg 'JSON\.stringify\(.*state|RuntimeSnapshot.*write|normalizeRustSnapshot.*save' src/runtime
rg 'snapshotForSave' src/runtime
rg 'requestAnimationFrame' src/runtime/createGameRuntime.ts
```

Expected: backend capture is the only gameplay save source, and capture is not called from the animation-frame callback.

- [ ] **Step 3: Run verification**

```bash
cargo test --workspace
bun run check
bun run format:check
bunx vitest run --project runtime
bun run test
bun run build
```

Expected: every command exits 0.

- [ ] **Step 4: Commit**

```bash
git add src/runtime tests/runtime tests/fixtures/rustSnapshot.ts
git commit -m "test: verify runtime persistence coordination"
```

---

## HPA-499 Completion Gate

- [ ] Coordinator operations return only `completed | failed | superseded`.
- [ ] Typed queue preserves gameplay behavior and returns `runtimeUnavailable` for persistence after death.
- [ ] Existing mutation paths account for dirty revisions exactly once.
- [ ] All active-city persistence mutations share one FIFO.
- [ ] Generation writes never change working baseline or save time.
- [ ] Loads restore through Rust, normalize once, clear transients, and enter paused.
- [ ] Reset/detach invalidate stale work.
- [ ] New City commits cleanly or restores exact prior lineage.
- [ ] Rollback failure enters fatal unavailable state.
- [ ] Full verification exits 0.
