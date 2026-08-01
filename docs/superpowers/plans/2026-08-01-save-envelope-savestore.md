# Save Envelope and SaveStore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement HPA-498’s versioned save envelope, strict compatibility inspection, host-neutral `SaveStore`, deterministic in-memory adapter, and reusable adapter contract suite.

**Architecture:** `src/persistence/` owns host metadata and storage contracts while treating Rust gameplay snapshots as opaque values. Header inspection validates only the closed envelope vocabulary. The in-memory adapter is the executable reference for atomic replacement, create-only generation records, corruption visibility, deterministic ordering, and persistent autosave high-water state.

**Tech Stack:** TypeScript 5.8, Vitest runtime project, Bun, existing Rust persistence fixtures, `RustGameSnapshot`, `serde_json` fixture tests.

## Global Constraints

- Implement `docs/superpowers/specs/2026-07-31-save-envelope-store-runtime-persistence-design.md` without adding migration or repair behavior.
- Reuse `GameMode`, `EconomyPreset`, `SandboxTemplateId`, and TypeScript `SNAPSHOT_SCHEMA_VERSION` from `src/domain/types.ts`.
- Rust and TypeScript schema constants are mirrored and must move together; parity is fixture-backed.
- Envelope inspection never invokes `normalizeRustSnapshot`, `validateSnapshot`, or gameplay repair.
- Expected storage failures return `SaveStoreResult<T>` and never rely on thrown host errors for control flow.
- Adapters never call `Date.now()`, `crypto.randomUUID()`, or allocate gameplay-facing IDs/generations.
- Checkpoint/autosave `createdAt` derives from envelope `savedAt` in the same atomic write.
- Autosave high-water is separate persisted state, never decreases on pruning, and is removed only by city deletion.
- Rename and duplicate inspect source envelopes internally; delete remains available by storage identity for corrupt/unsupported records.
- HPA-498 does not implement IndexedDB, Tauri filesystem storage, cloud sync, checksums, encryption, or UI.

---

## File Map

**Create**

- `src/persistence/envelope.ts`
- `src/persistence/envelopeInspection.ts`
- `src/persistence/saveStore.ts`
- `src/persistence/memorySaveStore.ts`
- `tests/runtime/persistence/fixtures.ts`
- `tests/runtime/persistence/envelope.test.ts`
- `tests/runtime/persistence/saveStore.test.ts`
- `tests/runtime/persistence/saveStoreContract.ts`
- `tests/runtime/persistence/memorySaveStore.test.ts`

**Modify**

- `crates/caelum-core/tests/persistence_fixture_export.rs`

**Read/Reuse**

- `src/domain/types.ts`
- `src/runtime/backend/types.ts`
- `tests/fixtures/persistence/valid-paused.json`
- `vite.config.ts`

---

### Task 1: Define envelope types, builder, and deterministic fixtures

**Files:**
- Create: `src/persistence/envelope.ts`
- Create: `tests/runtime/persistence/fixtures.ts`
- Create: `tests/runtime/persistence/envelope.test.ts`

**Interfaces:**
- Produces: `SaveEnvelopeSummary`, `SaveEnvelope<T>`, `WritableSaveEnvelope`, `InspectedSaveEnvelope`, `UntrustedSaveValue`, `SUPPORTED_SNAPSHOT_SCHEMA_VERSIONS`, `buildSaveEnvelope`.

- [ ] **Step 1: Write the failing builder test**

```ts
it("builds schema-v1 host metadata from a canonical Rust snapshot", () => {
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

  const result = buildSaveEnvelope({
    city: { id: "city-1", name: "North Loop" },
    cityCreatedAt: "2026-08-01T10:00:00.000Z",
    savedAt: "2026-08-01T10:05:00.000Z",
    appVersion: "0.1.0",
    snapshot,
  });

  expect(result).toMatchObject({
    format: "caelum-save",
    envelopeVersion: 1,
    snapshotSchemaVersion: SNAPSHOT_SCHEMA_VERSION,
    summary: {
      gameMode: "sandbox",
      economyPreset: "standard",
      sandboxTemplateId: "crossroads",
    },
  });
  expect(result.snapshot).toBe(snapshot);
});
```

- [ ] **Step 2: Run the test and confirm failure**

Run: `bunx vitest run --project runtime tests/runtime/persistence/envelope.test.ts`

Expected: FAIL because `src/persistence/envelope.ts` does not exist.

- [ ] **Step 3: Implement the envelope contract**

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
```

Implement `buildSaveEnvelope` exactly from the test inputs, deriving summary fields from `snapshot.rules` and using `SNAPSHOT_SCHEMA_VERSION` for `snapshotSchemaVersion`.

- [ ] **Step 4: Implement deterministic fixture helpers**

```ts
import validPaused from "../../fixtures/persistence/valid-paused.json";
import type { RustGameSnapshot } from "../../../src/runtime/backend/types";

export function makeRustSnapshot(
  overrides: Partial<RustGameSnapshot> = {},
): RustGameSnapshot {
  const base = structuredClone(validPaused) as RustGameSnapshot;
  return { ...base, ...overrides };
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
```

- [ ] **Step 5: Run tests and typecheck**

```bash
bunx vitest run --project runtime tests/runtime/persistence/envelope.test.ts
bun run check
```

Expected: both commands exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/persistence/envelope.ts tests/runtime/persistence/fixtures.ts tests/runtime/persistence/envelope.test.ts
git commit -m "feat: define save envelope contract"
```

---

### Task 2: Implement strict header inspection and mirrored schema parity

**Files:**
- Create: `src/persistence/envelopeInspection.ts`
- Modify: `tests/runtime/persistence/envelope.test.ts`
- Modify: `crates/caelum-core/tests/persistence_fixture_export.rs`

**Interfaces:**
- Produces: `SaveEnvelopeError`, `SaveCompatibility`, `InspectSaveEnvelopeResult`, `inspectSaveEnvelope`, `compatibilityToEnvelopeError`.

- [ ] **Step 1: Add failing catalogue tests**

```ts
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
    makeEnvelope({ snapshot: {} as never }),
    {
      status: "snapshotVersionMismatch",
      declaredVersion: SNAPSHOT_SCHEMA_VERSION,
      embeddedVersion: null,
    },
  ],
])("classifies an invalid header", (value, compatibility) => {
  expect(inspectSaveEnvelope(value)).toEqual({ ok: false, compatibility });
});

it("converts every list compatibility failure into one load error", () => {
  expect(
    compatibilityToEnvelopeError({
      status: "snapshotVersionMismatch",
      declaredVersion: 4,
      embeddedVersion: null,
    }),
  ).toEqual({
    code: "snapshotVersionMismatch",
    declaredVersion: 4,
    embeddedVersion: null,
  });
});
```

Add explicit tests for throwing getters, symbol keys, extra keys, missing keys, invalid domain summary strings, and mismatched embedded versions.

- [ ] **Step 2: Run the test and confirm failure**

Run: `bunx vitest run --project runtime tests/runtime/persistence/envelope.test.ts`

Expected: FAIL because inspection exports do not exist.

- [ ] **Step 3: Implement exception-safe closed inspection**

Use plain-object and exact-key helpers modeled after `src/runtime/backend/persistence.ts`. Catch every property/prototype/key access. Validate only envelope/header fields and embedded `snapshot.schemaVersion`; leave the snapshot body opaque.

```ts
export type InspectSaveEnvelopeResult =
  | {
      ok: true;
      envelope: InspectedSaveEnvelope;
      compatibility: { status: "candidate" };
    }
  | {
      ok: false;
      compatibility: Exclude<SaveCompatibility, { status: "candidate" }>;
    };
```

- [ ] **Step 4: Add exact Rust fixture parity**

Modify `crates/caelum-core/tests/persistence_fixture_export.rs` imports:

```rust
use caelum_core::{
    check_snapshot_schema, validate_snapshot, DerivedStateError, GameSnapshot, ModeError,
    PersistenceError, SnapshotField, SNAPSHOT_SCHEMA_VERSION,
};
```

Add this assertion at the start of `checked_in_snapshot_fixtures_preserve_the_persistence_contract`:

```rust
let valid = read_json("valid-paused.json");
assert_eq!(
    valid["schemaVersion"].as_u64(),
    Some(u64::from(SNAPSHOT_SCHEMA_VERSION)),
    "checked-in fixture schema must match the authoritative Rust constant",
);
```

In TypeScript, import `valid-paused.json` and assert its `schemaVersion` equals the TypeScript constant. Do not inspect Rust source text.

- [ ] **Step 5: Run parity and inspection tests**

```bash
cargo test -p caelum-core --test persistence_fixture_export
bunx vitest run --project runtime tests/runtime/persistence/envelope.test.ts
```

Expected: both commands exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/persistence/envelopeInspection.ts tests/runtime/persistence/envelope.test.ts crates/caelum-core/tests/persistence_fixture_export.rs
git commit -m "feat: inspect save envelope headers strictly"
```

---

### Task 3: Define SaveStore types and deterministic ordering

**Files:**
- Create: `src/persistence/saveStore.ts`
- Create: `tests/runtime/persistence/saveStore.test.ts`

**Interfaces:**
- Produces: `SaveStore`, `SaveStoreResult<T>`, `SaveStoreError`, all summaries, `AutosaveListing`, `sortCitySummaries`, `sortCheckpointSummaries`, `sortAutosaveSummaries`.

- [ ] **Step 1: Write failing ordering tests**

```ts
it("sorts cities by save time then stable ID and places unreadable times last", () => {
  expect(
    sortCitySummaries([
      citySummary({ cityId: "b", savedAt: "2026-08-01T10:00:00.000Z" }),
      citySummary({ cityId: "a", savedAt: "2026-08-01T10:00:00.000Z" }),
      citySummary({ cityId: "z", savedAt: null }),
    ]).map((value) => value.cityId),
  ).toEqual(["a", "b", "z"]);
});
```

Add equivalent checkpoint and autosave tests using the design’s ordering keys.

- [ ] **Step 2: Run the test and confirm failure**

Run: `bunx vitest run --project runtime tests/runtime/persistence/saveStore.test.ts`

Expected: FAIL because `saveStore.ts` does not exist.

- [ ] **Step 3: Implement the exact contract**

Define every operation and error code from the approved spec. `listAutosaves` returns `SaveStoreResult<AutosaveListing>` with `generationHighWaterMark: number | null`. Read operations return `UntrustedSaveValue`.

- [ ] **Step 4: Implement pure ordering helpers**

Use `Date.parse`; non-finite results sort after valid timestamps. Never rewrite summary values while sorting. Autosaves sort by descending generation and ascending ID.

- [ ] **Step 5: Run tests and typecheck**

```bash
bunx vitest run --project runtime tests/runtime/persistence/saveStore.test.ts
bun run check
```

Expected: both commands exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/persistence/saveStore.ts tests/runtime/persistence/saveStore.test.ts
git commit -m "feat: define SaveStore contract"
```

---

### Task 4: Implement in-memory working saves, rename, duplicate, and city deletion

**Files:**
- Create: `src/persistence/memorySaveStore.ts`
- Create: `tests/runtime/persistence/memorySaveStore.test.ts`

**Interfaces:**
- Produces: `createMemorySaveStore`, `createMemorySaveStoreFailureControls`.

- [ ] **Step 1: Add failing working-record tests**

```ts
it("preserves the previous working save when replacement aborts", async () => {
  const failures = createMemorySaveStoreFailureControls();
  const store = createMemorySaveStore({ failures });
  await expectOk(store.writeWorkingSave(makeEnvelope({ savedAt: "2026-08-01T10:00:00.000Z" })));
  failures.failNext("writeWorkingSave", "transactionAborted");

  await expectError(
    store.writeWorkingSave(makeEnvelope({ savedAt: "2026-08-01T11:00:00.000Z" })),
    "transactionAborted",
  );

  expect(await expectOk(store.readWorkingSave("city-1"))).toMatchObject({
    savedAt: "2026-08-01T10:00:00.000Z",
  });
});

it("rejects rename of an unsupported source without changing it", async () => {
  const store = createMemorySaveStore();
  store.seedRawWorking("city-1", { format: "caelum-save", envelopeVersion: 99 });
  await expectError(store.renameCity("city-1", "New Name"), "incompatibleRecord");
  expect(await expectOk(store.readWorkingSave("city-1"))).toMatchObject({
    envelopeVersion: 99,
  });
});
```

Add tests for detached read/write values, duplicate target conflict, corrupt duplicate source, rename preserving every non-name field, duplicate copying no generations/high-water, and city cascade delete.

- [ ] **Step 2: Run tests and confirm failure**

Run: `bunx vitest run --project runtime tests/runtime/persistence/memorySaveStore.test.ts`

Expected: FAIL because the adapter does not exist.

- [ ] **Step 3: Implement detached committed storage**

Clone all candidate values before mutating maps. Use `structuredClone`; convert clone failures into `serializationFailed`. Clone again on read/list. Keep working records, checkpoints, autosaves, and high-water in private maps.

- [ ] **Step 4: Implement source inspection and failure controls**

Rename and duplicate call `inspectSaveEnvelope` internally. Map unsupported variants to `incompatibleRecord`, other non-candidate variants to `corruptRecord`, and duplicate target collision to `conflict`. Failure controls fail one named operation before commit with a complete `SaveStoreError`.

- [ ] **Step 5: Run tests**

Run: `bunx vitest run --project runtime tests/runtime/persistence/memorySaveStore.test.ts`

Expected: PASS for working-record cases.

- [ ] **Step 6: Commit**

```bash
git add src/persistence/memorySaveStore.ts tests/runtime/persistence/memorySaveStore.test.ts
git commit -m "feat: implement in-memory working saves"
```

---

### Task 5: Implement checkpoints, autosaves, and persistent high-water

**Files:**
- Modify: `src/persistence/memorySaveStore.ts`
- Modify: `tests/runtime/persistence/memorySaveStore.test.ts`

**Interfaces:**
- Completes all generation methods in `SaveStore`.

- [ ] **Step 1: Add failing generation tests**

```ts
it("keeps autosave high-water after pruning", async () => {
  const store = createMemorySaveStore();
  await expectOk(store.writeWorkingSave(makeEnvelope()));
  await expectOk(store.writeAutosave({
    autosaveId: "auto-10",
    cityId: "city-1",
    generation: 10,
    envelope: makeEnvelope({ savedAt: "2026-08-01T10:10:00.000Z" }),
  }));
  await expectOk(store.deleteAutosave("city-1", "auto-10"));

  expect(await expectOk(store.listAutosaves("city-1"))).toEqual({
    items: [],
    generationHighWaterMark: 10,
  });

  await expectError(store.writeAutosave({
    autosaveId: "auto-reused",
    cityId: "city-1",
    generation: 10,
    envelope: makeEnvelope({ savedAt: "2026-08-01T10:11:00.000Z" }),
  }), "conflict");
});
```

Add tests for create-only checkpoint/autosave IDs, city mismatch, `createdAt === savedAt`, checkpoint rename timestamp preservation, failed write not advancing high-water, atomic record/high-water commit, city delete removing high-water, and duplicate starting with null high-water.

- [ ] **Step 2: Run tests and confirm failure**

Run: `bunx vitest run --project runtime tests/runtime/persistence/memorySaveStore.test.ts`

Expected: FAIL for generation methods.

- [ ] **Step 3: Implement checkpoint behavior**

Validate city match and ID uniqueness, clone envelope and metadata, derive `createdAt`, then commit. Rename changes checkpoint name only. Delete affects only the named checkpoint.

- [ ] **Step 4: Implement autosave atomicity**

Validate safe-integer generation, city match, ID uniqueness, and `generation > highWater`. Clone all candidate values first. Commit the record and new high-water only after validation/cloning succeeds. `deleteAutosave` removes only the record.

- [ ] **Step 5: Run tests**

Run: `bunx vitest run --project runtime tests/runtime/persistence/memorySaveStore.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/persistence/memorySaveStore.ts tests/runtime/persistence/memorySaveStore.test.ts
git commit -m "feat: add in-memory save generations"
```

---

### Task 6: Extract the reusable adapter contract and run final verification

**Files:**
- Create: `tests/runtime/persistence/saveStoreContract.ts`
- Modify: `tests/runtime/persistence/memorySaveStore.test.ts`
- Modify: `tests/runtime/persistence/envelope.test.ts`
- Modify: `tests/runtime/persistence/saveStore.test.ts`

**Interfaces:**
- Produces: `defineSaveStoreContract(name, createHarness)` for HPA-343/HPA-344.

- [ ] **Step 1: Define the harness without placeholder cases**

```ts
export interface SaveStoreContractHarness {
  store: SaveStore;
  reopen?: () => Promise<SaveStore>;
  failNext?: (
    operation: SaveStoreOperation,
    code: SaveStoreErrorCode,
  ) => void;
  seedRawWorking: (cityId: string, value: unknown) => void;
}

export function defineSaveStoreContract(
  name: string,
  createHarness: () => SaveStoreContractHarness | Promise<SaveStoreContractHarness>,
): void {
  describe(name, () => {
    it("atomically replaces working saves", async () => {
      const { store } = await createHarness();
      await expectOk(store.writeWorkingSave(makeEnvelope({ savedAt: "2026-08-01T10:00:00.000Z" })));
      await expectOk(store.writeWorkingSave(makeEnvelope({ savedAt: "2026-08-01T11:00:00.000Z" })));
      expect(await expectOk(store.readWorkingSave("city-1"))).toMatchObject({
        savedAt: "2026-08-01T11:00:00.000Z",
      });
    });

    it("persists autosave high-water independently of retained records", async () => {
      const { store } = await createHarness();
      await expectOk(store.writeWorkingSave(makeEnvelope()));
      await expectOk(store.writeAutosave({
        autosaveId: "auto-1",
        cityId: "city-1",
        generation: 1,
        envelope: makeEnvelope(),
      }));
      await expectOk(store.deleteAutosave("city-1", "auto-1"));
      expect(await expectOk(store.listAutosaves("city-1"))).toEqual({
        items: [],
        generationHighWaterMark: 1,
      });
    });
  });
}
```

Add named shared cases for all remaining normative behaviors already tested in memory-specific form: ordering, detachment, source inspection, create-only conflicts, timestamp/key corruption, failure atomicity, cascade delete, and duplicate isolation. Move each normative case into this suite; keep only failure-control internals in `memorySaveStore.test.ts`.

- [ ] **Step 2: Instantiate the contract for memory storage**

```ts
defineSaveStoreContract("MemorySaveStore", () => {
  const failures = createMemorySaveStoreFailureControls();
  const store = createMemorySaveStore({ failures });
  return {
    store,
    failNext: failures.failNext,
    seedRawWorking: store.seedRawWorking,
  };
});
```

- [ ] **Step 3: Run focused suites**

```bash
bunx vitest run --project runtime tests/runtime/persistence/envelope.test.ts
bunx vitest run --project runtime tests/runtime/persistence/saveStore.test.ts
bunx vitest run --project runtime tests/runtime/persistence/memorySaveStore.test.ts
```

Expected: all commands exit 0.

- [ ] **Step 4: Run full verification**

```bash
cargo test --workspace
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

Expected: no production clock/ID generation, Local Storage usage, or snapshot normalization in `src/persistence`.

- [ ] **Step 6: Commit**

```bash
git add src/persistence tests/runtime/persistence crates/caelum-core/tests/persistence_fixture_export.rs
git commit -m "test: define SaveStore adapter contract"
```

---

## HPA-498 Completion Gate

- [ ] Envelope summary uses shared domain types and non-null `SandboxTemplateId`.
- [ ] Rust/TypeScript schema parity is fixture-backed.
- [ ] Header inspection is exception-safe, exact, and gameplay-opaque.
- [ ] Rename/duplicate inspect sources internally with closed outcomes.
- [ ] Memory reads/writes are detached and failure-atomic.
- [ ] Checkpoint/autosave timestamps derive from envelope `savedAt`.
- [ ] Autosave high-water persists independently of retained records.
- [ ] Reusable adapter suite is ready for IndexedDB and Tauri.
- [ ] Every verification command exits 0 before HPA-498 is completed.
