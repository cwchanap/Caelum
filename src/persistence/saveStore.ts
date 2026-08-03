import type {
  UntrustedSaveValue,
  WritableSaveEnvelope,
  SaveEnvelopeSummary,
} from "./envelope";
import type { SaveCompatibility } from "./envelopeInspection";

/**
 * Stable identifier for the underlying durable storage a `SaveStore` addresses.
 *
 * Two adapter objects that target the same durable database (e.g. two
 * `DelayedSaveStore` wrappers around the same `MemorySaveStore`, or two
 * IndexedDB handles to the same database name) MUST expose the same
 * `storageIdentity` so the runtime persistence coordinator can serialize
 * operations across runtime lifetimes against that storage.
 *
 * When a `SaveStore` does not expose `storageIdentity`, the coordinator
 * falls back to object identity — each adapter instance gets its own
 * coordinator. This is safe for single-adapter usage but does not protect
 * against two adapter objects targeting the same durable database.
 */
export type StorageIdentity = string;

export interface SaveHeaderSummary {
  appVersion: string | null;
  snapshotSchemaVersion: number | null;
  summary: SaveEnvelopeSummary | null;
  compatibility: SaveCompatibility;
}

export interface CitySummary extends SaveHeaderSummary {
  cityId: string;
  name: string | null;
  cityCreatedAt: string | null;
  savedAt: string | null;
}

export interface CheckpointSummary extends SaveHeaderSummary {
  checkpointId: string;
  cityId: string;
  name: string;
  note: string | null;
  createdAt: string;
}

export interface AutosaveSummary extends SaveHeaderSummary {
  autosaveId: string;
  cityId: string;
  generation: number;
  createdAt: string;
}

export interface AutosaveListing {
  items: AutosaveSummary[];
  generationHighWaterMark: number | null;
}

export type SaveStoreOperation =
  | "listCities"
  | "readWorkingSave"
  | "writeWorkingSave"
  | "createWorkingSave"
  | "renameCity"
  | "duplicateCity"
  | "deleteCity"
  | "restoreWorkingSaveRaw"
  | "listCheckpoints"
  | "readCheckpoint"
  | "writeCheckpoint"
  | "renameCheckpoint"
  | "deleteCheckpoint"
  | "listAutosaves"
  | "readAutosave"
  | "writeAutosave"
  | "deleteAutosave";

export type SaveStoreErrorCode =
  | "notFound"
  | "conflict"
  | "incompatibleRecord"
  | "corruptRecord"
  | "quotaExceeded"
  | "permissionDenied"
  | "unavailable"
  | "transactionAborted"
  | "serializationFailed"
  | "ioFailure";

export interface SaveStoreError {
  operation: SaveStoreOperation;
  code: SaveStoreErrorCode;
  cityId?: string;
  recordId?: string;
  retryable: boolean;
  diagnostic: string;
}

export type SaveStoreResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: SaveStoreError };

export interface SaveStore {
  /**
   * Stable identity for the durable storage this adapter addresses. When
   * provided, the runtime persistence coordinator uses it to serialize
   * operations across runtime lifetimes against the same storage. See
   * {@link StorageIdentity} for the contract.
   */
  readonly storageIdentity?: StorageIdentity;

  listCities(): Promise<SaveStoreResult<CitySummary[]>>;

  readWorkingSave(cityId: string): Promise<SaveStoreResult<UntrustedSaveValue>>;
  writeWorkingSave(
    envelope: WritableSaveEnvelope,
  ): Promise<SaveStoreResult<CitySummary>>;
  /**
   * Atomically create a working-save record for a city only if NO storage
   * already exists for the city ID — no working record, no checkpoints, no
   * autosaves, and no generation high-water metadata. Used by the runtime's
   * New City activation to prove the initial write created the city's storage
   * rather than overwriting a pre-existing city.
   *
   * Returns `conflict` when ANY storage already exists for the city ID. This
   * is an atomic create-only operation: the existence check and the write
   * commit in the same transaction, so a concurrent create for the same ID
   * cannot overwrite an existing record. Do NOT implement this as a
   * `readWorkingSave` followed by `writeWorkingSave` — that remains
   * vulnerable to time-of-check/time-of-use races from other storage
   * consumers.
   *
   * `writeWorkingSave` remains the upsert operation for explicit Save Now
   * (updating an existing city's working record). This method is for the
   * initial New City write only.
   */
  createWorkingSave(
    envelope: WritableSaveEnvelope,
  ): Promise<SaveStoreResult<CitySummary>>;
  renameCity(
    cityId: string,
    name: string,
  ): Promise<SaveStoreResult<CitySummary>>;
  duplicateCity(
    sourceCityId: string,
    identity: {
      cityId: string;
      name: string;
      cityCreatedAt: string;
      savedAt: string;
      appVersion: string;
    },
  ): Promise<SaveStoreResult<CitySummary>>;
  deleteCity(cityId: string): Promise<SaveStoreResult<void>>;
  /**
   * Restore a previously-read raw working-save value for a city. Used by the
   * runtime's late-success cleanup to undo an orphan New City write that
   * overwrote a pre-existing record: the caller captures the prior
   * {@link UntrustedSaveValue} via {@link readWorkingSave} before the write,
   * and writes it back through this method when the write succeeded after
   * the transaction decided to roll back.
   *
   * The `value` MUST be a value previously returned by `readWorkingSave` for
   * the same `cityId`. Implementations re-inspect it and store it verbatim;
   * they do not re-derive or normalize the snapshot. This is the only store
   * operation that accepts an `UntrustedSaveValue` for writing — it exists so
   * late-success cleanup can restore a pre-existing record that an
   * uncancellable `writeWorkingSave` overwrote, without an unsafe cast and
   * without deleting a city whose ID collided with the New City identity.
   */
  restoreWorkingSaveRaw(
    cityId: string,
    value: UntrustedSaveValue,
  ): Promise<SaveStoreResult<void>>;

  listCheckpoints(
    cityId: string,
  ): Promise<SaveStoreResult<CheckpointSummary[]>>;
  readCheckpoint(
    cityId: string,
    checkpointId: string,
  ): Promise<SaveStoreResult<UntrustedSaveValue>>;
  writeCheckpoint(input: {
    checkpointId: string;
    cityId: string;
    name: string;
    note: string | null;
    envelope: WritableSaveEnvelope;
  }): Promise<SaveStoreResult<CheckpointSummary>>;
  renameCheckpoint(
    cityId: string,
    checkpointId: string,
    name: string,
  ): Promise<SaveStoreResult<CheckpointSummary>>;
  deleteCheckpoint(
    cityId: string,
    checkpointId: string,
  ): Promise<SaveStoreResult<void>>;

  listAutosaves(cityId: string): Promise<SaveStoreResult<AutosaveListing>>;
  readAutosave(
    cityId: string,
    autosaveId: string,
  ): Promise<SaveStoreResult<UntrustedSaveValue>>;
  writeAutosave(input: {
    autosaveId: string;
    cityId: string;
    generation: number;
    envelope: WritableSaveEnvelope;
  }): Promise<SaveStoreResult<AutosaveSummary>>;
  deleteAutosave(
    cityId: string,
    autosaveId: string,
  ): Promise<SaveStoreResult<void>>;
}

function compareIds(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareTimestampsDescending(
  left: string | null,
  right: string | null,
): number {
  const leftTime = left === null ? Number.NaN : Date.parse(left);
  const rightTime = right === null ? Number.NaN : Date.parse(right);
  const leftIsValid = Number.isFinite(leftTime);
  const rightIsValid = Number.isFinite(rightTime);

  if (leftIsValid && rightIsValid) return rightTime - leftTime;
  if (leftIsValid) return -1;
  if (rightIsValid) return 1;
  return 0;
}

export function sortCitySummaries(
  summaries: readonly CitySummary[],
): CitySummary[] {
  return [...summaries].sort(
    (left, right) =>
      compareTimestampsDescending(left.savedAt, right.savedAt) ||
      compareIds(left.cityId, right.cityId),
  );
}

export function sortCheckpointSummaries(
  summaries: readonly CheckpointSummary[],
): CheckpointSummary[] {
  return [...summaries].sort(
    (left, right) =>
      compareTimestampsDescending(left.createdAt, right.createdAt) ||
      compareIds(left.checkpointId, right.checkpointId),
  );
}

export function sortAutosaveSummaries(
  summaries: readonly AutosaveSummary[],
): AutosaveSummary[] {
  return [...summaries].sort(
    (left, right) =>
      right.generation - left.generation ||
      compareIds(left.autosaveId, right.autosaveId),
  );
}
