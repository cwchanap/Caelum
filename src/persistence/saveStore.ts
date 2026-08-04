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
   * disposed, or failed before finalization). Bootstrap reconciliation may
   * delete leftover pending records only when the adapter declares
   * `singleRealm: true`; a multi-realm adapter must preserve them because the
   * record may belong to a live transaction in another realm. `listCities`
   * includes pending records so reconciliation can classify them; production
   * UI that lists loadable cities should filter them out.
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
  | "deleteAutosave"
  | "inspectWorkingSaveState";

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

/**
 * The committed state of a city's working-save record, as observed by a single
 * coherent storage read. Used by the runtime's ambiguous-failure
 * reconciliation to classify whether a `createWorkingSave` or
 * `finalizeWorkingSave` operation committed before an ambiguous failure.
 *
 * - `"notFound"` — no working-save record exists for the city ID.
 * - `"pending"` — a pending record exists (created by `createWorkingSave` but
 *   not yet finalized by `finalizeWorkingSave`).
 * - `"active"` — a finalized record exists (the city is durable and loadable).
 *
 * Unlike a `readWorkingSave` + `listCities` two-call sequence, this is a single
 * storage observation with no inter-call race window. The runtime calls this
 * directly on the `SaveStore` (not through the persistence coordinator's
 * per-city FIFO) during an admitted foreground New City workflow, so it
 * remains callable after the lease begins closing — the foreground reservation
 * is counted by `drainAll`, so disposal waits for the entire workflow
 * including this read.
 */
export type WorkingSaveState = "notFound" | "pending" | "active";

export interface SaveStore {
  /**
   * Stable identity for the durable storage this adapter addresses. When
   * provided, the runtime persistence coordinator uses it to serialize
   * operations across runtime lifetimes against the same storage. See
   * {@link StorageIdentity} for the contract.
   */
  readonly storageIdentity?: StorageIdentity;

  /**
   * Whether this adapter guarantees its durable storage is only ever
   * accessed from a single realm/process (a single in-memory
   * `SharedPersistenceCoordinator` registry). When `true`, the runtime's
   * in-memory exclusive coordinator lease proves cross-consumer ownership,
   * so bootstrap reconciliation may safely delete leftover pending city
   * records from crashed New City transactions: no other realm can hold a
   * live New City transaction against the same storage.
   *
   * When `false` or absent, the storage may be shared across independent
   * realms/processes (e.g. multiple browser tabs, Tauri windows, or workers),
   * each with its own coordinator registry. The in-memory lease then proves
   * nothing about other realms: a pending record observed by realm B may
   * belong to a live New City transaction still running in realm A. Bootstrap
   * reconciliation MUST NOT delete pending records in this case — doing so
   * would destroy realm A's live transaction. Until durable transaction
   * ownership lands in HPA-539, New City admission is rejected up front for
   * these adapters with the typed `multiRealmNewCityUnsupported`
   * precondition error, before any storage mutation. A retained pending
   * record from a legacy, mixed-version, or external source is not repaired
   * by Reload alone; it requires owner-authorized or manual durable-storage
   * repair.
   *
   * In-memory test stores SHOULD declare `singleRealm: true` so the
   * bootstrap reconciliation tests exercise the deletion path.
   */
  readonly singleRealm?: boolean;

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
   * Bootstrap reconciliation deletes leftover pending records only for
   * `singleRealm: true` adapters. Multi-realm adapters preserve them because
   * the in-memory lease cannot establish ownership.
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
  /**
   * Atomically inspect the committed state of a city's working-save record in
   * a single storage observation, returning {@link WorkingSaveState}.
   *
   * Unlike a `readWorkingSave` + `listCities` two-call sequence, this is one
   * coherent read with no inter-call race window. The runtime uses this
   * during ambiguous-failure reconciliation of an admitted New City
   * transaction to classify whether a `createWorkingSave` or
   * `finalizeWorkingSave` operation committed before the failure. The call is
   * made directly by that owner workflow, including after the general lease
   * begins closing; it is not a public repair or ownership mechanism.
   *
   * Returns `{ ok: true, value: "notFound" }` when no working-save record
   * exists, `{ ok: true, value: "pending" }` when a pending record exists
   * (created but not finalized), and `{ ok: true, value: "active" }` when a
   * finalized record exists. Returns `{ ok: false, error }` when the
   * inspection itself failed (the committed state is unknowable).
   */
  inspectWorkingSaveState(
    cityId: string,
  ): Promise<SaveStoreResult<WorkingSaveState>>;
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
