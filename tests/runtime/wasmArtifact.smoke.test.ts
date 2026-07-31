import { describe, expect, it } from "vitest";

import { SNAPSHOT_SCHEMA_VERSION } from "../../src/domain/types";
import { createWasmBackend } from "../../src/runtime/backend/wasmBackend";
import type {
  RustGameSnapshot,
  RustObjectiveThresholds,
  SandboxCreationRequest,
} from "../../src/runtime/backend/types";
import lateDerivedCorruption from "../fixtures/persistence/late-derived-corruption.json";
import malformedCurrentSchema from "../fixtures/persistence/malformed-current-schema.json";
import unpaused from "../fixtures/persistence/unpaused.json";
import unsupportedSchema from "../fixtures/persistence/unsupported-schema.json";
import validPaused from "../fixtures/persistence/valid-paused.json";

const canonicalCrossroadsRequest: SandboxCreationRequest = {
  templateId: "crossroads",
  economyPreset: "standard",
  startingCapital: 120_000,
  demandMultiplier: 1,
  moveInRate: "paused",
};

function expectJsonCompatible(value: unknown, path = "$"): void {
  expect(typeof value, `${path} must not be undefined`).not.toBe("undefined");
  expect(typeof value, `${path} must not be bigint`).not.toBe("bigint");
  expect(value instanceof Map, `${path} must not be Map`).toBe(false);
  expect(ArrayBuffer.isView(value), `${path} must not be a typed array`).toBe(
    false,
  );

  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      expectJsonCompatible(entry, `${path}[${index}]`),
    );
  } else if (typeof value === "object" && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      expectJsonCompatible(entry, `${path}.${key}`);
    }
  }
}

/**
 * Loads the real built WASM artifact (not the vi.mock in wasmBackend.test.ts).
 * Requires `bun run ensure-wasm` / pretest hook so src/generated/caelum_wasm exists.
 */
describe("real WASM artifact smoke", () => {
  it("loads the built module and returns a schema-v4 snapshot", async () => {
    const backend = await createWasmBackend();
    const snapshot = await backend.snapshot();

    expect(snapshot.schemaVersion).toBe(SNAPSHOT_SCHEMA_VERSION);
    expect(snapshot.map.width).toBeGreaterThan(0);
    expect(snapshot.map.height).toBeGreaterThan(0);
    expect(Array.isArray(snapshot.map.tiles)).toBe(true);
    expect(snapshot.map.tiles.length).toBe(
      snapshot.map.width * snapshot.map.height,
    );
    expect(snapshot.rules).toEqual({
      gameMode: "sandbox",
      economyPreset: "standard",
      sandbox: {
        templateId: "crossroads",
        startingCapital: 120_000,
        demandMultiplier: 1,
        moveInRate: "paused",
      },
    });
    expect(snapshot.scenario.growthWaves).toEqual([]);
    expect(Object.hasOwn(snapshot.scenario, "objectives")).toBe(true);
    expect(snapshot.scenario.objectives).toBeUndefined();

    const tick = await backend.tick(0);
    expect(tick.rejection).toBeNull();
    expect(typeof tick.applied).toBe("boolean");
    expect(tick.snapshot.schemaVersion).toBe(SNAPSHOT_SCHEMA_VERSION);

    const rejected = await backend.dispatch({
      type: "setSpeed",
      speed: 3 as 0 | 1 | 2 | 4,
    });
    expect(rejected.applied).toBe(false);
    expect(rejected.rejection?.code).toBe("invalidSpeed");
  });

  it("stringifies, parses, and restores a JSON-compatible saved fixture without loss", async () => {
    const source = await createWasmBackend();

    await expect(
      source.validateSnapshot({ snapshot: validPaused }),
    ).resolves.toEqual({ ok: true });
    await expect(
      source.restoreSnapshot({ snapshot: validPaused }),
    ).resolves.toEqual({
      ok: true,
      snapshot: validPaused,
    });

    const saved = await source.snapshotForSave();
    expect(saved.ok).toBe(true);
    if (!saved.ok) throw new Error("expected snapshotForSave success");
    expectJsonCompatible(saved.snapshot);

    const parsed: unknown = JSON.parse(JSON.stringify(saved.snapshot));
    const destination = await createWasmBackend();
    const restored = await destination.restoreSnapshot({ snapshot: parsed });

    expect(restored).toEqual({
      ok: true,
      snapshot: saved.snapshot,
    });
  });

  it.each([
    {
      name: "unsupported schema",
      fixture: unsupportedSchema,
      error: {
        kind: "validation",
        source: "candidate",
        error: {
          code: "unsupportedSchema",
          context: {
            expected: SNAPSHOT_SCHEMA_VERSION,
            actual: SNAPSHOT_SCHEMA_VERSION - 1,
          },
        },
      },
    },
    {
      name: "unpaused snapshot",
      fixture: unpaused,
      error: {
        kind: "validation",
        source: "candidate",
        error: {
          code: "invalidModeSettings",
          context: {
            field: "paused",
            reason: { kind: "persistenceRequiresPaused" },
          },
        },
      },
    },
    {
      name: "malformed current schema",
      fixture: malformedCurrentSchema,
      error: {
        kind: "serialization",
        phase: "snapshotDecode",
        diagnostic: expect.any(String),
      },
    },
    {
      name: "late derived corruption",
      fixture: lateDerivedCorruption,
      error: {
        kind: "validation",
        source: "candidate",
        error: {
          code: "invalidDerivedState",
          context: {
            field: "metricsCounters",
            reason: { kind: "metricsRelationshipMismatch" },
          },
        },
      },
    },
  ])(
    "returns the exact $name category and preserves active state",
    async ({ fixture, error }) => {
      const backend = await createWasmBackend();
      const before = await backend.snapshot();

      await expect(
        backend.validateSnapshot({ snapshot: fixture }),
      ).resolves.toEqual({
        ok: false,
        error: { ...error, operation: "validateSnapshot" },
      });
      await expect(backend.snapshot()).resolves.toEqual(before);

      await expect(
        backend.restoreSnapshot({ snapshot: fixture }),
      ).resolves.toEqual({
        ok: false,
        error: { ...error, operation: "restoreSnapshot" },
      });
      await expect(backend.snapshot()).resolves.toEqual(before);
    },
  );

  it("restores a schema-v4 snapshot through the real artifact", async () => {
    const backend = await createWasmBackend();
    const initial = await backend.snapshot();
    const replacement: RustGameSnapshot = {
      ...initial,
      time: 123.5,
      day: 0,
      clockMinutes: 148,
      speed: 4,
      paused: true,
      budget: 110_000,
    };

    const result = await backend.restoreSnapshot({ snapshot: replacement });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected restore success");
    const loaded = result.snapshot;

    expect(loaded).toMatchObject({
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      time: 123.5,
      day: 0,
      clockMinutes: 148,
      speed: 4,
      paused: true,
      budget: 110_000,
      map: {
        width: initial.map.width,
        height: initial.map.height,
        tiles: expect.any(Array),
        roadStructures: expect.any(Array),
      },
      buildings: expect.any(Array),
      transit: {
        stops: expect.any(Array),
        stations: expect.any(Array),
        routes: expect.any(Array),
        metroLines: expect.any(Array),
        vehicles: expect.any(Array),
      },
      sims: expect.any(Array),
      activeTrips: expect.any(Array),
      metrics: expect.objectContaining({
        state: "running",
      }),
      scenario: expect.objectContaining({
        name: "Crossroads",
        growthWaves: [],
      }),
    });
    // serde-wasm-bindgen omits Rust Option::None, while the Tauri JSON wire
    // shape uses null for the same field.
    expect(loaded.metrics.lossReason ?? null).toBeNull();
    expect(loaded.rules).toEqual(initial.rules);
    expect(Object.hasOwn(loaded.scenario, "objectives")).toBe(true);
    expect(loaded.scenario.objectives).toBeNull();
    expect(loaded.map.tiles).toHaveLength(loaded.map.width * loaded.map.height);
  });

  it("immediately applies Creative road policy after loading a zero-budget snapshot", async () => {
    const source = await createWasmBackend();
    const created = await source.createSandbox({
      templateId: "blankGrid",
      economyPreset: "creative",
      startingCapital: 0,
      demandMultiplier: 1,
      moveInRate: "paused",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      throw new Error("expected Creative Blank Grid creation to succeed");
    }

    const destination = await createWasmBackend();
    const destinationBeforeLoad = await destination.snapshot();
    expect(destinationBeforeLoad.rules.economyPreset).toBe("standard");
    expect(destinationBeforeLoad.budget).not.toBe(0);

    const restore = await destination.restoreSnapshot({
      snapshot: created.snapshot,
    });
    expect(restore.ok).toBe(true);
    if (!restore.ok) throw new Error("expected Creative restore to succeed");
    const loaded = restore.snapshot;
    expect(loaded.schemaVersion).toBe(SNAPSHOT_SCHEMA_VERSION);
    expect(loaded.paused).toBe(true);
    expect(loaded.budget).toBe(0);
    expect(loaded.rules.economyPreset).toBe("creative");

    const result = await destination.dispatch({
      type: "layRoad",
      point: { x: 2, y: 2 },
    });

    expect(result.applied).toBe(true);
    expect(result.context.cost).toBe(100);
    expect(result.snapshot.budget).toBe(0);
    expect(result.snapshot.rules.economyPreset).toBe("creative");
    expect(
      result.snapshot.map.tiles.find((tile) => tile.x === 2 && tile.y === 2),
    ).toMatchObject({ kind: "road" });
  });

  it("round-trips present undefined objectives but rejects an omitted key", async () => {
    const backend = await createWasmBackend();
    const raw = await backend.snapshot();

    expect(Object.hasOwn(raw.scenario, "objectives")).toBe(true);
    expect(raw.scenario.objectives).toBeUndefined();
    const restored = await backend.restoreSnapshot({ snapshot: raw });
    expect(restored.ok).toBe(true);
    if (!restored.ok) throw new Error("expected restore success");
    const loaded = restored.snapshot;
    expect(loaded.schemaVersion).toBe(SNAPSHOT_SCHEMA_VERSION);
    expect(Object.hasOwn(loaded.scenario, "objectives")).toBe(true);
    expect(loaded.scenario.objectives).toBeNull();

    const missing = {
      ...raw,
      scenario: { ...raw.scenario },
    };
    delete (missing.scenario as { objectives?: unknown }).objectives;

    await expect(
      backend.validateSnapshot({ snapshot: missing }),
    ).resolves.toEqual({
      ok: false,
      error: {
        kind: "serialization",
        operation: "validateSnapshot",
        phase: "snapshotDecode",
        diagnostic: expect.stringMatching(/objectives|missing field/i),
      },
    });
  });

  it("rejects invalid demand multipliers at the real WASM Rust boundary", async () => {
    for (const invalid of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const backend = await createWasmBackend();
      const raw = await backend.snapshot();
      raw.rules.sandbox.demandMultiplier = invalid;

      await expect(
        backend.validateSnapshot({ snapshot: raw }),
      ).resolves.toEqual({
        ok: false,
        error: {
          kind: "serialization",
          operation: "validateSnapshot",
          phase: "snapshotDecode",
          diagnostic: expect.stringMatching(/demand multiplier/i),
        },
      });
    }
  });

  it("rejects invalid ObjectiveThresholds fields at the real WASM Rust boundary", async () => {
    // Threshold fields are validated newtypes (see model::ObjectiveThresholds).
    // The default sandbox snapshot has no objectives, so attach a valid
    // campaign objectives block first, then mutate one field to an invalid
    // value and assert the Rust deserializer rejects it. This mirrors the
    // demandMultiplier smoke test and closes the gap where only
    // DemandMultiplier rejection was exercised at the WASM boundary.
    const validThresholds: RustObjectiveThresholds = {
      maxLateRatio: 0.25,
      maxUnservedRatio: 0.2,
      maxAverageWait: 180,
      rollingWindowSeconds: 300,
      survivalTime: 1_200,
    };
    const cases: Array<{
      field: keyof RustObjectiveThresholds;
      invalid: number[];
      pattern: RegExp;
    }> = [
      {
        field: "maxLateRatio",
        invalid: [-0.1, Number.NaN, Number.POSITIVE_INFINITY],
        pattern: /max late ratio/i,
      },
      {
        field: "maxUnservedRatio",
        invalid: [-0.1, Number.NaN, Number.POSITIVE_INFINITY],
        pattern: /max unserved ratio/i,
      },
      {
        field: "maxAverageWait",
        invalid: [-1, Number.NaN, Number.POSITIVE_INFINITY],
        pattern: /max average wait/i,
      },
      {
        field: "rollingWindowSeconds",
        invalid: [0, -1, Number.NaN, Number.POSITIVE_INFINITY],
        pattern: /rolling window/i,
      },
      {
        field: "survivalTime",
        invalid: [0, -1, Number.NaN, Number.POSITIVE_INFINITY],
        pattern: /survival time/i,
      },
    ];

    for (const { field, invalid, pattern } of cases) {
      for (const value of invalid) {
        const backend = await createWasmBackend();
        const raw = await backend.snapshot();
        raw.rules.gameMode = "campaign";
        raw.scenario.objectives = { ...validThresholds };
        (raw.scenario.objectives as RustObjectiveThresholds)[field] = value;

        await expect(
          backend.validateSnapshot({ snapshot: raw }),
        ).resolves.toEqual({
          ok: false,
          error: {
            kind: "serialization",
            operation: "validateSnapshot",
            phase: "snapshotDecode",
            diagnostic: expect.stringMatching(pattern),
          },
        });
      }
    }
  });

  it("rejects an unpaused schema-v4 snapshot with the persistence error", async () => {
    const backend = await createWasmBackend();
    const raw = await backend.snapshot();
    raw.paused = false;

    await expect(backend.validateSnapshot({ snapshot: raw })).resolves.toEqual({
      ok: false,
      error: {
        kind: "validation",
        operation: "validateSnapshot",
        source: "candidate",
        error: {
          code: "invalidModeSettings",
          context: {
            field: "paused",
            reason: { kind: "persistenceRequiresPaused" },
          },
        },
      },
    });
  });

  it("rejects a schema-v3 save missing required v4 fields with unsupportedSchema", async () => {
    // A legacy schema-v3 save lacks the required v4 `startingCapital` field. The two-phase
    // probe must reject it with the structured `unsupportedSchema` code
    // (surfaced as a serialized PersistenceError object) instead of a generic
    // missing-field serde error string.
    const backend = await createWasmBackend();
    const raw = await backend.snapshot();
    const legacy = {
      ...raw,
      schemaVersion: SNAPSHOT_SCHEMA_VERSION - 1,
    } as Partial<RustGameSnapshot> & { rules?: unknown };
    delete (legacy as { rules?: unknown }).rules;

    await expect(
      backend.validateSnapshot({ snapshot: legacy }),
    ).resolves.toEqual({
      ok: false,
      error: {
        kind: "validation",
        operation: "validateSnapshot",
        source: "candidate",
        error: {
          code: "unsupportedSchema",
          context: {
            expected: SNAPSHOT_SCHEMA_VERSION,
            actual: SNAPSHOT_SCHEMA_VERSION - 1,
          },
        },
      },
    });
  });

  it("rejects a malformed schema-v4 payload with a raw string, not a typed object", async () => {
    // A payload whose `schemaVersion` is v4 but whose body cannot deserialize
    // into `GameSnapshot` (e.g. a required field has the wrong type) must
    // reject with a raw JavaScript string, not a `PersistenceError` object.
    // This matches the Tauri bridge's raw Serde string and the host contract
    // (design §12.7: raw deserialization failures are strings on both hosts).
    const backend = await createWasmBackend();
    const raw = await backend.snapshot();
    const malformed = {
      ...raw,
      map: { ...raw.map, tiles: "not-an-array" },
    } as unknown as RustGameSnapshot;

    const result = await backend.validateSnapshot({ snapshot: malformed });
    expect(result).toEqual({
      ok: false,
      error: {
        kind: "serialization",
        operation: "validateSnapshot",
        phase: "snapshotDecode",
        diagnostic: expect.any(String),
      },
    });
    if (result.ok || result.error.kind !== "serialization") {
      throw new Error("expected snapshotDecode serialization failure");
    }
    expect(result.error.diagnostic).toBeTypeOf("string");
  });

  it("round-trips a placeRoundabout dispatch through wasm-bindgen", async () => {
    const backend = await createWasmBackend();
    const before = await backend.snapshot();
    const structuresBefore = before.map.roadStructures.length;

    const result = await backend.dispatch({
      type: "placeRoundabout",
      origin: { x: 2, y: 2 },
      size: "compact2x2",
    });

    expect(result.applied).toBe(true);
    expect(result.rejection).toBeNull();
    expect(result.snapshot.map.roadStructures.length).toBe(
      structuresBefore + 1,
    );
    expect(
      result.snapshot.map.roadStructures.some((s) => s.kind === "roundabout"),
    ).toBe(true);
  });

  it("round-trips bus stop placement and route preview through wasm-bindgen", async () => {
    const backend = await createWasmBackend();

    const stopA = await backend.dispatch({
      type: "addBusStop",
      point: { x: 10, y: 7 },
    });
    expect(stopA.applied).toBe(true);
    expect(stopA.snapshot.transit.stops).toHaveLength(1);

    const stopB = await backend.dispatch({
      type: "addBusStop",
      point: { x: 5, y: 7 },
    });
    expect(stopB.applied).toBe(true);
    expect(stopB.snapshot.transit.stops).toHaveLength(2);

    const [stopAId, stopBId] = stopB.snapshot.transit.stops.map((s) => s.id);

    const preview = await backend.previewRoute({
      mode: "bus",
      pattern: "loop",
      waypointIds: [stopAId, stopBId],
      routeId: null,
      expectedRevision: null,
      generation: 1,
    });

    expect(Array.isArray(preview.legs)).toBe(true);
    expect(preview.legs.length).toBeGreaterThanOrEqual(1);
    expect(preview.missingWaypointIds).toEqual([]);
  });

  it.each([
    {
      templateId: "blankGrid",
      economyPreset: "creative",
      startingCapital: 42_000,
      demandMultiplier: 1.5,
      moveInRate: "paused",
    },
    canonicalCrossroadsRequest,
  ] satisfies SandboxCreationRequest[])(
    "creates deterministic $templateId snapshots with the exact requested rules",
    async (request) => {
      const firstBackend = await createWasmBackend();
      const secondBackend = await createWasmBackend();

      const first = await firstBackend.createSandbox(request);
      const second = await secondBackend.createSandbox(request);

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      if (!first.ok || !second.ok) {
        throw new Error("expected requested sandbox creation to succeed");
      }
      expect(first.snapshot.schemaVersion).toBe(4);
      expect(first.snapshot.budget).toBe(request.startingCapital);
      expect(first.snapshot.rules).toEqual({
        gameMode: "sandbox",
        economyPreset: request.economyPreset,
        sandbox: {
          templateId: request.templateId,
          startingCapital: request.startingCapital,
          demandMultiplier: request.demandMultiplier,
          moveInRate: request.moveInRate,
        },
      });
      expect(second.snapshot).toEqual(first.snapshot);
    },
  );

  it.each([
    {
      request: { ...canonicalCrossroadsRequest, templateId: "unknown" },
      error: {
        code: "unknownTemplateId",
        context: { field: "templateId", attemptedValue: "unknown" },
      },
    },
    {
      request: { ...canonicalCrossroadsRequest, economyPreset: "unknown" },
      error: {
        code: "unknownEconomyPreset",
        context: { field: "economyPreset", attemptedValue: "unknown" },
      },
    },
    {
      request: { ...canonicalCrossroadsRequest, startingCapital: -1 },
      error: {
        code: "invalidStartingCapital",
        context: { field: "startingCapital", attemptedValue: "-1" },
      },
    },
    {
      request: { ...canonicalCrossroadsRequest, demandMultiplier: 0 },
      error: {
        code: "invalidDemandMultiplier",
        context: { field: "demandMultiplier", attemptedValue: "0" },
      },
    },
    {
      request: { ...canonicalCrossroadsRequest, moveInRate: "steady" },
      error: {
        code: "unknownMoveInRate",
        context: { field: "moveInRate", attemptedValue: "steady" },
      },
    },
    {
      request: {
        ...canonicalCrossroadsRequest,
        startingCapital: Number.NaN,
      },
      error: {
        code: "invalidStartingCapital",
        context: { field: "startingCapital", attemptedValue: "NaN" },
      },
    },
    {
      request: {
        ...canonicalCrossroadsRequest,
        demandMultiplier: Number.POSITIVE_INFINITY,
      },
      error: {
        code: "invalidDemandMultiplier",
        context: { field: "demandMultiplier", attemptedValue: "Infinity" },
      },
    },
  ])(
    "returns the exact typed creation error for %#",
    async ({ request, error }) => {
      const backend = await createWasmBackend();

      await expect(
        backend.createSandbox(request as SandboxCreationRequest),
      ).resolves.toEqual({ ok: false, error });
    },
  );

  it("keeps the active engine unchanged after failed requested creation", async () => {
    const backend = await createWasmBackend();
    const created = await backend.createSandbox({
      ...canonicalCrossroadsRequest,
      templateId: "blankGrid",
      startingCapital: 42_000,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("expected setup creation to succeed");

    await expect(
      backend.createSandbox({
        ...canonicalCrossroadsRequest,
        startingCapital: -1,
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "invalidStartingCapital" },
    });
    await expect(backend.snapshot()).resolves.toEqual(created.snapshot);
  });

  it("resets to the exact successful request after a nominal-cost map mutation", async () => {
    const backend = await createWasmBackend();
    const created = await backend.createSandbox({
      templateId: "blankGrid",
      economyPreset: "creative",
      startingCapital: 42_000,
      demandMultiplier: 1.5,
      moveInRate: "paused",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("expected setup creation to succeed");

    const mapMutation = await backend.dispatch({
      type: "placeRoundabout",
      origin: { x: 2, y: 2 },
      size: "compact2x2",
    });
    expect(mapMutation.applied).toBe(true);
    expect(mapMutation.rejection).toBeNull();
    expect(mapMutation.context.cost).toBe(1_000);
    expect(mapMutation.snapshot.budget).toBe(created.snapshot.budget);
    expect(mapMutation.snapshot.map.roadStructures).toHaveLength(
      created.snapshot.map.roadStructures.length + 1,
    );
    expect(
      mapMutation.snapshot.map.roadStructures.some(
        (structure) => structure.kind === "roundabout",
      ),
    ).toBe(true);
    expect(mapMutation.snapshot.map).not.toEqual(created.snapshot.map);

    const reset = await backend.reset();
    expect(reset).toEqual({ ok: true, snapshot: created.snapshot });
    await expect(backend.snapshot()).resolves.toEqual(created.snapshot);
  });

  it("keeps the default constructor equal to canonical Crossroads", async () => {
    const defaultBackend = await createWasmBackend();
    const requestedBackend = await createWasmBackend();
    const canonical = await requestedBackend.createSandbox(
      canonicalCrossroadsRequest,
    );

    expect(canonical.ok).toBe(true);
    if (!canonical.ok)
      throw new Error("expected canonical creation to succeed");
    await expect(defaultBackend.snapshot()).resolves.toEqual(
      canonical.snapshot,
    );
  });
});
