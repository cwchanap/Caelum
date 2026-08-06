import {
  sortCitySummaries,
  type CitySaveRecord,
  type CitySaveStore,
  type CitySaveStoreError,
  type CitySaveStoreErrorCode,
  type CitySaveStoreOperation,
  type CitySaveStoreResult,
  type CitySummary,
} from "./citySaveStore";

/**
 * Failure-injection controls for the in-memory city save store. Used only by
 * tests to deterministically force the next occurrence of an operation to fail
 * with a given code. Production code constructs the store without these
 * controls.
 */
export interface MemoryCitySaveStoreFailureControls {
  failNext(
    operation: CitySaveStoreOperation,
    code: CitySaveStoreErrorCode,
  ): void;
}

type FailureQueues = Map<CitySaveStoreOperation, CitySaveStoreErrorCode[]>;

const failureQueues = new WeakMap<
  MemoryCitySaveStoreFailureControls,
  FailureQueues
>();

export function createMemoryCitySaveStoreFailureControls(): MemoryCitySaveStoreFailureControls {
  const queues: FailureQueues = new Map();
  const controls: MemoryCitySaveStoreFailureControls = {
    failNext: (operation, code) => {
      const queue = queues.get(operation) ?? [];
      queue.push(code);
      queues.set(operation, queue);
    },
  };
  failureQueues.set(controls, queues);
  return controls;
}

function errorResult<T>(
  operation: CitySaveStoreOperation,
  code: CitySaveStoreErrorCode,
  cityId?: string,
): CitySaveStoreResult<T> {
  const error: CitySaveStoreError = {
    operation,
    code,
    ...(cityId !== undefined ? { cityId } : {}),
    // Internal diagnostic kept generic and only for the catch-all `failed`
    // code; `notFound`/`conflict` are self-describing from operation + code.
    ...(code === "failed" ? { diagnostic: `${operation} failed` } : {}),
  };
  return { ok: false, error };
}

function cloneValue<T>(
  value: T,
  operation: CitySaveStoreOperation,
  cityId?: string,
): CitySaveStoreResult<T> {
  try {
    return { ok: true, value: structuredClone(value) as T };
  } catch {
    return errorResult<T>(operation, "failed", cityId);
  }
}

function summaryFor(record: CitySaveRecord): CitySummary {
  return {
    id: record.city.id,
    name: record.city.name,
    createdAt: record.city.createdAt,
    savedAt: record.savedAt,
  };
}

export function createMemoryCitySaveStore(options?: {
  failures?: MemoryCitySaveStoreFailureControls;
}): CitySaveStore {
  const records = new Map<string, CitySaveRecord>();
  const queues = options?.failures
    ? failureQueues.get(options.failures)
    : undefined;

  function injectedFailure<T>(
    operation: CitySaveStoreOperation,
    cityId?: string,
  ): CitySaveStoreResult<T> | null {
    const queue = queues?.get(operation);
    const code = queue?.shift();
    if (queue?.length === 0) queues?.delete(operation);
    return code === undefined ? null : errorResult<T>(operation, code, cityId);
  }

  const listCities: CitySaveStore["listCities"] = async () => {
    const failure = injectedFailure<CitySummary[]>("listCities");
    if (failure) return failure;
    const summaries = sortCitySummaries([...records.values()].map(summaryFor));
    return cloneValue(summaries, "listCities");
  };

  const readCity: CitySaveStore["readCity"] = async (id) => {
    const failure = injectedFailure<CitySaveRecord>("readCity", id);
    if (failure) return failure;
    const record = records.get(id);
    if (!record) return errorResult<CitySaveRecord>("readCity", "notFound", id);
    return cloneValue(record, "readCity", id);
  };

  // createCity: clone the full record, reject a duplicate id, apply any
  // injected failure, then commit. Cloning first means a hostile input getter
  // cannot reach storage and is reported as `failed`.
  const createCity: CitySaveStore["createCity"] = async (record) => {
    const cloned = cloneValue(record, "createCity");
    if (!cloned.ok) return cloned;
    const cityId = cloned.value.city.id;
    if (records.has(cityId)) {
      return errorResult<CitySummary>("createCity", "conflict", cityId);
    }
    const failure = injectedFailure<CitySummary>("createCity", cityId);
    if (failure) return failure;
    records.set(cityId, cloned.value);
    return cloneValue(summaryFor(cloned.value), "createCity", cityId);
  };

  // updateCity: require an existing record, clone the incoming update, build a
  // complete replacement that preserves the stored city identity (id/name/
  // createdAt) so a prior rename is not reverted, apply injected failure, then
  // commit. Building the candidate before the failure gate is safe — only
  // `records.set` commits, so a failed update leaves the prior record intact.
  const updateCity: CitySaveStore["updateCity"] = async (id, update) => {
    const existing = records.get(id);
    if (!existing)
      return errorResult<CitySummary>("updateCity", "notFound", id);
    const clonedUpdate = cloneValue(update, "updateCity", id);
    if (!clonedUpdate.ok) return clonedUpdate;
    const replacement: CitySaveRecord = {
      city: existing.city,
      savedAt: clonedUpdate.value.savedAt,
      snapshot: clonedUpdate.value.snapshot,
    };
    const failure = injectedFailure<CitySummary>("updateCity", id);
    if (failure) return failure;
    records.set(id, replacement);
    return cloneValue(summaryFor(replacement), "updateCity", id);
  };

  // renameCity: construct a replacement preserving every non-name field
  // (city.id, city.createdAt, savedAt, snapshot). A failed rename leaves the
  // prior record intact for the same reason as updateCity.
  const renameCity: CitySaveStore["renameCity"] = async (id, name) => {
    const existing = records.get(id);
    if (!existing)
      return errorResult<CitySummary>("renameCity", "notFound", id);
    const clonedName = cloneValue(name, "renameCity", id);
    if (!clonedName.ok) return clonedName;
    const replacement: CitySaveRecord = {
      ...existing,
      city: { ...existing.city, name: clonedName.value },
    };
    const failure = injectedFailure<CitySummary>("renameCity", id);
    if (failure) return failure;
    records.set(id, replacement);
    return cloneValue(summaryFor(replacement), "renameCity", id);
  };

  const deleteCity: CitySaveStore["deleteCity"] = async (id) => {
    if (!records.has(id)) {
      return errorResult<void>("deleteCity", "notFound", id);
    }
    const failure = injectedFailure<void>("deleteCity", id);
    if (failure) return failure;
    records.delete(id);
    return { ok: true, value: undefined };
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
