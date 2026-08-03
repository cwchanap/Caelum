import { createRustSnapshot } from "../../fixtures/rustSnapshot";
import {
  buildSaveEnvelope,
  type WritableSaveEnvelope,
} from "../../../src/persistence/envelope";
import type {
  AutosaveSummary,
  CheckpointSummary,
  CitySummary,
} from "../../../src/persistence/saveStore";
import type { RustGameSnapshot } from "../../../src/runtime/backend/types";

export function makeRustSnapshot(
  overrides: Partial<RustGameSnapshot> = {},
): RustGameSnapshot {
  return createRustSnapshot({ paused: true, ...overrides });
}

export function makeEnvelope(
  overrides: Partial<WritableSaveEnvelope> = {},
): WritableSaveEnvelope {
  const snapshot = overrides.snapshot ?? makeRustSnapshot();
  return {
    ...buildSaveEnvelope({
      city: { id: "city-1", name: "Test City" },
      cityCreatedAt: "2026-08-01T10:00:00.000Z",
      savedAt: "2026-08-01T10:05:00.000Z",
      appVersion: "0.1.0",
      snapshot,
    }),
    ...overrides,
    snapshot,
  };
}

export function makeCitySummary(
  overrides: Partial<CitySummary> = {},
): CitySummary {
  const envelope = makeEnvelope();
  return {
    cityId: envelope.city.id,
    name: envelope.city.name,
    cityCreatedAt: envelope.cityCreatedAt,
    savedAt: envelope.savedAt,
    appVersion: envelope.appVersion,
    snapshotSchemaVersion: envelope.snapshotSchemaVersion,
    summary: envelope.summary,
    compatibility: { status: "candidate" },
    pending: false,
    ...overrides,
  };
}

export function makeCheckpointSummary(
  overrides: Partial<CheckpointSummary> = {},
): CheckpointSummary {
  const envelope = makeEnvelope();
  return {
    checkpointId: "checkpoint-1",
    cityId: envelope.city.id,
    name: "Checkpoint 1",
    note: null,
    createdAt: envelope.savedAt,
    appVersion: envelope.appVersion,
    snapshotSchemaVersion: envelope.snapshotSchemaVersion,
    summary: envelope.summary,
    compatibility: { status: "candidate" },
    ...overrides,
  };
}

export function makeAutosaveSummary(
  overrides: Partial<AutosaveSummary> = {},
): AutosaveSummary {
  const envelope = makeEnvelope();
  return {
    autosaveId: "autosave-1",
    cityId: envelope.city.id,
    generation: 1,
    createdAt: envelope.savedAt,
    appVersion: envelope.appVersion,
    snapshotSchemaVersion: envelope.snapshotSchemaVersion,
    summary: envelope.summary,
    compatibility: { status: "candidate" },
    ...overrides,
  };
}
