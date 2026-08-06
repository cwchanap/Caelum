/**
 * Minimal six-operation city save store contract.
 *
 * This is the small save boundary consumed by the runtime. It replaces the
 * legacy 19-method {@link SaveStore} surface. The legacy store remains in
 * place for the remaining storage-adapter cutover; do not extend it.
 */

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

export type CitySaveStoreResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: CitySaveStoreError };

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

/**
 * Order city summaries by `savedAt` descending, then by `id` ascending.
 *
 * Ported verbatim from `saveStore.ts`'s `sortCitySummaries` (which sorts by
 * `savedAt` desc then `cityId` asc). The only adjustments are the field rename
 * `cityId` → `id` and the timestamp parameter type changing from
 * `string | null` to `string` (timestamps are now required). The NaN-handling
 * for invalid date strings is preserved so the ordering semantics for any given
 * input string are identical to the legacy comparator.
 *
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
