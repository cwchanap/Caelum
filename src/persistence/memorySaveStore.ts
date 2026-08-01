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

function checkpointSummary(record: StoredCheckpoint): CheckpointSummary {
  const inspected = inspectSaveEnvelope(record.envelope);
  const valid =
    inspected.ok &&
    inspected.envelope.city.id === record.cityId &&
    inspected.envelope.savedAt === record.createdAt;
  return {
    checkpointId: record.checkpointId,
    cityId: record.cityId,
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

function autosaveSummary(record: StoredAutosave): AutosaveSummary {
  const inspected = inspectSaveEnvelope(record.envelope);
  const valid =
    inspected.ok &&
    inspected.envelope.city.id === record.cityId &&
    inspected.envelope.savedAt === record.createdAt;
  return {
    autosaveId: record.autosaveId,
    cityId: record.cityId,
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
    const failure = injectedFailure<CitySummary>("writeWorkingSave");
    if (failure) return failure;
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

    workingRecords.set(cityId, candidate.value);
    return cloneResult(
      citySummary(cityId, candidate.value),
      "writeWorkingSave",
      { cityId },
    );
  };

  const renameCity: SaveStore["renameCity"] = async (cityId, name) => {
    const failure = injectedFailure<CitySummary>("renameCity", { cityId });
    if (failure) return failure;
    if (!workingRecords.has(cityId)) {
      return errorResult("renameCity", "notFound", { cityId });
    }
    const source = inspectStoredEnvelope(
      "renameCity",
      cityId,
      workingRecords.get(cityId),
    );
    if (!source.ok) return source;
    const detachedSource = cloneResult(source.value, "renameCity", { cityId });
    if (!detachedSource.ok) return detachedSource;
    const renamed: InspectedSaveEnvelope = {
      ...detachedSource.value,
      city: { ...detachedSource.value.city, name },
    };

    workingRecords.set(cityId, renamed);
    return cloneResult(citySummary(cityId, renamed), "renameCity", { cityId });
  };

  const duplicateCity: SaveStore["duplicateCity"] = async (
    sourceCityId,
    identity,
  ) => {
    const failure = injectedFailure<CitySummary>("duplicateCity", {
      cityId: sourceCityId,
    });
    if (failure) return failure;
    if (!workingRecords.has(sourceCityId)) {
      return errorResult("duplicateCity", "notFound", {
        cityId: sourceCityId,
      });
    }
    const source = inspectStoredEnvelope(
      "duplicateCity",
      sourceCityId,
      workingRecords.get(sourceCityId),
    );
    if (!source.ok) return source;
    if (workingRecords.has(identity.cityId)) {
      return errorResult("duplicateCity", "conflict", {
        cityId: identity.cityId,
      });
    }
    const detachedSource = cloneResult(source.value, "duplicateCity", {
      cityId: sourceCityId,
    });
    if (!detachedSource.ok) return detachedSource;
    const detachedIdentity = cloneResult(identity, "duplicateCity", {
      cityId: sourceCityId,
    });
    if (!detachedIdentity.ok) return detachedIdentity;
    if (detachedIdentity.value.cityId.length === 0) {
      return errorResult("duplicateCity", "corruptRecord", {
        cityId: detachedIdentity.value.cityId,
      });
    }
    const duplicate: InspectedSaveEnvelope = {
      ...detachedSource.value,
      city: {
        id: detachedIdentity.value.cityId,
        name: detachedIdentity.value.name,
      },
      cityCreatedAt: detachedIdentity.value.cityCreatedAt,
      savedAt: detachedIdentity.value.savedAt,
      appVersion: detachedIdentity.value.appVersion,
    };

    workingRecords.set(detachedIdentity.value.cityId, duplicate);
    return cloneResult(
      citySummary(detachedIdentity.value.cityId, duplicate),
      "duplicateCity",
      { cityId: detachedIdentity.value.cityId },
    );
  };

  const deleteCity: SaveStore["deleteCity"] = async (cityId) => {
    const failure = injectedFailure<void>("deleteCity", { cityId });
    if (failure) return failure;
    const exists =
      workingRecords.has(cityId) ||
      checkpointRecords.has(cityId) ||
      autosaveRecords.has(cityId) ||
      generationHighWaterMarks.has(cityId);
    if (!exists) return errorResult("deleteCity", "notFound", { cityId });

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
      [...(checkpointRecords.get(cityId)?.values() ?? [])].map(
        checkpointSummary,
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
    const context = { cityId: input.cityId, recordId: input.checkpointId };
    const failure = injectedFailure<CheckpointSummary>(
      "writeCheckpoint",
      context,
    );
    if (failure) return failure;
    if (input.cityId.length === 0 || input.checkpointId.length === 0) {
      return errorResult("writeCheckpoint", "corruptRecord", context);
    }
    const candidate = cloneResult(input, "writeCheckpoint", context);
    if (!candidate.ok) return candidate;
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
    const context = { cityId, recordId: checkpointId };
    const failure = injectedFailure<CheckpointSummary>(
      "renameCheckpoint",
      context,
    );
    if (failure) return failure;
    const cityRecords = checkpointRecords.get(cityId);
    const existing = cityRecords?.get(checkpointId);
    if (!cityRecords || !existing) {
      return errorResult("renameCheckpoint", "notFound", context);
    }
    const candidate = cloneResult(
      { ...existing, name },
      "renameCheckpoint",
      context,
    );
    if (!candidate.ok) return candidate;
    const result = cloneResult(
      checkpointSummary(candidate.value),
      "renameCheckpoint",
      context,
    );
    if (!result.ok) return result;

    cityRecords.set(checkpointId, candidate.value);
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
    const listing: AutosaveListing = {
      items: sortAutosaveSummaries(
        [...(autosaveRecords.get(cityId)?.values() ?? [])].map(autosaveSummary),
      ),
      generationHighWaterMark: generationHighWaterMarks.get(cityId) ?? null,
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
    const context = { cityId: input.cityId, recordId: input.autosaveId };
    const failure = injectedFailure<AutosaveSummary>("writeAutosave", context);
    if (failure) return failure;
    if (
      input.cityId.length === 0 ||
      input.autosaveId.length === 0 ||
      !Number.isSafeInteger(input.generation) ||
      input.generation < 0
    ) {
      return errorResult("writeAutosave", "corruptRecord", context);
    }
    const candidate = cloneResult(input, "writeAutosave", context);
    if (!candidate.ok) return candidate;
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
    const cityRecords = autosaveRecords.get(candidate.value.cityId);
    if (cityRecords?.has(candidate.value.autosaveId)) {
      return errorResult("writeAutosave", "conflict", context);
    }
    const highWater = generationHighWaterMarks.get(candidate.value.cityId);
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
