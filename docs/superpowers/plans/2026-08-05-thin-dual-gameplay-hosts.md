# HPA-547 Thin Dual Gameplay Hosts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep native Tauri and browser/WASM gameplay paths while deleting public host-session ownership, exhaustive persistence parity, and unused dispatch impact around the shared `caelum-core` engine.

**Architecture:** `caelum-core` remains the only gameplay authority and performs direct persistence normalization plus candidate-first engine construction. `caelum-wasm` and the Tauri command host become thin serialization/state wrappers behind a minimal TypeScript `GameBackend`; Tauri retains one private epoch acquired inside `createTauriBackend()`. The existing save-store and persistence coordinator remain except for call-site changes made directly necessary by pure sandbox candidates and the smaller backend contract.

**Tech Stack:** Rust 2021, Serde/serde_json, wasm-bindgen, serde-wasm-bindgen, Tauri 2, TypeScript 5.8, Svelte 5, Bun, Vitest, Playwright.

**Companion design:** `docs/superpowers/specs/2026-08-05-thin-dual-gameplay-hosts-design.md` is the normative contract. Amend and re-review that document before introducing a public method, error category, compatibility path, or validation responsibility not defined there.

## Global Constraints

- Keep Tauri/native Rust as the intended desktop release host.
- Keep WASM/browser as the fast Vite, Playwright, and demo host.
- Keep all gameplay rules and engine construction in `caelum-core`.
- Implement as one atomic breaking-change PR; do not introduce temporary dual contracts.
- Remove public `runtimeIdentity`, `RuntimeSession`, `beginRuntime`, and `validateSnapshot`.
- Keep the Tauri epoch private to `createTauriBackend()` and native commands.
- Expose only `unsupportedSchema`, `invalidSnapshot`, and `hostFailure` to frontend snapshot consumers.
- Keep sandbox form errors separate from snapshot errors.
- Build sandbox snapshots without mutating the active engine.
- Restore through complete candidate construction before assignment.
- Keep only structural checks required for safe construction and immediate engine use.
- Normalize directly derivable state; do not introduce migration, repair, warning, or normalization frameworks.
- Do not implement the HPA-548 six-operation city store in this PR.
- Do not implement the HPA-543 active-city/busy/dirty runtime replacement in this PR.
- Remove obsolete tests and fixtures with the behavior they specify.
- Require material net deletion in production and test code.

---

## Baseline Gate

- [ ] **Step 1: Confirm the branch starts from current `main` and contains the approved design**

```sh
git status --short --branch
git merge-base --is-ancestor origin/main HEAD
test -f docs/superpowers/specs/2026-08-05-thin-dual-gameplay-hosts-design.md
```

Expected: clean branch state, `origin/main` is an ancestor, and the design file exists.

- [ ] **Step 2: Record the current public and parity machinery before deleting it**

```sh
rg -n 'runtimeIdentity|RuntimeSession|beginRuntime|validateSnapshot|BackendOwnership' \
  src src-tauri crates tests
rg -n 'PersistenceBridgeError|PreparedEngineRestore|SaveSnapshotCapture' \
  crates src-tauri tests
rg -n 'DispatchResult\.context|result\.context|context\.affectedRouteIds' \
  src crates tests
```

Expected: matches in the current backend types/adapters, ownership module, core persistence bridge, native host, and parity tests.

- [ ] **Step 3: Run the focused pre-change baseline**

```sh
cargo test -p caelum-core --test persistence_snapshot
cargo test -p caelum-core --test persistence_atomicity
cargo test -p caelum --lib
bunx vitest run --project runtime \
  tests/runtime/backendContract.test.ts \
  tests/runtime/wasmBackend.test.ts \
  tests/runtime/tauriBackend.test.ts \
  tests/runtime/gameRuntime.test.ts
```

Expected: all listed targets pass. Record unrelated baseline failures in the PR rather than weakening the new focused assertions.

---

## File Map

### Create

- `src-tauri/src/game_host.rs` if extracting native gameplay state/commands keeps `lib.rs` focused.

### Modify

- `crates/caelum-core/src/engine.rs`
- `crates/caelum-core/src/lib.rs`
- `crates/caelum-core/src/intent.rs`
- `crates/caelum-core/src/persistence/mod.rs`
- `crates/caelum-core/src/persistence/map.rs`
- `crates/caelum-core/src/persistence/entities.rs`
- `crates/caelum-core/src/persistence/trips.rs`
- `crates/caelum-core/tests/persistence_snapshot.rs`
- `crates/caelum-core/tests/persistence_atomicity.rs`
- `crates/caelum-core/tests/persistence_determinism.rs`
- `crates/caelum-wasm/Cargo.toml`
- `crates/caelum-wasm/src/lib.rs`
- `src-tauri/src/lib.rs`
- `src/runtime/backend/types.ts`
- `src/runtime/backend/persistenceContract.ts`
- `src/runtime/backend/persistence.ts`
- `src/runtime/backend/shared.ts`
- `src/runtime/backend/index.ts`
- `src/runtime/backend/wasmBackend.ts`
- `src/runtime/backend/tauriBackend.ts`
- `src/runtime/createGameRuntime.ts`
- `tests/runtime/backendContract.test.ts`
- `tests/runtime/persistenceContract.test.ts`
- `tests/runtime/wasmBackend.test.ts`
- `tests/runtime/wasmArtifact.smoke.test.ts`
- `tests/runtime/tauriBackend.test.ts`
- `tests/runtime/gameRuntime.test.ts`
- `tests/runtime/constructionCleanup.test.ts`
- `tests/runtime/postDisposalBackendFailure.test.ts`
- `tests/fixtures/rustSnapshot.ts`
- `docs/architecture.md`
- `CLAUDE.md`
- `package.json`
- `codecov.yml` only if deleted coverage-only files are explicitly listed there.

### Delete when no remaining consumer exists

- `crates/caelum-core/src/persistence_bridge.rs`
- `crates/caelum-core/src/persistence/error.rs` or replace it with one compact private/load error module if construction code still benefits from a dedicated file.
- `src/runtime/backendOwnership.ts`
- `tests/runtime/backendOwnership.test.ts`
- exhaustive persistence branch/coverage/error-wire tests under `crates/caelum-core/tests/`.
- giant persistence fixtures under `tests/fixtures/persistence/` that specify removed error details.
- `scripts/benchmark-persistence-wasm.ts`.

---

### Task 1: Collapse Core Persistence to Candidate Construction

**Files:**

- Modify: `crates/caelum-core/src/engine.rs`
- Modify: `crates/caelum-core/src/lib.rs`
- Modify: `crates/caelum-core/src/persistence/mod.rs`
- Modify: `crates/caelum-core/src/persistence/map.rs`
- Modify: `crates/caelum-core/src/persistence/entities.rs`
- Modify: `crates/caelum-core/src/persistence/trips.rs`
- Test: `crates/caelum-core/tests/persistence_snapshot.rs`
- Test: `crates/caelum-core/tests/persistence_atomicity.rs`

**Interfaces:**

- Consumes: current `GameSnapshot`, `RoadTopology`, clock derivation helpers, and existing entity/index construction.
- Produces:

```rust
#[derive(Debug)]
pub enum SnapshotLoadError {
    UnsupportedSchema { expected: u16, actual: u16 },
    InvalidSnapshot(String),
}

impl GameEngine {
    pub fn snapshot_for_save(&self) -> GameSnapshot;

    pub fn from_snapshot(
        snapshot: GameSnapshot,
    ) -> Result<Self, SnapshotLoadError>;

    pub fn restore_snapshot(
        &mut self,
        snapshot: GameSnapshot,
    ) -> Result<GameSnapshot, SnapshotLoadError>;
}
```

Exact names may follow current Rust conventions; the public result must not expose the old field/reason taxonomy.

- [ ] **Step 1: Replace core persistence tests with the five required behaviors**

Add focused tests named equivalently to:

```rust
#[test]
fn snapshot_for_save_pauses_clone_without_mutating_live_engine() { /* ... */ }

#[test]
fn current_schema_snapshot_constructs_candidate_engine() { /* ... */ }

#[test]
fn unsupported_schema_is_reported_separately() { /* ... */ }

#[test]
fn structurally_invalid_snapshot_is_rejected() { /* ... */ }

#[test]
fn failed_restore_preserves_active_engine() { /* ... */ }
```

Use one representative structural failure that protects real construction, such as invalid fixed tile count or a required reference pointing outside the candidate indexes.

- [ ] **Step 2: Run the new focused tests and verify they fail against the old contract**

```sh
cargo test -p caelum-core --test persistence_snapshot
cargo test -p caelum-core --test persistence_atomicity
```

Expected: compile or assertion failures because `snapshot_for_save` still returns the old result and detailed validation remains.

- [ ] **Step 3: Add one direct persistence normalization helper**

Implement one private helper near candidate construction:

```rust
fn normalize_persistence_snapshot(snapshot: &mut GameSnapshot) {
    snapshot.paused = true;
    snapshot.day = clock::day_index(snapshot.time);
    snapshot.clock_minutes = clock::clock_minutes(snapshot.time);
}
```

Use existing clock helper names from the repository. Add no registry, warning list, or repair result.

- [ ] **Step 4: Make `snapshot_for_save` clone and normalize without validating the active engine**

Replace capture/token preparation with:

```rust
pub fn snapshot_for_save(&self) -> GameSnapshot {
    let mut snapshot = self.snapshot();
    normalize_persistence_snapshot(&mut snapshot);
    snapshot
}
```

Delete `SaveSnapshotCapture` when no host still consumes it.

- [ ] **Step 5: Reduce candidate preparation to construction safety**

Refactor the current `prepare_snapshot` path so it:

1. rejects unsupported schema;
2. normalizes direct derived fields;
3. validates fixed map shape, required indexes/references, and immediate numeric/index safety;
4. compiles `RoadTopology`;
5. returns a complete candidate engine.

Remove checks for exact canonical ID strings, exact ordering, route oracle equality, derived cache equality, metrics relationships, objective/loss forensics, and other diagnostics that do not protect immediate construction.

- [ ] **Step 6: Replace detailed public persistence errors with compact load errors**

Map every remaining current-schema construction failure to `InvalidSnapshot(diagnostic)`. Preserve `UnsupportedSchema { expected, actual }` as the only separately matched core category.

Delete re-exports of the old field/reason enum tree.

- [ ] **Step 7: Remove prepared restore tokens**

Implement candidate-first assignment directly:

```rust
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

Delete `PreparedEngineRestore` after both hosts migrate.

- [ ] **Step 8: Run core checks**

```sh
cargo test -p caelum-core
cargo clippy -p caelum-core --all-targets -- -D warnings
cargo fmt --all --check
```

Expected: PASS.

- [ ] **Step 9: Commit the core simplification**

```sh
git add crates/caelum-core
git commit -m "refactor: simplify core snapshot construction"
```

---

### Task 2: Thin the WASM Host and Add Pure Sandbox Candidates

**Files:**

- Modify: `crates/caelum-wasm/src/lib.rs`
- Modify: `crates/caelum-wasm/Cargo.toml`
- Modify: `src/runtime/backend/wasmBackend.ts`
- Test: `tests/runtime/wasmBackend.test.ts`
- Test: `tests/runtime/wasmArtifact.smoke.test.ts`

**Interfaces:**

- Consumes: compact core save/load result and existing `SandboxCreationRequest`.
- Produces: instance-local WASM methods for snapshot, save snapshot, pure sandbox snapshot, candidate-first restore, dispatch, tick, reset, and previews.

- [ ] **Step 1: Replace WASM parity tests with focused behavior tests**

Keep or add tests equivalent to:

```ts
it("builds a sandbox candidate without replacing the active engine", async () => {});
it("dispatches and ticks through the active engine", async () => {});
it("captures a paused save snapshot", async () => {});
it("restores a valid snapshot", async () => {});
it("preserves active state when restore rejects an invalid snapshot", async () => {});
```

In the artifact smoke test, keep one real-WASM save/restore round trip and one invalid restore preservation proof.

- [ ] **Step 2: Run the focused WASM tests and verify the pure-candidate test fails**

```sh
bunx vitest run --project runtime \
  tests/runtime/wasmBackend.test.ts \
  tests/runtime/wasmArtifact.smoke.test.ts
```

Expected: candidate purity fails because current `createSandbox` replaces the active engine.

- [ ] **Step 3: Remove the exported standalone validator and bridge taxonomy**

Delete WASM exports and helpers for:

- `validate_snapshot`;
- exact `PersistenceBridgeError` serialization;
- operation/source/phase tagging;
- prepared restore encoding;
- synthetic encode failure behavior.

Keep only compact conversion from core load failure to a small JS value that `wasmBackend.ts` can map.

- [ ] **Step 4: Implement pure sandbox candidate construction**

Expose a method equivalent to:

```rust
pub fn build_sandbox_snapshot(request: JsValue) -> Result<JsValue, JsValue> {
    let request: SandboxCreationRequest = serde_wasm_bindgen::from_value(request)
        .map_err(to_js_error)?;
    let candidate = GameEngine::from_sandbox_request(request)
        .map_err(encode_sandbox_error)?;
    serde_wasm_bindgen::to_value(&candidate.snapshot()).map_err(to_js_error)
}
```

It must not borrow or mutate `self.inner`.

- [ ] **Step 5: Implement candidate-first WASM restore**

Decode into `GameSnapshot`, construct a candidate through `GameEngine::from_snapshot`, serialize the accepted snapshot, then replace `self.inner`. A decode or construction failure leaves `self.inner` unchanged.

- [ ] **Step 6: Map WASM adapter failures to the three snapshot categories**

In `wasmBackend.ts`, return:

```ts
{ ok: false, error: { code: "unsupportedSchema", diagnostic } }
{ ok: false, error: { code: "invalidSnapshot", diagnostic } }
{ ok: false, error: { code: "hostFailure", diagnostic } }
```

Do not inspect a mirrored field/reason tree.

- [ ] **Step 7: Remove bridge-only Rust dependencies and dead TypeScript helpers**

Run:

```sh
cargo machete 2>/dev/null || true
cargo check -p caelum-wasm
```

Remove only dependencies confirmed unused by the compiler or manifest inspection.

- [ ] **Step 8: Rebuild and test WASM**

```sh
bun run wasm:build
bunx vitest run --project runtime \
  tests/runtime/wasmBackend.test.ts \
  tests/runtime/wasmArtifact.smoke.test.ts
cargo clippy -p caelum-wasm --all-targets -- -D warnings
```

Expected: PASS.

- [ ] **Step 9: Commit the WASM adapter simplification**

```sh
git add crates/caelum-wasm src/runtime/backend/wasmBackend.ts \
  tests/runtime/wasmBackend.test.ts tests/runtime/wasmArtifact.smoke.test.ts
git commit -m "refactor: thin the wasm gameplay host"
```

---

### Task 3: Make Tauri Session Handling Private

**Files:**

- Create: `src-tauri/src/game_host.rs` if extracting the current gameplay host.
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/runtime/backend/tauriBackend.ts`
- Test: `tests/runtime/tauriBackend.test.ts`
- Test: native `#[cfg(test)]` module colocated with `game_host.rs` or `lib.rs`.

**Interfaces:**

- Consumes: compact core candidate construction and current Tauri managed state.
- Produces: `createTauriBackend()` that acquires a private epoch before returning a minimal `GameBackend`.

- [ ] **Step 1: Add focused native command tests**

Keep exactly the behavior categories below:

```rust
#[test]
fn build_sandbox_snapshot_does_not_replace_managed_engine() { /* ... */ }

#[test]
fn valid_restore_replaces_managed_engine() { /* ... */ }

#[test]
fn invalid_restore_preserves_managed_engine() { /* ... */ }

#[test]
fn stale_epoch_cannot_mutate_after_new_session_begins() { /* ... */ }
```

Retain one dispatch/tick and one save snapshot test. Delete exact JSON error-shape cases.

- [ ] **Step 2: Add a TypeScript test that backend creation acquires the session internally**

Mock Tauri `invoke` and assert:

```ts
const backend = await createTauriBackend();
expect(invoke).toHaveBeenNthCalledWith(1, "game_begin_runtime");
await backend.dispatch(intent);
expect(invoke).toHaveBeenLastCalledWith("game_dispatch", {
  intent,
  runtimeEpoch: acquiredEpoch,
});
```

Assert the returned object has no `beginRuntime` or `runtimeIdentity` property.

- [ ] **Step 3: Extract `game_host.rs` only if it reduces mixed responsibility**

Move `OwnedEngine`, epoch helpers, gameplay commands, and focused tests into `src-tauri/src/game_host.rs`. Keep `lib.rs` responsible for builder setup, managed-state registration, and command registration.

Do not add a trait, command registry abstraction, service object, or dependency-injection layer.

- [ ] **Step 4: Replace mutating sandbox creation with a pure command**

Implement:

```rust
#[tauri::command]
fn game_build_sandbox_snapshot(
    request: SandboxCreationRequest,
) -> Result<GameSnapshot, SandboxCreationError> {
    GameEngine::from_sandbox_request(request).map(|engine| engine.snapshot())
}
```

The command does not access `State<EngineState>`.

- [ ] **Step 5: Delete the public validation command and exact bridge encoding**

Remove `game_validate_snapshot`, `EncodedPersistenceBridgeError`, operation/source/phase wrappers, and encode-before-commit helpers.

Keep compact command errors that distinguish unsupported schema, invalid candidate, and host failure for the TypeScript adapter.

- [ ] **Step 6: Keep one private epoch path**

Retain `game_begin_runtime`. In `createTauriBackend()`:

```ts
const { runtimeEpoch } = await invoke<{
  runtimeEpoch: number;
  snapshot: RustGameSnapshot;
}>("game_begin_runtime");
```

Close over `runtimeEpoch`. Do not return the initial snapshot separately from backend creation; runtime initialization will call `backend.snapshot()` through the shared contract.

- [ ] **Step 7: Simplify candidate-first native restore**

Decode and construct the candidate before locking managed state. Lock, verify epoch, assign candidate, and return its snapshot. A stale epoch or failed construction leaves managed state unchanged.

- [ ] **Step 8: Run Tauri host checks**

```sh
cargo test -p caelum --lib
cargo clippy -p caelum --all-targets -- -D warnings
bunx vitest run --project runtime tests/runtime/tauriBackend.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit the private native session**

```sh
git add src-tauri src/runtime/backend/tauriBackend.ts \
  tests/runtime/tauriBackend.test.ts
git commit -m "refactor: hide tauri gameplay sessions"
```

---

### Task 4: Reduce the TypeScript Backend Contract

**Files:**

- Modify: `src/runtime/backend/types.ts`
- Replace or reduce: `src/runtime/backend/persistenceContract.ts`
- Replace or reduce: `src/runtime/backend/persistence.ts`
- Modify: `src/runtime/backend/shared.ts`
- Modify: `src/runtime/backend/index.ts`
- Delete: `src/runtime/backendOwnership.ts`
- Test: `tests/runtime/backendContract.test.ts`
- Test: `tests/runtime/persistenceContract.test.ts`
- Delete: `tests/runtime/backendOwnership.test.ts`

**Interfaces:**

- Produces:

```ts
export type SnapshotErrorCode =
  | "unsupportedSchema"
  | "invalidSnapshot"
  | "hostFailure";

export interface SnapshotError {
  code: SnapshotErrorCode;
  diagnostic?: string;
}

export type SnapshotResult =
  | { ok: true; snapshot: RustGameSnapshot }
  | { ok: false; error: SnapshotError };

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

- [ ] **Step 1: Rewrite backend contract tests to assert the minimal method set**

Test a representative backend object against exactly:

```ts
[
  "snapshot",
  "snapshotForSave",
  "buildSandboxSnapshot",
  "restoreSnapshot",
  "dispatch",
  "tick",
  "reset",
  "previewRoute",
  "previewRoadMutation",
]
```

Assert `beginRuntime`, `runtimeIdentity`, and `validateSnapshot` are absent.

- [ ] **Step 2: Replace exhaustive persistence taxonomy tests with three-category mapping tests**

Keep one test per category and one malformed host failure. Delete arrays of field names, entity kinds, reason kinds, exact-key guards, prototype guards, and sparse-array fixtures.

- [ ] **Step 3: Replace public persistence types**

Remove:

- `PersistenceOperation`;
- `PersistenceValidationSource`;
- `PersistenceSerializationPhase`;
- `PersistenceHostErrorCode` variants beyond the three public categories;
- the complete field/reason/type taxonomy;
- `PersistenceValidationResult`;
- `{ snapshot }` request wrappers if no remaining caller uses them.

Define the compact snapshot result alongside `GameBackend` or in one small helper file used by both adapters.

- [ ] **Step 4: Delete backend ownership coordination**

Delete `src/runtime/backendOwnership.ts`, its `Map`, `WeakMap`, reset hook, coordinator types, and tests. Remove exports from barrel modules.

- [ ] **Step 5: Keep only current wire normalization**

Retain null/undefined normalization for Rust `Option` fields consumed by the runtime and preview responses.

Do not preserve `DispatchResult.context` normalization; Task 6 removes that field.

- [ ] **Step 6: Run focused TypeScript tests and checks**

```sh
bunx vitest run --project runtime \
  tests/runtime/backendContract.test.ts \
  tests/runtime/persistenceContract.test.ts \
  tests/runtime/wasmBackend.test.ts \
  tests/runtime/tauriBackend.test.ts
bun run check
```

Expected: PASS.

- [ ] **Step 7: Commit the public contract deletion**

```sh
git add src/runtime/backend tests/runtime/backendContract.test.ts \
  tests/runtime/persistenceContract.test.ts tests/runtime/backendOwnership.test.ts
git commit -m "refactor: reduce the gameplay backend contract"
```

---

### Task 5: Adapt Runtime Initialization, Save, Load, and New City

**Files:**

- Modify: `src/runtime/createGameRuntime.ts`
- Modify: `tests/runtime/gameRuntime.test.ts`
- Modify: `tests/runtime/constructionCleanup.test.ts`
- Modify: `tests/runtime/postDisposalBackendFailure.test.ts`

**Interfaces:**

- Consumes: the minimal `GameBackend` from Task 4.
- Preserves: the current `SaveStore`, envelope, persistence coordinator, leases, queues, revision tracking, pending/finalize behavior, and public runtime controller until HPA-543/HPA-548.

- [ ] **Step 1: Add an initialization test without backend ownership or `beginRuntime`**

Create a backend mock exposing only the new interface. Assert `createGameRuntime` initializes from one `snapshot()` call and does not require registry reset hooks.

- [ ] **Step 2: Add a load test proving one candidate-first restore call**

Arrange a stored snapshot and assert:

```ts
expect(backend.restoreSnapshot).toHaveBeenCalledTimes(1);
expect(backend.restoreSnapshot).toHaveBeenCalledWith(storedSnapshot);
expect(backend.validateSnapshot).toBeUndefined();
```

A failed restore must preserve the previous runtime state and active city identity.

- [ ] **Step 3: Add New City tests for candidate purity and activation failure**

Test both:

1. storage receives the sandbox candidate while the backend still exposes the prior active snapshot;
2. storage succeeds but activation fails, leaving the city record available and current gameplay unchanged.

Do not assert backend rollback or record deletion.

- [ ] **Step 4: Remove backend ownership acquisition and release**

Delete imports and construction/disposal code for `resolveBackendOwnershipCoordinator`, `BackendOwnership`, and registry cleanup.

Initialize state with:

```ts
state = normalizeRustSnapshot(await backend.snapshot());
```

Keep persistence lease acquisition and disposal unchanged.

- [ ] **Step 5: Replace validate-then-restore load flow**

Delete the public validation call. Pass the stored `unknown` snapshot directly to `restoreSnapshot`. Convert the three error codes into the current runtime persistence error representation without introducing a new error hierarchy.

- [ ] **Step 6: Adapt save capture to the compact result**

Handle `snapshotForSave()` success or the three snapshot failures. Leave current queue, revision, envelope, and write ordering unchanged.

- [ ] **Step 7: Replace mutating New City sandbox creation**

Call:

```ts
const built = await backend.buildSandboxSnapshot(request);
```

The candidate must remain local until storage succeeds.

Remove prior backend snapshot capture and rollback branches whose only purpose was undoing mutating `createSandbox`.

- [ ] **Step 8: Activate the stored candidate after persistence**

Call `restoreSnapshot(built.snapshot)` after the current store/finalize sequence. Publish the new city only after restore success.

On activation failure:

- leave the persisted record intact;
- restore prior public/UI state if it was temporarily suspended;
- return a retryable load/host failure;
- do not delete the record;
- do not restore a backend that was never changed.

- [ ] **Step 9: Remove ownership-only cleanup tests and retain disposal behavior still used by persistence**

Delete construction cases that test backend lock queues, identities, or double release. Keep tests that protect disposal from publishing after an in-flight backend or persistence operation.

- [ ] **Step 10: Run runtime tests**

```sh
bunx vitest run --project runtime \
  tests/runtime/gameRuntime.test.ts \
  tests/runtime/constructionCleanup.test.ts \
  tests/runtime/postDisposalBackendFailure.test.ts
bun run check
```

Expected: PASS.

- [ ] **Step 11: Commit the runtime call-site adaptation**

```sh
git add src/runtime/createGameRuntime.ts \
  tests/runtime/gameRuntime.test.ts \
  tests/runtime/constructionCleanup.test.ts \
  tests/runtime/postDisposalBackendFailure.test.ts
git commit -m "refactor: consume pure backend candidates"
```

---

### Task 6: Remove Unused `DispatchResult.context`

**Files:**

- Modify: `crates/caelum-core/src/intent.rs`
- Modify: `crates/caelum-core/src/engine.rs`
- Modify direct intent handlers that construct dispatch context.
- Modify: `src/runtime/backend/types.ts`
- Modify: `src/runtime/backend/shared.ts`
- Modify affected tests under `crates/caelum-core/tests/` and `tests/runtime/`.

**Interfaces:**

- Produces:

```rust
pub struct DispatchResult {
    pub snapshot: GameSnapshot,
    pub applied: bool,
    pub rejection: Option<GameplayRejection>,
}
```

TypeScript mirrors the same three fields.

- [ ] **Step 1: Search all production consumers before deletion**

```sh
rg -n 'DispatchContext|DispatchResult.*context|\.context\.cost|changed_tiles|skipped_tiles|affected_route_ids' \
  crates src src-tauri tests
```

Classify matches as dispatch result, gameplay rejection context, or route/road preview impact. Only dispatch-result impact is removed.

- [ ] **Step 2: Add or retain tests proving apply behavior without dispatch impact**

Assert representative dispatches still return the correct snapshot, `applied`, and `rejection`. Preview tests must continue asserting cost, changed tiles, skipped tiles, and route impacts.

- [ ] **Step 3: Remove `DispatchContext` from core result construction**

Stop calculating changed/skipped/full-map affected route data solely for the applied result. Keep calculations already required to apply the mutation or produce a preview.

- [ ] **Step 4: Remove TypeScript context typing and normalization**

Delete `DispatchContext`, the `context` field, and `normalizeDispatchResult` context handling. Keep rejection and preview normalization.

- [ ] **Step 5: Run core and runtime behavior tests**

```sh
cargo test -p caelum-core
bunx vitest run --project runtime \
  tests/runtime/backendContract.test.ts \
  tests/runtime/gameRuntime.test.ts \
  tests/runtime/previewCoordinator.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit dispatch result reduction**

```sh
git add crates/caelum-core src/runtime/backend tests
git commit -m "refactor: remove unused dispatch impact"
```

---

### Task 7: Delete Parity Infrastructure, Fixtures, and Benchmarks

**Files:**

- Delete or reduce Rust persistence branch/coverage/error-wire test files.
- Delete or reduce `tests/fixtures/persistence/*`.
- Delete: `scripts/benchmark-persistence-wasm.ts`.
- Modify: `package.json`.
- Modify: `codecov.yml` if it names removed files.
- Modify: `tests/fixtures/rustSnapshot.ts` only for the current compact wire shape.

- [ ] **Step 1: List every file that exists only for the removed contract**

```sh
find crates/caelum-core/tests -maxdepth 1 -type f | sort | rg 'persistence|coverage|branches|error_wire|fixture'
find tests/fixtures/persistence -maxdepth 1 -type f -print | sort
rg -n 'benchmark:persistence|benchmark-persistence-wasm|persistence-errors|late-derived-corruption' \
  package.json codecov.yml scripts tests docs
```

- [ ] **Step 2: Keep only fixtures required by focused behavior tests**

Retain at most:

- one valid current-schema snapshot;
- one unsupported-schema value;
- one representative current-schema invalid value.

Prefer constructing small invalid snapshots in Rust/TypeScript tests instead of maintaining giant generated JSON.

- [ ] **Step 3: Delete branch and coverage matrices for removed diagnostics**

Delete tests whose only assertion is that every old field/reason variant is reachable or serialized exactly. Keep deterministic gameplay invariants in their domain-specific test files.

- [ ] **Step 4: Remove the persistence benchmark command and script**

Delete `benchmark:persistence:wasm` from `package.json` and remove the script. No player-facing performance decision depends on the removed exhaustive validator benchmark.

- [ ] **Step 5: Verify no removed vocabulary remains**

```sh
rg -n 'PersistenceBridgeError|PersistenceValidationSource|PersistenceSerializationPhase|PERSISTENCE_SNAPSHOT_FIELDS|PERSISTENCE_REASON_KINDS|PreparedEngineRestore|SaveSnapshotCapture' \
  crates src src-tauri tests scripts package.json
```

Expected: no production matches; a historical document may mention the old names only when clearly marked superseded.

- [ ] **Step 6: Run all Rust and unit tests after deletion**

```sh
cargo test --workspace
bun run test:unit
```

Expected: PASS.

- [ ] **Step 7: Commit parity-infrastructure deletion**

```sh
git add -A crates/caelum-core/tests tests/fixtures scripts package.json codecov.yml
git commit -m "test: delete exhaustive host parity matrices"
```

---

### Task 8: Update Current Architecture Documentation

**Files:**

- Modify: `docs/architecture.md`
- Modify: `CLAUDE.md`
- Optionally annotate earlier HPA-340/HPA-341 specs/plans as superseded where they otherwise appear normative.

- [ ] **Step 1: Update the backend architecture description**

Document:

- both hosts remain;
- `GameBackend` is minimal;
- Tauri epoch is private;
- sandbox construction is pure;
- restore is candidate-first;
- frontend snapshot errors use three categories;
- exact host error parity is not an architecture requirement.

- [ ] **Step 2: Update persistence-validation guidance**

State that current local saves retain schema probing, deserialization, construction safety, and topology rebuild. Remove guidance requiring the exhaustive field/reason catalogue, exact-shape JavaScript guards, or active-engine self-validation.

- [ ] **Step 3: Update dispatch result documentation**

Remove references to post-apply `DispatchResult.context`. Preserve route/road preview impact documentation.

- [ ] **Step 4: Mark historical parity docs as superseded without rewriting their history**

Add a concise header to the old HPA-341 design/plan when necessary:

```md
> **Superseded by HPA-547 for current architecture.** This document records the earlier exhaustive parity design and remains historical implementation context.
```

Do not edit historical details beyond preventing normative ambiguity.

- [ ] **Step 5: Run documentation formatting**

```sh
bunx prettier --check CLAUDE.md docs/architecture.md \
  docs/superpowers/specs/2026-08-05-thin-dual-gameplay-hosts-design.md \
  docs/superpowers/plans/2026-08-05-thin-dual-gameplay-hosts.md
```

Expected: PASS.

- [ ] **Step 6: Commit documentation updates**

```sh
git add CLAUDE.md docs
git commit -m "docs: describe thin dual gameplay hosts"
```

---

### Task 9: Final Verification and Scope Audit

- [ ] **Step 1: Run formatting and static checks**

```sh
bun run format:check
bun run check
bun run lint
```

Expected: PASS.

- [ ] **Step 2: Run complete Rust and TypeScript test suites**

```sh
cargo test --workspace
bun run test
```

Expected: PASS.

- [ ] **Step 3: Run representative browser end-to-end coverage**

```sh
bun run test:e2e
```

Expected: PASS, including startup, one gameplay mutation, and existing route/road preview behavior.

- [ ] **Step 4: Build both hosts**

```sh
bun run build
cargo check -p caelum
```

Expected: browser production build and native Rust host compile successfully.

- [ ] **Step 5: Audit public surface and scope boundaries**

```sh
rg -n 'runtimeIdentity|RuntimeSession|beginRuntime|validateSnapshot|BackendOwnership|PersistenceBridgeError|PreparedEngineRestore|SaveSnapshotCapture' \
  crates src src-tauri tests
rg -n 'SharedPersistenceCoordinator|PersistenceLease|pending|finalize|revision' \
  src/runtime/createGameRuntime.ts src/runtime/persistenceCoordinator.ts
rg -n 'listCities|readCity|createCity|updateCity|renameCity|deleteCity' \
  src/persistence src/runtime
```

Expected:

- removed backend/session/parity symbols are absent from current production code;
- the existing persistence coordinator still exists for HPA-543;
- the current store/envelope remains for HPA-548 rather than being partially replaced.

- [ ] **Step 6: Confirm material net deletion**

```sh
git diff --stat origin/main...HEAD
git diff --numstat origin/main...HEAD | awk '{ add += $1; del += $2 } END { print "added", add, "deleted", del, "net", add-del }'
```

Expected: deletions materially exceed additions after excluding the design and plan documents. If production code grows, review for replacement abstractions or accidentally retained compatibility paths before proceeding.

- [ ] **Step 7: Review acceptance criteria against the diff**

Confirm every item in the companion design has a corresponding implementation or test. Specifically verify native release behavior, browser functionality, pure candidates, private epoch, small errors, candidate-first restore, `DispatchResult.context` deletion, and HPA-543/HPA-548 scope preservation.

- [ ] **Step 8: Commit final generated or formatting changes**

```sh
git status --short
git add -A
git commit -m "chore: finalize HPA-547 verification"
```

Skip the commit when the working tree is already clean.

## Suggested Commit Sequence

1. `refactor: simplify core snapshot construction`
2. `refactor: thin the wasm gameplay host`
3. `refactor: hide tauri gameplay sessions`
4. `refactor: reduce the gameplay backend contract`
5. `refactor: consume pure backend candidates`
6. `refactor: remove unused dispatch impact`
7. `test: delete exhaustive host parity matrices`
8. `docs: describe thin dual gameplay hosts`
9. `chore: finalize HPA-547 verification` when needed

## Review Gates

A reviewer should reject the implementation if it:

- removes either justified gameplay host;
- moves gameplay validation or business rules into TypeScript;
- exposes Tauri epoch/session details through `GameBackend`;
- retains the old exhaustive error taxonomy as a compatibility layer;
- adds factories, registries, traits, dependency injection, generated host contracts, or a plugin framework;
- implements the HPA-543 runtime rewrite or HPA-548 store rewrite early;
- preserves New City backend rollback after sandbox construction is pure;
- removes route/road preview impact used by the UI;
- weakens candidate-first restore or structural construction safety;
- produces no material net deletion.
