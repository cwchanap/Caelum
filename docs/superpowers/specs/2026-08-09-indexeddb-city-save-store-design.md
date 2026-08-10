# HPA-343 IndexedDB City Save Store Design

**Issue:** HPA-343  
**Status:** Proposed  
**Decision date:** 2026-08-09  
**Prerequisite:** HPA-548  
**Downstream:** HPA-345

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
- `getAll()` + the existing `sortCitySummaries()` helper for city-list ordering;
- native IndexedDB transaction atomicity for create/update/rename/delete;
- generic `failed` mapping for unexpected IndexedDB errors;
- `ConstraintError` mapped to `conflict` only for create-only writes.

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

### A. Raw IndexedDB + two tiny Promise helpers — selected

Keep a lazy database connection inside one closure and wrap only `IDBRequest` and transaction completion in local Promise helpers.

**Advantages**

- no production dependency;
- directly matches the six-operation contract;
- one module owns all browser-storage details;
- easy to delete or reshape while development saves remain disposable;
- no generic repository or transaction abstraction leaks into the rest of the application.

**Cost**

- roughly a few dozen lines of IndexedDB request/transaction ceremony.

### B. Add an `idb`-style production wrapper library — rejected

This would reduce some Promise boilerplate, but the adapter is only one object store with six operations. A permanent runtime dependency is not justified for this scope.

### C. Test only through Playwright in a real browser — rejected

That would avoid `fake-indexeddb`, but HPA-343 is not wired into the application yet. Exposing test-only browser hooks or prematurely changing bootstrap would cost more architecture than one development-only IndexedDB implementation.

## 4. Scope boundary

### HPA-343 owns

- `src/persistence/indexedDbCitySaveStore.ts`;
- one disposable browser database schema;
- create/list/read/update/rename/delete behavior;
- create conflict handling;
- definite IndexedDB failure mapping;
- persistence across multiple adapter instances using the same database name;
- adapter-focused tests using `fake-indexeddb`;
- a small cleanup to make the shared `CitySaveStore` contract suite adapter-neutral;
- architecture documentation for the browser store boundary.

### HPA-343 does not own

- runtime/bootstrap wiring;
- New City or city-library UI;
- native Tauri storage;
- migrations or legacy readers;
- autosaves, checkpoints, save history, import/export, cloud sync, recovery, or repair;
- multi-tab/window locking;
- encryption, signing, checksums, quota handling, vendor matrices, or security frameworks;
- snapshot inspection or validation in TypeScript.

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
store.delete(cityId);
```

This avoids duplicating the ID at the top level or inventing a storage-only record shape.

There is no index. `listCities()` reads the records, derives `CitySummary` values, and calls the existing `sortCitySummaries()` helper.

Breaking schema changes during active development should use a new database name/version and may leave/delete old development data. Do not write upgrade migrations or dual readers.

## 6. Module API

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

## 7. Operation semantics

### `listCities()`

1. Open the database.
2. Start one `readonly` transaction.
3. `getAll()` records from `cities`.
4. Derive `CitySummary` values from each record.
5. Sort with `sortCitySummaries()`.
6. Return the new summary array.

Do not persist a second summary/index record.

### `readCity(id)`

Use `get(id)`. Missing values return `notFound`. IndexedDB already returns a structured clone, so callers cannot mutate stored state through the returned record.

### `createCity(record)`

Use one `readwrite` transaction and `add(record, record.city.id)`.

- `ConstraintError` -> `conflict`;
- every other IndexedDB failure -> `failed`;
- success returns a newly derived `CitySummary`.

`add` supplies create-only semantics without a read-before-write race or custom conflict layer.

### `updateCity(id, update)`

Use one `readwrite` transaction:

1. `get(id)`;
2. return `notFound` if absent;
3. build a complete replacement preserving stored `city.id`, `city.name`, and `city.createdAt`;
4. `put(replacement, id)`;
5. wait for transaction completion;
6. return the replacement summary.

The read and replacement write stay in the same transaction so rename metadata cannot be accidentally reverted by this adapter.

### `renameCity(id, name)`

Use one `readwrite` transaction, read the current record, replace only `city.name`, then `put` the full record under the same ID.

### `deleteCity(id)`

Use one `readwrite` transaction, first read the ID so missing records map to `notFound`, then delete it.

No operation validates snapshot fields or gameplay schema.

## 8. Error mapping

Keep the existing store taxonomy exactly:

```ts
type CitySaveStoreErrorCode = "notFound" | "conflict" | "failed";
```

Rules:

- application-observed missing record -> `notFound`;
- `createCity` IndexedDB `ConstraintError` -> `conflict`;
- unavailable IndexedDB, open failures, transaction aborts, cloning failures, and other request failures -> `failed`.

A development diagnostic may contain the IndexedDB error `name`, but UI behavior must depend only on the existing code/operation/city ID.

Do not classify quota, browser vendor, corruption, permission, or retry categories.

## 9. Atomicity

Rely on normal IndexedDB transaction semantics rather than adding rollback code.

- `createCity` uses `add`, so a conflict cannot overwrite the prior value.
- `updateCity` and `renameCity` read and write in one `readwrite` transaction.
- request or transaction failure aborts the transaction, preserving the prior committed record.
- `deleteCity` performs its existence check and delete in one transaction.

Do not add a persistence queue, mutex, retry system, or multi-tab ownership model. The existing working-save runtime already serializes mutating player persistence actions within the supported single runtime.

## 10. Test strategy

The current shared contract requires every harness to expose `failNext`, which is appropriate for the in-memory adapter but would force test-only failure injection into every real adapter. HPA-343 should narrow that harness:

- keep common deterministic behavior in `defineCitySaveStoreContract()`;
- move injected-failure atomicity tests into `memoryCitySaveStore.test.ts`;
- do not add a `failNext` API to IndexedDB.

The IndexedDB adapter runs the common contract plus focused real-storage tests:

- empty list;
- create/list/read;
- create conflict preserves original;
- update preserves identity metadata;
- rename;
- delete/notFound;
- detached values through IndexedDB structured cloning;
- persisted data visible through a second adapter instance with the same database name;
- an uncloneable update value produces `failed` and leaves the previous committed record intact.

Use one `fake-indexeddb` dependency. Do not add a new Vitest browser project, custom fake database, Playwright hook, migration matrix, quota matrix, or exhaustive transaction-abort suite.

## 11. Bootstrap and downstream handoff

HPA-343 deliberately leaves `src/main.ts` unchanged. The app continues to boot the current anonymous development sandbox without a save store.

HPA-345 will:

1. create the browser store;
2. pass it through the existing `createGameRuntime({ saveStore })` option;
3. add the no-city/New City player flow;
4. prove the first real browser city persists through IndexedDB.

This keeps storage implementation and player-flow implementation independently reviewable.

## 12. Acceptance criteria

- [ ] One raw IndexedDB module implements all six `CitySaveStore` operations.
- [ ] One `cities` object store contains full `CitySaveRecord` values keyed by `record.city.id`.
- [ ] No metadata store, index, repository abstraction, or persistence service is added.
- [ ] `createCity` cannot overwrite an existing city.
- [ ] A definite failed update leaves the prior record intact.
- [ ] Returned/read values are detached from committed storage.
- [ ] A second adapter instance can read previously committed data from the same database.
- [ ] Runtime/UI code does not access IndexedDB and `src/main.ts` is unchanged.
- [ ] No migration, compatibility, security, recovery, retry, quota, or multi-tab framework is introduced.
- [ ] Tests use the real adapter through `fake-indexeddb` and remain in the existing runtime Vitest project.
