# Six-Operation CitySaveStore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the generalized `SaveEnvelope` and 19-operation `SaveStore` platform with a six-operation `CitySaveStore`, a one-map memory implementation, and the minimum runtime cutover required for current multi-city working saves.

**Architecture:** Store one detached `CitySaveRecord` per city. `createCity` establishes identity, `renameCity` owns the display name, and `updateCity(id, { savedAt, snapshot })` updates only working-save data. Rust remains the sole gameplay validator. HPA-548 removes store registries and recovery residue but deliberately leaves the coordinator core and ownership suite unchanged for HPA-543.

**Tech Stack:** TypeScript 5.8, Vitest, Svelte 5, Rust-backed `GameBackend`, Bun, Playwright, Cargo.

## Global Constraints

- Breaking change only: no migration, legacy reader, alias export, compatibility adapter, dual format, or deprecated method.
- Exactly six public operations: `listCities`, `readCity`, `createCity`, `updateCity`, `renameCity`, `deleteCity`.
- `updateCity` accepts only `savedAt` and `snapshot`; it cannot rewrite ID, name, or creation time.
- Store errors are only `notFound`, `conflict`, and `failed`.
- Rust remains the only gameplay snapshot validator.
- Do not absorb HPA-543's busy-gate rewrite or HPA-547's pure candidate work.
- Do not rewrite the core `createSharedPersistenceCoordinator` ownership suite. Delete only store-registry/cross-lifetime tests owned by HPA-548.
- Delete obsolete tests with the implementation they covered. Do not preserve counts or capability matrices.
- Every task below ends in a green repository state.

---

## File Map

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
- `tests/runtime/recoveryPublication.test.ts` when its remaining cases are all recovery-only

### Known direct consumers

- `src/main.ts`
- `src/App.svelte`
- `src/runtime/createGameRuntime.ts`
- `src/runtime/persistenceCoordinator.ts`
- `src/runtime/types.ts`
- `tests/runtime/persistenceCoordinator.test.ts`
- `tests/runtime/gameRuntime.test.ts`
- `tests/runtime/constructionCleanup.test.ts`
- `tests/runtime/backendOwnership.test.ts`
- `tests/runtime/postDisposalBackendFailure.test.ts`
- `tests/ui/appShell.test.ts`
- persistence fixtures, helpers, and wrappers

`tests/ui/pointerEvents.test.ts` imports `createGameRuntime` but currently has no persistence/active-city configuration. Do not edit it unless the compiler or tests identify a real dependency.

---

## Task 1: Rename Active City Creation Metadata

This is a mechanical green change independent of the store migration.

**Files:**
- Modify: every production/test file returned by the search below

**Interfaces:**
- Produces: `ActiveCityIdentity.createdAt`
- Removes: `ActiveCityIdentity.cityCreatedAt`

- [ ] **Step 1: Find every active-city field consumer**

```bash
rg -l "cityCreatedAt" src tests
```

- [ ] **Step 2: Rename the public field**

Use exactly:

```ts
export interface ActiveCityIdentity {
  id: string;
  name: string;
  createdAt: string;
}
```

Change object literals, fixtures, assertions, clone helpers, and comments. Do not keep an alias.

- [ ] **Step 3: Verify absence**

```bash
rg -n "cityCreatedAt" src tests
```

Expected: zero relevant matches.

- [ ] **Step 4: Run the green gate**

```bash
bun run test:unit
bun run check
```

Expected: both commands pass.

- [ ] **Step 5: Commit**

```bash
git add src tests
git commit -m "refactor: rename active city creation time"
```

---

## Task 2: Remove the Store Coordinator Registry Only

Keep the coordinator implementation and its core ownership tests intact. This task removes only store-specific cross-runtime registration.

**Files:**
- Modify: `src/runtime/createGameRuntime.ts`
- Modify: `src/runtime/persistenceCoordinator.ts`
- Modify: tests importing `resetPersistenceCoordinatorRegistry`
- Modify/Delete: registry-specific blocks in `tests/runtime/persistenceCoordinator.test.ts` and `tests/runtime/constructionCleanup.test.ts`

**Interfaces:**
- Keeps: `createSharedPersistenceCoordinator`, `PersistenceLease`, FIFO/fence behavior
- Removes: `resolvePersistenceCoordinator`, identity/object registries, registry reset helper

- [ ] **Step 1: Locate registry-only symbols**

```bash
rg -n "resolvePersistenceCoordinator|resetPersistenceCoordinatorRegistry|coordinatorRegistry|objectIdentityCoordinators|storageIdentity" src tests
```

- [ ] **Step 2: Construct the temporary coordinator per runtime**

Replace registry resolution with:

```ts
const coordinator = createSharedPersistenceCoordinator();
const lease = await coordinator.acquireLease();
```

Do not change the internals of `createSharedPersistenceCoordinator`.

The old `SaveStore.storageIdentity` property may remain temporarily until Task 4/5 removes the old contract. It must no longer affect runtime construction.

- [ ] **Step 3: Delete module-global store registries**

Remove:

- identity-keyed `Map`;
- object-keyed `WeakMap`;
- `resolvePersistenceCoordinator`;
- `resetPersistenceCoordinatorRegistry`;
- comments documenting cross-runtime store-identity handoff.

- [ ] **Step 4: Delete only registry/cross-lifetime tests**

Delete tests whose subject is:

- two adapters sharing one `storageIdentity`;
- object-identity fallback;
- registry reset;
- FIFO/fence state surviving runtime recreation through store identity.

Keep the core lease, queue, fence, foreground-admission, drain, closing, and release tests unchanged except import cleanup. Do not rewrite them around a new abstraction.

- [ ] **Step 5: Run the green gate**

```bash
bun run test tests/runtime/persistenceCoordinator.test.ts \
  tests/runtime/constructionCleanup.test.ts \
  tests/runtime/backendOwnership.test.ts
bun run test:unit
bun run check
```

Expected: all commands pass.

- [ ] **Step 6: Commit**

```bash
git add src/runtime tests/runtime
git commit -m "refactor: remove save store coordinator registry"
```

---

## Task 3: Add the Minimal Store Beside the Legacy Store

This task adds a complete green implementation without changing runtime consumers. The legacy store remains until Task 4/5.

**Files:**
- Create: `src/persistence/citySaveStore.ts`
- Create: `src/persistence/memoryCitySaveStore.ts`
- Create: `tests/runtime/persistence/citySaveStoreContract.ts`
- Create: `tests/runtime/persistence/memoryCitySaveStore.test.ts`

**Interfaces:**
- Produces: `CitySaveRecord`, `CitySummary`, `CitySaveUpdate`, `CitySaveStore`, result/error types, `sortCitySummaries`, memory implementation and failure controls

- [ ] **Step 1: Implement the public types**

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

export interface CitySaveUpdate {
  savedAt: string;
  snapshot: unknown;
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
  updateCity(
    id: string,
    update: CitySaveUpdate,
  ): Promise<CitySaveStoreResult<CitySummary>>;
  renameCity(id: string, name: string): Promise<CitySaveStoreResult<CitySummary>>;
  deleteCity(id: string): Promise<CitySaveStoreResult<void>>;
}
```

- [ ] **Step 2: Port existing sorting behavior**

Move the current ID comparator and timestamp-descending behavior from `saveStore.ts`. Adjust only `cityId` to `id` and nullable to required timestamps. Return a copied array.

Do not create a generic sorter or new ordering policy.

- [ ] **Step 3: Write the shared contract suite**

Use the existing define-once/run-per-adapter pattern with a minimal harness:

```ts
export interface CitySaveStoreContractHarness {
  store: CitySaveStore;
  failNext?: (
    operation: CitySaveStoreOperation,
    code: CitySaveStoreErrorCode,
  ) => void;
}
```

Cover exactly:

```ts
it("creates, lists, and reads a city", async () => {});
it("rejects a duplicate city ID", async () => {});
it("updates savedAt and snapshot", async () => {});
it("returns notFound when updating a missing city", async () => {});
it("preserves identity metadata during update", async () => {});
it("does not revert a committed rename during update", async () => {});
it("preserves the complete prior record after failed update", async () => {});
it("renames only the city name", async () => {});
it("deletes a city and reports notFound afterward", async () => {});
it("sorts by saved time then ID without mutating inputs", async () => {});
it("detaches committed inputs and returned values", async () => {});
```

For the rename/update regression:

1. `createCity` with name `Original`;
2. `renameCity` to `Renamed`;
3. `updateCity(id, { savedAt, snapshot })`;
4. assert the stored name remains `Renamed` and `createdAt` is unchanged.

- [ ] **Step 4: Implement the one-map memory store**

Use:

```ts
const records = new Map<string, CitySaveRecord>();
type FailureQueues = Map<CitySaveStoreOperation, CitySaveStoreErrorCode[]>;
```

Rules:

- `createCity`: clone full record, reject duplicate, apply failure, commit;
- `updateCity`: require existing record, clone update snapshot, construct a complete replacement preserving stored `city`, apply failure, commit;
- `renameCity`: construct a replacement preserving every non-name field;
- all reads/results are detached;
- no raw seeds, envelope inspection, pending sets, generations, capability flags, or storage identity.

- [ ] **Step 5: Run the green gate**

```bash
bun run test tests/runtime/persistence/memoryCitySaveStore.test.ts
bun run test:unit
bun run check
```

Expected: all commands pass while the old store still serves current runtime code.

- [ ] **Step 6: Commit**

```bash
git add src/persistence/citySaveStore.ts \
  src/persistence/memoryCitySaveStore.ts \
  tests/runtime/persistence/citySaveStoreContract.ts \
  tests/runtime/persistence/memoryCitySaveStore.test.ts
git commit -m "refactor: add minimal city save store"
```

---

## Task 4: Cut Runtime and Direct Consumers to CitySaveStore

This is the only large coupled task. It changes the store-facing runtime API, removes pending/recovery concepts, and updates bootstrap/UI consumers together. Keep the coordinator core and ownership suite untouched.

**Files:**
- Modify: `src/main.ts`
- Modify: `src/App.svelte`
- Modify: `src/runtime/createGameRuntime.ts`
- Modify: `src/runtime/persistenceCoordinator.ts`
- Modify: `src/runtime/types.ts`
- Create: `tests/runtime/delayedCitySaveStore.ts`
- Modify: known direct tests from the file map
- Delete: `tests/runtime/recoveryPublication.test.ts` when no independent behavior remains

**Interfaces:**
- Consumes: `CitySaveStore`, `CitySaveRecord`, `CitySaveUpdate`, `CitySummary`
- Produces: working-city-only Save/Load/Rename/New City/Detach controller

- [ ] **Step 1: Capture the real blast radius**

```bash
rg -l \
  "SaveStore|SaveEnvelope|SaveCompatibility|inspectSaveEnvelope|buildSaveEnvelope|readWorkingSave|writeWorkingSave|createWorkingSave|finalizeWorkingSave|inspectWorkingSaveState|runGameplayWrite|GenerationWrite|LoadSource|singleRealm|RuntimeRecoveryState|BootstrapRecoveryError|activeCityDeleteRequiresTransition|guardActiveCityDelete" \
  src tests
```

Use this output in addition to the hand-written file map.

- [ ] **Step 2: Collapse store-facing runtime types**

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

- `LoadSource`, `LoadSourceRead`, `readForLoadSource`;
- generation/checkpoint/autosave operations, statuses, and no-active-city variants;
- `GameplayWriteRequest`, `GenerationWrite*`, `runGameplayWrite`;
- envelope error variants;
- realm-admission variants;
- `activeCityDeleteRequiresTransition` and `guardActiveCityDelete`.

- [ ] **Step 3: Migrate Save Now to update-only**

Call:

```ts
const stored = await saveStore.updateCity(activeCity.id, {
  savedAt,
  snapshot: capture.snapshot,
});
```

Rules:

- never call `createCity` from Save Now;
- `notFound` is a normal store failure;
- successful current completion updates `lastSavedAt` and persistence baseline;
- failure preserves dirty state and prior storage;
- do not publish identity metadata from Save.

Replace every old upsert-based test setup with one explicit `createCity` seed.

- [ ] **Step 4: Migrate Load**

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

Apply the existing working-load clean revision/session transition.

Do not inspect snapshot keys, envelope metadata, schema version, compatibility, or record ID again. Failed read/restore preserves gameplay, UI, identity, save time, and dirty state.

- [ ] **Step 5: Migrate Rename**

Call `renameCity(activeCity.id, name)` through the current city queue. Publish only the returned name.

- [ ] **Step 6: Replace New City pending/finalize with one create**

After current backend-first sandbox creation and candidate capture:

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

- conflict/definite failure: rollback backend and return store failure;
- success while alive: publish candidate and identity;
- success after disposal begins: do not publish, attempt one `deleteCity(id)` cleanup;
- cleanup failure: return its concise store failure from the New City operation;
- disposal still drains and releases; no pin or repair state.

Delete finalize, pending state, read-back classification, bootstrap reconciliation, and realm admission.

- [ ] **Step 7: Delete persistence recovery from runtime, bootstrap, and App**

Remove:

- `RuntimeSnapshot.recovery`;
- `RecoveryRequiredDetails`;
- `RuntimeRecoveryState`;
- `BootstrapRecoveryError`;
- recovery variants of `RuntimeDisposeResult`;
- `pinRecovery`, terminal persistence recovery, and recovery publication;
- `src/main.ts` recovery error classification;
- App recovery screen/branch and recovery-only tests.

Use:

```ts
dispose: () => Promise<void>;
```

Keep normal bootstrap error rendering for ordinary thrown errors.

- [ ] **Step 8: Remove remaining old store capabilities**

Delete `storageIdentity`, `singleRealm`, their types/getters/comments, and any remaining realm-policy code from runtime/store-facing consumers. Task 2 already removed the coordinator registry.

- [ ] **Step 9: Replace delayed wrapper and fixtures**

`DelayedCitySaveStore` forwards six methods and records only:

```ts
const MUTATION_OPERATIONS = new Set<CitySaveStoreOperation>([
  "createCity",
  "updateCity",
  "renameCity",
  "deleteCity",
]);
```

Update `postDisposalBackendFailure.test.ts` to remove persistence-registry reset calls. Update `App.svelte`, `appShell.test.ts`, and `main.ts` together.

Do not rewrite the core coordinator ownership test block. Only adapt imports/types required by the controller surface.

- [ ] **Step 10: Keep focused runtime tests**

Retain or add:

```ts
it("saves an existing city with updateCity", async () => {});
it("does not create a missing city during Save Now", async () => {});
it("preserves dirty state and storage after failed Save", async () => {});
it("loads snapshot and publishes record identity and savedAt", async () => {});
it("preserves current runtime after failed read", async () => {});
it("preserves current runtime after failed restore", async () => {});
it("renames only active city metadata", async () => {});
it("creates and activates a new city", async () => {});
it("rolls back after create conflict", async () => {});
it("rolls back after definite create failure", async () => {});
it("does not publish a create that completes after disposal", async () => {});
it("releases disposal when late-create cleanup fails", async () => {});
```

Delete generation, multi-kind load, envelope, pending/finalize, bootstrap, realm, recovery, and active-delete-guard tests.

- [ ] **Step 11: Run the green cutover gate**

```bash
bun run test tests/runtime/persistenceCoordinator.test.ts \
  tests/runtime/gameRuntime.test.ts \
  tests/runtime/constructionCleanup.test.ts \
  tests/runtime/backendOwnership.test.ts \
  tests/runtime/postDisposalBackendFailure.test.ts \
  tests/ui/appShell.test.ts
bun run test:unit
bun run check
bun run test:e2e
```

Expected: all commands pass. `pointerEvents.test.ts` runs through `test:unit`; edit it only if this gate reports a failure.

- [ ] **Step 12: Commit**

```bash
git add src tests
git commit -m "refactor: cut runtime to city save store"
```

---

## Task 5: Delete the Legacy Persistence Platform

**Files:**
- Delete all old envelope/generalized-store files listed above
- Modify remaining imports, fixtures, helpers, and tests found by scans

**Interfaces:**
- Produces: one public store and one memory implementation with no compatibility layer

- [ ] **Step 1: Delete old source files**

```bash
git rm src/persistence/envelope.ts \
  src/persistence/envelopeInspection.ts \
  src/persistence/saveStore.ts \
  src/persistence/memorySaveStore.ts
```

- [ ] **Step 2: Delete obsolete persistence tests/wrapper**

```bash
git rm tests/runtime/persistence/envelope.test.ts \
  tests/runtime/persistence/saveStore.test.ts \
  tests/runtime/persistence/saveStoreContract.ts \
  tests/runtime/persistence/memorySaveStore.test.ts \
  tests/runtime/delayedSaveStore.ts
```

Delete `tests/runtime/recoveryPublication.test.ts` when Task 4 confirms it has no independent non-recovery cases.

- [ ] **Step 3: Remove obsolete fixtures and comments**

Delete envelope builders, compatibility helpers, raw corruption seeds, checkpoint/autosave/generation fixtures, capability flags, pending-state comments, and repair instructions.

- [ ] **Step 4: Run absence scans**

```bash
rg -n \
  "SaveEnvelope|SaveCompatibility|inspectSaveEnvelope|buildSaveEnvelope|SaveStore\\b|readWorkingSave|writeWorkingSave|createWorkingSave|finalizeWorkingSave|inspectWorkingSaveState|duplicateCity|generationHighWater|storageIdentity|singleRealm|multiRealmNewCityUnsupported|RuntimeRecoveryState|BootstrapRecoveryError|activeCityDeleteRequiresTransition|guardActiveCityDelete|runGameplayWrite|GenerationWrite|LoadSource" \
  src tests
```

Expected: zero relevant production/test matches.

Do not scan generic words such as `Checkpoint` or `Autosave` alone because unrelated gameplay/test concepts may use them.

- [ ] **Step 5: Confirm the singular new surface**

```bash
rg -n "interface CitySaveStore|createMemoryCitySaveStore|CitySaveRecord|CitySaveUpdate" src tests
```

Expected: one contract, one memory implementation, and direct consumers/tests.

- [ ] **Step 6: Run the green deletion gate**

```bash
bun run test:unit
bun run check
```

Expected: both commands pass.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: delete legacy save platform"
```

---

## Task 6: Final Verification and Scope Review

- [ ] **Step 1: Run the complete repository gates**

```bash
bun run test
bun run test:e2e
bun run check
bun run lint:svelte
bun run format:check
bun run build
cargo test --workspace
```

Expected: all commands pass. If a failure is confirmed pre-existing and unrelated, record the exact command/output in the implementation PR rather than expanding HPA-548.

- [ ] **Step 2: Review for accidental architecture growth**

Confirm there is:

- no busy-gate/runtime rewrite from HPA-543;
- no rewritten coordinator ownership suite;
- no manager/service/repository base class;
- no adapter registry or generic transaction layer;
- no envelope/compatibility/gameplay-summary metadata;
- no migration or fallback reader;
- no checkpoint/autosave placeholder;
- no recovery or repair taxonomy;
- no Save path capable of modifying identity metadata.

- [ ] **Step 3: Review the test diff**

Keep tests for player operations and store guarantees. Ensure the core coordinator ownership suite is unchanged except import/type cleanup and registry-specific deletion.

- [ ] **Step 4: Confirm material net reduction**

```bash
git diff --stat main...HEAD
git diff --numstat main...HEAD
```

Production and test code must both decrease materially.

- [ ] **Step 5: Verify downstream handoff**

HPA-543 must be able to delete `createSharedPersistenceCoordinator`, queues, leases, fences, tokens, revisions, and its preserved ownership suite without another store-shape migration.

- [ ] **Step 6: Commit verification-only changes when needed**

```bash
git add -A
git commit -m "chore: verify city save store simplification"
```

Skip when verification changes no files.

---

## Acceptance Mapping

- **Exactly six operations:** Tasks 3 and 5.
- **Identity-safe updates:** Task 3 contract tests and Task 4 Save migration.
- **Three error codes:** Task 3 and absence scans.
- **Minimal record and Rust authority:** Tasks 3–5.
- **No generations/pending/recovery/registry APIs:** Tasks 2, 4, and 5.
- **No hollow active-delete guard:** Task 4.
- **Bootstrap/App compile-safe cleanup:** Task 4 includes `src/main.ts` and e2e.
- **Coordinator boundary respected:** Task 2 and Task 6 preserve the core suite for HPA-543.
- **Green intermediate commits:** every task gate.
- **Material net deletion:** Task 6.

## Implementation Review Focus

Reject the implementation if it:

- folds HPA-543 into HPA-548;
- rewrites the coordinator ownership suite instead of preserving it;
- lets `updateCity` rewrite name or creation time;
- creates a compatibility adapter or retains old methods under aliases;
- inspects snapshot schema/keys in TypeScript;
- adds future metadata, generic frameworks, registries, or repair systems;
- omits `src/main.ts` or leaves recovery UI/types behind;
- skips Playwright after changing bootstrap/App behavior.
