import { describe, expect, expectTypeOf, it } from "vitest";
import catalogue from "../fixtures/persistence/persistence-errors.json";
import { SNAPSHOT_SCHEMA_VERSION } from "../../src/domain/types";
import {
  isPersistenceOperationError,
  isPersistenceValidationError,
  runPersistenceSnapshotOperation,
  runPersistenceValidationOperation,
} from "../../src/runtime/backend/persistence";
import type { RustGameSnapshot } from "../../src/runtime/backend/types";
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
    expectTypeOf(runPersistenceSnapshotOperation).returns.toEqualTypeOf<
      Promise<PersistenceSnapshotResultOf<RustGameSnapshot>>
    >();
  });

  it("accepts every catalogued Rust persistence error", () => {
    for (const error of catalogue.errors) {
      expect(isPersistenceValidationError(error)).toBe(true);
    }
  });

  it("accepts only nullish validation success", async () => {
    await expect(
      runPersistenceValidationOperation(() => undefined),
    ).resolves.toEqual({ ok: true });
    await expect(
      runPersistenceValidationOperation(async () => null),
    ).resolves.toEqual({ ok: true });

    for (const value of [true, false, 0, "ok", [], {}, { schemaVersion: 4 }]) {
      const result = await runPersistenceValidationOperation(() => value);
      expect(result).toMatchObject({
        ok: false,
        error: {
          kind: "host",
          operation: "validateSnapshot",
          code: "malformedSuccess",
        },
      });
    }
  });

  it("requires the exact current schema on snapshot success", async () => {
    await expect(
      runPersistenceSnapshotOperation("snapshotForSave", () => ({
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      })),
    ).resolves.toEqual({
      ok: true,
      snapshot: { schemaVersion: SNAPSHOT_SCHEMA_VERSION },
    });

    const wrong = await runPersistenceSnapshotOperation(
      "restoreSnapshot",
      () => ({
        schemaVersion: SNAPSHOT_SCHEMA_VERSION - 1,
      }),
    );
    expect(wrong).toMatchObject({
      ok: false,
      error: {
        kind: "host",
        operation: "restoreSnapshot",
        code: "malformedSuccess",
      },
    });
  });

  it("rejects unknown closed vocabulary and malformed embedded shapes", () => {
    const base = {
      kind: "validation",
      operation: "restoreSnapshot",
      source: "candidate",
      error: {
        code: "invalidTile",
        context: {
          tileId: "tile-0-0",
          reason: {
            kind: "connectionToNonRoad",
            details: { neighbor: { x: 1, y: 0 } },
          },
        },
      },
    };
    expect(isPersistenceOperationError(base)).toBe(true);
    expect(
      isPersistenceOperationError({
        ...base,
        error: {
          ...base.error,
          context: {
            ...base.error.context,
            reason: {
              kind: "connectionToNonRoad",
              details: { neighbor: { x: 1, y: 0, z: 2 } },
            },
          },
        },
      }),
    ).toBe(false);
  });

  it.each([
    { code: "unknown", context: {} },
    {
      code: "invalidNumericValue",
      context: { field: "unknown", reason: { kind: "negative" } },
    },
    {
      code: "invalidTile",
      context: {
        tileId: "tile-0-0",
        reason: {
          kind: "connectionOutOfBounds",
          details: { heading: "unknown" },
        },
      },
    },
    {
      code: "invalidTile",
      context: { tileId: "tile-0-0", reason: { kind: "connectionToNonRoad" } },
    },
    {
      code: "invalidTile",
      context: {
        tileId: "tile-0-0",
        reason: { kind: "unsupportedKind", details: {} },
      },
    },
    {
      code: "invalidNumericValue",
      context: {
        entity: null,
        field: "time",
        reason: { kind: "negative" },
      },
    },
    {
      code: "unsupportedSchema",
      context: { expected: 4, actual: 3, extra: true },
    },
    {
      code: "invalidEntity",
      context: {
        entity: { kind: "building", id: 1 },
        field: "entityId",
        reason: { kind: "emptyId" },
      },
    },
    {
      code: "invalidMapDimensions",
      context: {
        expected: { width: 28, height: 18 },
        actual: { width: 28, height: 18, depth: 1 },
      },
    },
  ])("rejects malformed closed validation error %#", (error) => {
    expect(isPersistenceValidationError(error)).toBe(false);
  });
});
