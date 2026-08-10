/** The six-operation city save store contract consumed by the runtime. */

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

export interface CitySaveUpdate {
  savedAt: string;
  snapshot: unknown;
}

export type CitySaveStoreOperation =
  | "listCities"
  | "readCity"
  | "createCity"
  | "updateCity"
  | "renameCity"
  | "deleteCity";

export type CitySaveStoreErrorCode = "notFound" | "conflict" | "failed";

export interface CitySaveStoreError {
  operation: CitySaveStoreOperation;
  code: CitySaveStoreErrorCode;
  cityId?: string;
  diagnostic?: string;
}

export interface CitySaveStoreErrorOptions {
  cityId?: string;
  diagnostic?: string;
}

export type CitySaveStoreResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: CitySaveStoreError };

/**
 * Atomicity guarantee: a mutation that returns an error (or rejects) must not
 * have committed the mutation. Specifically:
 * - a failed `createCity` commits nothing — `readCity(id)` remains `notFound`;
 * - a failed `updateCity`/`renameCity` leaves the complete prior record intact.
 * Adapters must not report success before their storage commit boundary.
 */
export interface CitySaveStore {
  listCities(): Promise<CitySaveStoreResult<CitySummary[]>>;
  readCity(id: string): Promise<CitySaveStoreResult<CitySaveRecord>>;
  createCity(record: CitySaveRecord): Promise<CitySaveStoreResult<CitySummary>>;
  updateCity(
    id: string,
    update: CitySaveUpdate,
  ): Promise<CitySaveStoreResult<CitySummary>>;
  renameCity(
    id: string,
    name: string,
  ): Promise<CitySaveStoreResult<CitySummary>>;
  deleteCity(id: string): Promise<CitySaveStoreResult<void>>;
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

/**
 * Order city summaries by `savedAt` descending, then by `id` ascending.
 * Returns a copied array; the input is not mutated.
 */
export function sortCitySummaries(
  summaries: readonly CitySummary[],
): CitySummary[] {
  return [...summaries].sort(
    (left, right) =>
      compareTimestampsDescending(left.savedAt, right.savedAt) ||
      compareIds(left.id, right.id),
  );
}

function compareIds(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareTimestampsDescending(left: string, right: string): number {
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  const leftIsValid = Number.isFinite(leftTime);
  const rightIsValid = Number.isFinite(rightTime);

  if (leftIsValid && rightIsValid) return rightTime - leftTime;
  if (leftIsValid) return -1;
  if (rightIsValid) return 1;
  return 0;
}
