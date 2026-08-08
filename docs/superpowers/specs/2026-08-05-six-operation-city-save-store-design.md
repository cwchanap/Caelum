# Six-Operation CitySaveStore Design

**Issue:** HPA-548  
**Status:** Proposed  
**Decision date:** 2026-08-05  
**Related work:** HPA-543, HPA-547, HPA-343, HPA-344, HPA-346

## 1. Decision

Replace the generalized save-envelope and 19-operation `SaveStore` platform with one small multi-city working-save contract:

- list cities;
- read one city;
- atomically create one city;
- atomically update only its saved snapshot/time;
- rename it;
- delete it.

Persist one record per city containing only immutable identity metadata, the mutable display name, the latest save time, and one opaque Rust snapshot.

This is a breaking active-development change. Delete the old persistence API, formats, fixtures, and tests in the same implementation PR. Do not add migration, aliases, dual writes, or a compatibility adapter.

## 2. Scope boundary

### HPA-548 owns

- the six-operation `CitySaveStore`;
- the minimal `CitySaveRecord` and `CitySummary`;
- a one-map memory implementation;
- a small shared adapter contract suite;
- removal of envelopes, compatibility inspection, checkpoints, autosaves, generations, duplicate city, pending/finalize, realm capability, storage identity, and persistence recovery/pinning;
- the minimum runtime cutover required to consume the new store.

### HPA-548 does not own

- IndexedDB storage — HPA-343;
- Tauri application-data files — HPA-344;
- city-library UI — HPA-346;
- pure sandbox candidate construction and host simplification — HPA-547;
- replacing queues, leases, fences, session/revision tokens, and supersession with one `persistenceBusy` gate — HPA-543.

HPA-543 explicitly depends on both HPA-547 and HPA-548. Do not fold its busy-gate rewrite into this ticket. HPA-548 keeps the current coordinator internals temporarily, but avoids rewriting the ownership-model suite that HPA-543 will delete.

## 3. Store model

### 3.1 Record and update shapes

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
```

Ownership rules:

- `createCity` is the only operation that establishes `city.id` and `city.createdAt`.
- `renameCity` is the only operation that changes `city.name`.
- `updateCity` changes only `savedAt` and `snapshot`.
- `city.createdAt` is immutable after creation.
- A Save Now operation cannot overwrite a committed rename with a stale in-memory name.

Every field has a current consumer. Do not add format, envelope version, app version, duplicated snapshot schema version, gameplay summary, pending state, compatibility state, checkpoint/autosave metadata, generations, or storage ownership metadata.

### 3.2 Reuse existing city sorting

Port the existing `compareIds`, timestamp-descending comparator, and copied-array `sortCitySummaries` behavior from `src/persistence/saveStore.ts` into the new contract module. Adjust only field names and non-null timestamp types.

Ordering remains:

1. valid `savedAt` descending;
2. ID ascending;
3. invalid timestamps after valid timestamps, ordered by ID.

Do not redesign or generalize the comparator.

## 4. Public contract

```ts
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

### 4.1 `listCities`

Returns detached summaries in deterministic order. It does not inspect snapshot contents.

### 4.2 `readCity`

Returns a detached full record. Missing records return `notFound`.

The store key and `record.city.id` are one invariant established by `createCity`; the runtime does not re-check identity after every read.

### 4.3 `createCity`

Atomically creates a record only when the ID does not already exist. Existing IDs return `conflict`.

The adapter validates only accessible host fields needed to store the record. Rust remains the only gameplay validator.

### 4.4 `updateCity`

Atomically replaces only the existing record's `savedAt` and `snapshot`. It preserves the stored `city.id`, latest `city.name`, and immutable `city.createdAt`.

Missing IDs return `notFound`. Update is never an upsert.

A definite failed update leaves the complete previous record readable.

### 4.5 `renameCity`

Changes only `city.name`. It preserves ID, creation time, save time, and snapshot.

### 4.6 `deleteCity`

Deletes the complete record. Missing IDs return `notFound`.

### 4.7 Errors

`failed` covers all non-conflict, non-not-found expected storage failures. The current UI does not distinguish unavailable, permission, quota, transaction, serialization, or I/O categories, so the store does not expose them.

`diagnostic` is optional support information and never controls behavior. Native diagnostics do not expose arbitrary filesystem paths.

## 5. Atomicity and detachment

Require only atomicity that protects current player-visible behavior:

- create-only prevents an ID collision from overwriting a city;
- update preserves the prior record after a definite failure.

Each adapter uses its natural primitive. Do not create a generic transaction layer.

Detach values at boundaries where mutation could affect committed state:

- detach the full input to `createCity` before commit;
- detach `CitySaveUpdate.snapshot` before update commit;
- return detached records and summaries;
- construct a replacement record for rename rather than mutating in place.

The memory store is one `Map<string, CitySaveRecord>` plus a small operation-failure queue for tests.

## 6. Runtime bridge

> **Superseded by HPA-543 (2026-08-08).** Sections 3–5 remain the authoritative
> `CitySaveStore` contract. The controller/coordinator workflow below describes
> the temporary HPA-548 cutover state and must not be used for new runtime work.
> See `2026-08-08-working-save-runtime-design.md` for the current runtime contract.

### 6.1 Controller surface after HPA-548

```ts
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

export interface ActiveCityIdentity {
  id: string;
  name: string;
  createdAt: string;
}

export interface LoadCityValue {
  snapshot: RuntimeSnapshot;
  cityId: string;
}
```

Delete:

- multi-kind `LoadSource` and `readForLoadSource`;
- checkpoint/autosave operations and statuses;
- `runGameplayWrite` and all generation-write types;
- envelope errors and `kind: "envelope"`;
- realm-admission errors;
- `activeCityDeleteRequiresTransition` and `guardActiveCityDelete`, which have no production consumer and are not part of this controller.

### 6.2 Save Now

1. Capture the canonical paused snapshot with `backend.snapshotForSave()`.
2. Generate `savedAt`.
3. Call:

```ts
saveStore.updateCity(activeCity.id, {
  savedAt,
  snapshot: capture.snapshot,
});
```

4. On success, preserve the current stale-session/revision rules, update `lastSavedAt`, and clear the working persistence baseline.
5. On failure, keep dirty state and the previous record.

Save Now never creates a missing city. Tests that previously seeded storage through upsert must call `createCity` explicitly.

### 6.3 Load

1. Call `readCity(cityId)`.
2. Pass `record.snapshot` directly to `backend.restoreSnapshot`.
3. After successful restore, publish:
   - `activeCity = record.city`;
   - `lastSavedAt = record.savedAt`;
   - the existing working-load clean revision/session state.
4. Failed read or restore preserves gameplay, UI, active identity, save time, and dirty bookkeeping.

There is no TypeScript envelope, schema, compatibility, or identity inspection layer. Backend failures remain backend errors.

### 6.4 Rename

Call `renameCity(activeCity.id, name)` through the current city ordering path. On success publish the returned name only. Later Save Now calls cannot revert it because `updateCity` does not accept identity metadata.

### 6.5 New City before HPA-547/HPA-543

The current backend mutates during `createSandbox`, so this bridge remains backend-first:

1. reserve the existing lifecycle path and capture prior canonical state;
2. call `backend.createSandbox(request)`;
3. capture the candidate with `snapshotForSave()`;
4. build one `CitySaveRecord`;
5. call `createCity(record)` once;
6. on conflict or definite failure, restore prior backend state;
7. on success while alive, publish the candidate and active city;
8. if disposal starts after create succeeds, do not publish and attempt one `deleteCity(id)` cleanup before release.

There is no finalize call, pending marker, read-back classification, bootstrap repair, or realm policy.

If late cleanup fails, return the concise store failure from the New City operation. Disposal still drains admitted work and releases ownership; do not pin the runtime or introduce manual-repair state.

### 6.6 Recovery and bootstrap cleanup

Delete together:

- `RuntimeSnapshot.recovery`;
- `RecoveryRequiredDetails`;
- `RuntimeRecoveryState`;
- `BootstrapRecoveryError`;
- recovery variants of `RuntimeDisposeResult`;
- recovery-only App UI and tests;
- `src/main.ts` bootstrap recovery classification;
- permanent persistence-lease pinning and its documentation.

`RuntimeController.dispose()` becomes `Promise<void>` after stopping admission, draining admitted work, and releasing the temporary persistence lease and backend ownership.

### 6.7 Coordinator boundary

Remove only store-specific cross-runtime registration:

- `StorageIdentity` reads from runtime construction;
- the identity `Map`;
- object-identity `WeakMap` fallback;
- `resolvePersistenceCoordinator`;
- `resetPersistenceCoordinatorRegistry`;
- tests specifically covering those registry and cross-lifetime store-identity paths.

Construct the temporary coordinator directly per runtime:

```ts
const coordinator = createSharedPersistenceCoordinator();
const lease = await coordinator.acquireLease();
```

Keep `createSharedPersistenceCoordinator`, its lease/FIFO/fence implementation, and its core ownership-model tests unchanged except for unavoidable imports or removed store-specific types. Do not rewrite those tests into a runtime-local variant. HPA-543 deletes the entire coordinator and suite after HPA-547 lands.

This temporary dead-general machinery is accepted to avoid paying for an intermediate rewrite that the downstream ticket immediately removes.

## 7. Testing

### 7.1 Shared store contract

Cover:

- create/list/read;
- create conflict;
- update success;
- update missing city;
- update preserves ID/name/created time;
- rename followed by update does not revert the renamed name;
- failed update preserves the complete previous record;
- rename;
- delete;
- deterministic sorting without input mutation;
- detached inputs and outputs.

Retain the existing define-once/run-per-adapter harness pattern for HPA-343 and HPA-344, but remove all capability matrices and future-operation stubs.

### 7.2 Runtime bridge

Retain focused tests for:

- Save success and failure;
- Save Now returning `notFound` rather than creating storage;
- Load publishing record identity and `savedAt` only after successful restore;
- failed read/restore preserving current runtime state;
- Rename;
- New City success;
- create conflict and definite failure rollback;
- post-disposal create success cleanup without publication;
- cleanup failure returning an operation error without blocking disposal.

Delete tests for envelopes, checkpoints, autosaves, generations, pending/finalize, ambiguous read-back, bootstrap repair, realm policy, storage registries, and recovery UI.

Preserve the core `createSharedPersistenceCoordinator` ownership suite for HPA-543; delete only the registry/cross-lifetime store-identity block.

## 8. File impact

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
- old envelope/generalized-store tests and delayed wrapper;
- recovery-only test file if no independent behavior remains.

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
- persistence fixtures, helpers, and wrappers.

Use repository-wide symbol scans to find additional consumers. `tests/ui/pointerEvents.test.ts` imports `createGameRuntime` but currently has no persistence/active-city setup; change it only if type checks or tests prove an actual dependency.

## 9. Sequencing

Use green, reviewable commits:

1. rename `cityCreatedAt` to `createdAt` repository-wide;
2. remove the store coordinator registry while preserving the coordinator core and suite;
3. add the new contract, memory store, and focused tests alongside the old platform;
4. cut the runtime, bootstrap, App, and direct tests to the new contract;
5. delete the old persistence platform and run absence scans;
6. run full unit, Playwright, type, lint, format, build, and Rust verification.

The final implementation remains one PR because no old/new compatibility layer is allowed.

## 10. Acceptance criteria

- Exactly six public store operations remain.
- `updateCity` accepts only `savedAt` and `snapshot`; identity is immutable except for `renameCity`.
- Only `notFound`, `conflict`, and `failed` store codes remain.
- Rust is the sole gameplay snapshot validator.
- No envelope, checkpoint, autosave, generation, duplicate, pending/finalize, realm, storage-identity, or recovery API remains.
- The runtime controller has no hollow generation/load/delete-guard surface.
- `src/main.ts` and App no longer handle persistence recovery.
- The core coordinator and ownership suite are not rewritten in HPA-548; HPA-543 owns their deletion.
- The memory implementation is one map and focused failure controls.
- Production and test code show material net deletion.

## 11. Review guardrails

Reject an implementation that:

- absorbs HPA-543's busy-gate rewrite;
- rewrites the coordinator ownership suite only to delete it in HPA-543;
- allows Save Now to rewrite name or creation time;
- creates a compatibility adapter or dual API;
- inspects snapshot keys/schema in TypeScript;
- adds future metadata, generic transactions, registries, capability systems, or repair frameworks;
- keeps old methods or recovery concepts under renamed types;
- skips Playwright after changing bootstrap or App error rendering.
