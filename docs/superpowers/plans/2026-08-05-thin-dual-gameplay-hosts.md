# HPA-547 Thin Dual Gameplay Hosts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep native Tauri and browser/WASM gameplay paths while deleting public host-session ownership, exhaustive persistence parity, and unused dispatch wire impact around the shared `caelum-core` engine.

**Architecture:** `caelum-core` remains the only gameplay authority. Public dispatch impact and JavaScript backend ownership are removed as independent green commits. The save/restore API then changes atomically across core, WASM, Tauri, TypeScript, the coordinator consumer type, and runtime call sites. Tauri retains a private epoch; Load and New City retain narrow prior-snapshot rollback for ambiguous thrown restores and for successful restores superseded before publication (until HPA-543 replaces the current load coordination with one busy gate).

**Tech Stack:** Rust 2021, Serde/serde_json, wasm-bindgen, serde-wasm-bindgen, Tauri 2, TypeScript 5.8, Svelte 5, Bun, Vitest, Playwright.

**Companion design:** `docs/superpowers/specs/2026-08-05-thin-dual-gameplay-hosts-design.md` is normative.

## Global Constraints

- Keep Tauri/native Rust as the desktop release host.
- Keep WASM/browser as the Vite, Playwright, and demo host.
- Keep all gameplay and candidate construction in `caelum-core`.
- Keep the snapshot API cut atomic; do not add old/new aliases.
- Remove public `runtimeIdentity`, `RuntimeSession`, `beginRuntime`, and `validateSnapshot`.
- Keep the Tauri epoch private to `createTauriBackend()` and native commands.
- Expose only `unsupportedSchema`, `invalidSnapshot`, and `hostFailure`.
- `SnapshotError` has no `operation`; direct callers already know the operation.
- Keep sandbox form errors separate.
- Reuse existing `create_sandbox_snapshot` in both hosts.
- Follow the resolved validator matrix and candidate-construction order in the design.
- Retain ordinary-road reciprocity checks; `RoadTopology::compile` does not provide them.
- Remove only public `DispatchResult.context`; retain private apply and preview impact.
- On a thrown restore, roll back the prior canonical snapshot; fatal-stop if rollback fails.
- Do not implement HPA-543 or HPA-548 early.
- Require material net deletion in production and test code.

## Risks

### Ambiguous restore delivery

A host can commit a candidate and lose the response. `{ ok: false }` is definitive non-mutation; a rejected promise is not. Capture prior canonical state before Load/New City activation, roll it back on a thrown restore, and enter the existing fatal coherence path if rollback fails. Do not publish an arbitrary backend re-read because it does not resolve city identity.

### Validator over-pruning

The net-deletion gate must not decide safety boundaries. Prune `map.rs`, `entities.rs`, and `trips.rs` separately, running core tests after each. Keep separate tests for non-reciprocal ordinary roads and genuine structure compiler failure.

### Temporary coordinator entanglement

Pending/finalize reconciliation still exists. Preserve it and its current tests; add no new reconciliation semantics. HPA-547 changes pure build and activation only.

---

## Baseline Gate

- [x] **Step 1: Confirm branch and documents**

```sh
git fetch origin
git status --short --branch
git merge-base --is-ancestor origin/main HEAD
test -f docs/superpowers/specs/2026-08-05-thin-dual-gameplay-hosts-design.md
test -f docs/superpowers/plans/2026-08-05-thin-dual-gameplay-hosts.md
```

Expected: clean branch; `origin/main` is an ancestor; both documents exist.

- [x] **Step 2: Record the removal surfaces**

```sh
rg -n 'runtimeIdentity|RuntimeSession|beginRuntime|validateSnapshot|BackendOwnership' \
  src src-tauri crates tests
rg -n 'PersistenceBridgeError|PersistenceOperationError|PreparedEngineRestore|SaveSnapshotCapture' \
  crates src src-tauri tests scripts
rg -n 'DispatchContext|\.context|affected_route_ids|affectedRouteIds' \
  crates/caelum-core src src-tauri tests
```

Expected: matches in the current backend, ownership module, persistence bridge/taxonomy, and dispatch wire/tests.

- [x] **Step 3: Run the focused baseline**

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

Expected: all pass before edits. Record unrelated failures; do not weaken assertions.

---

## File Map

### Create

- `crates/caelum-core/tests/persistence_construction.rs`
- Optional responsibility split: `src-tauri/src/game_host.rs`

### Modify

- `crates/caelum-core/src/{engine,intent,lib,sandbox}.rs`
- `crates/caelum-core/src/persistence/{mod,map,entities,trips}.rs`
- `crates/caelum-wasm/{Cargo.toml,src/lib.rs}`
- `src-tauri/src/lib.rs`
- `src/runtime/backend/{types,persistenceContract,persistence,shared,index,wasmBackend,tauriBackend}.ts`
- `src/runtime/{persistenceCoordinator,createGameRuntime}.ts`
- Focused runtime/core tests and `tests/fixtures/rustSnapshot.ts` where the dispatch shape changes
- `package.json`, `codecov.yml`, `vite.config.ts`, `docs/architecture.md`, `CLAUDE.md`

### Delete

- `src/runtime/backendOwnership.ts`
- `tests/runtime/backendOwnership.test.ts`
- `crates/caelum-core/src/persistence_bridge.rs`
- `crates/caelum-core/tests/persistence_error_wire.rs`
- `crates/caelum-core/tests/persistence_corruption.rs`
- `crates/caelum-core/tests/persistence_map_{coverage,branches,validation}.rs`
- `crates/caelum-core/tests/persistence_entities_{coverage,branches,validation}.rs`
- `crates/caelum-core/tests/persistence_trips_{coverage,branches,validation}.rs`
- `crates/caelum-core/tests/persistence_routing_validation.rs`
- `crates/caelum-core/tests/persistence_engine_validation.rs`
- `crates/caelum-core/tests/persistence_fixture_export.rs`
- Persistence JSON fixture catalogue after focused tests use programmatic candidates
- Historical HPA-340/HPA-341 validation/parity specs and plans after links are updated

---

# Task 1: Remove Public Dispatch Impact

**Files:** `crates/caelum-core/src/intent.rs`, `engine.rs`, backend types/shared normalization, affected fixtures/tests.

- [x] **Step 1: Classify every impact match**

```sh
rg -n 'DispatchContext|\.context|affected_route_ids|affectedRouteIds' \
  crates/caelum-core src src-tauri tests
```

Classify each match:

```text
DELETE — PUBLIC WIRE
DispatchResult.context, TypeScript mirror, shared.ts normalization, applied-result-only tests

KEEP — PRIVATE APPLY
dispatch_context, NetworkCandidate metadata, changed/skipped normalization,
route lifecycle recomputation inputs, cost/footprint commit values

KEEP — PREVIEW
Road/route preview impact, warnings, routeImpacts, changedTiles, skippedTiles
```

- [x] **Step 2: Change the public result**

```rust
pub struct DispatchResult {
    pub snapshot: GameSnapshot,
    pub applied: bool,
    pub rejection: Option<GameplayRejection>,
}
```

Remove the TypeScript `context` field and dispatch-context normalization. Keep private data needed by mutation commit. Rewrite assertions:

- cost → budget delta;
- changed tiles → resulting tile state;
- affected routes → resulting route/path state;
- preview impact → continue asserting preview responses.

- [x] **Step 3: Verify and commit**

```sh
cargo test -p caelum-core
bun run format:check
bun run lint
bun run check
bun run test:unit
bun run build
git add crates/caelum-core src/runtime/backend tests
git commit -m "refactor: remove unused dispatch impact from host wire"
```

Expected: every command exits 0; public context is gone; apply/preview behavior remains.

---

# Task 2: Remove JavaScript Backend Ownership

`beginRuntime` remains temporarily public until Task 3 hides the Tauri epoch.

**Files:** delete ownership module/test; modify backend types/Tauri adapter/runtime construction and ownership-only cleanup tests.

- [x] **Step 1: Remove ownership and identity**

Delete the coordinator, module `Map`, `WeakMap`, reset hook, lease handle, and tests. Remove `runtimeIdentity` from `GameBackend`/Tauri. Remove runtime acquisition/release and ownership-specific cleanup comments.

Do not change persistence leases, queues, tokens, pending/finalize, or public `beginRuntime` here.

- [x] **Step 2: Verify and commit**

```sh
rg -n 'runtimeIdentity|BackendOwnership|backendOwnershipRegistry|objectIdentityBackendOwnership' \
  src tests
bun run format:check
bun run lint
bun run check
bun run test:unit
bun run build
git add -A -- src/runtime tests/runtime
git commit -m "refactor: remove backend ownership coordination"
```

Expected: no ownership/identity matches and every command exits 0.

---

# Task 3: Atomic Snapshot Contract Cut

Tasks 1–2 are complete. Do not commit or introduce compatibility aliases until the final snapshot interface is consistent across core, both hosts, TypeScript, coordinator consumer, and runtime.

## Final TypeScript Contracts

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

export interface SandboxHostError {
  code: "hostFailure";
  diagnostic?: string;
}

export type PersistenceCoordinatorBackendError =
  | SnapshotError
  | SandboxHostError;
```

`GameBackend` has exactly: `snapshot`, `snapshotForSave`, `buildSandboxSnapshot`, `restoreSnapshot`, `dispatch`, `tick`, `reset`, `previewRoute`, `previewRoadMutation`.

## 3A. Final-contract tests

- [x] **Step 1: Add nine core construction tests**

Create `persistence_construction.rs`:

| Test | Mutation | Assertion |
| --- | --- | --- |
| unsupported schema | previous schema version | `UnsupportedSchema`; target unchanged |
| wrong tile count | remove final tile | `InvalidSnapshot` |
| duplicate entity ID | station reuses existing stop/building ID | `InvalidSnapshot` |
| missing reference | route waypoint is `missing-node` | `InvalidSnapshot` |
| non-reciprocal road | remove reciprocal ordinary-road edge | `InvalidSnapshot` before topology compile |
| genuine structure compile failure | reuse unsafe structure setup from `road_topology_compile_error.rs` through `from_snapshot` | `InvalidSnapshot` from structure compile |
| failed restore preservation | restore invalid tile-count candidate | target unchanged |
| paused save clone | save unpaused engine | returned paused; live unchanged |
| deterministic round trip | save → load → save | snapshots equal |

Use programmatic candidates, not persistence JSON fixtures.

- [x] **Step 2: Rewrite backend/error tests**

Backend contract tests require the nine final methods and absence of `beginRuntime`, `validateSnapshot`, `createSandbox`, and `runtimeIdentity`.

Persistence mapping tests cover only:

- schema rejection → `unsupportedSchema`;
- non-schema decode/construction rejection → `invalidSnapshot`;
- unexpected adapter failure → `hostFailure` with optional diagnostic;
- host diagnostics may differ.

Do not test an operation field.

- [x] **Step 3: Add host/runtime behavior tests**

Both host suites cover pure sandbox construction, dispatch/tick, save, valid restore, and definitive invalid restore preserving active state. Tauri also keeps one stale-epoch test.

Runtime tests cover:

- Load restore throws → prior snapshot rollback succeeds;
- Load rollback fails → fatal coherence state;
- sandbox build rejection writes nothing;
- activation `{ ok: false }` leaves stored record and prior gameplay/identity;
- activation throws → prior rollback;
- activation rollback fails → fatal coherence state;
- disposal after pure build writes nothing;
- success publishes candidate and identity only after restore.

Do not add pending/finalize ambiguity tests.

- [x] **Step 4: Verify tests fail against the old contract**

```sh
cargo test -p caelum-core --test persistence_construction
bunx vitest run --project runtime \
  tests/runtime/backendContract.test.ts \
  tests/runtime/persistenceContract.test.ts \
  tests/runtime/wasmBackend.test.ts \
  tests/runtime/tauriBackend.test.ts \
  tests/runtime/gameRuntime.test.ts
```

Expected: failures from missing final types/methods and old mutating New City behavior.

## 3B. Core save/restore and validation

- [x] **Step 5: Collapse errors and save capture**

```rust
pub enum SnapshotLoadError {
    UnsupportedSchema { expected: u16, actual: u16 },
    InvalidSnapshot(String),
}
```

Make `snapshot_for_save` return an infallible paused normalized clone. Remove `SaveSnapshotCapture`.

- [x] **Step 6: Prune/normalize `map.rs`**

Retain schema, finite tick arithmetic, speed, dimensions/count/coordinates, tile/infrastructure safety, duplicate/bounds/target/reciprocal road checks, basic structure ownership/ports, growth values reached by tick, and structure compilation.

Normalize day/clock, paused, and connection ordering. Delete canonical tile IDs, exact structure reconstruction, growth history, and objective/terminal relationship forensics.

```sh
cargo test -p caelum-core --test persistence_construction
cargo test -p caelum-core
```

- [x] **Step 7: Prune/normalize `entities.rs`**

Retain ID uniqueness, bounds, building/node ownership, platform identity/assignment, waypoint/reference integrity, route↔vehicle agreement, indexes/progress, and passenger compatibility.

Normalize building footprints, stop access, platform label/capacity, route lifecycle state, and vehicle capacity. Delete canonical ID formatting and stale route-oracle equality.

```sh
cargo test -p caelum-core --test persistence_construction
cargo test -p caelum-core
```

- [x] **Step 8: Prune/normalize `trips.rs`**

Retain point/reference/index bounds and finite tick arithmetic. Normalize worker/shift and trip sequence counters. Delete endpoint-history, sim/trip equality, router-oracle equality, metrics relationship/window/objective/loss forensics, and ordering validation.

```sh
cargo test -p caelum-core --test persistence_construction
cargo test -p caelum-core
```

- [x] **Step 9: Remove prepared restore token**

Construct a candidate with `GameEngine::from_snapshot`; `restore_snapshot` assigns only after construction succeeds. Remove `PreparedEngineRestore` and detailed bridge exports.

## 3C. TypeScript and hosts

- [x] **Step 10: Replace backend persistence types**

Define the small types above. Delete `PersistenceOperationError`, request wrapper, validation result, `RuntimeSession`, `beginRuntime`, and `validateSnapshot`.

Reduce `persistence.ts` to a small mapper:

```ts
export function snapshotError(
  code: SnapshotErrorCode,
  error?: unknown,
): SnapshotError {
  return {
    code,
    diagnostic:
      error instanceof Error
        ? error.message
        : error === undefined
          ? undefined
          : String(error),
  };
}
```

Keep only enough schema recognition to distinguish `unsupportedSchema`.

- [x] **Step 11: Replace coordinator consumer type**

```ts
export type PersistenceCoordinatorBackendError =
  | SnapshotError
  | SandboxHostError;
```

Delete old operation/error taxonomy imports. Keep the outer coordinator/store model unchanged.

- [x] **Step 12: Thin WASM**

Expose a bridge backed by existing `create_sandbox_snapshot`; do not construct and assign a temporary engine. Remove standalone validation, exact bridge serialization, prepared-token helpers, and encode-failure matrix tests. The adapter implements the final methods and maps only the three codes.

- [x] **Step 13: Thin Tauri and privatize epoch**

`createTauriBackend()` calls private `game_begin_runtime` before returning and closes over the epoch. Replace `game_create_sandbox` with non-mutating `game_build_sandbox_snapshot` using `create_sandbox_snapshot`. Delete `game_validate_snapshot`. Keep stale-epoch checks on mutating/save/restore commands.

A small `game_host.rs` extraction is allowed; no trait/framework.

## 3D. Runtime integration

- [x] **Step 14: Convert Save and Load**

Save uses `snapshotForSave`; thrown save capture is non-mutating `hostFailure`.

Load:

1. capture prior canonical snapshot inside the serialized load boundary;
2. call `restoreSnapshot(candidate)`;
3. `{ ok: false }` → publish backend error without rollback;
4. thrown restore → rollback prior snapshot, then publish `hostFailure`;
5. rollback failure → existing fatal coherence path;
6. successful superseded restore → retain current prior rollback until HPA-543.

Delete separate validation. Do not re-read/publish arbitrary backend state.

- [x] **Step 15: Convert New City**

Pure build → existing persist/finalize → capture prior immediately before activation → restore → publish.

Delete the early prior capture, mutating sandbox call, candidate recapture, and rollback/orphan branches caused solely by pre-persist backend mutation.

Keep current pending/finalize reconciliation/tests. Activation `{ ok: false }` leaves record/prior gameplay. Thrown activation rolls back prior; rollback failure is fatal.

- [x] **Step 16: Verify preparatory deletions remain**

```sh
rg -n 'runtimeIdentity|BackendOwnership|backendOwnershipRegistry' src tests
rg -n 'pub context: DispatchContext|context: DispatchContext' \
  crates/caelum-core/src/intent.rs src/runtime/backend/types.ts
```

Expected: no public ownership or dispatch context.

- [x] **Step 17: Full verification before snapshot commit**

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
bun run format:check
bun run lint
bun run check
bun run test:unit
bun run build
bun run test:e2e
```

Expected: every command exits 0.

- [x] **Step 18: Commit atomic snapshot cut**

```sh
git add crates/caelum-core crates/caelum-wasm src-tauri/src \
  src/runtime tests/runtime tests/fixtures/rustSnapshot.ts
git commit -m "refactor: simplify gameplay snapshot contract"
```

Do not split this commit by host/layer.

---

# Task 4: Delete Parity and Validator Maintenance Tax

- [x] **Step 1: Delete detailed modules and suites**

Delete the files in the File Map, including the previously omitted:

- `persistence_entities_branches.rs`;
- `persistence_fixture_export.rs`.

Move the nine retained safety assertions into `persistence_construction.rs`. Remove detailed exports from `lib.rs`.

- [x] **Step 2: Delete fixtures/benchmark safely**

Delete the persistence JSON catalogue/README and export generator after confirming no non-persistence test consumes them. Delete the obsolete WASM benchmark wiring and its package/coverage entries.

Retain `tests/fixtures/rustSnapshot.ts` data still used by ordinary gameplay/UI tests.

- [x] **Step 3: Retire superseded documents**

Delete the implemented HPA-340/HPA-341 validation/parity specs/plans that prescribe the removed contract. Update remaining links to HPA-547.

- [x] **Step 4: Verify and commit cleanup**

```sh
rg -n 'PersistenceBridgeError|PersistenceOperationError' crates src-tauri src tests
cargo test --workspace
bun run format:check
bun run lint
bun run check
bun run test:unit
bun run build
git add -A
git commit -m "test: remove obsolete host parity machinery"
```

Expected: public bridge taxonomy appears only in HPA-547 historical/problem prose.
Internal validator plumbing in `crates/caelum-core/src/persistence/error.rs`
(`PersistenceError`, `SnapshotField`, `DerivedStateError`, and related types)
remains `pub(crate)` and is mapped to the small public snapshot-error boundary;
all commands exit 0.

---

# Task 5: Architecture and Scope Audit

- [x] **Step 1: Update current architecture docs**

Document both hosts, nine-method backend, private epoch, pure sandbox, candidate-first restore, thrown-restore rollback, three errors without operation, public dispatch-context removal, retained private/preview impact, and HPA-543/HPA-548 boundaries.

- [x] **Step 2: Run contract and scope greps**

```sh
rg -n 'runtimeIdentity|RuntimeSession|validateSnapshot|BackendOwnership|PreparedEngineRestore|SaveSnapshotCapture' \
  crates src src-tauri tests docs CLAUDE.md
rg -n 'PersistenceBridgeError|PersistenceOperationError|PERSISTENCE_REASON_KINDS' \
  crates src src-tauri tests docs
rg -n 'buildSandboxSnapshot|create_sandbox_snapshot|game_build_sandbox_snapshot' \
  crates src src-tauri tests docs
rg -n 'SharedPersistenceCoordinator|PersistenceLease|cityQueues|pending|finalizeWorkingSave' \
  src/runtime src/persistence tests/runtime
```

Expected: removed terms only in historical explanation; pure sandbox exists in both adapters; current HPA-543/HPA-548 machinery remains.

- [x] **Step 3: Final verification and net deletion**

```sh
bun run format:check
bun run lint
bun run check
bun run build
bun run test
bun run test:e2e
cargo test --workspace
git diff --stat origin/main...HEAD
git diff --numstat origin/main...HEAD | \
  awk '{ add += $1; del += $2 } END { print "added", add, "deleted", del, "net", add-del }'
```

Review gate: production/test code shows material net deletion; documentation additions do not excuse growth; no replacement platform appears.

- [x] **Step 4: Commit docs**

```sh
git add docs/architecture.md CLAUDE.md \
  docs/superpowers/specs/2026-08-05-thin-dual-gameplay-hosts-design.md \
  docs/superpowers/plans/2026-08-05-thin-dual-gameplay-hosts.md
git commit -m "docs: align architecture with thin gameplay hosts"
```

---

## Final Checklist

- [x] Both hosts remain functional and use `create_sandbox_snapshot`.
- [x] `GameBackend` has nine methods; session/identity/validation are gone.
- [x] Tauri epoch is private and stale-epoch test remains.
- [x] Errors are three categories with optional diagnostic and no operation field.
- [x] Matrix decisions and candidate order are implemented.
- [x] Nine construction tests pass, including separate reciprocity/compiler failures.
- [x] Save capture is paused/infallible and does not mutate live state.
- [x] Definitive restore rejection preserves state.
- [x] Thrown Load/New City restore rolls back; rollback failure is fatal.
- [x] No new pending/finalize reconciliation tests were added.
- [x] Public dispatch context is gone; private apply/preview impact remains.
- [x] Detailed taxonomy, fixtures, matrices, benchmark, and missing delete-list files are gone.
- [x] Full format/lint/check/build/unit/e2e/Rust verification passes.
- [x] Production/test code is materially smaller.

## Commit Sequence

1. `refactor: remove unused dispatch impact from host wire`
2. `refactor: remove backend ownership coordination`
3. `refactor: simplify gameplay snapshot contract`
4. `test: remove obsolete host parity machinery`
5. `docs: align architecture with thin gameplay hosts`

Commits 1–2 are independently green. Do not split commit 3 by core/WASM/Tauri/TypeScript.
