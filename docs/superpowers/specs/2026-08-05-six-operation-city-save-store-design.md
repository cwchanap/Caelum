# Six-Operation CitySaveStore Design

**Issue:** HPA-548  
**Status:** Proposed  
**Decision date:** 2026-08-05  
**Related work:** HPA-543, HPA-547, HPA-343, HPA-344, HPA-346

## 1. Decision

Replace the versioned `SaveEnvelope` and 19-operation `SaveStore` platform with one six-operation `CitySaveStore` over a complete current-development record per city.

Keep:

- opaque application-generated city IDs;
- one working save per city;
- deterministic listing;
- atomic create-only and replace-existing writes;
- detached values at adapter boundaries;
- Rust as the only gameplay snapshot validator.

Remove:

- envelope/app/schema/summary metadata;
- checkpoints, autosaves, generations, and duplicate-city;
- pending/finalize/read-back reconciliation;
- store identity, realm capability, and shared-store registries;
- compatibility/corruption taxonomies and reusable capability matrices;
- the persistence-specific terminal recovery and lease-pin model whose triggers disappear with pending/finalize.

This is a breaking active-development change. Old APIs, fixtures, and development data are deleted rather than migrated.

## 2. Scope boundaries

HPA-548 owns the store reduction and the minimum runtime cutover required to consume it.

It does **not** implement:

- IndexedDB storage (HPA-343);
- Tauri application-data files (HPA-344);
- city-library UI (HPA-346);
- pure sandbox candidate construction or host simplification (HPA-547);
- replacement of the remaining runtime queues, leases, session tokens, and revision tracking with one busy gate (HPA-543);
- checkpoints, autosave, recovery frameworks, import/export, cloud sync, migrations, encryption, checksums, or multi-window/process correctness.

The implementation remains one atomic PR. Splitting it would leave two persistence APIs on `main` or require a temporary adapter.

## 3. Record and store contract

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

### 3.1 Contract invariants

- `readCity(id)` either returns `notFound` or a detached record whose `city.id === id`.
- `createCity` is create-only and returns `conflict` when the ID exists.
- `updateCity` is replace-existing, never upsert, and returns `notFound` when absent.
- `renameCity` changes only `city.name`.
- `deleteCity` returns `notFound` when absent.
- `listCities` sorts valid `savedAt` values descending, then `id` ascending; invalid timestamps follow valid timestamps and sort by ID.
- Store implementations do not inspect snapshot keys, schema versions, or gameplay invariants.
- Expected adapter failures use typed results. Unexpected throws are caught at the adapter/runtime boundary and collapsed to `unavailable` or `failed`; HPA-548 does not add ambiguous-write reconciliation.

The runtime trusts the store-key invariant instead of retaining envelope or city-ID inspection during load.

### 3.2 Reuse, not reinvention

Move the existing `compareIds`, timestamp comparison, and `sortCitySummaries` behavior from `saveStore.ts` into `citySaveStore.ts`, adapting only:

- `cityId` to `id`;
- nullable `savedAt` to required `savedAt`.

Retain focused coverage for ordering and input-array non-mutation. Do not create a second sorting design.

## 4. Memory implementation

`memoryCitySaveStore.ts` uses:

- one `Map<string, CitySaveRecord>`;
- one small per-operation failure queue for tests;
- `structuredClone` at committed input and returned-value boundaries.

It has no raw corruption seeds, checkpoint/autosave maps, pending sets, generation state, storage identity, realm flags, or capability switches.

For `updateCity`, the complete detached replacement is prepared before the injected failure and commit point. A failed update therefore leaves the previous map entry unchanged.

## 5. Runtime bridge

HPA-548 keeps the current queue/lease/session/revision machinery only as an internal bridge. Its public persistence surface must not retain deleted product concepts.

### 5.1 Controller and view surface

After HPA-548, the controller is limited to:

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
```

Use:

```ts
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

Remove:

- multi-kind `LoadSource` and `readForLoadSource`;
- `runGameplayWrite`, `GameplayWriteRequest`, and `GenerationWrite*`;
- checkpoint/autosave operation, status, and no-active-city variants;
- `kind: "envelope"` errors;
- `multiRealmNewCityUnsupported` and realm admission;
- generation save-status kinds.

`RuntimeSaveStatus` represents only working-save progress. `RuntimeLoadStatus` carries only a city ID.

### 5.2 Save Now

1. Capture the canonical paused snapshot through `backend.snapshotForSave()`.
2. Build a full `CitySaveRecord` from active identity, a new `savedAt`, and the captured snapshot.
3. Call `updateCity(record)`.
4. On success, preserve current stale-session/revision rules, update `lastSavedAt`, and clear the working persistence baseline as today.
5. On failure, keep dirty state and the previous record.

Save Now must never create a missing city. Tests and fixtures that previously used upsert must call `createCity` once during setup, then exercise `updateCity`.

### 5.3 Load

1. Call `readCity(cityId)`.
2. Rely on the store contract that `record.city.id === cityId`; do not retain a TypeScript identity-inspection branch.
3. Call `backend.restoreSnapshot({ snapshot: record.snapshot })`.
4. After successful restore, publish:
   - `activeCity = record.city`;
   - `lastSavedAt = record.savedAt`;
   - the existing working-load clean revision/session state.
5. A failed read or backend restore leaves gameplay, UI, active identity, save time, and dirty bookkeeping unchanged.
6. Backend restore failures remain backend errors. There is no envelope or compatibility error layer.

### 5.4 Rename

Call `renameCity(activeCity.id, name)` through the existing current-city ordering path. On success, publish only the returned name and preserve gameplay state.

### 5.5 New City before HPA-547/HPA-543

The current backend mutates during `createSandbox`, so this bridge temporarily remains backend-first:

1. Reserve the existing lifecycle path and capture prior canonical state.
2. Call `backend.createSandbox(request)`.
3. Capture the candidate with `snapshotForSave()`.
4. Build one `CitySaveRecord`.
5. Call `createCity(record)` once.
6. On conflict or definite failure, restore prior backend state.
7. On success while alive, publish the candidate and active city directly.
8. If disposal starts after create succeeds, do not publish; attempt one `deleteCity(id)` cleanup before releasing the runtime.

There is no finalize call, pending marker, read-back classification, bootstrap repair, or multi-realm policy.

If the best-effort delete fails, the New City operation returns the concise store failure. The runtime still drains and releases its lease/backend ownership. A valid extra city may remain listable; this is preferable to a terminal repair framework during active development.

### 5.6 Persistence recovery and disposal cleanup

Because pending/finalize, bootstrap reconciliation, realm ambiguity, and lease pinning are removed, delete their public residue in the same PR:

- `RuntimeSnapshot.recovery`;
- `RecoveryRequiredDetails`;
- `RuntimeRecoveryState`;
- `BootstrapRecoveryError`;
- recovery variants of `RuntimeDisposeResult`;
- recovery-only UI and tests;
- dispose documentation that warns callers about permanently pinned storage.

Simplify `RuntimeController.dispose()` to `Promise<void>` after it stops admission, drains already-admitted work, releases the temporary persistence lease, and releases backend ownership.

A concurrent New City cleanup failure is reported by that operation promise, not by a persistent recovery state. Disposal still waits for the admitted operation to settle before releasing.

### 5.7 Coordination bridge

Delete `StorageIdentity`, store capability getters, the identity `Map`, object-identity `WeakMap`, registry reset helpers, and `resolvePersistenceCoordinator`.

Each runtime constructs the temporary coordinator directly:

```ts
const coordinator = createSharedPersistenceCoordinator();
const lease = await coordinator.acquireLease();
```

This intentionally removes cross-runtime store-identity handoff. Tests that rely on shared FIFO/fence state across runtime lifetimes are deleted or rewritten. Backend ownership remains unchanged for HPA-547.

HPA-543 later removes the remaining runtime-local queues, leases, tokens, and revision baselines without another store migration.

## 6. Error policy

Keep only:

- `notFound`;
- `conflict`;
- `unavailable`;
- `failed`.

`diagnostic` is optional and never controls behavior. Native diagnostics do not expose arbitrary paths.

Do not add retry schedules, timeout systems, crash certification, repair instructions, or vendor-specific categories.

## 7. Testing strategy

### Store behavior

- create/list/read;
- create conflict;
- update success and missing-city failure;
- failed update preserves the previous record;
- rename;
- delete;
- deterministic sorting;
- detached inputs and outputs.

### Runtime bridge behavior

- Save success and failure;
- Save Now returns `notFound` rather than creating missing storage;
- Load publishes `record.city` and `record.savedAt` only after restore succeeds;
- failed read/restore preserves current runtime state;
- Rename;
- New City success;
- conflict/definite failure rollback;
- post-disposal create success attempts one cleanup and never publishes;
- cleanup failure returns an operation failure but does not pin disposal;
- disposal/recreation tests no longer assume shared store coordinator state.

Delete tests that exist only for envelopes, generations, pending/finalize, ambiguous read-back, bootstrap repair, multi-realm policy, storage identity, or recovery UI.

## 8. File impact

Create:

- `src/persistence/citySaveStore.ts`
- `src/persistence/memoryCitySaveStore.ts`
- `tests/runtime/persistence/citySaveStoreContract.ts`
- `tests/runtime/persistence/memoryCitySaveStore.test.ts`
- `tests/runtime/delayedCitySaveStore.ts`

Delete after cutover:

- `src/persistence/envelope.ts`
- `src/persistence/envelopeInspection.ts`
- `src/persistence/saveStore.ts`
- `src/persistence/memorySaveStore.ts`
- generalized envelope/store tests and wrappers.

Known direct consumers to modify include:

- `src/runtime/createGameRuntime.ts`
- `src/runtime/persistenceCoordinator.ts`
- `src/runtime/types.ts`
- `src/App.svelte`
- `tests/runtime/persistenceCoordinator.test.ts`
- `tests/runtime/gameRuntime.test.ts`
- `tests/runtime/constructionCleanup.test.ts`
- `tests/runtime/recoveryPublication.test.ts`
- `tests/runtime/backendOwnership.test.ts`
- `tests/runtime/postDisposalBackendFailure.test.ts`
- `tests/ui/appShell.test.ts`
- persistence fixtures/helpers and every file returned by the removed-symbol and `cityCreatedAt` scans.

`tests/ui/pointerEvents.test.ts` imports `createGameRuntime` but does not currently consume save-store or active-city options. It is included in compile verification and changes only if the cutover produces a real type or behavior failure.

Do not broadly refactor unrelated gameplay, canvas, backend-host, or Rust code.

## 9. Main risks and accepted tradeoffs

### 9.1 Hollow runtime API

Risk: deleting store methods while preserving checkpoint/autosave controller unions would freeze a phantom platform into tests and force HPA-543 to break callers again.

Decision: remove those controller types and methods in HPA-548.

### 9.2 Late create cleanup

Risk: a create may succeed after disposal begins and cleanup may fail.

Decision: return the cleanup failure from the operation, release the runtime normally, and allow the valid city record to remain. No lease pin or repair state.

### 9.3 Load without envelope inspection

Risk: residual TypeScript inspection could survive only to check identity or schema.

Decision: the store guarantees key/record identity and Rust validates the snapshot. The runtime performs neither check.

### 9.4 Upsert removal

Risk: tests or callers may recreate upsert for convenience.

Decision: setup uses `createCity`; Save Now always uses `updateCity` and may return `notFound`.

### 9.5 Per-runtime coordinator

Risk: disposal/recreate tests currently assume shared store-identity queues and fences.

Decision: remove that guarantee intentionally and rewrite tests around runtime-local coordination. Backend ownership remains the only cross-runtime handoff in this bridge.

### 9.6 Large field/type blast radius

Risk: `cityCreatedAt -> createdAt`, recovery-type deletion, and controller collapse affect many fixtures and assertions.

Decision: use repository-wide symbol inventories before editing and require zero relevant matches at the final gate.

## 10. Acceptance criteria

- Exactly six store operations remain.
- `CitySaveRecord` contains only city identity, `savedAt`, and opaque snapshot.
- Existing city sorting behavior is moved and field-adapted rather than redesigned.
- Save Now is update-only and never upserts.
- The runtime controller contains no checkpoint/autosave/generation/envelope/multi-realm surface.
- Load publishes record identity and save time only after Rust restore succeeds.
- Pending/finalize, store registries, persistence recovery/pinning, and recovery UI are removed.
- The remaining coordinator is runtime-local and uses only `CitySaveStore`.
- Old formats and APIs are deleted without adapters or migration.
- Production persistence code and related runtime persistence tests both show material net deletion.
