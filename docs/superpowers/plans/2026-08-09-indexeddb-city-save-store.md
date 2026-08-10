# HPA-343 IndexedDB City Save Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the smallest durable browser implementation of the existing six-operation `CitySaveStore`, backed by one IndexedDB object store and verified without wiring persistence into the player UI yet.

**Architecture:** `src/persistence/indexedDbCitySaveStore.ts` talks to raw IndexedDB directly and exposes only `CitySaveStore`. Full `CitySaveRecord` values live in one `cities` object store under out-of-line keys equal to `record.city.id`; list metadata is projected through one shared `citySummaryFromRecord()` helper and sorted by the existing `sortCitySummaries()` helper. The current runtime/bootstrap stays unchanged until HPA-345 supplies this adapter to `createGameRuntime()`.

**Tech Stack:** TypeScript, browser IndexedDB API, Vitest runtime project, Bun, `fake-indexeddb` as a dev-only test dependency.

## Global Constraints

- Implement exactly `listCities`, `readCity`, `createCity`, `updateCity`, `renameCity`, and `deleteCity`.
- Use database `caelum-city-saves-v1`, version `1`, with one object store named `cities`.
- Store complete `CitySaveRecord` values and use `record.city.id` as the out-of-line key.
- Export one pure `citySummaryFromRecord()` helper from `citySaveStore.ts`; memory and IndexedDB adapters must share it.
- Reuse `sortCitySummaries()`; do not add a metadata store or index.
- The shared adapter contract must prove multi-city `listCities()` ordering, not only the pure sorting helper.
- Do not inspect or validate gameplay snapshots in TypeScript.
- Do not add production storage libraries, repositories, services, registries, migrations, compatibility readers, retries, recovery, multi-tab ownership, quota handling, or security frameworks.
- Do not change `src/main.ts`, `createGameRuntime()`, Svelte UI, or the anonymous development bootstrap in HPA-343.
- Development saves are disposable; a future breaking schema can use a new database name/version instead of migration code.
- Keep tests in the existing `runtime` Vitest project; do not add a browser Vitest project or Playwright-only persistence hook.
- `fake-indexeddb` proves adapter behavior only. Real-browser wiring starts in HPA-345; the full `New City -> reload -> Continue/Load` player proof belongs to HPA-346 when the city library exists.

---

### Task 1: Share store helpers and make the contract adapter-neutral

**Files:**
- Modify: `src/persistence/citySaveStore.ts`
- Modify: `src/persistence/memoryCitySaveStore.ts`
- Modify: `tests/runtime/persistence/citySaveStoreContract.ts`
- Modify: `tests/runtime/persistence/memoryCitySaveStore.test.ts`

**Interfaces:**
- Consumes: existing `CitySaveRecord`, `CitySummary`, `CitySaveStore`, and `CitySaveStoreResult`.
- Produces: `citySummaryFromRecord(record: CitySaveRecord): CitySummary` for all concrete adapters.
- Produces: `defineCitySaveStoreContract(name, createStore)` without a test-only failure interface.
- Produces test-only `expectCitySaveStoreOk()` and `makeCitySaveRecord()` helpers for adapter suites.
- Preserves: `MemoryCitySaveStoreFailureControls` only for memory-adapter-specific failure tests.

- [ ] **Step 1: Extract the shared record-to-summary projection**

In `src/persistence/citySaveStore.ts`, add the projection next to the existing store types and sorting helper:

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

In `src/persistence/memoryCitySaveStore.ts`, import it:

```ts
import {
  citySummaryFromRecord,
  sortCitySummaries,
  type CitySaveRecord,
  type CitySaveStore,
  type CitySaveStoreError,
  type CitySaveStoreErrorCode,
  type CitySaveStoreOperation,
  type CitySaveStoreResult,
  type CitySummary,
} from "./citySaveStore";
```

Delete the private `summaryFor()` implementation and replace its usages:

```ts
const summaries = sortCitySummaries(
  [...records.values()].map(citySummaryFromRecord),
);
```

```ts
return cloneValue(
  citySummaryFromRecord(cloned.value),
  "createCity",
  cityId,
);
```

```ts
return cloneValue(citySummaryFromRecord(replacement), "updateCity", id);
```

```ts
return cloneValue(citySummaryFromRecord(replacement), "renameCity", id);
```

Do not extract `errorResult`, cloning, failure queues, or adapter transaction behavior. The shared helper is only the duplicated domain projection.

- [ ] **Step 2: Export the two reusable test helpers from the contract module**

In `tests/runtime/persistence/citySaveStoreContract.ts`, keep `expectError()` private but rename/export the generic success helper and record factory:

```ts
export async function expectCitySaveStoreOk<T>(
  result: Promise<CitySaveStoreResult<T>> | CitySaveStoreResult<T>,
): Promise<T> {
  const resolved = await result;
  if (!resolved.ok) {
    throw new Error(
      `${resolved.error.operation} failed with ${resolved.error.code}`,
    );
  }
  return resolved.value;
}

export function makeCitySaveRecord(
  id: string,
  name: string,
  overrides: {
    createdAt?: string;
    savedAt?: string;
    snapshot?: unknown;
  } = {},
): CitySaveRecord {
  return {
    city: {
      id,
      name,
      createdAt: overrides.createdAt ?? "2026-08-01T10:00:00.000Z",
    },
    savedAt: overrides.savedAt ?? "2026-08-01T10:00:00.000Z",
    snapshot: overrides.snapshot ?? { budget: 120_000 },
  };
}
```

Rename existing calls inside the contract from `expectOk()` / `makeRecord()` to these exported names. Do not create another fixture module: `tests/fixtures/citySave.ts` intentionally builds real Rust-shaped snapshots and is not suitable for the IndexedDB uncloneable-value test.

- [ ] **Step 3: Move injected failure tests into the memory adapter suite**

In `tests/runtime/persistence/memoryCitySaveStore.test.ts`, import the shared test helpers:

```ts
import {
  defineCitySaveStoreContract,
  expectCitySaveStoreOk,
  makeCitySaveRecord,
} from "./citySaveStoreContract";
```

Register the shared contract without failure controls:

```ts
defineCitySaveStoreContract("MemoryCitySaveStore", () =>
  createMemoryCitySaveStore(),
);
```

Move the contract's three injected failure cases into the existing `describe("MemoryCitySaveStore failure injection", ...)` block:

```ts
it("does not commit an injected create failure", async () => {
  const failures = createMemoryCitySaveStoreFailureControls();
  const store = createMemoryCitySaveStore({ failures });
  failures.failNext("createCity", "failed");

  expect(
    await store.createCity(makeCitySaveRecord("city-1", "First")),
  ).toMatchObject({
    ok: false,
    error: { operation: "createCity", code: "failed", cityId: "city-1" },
  });
  expect(await store.readCity("city-1")).toMatchObject({
    ok: false,
    error: { operation: "readCity", code: "notFound", cityId: "city-1" },
  });
});
```

```ts
it("preserves the prior record after an injected update failure", async () => {
  const failures = createMemoryCitySaveStoreFailureControls();
  const store = createMemoryCitySaveStore({ failures });
  const original = makeCitySaveRecord("city-1", "First");
  await expectCitySaveStoreOk(store.createCity(original));
  failures.failNext("updateCity", "failed");

  expect(
    await store.updateCity("city-1", {
      savedAt: "2026-08-02T11:00:00.000Z",
      snapshot: { budget: 90_000 },
    }),
  ).toMatchObject({
    ok: false,
    error: { operation: "updateCity", code: "failed", cityId: "city-1" },
  });
  expect(await expectCitySaveStoreOk(store.readCity("city-1"))).toEqual(
    original,
  );
});
```

```ts
it("preserves the prior record after an injected rename failure", async () => {
  const failures = createMemoryCitySaveStoreFailureControls();
  const store = createMemoryCitySaveStore({ failures });
  const original = makeCitySaveRecord("city-1", "Original");
  await expectCitySaveStoreOk(store.createCity(original));
  failures.failNext("renameCity", "failed");

  expect(await store.renameCity("city-1", "Renamed")).toMatchObject({
    ok: false,
    error: { operation: "renameCity", code: "failed", cityId: "city-1" },
  });
  expect(await expectCitySaveStoreOk(store.readCity("city-1"))).toEqual(
    original,
  );
});
```

Keep the existing injected `listCities` failure test in the same memory-only block. Do not add failure injection to the production `CitySaveStore` interface.

- [ ] **Step 4: Simplify the shared contract factory and add adapter-level list ordering**

In `tests/runtime/persistence/citySaveStoreContract.ts`, delete `CitySaveStoreContractHarness` and change the public helper to:

```ts
export function defineCitySaveStoreContract(
  name: string,
  createStore: () => CitySaveStore,
): void {
```

Inside each shared case, replace:

```ts
const { store } = createHarness();
```

with:

```ts
const store = createStore();
```

Delete the three injected create/update/rename failure tests and remove now-unused `CitySaveStoreErrorCode` / `CitySaveStoreOperation` imports.

Add an adapter-neutral empty-list case:

```ts
it("starts with an empty city list", async () => {
  const store = createStore();
  expect(await expectCitySaveStoreOk(store.listCities())).toEqual([]);
});
```

Add a multi-city ordering case that catches both Map insertion order and IndexedDB key order:

```ts
it("lists multiple cities by saved time then ID", async () => {
  const store = createStore();

  await expectCitySaveStoreOk(
    store.createCity(
      makeCitySaveRecord("city-b", "B", {
        savedAt: "2026-08-01T10:00:00.000Z",
      }),
    ),
  );
  await expectCitySaveStoreOk(
    store.createCity(
      makeCitySaveRecord("city-z", "Newest", {
        savedAt: "2026-08-01T11:00:00.000Z",
      }),
    ),
  );
  await expectCitySaveStoreOk(
    store.createCity(
      makeCitySaveRecord("city-a", "A", {
        savedAt: "2026-08-01T10:00:00.000Z",
      }),
    ),
  );

  const listed = await expectCitySaveStoreOk(store.listCities());
  expect(listed.map((city) => city.id)).toEqual([
    "city-z",
    "city-a",
    "city-b",
  ]);
});
```

Keep the existing pure `sortCitySummaries()` test as well: it still verifies the helper does not mutate its input and handles the tie-break rule directly. The new case verifies that each concrete adapter actually uses that ordering.

- [ ] **Step 5: Run focused contract verification**

```bash
bunx vitest run --project runtime tests/runtime/persistence/memoryCitySaveStore.test.ts
bun run check
bun run format:check
```

Expected: all commands pass, including the new adapter-level multi-city ordering case.

- [ ] **Step 6: Commit the shared helper/contract cleanup**

```bash
git add src/persistence/citySaveStore.ts src/persistence/memoryCitySaveStore.ts tests/runtime/persistence/citySaveStoreContract.ts tests/runtime/persistence/memoryCitySaveStore.test.ts
git commit -m "refactor: share city save store adapter helpers"
```

---

### Task 2: Implement and verify the IndexedDB CitySaveStore

**Files:**
- Create: `src/persistence/indexedDbCitySaveStore.ts`
- Create: `tests/runtime/persistence/indexedDbCitySaveStore.test.ts`
- Modify: `package.json`
- Modify: `bun.lock`
- Modify: `docs/architecture.md`

**Interfaces:**
- Consumes: `CitySaveStore`, `CitySaveRecord`, `CitySaveStoreResult`, `citySummaryFromRecord()`, and `sortCitySummaries()` from `src/persistence/citySaveStore.ts`.
- Consumes test-only: `defineCitySaveStoreContract()`, `expectCitySaveStoreOk()`, and `makeCitySaveRecord()` from `tests/runtime/persistence/citySaveStoreContract.ts`.
- Produces: `createIndexedDbCitySaveStore(options?: IndexedDbCitySaveStoreOptions): CitySaveStore`.
- Downstream: HPA-345 creates this adapter and passes it through the existing `createGameRuntime({ saveStore })` option. HPA-346 owns the complete reload/Continue browser proof after city-library UI exists.

- [ ] **Step 1: Add the dev-only IndexedDB implementation used by tests**

```bash
bun add -d fake-indexeddb
```

Expected: only `package.json` and `bun.lock` gain the development dependency and lock entries.

- [ ] **Step 2: Write the IndexedDB tests before the adapter exists**

Create `tests/runtime/persistence/indexedDbCitySaveStore.test.ts`:

```ts
import { indexedDB as fakeIndexedDB } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { createIndexedDbCitySaveStore } from "../../../src/persistence/indexedDbCitySaveStore";
import {
  defineCitySaveStoreContract,
  expectCitySaveStoreOk,
  makeCitySaveRecord,
} from "./citySaveStoreContract";

let databaseSequence = 0;

function nextDatabaseName(): string {
  databaseSequence += 1;
  return `caelum-indexeddb-test-${databaseSequence}`;
}

function createStore(databaseName = nextDatabaseName()) {
  return createIndexedDbCitySaveStore({
    indexedDB: fakeIndexedDB,
    databaseName,
  });
}

defineCitySaveStoreContract("IndexedDbCitySaveStore", () => createStore());

describe("IndexedDbCitySaveStore persistence", () => {
  it("reopens data through a second adapter instance", async () => {
    const databaseName = nextDatabaseName();
    const first = createStore(databaseName);
    const saved = makeCitySaveRecord("city-1", "First");
    await expectCitySaveStoreOk(first.createCity(saved));

    const second = createStore(databaseName);
    expect(
      await expectCitySaveStoreOk(second.readCity("city-1")),
    ).toEqual(saved);
  });

  it("preserves the previous record when an update cannot be cloned", async () => {
    const store = createStore();
    const original = makeCitySaveRecord("city-1", "First");
    await expectCitySaveStoreOk(store.createCity(original));

    const result = await store.updateCity("city-1", {
      savedAt: "2026-08-02T11:00:00.000Z",
      snapshot: { cannotClone: () => 1 },
    });

    expect(result).toMatchObject({
      ok: false,
      error: { operation: "updateCity", code: "failed", cityId: "city-1" },
    });
    expect(
      await expectCitySaveStoreOk(store.readCity("city-1")),
    ).toEqual(original);
  });
});
```

The shared contract now supplies empty-list, create/list/read, conflict, update, rename, delete, detached-value, and multi-city ordering coverage. Keep only IndexedDB-specific persistence/failure behavior in this file.

Inject `fakeIndexedDB` directly. Do not install IndexedDB globals for unrelated tests.

- [ ] **Step 3: Run the new test and confirm the red state**

```bash
bunx vitest run --project runtime tests/runtime/persistence/indexedDbCitySaveStore.test.ts
```

Expected: FAIL because `src/persistence/indexedDbCitySaveStore.ts` does not exist.

- [ ] **Step 4: Implement the raw IndexedDB adapter**

Create `src/persistence/indexedDbCitySaveStore.ts`:

```ts
import {
  citySummaryFromRecord,
  sortCitySummaries,
  type CitySaveRecord,
  type CitySaveStore,
  type CitySaveStoreErrorCode,
  type CitySaveStoreOperation,
  type CitySaveStoreResult,
} from "./citySaveStore";

const DEFAULT_DATABASE_NAME = "caelum-city-saves-v1";
const DATABASE_VERSION = 1;
const CITY_STORE_NAME = "cities";

export interface IndexedDbCitySaveStoreOptions {
  indexedDB?: IDBFactory;
  databaseName?: string;
}

function errorName(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    typeof (error as { name?: unknown }).name === "string"
  ) {
    return (error as { name: string }).name;
  }
  return "UnknownError";
}

function errorResult<T>(
  operation: CitySaveStoreOperation,
  code: CitySaveStoreErrorCode,
  cityId?: string,
  diagnostic?: string,
): CitySaveStoreResult<T> {
  return {
    ok: false,
    error: {
      operation,
      code,
      ...(cityId === undefined ? {} : { cityId }),
      ...(code === "failed" && diagnostic !== undefined
        ? { diagnostic }
        : {}),
    },
  };
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}

async function runTransaction<T>(
  database: IDBDatabase,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => Promise<T>,
): Promise<T> {
  const transaction = database.transaction(CITY_STORE_NAME, mode);
  const done = transactionDone(transaction);
  try {
    const value = await run(transaction.objectStore(CITY_STORE_NAME));
    await done;
    return value;
  } catch (error) {
    try {
      transaction.abort();
    } catch {
      // The request may already have aborted or completed the transaction.
    }
    await done.catch(() => undefined);
    throw error;
  }
}

export function createIndexedDbCitySaveStore(
  options: IndexedDbCitySaveStoreOptions = {},
): CitySaveStore {
  const factory = options.indexedDB ?? globalThis.indexedDB;
  const databaseName = options.databaseName ?? DEFAULT_DATABASE_NAME;
  let databasePromise: Promise<IDBDatabase> | null = null;

  function openDatabase(): Promise<IDBDatabase> {
    if (!factory) {
      return Promise.reject(new Error("IndexedDB unavailable"));
    }
    if (databasePromise) return databasePromise;

    databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(databaseName, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(CITY_STORE_NAME)) {
          database.createObjectStore(CITY_STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error ?? new Error("IndexedDB open failed"));
    }).catch((error: unknown) => {
      databasePromise = null;
      throw error;
    });

    return databasePromise;
  }

  const listCities: CitySaveStore["listCities"] = async () => {
    try {
      const database = await openDatabase();
      const records = await runTransaction(database, "readonly", async (store) =>
        requestResult(store.getAll()),
      );
      return {
        ok: true,
        value: sortCitySummaries(
          (records as CitySaveRecord[]).map(citySummaryFromRecord),
        ),
      };
    } catch (error) {
      return errorResult("listCities", "failed", undefined, errorName(error));
    }
  };

  const readCity: CitySaveStore["readCity"] = async (id) => {
    try {
      const database = await openDatabase();
      const record = (await runTransaction(database, "readonly", async (store) =>
        requestResult(store.get(id)),
      )) as CitySaveRecord | undefined;
      return record === undefined
        ? errorResult("readCity", "notFound", id)
        : { ok: true, value: record };
    } catch (error) {
      return errorResult("readCity", "failed", id, errorName(error));
    }
  };

  const createCity: CitySaveStore["createCity"] = async (record) => {
    let detached: CitySaveRecord;
    try {
      detached = structuredClone(record);
    } catch (error) {
      return errorResult(
        "createCity",
        "failed",
        record.city.id,
        errorName(error),
      );
    }

    const id = detached.city.id;
    try {
      const database = await openDatabase();
      await runTransaction(database, "readwrite", async (store) => {
        await requestResult(store.add(detached, id));
      });
      return { ok: true, value: citySummaryFromRecord(detached) };
    } catch (error) {
      const name = errorName(error);
      return errorResult(
        "createCity",
        name === "ConstraintError" ? "conflict" : "failed",
        id,
        name,
      );
    }
  };

  const updateCity: CitySaveStore["updateCity"] = async (id, update) => {
    let detachedUpdate: typeof update;
    try {
      detachedUpdate = structuredClone(update);
    } catch (error) {
      return errorResult("updateCity", "failed", id, errorName(error));
    }

    try {
      const database = await openDatabase();
      const replacement = await runTransaction(
        database,
        "readwrite",
        async (store) => {
          const existing = (await requestResult(store.get(id))) as
            | CitySaveRecord
            | undefined;
          if (existing === undefined) return null;

          const next: CitySaveRecord = {
            city: existing.city,
            savedAt: detachedUpdate.savedAt,
            snapshot: detachedUpdate.snapshot,
          };
          await requestResult(store.put(next, id));
          return next;
        },
      );
      return replacement === null
        ? errorResult("updateCity", "notFound", id)
        : { ok: true, value: citySummaryFromRecord(replacement) };
    } catch (error) {
      return errorResult("updateCity", "failed", id, errorName(error));
    }
  };

  const renameCity: CitySaveStore["renameCity"] = async (id, name) => {
    try {
      const database = await openDatabase();
      const replacement = await runTransaction(
        database,
        "readwrite",
        async (store) => {
          const existing = (await requestResult(store.get(id))) as
            | CitySaveRecord
            | undefined;
          if (existing === undefined) return null;

          const next: CitySaveRecord = {
            ...existing,
            city: { ...existing.city, name },
          };
          await requestResult(store.put(next, id));
          return next;
        },
      );
      return replacement === null
        ? errorResult("renameCity", "notFound", id)
        : { ok: true, value: citySummaryFromRecord(replacement) };
    } catch (error) {
      return errorResult("renameCity", "failed", id, errorName(error));
    }
  };

  const deleteCity: CitySaveStore["deleteCity"] = async (id) => {
    try {
      const database = await openDatabase();
      const deleted = await runTransaction(
        database,
        "readwrite",
        async (store) => {
          const existing = await requestResult(store.get(id));
          if (existing === undefined) return false;
          await requestResult(store.delete(id));
          return true;
        },
      );
      return deleted
        ? { ok: true, value: undefined }
        : errorResult("deleteCity", "notFound", id);
    } catch (error) {
      return errorResult("deleteCity", "failed", id, errorName(error));
    }
  };

  return {
    listCities,
    readCity,
    createCity,
    updateCity,
    renameCity,
    deleteCity,
  };
}
```

`runTransaction()` is a file-local Promise bridge for IndexedDB completion/abort semantics, not a reusable persistence abstraction. Keep it in this module and do not export it.

Waiting for `transaction.oncomplete` before returning success is load-bearing. Do not simplify mutation completion to request `onsuccess`: a successful request can still belong to a transaction that later aborts.

- [ ] **Step 5: Run the IndexedDB contract and focused persistence tests**

```bash
bunx vitest run --project runtime tests/runtime/persistence/indexedDbCitySaveStore.test.ts tests/runtime/persistence/memoryCitySaveStore.test.ts
```

Expected: both adapters pass the shared contract, including the adapter-level multi-city ordering case. IndexedDB-specific reopen behavior and the failed-uncloneable-update preservation test also pass.

Do not add a create/rename/delete abort matrix. The one uncloneable update is the representative real failure proving that the shared `runTransaction`/commit boundary preserves the prior record.

- [ ] **Step 6: Document the browser storage boundary**

In `docs/architecture.md`, immediately after the `workingSaveRuntime.ts` persistence paragraph, add:

```md
The browser persistence adapter is `indexedDbCitySaveStore.ts`: one
`caelum-city-saves-v1` IndexedDB database, one `cities` object store, and full
`CitySaveRecord` values keyed by opaque city ID. Memory and browser adapters
reuse the shared `citySummaryFromRecord()` projection; city-list ordering uses
`sortCitySummaries()` after reading the records. The browser adapter implements
the six `CitySaveStore` operations directly and has no metadata index, migration
layer, recovery model, or multi-tab ownership. HPA-345 owns wiring this adapter
into the first no-city/New City browser flow; the current anonymous development
bootstrap remains unchanged until then.
```

- [ ] **Step 7: Run the complete frontend verification gate**

```bash
bun run test:unit
bun run check
bun run lint
bun run format:check
bun run build
```

Expected: all commands pass. Do not add HPA-343-specific Playwright or Rust work: the adapter is not wired to the application and contains no Rust changes.

Passing this gate does **not** claim real-browser persistence integration. `fake-indexeddb` validates the adapter contract in Node. HPA-345 owns the first Chromium proof after wiring; HPA-346 owns the full `New City -> reload -> Continue/Load` player smoke once the city library exists.

- [ ] **Step 8: Verify no premature runtime/UI wiring entered scope**

```bash
git diff --stat main...HEAD
git grep -n "createIndexedDbCitySaveStore" -- src tests docs
```

Expected:

- production usage exists only in `src/persistence/indexedDbCitySaveStore.ts`;
- tests import the factory;
- `src/main.ts`, `src/runtime/createGameRuntime.ts`, and Svelte components are unchanged;
- no migration/index/recovery/multi-tab modules were added.

- [ ] **Step 9: Commit the adapter**

```bash
git add package.json bun.lock src/persistence/indexedDbCitySaveStore.ts tests/runtime/persistence/indexedDbCitySaveStore.test.ts docs/architecture.md
git commit -m "feat: add IndexedDB city save store"
```

---

## Plan self-review

- **Spec coverage:** one database/store, six operations, create conflict, failed-update preservation, detached values, reopen behavior, adapter-level multi-city ordering, shared summary projection, adapter-only boundary, and deferred bootstrap wiring are covered.
- **Placeholder scan:** no TODO/TBD or unspecified implementation steps remain.
- **Type consistency:** the plan reuses the existing `CitySaveStore`, `CitySaveRecord`, `CitySummary`, `citySummaryFromRecord()`, `sortCitySummaries()`, and `createGameRuntime({ saveStore })` contracts without compatibility types.
- **Duplication check:** memory and IndexedDB share only the stable record-to-summary projection and test factories; IndexedDB-specific error/transaction code remains local.
- **Risk check:** `fake-indexeddb` is explicitly treated as unit-level adapter evidence, not browser integration evidence. HPA-345/HPA-346 own the real Chromium handoff at the correct player-flow boundaries.
- **Scope check:** HPA-343 remains one browser-storage subsystem. HPA-345, HPA-346, and HPA-344 stay separate downstream tasks.