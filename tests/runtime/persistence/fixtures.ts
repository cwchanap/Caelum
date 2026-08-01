import { createRustSnapshot } from "../../fixtures/rustSnapshot";
import {
  buildSaveEnvelope,
  type WritableSaveEnvelope,
} from "../../../src/persistence/envelope";
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
