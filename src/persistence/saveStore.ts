import type {
  UntrustedSaveValue,
  WritableSaveEnvelope,
  SaveEnvelopeSummary,
} from "./envelope";
import type { SaveCompatibility } from "./envelopeInspection";

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
  listCities(): Promise<SaveStoreResult<CitySummary[]>>;

  readWorkingSave(cityId: string): Promise<SaveStoreResult<UntrustedSaveValue>>;
  writeWorkingSave(
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
