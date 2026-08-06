# Six-Operation CitySaveStore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `SaveEnvelope` and the 19-operation `SaveStore` platform with a six-operation `CitySaveStore`, a one-map memory implementation, and a compile-safe runtime cutover with no phantom generation/recovery API.

**Architecture:** Store one detached `CitySaveRecord` per city. Rust remains the only snapshot validator. HPA-548 removes store-specific pending, recovery, realm, and controller residue while retaining the existing runtime-local queues, lease, session tokens, and revision tracking for HPA-543.

**Tech Stack:** TypeScript 5.8, Vitest, Svelte 5, Bun, Rust-backed `GameBackend`, Cargo.

## Global constraints

- Breaking change only: no migration, compatibility adapter, aliases, dual format, or deprecated methods.
- Exactly six store operations: `listCities`, `readCity`, `createCity`, `updateCity`, `renameCity`, `deleteCity`.
- The record contains only city ID/name/creation time, save time, and opaque snapshot.
- Rust is the only gameplay snapshot validator.
- Save Now is update-only. Setup/New City creates records explicitly.
- Delete checkpoint/autosave/generation/envelope/multi-realm/recovery controller surface in the same cutover.
- Remove persistence recovery and lease pinning because their pending/finalize triggers are removed.
- Keep backend ownership unchanged for HPA-547.
- Keep the temporary runtime-local queue/lease/session/revision implementation for HPA-543.
- No repository/service/manager framework, generic transaction layer, adapter registry, or repair framework.
- Each task commit ends at a green verification gate. Do not commit knowingly broken intermediate states.

---

## File map

### Create

- `src/persistence/citySaveStore.ts`
- `src/persistence/memoryCitySaveStore.ts`
- `tests/runtime/persistence/citySaveStoreContract.ts`
- `tests/runtime/persistence/memoryCitySaveStore.test.ts`
- `tests/runtime/delayedCitySaveStore.ts`

### Delete after cutover

- `src/persistence/envelope.ts`
- `src/persistence/envelopeInspection.ts`
- `src/persistence/saveStore.ts`
- `src/persistence/memorySaveStore.ts`
- `tests/runtime/persistence/envelope.test.ts`
- `tests/runtime/persistence/saveStore.test.ts`
- `tests/runtime/persistence/saveStoreContract.ts`
- `tests/runtime/persistence/memorySaveStore.test.ts`
- `tests/runtime/delayedSaveStore.ts`

### Known direct consumers

- `src/runtime/createGameRuntime.ts`
- `src/runtime/persistenceCoordinator.ts`
- `src/runtime/types.ts`
- `src/App.svelte`
- `tests/runtime/persistence/fixtures.ts`
- `tests/runtime/persistence/storeTestUtils.ts`
- `tests/runtime/persistenceCoordinator.test.ts`
- `tests/runtime/gameRuntime.test.ts`
- `tests/runtime/constructionCleanup.test.ts`
- `tests/runtime/recoveryPublication.test.ts`
- `tests/runtime/backendOwnership.test.ts`
- `tests/runtime/postDisposalBackendFailure.test.ts`
- `tests/ui/appShell.test.ts`
- every additional file returned by the pre-cutover symbol inventory.

`tests/ui/pointerEvents.test.ts` is a compile-verification consumer, not a mandatory edit: it imports `createGameRuntime` but currently does not use save-store or active-city options.

---

## Task 1: Add the minimal store and memory implementation side-by-side

**Files:**
- Create: `src/persistence/citySaveStore.ts`
- Create: `src/persistence/memoryCitySaveStore.ts`
- Create: `tests/runtime/persistence/citySaveStoreContract.ts`
- Create: `tests/runtime/persistence/memoryCitySaveStore.test.ts`
- Modify additively: `tests/runtime/persistence/fixtures.ts`
- Modify additively: `tests/runtime/persistence/storeTestUtils.ts`

**Interfaces:**
- Produces: `CitySaveRecord`, `CitySummary`, `CitySaveStore*`, `sortCitySummaries`, `createMemoryCitySaveStore`, and failure controls.
- Consumed by: Task 2.
- The old store remains temporarily so existing consumers continue compiling at this task boundary.

- [ ] **Step 1: Add a minimal record fixture without deleting old fixtures**

```ts
import type { CitySaveRecord } from "../../../src/persistence/citySaveStore";
import { makeRustSnapshot } from "../../fixtures/rustSnapshot";

export function makeCitySaveRecord(
  overrides: Partial<CitySaveRecord> = {},
): CitySaveRecord {
  return {
    city: {
      id: "city-1",
      name: "Test City",
      createdAt: "2026-08-01T09:00:00.000Z",
      ...overrides.city,
    },
    savedAt: "2026-08-01T10:00:00.000Z",
    snapshot: makeRustSnapshot(),
    ...overrides,
  };
}
```

Keep old envelope fixtures until Task 3 deletes their consumers.

- [ ] **Step 2: Write the failing memory contract harness**

Create `memoryCitySaveStore.test.ts` before the implementation:

```ts
import { defineCitySaveStoreContract } from "./citySaveStoreContract";
import {
  createMemoryCitySaveStore,
  createMemoryCitySaveStoreFailureControls,
} from "../../../src/persistence/memoryCitySaveStore";

defineCitySaveStoreContract("MemoryCitySaveStore", () => {
  const failures = createMemoryCitySaveStoreFailureControls();
  return {
    store: createMemoryCitySaveStore({ failures }),
    failNext: failures.failNext,
  };
});
```

The contract suite covers only:

```ts
it("creates, lists, and reads a city", async () => {});
it("rejects a duplicate city ID", async () => {});
it("updates an existing city", async () => {});
it("returns notFound when updating a missing city", async () => {});
it("preserves the previous record after a failed update", async () => {});
it("renames only the city name", async () => {});
it("deletes a city and reports notFound afterward", async () => {});
it("sorts by saved time then ID without mutating inputs", async () => {});
it("detaches committed inputs and returned values", async () => {});
it("returns records whose city ID matches the requested key", async () => {});
```

- [ ] **Step 3: Run the red test**

```bash
bun run test tests/runtime/persistence/memoryCitySaveStore.test.ts
```

Expected: FAIL because `citySaveStore.ts` or `memoryCitySaveStore.ts` does not exist.

- [ ] **Step 4: Implement the public contract**

```ts
export interface CitySaveRecord {
  city: {
    id: string;
    name: string;
    createdAt: string;
  };
  savedAt: string;
  snapshot: unknown;
}

export interface CitySummary {
  id: string;
  name: string;
  createdAt: string;
  savedAt: string;
}

export type CitySaveStoreOperation =
  | "listCities"
  | "readCity"
  | "createCity"
  | "updateCity"
  | "renameCity"
  | "deleteCity";

export type CitySaveStoreErrorCode =
  | "notFound"
  | "conflict"
  | "unavailable"
  | "failed";

export interface CitySaveStoreError {
  operation: CitySaveStoreOperation;
  code: CitySaveStoreErrorCode;
  cityId?: string;
  diagnostic?: string;
}

export type CitySaveStoreResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: CitySaveStoreError };

export interface CitySaveStore {
  listCities(): Promise<CitySaveStoreResult<CitySummary[]>>;
  readCity(id: string): Promise<CitySaveStoreResult<CitySaveRecord>>;
  createCity(record: CitySaveRecord): Promise<CitySaveStoreResult<CitySummary>>;
  updateCity(record: CitySaveRecord): Promise<CitySaveStoreResult<CitySummary>>;
  renameCity(id: string, name: string): Promise<CitySaveStoreResult<CitySummary>>;
  deleteCity(id: string): Promise<CitySaveStoreResult<void>>;
}
```

`readCity(id)` must never return a record with a different `city.id`.

- [ ] **Step 5: Move the existing city sort behavior**

Port the existing `compareIds`, descending timestamp comparator, and `sortCitySummaries` from `src/persistence/saveStore.ts`. Adapt only:

- `cityId` to `id`;
- nullable `savedAt` to required `savedAt`.

Do not redesign the comparator. Return a copied array.

- [ ] **Step 6: Implement the one-map memory store**

Use:

```ts
const records = new Map<string, CitySaveRecord>();
type FailureQueues = Map<CitySaveStoreOperation, CitySaveStoreErrorCode[]>;
```

Rules:

- clone a full record before create/update commit;
- create returns `conflict` when present;
- update returns `notFound` when absent;
- apply injected update failure after preparing the detached replacement but before `records.set`;
- read/list/rename results are detached;
- rename replaces the record and changes only `city.name`;
- no raw seeds, checkpoints, autosaves, generations, pending state, storage identity, realm flags, or capability matrix.

- [ ] **Step 7: Run the green store gate**

```bash
bun run test tests/runtime/persistence/memoryCitySaveStore.test.ts
bun run check
```

Expected: both commands pass because this task is additive and old consumers still use the old modules.

- [ ] **Step 8: Commit**

```bash
git add src/persistence/citySaveStore.ts \
  src/persistence/memoryCitySaveStore.ts \
  tests/runtime/persistence/citySaveStoreContract.ts \
  tests/runtime/persistence/memoryCitySaveStore.test.ts \
  tests/runtime/persistence/fixtures.ts \
  tests/runtime/persistence/storeTestUtils.ts
git commit -m "refactor: add minimal city save store"
```

---

## Task 2: Cut the runtime and all direct consumers to CitySaveStore

This is one compile-safe task. The controller collapse, Save/Load/Rename migration, New City change, recovery deletion, registry deletion, UI cleanup, and affected runtime-test rewrite must land together.

**Files:**
- Modify: all known direct consumers from the file map
- Create: `tests/runtime/delayedCitySaveStore.ts`
- Delete when no longer referenced: `tests/runtime/recoveryPublication.test.ts` if all of its behavior is recovery-only
- Keep old persistence source/test modules until Task 3

**Interfaces:**
- Consumes: the Task 1 store.
- Produces: a runtime that uses only the six operations and exposes no deleted persistence concepts.

- [ ] **Step 1: Capture the real blast radius before editing**

```bash
rg -l \
  "SaveStore|SaveEnvelope|SaveCompatibility|inspectSaveEnvelope|buildSaveEnvelope|readWorkingSave|writeWorkingSave|createWorkingSave|finalizeWorkingSave|inspectWorkingSaveState|runGameplayWrite|GenerationWrite|LoadSource|storageIdentity|singleRealm|RuntimeRecoveryState|BootstrapRecoveryError|cityCreatedAt|resetPersistenceCoordinatorRegistry" \
  src tests
```

Save this output in the implementation notes and update every production/test consumer. Do not rely only on the hand-written file list.

- [ ] **Step 2: Collapse the runtime persistence types**

Use:

```ts
export type PersistenceCoordinatorOperation =
  | "saveWorking"
  | "renameActiveCity"
  | "loadCity"
  | "activateNewCity"
  | "detachActiveCity";

export type NoActiveCityOperation =
  | "saveWorking"
  | "renameActiveCity";

export interface ActiveCityIdentity {
  id: string;
  name: string;
  createdAt: string;
}

export interface LoadCityValue {
  snapshot: RuntimeSnapshot;
  cityId: string;
}

export interface RuntimePersistenceController {
  saveWorking(): Promise<PersistenceOperationResult<SaveWorkingValue>>;
  renameActiveCity(
    name: string,
  ): Promise<PersistenceOperationResult<RenameActiveCityValue>>;
  load(cityId: string): Promise<PersistenceOperationResult<LoadCityValue>>;
  detachActiveCity(): Promise<PersistenceOperationResult<RuntimeSnapshot>>;
  activateNewCity(
    request: SandboxCreationRequest,
    identity: NewCityIdentity,
  ): Promise<PersistenceOperationResult<LoadCityValue>>;
}
```

Delete:

- `LoadSource`, `LoadSourceRead`, and `readForLoadSource`;
- `GameplayWriteRequest`, `GenerationWriteKind`, `GenerationWriteValue`, and `runGameplayWrite`;
- checkpoint/autosave operation/status/no-active-city variants;
- envelope errors and `kind: "envelope"`;
- `multiRealmNewCityUnsupported`;
- generation save-status kinds.

`RuntimeLoadStatus` contains only `{ state: "reading" | "restoring"; cityId: string }`. `RuntimeSaveStatus` represents only working-save progress.

- [ ] **Step 3: Rename active metadata repository-wide**

Change `cityCreatedAt` to `createdAt` in production types, fixtures, and assertions. Keep no alias.

Run after edits:

```bash
rg -n "cityCreatedAt" src tests
```

Expected: zero relevant production/test matches.

- [ ] **Step 4: Migrate Save Now from upsert to update-only**

Build:

```ts
const record: CitySaveRecord = {
  city: {
    id: activeCity.id,
    name: activeCity.name,
    createdAt: activeCity.createdAt,
  },
  savedAt,
  snapshot: capture.snapshot,
};
```

Call:

```ts
await saveStore.updateCity(record);
```

Rules:

- Save Now never calls `createCity`;
- successful Save keeps current stale-session/revision behavior and updates `lastSavedAt`;
- `notFound` is surfaced as a store failure;
- failed Save leaves dirty state and the previous record.

Replace every test setup that used `writeWorkingSave` as an upsert with one explicit `createCity` seed. Later saves exercise `updateCity`.

- [ ] **Step 5: Migrate Load and identity publication**

Replace source dispatch with:

```ts
const read = await saveStore.readCity(cityId);
if (!read.ok) return publishStoreFailure(read.error);

const restored = await backend.restoreSnapshot({
  snapshot: read.value.snapshot,
});
```

After successful restore:

```ts
activeCity = { ...read.value.city };
lastSavedAt = read.value.savedAt;
```

Also apply the existing working-load clean revision/session transition.

Do not:

- inspect envelope/schema keys;
- compare `read.value.city.id` again in the runtime;
- retain compatibility errors.

The store contract owns key/record identity. Backend failures remain backend errors. Failed read/restore preserves gameplay, UI, identity, save time, and dirty bookkeeping.

- [ ] **Step 6: Migrate Rename**

Call `renameCity(activeCity.id, name)` through the existing current-city queue. Publish only the returned name and preserve gameplay state.

- [ ] **Step 7: Replace New City pending/finalize with one create**

After current mutating sandbox creation and candidate capture:

```ts
const record: CitySaveRecord = {
  city: {
    id: identity.id,
    name: identity.name,
    createdAt: identity.createdAt,
  },
  savedAt,
  snapshot: candidateCapture.snapshot,
};

const created = await cityQueues.enqueue(identity.id, () =>
  saveStore.createCity(record),
);
```

Behavior:

- conflict or definite failure: rollback the backend and return the store failure;
- success while alive: publish the candidate and active identity;
- success after disposal begins: do not publish; attempt one `deleteCity(identity.id)` cleanup;
- cleanup success: return runtime unavailable for the disposed operation;
- cleanup failure: return that concise store failure from the New City operation.

Delete finalize, pending state, read-back classification, bootstrap reconciliation, and realm admission. Do not inspect storage after failure and do not add a repair flow.

- [ ] **Step 8: Delete persistence recovery and lease pinning completely**

Remove:

- `RuntimeSnapshot.recovery`;
- `RecoveryRequiredDetails`;
- `RuntimeRecoveryState`;
- `BootstrapRecoveryError`;
- recovery variants and long pinning documentation from `RuntimeDisposeResult`;
- `enterLateSuccessCleanupFailure`, `pinRecovery`, and recovery publication;
- recovery-only App UI and tests.

Change:

```ts
dispose: () => Promise<void>;
```

Disposal still:

1. stops new admission;
2. waits for admitted gameplay/store/New City work;
3. releases the runtime-local persistence lease;
4. releases backend ownership.

A concurrent New City cleanup failure is returned by that operation promise. It does not prevent release or recreation.

- [ ] **Step 9: Delete store capability registries**

Remove:

- `StorageIdentity`;
- `storageIdentity` and `singleRealm` reads;
- identity `Map`, object `WeakMap`, and reset helpers;
- `resolvePersistenceCoordinator`.

Construct directly:

```ts
const coordinator = createSharedPersistenceCoordinator();
const lease = await coordinator.acquireLease();
```

Keep the coordinator internals unchanged otherwise. Rewrite/delete tests that assume FIFO/fence state survives disposal and recreation through store identity. Keep backend ownership tests that protect the backend engine handoff.

- [ ] **Step 10: Replace delayed wrappers and test fixtures**

`DelayedCitySaveStore` forwards six methods and records only:

```ts
const MUTATION_OPERATIONS = new Set<CitySaveStoreOperation>([
  "createCity",
  "updateCity",
  "renameCity",
  "deleteCity",
]);
```

Update known tests, including `postDisposalBackendFailure.test.ts`, to remove persistence-registry resets and old active-city field names.

Update `App.svelte` and `appShell.test.ts` to remove the persistence recovery screen/branch. Do not redesign unrelated UI.

- [ ] **Step 11: Keep focused runtime tests**

Retain or add:

```ts
it("saves an existing city with updateCity", async () => {});
it("does not create a missing city during Save Now", async () => {});
it("preserves dirty state and storage after failed Save", async () => {});
it("loads record snapshot and publishes record identity and savedAt", async () => {});
it("preserves current runtime after failed read", async () => {});
it("preserves current runtime after failed restore", async () => {});
it("renames only active city metadata", async () => {});
it("creates and activates a new city", async () => {});
it("rolls back after create conflict", async () => {});
it("rolls back after definite create failure", async () => {});
it("does not publish a create that completes after disposal", async () => {});
it("releases disposal even when late-create cleanup fails", async () => {});
```

Delete tests for checkpoint/autosave generation writes, multi-kind loads, envelope errors, pending/finalize, ambiguous read-back, bootstrap repair, realm policy, shared store registries, and recovery UI.

- [ ] **Step 12: Run the green runtime-cutover gate**

```bash
bun run test tests/runtime/persistenceCoordinator.test.ts \
  tests/runtime/gameRuntime.test.ts \
  tests/runtime/constructionCleanup.test.ts \
  tests/runtime/backendOwnership.test.ts \
  tests/runtime/postDisposalBackendFailure.test.ts \
  tests/ui/appShell.test.ts

bun run test:unit
bun run check
```

Expected: all pass. `pointerEvents.test.ts` is covered by `test:unit` and changes only if a real failure requires it.

- [ ] **Step 13: Commit**

```bash
git add src tests
git commit -m "refactor: cut runtime to city save store"
```

---

## Task 3: Delete the legacy persistence platform and prove singularity

**Files:**
- Delete: old source/test files from the file map
- Modify: remaining fixtures/helpers/imports returned by searches

**Interfaces:**
- Produces: one public store, one memory implementation, and no old API aliases.

- [ ] **Step 1: Delete old source files**

```bash
git rm src/persistence/envelope.ts \
  src/persistence/envelopeInspection.ts \
  src/persistence/saveStore.ts \
  src/persistence/memorySaveStore.ts
```

- [ ] **Step 2: Delete old tests and wrapper**

```bash
git rm tests/runtime/persistence/envelope.test.ts \
  tests/runtime/persistence/saveStore.test.ts \
  tests/runtime/persistence/saveStoreContract.ts \
  tests/runtime/persistence/memorySaveStore.test.ts \
  tests/runtime/delayedSaveStore.ts
```

Delete `recoveryPublication.test.ts` here if it was not already removed in Task 2 and contains no independent non-recovery behavior.

- [ ] **Step 3: Remove obsolete fixtures and helpers**

Delete:

- envelope builders and compatibility helpers;
- raw working/checkpoint/autosave seeds;
- generation builders/high-water controls;
- old store failure capabilities;
- registry reset helpers and related test setup;
- comments describing deleted behavior.

- [ ] **Step 4: Run focused removed-symbol scans**

```bash
rg -n \
  "SaveEnvelope|SaveCompatibility|inspectSaveEnvelope|buildSaveEnvelope|readWorkingSave|writeWorkingSave|createWorkingSave|finalizeWorkingSave|inspectWorkingSaveState|duplicateCity|runGameplayWrite|GameplayWriteRequest|GenerationWrite|loadCheckpoint|loadAutosave|createCheckpoint|createAutosave|storageIdentity|singleRealm|multiRealmNewCityUnsupported|RuntimeRecoveryState|BootstrapRecoveryError|cityCreatedAt|resetPersistenceCoordinatorRegistry" \
  src tests
```

Expected: zero relevant production/test matches.

Do **not** scan generic `Checkpoint`, because unrelated route-draft checkpoint types are valid gameplay/UI concepts.

- [ ] **Step 5: Confirm the new surface is singular**

```bash
rg -n "interface CitySaveStore|createMemoryCitySaveStore|CitySaveRecord" src tests
```

Expected: one public contract, one memory implementation, and direct consumers/tests.

- [ ] **Step 6: Run the green deletion gate**

```bash
bun run test:unit
bun run check
```

Expected: both pass.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: delete legacy save platform"
```

---

## Task 4: Full verification and scope review

**Files:**
- Modify only files requiring formatting or verified corrections.

- [ ] **Step 1: Run the complete repository verification**

```bash
bun run test
bun run check
bun run lint:svelte
bun run format:check
bun run build
cargo test --workspace
```

Record exact failures rather than expanding scope for unrelated pre-existing problems.

- [ ] **Step 2: Re-run the symbol gates**

Run the Task 3 scans again after formatting and test fixes.

- [ ] **Step 3: Review production architecture**

Confirm:

- exactly six store methods;
- no alias or compatibility adapter;
- no TypeScript snapshot inspection;
- no checkpoint/autosave/generation controller residue;
- no persistence recovery/pinning residue;
- no store identity registry;
- no generic transaction/repository/service framework;
- backend ownership unchanged;
- remaining queue/lease/session/revision code is runtime-local and isolated for HPA-543.

- [ ] **Step 4: Review Save/Load/New City semantics**

Confirm:

- all setup creation uses `createCity`;
- Save Now uses only `updateCity`;
- Load publishes record identity and `savedAt` only after restore;
- failed load preserves the active runtime;
- New City uses one create;
- late-create cleanup failure does not pin disposal.

- [ ] **Step 5: Confirm material net deletion**

```bash
git diff --stat main...HEAD
git diff --numstat main...HEAD
```

Require material net reduction in:

- `src/persistence`;
- runtime persistence/controller code;
- related runtime persistence tests.

Do not add tests merely to preserve old counts.

- [ ] **Step 6: Verify the HPA-543 handoff**

HPA-543 must be able to remove the remaining runtime-local queue, lease, tokens, and revision baseline without another store or public controller migration.

- [ ] **Step 7: Commit verification-only changes when necessary**

```bash
git add -A
git commit -m "chore: verify city save store simplification"
```

Skip this commit when verification changes no files.

---

## Acceptance mapping

- **Exactly six operations:** Tasks 1 and 3.
- **Minimal record and Rust authority:** Task 1.
- **Existing sort reused:** Task 1.
- **Save is update-only:** Task 2.
- **Load identity/save-time mapping:** Task 2.
- **No hollow generation/load/error surface:** Task 2.
- **No pending/finalize or recovery pinning:** Task 2.
- **No store capability registry:** Task 2.
- **No old platform or aliases:** Task 3.
- **Complete consumer inventory:** Task 2 symbol scan plus Task 3 zero-match gate.
- **Material net reduction and full checks:** Task 4.

## Implementation review focus

Reject the implementation if it:

- creates an adapter between old and new APIs;
- keeps an old method or union under another name;
- validates snapshot keys/schema in TypeScript;
- makes Save Now upsert;
- retains recovery/pinning after deleting its triggers;
- keeps shared store-identity coordination;
- adds future adapter scaffolding or repair taxonomy;
- broadens into HPA-543/HPA-547 beyond the explicit bridge.
