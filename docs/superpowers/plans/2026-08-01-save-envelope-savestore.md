# Save Envelope and SaveStore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement HPA-498’s versioned save envelope, strict compatibility inspection, host-neutral `SaveStore` contract, deterministic in-memory adapter, and reusable adapter conformance suite.

**Architecture:** Keep host metadata in `src/persistence/` and Rust gameplay snapshots opaque. Envelope inspection validates only the closed header vocabulary; Rust remains the semantic gameplay authority. The in-memory adapter establishes normative atomicity, conflict, ordering, corruption, and autosave high-water behavior that IndexedDB and Tauri adapters must later reproduce.

**Tech Stack:** TypeScript 5.8, Vitest runtime project, Bun, existing Rust-generated persistence fixtures, `RustGameSnapshot` and persistence contracts from `src/runtime/backend/`.

## Global Constraints

- Implement the approved design in `docs/superpowers/specs/2026-07-31-save-envelope-store-runtime-persistence-design.md`.
- `SNAPSHOT_SCHEMA_VERSION` is mirrored in TypeScript and Rust; parity tests must fail when either side or the Rust-generated fixture diverges.
- Reuse `GameMode`, `EconomyPreset`, and `SandboxTemplateId` from `src/domain/types.ts`.
- TypeScript header inspection must not validate, repair, normalize, or migrate gameplay snapshots.
- Expected store failures return `SaveStoreResult<T>`; adapters do not expose host exceptions as control flow.
- Adapters never call `Date.now()`, `crypto.randomUUID()`, or allocate city/checkpoint/autosave IDs or generation numbers.
- Checkpoint/autosave `createdAt` is derived from envelope `savedAt` in the same atomic write.
- Autosave generation high-water is persisted separately from retained autosaves and never decreases until city deletion.
- Rename and duplicate inspect source envelope headers internally; delete remains available by storage identity for corrupt/unsupported records.
- Do not add checksum, HMAC, encryption, schema migration, browser storage, or Tauri filesystem code in HPA-498.

---

## File Map

**Create**

- `src/persistence/envelope.ts` — envelope types, builder dependencies, summary derivation, supported-version constants.
- `src/persistence/envelopeInspection.ts` — exception-safe closed header inspection and compatibility/error mapping.
- `src/persistence/saveStore.ts` — store interface, result/error types, summaries, autosave listing, shared ordering helpers.
- `src/persistence/memorySaveStore.ts` — detached in-memory implementation and deterministic failure injection.
- `tests/runtime/persistence/fixtures.ts` — deterministic envelopes, hostile values, and store inputs.
- `tests/runtime/persistence/envelope.test.ts` — envelope builder, schema parity, and inspection catalogue tests.
- `tests/runtime/persistence/saveStoreContract.ts` — reusable adapter conformance suite.
- `tests/runtime/persistence/memorySaveStore.test.ts` — instantiate the reusable suite plus memory-specific detachment/failure tests.

**Read/Reuse**

- `src/domain/types.ts` — `SNAPSHOT_SCHEMA_VERSION`, `GameMode`, `EconomyPreset`, `SandboxTemplateId`.
- `src/runtime/backend/types.ts` — `RustGameSnapshot`.
- `tests/fixtures/persistence/valid-paused.json` — Rust-generated schema-v4 snapshot fixture.
- `vite.config.ts` — existing `tests/runtime/**/*.test.ts` collection.

---

### Task 1: Define the envelope and summary builder

**Files:**
- Create: `src/persistence/envelope.ts`
- Create: `tests/runtime/persistence/fixtures.ts`
- Test: `tests/runtime/persistence/envelope.test.ts`

**Interfaces:**
- Consumes: `SNAPSHOT_SCHEMA_VERSION`, `GameMode`, `EconomyPreset`, `SandboxTemplateId`, `RustGameSnapshot`.
- Produces: `SaveEnvelopeSummary`, `SaveEnvelope<TSnapshot>`, `WritableSaveEnvelope`, `InspectedSaveEnvelope`, `UntrustedSaveValue`, `SUPPORTED_SNAPSHOT_SCHEMA_VERSIONS`, `buildSaveEnvelope`.

- [ ] **Step 1: Write failing envelope construction tests**

```ts
import { describe, expect, it } from "vitest";
import { SNAPSHOT_SCHEMA_VERSION } from "../../../src/domain/types";
import { buildSaveEnvelope } from "../../../src/persistence/envelope";
import { makeRustSnapshot } from "./fixtures";

describe("buildSaveEnvelope", () => {
  it("copies only canonical snapshot facts into advisory summary metadata", () => {
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

    expect(envelope.format).toBe("caelum-save");
    expect(envelope.envelopeVersion).toBe(1);
    expect(envelope.snapshotSchemaVersion).toBe(SNAPSHOT_SCHEMA_VERSION);
    expect(envelope.summary).toEqual({
      gameMode: "sandbox",
      economyPreset: "standard",
      sandboxTemplateId: "crossroads",
    });
    expect(envelope.snapshot).toBe(snapshot);
  });
});
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run: `bunx vitest run --project runtime tests/runtime/persistence/envelope.test.ts`

Expected: FAIL because `src/persistence/envelope.ts` does not exist.

- [ ] **Step 3: Implement the envelope contract and builder**

```ts
import {
  SNAPSHOT_SCHEMA_VERSION,
  type EconomyPreset,
  type GameMode,
  type SandboxTemplateId,
} from "../domain/types";
import type { RustGameSnapshot } from "../runtime/backend/types";

export const CAELUM_SAVE_FORMAT = "caelum-save" as const;
export const SAVE_ENVELOPE_VERSION = 1 as const;
export const SUPPORTED_SNAPSHOT_SCHEMA_VERSIONS = new Set<number>([
  SNAPSHOT_SCHEMA_VERSION,
]);

export interface SaveEnvelopeSummary {
  gameMode: GameMode;
  economyPreset: EconomyPreset;
  sandboxTemplateId: SandboxTemplateId;
}

export interface SaveEnvelope<TSnapshot = unknown> {
  format: typeof CAELUM_SAVE_FORMAT;
  envelopeVersion: typeof SAVE_ENVELOPE_VERSION;
  city: { id: string; name: string };
  cityCreatedAt: string;
  savedAt: string;
  appVersion: string;
  snapshotSchemaVersion: number;
  summary: SaveEnvelopeSummary;
  snapshot: TSnapshot;
}

export type WritableSaveEnvelope = SaveEnvelope<RustGameSnapshot>;
export type InspectedSaveEnvelope = SaveEnvelope<unknown>;
export type UntrustedSaveValue = unknown;

export function buildSaveEnvelope(input: {
  city: SaveEnvelope["city"];
  cityCreatedAt: string;
  savedAt: string;
  appVersion: string;
  snapshot: RustGameSnapshot;
}): WritableSaveEnvelope {
  return {
    format: CAELUM_SAVE_FORMAT,
    envelopeVersion: SAVE_ENVELOPE_VERSION,
    city: input.city,
    cityCreatedAt: input.cityCreatedAt,
    savedAt: input.savedAt,
    appVersion: input.appVersion,
    snapshotSchemaVersion: SNAPSHOT_SCHEMA_VERSION,
    summary: {
      gameMode: input.snapshot.rules.gameMode,
      economyPreset: input.snapshot.rules.economyPreset,
      sandboxTemplateId: input.snapshot.rules.sandbox.templateId,
    },
    snapshot: input.snapshot,
  };
}
```

- [ ] **Step 4: Add validation-independent fixture helpers**

Create `makeRustSnapshot(overrides)` by cloning the existing valid paused fixture shape and applying deterministic test overrides. Do not synthesize a second gameplay validator; the helper exists only to build known-valid test inputs.

- [ ] **Step 5: Run tests**

Run: `bunx vitest run --project runtime tests/runtime/persistence/envelope.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/persistence/envelope.ts tests/runtime/persistence/fixtures.ts tests/runtime/persistence/envelope.test.ts
git commit -m "feat: define save envelope contract"
```

---

### Task 2: Implement strict envelope inspection and schema parity

**Files:**
- Create: `src/persistence/envelopeInspection.ts`
- Modify: `tests/runtime/persistence/envelope.test.ts`
- Read: `tests/fixtures/persistence/valid-paused.json`

**Interfaces:**
- Consumes: `UntrustedSaveValue`, `InspectedSaveEnvelope`, `SUPPORTED_SNAPSHOT_SCHEMA_VERSIONS`.
- Produces: `SaveEnvelopeError`, `SaveCompatibility`, `inspectSaveEnvelope`, `compatibilityToEnvelopeError`.

- [ ] **Step 1: Write catalogue and hostile-shape tests**

```ts
it.each([
  [{}, { status: "corruptHeader" }],
  [
    { format: "caelum-save", envelopeVersion: 99 },
    { status: "unsupportedEnvelope", version: 99 },
  ],
  [
    makeEnvelope({ snapshotSchemaVersion: 99, embeddedSchemaVersion: 99 }),
    { status: "unsupportedSnapshot", version: 99 },
  ],
  [
    makeEnvelope({ snapshotSchemaVersion: 4, snapshot: {} }),
    {
      status: "snapshotVersionMismatch",
      declaredVersion: 4,
      embeddedVersion: null,
    },
  ],
])("classifies %p", (value, expected) => {
  expect(inspectSaveEnvelope(value)).toEqual({ ok: false, compatibility: expected });
});

it("rejects throwing getters without escaping", () => {
  const value = Object.defineProperty({}, "format", {
    get() {
      throw new Error("hostile getter");
    },
  });
  expect(inspectSaveEnvelope(value)).toEqual({
    ok: false,
    compatibility: { status: "corruptHeader" },
  });
});
```

- [ ] **Step 2: Run the focused tests and confirm failure**

Run: `bunx vitest run --project runtime tests/runtime/persistence/envelope.test.ts`

Expected: FAIL because inspection exports do not exist.

- [ ] **Step 3: Implement exception-safe closed inspection**

Implement plain-object checks, exact required header keys, finite integer version checks, and summary primitive checks. Return:

```ts
export type InspectSaveEnvelopeResult =
  | { ok: true; envelope: InspectedSaveEnvelope; compatibility: { status: "candidate" } }
  | { ok: false; compatibility: Exclude<SaveCompatibility, { status: "candidate" }> };
```

Read `snapshot.schemaVersion` only through guarded property access. A missing/non-object/non-integer embedded version maps to `embeddedVersion: null`; throwing access maps to `corruptHeader`.

- [ ] **Step 4: Implement the exhaustive compatibility-to-error mapping**

```ts
export function compatibilityToEnvelopeError(
  compatibility: Exclude<SaveCompatibility, { status: "candidate" }>,
): SaveEnvelopeError {
  switch (compatibility.status) {
    case "corruptHeader":
      return { code: "corruptHeader" };
    case "unsupportedEnvelope":
      return { code: "unsupportedEnvelope", version: compatibility.version };
    case "unsupportedSnapshot":
      return { code: "unsupportedSnapshot", version: compatibility.version };
    case "snapshotVersionMismatch":
      return {
        code: "snapshotVersionMismatch",
        declaredVersion: compatibility.declaredVersion,
        embeddedVersion: compatibility.embeddedVersion,
      };
  }
}
```

- [ ] **Step 5: Add mirrored schema parity coverage**

Load `tests/fixtures/persistence/valid-paused.json` and assert its `schemaVersion` equals TypeScript `SNAPSHOT_SCHEMA_VERSION`. Add the corresponding Rust-side assertion to the existing persistence fixture test in the implementation branch if it is not already present; the TypeScript test must not parse Rust source text.

- [ ] **Step 6: Run tests**

Run: `bunx vitest run --project runtime tests/runtime/persistence/envelope.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/persistence/envelopeInspection.ts tests/runtime/persistence/envelope.test.ts
git commit -m "feat: inspect save envelope headers strictly"
```

---

### Task 3: Define the SaveStore contract and ordering helpers

**Files:**
- Create: `src/persistence/saveStore.ts`
- Modify: `tests/runtime/persistence/fixtures.ts`
- Create: `tests/runtime/persistence/saveStoreContract.ts`

**Interfaces:**
- Produces: `SaveStore`, `SaveStoreResult<T>`, `SaveStoreError`, `CitySummary`, `CheckpointSummary`, `AutosaveSummary`, `AutosaveListing`, deterministic sorting helpers.

- [ ] **Step 1: Write compile-time and runtime contract tests**

Create a minimal fake adapter in `saveStoreContract.ts` and assert list ordering helpers place valid timestamps before unreadable timestamps and use ID tie-breakers.

```ts
expect(sortCities([
  citySummary({ cityId: "b", savedAt: "2026-08-01T10:00:00.000Z" }),
  citySummary({ cityId: "a", savedAt: "2026-08-01T10:00:00.000Z" }),
  citySummary({ cityId: "z", savedAt: null }),
]).map((city) => city.cityId)).toEqual(["a", "b", "z"]);
```

- [ ] **Step 2: Run test and confirm failure**

Run: `bunx vitest run --project runtime tests/runtime/persistence/memorySaveStore.test.ts`

Expected: FAIL until the contract module exists.

- [ ] **Step 3: Implement the exact interface from the design**

Include `listAutosaves(cityId): Promise<SaveStoreResult<AutosaveListing>>`, with `generationHighWaterMark: number | null`. Keep read payloads typed as `UntrustedSaveValue`.

- [ ] **Step 4: Implement deterministic sort functions**

Export pure helpers for cities, checkpoints, and autosaves. Parse timestamps only for ordering; never mutate or repair summary values.

- [ ] **Step 5: Run TypeScript check**

Run: `bun run check`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/persistence/saveStore.ts tests/runtime/persistence/fixtures.ts tests/runtime/persistence/saveStoreContract.ts
git commit -m "feat: define SaveStore contract"
```

---

### Task 4: Implement working-save lifecycle in the in-memory adapter

**Files:**
- Create: `src/persistence/memorySaveStore.ts`
- Create: `tests/runtime/persistence/memorySaveStore.test.ts`
- Modify: `tests/runtime/persistence/saveStoreContract.ts`

**Interfaces:**
- Consumes: `SaveStore`, `inspectSaveEnvelope`, sorting helpers.
- Produces: `createMemorySaveStore(options?)`.

- [ ] **Step 1: Add failing working-save tests**

Cover write/read detachment, atomic replacement, rename, duplicate, target conflict, unsupported/corrupt source outcomes, and cascading city delete.

```ts
it("preserves the previous working save after an injected write failure", async () => {
  const controls = createMemoryFailureControls();
  const store = createMemorySaveStore({ failures: controls });
  await expectOk(store.writeWorkingSave(envelope({ savedAt: "2026-08-01T10:00:00.000Z" })));
  controls.failNext("writeWorkingSave", "transactionAborted");

  await expectError(
    store.writeWorkingSave(envelope({ savedAt: "2026-08-01T11:00:00.000Z" })),
    "transactionAborted",
  );

  expect(await expectOk(store.readWorkingSave("city-1"))).toMatchObject({
    savedAt: "2026-08-01T10:00:00.000Z",
  });
});
```

- [ ] **Step 2: Run test and confirm failure**

Run: `bunx vitest run --project runtime tests/runtime/persistence/memorySaveStore.test.ts`

Expected: FAIL because the adapter does not exist.

- [ ] **Step 3: Implement detached committed storage**

Use `structuredClone` for known JSON-compatible values and return `serializationFailed` when cloning throws. Store committed records in private maps; clone on both write and read so callers cannot mutate retained state.

- [ ] **Step 4: Implement rename/duplicate inspection semantics**

Both operations inspect the source internally. Map unsupported headers to `incompatibleRecord`, corrupt/mismatch to `corruptRecord`, and target collision to `conflict`. Rename changes only `city.name`; duplicate assigns the supplied host identity and copies no generations/high-water state.

- [ ] **Step 5: Implement deterministic failure injection**

Expose a test-only control object that can fail the next named operation before commit. Never add environment-specific branches to production consumers.

- [ ] **Step 6: Run focused tests**

Run: `bunx vitest run --project runtime tests/runtime/persistence/memorySaveStore.test.ts`

Expected: PASS for working-save cases.

- [ ] **Step 7: Commit**

```bash
git add src/persistence/memorySaveStore.ts tests/runtime/persistence/memorySaveStore.test.ts tests/runtime/persistence/saveStoreContract.ts
git commit -m "feat: implement in-memory working saves"
```

---

### Task 5: Implement checkpoints, autosaves, and persistent high-water state

**Files:**
- Modify: `src/persistence/memorySaveStore.ts`
- Modify: `tests/runtime/persistence/memorySaveStore.test.ts`
- Modify: `tests/runtime/persistence/saveStoreContract.ts`

**Interfaces:**
- Implements: checkpoint CRUD, autosave CRUD, `AutosaveListing`, high-water atomicity.

- [ ] **Step 1: Add failing generation tests**

Cover create-only ID conflicts, city/envelope mismatch, derived timestamps, ordering, checkpoint rename preservation, autosave high-water update, pruning without reuse, failed-write high-water preservation, duplicate isolation, and city-delete cleanup.

```ts
it("does not reuse a pruned autosave generation", async () => {
  const store = createMemorySaveStore();
  await expectOk(store.writeWorkingSave(envelope()));
  await expectOk(store.writeAutosave({
    autosaveId: "auto-10",
    cityId: "city-1",
    generation: 10,
    envelope: envelope({ savedAt: "2026-08-01T10:10:00.000Z" }),
  }));
  await expectOk(store.deleteAutosave("city-1", "auto-10"));

  const listing = await expectOk(store.listAutosaves("city-1"));
  expect(listing).toEqual({ items: [], generationHighWaterMark: 10 });

  await expectError(store.writeAutosave({
    autosaveId: "auto-10b",
    cityId: "city-1",
    generation: 10,
    envelope: envelope({ savedAt: "2026-08-01T10:11:00.000Z" }),
  }), "conflict");
});
```

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `bunx vitest run --project runtime tests/runtime/persistence/memorySaveStore.test.ts`

Expected: FAIL on unimplemented generation methods.

- [ ] **Step 3: Implement checkpoint storage**

Derive `createdAt` from `envelope.savedAt`; enforce exact city match and create-only checkpoint IDs. Rename changes checkpoint display metadata only and preserves timestamp/envelope.

- [ ] **Step 4: Implement autosave record plus high-water atomic commit**

Before commit, validate ID uniqueness, safe-integer generation, city match, and `generation > currentHighWater`. Clone all values first. Only after every step succeeds, commit the autosave record and high-water in one mutation block.

- [ ] **Step 5: Implement deletion semantics**

`deleteAutosave` removes only the record. `deleteCity` removes working save, checkpoints, autosaves, and high-water. `duplicateCity` creates no high-water entry for the target.

- [ ] **Step 6: Run focused tests**

Run: `bunx vitest run --project runtime tests/runtime/persistence/memorySaveStore.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/persistence/memorySaveStore.ts tests/runtime/persistence/memorySaveStore.test.ts tests/runtime/persistence/saveStoreContract.ts
git commit -m "feat: add in-memory save generations"
```

---

### Task 6: Finalize the reusable adapter contract suite

**Files:**
- Modify: `tests/runtime/persistence/saveStoreContract.ts`
- Modify: `tests/runtime/persistence/memorySaveStore.test.ts`
- Modify: `tests/runtime/persistence/envelope.test.ts`

**Interfaces:**
- Produces: `defineSaveStoreContract(name, createHarness)` for HPA-343/HPA-344.

- [ ] **Step 1: Refactor memory tests into a reusable harness**

```ts
export interface SaveStoreContractHarness {
  store: SaveStore;
  reopen?(): Promise<SaveStore>;
  failNext?(operation: SaveStoreOperation, code: SaveStoreErrorCode): void;
}

export function defineSaveStoreContract(
  name: string,
  createHarness: () => Promise<SaveStoreContractHarness> | SaveStoreContractHarness,
): void {
  describe(name, () => {
    // shared contract cases
  });
}
```

The shared suite must cover all normative behavior, while adapter-specific reopen/crash cases remain optional harness extensions.

- [ ] **Step 2: Verify every design acceptance criterion has a named test**

Required named groups:

- envelope/header catalogue and hostile values;
- working atomic replacement and detached reads/writes;
- deterministic city/checkpoint/autosave ordering;
- rename/duplicate inspection parity;
- checkpoint/autosave create-only conflicts;
- key/timestamp mismatch corruption;
- autosave high-water atomicity and pruning;
- city cascade delete and duplicate isolation;
- typed failure codes without thrown host errors.

- [ ] **Step 3: Run the runtime persistence suite**

Run: `bunx vitest run --project runtime tests/runtime/persistence`

Expected: all tests PASS.

- [ ] **Step 4: Run full verification**

```bash
bun run check
bun run format:check
bunx vitest run --project runtime
bun run test
bun run build
```

Expected: every command exits 0.

- [ ] **Step 5: Search for prohibited behavior**

```bash
rg 'Date\.now|crypto\.randomUUID|localStorage|normalizeRustSnapshot' src/persistence tests/runtime/persistence
```

Expected: no production ID/time generation, Local Storage use, or snapshot normalization in `src/persistence`.

- [ ] **Step 6: Commit**

```bash
git add src/persistence tests/runtime/persistence
git commit -m "test: define SaveStore adapter contract"
```

---

## HPA-498 Completion Gate

- [ ] `SaveEnvelope` uses shared domain types and a non-null `SandboxTemplateId`.
- [ ] TypeScript/Rust schema version parity is fixture-backed.
- [ ] Header inspection is exception-safe and closed.
- [ ] `SaveStore` has no browser/Tauri branching.
- [ ] Memory adapter detaches reads/writes and preserves previous commits after failures.
- [ ] Rename/duplicate inspect sources internally with closed outcomes.
- [ ] Checkpoint/autosave timestamps derive from envelope `savedAt`.
- [ ] Autosave high-water persists independently of retained records.
- [ ] Reusable adapter suite is ready for HPA-343 and HPA-344.
- [ ] Full verification commands pass before HPA-498 is marked complete.
