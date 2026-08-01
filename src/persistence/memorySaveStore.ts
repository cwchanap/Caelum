import type { InspectedSaveEnvelope, UntrustedSaveValue } from "./envelope";
import {
  inspectSaveEnvelope,
  type SaveCompatibility,
} from "./envelopeInspection";
import {
  sortAutosaveSummaries,
  sortCheckpointSummaries,
  sortCitySummaries,
  type AutosaveListing,
  type AutosaveSummary,
  type CheckpointSummary,
  type CitySummary,
  type SaveStore,
  type SaveStoreError,
  type SaveStoreErrorCode,
  type SaveStoreOperation,
  type SaveStoreResult,
} from "./saveStore";

export interface MemorySaveStore extends SaveStore {
  seedRawWorking(cityId: string, value: unknown): void;
  seedRawCheckpoint(seed: MemoryRawCheckpointSeed): void;
  seedRawAutosave(seed: MemoryRawAutosaveSeed): void;
}

export interface MemoryRawCheckpointSeed {
  storageCityId: string;
  storageCheckpointId: string;
  checkpointId: string;
  cityId: string;
  name: string;
  note: string | null;
  createdAt: string;
  envelope: unknown;
}

export interface MemoryRawAutosaveSeed {
  storageCityId: string;
  storageAutosaveId: string;
  autosaveId: string;
  cityId: string;
  generation: number;
  createdAt: string;
  envelope: unknown;
  generationHighWaterMark?: number;
}

export interface MemorySaveStoreFailureControls {
  failNext(operation: SaveStoreOperation, code: SaveStoreErrorCode): void;
}

interface StoredCheckpoint {
  checkpointId: string;
  cityId: string;
  name: string;
  note: string | null;
  createdAt: string;
  envelope: unknown;
}

interface StoredAutosave {
  autosaveId: string;
  cityId: string;
  generation: number;
  createdAt: string;
  envelope: unknown;
}

type FailureQueues = Map<SaveStoreOperation, SaveStoreErrorCode[]>;

const failureQueues = new WeakMap<
  MemorySaveStoreFailureControls,
  FailureQueues
>();

const RETRYABLE_CODES = new Set<SaveStoreErrorCode>([
  "unavailable",
  "transactionAborted",
  "ioFailure",
]);

function errorResult<T>(
  operation: SaveStoreOperation,
  code: SaveStoreErrorCode,
  context: { cityId?: string; recordId?: string } = {},
): SaveStoreResult<T> {
  const error: SaveStoreError = {
    operation,
    code,
    retryable: RETRYABLE_CODES.has(code),
    diagnostic: `${operation} failed with ${code}`,
    ...context,
  };
  return { ok: false, error };
}

function cloneResult<T>(
  value: T,
  operation: SaveStoreOperation,
  context: { cityId?: string; recordId?: string } = {},
): SaveStoreResult<T> {
  try {
    return { ok: true, value: structuredClone(value) as T };
  } catch {
    return errorResult(operation, "serializationFailed", context);
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isValidGeneration(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function incompatibleCode(
  compatibility: Exclude<SaveCompatibility, { status: "candidate" }>,
): "incompatibleRecord" | "corruptRecord" {
  switch (compatibility.status) {
    case "unsupportedEnvelope":
    case "unsupportedSnapshot":
      return "incompatibleRecord";
    case "corruptHeader":
    case "snapshotVersionMismatch":
      return "corruptRecord";
  }
}

function inspectStoredEnvelope(
  operation: SaveStoreOperation,
  cityId: string,
  value: unknown,
): SaveStoreResult<InspectedSaveEnvelope> {
  const inspected = inspectSaveEnvelope(value);
  if (!inspected.ok) {
    return errorResult(operation, incompatibleCode(inspected.compatibility), {
      cityId,
    });
  }
  if (inspected.envelope.city.id !== cityId) {
    return errorResult(operation, "corruptRecord", { cityId });
  }
  return { ok: true, value: inspected.envelope };
}

function corruptSummary(
  cityId: string,
  compatibility: SaveCompatibility,
): CitySummary {
  return {
    cityId,
    name: null,
    cityCreatedAt: null,
    savedAt: null,
    appVersion: null,
    snapshotSchemaVersion: null,
    summary: null,
    compatibility,
  };
}

function citySummary(cityId: string, value: unknown): CitySummary {
  const inspected = inspectSaveEnvelope(value);
  if (!inspected.ok) {
    return corruptSummary(cityId, inspected.compatibility);
  }
  const envelope = inspected.envelope;
  if (envelope.city.id !== cityId) {
    return corruptSummary(cityId, { status: "corruptHeader" });
  }
  return {
    cityId,
    name: envelope.city.name,
    cityCreatedAt: envelope.cityCreatedAt,
    savedAt: envelope.savedAt,
    appVersion: envelope.appVersion,
    snapshotSchemaVersion: envelope.snapshotSchemaVersion,
    summary: envelope.summary,
    compatibility: { status: "candidate" },
  };
}

function checkpointSummary(
  record: StoredCheckpoint,
  storageCityId = record.cityId,
  storageCheckpointId = record.checkpointId,
): CheckpointSummary {
  const inspected = inspectSaveEnvelope(record.envelope);
  const valid =
    inspected.ok &&
    record.cityId === storageCityId &&
    record.checkpointId === storageCheckpointId &&
    inspected.envelope.city.id === storageCityId &&
    inspected.envelope.savedAt === record.createdAt;
  return {
    checkpointId: storageCheckpointId,
    cityId: storageCityId,
    name: record.name,
    note: record.note,
    createdAt: record.createdAt,
    appVersion: valid ? inspected.envelope.appVersion : null,
    snapshotSchemaVersion: valid
      ? inspected.envelope.snapshotSchemaVersion
      : null,
    summary: valid ? inspected.envelope.summary : null,
    compatibility: valid
      ? { status: "candidate" }
      : inspected.ok
        ? { status: "corruptHeader" }
        : inspected.compatibility,
  };
}

function autosaveSummary(
  record: StoredAutosave,
  storageCityId = record.cityId,
  storageAutosaveId = record.autosaveId,
): AutosaveSummary {
  const inspected = inspectSaveEnvelope(record.envelope);
  const valid =
    inspected.ok &&
    record.cityId === storageCityId &&
    record.autosaveId === storageAutosaveId &&
    inspected.envelope.city.id === storageCityId &&
    inspected.envelope.savedAt === record.createdAt &&
    isValidGeneration(record.generation);
  return {
    autosaveId: storageAutosaveId,
    cityId: storageCityId,
    generation: record.generation,
    createdAt: record.createdAt,
    appVersion: valid ? inspected.envelope.appVersion : null,
    snapshotSchemaVersion: valid
      ? inspected.envelope.snapshotSchemaVersion
      : null,
    summary: valid ? inspected.envelope.summary : null,
    compatibility: valid
      ? { status: "candidate" }
      : inspected.ok
        ? { status: "corruptHeader" }
        : inspected.compatibility,
  };
}

export function createMemorySaveStoreFailureControls(): MemorySaveStoreFailureControls {
  const queues: FailureQueues = new Map();
  const controls: MemorySaveStoreFailureControls = {
    failNext: (operation, code) => {
      const queue = queues.get(operation) ?? [];
      queue.push(code);
      queues.set(operation, queue);
    },
  };
  failureQueues.set(controls, queues);
  return controls;
}

export function createMemorySaveStore(options?: {
  failures?: MemorySaveStoreFailureControls;
}): MemorySaveStore {
  const workingRecords = new Map<string, unknown>();
  const checkpointRecords = new Map<string, Map<string, StoredCheckpoint>>();
  const autosaveRecords = new Map<string, Map<string, StoredAutosave>>();
  const generationHighWaterMarks = new Map<string, number>();
  const queues = options?.failures
    ? failureQueues.get(options.failures)
    : undefined;

  function injectedFailure<T>(
    operation: SaveStoreOperation,
    context: { cityId?: string; recordId?: string } = {},
  ): SaveStoreResult<T> | null {
    const queue = queues?.get(operation);
    const code = queue?.shift();
    if (queue?.length === 0) queues?.delete(operation);
    return code === undefined ? null : errorResult(operation, code, context);
  }

  function cityStorageExists(cityId: string): boolean {
    return (
      workingRecords.has(cityId) ||
      checkpointRecords.has(cityId) ||
      autosaveRecords.has(cityId) ||
      generationHighWaterMarks.has(cityId)
    );
  }

  const listCities: SaveStore["listCities"] = async () => {
    const failure = injectedFailure<CitySummary[]>("listCities");
    if (failure) return failure;
    const summaries = sortCitySummaries(
      [...workingRecords].map(([cityId, value]) => citySummary(cityId, value)),
    );
    return cloneResult(summaries, "listCities");
  };

  const readWorkingSave: SaveStore["readWorkingSave"] = async (cityId) => {
    const failure = injectedFailure<UntrustedSaveValue>("readWorkingSave", {
      cityId,
    });
    if (failure) return failure;
    if (!workingRecords.has(cityId)) {
      return errorResult("readWorkingSave", "notFound", { cityId });
    }
    return cloneResult(workingRecords.get(cityId), "readWorkingSave", {
      cityId,
    });
  };

  const writeWorkingSave: SaveStore["writeWorkingSave"] = async (envelope) => {
    const candidate = cloneResult(envelope, "writeWorkingSave");
    if (!candidate.ok) return candidate;
    const inspected = inspectSaveEnvelope(candidate.value);
    if (!inspected.ok) {
      return errorResult(
        "writeWorkingSave",
        incompatibleCode(inspected.compatibility),
      );
    }
    const cityId = inspected.envelope.city.id;
    if (cityId.length === 0) {
      return errorResult("writeWorkingSave", "corruptRecord", { cityId });
    }
    const failure = injectedFailure<CitySummary>("writeWorkingSave", {
      cityId,
    });
    if (failure) return failure;

    workingRecords.set(cityId, candidate.value);
    return cloneResult(
      citySummary(cityId, candidate.value),
      "writeWorkingSave",
      { cityId },
    );
  };

  const renameCity: SaveStore["renameCity"] = async (cityId, name) => {
    const input = cloneResult({ cityId, name }, "renameCity");
    if (!input.ok) return input;
    if (
      !isNonEmptyString(input.value.cityId) ||
      typeof input.value.name !== "string"
    ) {
      return errorResult("renameCity", "corruptRecord");
    }
    const context = { cityId: input.value.cityId };
    const failure = injectedFailure<CitySummary>("renameCity", context);
    if (failure) return failure;
    if (!workingRecords.has(input.value.cityId)) {
      return errorResult("renameCity", "notFound", context);
    }
    const source = inspectStoredEnvelope(
      "renameCity",
      input.value.cityId,
      workingRecords.get(input.value.cityId),
    );
    if (!source.ok) return source;
    const detachedSource = cloneResult(source.value, "renameCity", context);
    if (!detachedSource.ok) return detachedSource;
    const renamed: InspectedSaveEnvelope = {
      ...detachedSource.value,
      city: { ...detachedSource.value.city, name: input.value.name },
    };

    workingRecords.set(input.value.cityId, renamed);
    return cloneResult(
      citySummary(input.value.cityId, renamed),
      "renameCity",
      context,
    );
  };

  const duplicateCity: SaveStore["duplicateCity"] = async (
    sourceCityId,
    identity,
  ) => {
    const input = cloneResult({ sourceCityId, identity }, "duplicateCity");
    if (!input.ok) return input;
    if (
      !isNonEmptyString(input.value.sourceCityId) ||
      !isNonEmptyString(input.value.identity.cityId) ||
      typeof input.value.identity.name !== "string" ||
      typeof input.value.identity.cityCreatedAt !== "string" ||
      typeof input.value.identity.savedAt !== "string" ||
      typeof input.value.identity.appVersion !== "string"
    ) {
      return errorResult("duplicateCity", "corruptRecord");
    }
    const sourceContext = { cityId: input.value.sourceCityId };
    const failure = injectedFailure<CitySummary>(
      "duplicateCity",
      sourceContext,
    );
    if (failure) return failure;
    if (!workingRecords.has(input.value.sourceCityId)) {
      return errorResult("duplicateCity", "notFound", sourceContext);
    }
    const source = inspectStoredEnvelope(
      "duplicateCity",
      input.value.sourceCityId,
      workingRecords.get(input.value.sourceCityId),
    );
    if (!source.ok) return source;
    const targetCityId = input.value.identity.cityId;
    if (cityStorageExists(targetCityId)) {
      return errorResult("duplicateCity", "conflict", {
        cityId: targetCityId,
      });
    }
    const detachedSource = cloneResult(
      source.value,
      "duplicateCity",
      sourceContext,
    );
    if (!detachedSource.ok) return detachedSource;
    const duplicate: InspectedSaveEnvelope = {
      ...detachedSource.value,
      city: {
        id: targetCityId,
        name: input.value.identity.name,
      },
      cityCreatedAt: input.value.identity.cityCreatedAt,
      savedAt: input.value.identity.savedAt,
      appVersion: input.value.identity.appVersion,
    };

    workingRecords.set(targetCityId, duplicate);
    return cloneResult(citySummary(targetCityId, duplicate), "duplicateCity", {
      cityId: targetCityId,
    });
  };

  const deleteCity: SaveStore["deleteCity"] = async (cityId) => {
    const failure = injectedFailure<void>("deleteCity", { cityId });
    if (failure) return failure;
    if (!cityStorageExists(cityId)) {
      return errorResult("deleteCity", "notFound", { cityId });
    }

    workingRecords.delete(cityId);
    checkpointRecords.delete(cityId);
    autosaveRecords.delete(cityId);
    generationHighWaterMarks.delete(cityId);
    return { ok: true, value: undefined };
  };

  const listCheckpoints: SaveStore["listCheckpoints"] = async (cityId) => {
    const failure = injectedFailure<CheckpointSummary[]>("listCheckpoints", {
      cityId,
    });
    if (failure) return failure;
    const summaries = sortCheckpointSummaries(
      [...(checkpointRecords.get(cityId)?.entries() ?? [])].map(
        ([checkpointId, record]) =>
          checkpointSummary(record, cityId, checkpointId),
      ),
    );
    return cloneResult(summaries, "listCheckpoints", { cityId });
  };

  const readCheckpoint: SaveStore["readCheckpoint"] = async (
    cityId,
    checkpointId,
  ) => {
    const context = { cityId, recordId: checkpointId };
    const failure = injectedFailure<UntrustedSaveValue>(
      "readCheckpoint",
      context,
    );
    if (failure) return failure;
    const record = checkpointRecords.get(cityId)?.get(checkpointId);
    if (!record) return errorResult("readCheckpoint", "notFound", context);
    return cloneResult(record.envelope, "readCheckpoint", context);
  };

  const writeCheckpoint: SaveStore["writeCheckpoint"] = async (input) => {
    const candidate = cloneResult(input, "writeCheckpoint");
    if (!candidate.ok) return candidate;
    if (
      !isNonEmptyString(candidate.value.cityId) ||
      !isNonEmptyString(candidate.value.checkpointId) ||
      typeof candidate.value.name !== "string" ||
      !isNullableString(candidate.value.note)
    ) {
      return errorResult("writeCheckpoint", "corruptRecord");
    }
    const context = {
      cityId: candidate.value.cityId,
      recordId: candidate.value.checkpointId,
    };
    const failure = injectedFailure<CheckpointSummary>(
      "writeCheckpoint",
      context,
    );
    if (failure) return failure;
    const inspected = inspectSaveEnvelope(candidate.value.envelope);
    if (!inspected.ok) {
      return errorResult(
        "writeCheckpoint",
        incompatibleCode(inspected.compatibility),
        context,
      );
    }
    if (inspected.envelope.city.id !== candidate.value.cityId) {
      return errorResult("writeCheckpoint", "corruptRecord", context);
    }
    const cityRecords = checkpointRecords.get(candidate.value.cityId);
    if (cityRecords?.has(candidate.value.checkpointId)) {
      return errorResult("writeCheckpoint", "conflict", context);
    }
    const record: StoredCheckpoint = {
      checkpointId: candidate.value.checkpointId,
      cityId: candidate.value.cityId,
      name: candidate.value.name,
      note: candidate.value.note,
      createdAt: inspected.envelope.savedAt,
      envelope: candidate.value.envelope,
    };
    const result = cloneResult(
      checkpointSummary(record),
      "writeCheckpoint",
      context,
    );
    if (!result.ok) return result;

    const committedRecords = cityRecords ?? new Map<string, StoredCheckpoint>();
    committedRecords.set(record.checkpointId, record);
    if (!cityRecords) checkpointRecords.set(record.cityId, committedRecords);
    return result;
  };

  const renameCheckpoint: SaveStore["renameCheckpoint"] = async (
    cityId,
    checkpointId,
    name,
  ) => {
    const input = cloneResult(
      { cityId, checkpointId, name },
      "renameCheckpoint",
    );
    if (!input.ok) return input;
    if (
      !isNonEmptyString(input.value.cityId) ||
      !isNonEmptyString(input.value.checkpointId) ||
      typeof input.value.name !== "string"
    ) {
      return errorResult("renameCheckpoint", "corruptRecord");
    }
    const context = {
      cityId: input.value.cityId,
      recordId: input.value.checkpointId,
    };
    const failure = injectedFailure<CheckpointSummary>(
      "renameCheckpoint",
      context,
    );
    if (failure) return failure;
    const cityRecords = checkpointRecords.get(input.value.cityId);
    const existing = cityRecords?.get(input.value.checkpointId);
    if (!cityRecords || !existing) {
      return errorResult("renameCheckpoint", "notFound", context);
    }
    const candidate = cloneResult(
      { ...existing, name: input.value.name },
      "renameCheckpoint",
      context,
    );
    if (!candidate.ok) return candidate;
    const result = cloneResult(
      checkpointSummary(
        candidate.value,
        input.value.cityId,
        input.value.checkpointId,
      ),
      "renameCheckpoint",
      context,
    );
    if (!result.ok) return result;

    cityRecords.set(input.value.checkpointId, candidate.value);
    return result;
  };

  const deleteCheckpoint: SaveStore["deleteCheckpoint"] = async (
    cityId,
    checkpointId,
  ) => {
    const context = { cityId, recordId: checkpointId };
    const failure = injectedFailure<void>("deleteCheckpoint", context);
    if (failure) return failure;
    const cityRecords = checkpointRecords.get(cityId);
    if (!cityRecords?.has(checkpointId)) {
      return errorResult("deleteCheckpoint", "notFound", context);
    }

    cityRecords.delete(checkpointId);
    if (cityRecords.size === 0) checkpointRecords.delete(cityId);
    return { ok: true, value: undefined };
  };

  const listAutosaves: SaveStore["listAutosaves"] = async (cityId) => {
    const failure = injectedFailure<AutosaveListing>("listAutosaves", {
      cityId,
    });
    if (failure) return failure;
    const generationHighWaterMark = generationHighWaterMarks.get(cityId);
    if (
      generationHighWaterMark !== undefined &&
      !isValidGeneration(generationHighWaterMark)
    ) {
      return errorResult("listAutosaves", "corruptRecord", { cityId });
    }
    const listing: AutosaveListing = {
      items: sortAutosaveSummaries(
        [...(autosaveRecords.get(cityId)?.entries() ?? [])].map(
          ([autosaveId, record]) => autosaveSummary(record, cityId, autosaveId),
        ),
      ),
      generationHighWaterMark: generationHighWaterMark ?? null,
    };
    return cloneResult(listing, "listAutosaves", { cityId });
  };

  const readAutosave: SaveStore["readAutosave"] = async (
    cityId,
    autosaveId,
  ) => {
    const context = { cityId, recordId: autosaveId };
    const failure = injectedFailure<UntrustedSaveValue>(
      "readAutosave",
      context,
    );
    if (failure) return failure;
    const record = autosaveRecords.get(cityId)?.get(autosaveId);
    if (!record) return errorResult("readAutosave", "notFound", context);
    return cloneResult(record.envelope, "readAutosave", context);
  };

  const writeAutosave: SaveStore["writeAutosave"] = async (input) => {
    const candidate = cloneResult(input, "writeAutosave");
    if (!candidate.ok) return candidate;
    if (
      !isNonEmptyString(candidate.value.cityId) ||
      !isNonEmptyString(candidate.value.autosaveId) ||
      !isValidGeneration(candidate.value.generation)
    ) {
      return errorResult("writeAutosave", "corruptRecord");
    }
    const context = {
      cityId: candidate.value.cityId,
      recordId: candidate.value.autosaveId,
    };
    const failure = injectedFailure<AutosaveSummary>("writeAutosave", context);
    if (failure) return failure;
    const inspected = inspectSaveEnvelope(candidate.value.envelope);
    if (!inspected.ok) {
      return errorResult(
        "writeAutosave",
        incompatibleCode(inspected.compatibility),
        context,
      );
    }
    if (inspected.envelope.city.id !== candidate.value.cityId) {
      return errorResult("writeAutosave", "corruptRecord", context);
    }
    const highWater = generationHighWaterMarks.get(candidate.value.cityId);
    if (highWater !== undefined && !isValidGeneration(highWater)) {
      return errorResult("writeAutosave", "corruptRecord", context);
    }
    const cityRecords = autosaveRecords.get(candidate.value.cityId);
    if (cityRecords?.has(candidate.value.autosaveId)) {
      return errorResult("writeAutosave", "conflict", context);
    }
    if (highWater !== undefined && candidate.value.generation <= highWater) {
      return errorResult("writeAutosave", "conflict", context);
    }
    const record: StoredAutosave = {
      autosaveId: candidate.value.autosaveId,
      cityId: candidate.value.cityId,
      generation: candidate.value.generation,
      createdAt: inspected.envelope.savedAt,
      envelope: candidate.value.envelope,
    };
    const result = cloneResult(
      autosaveSummary(record),
      "writeAutosave",
      context,
    );
    if (!result.ok) return result;

    const committedRecords = cityRecords ?? new Map<string, StoredAutosave>();
    committedRecords.set(record.autosaveId, record);
    if (!cityRecords) autosaveRecords.set(record.cityId, committedRecords);
    generationHighWaterMarks.set(record.cityId, record.generation);
    return result;
  };

  const deleteAutosave: SaveStore["deleteAutosave"] = async (
    cityId,
    autosaveId,
  ) => {
    const context = { cityId, recordId: autosaveId };
    const failure = injectedFailure<void>("deleteAutosave", context);
    if (failure) return failure;
    const cityRecords = autosaveRecords.get(cityId);
    if (!cityRecords?.has(autosaveId)) {
      return errorResult("deleteAutosave", "notFound", context);
    }

    cityRecords.delete(autosaveId);
    if (cityRecords.size === 0) autosaveRecords.delete(cityId);
    return { ok: true, value: undefined };
  };

  return {
    seedRawWorking: (cityId, value) => {
      workingRecords.set(cityId, structuredClone(value));
    },
    seedRawCheckpoint: (seed) => {
      const detached = structuredClone(seed);
      const cityRecords =
        checkpointRecords.get(detached.storageCityId) ??
        new Map<string, StoredCheckpoint>();
      cityRecords.set(detached.storageCheckpointId, {
        checkpointId: detached.checkpointId,
        cityId: detached.cityId,
        name: detached.name,
        note: detached.note,
        createdAt: detached.createdAt,
        envelope: detached.envelope,
      });
      checkpointRecords.set(detached.storageCityId, cityRecords);
    },
    seedRawAutosave: (seed) => {
      const detached = structuredClone(seed);
      const cityRecords =
        autosaveRecords.get(detached.storageCityId) ??
        new Map<string, StoredAutosave>();
      cityRecords.set(detached.storageAutosaveId, {
        autosaveId: detached.autosaveId,
        cityId: detached.cityId,
        generation: detached.generation,
        createdAt: detached.createdAt,
        envelope: detached.envelope,
      });
      autosaveRecords.set(detached.storageCityId, cityRecords);
      if (detached.generationHighWaterMark !== undefined) {
        generationHighWaterMarks.set(
          detached.storageCityId,
          detached.generationHighWaterMark,
        );
      }
    },
    listCities,
    readWorkingSave,
    writeWorkingSave,
    renameCity,
    duplicateCity,
    deleteCity,
    listCheckpoints,
    readCheckpoint,
    writeCheckpoint,
    renameCheckpoint,
    deleteCheckpoint,
    listAutosaves,
    readAutosave,
    writeAutosave,
    deleteAutosave,
  };
}
