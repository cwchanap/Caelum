# Six-Operation CitySaveStore Design

**Issue:** HPA-548  
**Status:** Proposed  
**Decision date:** 2026-08-05  
**Related work:** HPA-543, HPA-547, HPA-343, HPA-344, HPA-346

## 1. Purpose

Caelum currently has a generalized persistence platform built around a versioned `SaveEnvelope`, a 19-operation `SaveStore`, checkpoints, autosaves, generations, pending/finalize state, compatibility inspection, storage identity, and shared coordination policy.

That platform is substantially larger than the Phase 1 product requirement: let the player create, list, load, save, rename, and delete multiple cities.

HPA-548 replaces the persistence boundary with the smallest contract that supports that workflow while preserving the parts that are currently important:

- opaque application-generated city IDs;
- one current working save per city;
- deterministic city listing;
- atomic create-only and replace-existing writes;
- detached values where mutation could leak through an adapter;
- Rust as the only gameplay snapshot validator; and
- two justified production adapters: IndexedDB and Tauri application-data files.

This is a breaking active-development change. Old development data and old APIs are deleted rather than migrated.

## 2. Goals

1. Reduce the public persistence interface to exactly six city operations.
2. Store one minimal record per city: identity metadata, save time, and an opaque snapshot.
3. Remove host metadata that duplicates gameplay facts or future compatibility policy.
4. Remove checkpoint, autosave, generation, duplicate-city, pending/finalize, multi-realm, and storage-capability APIs.
5. Make the memory implementation and shared behavior tests small enough to understand directly.
6. Migrate the existing runtime only far enough to consume the new store contract.
7. Leave the remaining queue, lease, and revision architecture for HPA-543 rather than absorbing that rewrite here.
8. Produce a material net reduction in production and test code.

## 3. Non-goals

HPA-548 does not implement:

- IndexedDB storage; HPA-343 owns it.
- Native Tauri file storage; HPA-344 owns it.
- City-library presentation; HPA-346 owns it.
- Pure sandbox candidate construction or host simplification; HPA-547 owns it.
- Replacement of persistence queues, leases, revisions, and recovery state with one busy gate; HPA-543 owns it.
- Checkpoints, autosave, recovery, import/export, cloud sync, migrations, folders, tags, thumbnails, encryption, signing, checksums, or multi-window/process correctness.
- Backward compatibility for existing development records.

## 4. Design principles

### 4.1 Build only the current player workflow

The store models six operations the current product needs. It does not reserve methods or metadata for possible future features.

### 4.2 Keep gameplay authority in Rust

The store treats `snapshot` as opaque data. It neither inspects snapshot schema versions nor validates gameplay invariants. Loading passes the stored snapshot to the Rust-backed `GameBackend`, whose candidate-first restore remains authoritative.

### 4.3 Prefer one complete record over parallel metadata structures

Each city has one complete current-development record. Listing projects summaries from that record. There is no metadata index in the public model and no split between a save envelope and store-owned city metadata.

### 4.4 Use breaking changes instead of transition machinery

There are no aliases, compatibility wrappers, migrations, dual formats, deprecated methods, or fallback readers. Every old call site and test changes in the same implementation PR.

### 4.5 Keep adapter semantics explicit but small

Atomic create and atomic replacement are required because they protect visible player operations. Detailed vendor-specific quota, permission, corruption, and transaction taxonomies are not required at this stage.

## 5. Public record model

Create `src/persistence/citySaveStore.ts` with the following core types:

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
```

Every field has a current consumer:

- `city.id` identifies the city and storage record.
- `city.name` supports the library and rename.
- `city.createdAt` preserves identity metadata across saves.
- `savedAt` supports visible last-save time and deterministic sorting.
- `snapshot` is the canonical Rust gameplay payload.

The following fields are deliberately absent:

- format discriminator;
- envelope version;
- application version;
- duplicated snapshot schema version;
- duplicated gameplay summary such as game mode, economy, or template;
- pending/finalized state;
- compatibility state;
- storage identity or realm capability;
- checkpoint, autosave, generation, or recovery metadata.

## 6. Public store contract

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

The typed-result shape follows current project conventions without retaining the old error taxonomy.

### 6.1 `listCities`

Returns summaries sorted by:

1. valid `savedAt` timestamps descending;
2. city ID ascending as the deterministic tie-breaker;
3. invalid timestamps after valid timestamps, ordered by ID.

The sorting utility returns a new array and does not mutate the caller-owned input.

### 6.2 `readCity`

Returns the complete detached record. Missing records return `notFound` rather than `null`, preserving a closed result convention.

The store does not inspect or normalize the snapshot.

### 6.3 `createCity`

Atomically creates a city only when its ID does not exist. Existing IDs return `conflict`. The existence check and commit must occur in one adapter transaction or equivalent atomic filesystem operation.

A successful create proves the operation did not overwrite an existing city.

### 6.4 `updateCity`

Atomically replaces an existing city record. Missing IDs return `notFound`; update is not an upsert.

A definite failed update must leave the previous committed record readable. Adapters prepare the replacement before the commit point and never mutate the existing record in place.

### 6.5 `renameCity`

Changes only `city.name`. It preserves ID, creation time, save time, and snapshot. Missing records return `notFound`.

### 6.6 `deleteCity`

Deletes the complete city record. Missing records return `notFound`.

There are no child checkpoint/autosave records to cascade.

## 7. Atomicity and value detachment

The contract promises atomicity only where it protects visible current behavior:

- create-only semantics prevent New City from overwriting an ID collision;
- replace-existing semantics preserve the previous working save after a definite failure.

The memory store, IndexedDB adapter, and native file adapter each implement these guarantees using their natural primitive. A generic transaction abstraction is explicitly prohibited.

Adapters detach values on input and output wherever accidental mutation could otherwise modify committed state:

- `createCity` and `updateCity` capture a detached record before commit;
- `readCity` returns a detached record;
- `listCities` returns detached summaries;
- `renameCity` returns a detached summary.

Clone or serialization failures map to the small generic error contract. The implementation does not maintain a public serialization-error category.

## 8. Snapshot authority and loading

A stored snapshot is same-application local data, but it is still not gameplay authority until Rust constructs a valid candidate.

The load path is:

1. `readCity(id)` returns `CitySaveRecord`.
2. The runtime passes `record.snapshot` directly to `backend.restoreSnapshot({ snapshot })`.
3. Rust performs schema probing, deserialization, invariant validation, topology reconstruction, and candidate-first activation.
4. The runtime publishes the city identity only after restore succeeds.
5. A failed read or restore leaves the active gameplay state and identity unchanged.

TypeScript does not inspect exact keys, duplicate the schema version, classify compatibility, or pre-validate gameplay.

## 9. Runtime bridge scope

The current runtime directly consumes the old store and envelope APIs. HPA-548 therefore includes a compile-safe runtime migration, but not the complete runtime simplification planned by HPA-543.

### 9.1 Keep temporarily

Until HPA-543 lands, retain only where necessary:

- the gameplay serialization queue;
- session/load tokens and revision-based dirty tracking;
- current per-city queue and lease implementation;
- current Save, Load, Rename, New City, detach, and disposal behavior;
- backend rollback required by the current mutating `createSandbox` operation.

These are temporary implementation details, not justification for adding them to `CitySaveStore`.

### 9.2 Remove in HPA-548

- `SaveEnvelope`, its builder, and TypeScript inspection;
- compatibility and duplicated schema/app/gameplay metadata;
- checkpoint and autosave load sources;
- generation-write capability and generation save-status kinds;
- pending/finalize/inspect-working-state protocol;
- pending-record bootstrap reconciliation;
- `singleRealm`, multi-realm admission policy, and related recovery variants;
- store `storageIdentity`, identity registry, and object-identity `WeakMap` fallback;
- duplicate-city operation;
- raw corruption and compatibility test seams.

### 9.3 Save Now bridge

1. Capture the canonical paused snapshot with `backend.snapshotForSave()`.
2. Construct `CitySaveRecord` from the active identity, a new `savedAt`, and the captured snapshot.
3. Call `updateCity(record)`.
4. On success, preserve current revision/session completion behavior and update `lastSavedAt`.
5. On failure, retain dirty state and the previous committed save.

### 9.4 Load bridge

1. Read the selected city with `readCity`.
2. Restore `record.snapshot` through the backend.
3. Publish `record.city` only after successful restore.
4. Preserve current gameplay and identity after a failed read or restore.

Only the working-city source remains. Checkpoint and autosave sources are deleted.

### 9.5 Rename bridge

Call `renameCity(activeCity.id, name)` through the existing current-city ordering path. On success, publish only the updated display name and preserve gameplay state.

### 9.6 New City bridge before HPA-547/HPA-543

The current backend mutates during `createSandbox`, so HPA-548 temporarily keeps backend-first rollback:

1. Reserve the existing lifecycle path and capture prior canonical state.
2. Call `backend.createSandbox(request)`.
3. Capture the candidate with `snapshotForSave()`.
4. Construct one `CitySaveRecord`.
5. Call atomic `createCity(record)` exactly once.
6. On conflict or definite create failure, restore prior backend state.
7. On create success, publish the candidate and active city directly; there is no finalize operation.
8. If disposal begins after create succeeds, attempt one best-effort `deleteCity(id)` before release and do not publish success.

Do not retain read-back reconciliation, pending records, lease pinning, or a repair state machine. After HPA-547 provides pure candidate construction, HPA-543 switches New City to storage-first creation without rollback.

### 9.7 Coordination bridge

Remove store capability registries and construct the existing persistence coordinator per runtime with `createSharedPersistenceCoordinator()`.

This deliberately gives up cross-runtime coordination through store identity during the short bridge period. Phase 1 disables overlapping player actions; HPA-543 removes the coordinator entirely in favor of one runtime-local busy gate.

Backend ownership remains untouched because HPA-547 owns host identity and session simplification.

## 10. Memory implementation

Rename the in-memory implementation to `memoryCitySaveStore.ts` and implement it with:

- one `Map<string, CitySaveRecord>`;
- one small per-operation failure queue for focused tests;
- shared summary projection and sorting helpers;
- structured cloning at record boundaries.

It must not contain:

- raw-record seed methods;
- envelope inspection;
- checkpoint or autosave maps;
- generation high-water marks;
- pending city sets;
- storage identity counters;
- realm flags;
- detailed retryability policy;
- adapter capability switches.

## 11. Adapter implications

### 11.1 IndexedDB

HPA-343 implements one object store keyed by city ID. `createCity` uses an add/create-only transaction; `updateCity` performs replace-existing semantics in one transaction.

### 11.2 Tauri files

HPA-344 uses one fixed application-data directory and one file per city. Atomic replacement uses a temporary file and rename or another platform-appropriate atomic replacement primitive.

No metadata index is required until measurement shows directory listing and record parsing are insufficient.

Neither adapter receives a base repository class, registry, capability object, or generic transaction framework.

## 12. Error policy

Expected UI-relevant outcomes use four codes:

- `notFound` for missing records;
- `conflict` for create-only ID collisions;
- `unavailable` for a temporarily inaccessible adapter;
- `failed` for other expected operation failures.

`diagnostic` is optional support information. Runtime control flow must not depend on its exact text. Native diagnostics must not expose arbitrary filesystem paths.

Thrown adapter exceptions are caught at the adapter or runtime boundary and converted to this small contract. HPA-548 does not add retry schedules, timeout systems, vendor-specific taxonomies, or forensic classifications.

## 13. Testing strategy

The shared behavior suite covers only promised public behavior:

- create, list, and read;
- create conflict;
- update success;
- missing-city update;
- failed update preserves the prior record;
- rename;
- delete;
- deterministic sorting;
- detached values.

The runtime bridge retains focused tests for:

- Save success and failure;
- Load success and failure preserving current gameplay;
- Rename;
- New City success;
- create conflict and definite failure rollback;
- post-disposal create success attempting cleanup without publication.

Delete tests that exist only for:

- checkpoint/autosave CRUD;
- generation rotation or high-water state;
- envelope exact-key or compatibility matrices;
- pending/finalize state;
- ambiguous-operation reconciliation;
- multi-realm admission and recovery;
- store identity getter behavior;
- reusable capability matrices and skipped adapter features.

Deterministic Rust tests that protect current gameplay behavior remain outside this cleanup.

## 14. Breaking-change and data policy

There is no released save compatibility requirement.

The implementation PR must:

- change the record and store types directly;
- delete old readers, writers, aliases, wrappers, methods, fixtures, and tests;
- leave no old-to-new adapter;
- clear old IndexedDB databases and native development files when HPA-343/HPA-344 implement the durable stores;
- avoid dual writes or format detection.

Historical design documents remain as records and may be marked superseded, but production code does not preserve their APIs.

## 15. File boundaries

Create or rename:

- `src/persistence/citySaveStore.ts`
- `src/persistence/memoryCitySaveStore.ts`
- `tests/runtime/persistence/citySaveStoreContract.ts`
- `tests/runtime/persistence/memoryCitySaveStore.test.ts`
- `tests/runtime/delayedCitySaveStore.ts`

Delete:

- `src/persistence/envelope.ts`
- `src/persistence/envelopeInspection.ts`
- old `saveStore.ts` and `memorySaveStore.ts` after imports migrate;
- envelope tests and generalized store tests after focused behavior is covered;
- checkpoint/autosave raw fixtures and helpers.

Modify only where the removed public API is consumed:

- `src/runtime/createGameRuntime.ts`
- `src/runtime/persistenceCoordinator.ts`
- `src/runtime/types.ts`
- focused runtime and persistence tests.

Do not broadly refactor unrelated gameplay, Svelte UI, backend host, or Rust domain code.

## 16. Sequencing

1. Add the new contract, memory implementation, and focused behavior tests.
2. Migrate Save, Load, and Rename.
3. Replace pending/finalize New City with one atomic create.
4. Remove store capability registries.
5. Delete the legacy envelope/store platform and obsolete tests.
6. Run the full verification suite and inspect the diff for material net deletion.

The implementation should be one atomic PR. Splitting the migration would either leave a dual persistence API on `main` or require a temporary compatibility layer.

## 17. Acceptance criteria

- The active public store has exactly six operations.
- City records contain only current city-list metadata and one opaque snapshot.
- No checkpoint, autosave, generation, duplicate, pending/finalize, compatibility, storage identity, or multi-realm store API remains.
- No duplicated gameplay summary, snapshot schema version, or application version remains in host records.
- Atomic create and atomic replace-existing behavior are tested.
- IndexedDB and Tauri adapters can implement the contract without future-feature stubs.
- The memory fake and shared tests are small and direct.
- Old development formats are deleted rather than adapted.
- The current runtime compiles and preserves Save, Load, Rename, New City, and delete-related behavior through the bridge.
- Production and test code show material net reduction.

## 18. Review guardrails

Reject an implementation that:

- introduces an old-to-new compatibility adapter;
- retains an old operation under a new name;
- validates snapshot contents in TypeScript;
- adds metadata for a future city-library feature without a current consumer;
- introduces repository/service/manager base classes or adapter registries;
- adds generic transactions, capability policy, migrations, or repair frameworks;
- broadens the runtime rewrite beyond the minimum bridge owned by HPA-548;
- keeps tests solely to preserve previous coverage counts.
