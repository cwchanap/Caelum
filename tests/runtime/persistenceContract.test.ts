import { describe, expectTypeOf, it } from "vitest";
import type {
  PersistenceOperationError,
  PersistenceSnapshotRequest,
  PersistenceSnapshotResultOf,
  PersistenceValidationError,
  PersistenceValidationResult,
} from "../../src/runtime/backend/persistenceContract";

describe("persistence contract types", () => {
  it("keeps imported snapshots unknown", () => {
    expectTypeOf<
      PersistenceSnapshotRequest["snapshot"]
    >().toEqualTypeOf<unknown>();
  });

  it("requires operation attribution on every error family", () => {
    expectTypeOf<PersistenceOperationError["operation"]>().toEqualTypeOf<
      "snapshotForSave" | "validateSnapshot" | "restoreSnapshot"
    >();
  });

  it("uses explicit snapshot and validation result unions", () => {
    expectTypeOf<
      PersistenceSnapshotResultOf<{ schemaVersion: 4 }>
    >().toEqualTypeOf<
      | { ok: true; snapshot: { schemaVersion: 4 } }
      | { ok: false; error: PersistenceOperationError }
    >();
    expectTypeOf<PersistenceValidationResult>().toEqualTypeOf<
      { ok: true } | { ok: false; error: PersistenceOperationError }
    >();
    expectTypeOf<PersistenceValidationError>().toMatchTypeOf<{
      code: string;
      context: object;
    }>();
  });
});
