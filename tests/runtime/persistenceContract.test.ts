import { describe, expect, expectTypeOf, it } from "vitest";
import catalogue from "../fixtures/persistence/persistence-errors.json";
import { SNAPSHOT_SCHEMA_VERSION } from "../../src/domain/types";
import {
  PERSISTENCE_ENTITY_KINDS,
  PERSISTENCE_HEADINGS,
  PERSISTENCE_REASON_KINDS,
  PERSISTENCE_SNAPSHOT_FIELDS,
  PERSISTENCE_VALIDATION_CODES,
  isPersistenceOperationError,
  isPersistenceValidationError,
  runPersistenceSnapshotOperation,
  runPersistenceValidationOperation,
} from "../../src/runtime/backend/persistence";
import type { Heading } from "../../src/domain/types";
import type { RustGameSnapshot } from "../../src/runtime/backend/types";
import type {
  PersistenceAssignmentError,
  PersistenceDerivedStateError,
  PersistenceEntityError,
  PersistenceEntityKind,
  PersistenceModeError,
  PersistenceNumericError,
  PersistenceOperationError,
  PersistenceOwnershipError,
  PersistenceRoadStructureError,
  PersistenceRoadTopologyError,
  PersistenceScenarioError,
  PersistenceSnapshotField,
  PersistenceSnapshotRequest,
  PersistenceSnapshotResultOf,
  PersistenceTileError,
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

  it("keeps the catalogue and TypeScript closed vocabularies bidirectionally equal", () => {
    expectTypeOf<(typeof PERSISTENCE_VALIDATION_CODES)[number]>().toEqualTypeOf<
      PersistenceValidationError["code"]
    >();
    expectTypeOf<
      (typeof PERSISTENCE_SNAPSHOT_FIELDS)[number]
    >().toEqualTypeOf<PersistenceSnapshotField>();
    expectTypeOf<
      (typeof PERSISTENCE_ENTITY_KINDS)[number]
    >().toEqualTypeOf<PersistenceEntityKind>();
    expectTypeOf<
      (typeof PERSISTENCE_HEADINGS)[number]
    >().toEqualTypeOf<Heading>();
    expectTypeOf<
      (typeof PERSISTENCE_REASON_KINDS.numeric)[number]
    >().toEqualTypeOf<PersistenceNumericError["kind"]>();
    expectTypeOf<
      (typeof PERSISTENCE_REASON_KINDS.mode)[number]
    >().toEqualTypeOf<PersistenceModeError["kind"]>();
    expectTypeOf<
      (typeof PERSISTENCE_REASON_KINDS.scenario)[number]
    >().toEqualTypeOf<PersistenceScenarioError["kind"]>();
    expectTypeOf<
      (typeof PERSISTENCE_REASON_KINDS.tile)[number]
    >().toEqualTypeOf<PersistenceTileError["kind"]>();
    expectTypeOf<
      (typeof PERSISTENCE_REASON_KINDS.roadStructure)[number]
    >().toEqualTypeOf<PersistenceRoadStructureError["kind"]>();
    expectTypeOf<
      (typeof PERSISTENCE_REASON_KINDS.entity)[number]
    >().toEqualTypeOf<PersistenceEntityError["kind"]>();
    expectTypeOf<
      (typeof PERSISTENCE_REASON_KINDS.ownership)[number]
    >().toEqualTypeOf<PersistenceOwnershipError["kind"]>();
    expectTypeOf<
      (typeof PERSISTENCE_REASON_KINDS.assignment)[number]
    >().toEqualTypeOf<PersistenceAssignmentError["kind"]>();
    expectTypeOf<
      (typeof PERSISTENCE_REASON_KINDS.derivedState)[number]
    >().toEqualTypeOf<PersistenceDerivedStateError["kind"]>();
    expectTypeOf<
      (typeof PERSISTENCE_REASON_KINDS.roadTopology)[number]
    >().toEqualTypeOf<PersistenceRoadTopologyError["kind"]>();

    expect(catalogue.topLevelCodes).toEqual([...PERSISTENCE_VALIDATION_CODES]);
    expect(catalogue.snapshotFields).toEqual([...PERSISTENCE_SNAPSHOT_FIELDS]);
    expect(catalogue.entityKinds).toEqual([...PERSISTENCE_ENTITY_KINDS]);
    expect(catalogue.headings).toEqual([...PERSISTENCE_HEADINGS]);
    expect(catalogue.reasonKinds).toEqual(PERSISTENCE_REASON_KINDS);
    expect([...new Set(catalogue.errors.map((error) => error.code))]).toEqual(
      catalogue.topLevelCodes,
    );
  });

  it("accepts every catalogued reason through its top-level validation envelope", () => {
    const families = [
      [
        "numeric",
        (reason: unknown) => ({
          code: "invalidNumericValue",
          context: { field: "time", reason },
        }),
      ],
      [
        "mode",
        (reason: unknown) => ({
          code: "invalidModeSettings",
          context: { field: "paused", reason },
        }),
      ],
      [
        "scenario",
        (reason: unknown) => ({
          code: "invalidScenario",
          context: { field: "scenarioGrowthWaves", reason },
        }),
      ],
      [
        "tile",
        (reason: unknown) => ({
          code: "invalidTile",
          context: { tileId: "tile-1-2", reason },
        }),
      ],
      [
        "roadStructure",
        (reason: unknown) => ({
          code: "invalidRoadStructure",
          context: { structureId: "roundabout:compact2x2:4,2", reason },
        }),
      ],
      [
        "entity",
        (reason: unknown) => ({
          code: "invalidEntity",
          context: {
            entity: { kind: "building", id: "building-001" },
            field: "entityId",
            reason,
          },
        }),
      ],
      [
        "ownership",
        (reason: unknown) => ({
          code: "invalidOwnership",
          context: {
            owner: { kind: "building", id: "building-001" },
            owned: { kind: "stop", id: "stop-001" },
            reason,
          },
        }),
      ],
      [
        "assignment",
        (reason: unknown) => ({
          code: "invalidAssignment",
          context: {
            entity: { kind: "vehicle", id: "vehicle-001" },
            reason,
          },
        }),
      ],
      [
        "derivedState",
        (reason: unknown) => ({
          code: "invalidDerivedState",
          context: { field: "metricsState", reason },
        }),
      ],
      [
        "roadTopology",
        (reason: unknown) => ({
          code: "invalidRoadTopology",
          context: { reason },
        }),
      ],
    ] as const;

    for (const [family, envelope] of families) {
      const reasons = catalogue.reasons[family];
      expect(reasons.map((reason) => reason.kind)).toEqual(
        catalogue.reasonKinds[family],
      );
      for (const reason of reasons) {
        expect(
          isPersistenceValidationError(envelope(reason)),
          `${family}/${reason.kind}`,
        ).toBe(true);
      }
    }
  });

  it("requires validation-error keys to be own properties", () => {
    const previousExpected = Object.getOwnPropertyDescriptor(
      Object.prototype,
      "expected",
    );
    const previousActual = Object.getOwnPropertyDescriptor(
      Object.prototype,
      "actual",
    );
    let accepted: boolean | undefined;

    try {
      Object.defineProperties(Object.prototype, {
        expected: { configurable: true, value: 4 },
        actual: { configurable: true, value: 3 },
      });
      accepted = isPersistenceValidationError({
        code: "unsupportedSchema",
        context: {},
      });
    } finally {
      if (previousExpected === undefined) {
        Reflect.deleteProperty(Object.prototype, "expected");
      } else {
        Object.defineProperty(Object.prototype, "expected", previousExpected);
      }
      if (previousActual === undefined) {
        Reflect.deleteProperty(Object.prototype, "actual");
      } else {
        Object.defineProperty(Object.prototype, "actual", previousActual);
      }
    }

    expect(accepted).toBe(false);
  });

  it.each([
    {
      name: "getPrototypeOf trap",
      value: new Proxy(
        {},
        {
          getPrototypeOf() {
            throw new Error("hostile getPrototypeOf");
          },
        },
      ),
    },
    {
      name: "ownKeys trap",
      value: new Proxy(
        {
          code: "unsupportedSchema",
          context: { expected: 4, actual: 3 },
        },
        {
          ownKeys() {
            throw new Error("hostile ownKeys");
          },
        },
      ),
    },
    {
      name: "throwing getter",
      value: Object.defineProperty({}, "code", {
        configurable: true,
        get() {
          throw new Error("hostile getter");
        },
      }),
    },
  ])("returns false instead of throwing for a $name", ({ value }) => {
    expect(() => isPersistenceValidationError(value)).not.toThrow();
    expect(isPersistenceValidationError(value)).toBe(false);
    expect(() => isPersistenceOperationError(value)).not.toThrow();
    expect(isPersistenceOperationError(value)).toBe(false);
  });

  it.each([
    {
      name: "getPrototypeOf trap",
      value: new Proxy(
        {},
        {
          getPrototypeOf() {
            throw new Error("hostile getPrototypeOf");
          },
        },
      ),
    },
    {
      name: "ownKeys trap",
      value: new Proxy(
        {},
        {
          ownKeys() {
            throw new Error("hostile ownKeys");
          },
        },
      ),
    },
    {
      name: "throwing schemaVersion getter",
      value: Object.defineProperty({}, "schemaVersion", {
        configurable: true,
        enumerable: true,
        get() {
          throw new Error("hostile schemaVersion getter");
        },
      }),
    },
  ])(
    "normalizes a resolved hostile $name to a typed malformed success",
    async ({ value }) => {
      await expect(
        runPersistenceSnapshotOperation("restoreSnapshot", () => value),
      ).resolves.toMatchObject({
        ok: false,
        error: {
          kind: "host",
          operation: "restoreSnapshot",
          code: "malformedSuccess",
        },
      });
    },
  );

  it("normalizes a hostile rejected object to a typed fallback", async () => {
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("hostile getPrototypeOf");
        },
      },
    );

    await expect(
      runPersistenceValidationOperation(null, () => Promise.reject(hostile)),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        kind: "host",
        operation: "validateSnapshot",
        code: "invokeFailed",
      },
    });
  });

  it("normalizes a revoked proxy rejection to a typed fallback", async () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();

    await expect(
      runPersistenceValidationOperation(null, () => Promise.reject(proxy)),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        kind: "host",
        operation: "validateSnapshot",
        code: "invokeFailed",
      },
    });
  });

  it("requires the host-specific validation success marker", async () => {
    await expect(
      runPersistenceValidationOperation(undefined, () => undefined),
    ).resolves.toEqual({ ok: true });
    await expect(
      runPersistenceValidationOperation(null, async () => null),
    ).resolves.toEqual({ ok: true });

    for (const [expectedSuccess, value] of [
      [undefined, null],
      [null, undefined],
      [undefined, true],
      [undefined, false],
      [undefined, 0],
      [undefined, "ok"],
      [undefined, []],
      [undefined, {}],
      [undefined, { schemaVersion: 4 }],
    ] as const) {
      const result = await runPersistenceValidationOperation(
        expectedSuccess,
        () => value,
      );
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
