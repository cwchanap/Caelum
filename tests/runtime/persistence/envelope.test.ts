import { expect, it } from "vitest";
import { SNAPSHOT_SCHEMA_VERSION } from "../../../src/domain/types";
import { buildSaveEnvelope } from "../../../src/persistence/envelope";
import {
  compatibilityToEnvelopeError,
  inspectSaveEnvelope,
  type SaveCompatibility,
} from "../../../src/persistence/envelopeInspection";
import validPaused from "../../fixtures/persistence/valid-paused.json";
import { makeEnvelope, makeRustSnapshot } from "./fixtures";

function withoutOwnKey(value: object, key: PropertyKey): object {
  const copy = Object.assign({}, value);
  Reflect.deleteProperty(copy, key);
  return copy;
}

function withEnvelopeOverrides(
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  return { ...makeEnvelope(), ...overrides };
}

it("builds schema-v1 metadata from a canonical Rust snapshot", () => {
  const snapshot = makeRustSnapshot({
    rules: {
      gameMode: "sandbox",
      economyPreset: "standard",
      sandbox: {
        templateId: "crossroads",
        startingCapital: 125_000,
        demandMultiplier: 1,
        moveInRate: "paused",
      },
    },
  });

  const envelope = buildSaveEnvelope({
    city: { id: "city-1", name: "North Loop" },
    cityCreatedAt: "2026-08-01T10:00:00.000Z",
    savedAt: "2026-08-01T10:05:00.000Z",
    appVersion: "0.1.0",
    snapshot,
  });

  expect(envelope).toMatchObject({
    format: "caelum-save",
    envelopeVersion: 1,
    snapshotSchemaVersion: SNAPSHOT_SCHEMA_VERSION,
    summary: {
      gameMode: "sandbox",
      economyPreset: "standard",
      sandboxTemplateId: "crossroads",
    },
  });
  expect(envelope.snapshot).toBe(snapshot);
});

it("accepts an exact compatible header without interpreting its gameplay body", () => {
  const opaqueSnapshot = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    gameplay: new Proxy(
      {},
      {
        get() {
          throw new Error("gameplay body must remain opaque");
        },
      },
    ),
  };
  const envelope = withEnvelopeOverrides({ snapshot: opaqueSnapshot });

  expect(inspectSaveEnvelope(envelope)).toEqual({ ok: true, envelope });
});

it("materializes a stable header from stateful getters", () => {
  const envelope = makeEnvelope();
  let savedAtReads = 0;
  const statefulEnvelope = Object.defineProperty({ ...envelope }, "savedAt", {
    enumerable: true,
    get() {
      savedAtReads += 1;
      return savedAtReads === 1 ? "2026-08-01T10:05:00.000Z" : 42;
    },
  });

  const result = inspectSaveEnvelope(statefulEnvelope);
  const readsDuringInspection = savedAtReads;

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(readsDuringInspection).toBe(1);
  expect(result.envelope).not.toBe(statefulEnvelope);
  expect(result.envelope.savedAt).toBe("2026-08-01T10:05:00.000Z");
  expect(result.envelope.snapshot).toBe(envelope.snapshot);
});

it.each([
  [{}, { status: "corruptHeader" }],
  [
    { format: "caelum-save", envelopeVersion: 99 },
    { status: "unsupportedEnvelope", version: 99 },
  ],
  [
    makeEnvelope({ snapshotSchemaVersion: 99 }),
    { status: "unsupportedSnapshot", version: 99 },
  ],
  [
    withEnvelopeOverrides({ snapshot: {} }),
    {
      status: "snapshotVersionMismatch",
      declaredVersion: SNAPSHOT_SCHEMA_VERSION,
      embeddedVersion: null,
    },
  ],
] as const)("classifies invalid headers", (value, compatibility) => {
  expect(inspectSaveEnvelope(value)).toEqual({ ok: false, compatibility });
});

it.each([
  [
    "prototype inspection",
    new Proxy(makeEnvelope(), {
      getPrototypeOf() {
        throw new Error("hostile prototype");
      },
    }),
  ],
  [
    "key enumeration",
    new Proxy(makeEnvelope(), {
      ownKeys() {
        throw new Error("hostile key enumeration");
      },
    }),
  ],
  [
    "header property access",
    Object.defineProperty(makeEnvelope(), "savedAt", {
      enumerable: true,
      get() {
        throw new Error("hostile header getter");
      },
    }),
  ],
  [
    "snapshot property access",
    withEnvelopeOverrides({
      snapshot: Object.defineProperty({}, "schemaVersion", {
        enumerable: true,
        get() {
          throw new Error("hostile snapshot getter");
        },
      }),
    }),
  ],
])("contains exceptions from %s", (_label, value) => {
  let result: ReturnType<typeof inspectSaveEnvelope> | undefined;
  expect(() => {
    result = inspectSaveEnvelope(value);
  }).not.toThrow();
  expect(result).toEqual({
    ok: false,
    compatibility: { status: "corruptHeader" },
  });
});

it.each([
  ["outer extra string", { ...makeEnvelope(), extra: true }],
  ["outer symbol", Object.assign(makeEnvelope(), { [Symbol("extra")]: true })],
  [
    "city extra string",
    makeEnvelope({
      city: { id: "city-1", name: "Test City", extra: true } as never,
    }),
  ],
  [
    "city symbol",
    makeEnvelope({
      city: Object.assign(
        { id: "city-1", name: "Test City" },
        { [Symbol("extra")]: true },
      ),
    }),
  ],
  [
    "summary extra string",
    makeEnvelope({
      summary: {
        ...makeEnvelope().summary,
        extra: true,
      } as never,
    }),
  ],
  [
    "summary symbol",
    makeEnvelope({
      summary: Object.assign(
        { ...makeEnvelope().summary },
        { [Symbol("extra")]: true },
      ),
    }),
  ],
])("rejects %s keys", (_label, value) => {
  expect(inspectSaveEnvelope(value)).toEqual({
    ok: false,
    compatibility: { status: "corruptHeader" },
  });
});

it.each([
  ...[
    "format",
    "envelopeVersion",
    "city",
    "cityCreatedAt",
    "savedAt",
    "appVersion",
    "snapshotSchemaVersion",
    "summary",
    "snapshot",
  ].map((key) => [`envelope.${key}`, withoutOwnKey(makeEnvelope(), key)]),
  [
    "city.id",
    makeEnvelope({ city: withoutOwnKey(makeEnvelope().city, "id") as never }),
  ],
  [
    "city.name",
    makeEnvelope({ city: withoutOwnKey(makeEnvelope().city, "name") as never }),
  ],
  [
    "summary.gameMode",
    makeEnvelope({
      summary: withoutOwnKey(makeEnvelope().summary, "gameMode") as never,
    }),
  ],
  [
    "summary.economyPreset",
    makeEnvelope({
      summary: withoutOwnKey(makeEnvelope().summary, "economyPreset") as never,
    }),
  ],
  [
    "summary.sandboxTemplateId",
    makeEnvelope({
      summary: withoutOwnKey(
        makeEnvelope().summary,
        "sandboxTemplateId",
      ) as never,
    }),
  ],
])("rejects missing field %s", (_label, value) => {
  expect(inspectSaveEnvelope(value)).toEqual({
    ok: false,
    compatibility: { status: "corruptHeader" },
  });
});

it.each([
  ["gameMode", { gameMode: "other" }],
  ["economyPreset", { economyPreset: "other" }],
  ["sandboxTemplateId", { sandboxTemplateId: "other" }],
])("rejects invalid summary string %s", (_field, summaryOverride) => {
  expect(
    inspectSaveEnvelope(
      makeEnvelope({
        summary: { ...makeEnvelope().summary, ...summaryOverride } as never,
      }),
    ),
  ).toEqual({
    ok: false,
    compatibility: { status: "corruptHeader" },
  });
});

it("rejects an empty city ID", () => {
  expect(
    inspectSaveEnvelope(
      makeEnvelope({ city: { id: "", name: "Missing identity" } }),
    ),
  ).toEqual({
    ok: false,
    compatibility: { status: "corruptHeader" },
  });
});

it.each([
  [SNAPSHOT_SCHEMA_VERSION - 1, SNAPSHOT_SCHEMA_VERSION - 1],
  ["4", null],
  [4.5, null],
  [Number.NaN, null],
])(
  "classifies embedded snapshot version %j",
  (schemaVersion, embeddedVersion) => {
    expect(
      inspectSaveEnvelope(
        withEnvelopeOverrides({ snapshot: { schemaVersion } }),
      ),
    ).toEqual({
      ok: false,
      compatibility: {
        status: "snapshotVersionMismatch",
        declaredVersion: SNAPSHOT_SCHEMA_VERSION,
        embeddedVersion,
      },
    });
  },
);

it.each([
  [{ status: "corruptHeader" }, { code: "corruptHeader" }],
  [
    { status: "unsupportedEnvelope", version: 2 },
    { code: "unsupportedEnvelope", version: 2 },
  ],
  [
    { status: "unsupportedSnapshot", version: 3 },
    { code: "unsupportedSnapshot", version: 3 },
  ],
  [
    {
      status: "snapshotVersionMismatch",
      declaredVersion: 4,
      embeddedVersion: 3,
    },
    {
      code: "snapshotVersionMismatch",
      declaredVersion: 4,
      embeddedVersion: 3,
    },
  ],
] satisfies ReadonlyArray<
  [Exclude<SaveCompatibility, { status: "candidate" }>, unknown]
>)("maps compatibility %j to its load error", (compatibility, error) => {
  expect(compatibilityToEnvelopeError(compatibility)).toEqual(error);
});

it("keeps the checked-in Rust fixture schema equal to the TypeScript constant", () => {
  expect(validPaused.schemaVersion).toBe(SNAPSHOT_SCHEMA_VERSION);
});

it.each([
  ["array", []],
  ["null", null],
  ["number", 42],
  ["string", "caelum-save"],
])("rejects a non-plain-object %s envelope as corrupt", (_label, value) => {
  expect(inspectSaveEnvelope(value)).toEqual({
    ok: false,
    compatibility: { status: "corruptHeader" },
  });
});

it("accepts a null-prototype envelope with a compatible header", () => {
  const envelope = Object.assign(Object.create(null), makeEnvelope());
  expect(inspectSaveEnvelope(envelope)).toEqual({ ok: true, envelope });
});
