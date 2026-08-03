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
  /**
   * Whether the city's working-save record is in the pending state created by
   * `createWorkingSave` but not yet finalized by `finalizeWorkingSave`.
   *
   * A pending record is a durable marker from a New City creation transaction
   * that committed its initial write but did not complete the runtime
   * transaction (the candidate was installed but the runtime crashed, was
   * disposed, or failed before finalization). Bootstrap reconciliation deletes
   * leftover pending records so a crashed New City does not leave an orphan
   * that blocks future creates for the same city ID. `listCities` includes
   * pending records so the reconciliation pass can find them; production UI
   * that lists loadable cities should filter them out.
   */
  pending: boolean;
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
  | "finalizeWorkingSave"
  | "renameCity"
  | "duplicateCity"
  | "deleteCity"
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
   * The created record is in a **pending** state: it is durably committed but
   * not yet finalized as an active city. The runtime MUST call
   * {@link finalizeWorkingSave} after the New City transaction succeeds
   * (candidate installed, state ready to publish) to flip the record from
   * pending to active. If the runtime crashes, is disposed, or fails before
   * finalization, the pending record remains in storage as a durable marker.
   * Bootstrap reconciliation deletes leftover pending records so a crashed
   * New City does not leave an orphan that blocks future creates for the same
   * city ID.
   *
   * Returns `conflict` when ANY storage already exists for the city ID
   * (including a pending record from a prior unfinalized create). This is an
   * atomic create-only operation: the existence check and the write commit in
   * the same transaction, so a concurrent create for the same ID cannot
   * overwrite an existing record. Do NOT implement this as a `readWorkingSave`
   * followed by `writeWorkingSave` — that remains vulnerable to
   * time-of-check/time-of-use races from other storage consumers.
   *
   * `writeWorkingSave` remains the upsert operation for explicit Save Now
   * (updating an existing city's working record). This method is for the
   * initial New City write only.
   */
  createWorkingSave(
    envelope: WritableSaveEnvelope,
  ): Promise<SaveStoreResult<CitySummary>>;
  /**
   * Atomically finalize a pending working-save record, flipping it from the
   * pending state (created by {@link createWorkingSave}) to an active city.
   * Called by the runtime's New City activation after the candidate is
   * installed and the runtime transaction is ready to publish success.
   *
   * Returns `notFound` if no working-save record exists for the city ID.
   * If the record is already finalized (not pending), the operation is
   * idempotent: it returns the current summary without error.
   *
   * This operation is atomic: the pending-to-active transition commits in a
   * single transaction. After finalization, the city is a durable, loadable
   * city that survives process restarts.
   */
  finalizeWorkingSave(cityId: string): Promise<SaveStoreResult<CitySummary>>;
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
