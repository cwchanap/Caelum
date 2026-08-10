# HPA-343 IndexedDB City Save Store Design

**Issue:** HPA-343  
**Status:** Proposed  
**Decision date:** 2026-08-09  
**Prerequisite:** HPA-548  
**Downstream:** HPA-345, HPA-346

## 1. Decision

Implement the browser/WASM save adapter as one small raw IndexedDB module:

```text
src/persistence/indexedDbCitySaveStore.ts
```

It implements the existing six-operation `CitySaveStore` directly with:

- one database;
- one `cities` object store;
- out-of-line keys using `record.city.id`;
- no secondary indexes or metadata store;
- `getAll()` plus the existing shared city-summary ordering for city lists;
- native IndexedDB cloning and transaction atomicity for create/update/rename/delete;
- generic `failed` mapping for unexpected IndexedDB errors;
- `ConstraintError` mapped to `conflict` only for create-only writes.

Extend the existing store contract module with two tiny shared production helpers once IndexedDB becomes the second concrete adapter:

- `citySummaryFromRecord(record)` for the record-to-list projection;
- `citySaveStoreError(operation, code, options?)` for the common `CitySaveStoreError` envelope.

These helpers share only domain shape. IndexedDB request handling, transaction behavior, and browser-error-to-store-code mapping stay adapter-local. Do not introduce a repository, storage service, transaction service, or base adapter.

Use raw IndexedDB rather than adding a production storage library. Add `fake-indexeddb` only as a development dependency so the real adapter can run in the existing Node Vitest runtime project without introducing a browser-test project or wiring persistence into the application before HPA-345.

HPA-343 is adapter-only. Do not change `src/main.ts`, `createGameRuntime()`, Svelte UI, or the current anonymous development bootstrap. HPA-345 owns the first player-visible no-city/New City flow and is where the real browser adapter becomes a runtime dependency.

## 2. Why HPA-343 is next

HPA-543 is implemented and merged, so the remaining Phase 1 critical path is:

```text
HPA-343 IndexedDB adapter -> HPA-345 New City flow -> HPA-346 city library
```

HPA-344 is also unblocked and remains required for native desktop, but completing it first does not unlock the first real player-facing city flow. The browser/WASM path is the faster development and automated UI-test host, so HPA-343 gives the best next increment.

The current repository already has the correct abstraction boundary:

- `CitySaveStore` defines exactly six operations;
- `MemoryCitySaveStore` proves the contract in memory;
- `workingSaveRuntime.ts` consumes only `CitySaveStore`;
- `createGameRuntime()` accepts an optional `saveStore`;
- `src/main.ts` intentionally does not provide one yet.

The missing piece is durable browser storage, not another persistence architecture layer.

## 3. Approaches considered

### A. Raw IndexedDB + small file-local Promise bridge — selected

Keep a lazy database connection inside one closure and wrap only `IDBRequest` and transaction completion in file-local Promise helpers.

**Advantages**

- no production dependency;
- directly matches the six-operation contract;
- one module owns all browser-storage details;
- IndexedDB itself performs the storage clone instead of copying the complete game snapshot in application code first;
- easy to delete or reshape while development saves remain disposable;
- no generic repository or transaction abstraction leaks into the rest of the application.

**Cost**

- a small amount of explicit IndexedDB request/transaction ceremony;
- transaction-scoped code must preserve IndexedDB's active-transaction rule.

### B. Add an `idb`-style production wrapper library — rejected

This would reduce some Promise boilerplate, but the adapter is only one object store with six operations. A permanent runtime dependency is not justified for this scope.

### C. Test only through Playwright in a real browser — rejected for HPA-343

That would avoid `fake-indexeddb`, but HPA-343 is not wired into the application yet. Exposing test-only browser hooks or prematurely changing bootstrap would cost more architecture than one development-only IndexedDB implementation.

Real-browser proof is intentionally downstream. HPA-345 is the first task allowed to wire the adapter and prove a real Rust/WASM New City snapshot is accepted by Chromium IndexedDB. HPA-346 owns the complete player workflow that proves a created city survives reload and can be Continued/Loaded once the city library exists.

## 4. Scope boundary

### HPA-343 owns

- `src/persistence/indexedDbCitySaveStore.ts`;
- one disposable browser database schema;
- create/list/read/update/rename/delete behavior;
- create conflict handling;
- definite IndexedDB failure mapping;
- persistence across multiple adapter instances using the same database name;
- adapter-focused tests using `fake-indexeddb`;
- one Node test that stores a real `createWasmBackend().snapshotForSave()` payload;
- exporting `citySummaryFromRecord()` from `citySaveStore.ts` and using it from memory + IndexedDB adapters;
- exporting `citySaveStoreError()` from `citySaveStore.ts` and using it for the shared store-error envelope;
- making the shared `CitySaveStore` contract suite adapter-neutral;
- proving multi-city `listCities()` ordering through the shared adapter contract, not only through the pure sorting helper;
- one genuine IndexedDB abort-path test using an uncloneable update;
- architecture documentation for the browser store boundary.

### HPA-343 does not own

- runtime/bootstrap wiring;
- New City or city-library UI;
- native Tauri storage;
- migrations or legacy readers;
- autosaves, checkpoints, save history, import/export, cloud sync, recovery, or repair;
- multi-tab/window locking;
- encryption, signing, checksums, quota handling, vendor matrices, or security frameworks;
- snapshot inspection or validation in TypeScript;
- exhaustive request/abort/quota failure matrices.

## 5. Storage layout

Use these module-local constants:

```ts
const DEFAULT_DATABASE_NAME = "caelum-city-saves-v1";
const DATABASE_VERSION = 1;
const CITY_STORE_NAME = "cities";
```

The object store uses no key path. Each operation supplies `record.city.id` as the out-of-line IndexedDB key:

```ts
store.add(record, record.city.id);
store.put(record, record.city.id);
store.get(cityId);
store.getKey(cityId);
store.delete(cityId);
```

This avoids duplicating the ID at the top level or inventing a storage-only record shape.

There is no index. `listCities()` reads the records, maps each through the shared `citySummaryFromRecord()` helper, and calls `sortCitySummaries()`.

Breaking schema changes during active development should use a new database name/version and may leave/delete old development data. Do not write upgrade migrations or dual readers.

## 6. Shared store helpers

### Record-to-summary projection

The existing memory adapter already derives the same four fields that every durable adapter must expose. Once IndexedDB becomes the second concrete adapter, keep that projection in the store contract module:

```ts
export function citySummaryFromRecord(record: CitySaveRecord): CitySummary {
  return {
    id: record.city.id,
    name: record.city.name,
    createdAt: record.city.createdAt,
    savedAt: record.savedAt,
  };
}
```

`MemoryCitySaveStore` deletes its private `summaryFor()` and imports this helper. The IndexedDB adapter uses the same helper for list/create/update/rename results.

### Store-error envelope

The shape of a `CitySaveStoreError` is also shared contract behavior. Keep one constructor beside the types:

```ts
export interface CitySaveStoreErrorOptions {
  cityId?: string;
  diagnostic?: string;
}

export function citySaveStoreError(
  operation: CitySaveStoreOperation,
  code: CitySaveStoreErrorCode,
  options: CitySaveStoreErrorOptions = {},
): CitySaveStoreError {
  return {
    operation,
    code,
    ...(options.cityId === undefined ? {} : { cityId: options.cityId }),
    ...(code === "failed" && options.diagnostic !== undefined
      ? { diagnostic: options.diagnostic }
      : {}),
  };
}
```

The helper does not decide whether an IndexedDB error is `conflict` or `failed`; each adapter still owns that mapping. It only prevents the shared envelope and `diagnostic` rule from drifting across memory, runtime throw-mapping, IndexedDB, and later native storage.

`MemoryCitySaveStore` may keep a tiny local `errorResult<T>()` wrapper that delegates to `citySaveStoreError()`. `workingSaveRuntime.ts` uses the same helper when a store call throws. IndexedDB likewise keeps a file-local result wrapper around the shared error object.

Do not extract IndexedDB request Promise wrappers, transaction wrappers, database opening, or browser error-name mapping into shared modules.

## 7. Module API

Expose one factory:

```ts
export interface IndexedDbCitySaveStoreOptions {
  indexedDB?: IDBFactory;
  databaseName?: string;
}

export function createIndexedDbCitySaveStore(
  options: IndexedDbCitySaveStoreOptions = {},
): CitySaveStore;
```

Production uses `globalThis.indexedDB` and the default database name. Tests inject `fake-indexeddb` plus a unique database name.

Do not expose the `IDBDatabase`, object store, transaction helpers, a `close()` lifecycle, or testing failure controls. HPA-343 needs no public API beyond `CitySaveStore`.

The adapter lazily opens and caches one connection Promise per factory instance. If IndexedDB is unavailable or opening fails, operations return the existing generic `failed` result.

## 8. Operation semantics

### `listCities()`

1. Open the database.
2. Start one `readonly` transaction.
3. `getAll()` records from `cities`.
4. Map records through `citySummaryFromRecord()`.
5. Sort with `sortCitySummaries()`.
6. Return the new summary array after the transaction completes.

Do not persist a second summary/index record.

The shared adapter contract creates multiple cities in an order that matches neither Map insertion order nor IndexedDB key order, then asserts `listCities()` returns saved-time-descending / ID-ascending order. This prevents an adapter from accidentally returning raw storage order.

### `readCity(id)`

Use `get(id)`. Missing values return `notFound`. IndexedDB returns a structured clone, so callers cannot mutate stored state through the returned record.

### `createCity(record)`

Use one `readwrite` transaction and call:

```ts
store.add(record, record.city.id);
```

Do **not** `structuredClone(record)` first. IndexedDB clones the value as part of `add()`. A manual pre-clone would copy the full game snapshot twice and would move `DataCloneError` outside the transaction helper.

Before awaiting the transaction, derive the returned `CitySummary` from primitives:

```ts
const summary = citySummaryFromRecord(record);
```

Then:

- `ConstraintError` -> `conflict`;
- every other IndexedDB failure -> `failed`;
- success returns the pre-derived summary only after transaction completion.

`add` supplies create-only semantics without a read-before-write race or custom conflict layer.

### `updateCity(id, update)`

Use one `readwrite` transaction:

1. `get(id)`;
2. return `notFound` if absent;
3. build a complete replacement preserving stored `city.id`, `city.name`, and `city.createdAt`;
4. derive the replacement summary;
5. call `put(replacement, id)` directly, letting IndexedDB perform the storage clone;
6. wait for transaction completion;
7. return the pre-derived summary.

Do **not** pre-clone `update`. If `update.snapshot` is uncloneable, `put()` throws `DataCloneError` while `runTransaction()` owns the transaction. Its catch aborts the transaction, making the focused failure test a real proof that the prior committed record survives an adapter write failure.

The read and replacement write stay in the same transaction so rename metadata cannot be accidentally reverted by this adapter.

### `renameCity(id, name)`

Use one `readwrite` transaction, read the current record, replace only `city.name`, derive the summary, then `put` the full record under the same ID. Return the summary only after transaction completion.

### `deleteCity(id)`

Use one `readwrite` transaction. Call `getKey(id)` to test existence without cloning the complete game snapshot. Return `notFound` if the result is `undefined`; otherwise issue `delete(id)` in the same transaction.

No operation validates snapshot fields or gameplay schema.

## 9. Error mapping

Keep the existing store taxonomy exactly:

```ts
type CitySaveStoreErrorCode = "notFound" | "conflict" | "failed";
```

Rules:

- application-observed missing record -> `notFound`;
- `createCity` IndexedDB `ConstraintError` -> `conflict`;
- unavailable IndexedDB, open failures, transaction aborts, cloning failures, and other request failures -> `failed`.

Build the envelope with `citySaveStoreError()`. A development diagnostic may contain the IndexedDB error `name`, but UI behavior must depend only on the existing code/operation/city ID.

Do not classify quota, browser vendor, corruption, permission, or retry categories.

## 10. Transaction and atomicity rules

Rely on normal IndexedDB transaction semantics rather than adding rollback code.

- `createCity` uses `add`, so a conflict cannot overwrite the prior value.
- `updateCity` and `renameCity` read and write in one `readwrite` transaction.
- `DataCloneError` from `add/put`, request failure, or transaction failure aborts the transaction and preserves the prior committed state.
- `deleteCity` performs its existence check and delete in one transaction.
- a mutating operation does not return success until the transaction's `oncomplete` fires; request success alone is not a commit signal.

The file-local transaction runner has one important invariant:

> Inside a transaction callback, await only IndexedDB requests issued by that transaction. Do not await timers, network work, another `openDatabase()`, or unrelated promises between requests.

IndexedDB transactions are active during their creation task and associated request event dispatch. A non-IDB asynchronous gap can make the transaction inactive or allow it to commit before the next request. Keep this invariant as a comment next to `runTransaction()` because `fake-indexeddb` is not sufficient evidence for browser event-loop timing.

Do not add a persistence queue, mutex, retry system, or multi-tab ownership model. The existing working-save runtime already serializes mutating player persistence actions within the supported single runtime.

## 11. Test strategy

The current shared contract requires every harness to expose `failNext`, which is appropriate for the in-memory adapter but would force test-only failure injection into every real adapter. HPA-343 narrows that harness:

- `defineCitySaveStoreContract(name, createStore)` receives only a `CitySaveStore` factory;
- deterministic common behavior remains in the shared contract;
- the shared contract adds a multi-city `listCities()` ordering case that fails for raw Map insertion order and raw IndexedDB key order;
- injected create/update/rename atomicity failures move into `memoryCitySaveStore.test.ts`;
- memory-specific `failNext` remains unchanged and does not enter the production contract.

Avoid triplicating generic test setup. `citySaveStoreContract.ts` exports only the small helpers its adapter suites need:

- `expectCitySaveStoreOk()`;
- `makeCitySaveRecord()`.

Keep adapter-specific database-name/factory setup local. The existing `tests/fixtures/citySave.ts` fixture remains useful for cloneable Rust-shaped records and should be reused by the IndexedDB reopen test. The generic record helper remains useful for the deliberately uncloneable failure case.

The IndexedDB adapter runs the common contract plus focused storage tests:

1. **Reopen with a Rust-shaped fixture.** Create a record through `tests/fixtures/citySave.ts`, write it with one adapter instance, then read the same record through a second instance using the same database name.
2. **Real WASM snapshot round trip.** Call `createWasmBackend().snapshotForSave()`, place the returned real `RustGameSnapshot` into a `CitySaveRecord`, `createCity()` it, then `readCity()` and compare the snapshot.
3. **Genuine abort-path atomicity.** Seed a valid record, call `updateCity()` with an uncloneable function inside `snapshot`, assert `failed`, then read and verify the complete prior record is unchanged. Because there is no pre-clone, the `DataCloneError` occurs at `store.put()` inside `runTransaction()` and exercises the transaction abort path.

The shared contract already covers empty list, create/list/read, create conflict preserving the original, update identity preservation, rename, delete/notFound, list ordering, and detached values.

One representative real adapter failure is enough. Rename/delete use the same file-local transaction completion path; do not add retry/abort/quota matrices or production failure hooks merely to exercise every mutation kind.

`fake-indexeddb` is a deterministic Node test implementation, not evidence that Chromium/WebKit browser integration is complete. The real-WASM Node test proves the current Rust/WASM snapshot shape is accepted by the test IndexedDB implementation; it does not replace browser proof.

HPA-345's Chromium New City smoke must specifically prove that a real Rust/WASM candidate snapshot is accepted by actual browser IndexedDB. HPA-346 later adds reload + Continue/Load proof once that UI exists.

## 12. Bootstrap and downstream handoff

HPA-343 deliberately leaves `src/main.ts` unchanged. The app continues to boot the current anonymous development sandbox without a save store.

HPA-345 will:

1. create the browser store;
2. pass it through the existing `createGameRuntime({ saveStore })` option;
3. add the no-city/New City player flow;
4. provide the first real Chromium proof that a real Rust/WASM New City snapshot writes through the real IndexedDB adapter.

HPA-346, once the city library/Continue/Load UI exists, owns the full player-visible persistence smoke flow:

```text
New City -> reload page -> Continue/Load -> restored city
```

This split matters: pulling Load/Continue into HPA-345 solely to strengthen an adapter test would violate the existing Phase 1 ticket boundary.

## 13. Acceptance criteria

- [ ] One raw IndexedDB module implements all six `CitySaveStore` operations.
- [ ] One `cities` object store contains full `CitySaveRecord` values keyed by `record.city.id`.
- [ ] No metadata store, index, repository abstraction, or persistence service is added.
- [ ] Memory and IndexedDB adapters reuse `citySummaryFromRecord()` rather than duplicating summary projection.
- [ ] Memory/runtime/IndexedDB store failures reuse `citySaveStoreError()` for the shared error envelope while retaining adapter-specific error mapping.
- [ ] The shared adapter contract proves multi-city saved-time/ID ordering through `listCities()`.
- [ ] `createCity` cannot overwrite an existing city.
- [ ] IndexedDB storage performs the value clone; the adapter does not copy the full snapshot with a redundant pre-`structuredClone()`.
- [ ] The uncloneable-update test reaches `put()` inside the active transaction and proves failure preserves the prior record.
- [ ] Returned/read values are detached from committed storage.
- [ ] A second adapter instance can read a Rust-shaped record committed by the first instance.
- [ ] A real `snapshotForSave()` payload can round-trip through the IndexedDB adapter in the runtime Vitest project.
- [ ] Delete existence checks use `getKey()` rather than reading/cloning the whole city record.
- [ ] Mutating operations wait for IndexedDB transaction completion before reporting success.
- [ ] Transaction callbacks contain no non-IndexedDB asynchronous gaps between requests.
- [ ] Runtime/UI code does not access IndexedDB and `src/main.ts` is unchanged.
- [ ] No migration, compatibility, security, recovery, retry, quota, or multi-tab framework is introduced.
- [ ] Tests use the real adapter through `fake-indexeddb` and remain in the existing runtime Vitest project.
- [ ] Real-browser wiring/proof remains downstream rather than being simulated by HPA-343.