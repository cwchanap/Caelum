# HPA-343 IndexedDB City Save Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the smallest durable browser implementation of the existing six-operation `CitySaveStore`, backed by one IndexedDB object store and verified without wiring persistence into the player UI yet.

**Architecture:** `src/persistence/indexedDbCitySaveStore.ts` talks to raw IndexedDB directly and exposes only `CitySaveStore`. Full `CitySaveRecord` values live in one `cities` object store under out-of-line keys equal to `record.city.id`; list metadata is derived on read and sorted by the existing helper. The existing runtime remains unchanged until HPA-345 supplies the adapter to `createGameRuntime()`.

**Tech Stack:** TypeScript, browser IndexedDB API, Vitest runtime project, Bun, `fake-indexeddb` as a dev-only test dependency.

## Global Constraints

- Implement exactly the existing six `CitySaveStore` operations: `listCities`, `readCity`, `createCity`, `updateCity`, `renameCity`, `deleteCity`.
- Use one IndexedDB database named `caelum-city-saves-v1`, version `1`, with one object store named `cities`.
- Store complete `CitySaveRecord` values; use `record.city.id` as the out-of-line object-store key.
- Reuse `sortCitySummaries()`; do not add a metadata store or index.
- Do not inspect or validate gameplay snapshots in TypeScript.
- Do not add production storage libraries, repositories, services, registries, migration code, compatibility readers, retries, recovery, multi-tab ownership, quota handling, or security frameworks.
- Do not change `src/main.ts`, `createGameRuntime()`, Svelte UI, or the current anonymous bootstrap in HPA-343.
- Development saves are disposable; future breaking schema changes may use a new database name/version instead of migration code.
- Keep tests in the existing `runtime` Vitest project; do not add a browser Vitest project or Playwright-only test hook.

---

### Task 1: Make the shared CitySaveStore contract adapter-neutral

**Files:**
- Modify: `tests/runtime/persistence/citySaveStoreContract.ts`
- Modify: `tests/runtime/persistence/memoryCitySaveStore.test.ts`

**Interfaces:**
- Consumes: existing `CitySaveStore` and `CitySaveStoreResult` from `src/persistence/citySaveStore.ts`.
- Produces: `defineCitySaveStoreContract(name, createStore)` that any real adapter can run without exposing a test-only `failNext` API.
- Preserves: `MemoryCitySaveStoreFailureControls` for memory-adapter-specific atomicity tests only.

- [ ] **Step 1: Move failure-injection assertions into the memory adapter test**

In `tests/runtime/persistence/memoryCitySaveStore.test.ts`, add local helpers and preserve the three existing injected-failure guarantees outside the shared contract:

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

function record(id = "city-1"): CitySaveRecord {
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

Add/retain these memory-specific tests:

```ts
it("does not commit an injected create failure", async () => {
  const failures = createMemoryCitySaveStoreFailureControls();
  const store = createMemoryCitySaveStore({ failures });
  failures.failNext("createCity", "failed");

  const result = await store.createCity(record());
  expect(result).toMatchObject({
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
  const original = record();
  await expectOk(store.createCity(original));
  failures.failNext("updateCity", "failed");

  await store.updateCity("city-1", {
    savedAt: "2026-08-02T11:00:00.000Z",
    snapshot: { budget: 90_000 },
  });

  expect(await expectOk(store.readCity("city-1"))).toEqual(original);
});

it("preserves the prior record after an injected rename failure", async () => {
  const failures = createMemoryCitySaveStoreFailureControls();
  const store = createMemoryCitySaveStore({ failures });
  const original = record();
  await expectOk(store.createCity(original));
  failures.failNext("renameCity", "failed");

  await store.renameCity("city-1", "Renamed");

  expect(await expectOk(store.readCity("city-1"))).toEqual(original);
});
```

- [ ] **Step 2: Simplify the shared contract harness**

Change `tests/runtime/persistence/citySaveStoreContract.ts` from the failure-aware harness:

```ts
export interface CitySaveStoreContractHarness {
  store: CitySaveStore;
  failNext: (
    operation: CitySaveStoreOperation,
    code: CitySaveStoreErrorCode,
  ) => void;
}
```

to a direct store factory:

```ts
export function defineCitySaveStoreContract(
  name: string,
  createStore: () => CitySaveStore,
): void {
```

Inside each shared test, replace:

```ts
const { store } = createHarness();
```

with:

```ts
const store = createStore();
```

Delete the three `failNext` tests from the shared contract. They now live in the memory adapter suite and no longer force production adapters to expose failure injection.

Remove now-unused imports of `CitySaveStoreErrorCode` and `CitySaveStoreOperation` from the shared contract.

Add an explicit adapter-neutral empty-list test:

```ts
it("starts with an empty city list", async () => {
  const store = createStore();
  expect(await expectOk(store.listCities())).toEqual([]);
});
```

Keep the existing shared tests for create/list/read, conflict, update, identity preservation, rename, delete/notFound, sorting helper behavior, and detached values.

- [ ] **Step 3: Update the memory harness call**

Change:

```ts
defineCitySaveStoreContract("MemoryCitySaveStore", () => {
  const failures = createMemoryCitySaveStoreFailureControls();
  const store = createMemoryCitySaveStore({ failures });
  return {
    store,
    failNext: (operation, code) => failures.failNext(operation, code),
  };
});
```

to:

```ts
defineCitySaveStoreContract("MemoryCitySaveStore", () =>
  createMemoryCitySaveStore(),
);
```

- [ ] **Step 4: Run the focused memory-store contract**

Run:

```bash
bunx vitest run --project runtime tests/runtime/persistence/memoryCitySaveStore.test.ts
```

Expected: all memory-store contract and injected-failure tests pass.

- [ ] **Step 5: Run TypeScript and formatting checks**

Run:

```bash
bun run check
bun run format:check
```

Expected: both commands pass.

- [ ] **Step 6: Commit the adapter-neutral test contract**

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
- Consumes: `CitySaveStore`, `CitySaveRecord`, `CitySaveUpdate`, `CitySummary`, `CitySaveStoreResult`, `sortCitySummaries()` from `src/persistence/citySaveStore.ts`.
- Produces: `createIndexedDbCitySaveStore(options?: IndexedDbCitySaveStoreOptions): CitySaveStore`.
- Test-only dependency: `fake-indexeddb` provides an `IDBFactory` implementation; the production adapter API remains ordinary IndexedDB.
- Downstream HPA-345 will call the factory and pass the result to the already-existing `createGameRuntime({ saveStore })` option.

- [ ] **Step 1: Add the dev-only IndexedDB test implementation**

Run:

```bash
bun add -d fake-indexeddb
```

Expected: `package.json` and `bun.lock` gain only the `fake-indexeddb` development dependency and its lock data.

- [ ] **Step 2: Write the IndexedDB adapter tests before the module exists**

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

Do not add global IndexedDB setup; inject the factory directly so the adapter remains easy to test and no unrelated tests acquire browser globals.

- [ ] **Step 3: Run the new test to verify it fails**

Run:

```bash
bunx vitest run --project runtime tests/runtime/persistence/indexedDbCitySaveStore.test.ts
```

Expected: FAIL because `src/persistence/indexedDbCitySaveStore.ts` does not exist.

- [ ] **Step 4: Implement the minimal raw IndexedDB adapter**

Create `src/persistence/indexedDbCitySaveStore.ts` with this structure:

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
      ...(diagnostic === undefined ? {} : { diagnostic }),
    },
  };
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
    transaction.onerror = () => {
      // Abort/completion decides the transaction outcome. The request-specific
      // error is handled by requestResult().
    };
  });
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
      const transaction = database.transaction(CITY_STORE_NAME, "readonly");
      const done = transactionDone(transaction);
      const request = transaction.objectStore(CITY_STORE_NAME).getAll();
      const records = (await requestResult(request)) as CitySaveRecord[];
      await done;
      return {
        ok: true,
        value: sortCitySummaries(records.map(summaryFor)),
      };
    } catch (error) {
      return errorResult("listCities", "failed", undefined, errorName(error));
    }
  };

  const readCity: CitySaveStore["readCity"] = async (id) => {
    try {
      const database = await openDatabase();
      const transaction = database.transaction(CITY_STORE_NAME, "readonly");
      const done = transactionDone(transaction);
      const request = transaction.objectStore(CITY_STORE_NAME).get(id);
      const record = (await requestResult(request)) as CitySaveRecord | undefined;
      await done;
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
      const transaction = database.transaction(CITY_STORE_NAME, "readwrite");
      const done = transactionDone(transaction);
      const request = transaction.objectStore(CITY_STORE_NAME).add(detached, id);
      await requestResult(request);
      await done;
      return { ok: true, value: summaryFor(detached) };
    } catch (error) {
      return errorResult(
        "createCity",
        errorName(error) === "ConstraintError" ? "conflict" : "failed",
        id,
        errorName(error),
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
      const transaction = database.transaction(CITY_STORE_NAME, "readwrite");
      const done = transactionDone(transaction);
      const objectStore = transaction.objectStore(CITY_STORE_NAME);
      const existing = (await requestResult(objectStore.get(id))) as
        | CitySaveRecord
        | undefined;

      if (existing === undefined) {
        await done;
        return errorResult("updateCity", "notFound", id);
      }

      const replacement: CitySaveRecord = {
        city: existing.city,
        savedAt: detachedUpdate.savedAt,
        snapshot: detachedUpdate.snapshot,
      };
      await requestResult(objectStore.put(replacement, id));
      await done;
      return { ok: true, value: summaryFor(replacement) };
    } catch (error) {
      return errorResult("updateCity", "failed", id, errorName(error));
    }
  };

  const renameCity: CitySaveStore["renameCity"] = async (id, name) => {
    try {
      const database = await openDatabase();
      const transaction = database.transaction(CITY_STORE_NAME, "readwrite");
      const done = transactionDone(transaction);
      const objectStore = transaction.objectStore(CITY_STORE_NAME);
      const existing = (await requestResult(objectStore.get(id))) as
        | CitySaveRecord
        | undefined;

      if (existing === undefined) {
        await done;
        return errorResult("renameCity", "notFound", id);
      }

      const replacement: CitySaveRecord = {
        ...existing,
        city: { ...existing.city, name },
      };
      await requestResult(objectStore.put(replacement, id));
      await done;
      return { ok: true, value: summaryFor(replacement) };
    } catch (error) {
      return errorResult("renameCity", "failed", id, errorName(error));
    }
  };

  const deleteCity: CitySaveStore["deleteCity"] = async (id) => {
    try {
      const database = await openDatabase();
      const transaction = database.transaction(CITY_STORE_NAME, "readwrite");
      const done = transactionDone(transaction);
      const objectStore = transaction.objectStore(CITY_STORE_NAME);
      const existing = await requestResult(objectStore.get(id));

      if (existing === undefined) {
        await done;
        return errorResult("deleteCity", "notFound", id);
      }

      await requestResult(objectStore.delete(id));
      await done;
      return { ok: true, value: undefined };
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

Keep all constants/helpers module-local except the options type and factory. Do not add a class, base adapter, generic transaction runner, or public database lifecycle API.

- [ ] **Step 5: Run the IndexedDB tests**

Run:

```bash
bunx vitest run --project runtime tests/runtime/persistence/indexedDbCitySaveStore.test.ts
```

Expected: the full shared contract plus reopen and failed-update-preservation tests pass.

If `fake-indexeddb` reports a `ConstraintError` or clone failure with a different concrete error object, adjust only `errorName()` extraction; do not add a browser/vendor error taxonomy.

- [ ] **Step 6: Document the browser storage boundary**

In `docs/architecture.md`, in the persistence section immediately after the `workingSaveRuntime.ts` paragraph, add:

```md
The browser persistence adapter is `indexedDbCitySaveStore.ts`: one
`caelum-city-saves-v1` IndexedDB database, one `cities` object store, and full
`CitySaveRecord` values keyed by the opaque city ID. It implements the six
`CitySaveStore` operations directly, derives/sorts list summaries from the same
records, and has no metadata index, migration layer, recovery model, or
multi-tab ownership. HPA-345 owns wiring this adapter into the first no-city/New
City browser flow; the current anonymous development bootstrap remains
unchanged until then.
```

Do not describe IndexedDB as a generic platform abstraction or claim native/browser internals are identical.

- [ ] **Step 7: Run the complete frontend verification gate**

Run:

```bash
bun run test:unit
bun run check
bun run lint
bun run format:check
bun run build
```

Expected:

- all UI/runtime unit tests pass;
- TypeScript/Svelte checks pass;
- ESLint/stylelint/Rust lint command remains green;
- formatting is clean;
- the production browser build succeeds.

Do not add Playwright or Rust test work specifically for HPA-343: the adapter is not wired to the application and contains no Rust changes. HPA-345 owns the first real browser persistence E2E slice.

- [ ] **Step 8: Verify scope and absence of premature wiring**

Run:

```bash
git diff --stat main...HEAD
git grep -n "createIndexedDbCitySaveStore" -- src tests docs
```

Expected:

- production usage appears only in `src/persistence/indexedDbCitySaveStore.ts`;
- tests import the factory;
- `src/main.ts`, `src/runtime/createGameRuntime.ts`, and Svelte components are unchanged;
- no migration/index/recovery/multi-tab modules were added.

- [ ] **Step 9: Commit the IndexedDB adapter**

```bash
git add package.json bun.lock src/persistence/indexedDbCitySaveStore.ts tests/runtime/persistence/indexedDbCitySaveStore.test.ts docs/architecture.md
git commit -m "feat: add IndexedDB city save store"
```

---

## Plan self-review

- **Spec coverage:** one database/store, six operations, create conflict, failed-update preservation, detached values, reopen behavior, adapter-only boundary, and deferred bootstrap wiring are all covered.
- **Placeholder scan:** no TODO/TBD/future implementation placeholders are required by the tasks.
- **Type consistency:** the plan reuses the existing `CitySaveStore`, `CitySaveRecord`, `CitySummary`, and `createGameRuntime({ saveStore })` contracts without adding compatibility types.
- **Scope check:** HPA-343 remains one browser-storage subsystem. HPA-345 and HPA-344 stay separate downstream tasks.
