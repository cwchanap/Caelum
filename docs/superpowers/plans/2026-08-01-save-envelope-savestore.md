# Save Envelope and SaveStore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Issue:** HPA-498  
**Design source:** HPA-342 draft design PR #21  
**Blocks:** HPA-343, HPA-344, HPA-499  
**Execution order:** Implement before HPA-499.

**Goal:** Implement HPA-498’s versioned save envelope, strict compatibility inspection, host-neutral `SaveStore`, deterministic in-memory adapter, and reusable adapter contract suite.

**Architecture:** `src/persistence/` owns host metadata and storage contracts while treating Rust gameplay snapshots as opaque values. Header inspection validates only the closed envelope vocabulary. The in-memory adapter is the executable reference for atomic replacement, create-only generation records, corruption visibility, deterministic ordering, and persistent autosave high-water state.

**Tech Stack:** TypeScript 5.8, Vitest runtime project, Bun, existing Rust persistence fixtures, `RustGameSnapshot`, `serde_json` fixture tests.

## Global Constraints

- Implement `docs/superpowers/specs/2026-07-31-save-envelope-store-runtime-persistence-design.md` without migration or repair behavior.
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
- `tests/runtime/persistence/storeTestUtils.ts`
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

## Test Utility Contract

`tests/runtime/persistence/fixtures.ts` exports:

```ts
export function makeRustSnapshot(
  overrides?: Partial<RustGameSnapshot>,
): RustGameSnapshot;
export function makeEnvelope(
  overrides?: Partial<WritableSaveEnvelope>,
): WritableSaveEnvelope;
export function makeCitySummary(
  overrides?: Partial<CitySummary>,
): CitySummary;
export function makeCheckpointSummary(
  overrides?: Partial<CheckpointSummary>,
): CheckpointSummary;
export function makeAutosaveSummary(
  overrides?: Partial<AutosaveSummary>,
): AutosaveSummary;
```

`tests/runtime/persistence/storeTestUtils.ts` exports:

```ts
export async function expectOk<T>(
  result: Promise<SaveStoreResult<T>> | SaveStoreResult<T>,
): Promise<T>;

export async function expectError(
  result: Promise<SaveStoreResult<unknown>> | SaveStoreResult<unknown>,
  code: SaveStoreErrorCode,
): Promise<SaveStoreError>;
```

`expectOk` throws the returned diagnostic when `ok === false`; `expectError` asserts `ok === false` and exact code. All later test snippets use these helpers.

---

### Task 1: Define envelope types, builder, and deterministic snapshot fixtures

**Files:**
- Create: `src/persistence/envelope.ts`
- Create: `tests/runtime/persistence/fixtures.ts`
- Create: `tests/runtime/persistence/envelope.test.ts`

**Interfaces:**
- Produces: `SaveEnvelopeSummary`, `SaveEnvelope<T>`, `WritableSaveEnvelope`, `InspectedSaveEnvelope`, `UntrustedSaveValue`, `SUPPORTED_SNAPSHOT_SCHEMA_VERSIONS`, `buildSaveEnvelope`, `makeRustSnapshot`, `makeEnvelope`.

- [ ] **Step 1: Write the failing builder test**

```ts
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
```

- [ ] **Step 2: Run the test and confirm failure**

Run: `bunx vitest run --project runtime tests/runtime/persistence/envelope.test.ts`

Expected: FAIL because `envelope.ts` does not exist.

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

Implement `buildSaveEnvelope` by deriving all summary values from `snapshot.rules` and using the shared schema constant.

- [ ] **Step 4: Implement `makeRustSnapshot` and `makeEnvelope`**

Use `tests/fixtures/rustSnapshot.ts::createRustSnapshot` rather than importing JSON directly:

```ts
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

### Task 2: Implement strict header inspection and schema parity

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
])("classifies invalid headers", (value, compatibility) => {
  expect(inspectSaveEnvelope(value)).toEqual({ ok: false, compatibility });
});
```

Add explicit tests for throwing getters, extra/symbol keys, missing fields, invalid summary strings, embedded mismatch, and exhaustive compatibility-to-error mapping.

- [ ] **Step 2: Run the test and confirm failure**

Run: `bunx vitest run --project runtime tests/runtime/persistence/envelope.test.ts`

Expected: FAIL because inspection exports do not exist.

- [ ] **Step 3: Implement exception-safe exact inspection**

Use plain-object and exact-key helpers modeled after `src/runtime/backend/persistence.ts`. Catch every prototype/key/property access. Validate envelope/header fields plus `snapshot.schemaVersion` only; retain the body as `unknown`.

- [ ] **Step 4: Add exact Rust fixture parity**

Import `SNAPSHOT_SCHEMA_VERSION` in `crates/caelum-core/tests/persistence_fixture_export.rs` and add:

```rust
let valid = read_json("valid-paused.json");
assert_eq!(
    valid["schemaVersion"].as_u64(),
    Some(u64::from(SNAPSHOT_SCHEMA_VERSION)),
    "checked-in fixture schema must match Rust",
);
```

The TypeScript test loads the same fixture and compares it to the TypeScript constant. It must not parse Rust source.

- [ ] **Step 5: Run tests**

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

### Task 3: Define SaveStore, ordering helpers, and shared test utilities

**Files:**
- Create: `src/persistence/saveStore.ts`
- Create: `tests/runtime/persistence/saveStore.test.ts`
- Create: `tests/runtime/persistence/storeTestUtils.ts`
- Modify: `tests/runtime/persistence/fixtures.ts`

**Interfaces:**
- Produces all `SaveStore` contracts, sorting functions, summary builders, `expectOk`, and `expectError`.

- [ ] **Step 1: Add failing ordering tests**

```ts
it("sorts cities by save time then ID and places invalid times last", () => {
  expect(
    sortCitySummaries([
      makeCitySummary({ cityId: "b", savedAt: "2026-08-01T10:00:00.000Z" }),
      makeCitySummary({ cityId: "a", savedAt: "2026-08-01T10:00:00.000Z" }),
      makeCitySummary({ cityId: "z", savedAt: null }),
    ]).map((value) => value.cityId),
  ).toEqual(["a", "b", "z"]);
});
```

Add equivalent checkpoint and autosave ordering tests.

- [ ] **Step 2: Run the test and confirm failure**

Run: `bunx vitest run --project runtime tests/runtime/persistence/saveStore.test.ts`

Expected: FAIL because the contract module does not exist.

- [ ] **Step 3: Implement the exact SaveStore contract**

Define every operation/error from the spec. `listAutosaves` returns `SaveStoreResult<AutosaveListing>`. Read methods return `UntrustedSaveValue`.

- [ ] **Step 4: Implement test utilities exactly**

```ts
export async function expectOk<T>(
  result: Promise<SaveStoreResult<T>> | SaveStoreResult<T>,
): Promise<T> {
  const resolved = await result;
  if (!resolved.ok) throw new Error(resolved.error.diagnostic);
  return resolved.value;
}

export async function expectError(
  result: Promise<SaveStoreResult<unknown>> | SaveStoreResult<unknown>,
  code: SaveStoreErrorCode,
): Promise<SaveStoreError> {
  const resolved = await result;
  expect(resolved.ok).toBe(false);
  if (resolved.ok) throw new Error(`Expected ${code}`);
  expect(resolved.error.code).toBe(code);
  return resolved.error;
}
```

Implement deterministic summary builders in `fixtures.ts` using candidate compatibility defaults.

- [ ] **Step 5: Run tests and typecheck**

```bash
bunx vitest run --project runtime tests/runtime/persistence/saveStore.test.ts
bun run check
```

Expected: both commands exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/persistence/saveStore.ts tests/runtime/persistence
git commit -m "feat: define SaveStore contract"
```

---

### Task 4: Implement in-memory working saves and metadata operations

**Files:**
- Create: `src/persistence/memorySaveStore.ts`
- Create: `tests/runtime/persistence/memorySaveStore.test.ts`

**Interfaces:**
- Produces:

```ts
export interface MemorySaveStore extends SaveStore {
  seedRawWorking(cityId: string, value: unknown): void;
}

export interface MemorySaveStoreFailureControls {
  failNext(operation: SaveStoreOperation, code: SaveStoreErrorCode): void;
}

export function createMemorySaveStore(options?: {
  failures?: MemorySaveStoreFailureControls;
}): MemorySaveStore;
export function createMemorySaveStoreFailureControls(): MemorySaveStoreFailureControls;
```

- [ ] **Step 1: Add failing working-record tests**

```ts
it("preserves the previous working save after an aborted replacement", async () => {
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
```

Add tests for detached values, rename/duplicate source inspection, target conflict, rename preserving non-name fields, duplicate isolation, and city cascade deletion.

- [ ] **Step 2: Run tests and confirm failure**

Run: `bunx vitest run --project runtime tests/runtime/persistence/memorySaveStore.test.ts`

Expected: FAIL because the adapter does not exist.

- [ ] **Step 3: Implement detached committed maps**

Clone all candidates before mutation and every returned value. Convert clone failures into `serializationFailed`. Keep working records, checkpoints, autosaves, and high-water in private maps.

- [ ] **Step 4: Implement rename/duplicate inspection and failure injection**

Use `inspectSaveEnvelope`. Unsupported variants become `incompatibleRecord`; corrupt/mismatch variants become `corruptRecord`; duplicate target collision becomes `conflict`. Failure controls fail before commit and are implemented with arrow functions so test harness references remain bound.

- [ ] **Step 5: Run tests and commit**

```bash
bunx vitest run --project runtime tests/runtime/persistence/memorySaveStore.test.ts
git add src/persistence/memorySaveStore.ts tests/runtime/persistence/memorySaveStore.test.ts
git commit -m "feat: implement in-memory working saves"
```

---

### Task 5: Implement checkpoints, autosaves, and persistent high-water

**Files:**
- Modify: `src/persistence/memorySaveStore.ts`
- Modify: `tests/runtime/persistence/memorySaveStore.test.ts`

- [ ] **Step 1: Add failing generation tests**

```ts
it("keeps high-water after pruning and rejects reuse", async () => {
  const store = createMemorySaveStore();
  await expectOk(store.writeWorkingSave(makeEnvelope()));
  await expectOk(store.writeAutosave({
    autosaveId: "auto-10",
    cityId: "city-1",
    generation: 10,
    envelope: makeEnvelope(),
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
    envelope: makeEnvelope(),
  }), "conflict");
});
```

Add tests for create-only IDs, city mismatch, derived timestamps, checkpoint rename preservation, failed write high-water atomicity, city-delete cleanup, and duplicate null high-water.

- [ ] **Step 2: Run tests and confirm failure**

Run: `bunx vitest run --project runtime tests/runtime/persistence/memorySaveStore.test.ts`

Expected: FAIL for generation methods.

- [ ] **Step 3: Implement checkpoint behavior**

Validate city/ID, clone inputs, derive `createdAt`, then commit. Rename changes checkpoint name only; delete affects only the named record.

- [ ] **Step 4: Implement autosave atomicity**

Validate safe-integer generation, city match, ID uniqueness, and `generation > highWater`. Clone all values first; then commit record and high-water together. `deleteAutosave` never lowers high-water.

- [ ] **Step 5: Run tests and commit**

```bash
bunx vitest run --project runtime tests/runtime/persistence/memorySaveStore.test.ts
git add src/persistence/memorySaveStore.ts tests/runtime/persistence/memorySaveStore.test.ts
git commit -m "feat: add in-memory save generations"
```

---

### Task 6: Extract the reusable adapter contract and verify

**Files:**
- Create: `tests/runtime/persistence/saveStoreContract.ts`
- Modify: `tests/runtime/persistence/memorySaveStore.test.ts`

**Interfaces:**
- Produces `defineSaveStoreContract(name, createHarness)`.

- [ ] **Step 1: Define the concrete harness**

```ts
export interface SaveStoreContractHarness {
  store: SaveStore;
  reopen?: () => Promise<SaveStore>;
  failNext?: (
    operation: SaveStoreOperation,
    code: SaveStoreErrorCode,
  ) => void;
  seedRawWorking(cityId: string, value: unknown): void;
}
```

Implement named shared cases for ordering, detachment, replacement atomicity, source inspection, create-only conflicts, key/timestamp corruption, high-water behavior, cascade deletion, and duplicate isolation. Each case uses the Test Utility Contract helpers.

- [ ] **Step 2: Instantiate the memory harness**

```ts
defineSaveStoreContract("MemorySaveStore", () => {
  const failures = createMemorySaveStoreFailureControls();
  const store = createMemorySaveStore({ failures });
  return {
    store,
    failNext: (operation, code) => failures.failNext(operation, code),
    seedRawWorking: (cityId, value) => store.seedRawWorking(cityId, value),
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

Expected: no production clock/ID generation, Local Storage use, or snapshot normalization.

- [ ] **Step 6: Commit**

```bash
git add src/persistence tests/runtime/persistence crates/caelum-core/tests/persistence_fixture_export.rs
git commit -m "test: define SaveStore adapter contract"
```

---

## HPA-498 Completion Gate

- [ ] Envelope uses shared domain types and fixture-backed schema parity.
- [ ] Header inspection is exception-safe, exact, and gameplay-opaque.
- [ ] Rename/duplicate inspect sources internally with closed outcomes.
- [ ] Memory reads/writes are detached and failure-atomic.
- [ ] Generation timestamps derive from envelope `savedAt`.
- [ ] Autosave high-water persists independently of retained records.
- [ ] Reusable adapter suite is ready for IndexedDB and Tauri.
- [ ] Every verification command exits 0 before completion.
