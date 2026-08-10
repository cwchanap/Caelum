# HPA-343 IndexedDB City Save Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the smallest durable browser implementation of the existing six-operation `CitySaveStore`, backed by one IndexedDB object store and verified without wiring persistence into the player UI yet.

**Architecture:** `src/persistence/indexedDbCitySaveStore.ts` talks to raw IndexedDB directly and exposes only `CitySaveStore`. Full `CitySaveRecord` values live in one `cities` object store under out-of-line keys equal to `record.city.id`; list metadata and store-error envelopes reuse tiny shared helpers from `citySaveStore.ts`. IndexedDB performs the storage clone at `add/put`, and every mutation reports success only after transaction completion. The current runtime/bootstrap stays unchanged until HPA-345 supplies this adapter to `createGameRuntime()`.

**Tech Stack:** TypeScript, browser IndexedDB API, Vitest runtime project, Bun, existing WASM backend, `fake-indexeddb` as a dev-only test dependency.

## Global Constraints

- Implement exactly `listCities`, `readCity`, `createCity`, `updateCity`, `renameCity`, and `deleteCity`.
- Use database `caelum-city-saves-v1`, version `1`, with one object store named `cities`.
- Store complete `CitySaveRecord` values and use `record.city.id` as the out-of-line key.
- Export only two shared production helpers from `citySaveStore.ts`: `citySummaryFromRecord()` and `citySaveStoreError()`.
- Reuse `sortCitySummaries()`; do not add a metadata store or index.
- The shared adapter contract must prove multi-city `listCities()` ordering, not only the pure sorting helper.
- Let IndexedDB clone save values at `add/put`; do not pre-`structuredClone()` complete snapshots in the adapter.
- A mutating operation may return success only after its transaction `oncomplete` fires.
- Inside one transaction callback, await only IndexedDB requests belonging to that transaction. No timers, fetches, another database open, or unrelated promises may occur between requests.
- Do not inspect or validate gameplay snapshots in TypeScript.
- Do not add production storage libraries, repositories, services, registries, migrations, compatibility readers, retries, recovery, multi-tab ownership, quota handling, or security frameworks.
- Do not change `src/main.ts`, `createGameRuntime()`, Svelte UI, or the anonymous development bootstrap in HPA-343.
- Development saves are disposable; a future breaking schema can use a new database name/version instead of migration code.
- Keep tests in the existing `runtime` Vitest project; do not add a browser Vitest project or Playwright-only persistence hook.
- `fake-indexeddb` proves adapter behavior only. HPA-345 must confirm a real Rust/WASM snapshot writes through actual Chromium IndexedDB; HPA-346 owns the full `New City -> reload -> Continue/Load` browser flow.

---

## File structure

### Production

- Modify `src/persistence/citySaveStore.ts`
  - add shared record-to-summary projection;
  - add shared store-error envelope constructor;
  - keep the six-operation interface unchanged.
- Modify `src/persistence/memoryCitySaveStore.ts`
  - reuse the two shared helpers;
  - keep memory-only cloning/failure injection local.
- Modify `src/runtime/workingSaveRuntime.ts`
  - reuse `citySaveStoreError()` when a store call throws.
- Create `src/persistence/indexedDbCitySaveStore.ts`
  - own all browser IndexedDB details in one module.

### Tests

- Modify `tests/runtime/persistence/citySaveStoreContract.ts`
  - adapter-neutral contract;
  - shared test helpers;
  - multi-city ordering coverage.
- Modify `tests/runtime/persistence/memoryCitySaveStore.test.ts`
  - retain injected atomicity coverage only for the memory adapter.
- Create `tests/runtime/persistence/indexedDbCitySaveStore.test.ts`
  - shared contract;
  - reopen with Rust-shaped fixture;
  - real WASM snapshot round trip;
  - genuine IndexedDB abort-path preservation test.

### Tooling/docs

- Modify `package.json` and `bun.lock` for dev-only `fake-indexeddb`.
- Modify `docs/architecture.md` for the browser storage boundary.

---

### Task 1: Share store helpers and make the contract adapter-neutral

**Files:**
- Modify: `src/persistence/citySaveStore.ts`
- Modify: `src/persistence/memoryCitySaveStore.ts`
- Modify: `src/runtime/workingSaveRuntime.ts`
- Modify: `tests/runtime/persistence/citySaveStoreContract.ts`
- Modify: `tests/runtime/persistence/memoryCitySaveStore.test.ts`

**Interfaces:**
- Consumes: existing `CitySaveRecord`, `CitySummary`, `CitySaveStore`, `CitySaveStoreError`, `CitySaveStoreResult`.
- Produces: `citySummaryFromRecord(record: CitySaveRecord): CitySummary`.
- Produces: `citySaveStoreError(operation, code, options?): CitySaveStoreError`.
- Produces: `defineCitySaveStoreContract(name, createStore)` without a failure-injection interface.
- Produces test-only: `expectCitySaveStoreOk()` and `makeCitySaveRecord()`.
- Preserves: `MemoryCitySaveStoreFailureControls` only for memory-specific failure tests.

- [ ] **Step 1: Add the shared record projection and error envelope**

In `src/persistence/citySaveStore.ts`, add:

```ts
export interface CitySaveStoreErrorOptions {
  cityId?: string;
  diagnostic?: string;
}

export function citySummaryFromRecord(record: CitySaveRecord): CitySummary {
  return {
    id: record.city.id,
    name: record.city.name,
    createdAt: record.city.createdAt,
    savedAt: record.savedAt,
  };
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

Tighten the interface atomicity comment so it applies equally to Map, IndexedDB, and native files:

```ts
/**
 * Atomicity guarantee: a mutation that returns an error (or rejects) must not
 * have committed the mutation. Specifically:
 * - a failed `createCity` commits nothing — `readCity(id)` remains `notFound`;
 * - a failed `updateCity`/`renameCity` leaves the complete prior record intact.
 * Adapters must not report success before their storage commit boundary.
 */
```

Do not add an error class, adapter base type, or generic transaction abstraction.

- [ ] **Step 2: Reuse the helpers from MemoryCitySaveStore**

In `src/persistence/memoryCitySaveStore.ts`, import:

```ts
import {
  citySaveStoreError,
  citySummaryFromRecord,
  sortCitySummaries,
  type CitySaveRecord,
  type CitySaveStore,
  type CitySaveStoreErrorCode,
  type CitySaveStoreOperation,
  type CitySaveStoreResult,
} from "./citySaveStore";
```

Replace the private error-envelope construction with a wrapper over the shared helper:

```ts
function errorResult<T>(
  operation: CitySaveStoreOperation,
  code: CitySaveStoreErrorCode,
  cityId?: string,
): CitySaveStoreResult<T> {
  return {
    ok: false,
    error: citySaveStoreError(operation, code, {
      cityId,
      ...(code === "failed" ? { diagnostic: `${operation} failed` } : {}),
    }),
  };
}
```

Delete the private `summaryFor()` and replace its usages with `citySummaryFromRecord()`:

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

Keep `cloneValue()`, failure queues, and injected-failure controls memory-only.

- [ ] **Step 3: Reuse the error envelope for thrown store calls**

In `src/runtime/workingSaveRuntime.ts`, import `citySaveStoreError` from the existing store module and replace the manually reconstructed error object in `callStore()`:

```ts
return {
  ok: false,
  error: {
    kind: "store",
    error: citySaveStoreError(operation, "failed", {
      cityId,
      diagnostic: thrown instanceof Error ? thrown.message : String(thrown),
    }),
  },
};
```

Do not change `WorkingSaveError`, persistence state, busy behavior, or any runtime operation semantics.

- [ ] **Step 4: Export the two reusable test helpers**

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

Rename existing calls inside the contract from `expectOk()` / `makeRecord()` to these exported names.

Do not move these helpers to production or create another fixture framework. `tests/fixtures/citySave.ts` remains the Rust-shaped fixture and will be reused where that shape matters.

- [ ] **Step 5: Move injected atomicity failures into the memory suite**

In `tests/runtime/persistence/memoryCitySaveStore.test.ts`, import:

```ts
import {
  defineCitySaveStoreContract,
  expectCitySaveStoreOk,
  makeCitySaveRecord,
} from "./citySaveStoreContract";
```

Register the common contract without failure controls:

```ts
defineCitySaveStoreContract("MemoryCitySaveStore", () =>
  createMemoryCitySaveStore(),
);
```

Move the current shared injected create/update/rename failure cases into the existing memory-only failure block.

Create failure:

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

Update failure:

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

Rename failure:

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

Keep the existing injected `listCities` failure test in the same block. Do not expose `failNext` from any real adapter.

- [ ] **Step 6: Simplify the shared contract and add adapter-level ordering**

In `tests/runtime/persistence/citySaveStoreContract.ts`, delete `CitySaveStoreContractHarness` and change:

```ts
export function defineCitySaveStoreContract(
  name: string,
  createStore: () => CitySaveStore,
): void {
```

Inside each shared case, replace the harness destructuring with:

```ts
const store = createStore();
```

Delete the injected create/update/rename failure cases and their now-unused operation/error-code imports.

Add empty-list coverage:

```ts
it("starts with an empty city list", async () => {
  const store = createStore();
  expect(await expectCitySaveStoreOk(store.listCities())).toEqual([]);
});
```

Add an ordering case that catches both Map insertion order and IndexedDB key order:

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

Keep the existing direct `sortCitySummaries()` test because it separately proves non-mutating sort behavior.

- [ ] **Step 7: Run the full runtime-project verification for Task 1**

Task 1 changes the core store contract module plus `workingSaveRuntime.ts`, so do not verify only the memory file.

```bash
bunx vitest run --project runtime
bun run check
bun run format:check
```

Expected: the complete runtime Vitest project, TypeScript/Svelte checks, and formatting pass.

- [ ] **Step 8: Commit the shared helper/contract cleanup**

```bash
git add src/persistence/citySaveStore.ts src/persistence/memoryCitySaveStore.ts src/runtime/workingSaveRuntime.ts tests/runtime/persistence/citySaveStoreContract.ts tests/runtime/persistence/memoryCitySaveStore.test.ts
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
- Consumes: `CitySaveStore`, `CitySaveRecord`, `CitySaveStoreResult`, `citySaveStoreError()`, `citySummaryFromRecord()`, and `sortCitySummaries()` from `src/persistence/citySaveStore.ts`.
- Consumes test-only: `defineCitySaveStoreContract()`, `expectCitySaveStoreOk()`, and `makeCitySaveRecord()`.
- Consumes existing Rust-shaped fixture: `record()` from `tests/fixtures/citySave.ts`.
- Consumes existing WASM host: `createWasmBackend()` and `snapshotForSave()`.
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
import { createWasmBackend } from "../../../src/runtime/backend/wasmBackend";
import { record as citySaveRecord } from "../../fixtures/citySave";
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

const summary = {
  id: "city-1",
  name: "First",
  createdAt: "2026-08-01T10:00:00.000Z",
  savedAt: "2026-08-01T10:00:00.000Z",
};

defineCitySaveStoreContract("IndexedDbCitySaveStore", () => createStore());

describe("IndexedDbCitySaveStore persistence", () => {
  it("reopens a Rust-shaped record through a second adapter instance", async () => {
    const databaseName = nextDatabaseName();
    const saved = citySaveRecord(summary);

    const first = createStore(databaseName);
    await expectCitySaveStoreOk(first.createCity(saved));

    const second = createStore(databaseName);
    expect(
      await expectCitySaveStoreOk(second.readCity("city-1")),
    ).toEqual(saved);
  });

  it("stores and reads a real WASM snapshotForSave payload", async () => {
    const backend = await createWasmBackend();
    const captured = await backend.snapshotForSave();
    expect(captured.ok).toBe(true);
    if (!captured.ok) throw new Error("snapshotForSave failed");

    const store = createStore();
    const saved = citySaveRecord(summary, captured.snapshot);
    await expectCitySaveStoreOk(store.createCity(saved));

    const read = await expectCitySaveStoreOk(store.readCity("city-1"));
    expect(read).toEqual(saved);
  });

  it("aborts an uncloneable update and preserves the previous record", async () => {
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

Inject `fakeIndexedDB` directly. Do not install `fake-indexeddb/auto` globals for unrelated tests.

The reopen case intentionally uses the existing Rust-shaped fixture. The second case uses the real WASM save payload. The third case intentionally uses a function because it must fail structured cloning.

- [ ] **Step 3: Run the new file and confirm it is red because the adapter is absent**

```bash
bunx vitest run --project runtime tests/runtime/persistence/indexedDbCitySaveStore.test.ts
```

Expected: FAIL because `src/persistence/indexedDbCitySaveStore.ts` does not exist.

This is only the TDD wiring/red-state check. It is not behavioral evidence for IndexedDB atomicity; the behavioral proof comes after the adapter exists and the uncloneable update reaches `store.put()`.

- [ ] **Step 4: Implement the raw IndexedDB adapter**

Create `src/persistence/indexedDbCitySaveStore.ts`:

```ts
import {
  citySaveStoreError,
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

function failure<T>(
  operation: CitySaveStoreOperation,
  code: CitySaveStoreErrorCode,
  cityId?: string,
  diagnostic?: string,
): CitySaveStoreResult<T> {
  return {
    ok: false,
    error: citySaveStoreError(operation, code, { cityId, diagnostic }),
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
      reject(
        transaction.error ?? new Error("IndexedDB transaction aborted"),
      );
  });
}

async function runTransaction<T>(
  database: IDBDatabase,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => Promise<T>,
): Promise<T> {
  const transaction = database.transaction(CITY_STORE_NAME, mode);
  const done = transactionDone(transaction);

  // IndexedDB transactions are active only in their creation/request-event
  // tasks. `run` may await requests issued by this transaction, but must not
  // await timers, network work, another openDatabase(), or unrelated promises
  // between requests.
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
      const records = (await runTransaction(
        database,
        "readonly",
        async (store) => requestResult(store.getAll()),
      )) as CitySaveRecord[];
      return {
        ok: true,
        value: sortCitySummaries(records.map(citySummaryFromRecord)),
      };
    } catch (error) {
      return failure("listCities", "failed", undefined, errorName(error));
    }
  };

  const readCity: CitySaveStore["readCity"] = async (id) => {
    try {
      const database = await openDatabase();
      const record = (await runTransaction(
        database,
        "readonly",
        async (store) => requestResult(store.get(id)),
      )) as CitySaveRecord | undefined;
      return record === undefined
        ? failure("readCity", "notFound", id)
        : { ok: true, value: record };
    } catch (error) {
      return failure("readCity", "failed", id, errorName(error));
    }
  };

  const createCity: CitySaveStore["createCity"] = async (record) => {
    const id = record.city.id;
    const summary = citySummaryFromRecord(record);

    try {
      const database = await openDatabase();
      await runTransaction(database, "readwrite", async (store) => {
        // IndexedDB clones the value as part of add(). Do not structuredClone
        // the full game snapshot first.
        await requestResult(store.add(record, id));
      });
      return { ok: true, value: summary };
    } catch (error) {
      const name = errorName(error);
      return failure(
        "createCity",
        name === "ConstraintError" ? "conflict" : "failed",
        id,
        name,
      );
    }
  };

  const updateCity: CitySaveStore["updateCity"] = async (id, update) => {
    try {
      const database = await openDatabase();
      const summary = await runTransaction(
        database,
        "readwrite",
        async (store) => {
          const existing = (await requestResult(store.get(id))) as
            | CitySaveRecord
            | undefined;
          if (existing === undefined) return null;

          const next: CitySaveRecord = {
            city: existing.city,
            savedAt: update.savedAt,
            snapshot: update.snapshot,
          };
          const nextSummary = citySummaryFromRecord(next);

          // put() performs the storage clone. DataCloneError is therefore
          // thrown inside runTransaction(), whose catch aborts this transaction.
          await requestResult(store.put(next, id));
          return nextSummary;
        },
      );
      return summary === null
        ? failure("updateCity", "notFound", id)
        : { ok: true, value: summary };
    } catch (error) {
      return failure("updateCity", "failed", id, errorName(error));
    }
  };

  const renameCity: CitySaveStore["renameCity"] = async (id, name) => {
    try {
      const database = await openDatabase();
      const summary = await runTransaction(
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
          const nextSummary = citySummaryFromRecord(next);
          await requestResult(store.put(next, id));
          return nextSummary;
        },
      );
      return summary === null
        ? failure("renameCity", "notFound", id)
        : { ok: true, value: summary };
    } catch (error) {
      return failure("renameCity", "failed", id, errorName(error));
    }
  };

  const deleteCity: CitySaveStore["deleteCity"] = async (id) => {
    try {
      const database = await openDatabase();
      const deleted = await runTransaction(
        database,
        "readwrite",
        async (store) => {
          const existingKey = await requestResult(store.getKey(id));
          if (existingKey === undefined) return false;
          await requestResult(store.delete(id));
          return true;
        },
      );
      return deleted
        ? { ok: true, value: undefined }
        : failure("deleteCity", "notFound", id);
    } catch (error) {
      return failure("deleteCity", "failed", id, errorName(error));
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

`runTransaction()` is a file-local IndexedDB completion/abort bridge, not a reusable persistence abstraction. Keep it in this module and keep the no-non-IDB-await invariant beside it.

There is intentionally no manual `structuredClone()` in `createCity` or `updateCity`: IndexedDB clones at `add/put`, which both avoids a second full snapshot copy and ensures clone failure is observed inside the transaction boundary.

- [ ] **Step 5: Run focused persistence tests and confirm the real failure path**

```bash
bunx vitest run --project runtime tests/runtime/persistence/indexedDbCitySaveStore.test.ts tests/runtime/persistence/memoryCitySaveStore.test.ts tests/runtime/wasmBackend.test.ts
```

Expected:

- shared contract passes for both adapters;
- reopen works with the Rust-shaped fixture;
- a real `snapshotForSave()` payload round-trips through the IndexedDB adapter;
- the uncloneable update returns `failed` and the prior complete record remains unchanged.

When reviewing the implementation, confirm the uncloneable case reaches `store.put(next, id)` rather than being rejected by a pre-clone guard.

- [ ] **Step 6: Document the browser storage boundary and transaction invariant**

In `docs/architecture.md`, immediately after the `workingSaveRuntime.ts` persistence paragraph, add:

```md
The browser persistence adapter is `indexedDbCitySaveStore.ts`: one
`caelum-city-saves-v1` IndexedDB database, one `cities` object store, and full
`CitySaveRecord` values keyed by opaque city ID. It implements the six
`CitySaveStore` operations directly, derives/sorts list summaries from the same
records, lets IndexedDB clone values at `add`/`put`, and has no metadata index,
migration layer, recovery model, or multi-tab ownership. Multi-request
transactions keep only IndexedDB request awaits between requests so the
transaction remains active. HPA-345 owns wiring the adapter into the first
no-city/New City browser flow; the current anonymous development bootstrap
remains unchanged until then.
```

- [ ] **Step 7: Run the complete frontend verification gate**

```bash
bun run test:unit
bun run check
bun run lint
bun run format:check
bun run build
```

Expected: all commands pass.

Do not add HPA-343-specific Playwright or Rust work. HPA-343 has no app wiring or Rust implementation changes; the real-browser proof begins downstream in HPA-345.

- [ ] **Step 8: Verify the intended scope and absence of redundant cloning**

```bash
git diff --stat main...HEAD
git grep -n "createIndexedDbCitySaveStore" -- src tests docs
git grep -n "structuredClone" -- src/persistence/indexedDbCitySaveStore.ts || true
git grep -n "getKey" -- src/persistence/indexedDbCitySaveStore.ts
```

Expected:

- production factory usage exists only in the IndexedDB module;
- tests import the factory;
- `src/main.ts`, `src/runtime/createGameRuntime.ts`, and Svelte components are unchanged;
- no `structuredClone` call exists in the IndexedDB adapter;
- delete uses `getKey(id)` before `delete(id)`;
- no migration/index/recovery/multi-tab modules were added.

- [ ] **Step 9: Commit the adapter**

```bash
git add package.json bun.lock src/persistence/indexedDbCitySaveStore.ts tests/runtime/persistence/indexedDbCitySaveStore.test.ts docs/architecture.md
git commit -m "feat: add IndexedDB city save store"
```

---

## Review checkpoints

### Atomicity checkpoint

The IndexedDB-specific uncloneable update is load-bearing evidence. The implementation is wrong if it catches clone failure before entering `runTransaction()`.

Expected path:

```text
updateCity
  -> open database
  -> begin readwrite transaction
  -> get existing record
  -> build replacement
  -> store.put(replacement, id)
  -> DataCloneError
  -> runTransaction catch
  -> transaction.abort()
  -> operation returns failed
  -> prior record still readable unchanged
```

Do not expand this into an every-operation failure matrix. One real write failure proves the common transaction-abort path; memory retains deterministic injected coverage for its own commit seam.

### Snapshot compatibility checkpoint

HPA-343 has two levels of evidence:

1. Rust-shaped fixture survives IndexedDB reopen.
2. Current real WASM `snapshotForSave()` survives create/read through `fake-indexeddb`.

Neither is real-browser evidence. HPA-345's Chromium New City flow is the browser cloneability proof for the Rust/WASM snapshot payload. HPA-346 later proves reload + restore through player UI.

### Transaction-lifetime checkpoint

The file-local transaction callback may await only IndexedDB requests issued against its current transaction. Do not add:

- `setTimeout`/sleep;
- fetch/network work;
- another `openDatabase()`;
- unrelated async helpers;
- UI/runtime calls

between `get` and `put/delete`.

If future work needs such asynchronous work, perform it before opening the transaction or redesign that operation explicitly. Do not silently insert it into the current callback.

---

## Plan self-review

- **Spec coverage:** one database/store, six operations, shared summary/error helpers, create conflict, genuine transaction-abort preservation, detached values, Rust-shaped reopen, real WASM snapshot round trip, list ordering, adapter-only boundary, and downstream browser proof are covered.
- **Placeholder scan:** no TODO/TBD or unspecified implementation steps remain.
- **Type consistency:** the plan reuses the existing `CitySaveStore`, `CitySaveRecord`, `CitySummary`, `CitySaveStoreError`, and `createGameRuntime({ saveStore })` contracts without compatibility types.
- **Atomicity consistency:** no pre-`structuredClone()` bypasses the IndexedDB failure path; request success is not treated as commit success.
- **Transaction consistency:** every multi-request transaction documents and follows the no-non-IDB-await invariant.
- **Scope check:** HPA-343 remains one browser-storage subsystem. HPA-345 and HPA-346 retain player-flow ownership; HPA-344 remains the independent native adapter.