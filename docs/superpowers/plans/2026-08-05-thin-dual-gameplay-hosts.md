# HPA-547 Thin Dual Gameplay Hosts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep native Tauri and browser/WASM gameplay paths while deleting public host-session ownership, exhaustive persistence parity, and unused dispatch wire impact around the shared `caelum-core` engine.

**Architecture:** `caelum-core` remains the only gameplay authority and performs direct persistence normalization plus candidate-first engine construction. `caelum-wasm` and the Tauri command host become thin serialization/state wrappers behind a minimal TypeScript `GameBackend`; Tauri retains one private epoch acquired inside `createTauriBackend()`. The existing save-store and persistence coordinator remain except for the concrete backend-error type and call-site changes required by the smaller host contract and pure sandbox candidates.

**Tech Stack:** Rust 2021, Serde/serde_json, wasm-bindgen, serde-wasm-bindgen, Tauri 2, TypeScript 5.8, Svelte 5, Bun, Vitest, Playwright.

**Companion design:** `docs/superpowers/specs/2026-08-05-thin-dual-gameplay-hosts-design.md` is the normative contract. Amend and re-review it before introducing a public method, error category, compatibility path, validation responsibility, or New City recovery behavior not defined there.

## Global Constraints

- Keep Tauri/native Rust as the intended desktop release host.
- Keep WASM/browser as the fast Vite, Playwright, and demo host.
- Keep all gameplay rules and engine construction in `caelum-core`.
- Implement the host contract as one atomic cut; do not introduce temporary old/new methods or aliases.
- Remove public `runtimeIdentity`, `RuntimeSession`, `beginRuntime`, and `validateSnapshot`.
- Keep the Tauri epoch private to `createTauriBackend()` and native commands.
- Expose only `unsupportedSchema`, `invalidSnapshot`, and `hostFailure` to frontend snapshot consumers.
- Include `operation` on `SnapshotError`; UI still branches only on `code`.
- Keep sandbox form errors separate from snapshot errors.
- Reuse the existing core `create_sandbox_snapshot` function.
- Build sandbox snapshots without mutating the active engine.
- Restore through complete candidate construction before assignment.
- Follow the design’s validator retain/normalize/delete matrix.
- Keep private apply data needed by gameplay; remove only public `DispatchResult.context`.
- Keep preview impact unchanged.
- Replace `PersistenceCoordinatorBackendError` concretely with `SnapshotError | SandboxHostError`.
- Do not implement the HPA-548 six-operation city store in this PR.
- Do not implement the HPA-543 active-city/busy/dirty runtime replacement in this PR.
- Remove obsolete tests and fixtures with the behavior they specify.
- Require material net deletion in production and test code.

---

## Baseline Gate

- [ ] **Step 1: Confirm the implementation branch starts from the approved documentation branch**

```sh
git fetch origin
git status --short --branch
git merge-base --is-ancestor origin/main HEAD
test -f docs/superpowers/specs/2026-08-05-thin-dual-gameplay-hosts-design.md
test -f docs/superpowers/plans/2026-08-05-thin-dual-gameplay-hosts.md
```

Expected: clean branch, `origin/main` is an ancestor, and both HPA-547 documents exist.

- [ ] **Step 2: Record the public host/session surface**

```sh
rg -n 'runtimeIdentity|RuntimeSession|beginRuntime|validateSnapshot|BackendOwnership' \
  src src-tauri crates tests
```

Expected: matches in backend types/adapters, `backendOwnership.ts`, runtime construction/disposal, and ownership/session tests.

- [ ] **Step 3: Record the detailed persistence/parity surface**

```sh
rg -n 'PersistenceBridgeError|PersistenceOperationError|PreparedEngineRestore|SaveSnapshotCapture' \
  crates src src-tauri tests scripts
rg -n 'PERSISTENCE_VALIDATION_CODES|PERSISTENCE_SNAPSHOT_FIELDS|PERSISTENCE_REASON_KINDS' \
  src tests
```

Expected: matches in core bridge/error modules, both hosts, TypeScript persistence guards, fixtures, and parity tests.

- [ ] **Step 4: Classify dispatch impact before editing**

```sh
rg -n 'DispatchContext|\.context|affected_route_ids|affectedRouteIds' \
  crates/caelum-core src src-tauri tests
```

Create a scratch checklist with three buckets:

```text
PUBLIC WIRE
- DispatchResult.context definition/constructors
- TypeScript DispatchResult.context
- shared.ts dispatch normalization
- tests asserting applied-result context only

PRIVATE APPLY
- dispatch_context
- NetworkCandidate.context
- commit_result_for_tiles / commit_network_mutation
- changed/skipped tile normalization
- route lifecycle recomputation inputs

PREVIEW
- RoadMutationPreviewResponse impact
- RoutePreviewResponse warnings/rejection context
- preview tests/UI consumers
```

Expected: every match is assigned before deletion. Only the public-wire bucket must disappear.

- [ ] **Step 5: Run the focused pre-change baseline**

```sh
cargo test -p caelum-core --test persistence_snapshot
cargo test -p caelum-core --test persistence_atomicity
cargo test -p caelum --lib
bunx vitest run --project runtime \
  tests/runtime/backendContract.test.ts \
  tests/runtime/persistenceContract.test.ts \
  tests/runtime/wasmBackend.test.ts \
  tests/runtime/tauriBackend.test.ts \
  tests/runtime/gameRuntime.test.ts
```

Expected: all listed targets pass before edits. Record unrelated failures; do not weaken assertions.

---

## File Map

### Create

- `crates/caelum-core/tests/persistence_construction.rs`
- Optional responsibility split: `src-tauri/src/game_host.rs`

### Modify

- `crates/caelum-core/src/engine.rs`
- `crates/caelum-core/src/intent.rs`
- `crates/caelum-core/src/lib.rs`
- `crates/caelum-core/src/persistence/mod.rs`
- `crates/caelum-core/src/persistence/map.rs`
- `crates/caelum-core/src/persistence/entities.rs`
- `crates/caelum-core/src/persistence/trips.rs`
- `crates/caelum-core/src/sandbox.rs` only if a small export adjustment is required
- `crates/caelum-wasm/src/lib.rs`
- `crates/caelum-wasm/Cargo.toml`
- `src-tauri/src/lib.rs`
- `src/runtime/backend/types.ts`
- `src/runtime/backend/persistenceContract.ts`
- `src/runtime/backend/persistence.ts`
- `src/runtime/backend/shared.ts`
- `src/runtime/backend/index.ts`
- `src/runtime/backend/wasmBackend.ts`
- `src/runtime/backend/tauriBackend.ts`
- `src/runtime/persistenceCoordinator.ts`
- `src/runtime/createGameRuntime.ts`
- `tests/runtime/backendContract.test.ts`
- `tests/runtime/persistenceContract.test.ts`
- `tests/runtime/wasmBackend.test.ts`
- `tests/runtime/wasmArtifact.smoke.test.ts`
- `tests/runtime/tauriBackend.test.ts`
- `tests/runtime/gameRuntime.test.ts`
- `tests/runtime/constructionCleanup.test.ts`
- `tests/runtime/postDisposalBackendFailure.test.ts`
- `tests/fixtures/rustSnapshot.ts` only where the removed dispatch field changes fixture shape
- `package.json`
- `codecov.yml`
- `vite.config.ts`
- `docs/architecture.md`
- `CLAUDE.md`

### Delete

- `crates/caelum-core/src/persistence/error.rs`
- `crates/caelum-core/src/persistence_bridge.rs`
- `src/runtime/backendOwnership.ts`
- `tests/runtime/backendOwnership.test.ts`
- `scripts/benchmark-persistence-wasm.ts`
- `crates/caelum-core/tests/persistence_error_wire.rs`
- `crates/caelum-core/tests/persistence_corruption.rs`
- `crates/caelum-core/tests/persistence_map_coverage.rs`
- `crates/caelum-core/tests/persistence_map_branches.rs`
- `crates/caelum-core/tests/persistence_entities_coverage.rs`
- `crates/caelum-core/tests/persistence_entities_validation.rs`
- `crates/caelum-core/tests/persistence_trips_coverage.rs`
- `crates/caelum-core/tests/persistence_trips_branches.rs`
- `crates/caelum-core/tests/persistence_trips_validation.rs`
- `crates/caelum-core/tests/persistence_routing_validation.rs`
- `crates/caelum-core/tests/persistence_map_validation.rs`
- `crates/caelum-core/tests/persistence_engine_validation.rs`
- persistence JSON fixtures under `tests/fixtures/persistence/` after retained tests use inline/programmatic candidates
- implemented historical specs/plans that prescribe the removed exhaustive validator/parity contract:
  - `docs/superpowers/specs/2026-07-27-rust-persistence-validation-design.md`
  - `docs/superpowers/plans/2026-07-27-rust-persistence-validation.md`
  - `docs/superpowers/specs/2026-07-30-persistence-host-parity-design.md`
  - `docs/superpowers/plans/2026-07-30-persistence-host-parity.md`

### Reduce or replace

- `crates/caelum-core/tests/persistence_snapshot.rs`
- `crates/caelum-core/tests/persistence_atomicity.rs`
- `crates/caelum-core/tests/persistence_determinism.rs`
- `crates/caelum-core/tests/common/persistence_fixtures.rs`
- `tests/runtime/persistenceContract.test.ts`
- `tests/runtime/constructionCleanup.test.ts`

Do not delete `tests/fixtures/rustSnapshot.ts` or shared fixture helpers merely because HPA-341 touched them; retain any data still used by non-persistence runtime/UI tests.

---

# Task 1: Atomic Host Contract Cut

This task is one review/commit unit. Steps deliberately cross core, TypeScript, WASM, Tauri, and runtime because no intermediate public contract can remain repository-green without forbidden compatibility aliases.

During Steps 1–12:

- focused targets may be run for feedback;
- the full workspace may be red while callers are being converted;
- do not commit;
- do not add old/new method aliases;
- do not claim repository-wide green until Step 13.

**Files:** all production and focused test files in the Create/Modify lists above, excluding cleanup-only fixtures/docs handled by Task 2.

**Produces:**

```ts
export type SnapshotOperation = "snapshotForSave" | "restoreSnapshot";

export type SnapshotErrorCode =
  | "unsupportedSchema"
  | "invalidSnapshot"
  | "hostFailure";

export interface SnapshotError {
  operation: SnapshotOperation;
  code: SnapshotErrorCode;
  diagnostic?: string;
}

export type SnapshotResult =
  | { ok: true; snapshot: RustGameSnapshot }
  | { ok: false; error: SnapshotError };

export interface SandboxHostError {
  operation: "buildSandboxSnapshot";
  code: "hostFailure";
  diagnostic?: string;
}

export type PersistenceCoordinatorBackendError =
  | SnapshotError
  | SandboxHostError;
```

```ts
export interface GameBackend {
  snapshot(): Promise<RustGameSnapshot>;
  snapshotForSave(): Promise<SnapshotResult>;
  buildSandboxSnapshot(
    request: SandboxCreationRequest,
  ): Promise<SandboxCreationResult>;
  restoreSnapshot(snapshot: unknown): Promise<SnapshotResult>;
  dispatch(intent: GameIntent): Promise<DispatchResult>;
  tick(deltaSeconds: number): Promise<DispatchResult>;
  reset(): Promise<SandboxResetResult>;
  previewRoute(request: RoutePreviewRequest): Promise<RoutePreviewResponse>;
  previewRoadMutation(
    request: RoadMutationPreviewRequest,
  ): Promise<RoadMutationPreviewResponse>;
}
```

```rust
pub enum SnapshotLoadError {
    UnsupportedSchema { expected: u16, actual: u16 },
    InvalidSnapshot(String),
}
```

## 1A. Write final-contract tests first

- [ ] **Step 1: Add the focused core construction test file**

Create `crates/caelum-core/tests/persistence_construction.rs` with these exact behaviors:

```rust
#[test]
fn unsupported_schema_is_rejected_before_activation() { /* schema mismatch */ }

#[test]
fn wrong_tile_count_is_invalid_snapshot() { /* remove one map tile */ }

#[test]
fn duplicate_entity_id_is_invalid_snapshot() { /* duplicate a stop/building id */ }

#[test]
fn missing_required_reference_is_invalid_snapshot() { /* route references missing node */ }

#[test]
fn topology_compile_failure_is_invalid_snapshot() { /* impossible road connectivity */ }

#[test]
fn failed_restore_preserves_active_engine() { /* compare snapshot before/after */ }

#[test]
fn save_snapshot_is_paused_without_mutating_live_engine() { /* live pause unchanged */ }

#[test]
fn engine_minted_save_round_trips_deterministically() { /* save -> from_snapshot -> save */ }
```

Use programmatically mutated `GameEngine::new().snapshot()` values. Do not use the giant persistence JSON fixture catalogue.

- [ ] **Step 2: Run the new core tests and confirm they fail against the old API/behavior**

```sh
cargo test -p caelum-core --test persistence_construction
```

Expected: compile/test failures because `SnapshotLoadError` and the simplified save/restore behavior do not exist yet.

- [ ] **Step 3: Rewrite the TypeScript backend contract tests for the final method set**

In `tests/runtime/backendContract.test.ts`, assert:

```ts
const methods = [
  "snapshot",
  "snapshotForSave",
  "buildSandboxSnapshot",
  "restoreSnapshot",
  "dispatch",
  "tick",
  "reset",
  "previewRoute",
  "previewRoadMutation",
] as const;
```

Also assert the backend has no own/public:

```ts
expect("runtimeIdentity" in backend).toBe(false);
expect("beginRuntime" in backend).toBe(false);
expect("validateSnapshot" in backend).toBe(false);
expect("createSandbox" in backend).toBe(false);
```

- [ ] **Step 4: Replace persistence taxonomy tests with three-code mapping tests**

Rewrite `tests/runtime/persistenceContract.test.ts` to cover only:

```ts
it("maps schema mismatch to unsupportedSchema", () => { /* ... */ });
it("maps decode/construction rejection to invalidSnapshot", () => { /* ... */ });
it("maps unexpected adapter failure to hostFailure", () => { /* ... */ });
it("preserves operation without requiring equal diagnostics", () => { /* ... */ });
```

Delete tests for exact keys, prototypes, sparse arrays, every field/reason enum, and exact native/WASM diagnostic parity.

- [ ] **Step 5: Add pure sandbox and failed-restore host tests**

Update `tests/runtime/wasmBackend.test.ts` and `tests/runtime/tauriBackend.test.ts` with the same behavioral cases:

```ts
it("builds a sandbox snapshot without changing the active engine", async () => {
  const before = await backend.snapshot();
  const built = await backend.buildSandboxSnapshot(validRequest);
  expect(built.ok).toBe(true);
  expect(await backend.snapshot()).toEqual(before);
});

it("preserves active gameplay when restore rejects the candidate", async () => {
  const before = await backend.snapshot();
  const restored = await backend.restoreSnapshot(invalidCandidate);
  expect(restored).toMatchObject({
    ok: false,
    error: { operation: "restoreSnapshot", code: "invalidSnapshot" },
  });
  expect(await backend.snapshot()).toEqual(before);
});
```

For Tauri, retain one stale-epoch native test. Do not test a public epoch method.

- [ ] **Step 6: Add New City post-condition tests**

In `tests/runtime/gameRuntime.test.ts`, add or rewrite exact cases:

```ts
it("leaves backend, store, and identity unchanged when sandbox build rejects", async () => { /* ... */ });

it("leaves backend and active identity unchanged on definite persist failure", async () => { /* ... */ });

it("keeps the stored city but preserves current gameplay when activation restore fails", async () => { /* ... */ });

it("writes nothing when disposed after pure build and before persistence", async () => { /* ... */ });

it("publishes candidate snapshot and city identity only after restore succeeds", async () => { /* ... */ });
```

Mocks must implement the final `GameBackend`; do not retain `createSandbox`, `beginRuntime`, or `validateSnapshot`.

- [ ] **Step 7: Run the final-contract tests and confirm they fail**

```sh
bunx vitest run --project runtime \
  tests/runtime/backendContract.test.ts \
  tests/runtime/persistenceContract.test.ts \
  tests/runtime/wasmBackend.test.ts \
  tests/runtime/tauriBackend.test.ts \
  tests/runtime/gameRuntime.test.ts
```

Expected: failures from missing final methods/types and old mutating New City behavior.

## 1B. Simplify core save/restore and validation

- [ ] **Step 8: Collapse the public Rust persistence error**

Replace the exported detailed tree with:

```rust
#[derive(Debug, thiserror::Error)]
pub enum SnapshotLoadError {
    #[error("unsupported snapshot schema: expected {expected}, got {actual}")]
    UnsupportedSchema { expected: u16, actual: u16 },

    #[error("invalid snapshot: {0}")]
    InvalidSnapshot(String),
}
```

If `thiserror` is not already a direct core dependency, implement `Display`/`Error` manually rather than adding a dependency solely for two variants.

Keep `SnapshotSchemaProbe` and schema probing before full decode.

- [ ] **Step 9: Implement direct save normalization**

Change `GameEngine::snapshot_for_save` to:

```rust
pub fn snapshot_for_save(&self) -> GameSnapshot {
    let mut snapshot = self.snapshot();
    snapshot.paused = true;
    snapshot.day = clock::day_index(snapshot.time);
    snapshot.clock_minutes = clock::clock_minutes(snapshot.time);
    snapshot
}
```

Before calculating clock fields on import, retain finite/range validation for `time`.

Delete `SaveSnapshotCapture` and active-engine whole-validator calls.

- [ ] **Step 10: Implement candidate preparation according to the matrix**

Refactor `persistence/mod.rs`, `map.rs`, `entities.rs`, and `trips.rs` so candidate preparation performs this sequence:

```rust
fn prepare_snapshot(
    mut snapshot: GameSnapshot,
) -> Result<PreparedSnapshot, SnapshotLoadError> {
    check_schema_version(snapshot.schema_version)?;
    validate_time_for_clock_derivation(snapshot.time)?;
    snapshot.paused = true;
    snapshot.day = clock::day_index(snapshot.time);
    snapshot.clock_minutes = clock::clock_minutes(snapshot.time);

    let topology = validate_map_and_compile(&mut snapshot)?;
    let indexes = validate_entity_indexes(&mut snapshot, &topology)?;
    validate_trip_access_safety(&mut snapshot, &indexes)?;

    Ok(PreparedSnapshot {
        snapshot,
        road_topology: topology,
    })
}
```

The helper names may follow the existing module style, but the actions must match the design matrix:

- retain schema, map dimensions/count, bounds, unique keys, required refs, safe indexes, finite values used by tick, and topology compile;
- normalize clock/paused and only cheap existing deterministic orderings required by runtime behavior;
- delete canonical ID formatting, exact ordering forensics, route oracle equality, exact trip-state/position derivations, metrics/outcome/objective catalogues.

Do not introduce a warning list, repair registry, or generic normalization framework.

- [ ] **Step 11: Remove prepared restore tokens**

Implement:

```rust
pub fn from_snapshot(
    snapshot: GameSnapshot,
) -> Result<Self, SnapshotLoadError> {
    let prepared = prepare_snapshot(snapshot)?;
    Ok(Self {
        snapshot: prepared.snapshot,
        road_topology: prepared.road_topology,
    })
}

pub fn restore_snapshot(
    &mut self,
    snapshot: GameSnapshot,
) -> Result<GameSnapshot, SnapshotLoadError> {
    let candidate = Self::from_snapshot(snapshot)?;
    let restored = candidate.snapshot();
    *self = candidate;
    Ok(restored)
}
```

Delete `PreparedEngineRestore`.

- [ ] **Step 12: Run focused core tests**

```sh
cargo test -p caelum-core --test persistence_construction
cargo test -p caelum-core --test persistence_snapshot
cargo test -p caelum-core --test persistence_determinism
```

Expected: focused core targets pass. The whole workspace may still fail because hosts have not been converted; do not add compatibility APIs.

## 1C. Cut the TypeScript contract and coordinator seam

- [ ] **Step 13: Replace backend persistence types**

In `src/runtime/backend/types.ts`, define exactly the `SnapshotOperation`, `SnapshotErrorCode`, `SnapshotError`, `SnapshotResult`, `SandboxHostError`, and final `GameBackend` interfaces from the design.

Remove:

- `RuntimeIdentity`;
- `RuntimeSession`;
- `runtimeIdentity`;
- `beginRuntime`;
- `validateSnapshot`;
- `PersistenceSnapshotRequest`;
- `PersistenceValidationResult`;
- public `DispatchContext`;
- `DispatchResult.context`.

- [ ] **Step 14: Collapse persistence mapping helpers**

Reduce `src/runtime/backend/persistenceContract.ts` to the small types only if `types.ts` would become unwieldy; otherwise delete it and export the types from `types.ts`.

Reduce `src/runtime/backend/persistence.ts` to small functions equivalent to:

```ts
export function snapshotError(
  operation: SnapshotOperation,
  code: SnapshotErrorCode,
  error?: unknown,
): SnapshotError {
  return {
    operation,
    code,
    diagnostic:
      error instanceof Error ? error.message : error === undefined ? undefined : String(error),
  };
}
```

Keep only schema-code recognition needed to distinguish `unsupportedSchema` from `invalidSnapshot`. Do not validate exact error object keys.

- [ ] **Step 15: Replace the coordinator backend error type explicitly**

In `src/runtime/persistenceCoordinator.ts`:

```ts
import type {
  SandboxCreationError,
  SandboxCreationRequest,
  SandboxHostError,
  SnapshotError,
} from "./backend";

export type PersistenceCoordinatorBackendError =
  | SnapshotError
  | SandboxHostError;
```

Delete `PersistenceOperationError` imports and the old `createSandbox` host-error shape.

## 1D. Thin both hosts against the final interface

- [ ] **Step 16: Reuse core pure sandbox construction in WASM**

In `crates/caelum-wasm/src/lib.rs`, expose a thin bridge backed by `create_sandbox_snapshot`:

```rust
#[wasm_bindgen]
pub fn build_sandbox_snapshot(request: JsValue) -> Result<JsValue, JsValue> {
    let request: SandboxCreationRequest =
        serde_wasm_bindgen::from_value(request).map_err(to_js_error)?;
    let snapshot = create_sandbox_snapshot(request)
        .map_err(|error| serde_wasm_bindgen::to_value(&error).unwrap_or_else(to_js_error))?;
    serde_wasm_bindgen::to_value(&snapshot).map_err(to_js_error)
}
```

Keep `GameEngine::from_sandbox_request` only for live-engine construction elsewhere.

Delete WASM `validate_snapshot`, bridge-error serialization, prepared-token encoding helpers, and exact encode-failure tests.

- [ ] **Step 17: Implement the final WASM TypeScript adapter**

In `src/runtime/backend/wasmBackend.ts`:

- remove `beginRuntime`;
- remove `validateSnapshot`;
- rename/replace `createSandbox` with pure `buildSandboxSnapshot`;
- map save/restore failures to `SnapshotError`;
- preserve active engine on failed restore;
- keep Option/null normalization for snapshots/previews currently consumed by the runtime.

- [ ] **Step 18: Make the Tauri epoch private**

In `src/runtime/backend/tauriBackend.ts`, acquire the epoch before returning:

```ts
export async function createTauriBackend(): Promise<GameBackend> {
  const { runtimeEpoch } = await invoke<{
    runtimeEpoch: number;
    snapshot: RustGameSnapshot;
  }>("game_begin_runtime");

  return {
    async snapshot() {
      return invoke<RustGameSnapshot>("game_snapshot");
    },
    // mutating calls close over runtimeEpoch
  };
}
```

Do not return the begin-runtime snapshot through a public session API. The extra later `snapshot()` IPC is accepted; do not optimize it in this issue.

- [ ] **Step 19: Replace Tauri sandbox and validation commands**

In the native host:

```rust
#[tauri::command]
fn game_build_sandbox_snapshot(
    request: SandboxCreationRequest,
) -> Result<GameSnapshot, SandboxCreationError> {
    create_sandbox_snapshot(request)
}
```

Delete `game_validate_snapshot`.

Keep `game_begin_runtime` internal to adapter bootstrap and keep stale-epoch checks on mutating/save/restore commands.

Simplify persistence command errors to schema/invalid/host mapping. Diagnostics may differ from WASM.

## 1E. Adapt runtime and dispatch wire

- [ ] **Step 20: Delete JavaScript backend ownership**

Delete `src/runtime/backendOwnership.ts` and `tests/runtime/backendOwnership.test.ts`.

In `createGameRuntime.ts`:

- remove coordinator resolution/acquisition;
- initialize with `await backend.snapshot()`;
- remove ownership release/drain behavior;
- retain the existing persistence lease/coordinator for HPA-543.

Update construction cleanup tests to remove ownership-only cases while retaining actual resource cleanup cases.

- [ ] **Step 21: Convert Save and Load**

Save:

```ts
const captured = await backend.snapshotForSave();
if (!captured.ok) {
  return { status: "failed", error: { kind: "backend", error: captured.error } };
}
```

Load:

```ts
const restored = await backend.restoreSnapshot(untrustedSnapshot);
if (!restored.ok) {
  return { status: "failed", error: { kind: "backend", error: restored.error } };
}
// publish only here
```

Delete separate validation calls.

- [ ] **Step 22: Convert New City to pure build → persist → restore**

Replace the mutate/capture/rollback sequence with:

```ts
let built: SandboxCreationResult;
try {
  built = await backend.buildSandboxSnapshot(request);
} catch (error: unknown) {
  return restorePriorRuntimeAfterNewCityFailure(prior, {
    kind: "backend",
    error: {
      operation: "buildSandboxSnapshot",
      code: "hostFailure",
      diagnostic: error instanceof Error ? error.message : String(error),
    },
  });
}

if (!built.ok) {
  return restorePriorRuntimeAfterNewCityFailure(prior, {
    kind: "sandbox",
    error: built.error,
  });
}

const candidateSnapshot = built.snapshot;
// existing store create/finalize flow uses candidateSnapshot
// no backend rollback path exists because the backend is unchanged
const activated = await backend.restoreSnapshot(candidateSnapshot);
```

Post-conditions:

- build failure: no store write, backend/identity unchanged;
- definite persist failure: backend/identity unchanged;
- ambiguous persist failure: use existing reconciliation without new recovery behavior;
- restore failure after persistence: leave record, backend/identity unchanged;
- success: publish candidate and identity together.

Delete prior backend snapshot capture, candidate snapshot recapture, rollback restore, and orphan deletion branches that exist only because `createSandbox` mutated the engine.

Do not delete pending/finalize reconciliation that belongs to HPA-543/HPA-548.

- [ ] **Step 23: Remove dispatch context from the public wire only**

In `crates/caelum-core/src/intent.rs`, remove `context` from serialized `DispatchResult`.

Keep private apply information:

- `dispatch_context` or a renamed private helper;
- changed/skipped tiles needed for road mutation normalization;
- `NetworkCandidate` apply metadata;
- route lifecycle recomputation inputs.

Change result construction to return only snapshot/applied/rejection.

Rewrite tests that asserted `result.context.cost` or changed tiles to assert:

- budget delta/snapshot state;
- route state after apply;
- rejection;
- preview response impact when impact is the behavior under test.

Do not remove preview impact fields.

- [ ] **Step 24: Run the focused contract-cut verification**

```sh
cargo test -p caelum-core --test persistence_construction
cargo test -p caelum-core
cargo test -p caelum --lib
bunx vitest run --project runtime \
  tests/runtime/backendContract.test.ts \
  tests/runtime/persistenceContract.test.ts \
  tests/runtime/wasmBackend.test.ts \
  tests/runtime/tauriBackend.test.ts \
  tests/runtime/wasmArtifact.smoke.test.ts \
  tests/runtime/gameRuntime.test.ts \
  tests/runtime/constructionCleanup.test.ts \
  tests/runtime/postDisposalBackendFailure.test.ts
bun run check
```

Expected: all commands pass against the final interface.

- [ ] **Step 25: Verify the forbidden public surface is gone**

```sh
rg -n 'runtimeIdentity|RuntimeSession|beginRuntime\??\(|validateSnapshot|BackendOwnership' \
  src tests
rg -n 'PersistenceOperationError|PERSISTENCE_VALIDATION_CODES|PERSISTENCE_REASON_KINDS' \
  src tests
rg -n 'pub context: DispatchContext|context: DispatchContext' \
  crates/caelum-core/src/intent.rs src/runtime/backend/types.ts
```

Expected:

- no public runtime/session/ownership matches;
- no exhaustive TypeScript taxonomy;
- no public dispatch context field;
- private native `game_begin_runtime` and private core apply helpers may still match their specific names.

- [ ] **Step 26: Commit the atomic contract cut**

```sh
git add \
  crates/caelum-core \
  crates/caelum-wasm \
  src-tauri/src \
  src/runtime \
  tests/runtime \
  tests/fixtures/rustSnapshot.ts
git commit -m "refactor: simplify dual gameplay host contract"
```

Do not split this commit by host or layer.

---

# Task 2: Delete Parity and Validator Maintenance Tax

**Files:** cleanup-only delete/reduce files from the File Map.

**Consumes:** final contract from Task 1.

**Produces:** focused retained tests and no obsolete parity/coverage/benchmark infrastructure.

- [ ] **Step 1: Move the eight retained core assertions into `persistence_construction.rs`**

Ensure no retained safety assertion exists only in a file about error-wire vocabulary, branch coverage, or forensic corruption.

Run:

```sh
cargo test -p caelum-core --test persistence_construction
```

Expected: 8 focused tests pass.

- [ ] **Step 2: Delete the detailed Rust error and bridge modules**

Delete:

```text
crates/caelum-core/src/persistence/error.rs
crates/caelum-core/src/persistence_bridge.rs
```

Remove their exports from `crates/caelum-core/src/lib.rs`.

Run:

```sh
rg -n 'PersistenceBridgeError|PersistenceHostErrorCode|PersistenceOperation|PersistenceValidationSource|SnapshotField|DerivedStateError' \
  crates src-tauri src tests
```

Expected: no production dependency on the deleted public taxonomy. Any remaining private diagnostic enum must be small and construction-local, not exported/serialized.

- [ ] **Step 3: Delete validator matrix tests**

Delete the exact files listed in the File Map for:

- corruption catalogues;
- error wire;
- map/entity/trip branch and coverage suites;
- routing/engine persistence validation matrices.

Run:

```sh
find crates/caelum-core/tests -maxdepth 1 -type f -name 'persistence*' -print | sort
```

Expected: only focused construction/snapshot/determinism tests that still cover retained behavior remain.

- [ ] **Step 4: Delete persistence JSON fixture catalogue**

Delete `tests/fixtures/persistence/` after verifying no retained test imports it:

```sh
rg -n 'fixtures/persistence|valid-paused|unsupported-schema|late-derived-corruption|persistence-errors' \
  crates src src-tauri tests scripts
```

Expected before deletion: only obsolete tests/benchmark/docs reference it.

Expected after deletion: no matches.

- [ ] **Step 5: Delete the WASM persistence benchmark**

Delete:

```text
scripts/benchmark-persistence-wasm.ts
```

Remove:

```json
"benchmark:persistence:wasm": "..."
```

from `package.json`, plus its coverage ignore entry.

Run:

```sh
rg -n 'benchmark:persistence:wasm|benchmark-persistence-wasm' .
```

Expected: no matches.

- [ ] **Step 6: Reduce shared fixtures rather than deleting unrelated data**

Inspect:

```sh
rg -n 'persistence_fixtures|host_parity_fixture|rich_fixture' \
  crates tests
rg -n 'rustSnapshot' tests src
```

Actions:

- delete `host_parity_fixture` and export-only helpers used solely by removed matrices;
- retain `rich_fixture` only if ordinary gameplay tests still consume it;
- retain `tests/fixtures/rustSnapshot.ts` fields used by runtime/UI tests, updating only the removed dispatch result shape.

- [ ] **Step 7: Delete obsolete implemented design/plan documents**

Delete the four historical documents listed in the File Map because they prescribe the removed exhaustive contract.

Update links in `docs/architecture.md`, `CLAUDE.md`, and remaining plans to point to HPA-547 where current behavior is described.

- [ ] **Step 8: Run focused and full test suites after deletion**

```sh
cargo test --workspace
bun run test:unit
bun run check
```

Expected: all pass with the deleted files absent.

- [ ] **Step 9: Commit cleanup**

```sh
git add -A
git commit -m "test: remove obsolete host parity machinery"
```

---

# Task 3: Final Architecture and Scope Audit

**Files:**

- Modify: `docs/architecture.md`
- Modify: `CLAUDE.md`
- Modify only if needed: HPA-547 spec/plan to reflect implementation evidence

**Produces:** documentation matching the implemented thin-host boundary and evidence that the PR is a simplification rather than a replacement platform.

- [ ] **Step 1: Update architecture documentation**

Document:

- both hosts remain;
- `GameBackend` method list;
- Tauri epoch is private;
- pure `create_sandbox_snapshot` path;
- candidate-first restore;
- three snapshot errors;
- public dispatch context removed;
- private apply/preview impact retained;
- HPA-543/HPA-548 remain future work.

Remove descriptions of:

- public sessions/identity;
- standalone validation;
- detailed error parity;
- prepared tokens;
- persistence benchmark requirements.

- [ ] **Step 2: Run contract/scope greps**

```sh
rg -n 'runtimeIdentity|RuntimeSession|validateSnapshot|BackendOwnership|PreparedEngineRestore|SaveSnapshotCapture' \
  crates src src-tauri tests docs CLAUDE.md
rg -n 'PersistenceBridgeError|PersistenceOperationError|PERSISTENCE_REASON_KINDS' \
  crates src src-tauri tests docs
rg -n 'buildSandboxSnapshot|create_sandbox_snapshot|game_build_sandbox_snapshot' \
  crates src src-tauri tests docs
```

Expected:

- removed terms appear only in HPA-547 historical/problem statements when explaining deletion;
- pure sandbox terms appear in core and both adapters;
- no compatibility aliases remain.

- [ ] **Step 3: Verify dispatch impact boundaries**

```sh
rg -n 'DispatchContext|affected_route_ids|affectedRouteIds|routeImpacts|changedTiles|skippedTiles' \
  crates/caelum-core src tests
```

Manually verify:

- no serialized/public `DispatchResult.context`;
- private apply data remains only where mutation commit needs it;
- preview response impact and consumers remain.

- [ ] **Step 4: Verify New City post-conditions through tests**

```sh
bunx vitest run --project runtime tests/runtime/gameRuntime.test.ts \
  -t 'sandbox build rejects|definite persist failure|activation restore fails|disposed after pure build|publishes candidate'
```

Expected: all five focused cases pass.

- [ ] **Step 5: Run full repository verification**

```sh
bun run format:check
bun run lint
bun run check
bun run build
bun run test
cargo test --workspace
```

Expected: every command exits 0.

- [ ] **Step 6: Check net deletion**

```sh
git diff --stat origin/main...HEAD
git diff --numstat origin/main...HEAD | \
  awk '{ add += $1; del += $2 } END { print "added", add, "deleted", del, "net", add-del }'
```

Review gate:

- production plus test code must show material net deletion;
- documentation additions do not excuse production/test growth;
- reject the implementation if removed taxonomy/coordination is replaced by a new generic abstraction.

- [ ] **Step 7: Confirm HPA-543/HPA-548 boundaries remain intact**

```sh
rg -n 'SharedPersistenceCoordinator|PersistenceLease|cityQueues|pending|finalizeWorkingSave' \
  src/runtime src/persistence tests/runtime
rg -n 'interface SaveStore|createWorkingSave|finalizeWorkingSave|createCheckpoint|createAutosave' \
  src/persistence src/runtime tests
```

Expected: current coordinator/store machinery still exists except for direct host-contract consumer changes. Its removal belongs to HPA-543/HPA-548.

- [ ] **Step 8: Commit documentation alignment**

```sh
git add docs/architecture.md CLAUDE.md \
  docs/superpowers/specs/2026-08-05-thin-dual-gameplay-hosts-design.md \
  docs/superpowers/plans/2026-08-05-thin-dual-gameplay-hosts.md
git commit -m "docs: align architecture with thin gameplay hosts"
```

---

## Final Review Checklist

- [ ] Both native and WASM hosts remain functional.
- [ ] Both hosts use the existing `create_sandbox_snapshot`.
- [ ] `GameBackend` has only the nine final methods.
- [ ] `runtimeIdentity`, public sessions, ownership registries, and standalone validation are gone.
- [ ] Tauri stale-webview protection remains private.
- [ ] Snapshot errors are exactly three categories with operation and optional diagnostic.
- [ ] Coordinator backend error is exactly `SnapshotError | SandboxHostError`.
- [ ] Validator pruning matches the retain/normalize/delete matrix.
- [ ] Eight retained construction-safety tests pass.
- [ ] Save capture does not validate or mutate the live engine.
- [ ] Restore is candidate-first and preserves active state on failure.
- [ ] New City follows pure build → persist → restore.
- [ ] Persist failure and restore-after-persist failure post-conditions are tested.
- [ ] Public `DispatchResult.context` is gone.
- [ ] Private apply data and preview impact still work.
- [ ] Detailed parity taxonomy, fixtures, matrices, and benchmark are deleted.
- [ ] No temporary aliases or compatibility adapters remain.
- [ ] HPA-543/HPA-548 machinery is not redesigned early.
- [ ] Full format/lint/check/build/test verification passes.
- [ ] Production/test code shows material net deletion.

## Commit Sequence

1. `refactor: simplify dual gameplay host contract`
2. `test: remove obsolete host parity machinery`
3. `docs: align architecture with thin gameplay hosts`

Do not create separate core/WASM/Tauri/TypeScript contract commits. That split would require an inconsistent public boundary or temporary compatibility methods.
