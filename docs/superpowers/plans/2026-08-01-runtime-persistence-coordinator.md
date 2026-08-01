# Runtime Persistence Coordinator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement HPA-499’s typed persistence coordinator, runtime dirty/session tracking, per-city persistence FIFO, source-aware loading, and foreground New City rollback while preserving existing gameplay behavior.

**Architecture:** `createGameRuntime` remains the only owner of authoritative frontend runtime state. Extract the existing gameplay queue mechanics into a typed internal serializer, then layer a focused persistence coordinator over it. Normal saves briefly enter gameplay ordering for canonical Rust capture and release the gameplay queue during storage I/O; all active-city persistence mutations serialize through one per-city FIFO. Foreground New City is the sole admission-reserving transaction and either commits a clean city or restores the exact prior lineage.

**Tech Stack:** TypeScript 5.8, Vitest runtime project, existing `GameBackend`, `createGameRuntime`, `normalizeRustSnapshot`, `createUiState`, HPA-498 `SaveStore`, Bun.

## Global Constraints

- HPA-498 must be implemented first; do not redefine envelope/store types inside runtime code.
- Rust remains authoritative: every gameplay-bearing write uses `backend.snapshotForSave()`, and every load uses `backend.restoreSnapshot()`.
- Never serialize `RuntimeSnapshot.state` or normalized `GameState`.
- The existing `queueBackend` behavior for gameplay callers must remain unchanged, including dead-runtime resolution with the last `RuntimeSnapshot`.
- Persistence operations on a dead runtime return typed `runtimeUnavailable`; they never receive a wrong-shaped `RuntimeSnapshot`.
- All coordinator calls return `completed | failed | superseded`.
- Session/request/revision tokens remain coordinator-internal.
- Working save, checkpoint, autosave, and active rename share one per-city FIFO persistence queue.
- Only working-save success advances `persistedRevision` and `lastSavedAt`; checkpoint/autosave writes never clear dirty state.
- Successful working/checkpoint/autosave loads publish one normalized paused runtime snapshot.
- Foreground New City drops new ticks and treats new backend dispatch attempts as no-ops; it does not buffer a backlog.
- Rollback restores exact prior backend/runtime/bookkeeping state; rollback failure is fatal and clears the active save identity.
- Do not add a frontend-only timeout over uncancellable store writes.

---

## File Map

**Create**

- `src/runtime/persistenceCoordinator.ts` — operation/result types, internal tokens, per-city FIFO, save/load/rename/generation-write coordination.
- `tests/runtime/persistenceCoordinator.test.ts` — focused coordinator tests with delayed store/backend harnesses.

**Modify**

- `src/runtime/types.ts` — public persistence view and `RuntimeController` methods.
- `src/runtime/createGameRuntime.ts` — typed queue primitive, persistence state ownership, commit helpers, lifecycle transaction, controller integration.
- `src/runtime/runtimeSelectors.ts` only if shell-facing save state needs read-only selection; do not add presentation policy here.
- `tests/runtime/gameRuntime.test.ts` — integration coverage for existing mutation paths, dead runtime, loads, reset, and New City lifecycle.
- `src/main.ts` only to inject `SaveStore`, clock, and app version once application composition is required by the runtime constructor.

**Reuse**

- `src/persistence/envelope.ts`
- `src/persistence/envelopeInspection.ts`
- `src/persistence/saveStore.ts`
- `src/runtime/backend/types.ts`
- `src/runtime/backend/persistenceContract.ts`
- `src/runtime/backend/shared.ts` or the existing module exporting `normalizeRustSnapshot`
- `src/ui/uiState.ts::createUiState`

---

### Task 1: Define coordinator operation and public view types

**Files:**
- Create: `src/runtime/persistenceCoordinator.ts`
- Modify: `src/runtime/types.ts`
- Test: `tests/runtime/persistenceCoordinator.test.ts`

**Interfaces:**
- Consumes: HPA-498 summaries/errors and backend `PersistenceOperationError`.
- Produces: `PersistenceOperationResult<T>`, `PersistenceCoordinatorOperation`, `PersistenceCoordinatorError`, `RuntimePersistenceView`, `RuntimePersistenceController`, `RuntimeGameplayWriteCoordinator`.

- [ ] **Step 1: Write failing operation-catalogue tests**

```ts
import { describe, expect, it } from "vitest";
import type {
  PersistenceOperationResult,
  SaveWorkingValue,
} from "../../src/runtime/persistenceCoordinator";

function statusOf<T>(result: PersistenceOperationResult<T>): string {
  return result.status;
}

describe("PersistenceOperationResult", () => {
  it("keeps superseded separate from persistent errors", () => {
    const result: PersistenceOperationResult<SaveWorkingValue> = {
      status: "superseded",
    };
    expect(statusOf(result)).toBe("superseded");
  });
});
```

- [ ] **Step 2: Run focused test and confirm failure**

Run: `bunx vitest run --project runtime tests/runtime/persistenceCoordinator.test.ts`

Expected: FAIL because the coordinator module does not exist.

- [ ] **Step 3: Define exact closed result and error types**

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

Include the approved `noActiveCity`, `activeCityDeleteRequiresTransition`, and `runtimeUnavailable` precondition variants.

- [ ] **Step 4: Add the public persistence view to `RuntimeSnapshot`**

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
```

Add `persistence: RuntimePersistenceView` to `RuntimeSnapshot`. Keep tokens and revision counters out of public types.

- [ ] **Step 5: Run typecheck**

Run: `bun run check`

Expected: FAIL only at runtime snapshot construction sites that still omit `persistence`; those are addressed in later tasks.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/persistenceCoordinator.ts src/runtime/types.ts tests/runtime/persistenceCoordinator.test.ts
git commit -m "feat: define runtime persistence contracts"
```

---

### Task 2: Refactor the gameplay queue into a typed internal serializer

**Files:**
- Modify: `src/runtime/createGameRuntime.ts`
- Modify: `tests/runtime/gameRuntime.test.ts`
- Modify: `tests/runtime/persistenceCoordinator.test.ts`

**Interfaces:**
- Produces internal `enqueueSerialized<T>`; preserves public `queueBackend` behavior.

- [ ] **Step 1: Add regression tests for current gameplay behavior and typed dead outcomes**

```ts
it("keeps gameplay queueBackend returning the last RuntimeSnapshot after fatal death", async () => {
  const { runtime, backend } = await createRuntimeHarness();
  backend.failNextDispatch(new Error("fatal"));
  const failed = await runtime.togglePause();
  const afterDeath = await runtime.tick(1);
  expect(afterDeath).toBe(failed);
});

it("returns runtimeUnavailable for persistence work queued after death", async () => {
  const { runtime, backend } = await createRuntimeHarness();
  backend.failNextDispatch(new Error("fatal"));
  await runtime.togglePause();
  const result = await runtime.saveWorking();
  expect(result).toEqual({
    status: "failed",
    error: {
      kind: "precondition",
      error: { code: "runtimeUnavailable", operation: "saveWorking" },
    },
  });
  expect(backend.snapshotForSaveCalls).toBe(0);
});
```

- [ ] **Step 2: Run tests and confirm the persistence case fails**

Run: `bunx vitest run --project runtime tests/runtime/gameRuntime.test.ts tests/runtime/persistenceCoordinator.test.ts`

Expected: existing gameplay case passes; persistence case fails because no typed path exists.

- [ ] **Step 3: Extract `enqueueSerialized<T>` from `queueBackend`**

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

Then rewrite `queueBackend` as a wrapper that supplies `getSnapshot` and `failBackend`, preserving every existing caller result.

- [ ] **Step 4: Add a typed persistence serialization helper**

Map dead runtime to `runtimeUnavailable`. Map unexpected backend invocation errors to the HPA-341 host failure shape for the requested persistence operation; do not invent string-based errors.

- [ ] **Step 5: Run queue tests**

Run: `bunx vitest run --project runtime tests/runtime/gameRuntime.test.ts tests/runtime/persistenceCoordinator.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/createGameRuntime.ts tests/runtime/gameRuntime.test.ts tests/runtime/persistenceCoordinator.test.ts
git commit -m "refactor: generalize runtime serialization safely"
```

---

### Task 3: Add persistence state ownership and exact runtime commit helpers

**Files:**
- Modify: `src/runtime/createGameRuntime.ts`
- Modify: `src/runtime/types.ts`
- Modify: `tests/runtime/gameRuntime.test.ts`

**Interfaces:**
- Produces internal persistence state, `getPersistenceView()`, mutation commit helper, authoritative replacement helper.

- [ ] **Step 1: Add failing dirty-state coverage for all existing mutation paths**

Test ordinary dispatch, applied tick, route-draft save, reset, UI-only changes, preview/no-op/rejected dispatch.

```ts
it("marks dirty after route-draft save but not after UI-only edits", async () => {
  const { runtime } = await createRuntimeHarness({ activeCity: cityIdentity() });
  runtime.setTool("busRoute");
  expect(runtime.getSnapshot().persistence.dirty).toBe(false);
  await completeValidRouteDraft(runtime);
  expect(runtime.getSnapshot().persistence.dirty).toBe(true);
});
```

- [ ] **Step 2: Run test and confirm failure**

Run: `bunx vitest run --project runtime tests/runtime/gameRuntime.test.ts -t "dirty"`

Expected: FAIL because the runtime has no persistence view/revisions.

- [ ] **Step 3: Add internal state**

```ts
let activeCity: ActiveCityIdentity | null = options.activeCity ?? null;
let sessionToken = 0;
let currentRevision = 0;
let persistedRevision = 0;
let saveStatus: RuntimeSaveStatus = { state: "idle" };
let loadStatus: RuntimeLoadStatus = { state: "idle" };
let lifecycleStatus: RuntimeLifecycleStatus = { state: "idle" };
let lastSavedAt: string | null = options.lastSavedAt ?? null;
let persistenceError: PersistenceCoordinatorError | null = null;
```

`dirty` is always derived from revision inequality.

- [ ] **Step 4: Factor commit helpers**

Create one helper for normal backend dispatch/tick results that increments `currentRevision` only when `applied === true`, and one authoritative replacement helper for load/reset/New City that resets or restores lineage bookkeeping explicitly.

Every `RuntimeSnapshot` construction includes `persistence: getPersistenceView()`.

- [ ] **Step 5: Update uncommon mutation paths**

Route-draft save, reset, and debug mutation helpers must call the same normal mutation commit helper. UI-only functions continue committing without revision changes.

- [ ] **Step 6: Run focused and full runtime tests**

```bash
bunx vitest run --project runtime tests/runtime/gameRuntime.test.ts
bun run check
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/runtime/createGameRuntime.ts src/runtime/types.ts tests/runtime/gameRuntime.test.ts
git commit -m "feat: track runtime persistence revisions"
```

---

### Task 4: Implement the per-city persistence FIFO and working save

**Files:**
- Modify: `src/runtime/persistenceCoordinator.ts`
- Modify: `src/runtime/createGameRuntime.ts`
- Modify: `tests/runtime/persistenceCoordinator.test.ts`

**Interfaces:**
- Produces: per-city FIFO, `saveWorking`, working-save status, monotonic persisted-revision completion.

- [ ] **Step 1: Add delayed-store FIFO and mutation-during-save tests**

```ts
it("serializes active-city persistence requests by call order", async () => {
  const harness = await createCoordinatorHarness();
  harness.store.deferWrites();
  const first = harness.runtime.saveWorking();
  const second = harness.runtime.saveWorking();
  expect(harness.store.activeWriteCount()).toBe(1);
  harness.store.releaseNextWrite();
  await first;
  expect(harness.store.activeWriteCount()).toBe(1);
  harness.store.releaseNextWrite();
  await second;
  expect(harness.store.writeOrder()).toEqual(["working-1", "working-2"]);
});

it("clears dirty only through the captured revision", async () => {
  const harness = await createCoordinatorHarness();
  await harness.runtime.debugSetBudget(100_000);
  harness.store.deferWrites();
  const save = harness.runtime.saveWorking();
  await harness.waitForCapture();
  await harness.runtime.debugSetBudget(90_000);
  harness.store.releaseNextWrite();
  expect((await save).status).toBe("completed");
  expect(harness.runtime.getSnapshot().persistence.dirty).toBe(true);
});
```

- [ ] **Step 2: Run tests and confirm failure**

Run: `bunx vitest run --project runtime tests/runtime/persistenceCoordinator.test.ts`

Expected: FAIL because FIFO/save implementation is absent.

- [ ] **Step 3: Implement a private per-city promise tail**

```ts
const cityTails = new Map<string, Promise<void>>();

function enqueueCityPersistence<T>(cityId: string, work: () => Promise<T>): Promise<T> {
  const prior = cityTails.get(cityId) ?? Promise.resolve();
  const run = prior.then(work, work);
  cityTails.set(cityId, run.then(() => undefined, () => undefined));
  return run.finally(() => {
    if (cityTails.get(cityId) === run) cityTails.delete(cityId);
  });
}
```

Use a stable wrapper/tail identity so cleanup compares the actual stored tail, not `run` incorrectly.

- [ ] **Step 4: Implement `saveWorking`**

At FIFO head: verify city/session, set status, enter typed gameplay serialization, call `snapshotForSave`, build the envelope using injected `now`/`appVersion`, release gameplay queue, write store, then apply completion only if city/session still match.

Use `Math.max(persistedRevision, capturedRevision)`. A stale completion returns `superseded` and does not modify current error/status/time.

- [ ] **Step 5: Test clean explicit save**

A clean `saveWorking` still writes and refreshes `lastSavedAt`; autosave policy will decide whether to skip before entering this API.

- [ ] **Step 6: Run tests**

Run: `bunx vitest run --project runtime tests/runtime/persistenceCoordinator.test.ts`

Expected: PASS for working-save/FIFO cases.

- [ ] **Step 7: Commit**

```bash
git add src/runtime/persistenceCoordinator.ts src/runtime/createGameRuntime.ts tests/runtime/persistenceCoordinator.test.ts
git commit -m "feat: coordinate working saves"
```

---

### Task 5: Add generation writes and active-city rename to the shared FIFO

**Files:**
- Modify: `src/runtime/persistenceCoordinator.ts`
- Modify: `src/runtime/createGameRuntime.ts`
- Modify: `tests/runtime/persistenceCoordinator.test.ts`

**Interfaces:**
- Produces: `runGameplayWrite({ kind: "checkpoint" | "autosave" })`, `renameActiveCity`.

- [ ] **Step 1: Add cross-kind FIFO and dirty-isolation tests**

```ts
it("serializes working, checkpoint, autosave, and rename for one city", async () => {
  const harness = await createCoordinatorHarness();
  harness.store.deferAllMutations();
  const operations = [
    harness.runtime.saveWorking(),
    harness.coordinator.runGameplayWrite(checkpointRequest()),
    harness.coordinator.runGameplayWrite(autosaveRequest()),
    harness.runtime.renameActiveCity("Renamed"),
  ];
  await harness.releaseAllInOrder();
  await Promise.all(operations);
  expect(harness.store.mutationKinds()).toEqual([
    "working",
    "checkpoint",
    "autosave",
    "rename",
  ]);
});

it.each(["checkpoint", "autosave"] as const)(
  "%s success does not clear working dirty state",
  async (kind) => {
    const harness = await createCoordinatorHarness();
    await harness.runtime.debugSetBudget(50_000);
    const before = harness.runtime.getSnapshot().persistence;
    const result = await harness.coordinator.runGameplayWrite(generationRequest(kind));
    expect(result.status).toBe("completed");
    const after = harness.runtime.getSnapshot().persistence;
    expect(after.dirty).toBe(before.dirty);
    expect(after.lastSavedAt).toBe(before.lastSavedAt);
  },
);
```

- [ ] **Step 2: Run tests and confirm failure**

Run: `bunx vitest run --project runtime tests/runtime/persistenceCoordinator.test.ts`

Expected: FAIL for generation/rename paths.

- [ ] **Step 3: Implement `runGameplayWrite`**

Only accept `checkpoint` or `autosave`. Own active-city precondition, FIFO head capture, canonical envelope, status kind, session supersession, and typed result. The workflow callback receives only `{ city, envelope }`.

- [ ] **Step 4: Implement active rename**

At FIFO head call `store.renameCity`. On completion, update only the live active identity slice when city/session match. Use current `state` and `ui` when publishing; never replay a captured runtime snapshot.

- [ ] **Step 5: Run tests**

Run: `bunx vitest run --project runtime tests/runtime/persistenceCoordinator.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/persistenceCoordinator.ts src/runtime/createGameRuntime.ts tests/runtime/persistenceCoordinator.test.ts
git commit -m "feat: serialize city persistence mutations"
```

---

### Task 6: Implement source-aware load and atomic restored-state commit

**Files:**
- Modify: `src/runtime/persistenceCoordinator.ts`
- Modify: `src/runtime/createGameRuntime.ts`
- Modify: `tests/runtime/persistenceCoordinator.test.ts`
- Modify: `tests/runtime/gameRuntime.test.ts`

**Interfaces:**
- Produces: `load(source)`, preview/gesture invalidation helper, normalized authoritative replacement.

- [ ] **Step 1: Add load failure, supersession, paused-state, and UI reset tests**

```ts
it("keeps the current city unchanged when envelope inspection fails", async () => {
  const harness = await createCoordinatorHarness();
  harness.store.setWorkingRaw("other-city", { format: "broken" });
  const before = harness.runtime.getSnapshot();
  const result = await harness.runtime.load({ kind: "working", cityId: "other-city" });
  expect(result.status).toBe("failed");
  expect(harness.runtime.getSnapshot().state).toBe(before.state);
  expect(harness.runtime.getSnapshot().persistence.activeCity).toEqual(
    before.persistence.activeCity,
  );
});

it("loads a checkpoint paused and dirty with one publication", async () => {
  const harness = await createCoordinatorHarness();
  const publications: RuntimeSnapshot[] = [];
  const unsubscribe = harness.runtime.subscribe((snapshot) => publications.push(snapshot));
  const result = await harness.runtime.load({
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

- [ ] **Step 2: Run tests and confirm failure**

Run: `bunx vitest run --project runtime tests/runtime/persistenceCoordinator.test.ts tests/runtime/gameRuntime.test.ts`

Expected: FAIL for load behavior.

- [ ] **Step 3: Implement read and inspection outside gameplay queue**

Select `readWorkingSave`, `readCheckpoint`, or `readAutosave` from `LoadSource`. Convert non-candidate compatibility through the single HPA-498 mapping.

- [ ] **Step 4: Restore inside typed gameplay serialization**

Recheck load request token at queue head, call `backend.restoreSnapshot`, then pass the raw returned snapshot to one runtime commit helper that calls `normalizeRustSnapshot` internally.

- [ ] **Step 5: Reset all transient runtime/UI state atomically**

Clear hover timer, route/road preview coordinators, road mutation preview, route draft/history, gestures, selections, notices, gameplay rejection, sandbox reset error, transient backend/persistence errors. Replace UI with `createUiState()`. Update identity/session/revision baseline and publish once.

- [ ] **Step 6: Implement clean/dirty source distinction**

Working load resets clean baseline. Checkpoint/autosave load initializes dirty baseline. Every persisted load remains paused.

- [ ] **Step 7: Run tests**

```bash
bunx vitest run --project runtime tests/runtime/persistenceCoordinator.test.ts
bunx vitest run --project runtime tests/runtime/gameRuntime.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/runtime/persistenceCoordinator.ts src/runtime/createGameRuntime.ts tests/runtime/persistenceCoordinator.test.ts tests/runtime/gameRuntime.test.ts
git commit -m "feat: restore cities through persistence coordinator"
```

---

### Task 7: Implement reset, detach, and active-delete lifecycle guards

**Files:**
- Modify: `src/runtime/createGameRuntime.ts`
- Modify: `src/runtime/persistenceCoordinator.ts`
- Modify: `tests/runtime/gameRuntime.test.ts`

**Interfaces:**
- Produces: `detachActiveCity`, reset lineage behavior, active-delete precondition capability.

- [ ] **Step 1: Add failing reset/detach tests**

```ts
it("reset preserves city identity but starts a dirty new lineage", async () => {
  const { runtime } = await createRuntimeHarness({ activeCity: cityIdentity() });
  const identity = runtime.getSnapshot().persistence.activeCity;
  await runtime.reset();
  expect(runtime.getSnapshot().persistence.activeCity).toEqual(identity);
  expect(runtime.getSnapshot().persistence.dirty).toBe(true);
});

it("detach invalidates stale saves and removes the working target", async () => {
  const harness = await createCoordinatorHarness();
  harness.store.deferWrites();
  const save = harness.runtime.saveWorking();
  const detach = harness.runtime.detachActiveCity();
  expect(detach.status).toBe("completed");
  harness.store.releaseNextWrite();
  expect((await save).status).toBe("superseded");
  expect(harness.runtime.getSnapshot().persistence.activeCity).toBeNull();
});
```

- [ ] **Step 2: Run tests and confirm failure**

Run: `bunx vitest run --project runtime tests/runtime/gameRuntime.test.ts tests/runtime/persistenceCoordinator.test.ts`

Expected: FAIL for lifecycle behavior.

- [ ] **Step 3: Implement reset lineage transition**

After backend reset succeeds, advance session, reset UI/transients, keep identity, establish dirty baseline, and leave working save metadata unchanged. Old persistence completions become superseded.

- [ ] **Step 4: Implement synchronous detach result**

Advance session, clear active identity/status/error/save target, preserve current gameplay snapshot only as detached runtime state, and publish once.

- [ ] **Step 5: Expose active-delete guard**

Provide a coordinator check returning `activeCityDeleteRequiresTransition` when UI attempts to delete the currently bound city. The actual store delete remains HPA-346.

- [ ] **Step 6: Run tests and commit**

```bash
bunx vitest run --project runtime tests/runtime/gameRuntime.test.ts tests/runtime/persistenceCoordinator.test.ts
git add src/runtime/createGameRuntime.ts src/runtime/persistenceCoordinator.ts tests/runtime
git commit -m "feat: add persistence lifecycle transitions"
```

---

### Task 8: Implement foreground New City activation and exact rollback

**Files:**
- Modify: `src/runtime/persistenceCoordinator.ts`
- Modify: `src/runtime/createGameRuntime.ts`
- Modify: `src/runtime/types.ts`
- Modify: `tests/runtime/persistenceCoordinator.test.ts`
- Modify: `tests/runtime/gameRuntime.test.ts`

**Interfaces:**
- Produces: typed `activateNewCity(request, identity)` lifecycle operation used by HPA-345.

- [ ] **Step 1: Add admission, success, rollback, and rollback-failure tests**

Required tests:

- queued gameplay drains before transaction begins;
- ticks called during lifecycle resolve unchanged and never reach backend;
- dispatching controller methods during lifecycle resolve unchanged and never queue;
- successful initial write publishes one clean paused city;
- failed initial write restores exact prior state, UI, identity, revisions, dirty, save time, statuses, and error;
- rollback backend restore failure enters fatal/dead state and clears active identity;
- rollback pause-state restoration failure has the same fatal result.

```ts
it("keeps a previously clean city clean after initial write failure", async () => {
  const harness = await createCoordinatorHarness({ clean: true });
  const before = harness.runtime.getSnapshot();
  harness.store.failNext("writeWorkingSave", "quotaExceeded");
  const result = await harness.runtime.activateNewCity(
    sandboxRequest(),
    newCityIdentity(),
  );
  expect(result.status).toBe("failed");
  const after = harness.runtime.getSnapshot();
  expect(after.state).toEqual(before.state);
  expect(after.ui).toEqual(before.ui);
  expect(after.persistence).toEqual(before.persistence);
});
```

- [ ] **Step 2: Run tests and confirm failure**

Run: `bunx vitest run --project runtime tests/runtime/persistenceCoordinator.test.ts tests/runtime/gameRuntime.test.ts`

Expected: FAIL for New City lifecycle.

- [ ] **Step 3: Add backend-mutation admission flag**

When lifecycle is active, `tick` and backend-dispatching controller methods return the current `RuntimeSnapshot` immediately. Do not append them to `gameplayQueue`. Local lifecycle/modal UI may still publish.

- [ ] **Step 4: Capture exact rollback state before mutation**

Capture canonical prior persistence snapshot, raw pause/running state, active identity, session/revisions, `lastSavedAt`, statuses, persistence error, runtime state, and UI after previously queued gameplay drains.

- [ ] **Step 5: Create, capture, and write candidate**

Call `backend.createSandbox`, then `backend.snapshotForSave`, build the initial envelope, and reserve gameplay admission across the write. Publish candidate only after store success; bind clean paused city once.

- [ ] **Step 6: Implement transaction-internal rollback**

Call `restoreSnapshot` with prior canonical snapshot and restore prior pause/running state without normal dirty accounting. Restore captured bookkeeping exactly and publish no candidate intermediate state.

- [ ] **Step 7: Implement fatal rollback failure**

Reuse/extend `failBackend`, invalidate session, clear active identity/save target, reset persistence statuses, stop runtime, and require rebootstrap. Ensure later saves return `runtimeUnavailable`.

- [ ] **Step 8: Run tests**

Run: `bunx vitest run --project runtime tests/runtime/persistenceCoordinator.test.ts tests/runtime/gameRuntime.test.ts`

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/runtime/persistenceCoordinator.ts src/runtime/createGameRuntime.ts src/runtime/types.ts tests/runtime
git commit -m "feat: add transactional new city activation"
```

---

### Task 9: Application composition and final verification

**Files:**
- Modify: `src/main.ts` if constructor dependencies are not already injected by tests/composition.
- Modify: `tests/runtime/persistenceCoordinator.test.ts`
- Modify: `tests/runtime/gameRuntime.test.ts`

**Interfaces:**
- Finalizes runtime constructor options: `backend`, `saveStore`, `now`, `appVersion`, optional initial identity.

- [ ] **Step 1: Inject dependencies at composition boundary**

Do not create an IndexedDB/Tauri adapter in HPA-499. Use the HPA-498 in-memory adapter only in tests. Production adapter selection remains HPA-343/HPA-344; if no production adapter is available yet, make `saveStore` an explicit constructor dependency and leave main composition unchanged until the adapter ticket lands.

- [ ] **Step 2: Add prohibited-path searches**

```bash
rg 'JSON\.stringify\(.*state|normalizeRustSnapshot.*save|RuntimeSnapshot.*write' src/runtime
rg 'snapshotForSave' src/runtime
```

Expected: gameplay-bearing writes route through the coordinator/backend; normalized state is never a save source.

- [ ] **Step 3: Run focused verification**

```bash
bunx vitest run --project runtime tests/runtime/persistenceCoordinator.test.ts
bunx vitest run --project runtime tests/runtime/gameRuntime.test.ts
```

Expected: PASS.

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

- [ ] **Step 5: Review performance boundary**

Confirm no save capture call originates in the canvas `requestAnimationFrame` callback. Record real-WASM p95 evidence for HPA-352 handoff; do not treat the 100 ms review ceiling as a frame budget.

- [ ] **Step 6: Commit**

```bash
git add src/runtime src/main.ts tests/runtime
git commit -m "test: verify runtime persistence coordination"
```

---

## HPA-499 Completion Gate

- [ ] Every coordinator call returns `completed | failed | superseded`.
- [ ] Dead runtime returns typed `runtimeUnavailable`; existing gameplay queue semantics are unchanged.
- [ ] All normal mutation paths update dirty revisions consistently.
- [ ] Working/checkpoint/autosave/rename serialize through one per-city FIFO.
- [ ] Generation writes never update working `persistedRevision` or `lastSavedAt`.
- [ ] Loads inspect first, restore through Rust, normalize inside commit, publish once, and enter paused.
- [ ] Working load is clean; generation load is dirty.
- [ ] Reset/detach invalidate stale operations correctly.
- [ ] Foreground New City drops/no-ops new backend work, commits cleanly, or restores exact prior lineage.
- [ ] Rollback failure enters explicit fatal/unavailable state.
- [ ] Save capture is outside animation-frame-critical code.
- [ ] Full Rust/TypeScript/runtime/build verification passes before HPA-499 is marked complete.
