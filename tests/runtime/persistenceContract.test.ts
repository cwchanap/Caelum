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

  it("ignores an inherited optional numeric-error entity", () => {
    const previousEntity = Object.getOwnPropertyDescriptor(
      Object.prototype,
      "entity",
    );
    let accepted: boolean | undefined;

    try {
      Object.defineProperty(Object.prototype, "entity", {
        configurable: true,
        value: null,
      });
      accepted = isPersistenceValidationError({
        code: "invalidNumericValue",
        context: { field: "time", reason: { kind: "notFinite" } },
      });
    } finally {
      if (previousEntity === undefined) {
        Reflect.deleteProperty(Object.prototype, "entity");
      } else {
        Object.defineProperty(Object.prototype, "entity", previousEntity);
      }
    }

    expect(accepted).toBe(true);
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

  it("detaches a stateful operation getter into a safe recognized error", async () => {
    let operationReads = 0;
    const stateful = new Proxy(
      {
        kind: "serialization",
        operation: "restoreSnapshot",
        phase: "snapshotDecode",
        diagnostic: "synthetic decode failure",
      },
      {
        get(target, property, receiver) {
          if (property === "operation" && operationReads++ > 0) {
            throw new Error("hostile second operation read");
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );

    const result = await runPersistenceSnapshotOperation(
      "restoreSnapshot",
      () => Promise.reject(stateful),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // The detached error is recognized: materialization read the getter
      // once (succeeding), and the returned plain object never re-invokes it.
      expect(result.error).toMatchObject({
        kind: "serialization",
        operation: "restoreSnapshot",
        phase: "snapshotDecode",
      });
      expect(() => result.error.operation).not.toThrow();
      expect(operationReads).toBe(1);
    }
  });

  it("detaches nested context so post-normalization mutation cannot affect the returned error", async () => {
    const context = {
      tileId: "tile-0-0",
      reason: {
        kind: "connectionToNonRoad",
        details: { neighbor: { x: 1, y: 0 } },
      },
    };
    const rejection = {
      kind: "validation",
      operation: "restoreSnapshot",
      source: "candidate",
      error: { code: "invalidTile", context },
    };
    const expectedContext = JSON.parse(JSON.stringify(context));

    const result = await runPersistenceSnapshotOperation(
      "restoreSnapshot",
      () => Promise.reject(rejection),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    // Assert the full expected shape unconditionally so a regression to
    // host/invokeFailed or host/malformedError fails the test rather than
    // skipping the assertions.
    expect(result.error.kind).toBe("validation");
    expect(result.error).toMatchObject({ error: { code: "invalidTile" } });
    const error = result.error as Extract<
      PersistenceOperationError,
      { kind: "validation" }
    >;
    // Mutate the original nested context after normalization.
    context.tileId = "tampered";
    context.reason.details.neighbor.x = 999;
    // The returned error is detached — unaffected by the mutation.
    expect(error.error.context).toEqual(expectedContext);
  });

  it("detaches a hostile nested getter so later field access on the returned error is safe", async () => {
    let reasonReads = 0;
    const context = Object.defineProperty({ tileId: "tile-0-0" }, "reason", {
      configurable: true,
      enumerable: true,
      get() {
        if (reasonReads++ > 0) {
          throw new Error("hostile second reason read");
        }
        return {
          kind: "connectionToNonRoad",
          details: { neighbor: { x: 1, y: 0 } },
        };
      },
    });
    const rejection = {
      kind: "validation",
      operation: "restoreSnapshot",
      source: "candidate",
      error: { code: "invalidTile", context },
    };

    const result = await runPersistenceSnapshotOperation(
      "restoreSnapshot",
      () => Promise.reject(rejection),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    // Assert the full expected shape unconditionally so a regression to
    // host/invokeFailed or host/malformedError fails the test rather than
    // skipping the assertions.
    expect(result.error.kind).toBe("validation");
    expect(result.error).toMatchObject({ error: { code: "invalidTile" } });
    const error = result.error as Extract<
      PersistenceOperationError,
      { kind: "validation" }
    >;
    const validationError = error.error as Extract<
      PersistenceValidationError,
      { code: "invalidTile" }
    >;
    const returnedContext = validationError.context;
    // The detached context is a plain object — reading reason never throws.
    expect(() => returnedContext.reason).not.toThrow();
    expect(returnedContext.reason).toEqual({
      kind: "connectionToNonRoad",
      details: { neighbor: { x: 1, y: 0 } },
    });
    // Only materialization read the original getter.
    expect(reasonReads).toBe(1);
  });

  it("preserves name and message for an ordinary Error rejection diagnostic", async () => {
    const result = await runPersistenceSnapshotOperation(
      "restoreSnapshot",
      () => Promise.reject(new Error("restore failed")),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    // Assert the full expected shape unconditionally so a regression to a
    // non-host discriminant fails the test rather than skipping the assertions.
    expect(result.error.kind).toBe("host");
    const error = result.error as Extract<
      PersistenceOperationError,
      { kind: "host" }
    >;
    expect(error.code).toBe("invokeFailed");
    expect(error.diagnostic).toContain("restore failed");
    expect(error.diagnostic).not.toBe("{}");
  });

  it("rejects a closed-shape error with an extra undefined-valued property", async () => {
    // JSON.stringify drops undefined-valued own properties, which would turn
    // this malformed shape (extra `extra` key) into a valid serialization
    // error. Detachment must preserve the real own-key shape so the
    // closed-shape guard (hasExactKeys) rejects it.
    const rejection = {
      kind: "serialization",
      operation: "restoreSnapshot",
      phase: "snapshotDecode",
      diagnostic: "failed",
      extra: undefined,
    };
    const result = await runPersistenceSnapshotOperation(
      "restoreSnapshot",
      () => Promise.reject(rejection),
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: "host",
        operation: "restoreSnapshot",
        code: "malformedError",
      },
    });
  });

  it("rejects a forged toJSON() result that would otherwise satisfy the closed shape", async () => {
    // JSON.stringify invokes toJSON(), which could replace a hostile object
    // with a valid serialization error. Detachment must not honor toJSON so
    // the original shape (with `unexpected` and `toJSON` keys) is rejected by
    // the closed-shape guard rather than laundered into a recognized error.
    const rejection = {
      unexpected: true,
      toJSON() {
        return {
          kind: "serialization",
          operation: "restoreSnapshot",
          phase: "snapshotDecode",
          diagnostic: "forged",
        };
      },
    };
    const result = await runPersistenceSnapshotOperation(
      "restoreSnapshot",
      () => Promise.reject(rejection),
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: "host",
        operation: "restoreSnapshot",
        code: "malformedError",
      },
    });
  });

  it("rejects a stateful getPrototypeOf proxy that alternates between plain and non-plain", async () => {
    // A stateful getPrototypeOf proxy can appear plain on the initial
    // isPlainObject check (top-level), non-plain during detachment (so
    // detachValue returns the original proxy by reference), then plain
    // again during validation — letting the hostile proxy escape as a
    // recognized error. The sentinel replacement makes the detached copy
    // permanently non-plain so the proxy cannot escape.
    let protoCalls = 0;
    const alternating = new Proxy(
      {
        kind: "serialization",
        operation: "restoreSnapshot",
        phase: "snapshotDecode",
        diagnostic: "hostile alternating proxy",
      },
      {
        getPrototypeOf() {
          protoCalls++;
          // Odd calls: plain. Even calls: non-plain.
          return protoCalls % 2 === 1
            ? Object.prototype
            : { constructor: "non-plain" };
        },
      },
    );

    const result = await runPersistenceSnapshotOperation(
      "restoreSnapshot",
      () => Promise.reject(alternating),
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: "host",
        operation: "restoreSnapshot",
        code: "malformedError",
      },
    });
    // The proxy must not be the returned error — the sentinel replaces it.
    if (!result.ok) {
      expect(result.error).not.toBe(alternating);
    }
  });

  it("rejects a forged error with an own __proto__ data property", async () => {
    // Property assignment (clone[key] = value) for key "__proto__" invokes
    // the inherited prototype setter rather than creating an own data
    // property, silently dropping the key from the detached copy. This
    // would let a malformed shape (valid keys plus an own __proto__) pass
    // the closed-shape guard after detachment. Using defineProperty
    // preserves __proto__ as an own key so hasExactKeys rejects it.
    //
    // The input is built on Object.create(null) so that assigning
    // "__proto__" creates a real own data property (no inherited setter
    // on a null-prototype object). isPlainObject still accepts it
    // (null prototype is plain), so the top-level gate is passed.
    const rejection = Object.create(null);
    rejection.kind = "serialization";
    rejection.operation = "restoreSnapshot";
    rejection.phase = "snapshotDecode";
    rejection.diagnostic = "forged with __proto__";
    rejection.__proto__ = null;
    // Sanity: the input has an own __proto__ data property and is plain.
    expect(Reflect.ownKeys(rejection)).toContain("__proto__");
    expect(Object.getPrototypeOf(rejection)).toBeNull();

    const result = await runPersistenceSnapshotOperation(
      "restoreSnapshot",
      () => Promise.reject(rejection),
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: "host",
        operation: "restoreSnapshot",
        code: "malformedError",
      },
    });
  });

  it("rejects an unsafeRoundaboutPortMapping with a sparse footprint array", async () => {
    // Array.prototype.every skips holes, so new Array(3).every(isPoint)
    // returns true (vacuous truth). Without the own-property-per-index check,
    // a hostile sparse footprint would be accepted as a recognized
    // invalidRoadTopology error even though Rust/JSON can never emit one.
    // The detacher must also preserve length so the sparse array is not
    // laundered into [] (which would pass the empty-array check).
    const footprint = new Array(3);
    const rejection = {
      kind: "validation",
      operation: "restoreSnapshot",
      source: "candidate",
      error: {
        code: "invalidRoadTopology",
        context: {
          reason: {
            kind: "unsafeRoundaboutPortMapping",
            details: {
              structureId: "roundabout:compact2x2:4,2",
              footprint,
            },
          },
        },
      },
    };
    const result = await runPersistenceSnapshotOperation(
      "restoreSnapshot",
      () => Promise.reject(rejection),
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: "host",
        operation: "restoreSnapshot",
        code: "malformedError",
      },
    });
  });

  it("rejects an unsafeRoundaboutPortMapping footprint carrying an extra string key", async () => {
    // Array.prototype.every ignores non-index own properties, so a footprint
    // with an extra string key would pass isPointArray. The own-key count
    // check rejects it because the count exceeds len + 1.
    const footprint = [
      { x: 4, y: 2 },
      { x: 5, y: 2 },
    ];
    (footprint as unknown as Record<string, unknown>).extra = "hostile";
    const rejection = {
      kind: "validation",
      operation: "restoreSnapshot",
      source: "candidate",
      error: {
        code: "invalidRoadTopology",
        context: {
          reason: {
            kind: "unsafeRoundaboutPortMapping",
            details: {
              structureId: "roundabout:compact2x2:4,2",
              footprint,
            },
          },
        },
      },
    };
    const result = await runPersistenceSnapshotOperation(
      "restoreSnapshot",
      () => Promise.reject(rejection),
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: "host",
        operation: "restoreSnapshot",
        code: "malformedError",
      },
    });
  });

  it("rejects an unsafeRoundaboutPortMapping footprint carrying an extra symbol key", async () => {
    // Same as the string-key case but with a symbol-keyed property, which
    // Reflect.ownKeys includes in the count.
    const footprint = [{ x: 4, y: 2 }];
    (footprint as unknown as Record<symbol, unknown>)[Symbol("extra")] =
      "hostile";
    const rejection = {
      kind: "validation",
      operation: "restoreSnapshot",
      source: "candidate",
      error: {
        code: "invalidRoadTopology",
        context: {
          reason: {
            kind: "unsafeRoundaboutPortMapping",
            details: {
              structureId: "roundabout:compact2x2:4,2",
              footprint,
            },
          },
        },
      },
    };
    const result = await runPersistenceSnapshotOperation(
      "restoreSnapshot",
      () => Promise.reject(rejection),
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: "host",
        operation: "restoreSnapshot",
        code: "malformedError",
      },
    });
  });

  it("rejects an unsafeRoundaboutPortMapping footprint whose Proxy under-reports length", async () => {
    // A Proxy get-trap can report a shorter length than the indices its
    // ownKeys exposes: here length === 1 but ownKeys yields "0" and "1".
    // Object.defineProperty on a canonical index >= the clone's current
    // length silently grows the clone, which would launder the inconsistent
    // shape into a valid dense two-element array that isPointArray accepts.
    // The post-detach length guard replaces the clone with the non-plain
    // sentinel so the enclosing candidate is discarded as malformedError.
    const footprint = new Proxy(
      [
        { x: 4, y: 2 },
        { x: 5, y: 2 },
      ],
      {
        get(target, key, receiver) {
          if (key === "length") return 1;
          return Reflect.get(target, key, receiver);
        },
      },
    );
    // Sanity: the proxy lies about its length while exposing two indices.
    expect(footprint.length).toBe(1);
    expect(Reflect.ownKeys(footprint)).toEqual(["0", "1", "length"]);

    const rejection = {
      kind: "validation",
      operation: "restoreSnapshot",
      source: "candidate",
      error: {
        code: "invalidRoadTopology",
        context: {
          reason: {
            kind: "unsafeRoundaboutPortMapping",
            details: {
              structureId: "roundabout:compact2x2:4,2",
              footprint,
            },
          },
        },
      },
    };
    const result = await runPersistenceSnapshotOperation(
      "restoreSnapshot",
      () => Promise.reject(rejection),
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: "host",
        operation: "restoreSnapshot",
        code: "malformedError",
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

  it.each([
    { phase: "snapshotDecode", label: "decode" },
    { phase: "snapshotEncode", label: "encode" },
  ])("accepts a serialization operation error ($label)", ({ phase }) => {
    expect(
      isPersistenceOperationError({
        kind: "serialization",
        operation: "restoreSnapshot",
        phase,
        diagnostic: "synthetic failure",
      }),
    ).toBe(true);
  });

  it("rejects a serialization operation error with an unknown phase", () => {
    expect(
      isPersistenceOperationError({
        kind: "serialization",
        operation: "restoreSnapshot",
        phase: "unknown",
        diagnostic: "synthetic failure",
      }),
    ).toBe(false);
  });

  it.each([
    "stateUnavailable",
    "invokeFailed",
    "malformedSuccess",
    "malformedError",
  ] as const)("accepts a host operation error with code %s", (code) => {
    expect(
      isPersistenceOperationError({
        kind: "host",
        operation: "validateSnapshot",
        code,
        diagnostic: "synthetic failure",
      }),
    ).toBe(true);
  });

  it("rejects a host operation error with an unknown code", () => {
    expect(
      isPersistenceOperationError({
        kind: "host",
        operation: "validateSnapshot",
        code: "unknown",
        diagnostic: "synthetic failure",
      }),
    ).toBe(false);
  });

  it("rejects an operation error with an unknown kind", () => {
    expect(
      isPersistenceOperationError({
        kind: "unknown",
        operation: "restoreSnapshot",
      }),
    ).toBe(false);
  });

  it("returns false instead of throwing when an operation field getter throws", () => {
    const throwing = Object.defineProperty(
      {
        kind: "validation",
        source: "candidate",
        error: {
          code: "unsupportedSchema",
          context: { expected: 4, actual: 3 },
        },
      },
      "operation",
      {
        configurable: true,
        get() {
          throw new Error("hostile operation getter");
        },
      },
    );
    expect(() => isPersistenceOperationError(throwing)).not.toThrow();
    expect(isPersistenceOperationError(throwing)).toBe(false);
  });

  it("returns a recognized operation error directly when the operation matches", async () => {
    const error = {
      kind: "serialization",
      operation: "restoreSnapshot",
      phase: "snapshotDecode",
      diagnostic: "synthetic decode failure",
    } as const;
    await expect(
      runPersistenceSnapshotOperation("restoreSnapshot", () =>
        Promise.reject(error),
      ),
    ).resolves.toEqual({ ok: false, error });
  });

  it("normalizes a recognized operation error with a mismatched operation to malformedError", async () => {
    const error = {
      kind: "serialization",
      operation: "snapshotForSave",
      phase: "snapshotEncode",
      diagnostic: "synthetic encode failure",
    } as const;
    await expect(
      runPersistenceSnapshotOperation("restoreSnapshot", () =>
        Promise.reject(error),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        kind: "host",
        operation: "restoreSnapshot",
        code: "malformedError",
      },
    });
  });

  it.each([
    {
      family: "numeric",
      envelope: (reason: unknown) => ({
        code: "invalidNumericValue",
        context: { field: "time", reason },
      }),
    },
    {
      family: "mode",
      envelope: (reason: unknown) => ({
        code: "invalidModeSettings",
        context: { field: "paused", reason },
      }),
    },
    {
      family: "scenario",
      envelope: (reason: unknown) => ({
        code: "invalidScenario",
        context: { field: "scenarioGrowthWaves", reason },
      }),
    },
    {
      family: "tile",
      envelope: (reason: unknown) => ({
        code: "invalidTile",
        context: { tileId: "tile-1-2", reason },
      }),
    },
    {
      family: "roadStructure",
      envelope: (reason: unknown) => ({
        code: "invalidRoadStructure",
        context: { structureId: "roundabout:compact2x2:4,2", reason },
      }),
    },
    {
      family: "entity",
      envelope: (reason: unknown) => ({
        code: "invalidEntity",
        context: {
          entity: { kind: "building", id: "building-001" },
          field: "entityId",
          reason,
        },
      }),
    },
    {
      family: "ownership",
      envelope: (reason: unknown) => ({
        code: "invalidOwnership",
        context: {
          owner: { kind: "building", id: "building-001" },
          owned: { kind: "stop", id: "stop-001" },
          reason,
        },
      }),
    },
    {
      family: "assignment",
      envelope: (reason: unknown) => ({
        code: "invalidAssignment",
        context: {
          entity: { kind: "vehicle", id: "vehicle-001" },
          reason,
        },
      }),
    },
    {
      family: "derivedState",
      envelope: (reason: unknown) => ({
        code: "invalidDerivedState",
        context: { field: "metricsState", reason },
      }),
    },
    {
      family: "roadTopology",
      envelope: (reason: unknown) => ({
        code: "invalidRoadTopology",
        context: { reason },
      }),
    },
  ] as const)(
    "rejects a $family reason whose kind is outside the closed vocabulary",
    ({ envelope }) => {
      expect(isPersistenceValidationError(envelope({ kind: "bogus" }))).toBe(
        false,
      );
    },
  );

  it("accepts a null-prototype plain object as a validation context", () => {
    const context = Object.assign(Object.create(null), {
      expected: 4,
      actual: 3,
    });
    expect(
      isPersistenceValidationError({
        code: "unsupportedSchema",
        context,
      }),
    ).toBe(true);
  });
});
