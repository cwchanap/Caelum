# HPA-343 IndexedDB City Save Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the smallest durable browser implementation of the existing six-operation `CitySaveStore`, backed by one IndexedDB object store and verified without wiring persistence into the player UI yet.

**Architecture:** `src/persistence/indexedDbCitySaveStore.ts` talks to raw IndexedDB directly and exposes only `CitySaveStore`. Full `CitySaveRecord` values live in one `cities` object store under out-of-line keys equal to `record.city.id`; list metadata is derived on read and sorted by the existing helper. The current runtime/bootstrap stays unchanged until HPA-345 supplies this adapter to `createGameRuntime()`.

**Tech Stack:** TypeScript, browser IndexedDB API, Vitest runtime project, Bun, `fake-indexeddb` as a dev-only test dependency.

## Global Constraints

- Implement exactly `listCities`, `readCity`, `createCity`, `updateCity`, `renameCity`, and `deleteCity`.
- Use database `caelum-city-saves-v1`, version `1`, with one object store named `cities`.
- Store complete `CitySaveRecord` values and use `record.city.id` as the out-of-line key.
- Reuse `sortCitySummaries()`; do not add a metadata store or index.
- Do not inspect or validate gameplay snapshots in TypeScript.
- Do not add production storage libraries, repositories, services, registries, migrations, compatibility readers, retries, recovery, multi-tab ownership, quota handling, or security frameworks.
- Do not change `src/main.ts`, `createGameRuntime()`, Svelte UI, or the anonymous development bootstrap in HPA-343.
- Development saves are disposable; a future breaking schema can use a new database name/version instead of migration code.
- Keep tests in the existing `runtime` Vitest project; do not add a browser Vitest project or Playwright-only persistence hook.

---

### Task 1: Make the shared CitySaveStore contract adapter-neutral

**Files:**
- Modify: `tests/runtime/persistence/citySaveStoreContract.ts`
- Modify: `tests/runtime/persistence/memoryCitySaveStore.test.ts`

**Interfaces:**
- Consumes: `CitySaveStore` and `CitySaveStoreResult` from `src/persistence/citySaveStore.ts`.
- Produces: `defineCitySaveStoreContract(name, createStore)` that real adapters can run without exposing a test-only failure API.
- Preserves: `MemoryCitySaveStoreFailureControls` only for memory-adapter-specific failure tests.

- [ ] **Step 1: Move injected failure tests into the memory adapter suite**

In `tests/runtime/persistence/memoryCitySaveStore.test.ts`, add local helpers:

```ts
import type {
  CitySaveRecord,
  CitySaveStoreResult,
} from "../../../src/persistence/citySaveStore";

async function expectOk<T>(
  result: Promise<CitySaveStoreResult<T>>,
): Promise<T> {
  const resolved = await result;
  if (!resolved.ok) {
    throw new Error(
      `${resolved.error.operation} failed with ${resolved.error.code}`,
    );
  }
  return resolved.value;
}

function makeRecord(id = "city-1"): CitySaveRecord {
  return {
    city: {
      id,
      name: "First",
      createdAt: "2026-08-01T10:00:00.000Z",
    },
    savedAt: "2026-08-01T10:00:00.000Z",
    snapshot: { budget: 120_000 },
  };
}
```

Move the shared contract's three `failNext` cases into `describe("MemoryCitySaveStore failure injection", ...)` so they remain explicit memory-adapter tests:

```ts
it("does not commit an injected create failure", async () => {
  const failures = createMemoryCitySaveStoreFailureControls();
  const store = createMemoryCitySaveStore({ failures });
  failures.failNext("createCity", "failed");

  expect(await store.createCity(makeRecord())).toMatchObject({
    ok: false,
    error: { operation: "createCity", code: "failed", cityId: "city-1" },
  });
  expect(await store.readCity("city-1")).toMatchObject({
    ok: false,
    error: { operation: "readCity", code: "notFound", cityId: "city-1" },
  });
});

it("preserves the prior record after an injected update failure", async () => {
  const failures = createMemoryCitySaveStoreFailureControls();
  const store = createMemoryCitySaveStore({ failures });
  const original = makeRecord();
  await expectOk(store.createCity(original));
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
  expect(await expectOk(store.readCity("city-1"))).toEqual(original);
});

it("preserves the prior record after an injected rename failure", async () => {
  const failures = createMemoryCitySaveStoreFailureControls();
  const store = createMemoryCitySaveStore({ failures });
  const original = makeRecord();
  await expectOk(store.createCity(original));
  failures.failNext("renameCity", "failed");

  expect(await store.renameCity("city-1", "Renamed")).toMatchObject({
    ok: false,
    error: { operation: "renameCity", code: "failed", cityId: "city-1" },
  });
  expect(await expectOk(store.readCity("city-1"))).toEqual(original);
});
```

Keep the existing injected `listCities` failure test in the same describe block.

- [ ] **Step 2: Simplify the shared contract factory**

In `tests/runtime/persistence/citySaveStoreContract.ts`, delete the failure-aware harness interface and change the public helper to:

```ts
export function defineCitySaveStoreContract(
  name: string,
  createStore: () => CitySaveStore,
): void {
```

Inside shared tests, replace:

```ts
const { store } = createHarness();
```

with:

```ts
const store = createStore();
```

Delete the three injected create/update/rename failure tests from this shared file and remove now-unused `CitySaveStoreErrorCode` / `CitySaveStoreOperation` imports.

Add one adapter-neutral empty-list test:

```ts
it("starts with an empty city list", async () => {
  const store = createStore();
  expect(await expectOk(store.listCities())).toEqual([]);
});
```

Keep all existing deterministic contract cases for create/list/read, conflict, update, identity preservation, rename, delete/notFound, sorting, and detached values.

- [ ] **Step 3: Update the memory contract registration**

Replace the current failure-control harness registration with:

```ts
defineCitySaveStoreContract("MemoryCitySaveStore", () =>
  createMemoryCitySaveStore(),
);
```

- [ ] **Step 4: Run focused contract verification**

```bash
bunx vitest run --project runtime tests/runtime/persistence/memoryCitySaveStore.test.ts
bun run check
bun run format:check
```

Expected: all commands pass.

- [ ] **Step 5: Commit the test-boundary cleanup**

```bash
git add tests/runtime/persistence/citySaveStoreContract.ts tests/runtime/persistence/memoryCitySaveStore.test.ts
git commit -m "test: make city save store contract adapter neutral"
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
- Consumes: `CitySaveStore`, `CitySaveRecord`, `CitySummary`, `CitySaveStoreResult`, and `sortCitySummaries()` from `src/persistence/citySaveStore.ts`.
- Produces: `createIndexedDbCitySaveStore(options?: IndexedDbCitySaveStoreOptions): CitySaveStore`.
- Downstream: HPA-345 creates this adapter and passes it through the existing `createGameRuntime({ saveStore })` option.

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
import type {
  CitySaveRecord,
  CitySaveStoreResult,
} from "../../../src/persistence/citySaveStore";
import { createIndexedDbCitySaveStore } from "../../../src/persistence/indexedDbCitySaveStore";
import { defineCitySaveStoreContract } from "./citySaveStoreContract";

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

async function expectOk<T>(
  result: Promise<CitySaveStoreResult<T>>,
): Promise<T> {
  const resolved = await result;
  if (!resolved.ok) {
    throw new Error(
      `${resolved.error.operation} failed with ${resolved.error.code}`,
    );
  }
  return resolved.value;
}

function makeRecord(snapshot: unknown = { budget: 120_000 }): CitySaveRecord {
  return {
    city: {
      id: "city-1",
      name: "First",
      createdAt: "2026-08-01T10:00:00.000Z",
    },
    savedAt: "2026-08-01T10:00:00.000Z",
    snapshot,
  };
}

defineCitySaveStoreContract("IndexedDbCitySaveStore", () => createStore());

describe("IndexedDbCitySaveStore persistence", () => {
  it("reopens data through a second adapter instance", async () => {
    const databaseName = nextDatabaseName();
    const first = createStore(databaseName);
    await expectOk(first.createCity(makeRecord()));

    const second = createStore(databaseName);
    expect(await expectOk(second.readCity("city-1"))).toEqual(makeRecord());
  });

  it("preserves the previous record when an update cannot be cloned", async () => {
    const store = createStore();
    const original = makeRecord();
    await expectOk(store.createCity(original));

    const result = await store.updateCity("city-1", {
      savedAt: "2026-08-02T11:00:00.000Z",
      snapshot: { cannotClone: () => 1 },
    });

    expect(result).toMatchObject({
      ok: false,
      error: { operation: "updateCity", code: "failed", cityId: "city-1" },
    });
    expect(await expectOk(store.readCity("city-1"))).toEqual(original);
  });
});
```

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
  sortCitySummaries,
  type CitySaveRecord,
  type CitySaveStore,
  type CitySaveStoreErrorCode,
  type CitySaveStoreOperation,
  type CitySaveStoreResult,
  type CitySummary,
} from "./citySaveStore";

const DEFAULT_DATABASE_NAME = "caelum-city-saves-v1";
const DATABASE_VERSION = 1;
const CITY_STORE_NAME = "cities";

export interface IndexedDbCitySaveStoreOptions {
  indexedDB?: IDBFactory;
  databaseName?: string;
}

function summaryFor(record: CitySaveRecord): CitySummary {
  return {
    id: record.city.id,
    name: record.city.name,
    createdAt: record.city.createdAt,
    savedAt: record.savedAt,
  };
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
          (records as CitySaveRecord[]).map(summaryFor),
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
      return { ok: true, value: summaryFor(detached) };
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
        : { ok: true, value: summaryFor(replacement) };
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
        : { ok: true, value: summaryFor(replacement) };
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

- [ ] **Step 5: Run the IndexedDB contract and focused persistence tests**

```bash
bunx vitest run --project runtime tests/runtime/persistence/indexedDbCitySaveStore.test.ts tests/runtime/persistence/memoryCitySaveStore.test.ts
```

Expected: both adapters pass their applicable tests, including reopen behavior and the failed-uncloneable-update preservation test.

- [ ] **Step 6: Document the browser storage boundary**

In `docs/architecture.md`, immediately after the `workingSaveRuntime.ts` persistence paragraph, add:

```md
The browser persistence adapter is `indexedDbCitySaveStore.ts`: one
`caelum-city-saves-v1` IndexedDB database, one `cities` object store, and full
`CitySaveRecord` values keyed by opaque city ID. It implements the six
`CitySaveStore` operations directly, derives/sorts list summaries from the same
records, and has no metadata index, migration layer, recovery model, or
multi-tab ownership. HPA-345 owns wiring this adapter into the first no-city/New
City browser flow; the current anonymous development bootstrap remains
unchanged until then.
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

- **Spec coverage:** one database/store, six operations, create conflict, failed-update preservation, detached values, reopen behavior, adapter-only boundary, and deferred bootstrap wiring are covered.
- **Placeholder scan:** no TODO/TBD or unspecified implementation steps remain.
- **Type consistency:** the plan reuses the existing `CitySaveStore`, `CitySaveRecord`, `CitySummary`, and `createGameRuntime({ saveStore })` contracts without compatibility types.
- **Scope check:** HPA-343 remains one browser-storage subsystem. HPA-345 and HPA-344 stay separate downstream tasks.
