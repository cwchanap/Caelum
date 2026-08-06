# Six-Operation CitySaveStore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the generalized `SaveEnvelope` and 19-operation `SaveStore` platform with a six-operation `CitySaveStore`, a one-map memory implementation, and the minimum runtime bridge required to preserve current multi-city working-save behavior.

**Architecture:** Store one detached `CitySaveRecord` per city and project list summaries from that record. Rust remains the only snapshot validator. The existing runtime queue, lease, and revision machinery may remain temporarily, but it must consume only the six-operation store; HPA-543 deletes that remaining coordination framework later.

**Tech Stack:** TypeScript 5.8, Vitest, Svelte 5 runtime, Rust-backed `GameBackend`, Bun, Cargo.

## Global Constraints

- Breaking change only: no migration, compatibility adapter, legacy reader, alias export, dual format, or deprecated method.
- The public store has exactly six operations: `listCities`, `readCity`, `createCity`, `updateCity`, `renameCity`, and `deleteCity`.
- Store records contain only city ID/name/creation time, save time, and one opaque snapshot.
- Rust remains the only gameplay snapshot validator.
- Do not add repository/service/manager base classes, adapter registries, generic transaction layers, capability systems, or repair frameworks.
- Keep current runtime queues, leases, and revision tracking only where required for a compile-safe bridge. HPA-543 owns their replacement.
- Keep backend-first New City rollback only until HPA-547 provides a pure candidate operation.
- Delete obsolete tests with the implementation they covered. Do not preserve test counts for their own sake.

---

## File Structure

### Create

- `src/persistence/citySaveStore.ts` — public record, summary, result, error, contract, and sorting helper.
- `src/persistence/memoryCitySaveStore.ts` — one-map memory implementation and focused failure controls.
- `tests/runtime/persistence/citySaveStoreContract.ts` — shared six-operation behavior suite.
- `tests/runtime/persistence/memoryCitySaveStore.test.ts` — memory harness for the shared suite.
- `tests/runtime/delayedCitySaveStore.ts` — six-operation delayed test wrapper.

### Delete after migration

- `src/persistence/envelope.ts`
- `src/persistence/envelopeInspection.ts`
- `src/persistence/saveStore.ts`
- `src/persistence/memorySaveStore.ts`
- `tests/runtime/persistence/envelope.test.ts`
- `tests/runtime/persistence/saveStore.test.ts`
- `tests/runtime/persistence/saveStoreContract.ts`
- `tests/runtime/persistence/memorySaveStore.test.ts`
- `tests/runtime/delayedSaveStore.ts`

### Modify

- `src/runtime/createGameRuntime.ts`
- `src/runtime/persistenceCoordinator.ts`
- `src/runtime/types.ts`
- `tests/runtime/persistence/fixtures.ts`
- `tests/runtime/persistence/storeTestUtils.ts`
- `tests/runtime/persistenceCoordinator.test.ts`
- `tests/runtime/gameRuntime.test.ts`
- `tests/runtime/constructionCleanup.test.ts`
- `tests/runtime/recoveryPublication.test.ts`
- `tests/runtime/backendOwnership.test.ts`
- any remaining imports found by the removed-symbol scan

---

## Task 1: Add the Six-Operation Contract and Focused Tests

**Files:**
- Create: `src/persistence/citySaveStore.ts`
- Create: `tests/runtime/persistence/citySaveStoreContract.ts`
- Modify: `tests/runtime/persistence/storeTestUtils.ts`
- Modify: `tests/runtime/persistence/fixtures.ts`

**Interfaces:**
- Produces: `CitySaveRecord`, `CitySummary`, `CitySaveStoreOperation`, `CitySaveStoreErrorCode`, `CitySaveStoreError`, `CitySaveStoreResult<T>`, `CitySaveStore`, `sortCitySummaries`.
- Consumed by: Tasks 2–7.

- [ ] **Step 1: Add minimal city fixtures**

Replace envelope-oriented fixture construction with one focused record builder:

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

Do not add corrupt-envelope, checkpoint, autosave, generation, or compatibility fixtures.

- [ ] **Step 2: Write the shared contract tests first**

Define a harness with only the capabilities the contract actually needs:

```ts
export interface CitySaveStoreContractHarness {
  store: CitySaveStore;
  failNext?: (
    operation: CitySaveStoreOperation,
    code: CitySaveStoreErrorCode,
  ) => void;
}
```

Cover these tests:

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
```

- [ ] **Step 3: Run the new contract test and verify failure**

Run:

```bash
bun run test tests/runtime/persistence/memoryCitySaveStore.test.ts
```

Expected: FAIL because `citySaveStore.ts` and `memoryCitySaveStore.ts` do not exist.

- [ ] **Step 4: Implement the public contract**

Create exactly this interface surface:

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

Add `toCitySummary(record)` internally and export `sortCitySummaries(summaries)`.

- [ ] **Step 5: Implement deterministic sorting**

Comparator behavior:

```ts
function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareSavedAtDescending(left: string, right: string): number {
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  const leftValid = Number.isFinite(leftTime);
  const rightValid = Number.isFinite(rightTime);

  if (leftValid && rightValid) return rightTime - leftTime;
  if (leftValid) return -1;
  if (rightValid) return 1;
  return 0;
}
```

Return a copied array sorted by timestamp then ID.

- [ ] **Step 6: Run type checks for the new surface**

```bash
bun run check
```

Expected: existing old-store consumers still fail; the new contract files themselves type-check.

- [ ] **Step 7: Commit**

```bash
git add src/persistence/citySaveStore.ts \
  tests/runtime/persistence/citySaveStoreContract.ts \
  tests/runtime/persistence/fixtures.ts \
  tests/runtime/persistence/storeTestUtils.ts
git commit -m "refactor: define minimal city save store"
```

---

## Task 2: Implement the One-Map Memory Store

**Files:**
- Create: `src/persistence/memoryCitySaveStore.ts`
- Create: `tests/runtime/persistence/memoryCitySaveStore.test.ts`

**Interfaces:**
- Consumes: `CitySaveStore` and related types from Task 1.
- Produces: `createMemoryCitySaveStore()` and `createMemoryCitySaveStoreFailureControls()`.

- [ ] **Step 1: Add the failing memory harness**

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

- [ ] **Step 2: Run the test and verify failure**

```bash
bun run test tests/runtime/persistence/memoryCitySaveStore.test.ts
```

Expected: FAIL because the memory implementation does not exist.

- [ ] **Step 3: Implement one map and one small failure queue**

Use:

```ts
const records = new Map<string, CitySaveRecord>();
type FailureQueues = Map<CitySaveStoreOperation, CitySaveStoreErrorCode[]>;
```

Do not add raw seed methods, checkpoint/autosave maps, generation state, pending sets, storage identities, or realm flags.

- [ ] **Step 4: Implement atomic create/update behavior**

For `createCity`:

1. Detach and validate only the accessible record fields needed by the store.
2. Return `conflict` when `records.has(id)`.
3. Apply injected failure before committing.
4. Commit the detached record in one synchronous step.

For `updateCity`:

1. Return `notFound` when absent.
2. Prepare a detached complete replacement before the failure/commit point.
3. Apply injected failure.
4. Replace the map value; never mutate the existing record.

- [ ] **Step 5: Implement detached reads and rename**

Use `structuredClone` at input/output boundaries. `renameCity` must construct a replacement record preserving all non-name fields.

- [ ] **Step 6: Run the focused suite**

```bash
bun run test tests/runtime/persistence/memoryCitySaveStore.test.ts
bun run check
```

Expected: PASS for the focused store suite; old-store consumers may still fail until subsequent tasks.

- [ ] **Step 7: Commit**

```bash
git add src/persistence/memoryCitySaveStore.ts \
  tests/runtime/persistence/memoryCitySaveStore.test.ts
git commit -m "refactor: add memory city save store"
```

---

## Task 3: Migrate Save, Load, Rename, and Public Types

**Files:**
- Modify: `src/runtime/createGameRuntime.ts`
- Modify: `src/runtime/persistenceCoordinator.ts`
- Modify: `src/runtime/types.ts`
- Create: `tests/runtime/delayedCitySaveStore.ts`
- Modify: `tests/runtime/persistenceCoordinator.test.ts`
- Modify: `tests/runtime/gameRuntime.test.ts`

**Interfaces:**
- Consumes: `CitySaveStore`, `CitySaveRecord`, `CitySummary`.
- Produces: current working-save Save/Load/Rename behavior with no envelope or generation concepts.

- [ ] **Step 1: Reduce runtime persistence types**

Replace old store-facing imports with `CitySaveStore` types.

Rename active metadata consistently:

```ts
export interface ActiveCityIdentity {
  id: string;
  name: string;
  createdAt: string;
}
```

Do not retain `cityCreatedAt` as an alias.

Reduce load sources to working cities only:

```ts
export interface LoadCityValue {
  snapshot: RuntimeSnapshot;
  cityId: string;
}
```

Delete checkpoint/autosave source unions, generation write types, `runGameplayWrite`, and generation save-status kinds.

- [ ] **Step 2: Remove envelope construction and inspection**

Delete imports and usage of:

```ts
buildSaveEnvelope
inspectSaveEnvelope
compatibilityToEnvelopeError
SaveEnvelopeError
WritableSaveEnvelope
InspectedSaveEnvelope
```

Remove `appVersion` from `CreateGameRuntimeOptions` and all test setup.

- [ ] **Step 3: Migrate Save Now**

After `snapshotForSave()` succeeds, construct:

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

Replace `writeWorkingSave` with `updateCity(record)`. Preserve current session/revision stale-completion behavior and update `lastSavedAt` only on current successful completion.

- [ ] **Step 4: Migrate Load**

Replace source dispatch with:

```ts
const read = await saveStore.readCity(cityId);
if (!read.ok) return storeFailure(read.error);

const restored = await backend.restoreSnapshot({
  snapshot: read.value.snapshot,
});
```

Publish `read.value.city` only after restore succeeds. Failed read or restore must leave current gameplay, UI, identity, and dirty bookkeeping unchanged.

- [ ] **Step 5: Migrate Rename**

Call `saveStore.renameCity(activeCity.id, name)`. Publish only the returned name and preserve gameplay state.

- [ ] **Step 6: Replace the delayed test wrapper**

`DelayedCitySaveStore` forwards only six methods and tracks only these mutations:

```ts
const MUTATION_OPERATIONS = new Set<CitySaveStoreOperation>([
  "createCity",
  "updateCity",
  "renameCity",
  "deleteCity",
]);
```

- [ ] **Step 7: Rewrite focused tests**

Keep:

- Save success refreshes `savedAt` and current persistence baseline.
- Save failure preserves dirty state and previous record.
- Load success restores and publishes the selected city.
- Failed read preserves current state.
- Failed restore preserves current state and identity.
- Rename changes only active display metadata.

Delete generation/checkpoint/autosave tests in the touched files.

- [ ] **Step 8: Run focused checks**

```bash
bun run test tests/runtime/persistenceCoordinator.test.ts \
  tests/runtime/gameRuntime.test.ts
bun run check
```

- [ ] **Step 9: Commit**

```bash
git add src/runtime tests/runtime
git commit -m "refactor: use city records for save and load"
```

---

## Task 4: Replace Pending/Finalize New City with One Atomic Create

**Files:**
- Modify: `src/runtime/createGameRuntime.ts`
- Modify: `src/runtime/persistenceCoordinator.ts`
- Modify: `src/runtime/types.ts`
- Modify: `tests/runtime/persistenceCoordinator.test.ts`
- Modify: `tests/runtime/gameRuntime.test.ts`
- Modify: `tests/runtime/recoveryPublication.test.ts`

**Interfaces:**
- Consumes: `createCity(record)` and `deleteCity(id)`.
- Produces: one-write New City bridge using the current mutating backend and rollback.

- [ ] **Step 1: Delete pending-state bootstrap reconciliation**

Remove startup reads and branches based on:

```ts
city.pending
singleRealm
inspectWorkingSaveState
bootstrapReconciliationFailed
multiRealmAmbiguousCleanup
```

Runtime construction must no longer inspect the store before normal player actions.

- [ ] **Step 2: Delete finalize and ambiguous read-back helpers**

Remove:

- `readCityPendingState`;
- `reconcileAmbiguousCreateFailure`;
- `reconcileAmbiguousFinalizeFailure`;
- pending/finalized state types;
- finalize-specific error handling;
- lease pinning and repair instructions owned only by those paths.

- [ ] **Step 3: Construct one city record after candidate capture**

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
```

- [ ] **Step 4: Replace create/finalize with one create**

```ts
const created = await cityQueues.enqueue(identity.id, () =>
  saveStore.createCity(record),
);
```

Behavior:

- `conflict`: rollback backend and return the store failure.
- other definite failure: rollback backend and return the store failure.
- success while alive: publish candidate and active identity.
- success after disposal: do not publish; attempt one `deleteCity(identity.id)` cleanup, then return runtime unavailable.

Do not read back storage to classify ambiguous state.

- [ ] **Step 5: Simplify cleanup failure**

A failed best-effort delete may surface one concise failure result, but must not pin the lease, create a terminal storage-recovery state, or instruct manual repair.

- [ ] **Step 6: Keep only focused New City tests**

```ts
it("creates and activates a new city", async () => {});
it("rolls back after create conflict", async () => {});
it("rolls back after definite create failure", async () => {});
it("does not publish a create that completes after disposal", async () => {});
```

Delete pending/finalize, ambiguous failure, bootstrap repair, and multi-realm matrices.

- [ ] **Step 7: Run focused checks**

```bash
bun run test tests/runtime/persistenceCoordinator.test.ts \
  tests/runtime/gameRuntime.test.ts \
  tests/runtime/recoveryPublication.test.ts
bun run check
```

- [ ] **Step 8: Commit**

```bash
git add src/runtime tests/runtime
git commit -m "refactor: create cities with one store operation"
```

---

## Task 5: Remove Store Capability Registries

**Files:**
- Modify: `src/runtime/createGameRuntime.ts`
- Modify: `src/runtime/persistenceCoordinator.ts`
- Modify: `tests/runtime/constructionCleanup.test.ts`
- Modify: `tests/runtime/backendOwnership.test.ts`

**Interfaces:**
- Produces: runtime-local construction of the temporary existing persistence coordinator.

- [ ] **Step 1: Delete store identity types and metadata reads**

Remove `StorageIdentity`, `storageIdentity`, `singleRealm`, read-once getter handling, and all store capability comments.

- [ ] **Step 2: Delete module-global registries**

Remove the identity `Map`, object-identity `WeakMap`, and `resolvePersistenceCoordinator`.

- [ ] **Step 3: Construct the temporary coordinator directly**

Use:

```ts
const coordinator = createSharedPersistenceCoordinator();
const lease = await coordinator.acquireLease();
```

Do not redesign the coordinator in this task. HPA-543 deletes it later.

- [ ] **Step 4: Preserve backend ownership unchanged**

Do not remove `BackendOwnershipCoordinator`, runtime backend identities, or Tauri session behavior. HPA-547 owns that scope.

- [ ] **Step 5: Remove capability-only tests**

Delete tests for:

- throwing or stateful `storageIdentity`/`singleRealm` getters;
- two adapter wrappers sharing one store identity;
- object-identity fallback;
- multi-realm admission.

Retain tests that independently protect backend ownership and ordinary constructor cleanup.

- [ ] **Step 6: Run focused checks**

```bash
bun run test tests/runtime/constructionCleanup.test.ts \
  tests/runtime/backendOwnership.test.ts
bun run check
```

- [ ] **Step 7: Commit**

```bash
git add src/runtime tests/runtime
git commit -m "refactor: remove save store capability registry"
```

---

## Task 6: Delete the Legacy Persistence Platform

**Files:**
- Delete all old envelope/store files listed in File Structure.
- Modify remaining imports, fixtures, helpers, and tests found by search.

**Interfaces:**
- Produces: one public store contract and one memory implementation with no alias layer.

- [ ] **Step 1: Delete old source files after imports migrate**

```bash
git rm src/persistence/envelope.ts \
  src/persistence/envelopeInspection.ts \
  src/persistence/saveStore.ts \
  src/persistence/memorySaveStore.ts
```

- [ ] **Step 2: Delete obsolete persistence tests and wrappers**

```bash
git rm tests/runtime/persistence/envelope.test.ts \
  tests/runtime/persistence/saveStore.test.ts \
  tests/runtime/persistence/saveStoreContract.ts \
  tests/runtime/persistence/memorySaveStore.test.ts \
  tests/runtime/delayedSaveStore.ts
```

- [ ] **Step 3: Remove obsolete fixtures and helpers**

Delete raw working/checkpoint/autosave seed types, generation builders, envelope builders, compatibility helpers, and capability flags.

- [ ] **Step 4: Run the removed-symbol scan**

```bash
rg -n "SaveEnvelope|SaveCompatibility|inspectSaveEnvelope|buildSaveEnvelope|SaveStore\b|readWorkingSave|writeWorkingSave|createWorkingSave|finalizeWorkingSave|inspectWorkingSaveState|duplicateCity|Checkpoint|Autosave|generationHighWater|storageIdentity|singleRealm|multiRealmNewCityUnsupported" src tests
```

Expected: zero relevant production/test matches. Historical documentation matches are allowed.

- [ ] **Step 5: Confirm the new surface is singular**

```bash
rg -n "interface CitySaveStore|createMemoryCitySaveStore|CitySaveRecord" src tests
```

Expected: one public contract, one memory implementation, and direct consumers/tests.

- [ ] **Step 6: Remove stale comments and skipped matrices**

Delete comments describing pending records, checkpoint/autosave generations, compatibility inspection, cross-runtime storage identity, or manual repair. Remove test skips that existed only for adapter capabilities.

- [ ] **Step 7: Run focused checks**

```bash
bun run test:unit
bun run check
```

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor: delete legacy save platform"
```

---

## Task 7: Final Verification and Scope Review

**Files:**
- Modify only files requiring formatting or test corrections.

- [ ] **Step 1: Run the full repository checks**

```bash
bun run test
bun run check
bun run lint:svelte
bun run format:check
bun run build
cargo test --workspace
```

Expected: all pass. If a failure is unrelated and pre-existing, record the exact command and failure in the PR rather than expanding HPA-548.

- [ ] **Step 2: Review the production diff for accidental architecture growth**

Confirm there is:

- no manager/service/repository base class;
- no adapter registry;
- no generic transaction abstraction;
- no format or compatibility metadata;
- no duplicated gameplay summary or schema version;
- no migration or fallback reader;
- no checkpoint/autosave placeholder;
- no new recovery taxonomy;
- no broad gameplay/backend/UI refactor.

- [ ] **Step 3: Review the test diff**

Confirm tests describe current player-visible operations and atomic store guarantees rather than deleted internal branches. Keep deterministic Rust gameplay tests untouched.

- [ ] **Step 4: Confirm material net reduction**

```bash
git diff --stat main...HEAD
git diff --numstat main...HEAD
```

Production and test code should both decrease materially despite the new focused contract files.

- [ ] **Step 5: Verify HPA-543 handoff**

The remaining runtime coordination must consume only `CitySaveStore`; HPA-543 should be able to delete queues, leases, tokens, and revision baselines without another store-shape migration.

- [ ] **Step 6: Commit formatting-only changes when necessary**

```bash
git add -A
git commit -m "chore: verify city save store simplification"
```

Skip this commit when verification produces no file changes.

---

## Acceptance Mapping

- **Exactly six operations:** Tasks 1 and 6.
- **Minimal city record:** Task 1 and deletion of envelope modules in Task 6.
- **No checkpoint/autosave/generation/duplicate/pending APIs:** Tasks 3, 4, and 6.
- **No duplicated gameplay metadata/schema/app version:** Tasks 3 and 6.
- **Atomic create and update:** Tasks 1 and 2 tests; durable equivalents belong to HPA-343/HPA-344.
- **Small memory fake and tests:** Task 2.
- **No old-format adaptation:** Task 6.
- **Compile-safe current runtime bridge:** Tasks 3–5.
- **Material net reduction:** Task 7.

## Implementation Review Focus

Reject the implementation if it:

- creates a compatibility adapter between `SaveStore` and `CitySaveStore`;
- retains old methods under aliases;
- inspects snapshot schema or exact keys in TypeScript;
- adds future metadata with no current consumer;
- creates a generic persistence framework;
- expands into HPA-543 or HPA-547 beyond the explicit bridge steps;
- keeps redundant tests solely to maintain previous coverage counts.
