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

const DEFAULT_DATABASE_NAME = "caelum-city-saves-v8";
const DATABASE_VERSION = 8;
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
