# HPA-547: Thin Dual Gameplay Hosts Around `caelum-core`

**Status:** Proposed for implementation

**Linear:** [HPA-547](https://linear.app/cwchanap/issue/HPA-547/foundation-minimize-nativewasm-host-duplication-around-caelum-core)

**Parent decision:** [HPA-342](https://linear.app/cwchanap/issue/HPA-342/decision-shared-rust-core-with-thin-nativewasm-hosts-and-minimal-multi)

## Outcome

Caelum keeps both current gameplay hosts while removing the ownership, parity, and forensic validation machinery that makes them expensive to maintain.

- `caelum-core` remains the only gameplay implementation.
- Tauri/native Rust remains the intended desktop release host.
- WASM/browser remains the fast Vite, Playwright, and lightweight demo host.
- Both expose one small TypeScript `GameBackend` used by the shared Svelte runtime.
- Tauri session details remain private to the Tauri adapter.
- Snapshot restore remains candidate-first, so a failed load never partially replaces active gameplay.
- New City can build a sandbox candidate without mutating the active engine.
- Production and test code show material net deletion.

This is a simplification project, not a host migration. Removing the native host would discard the intended product architecture. Removing WASM would slow the established development loop without evidence that its wrapper cost exceeds its value.

## Problem

HPA-340 and HPA-341 established a safe persistence boundary, but the implementation optimized for exact cross-host parity and hostile-input diagnostics before the game had a player-facing save flow.

The resulting maintenance surface includes:

- a public `beginRuntime` and `RuntimeSession` contract shared by hosts that do not share the same lifecycle needs;
- `runtimeIdentity`, a module-level backend ownership registry, and object/`WeakMap` fallback coordination;
- a public `validateSnapshot` operation even though candidate-first restore already validates before activation;
- prepared save/restore tokens and encode-before-commit rules maintained mainly for exact host parity;
- a large Rust persistence field/reason taxonomy mirrored through WASM, Tauri, TypeScript, fixtures, and tests;
- exact-shape JavaScript guards for values produced by the same local application;
- generated fixtures, benchmarks, and cross-product test matrices that make ordinary gameplay schema changes expensive;
- `DispatchResult.context`, including full-map impact calculation, even though production TypeScript does not consume it.

The shared Rust core already prevents gameplay-rule duplication. The remaining cost comes from making host transport and snapshot diagnostics behave like a public platform contract.

## Scope

HPA-547 owns one atomic breaking change across the gameplay host boundary:

1. simplify `caelum-core` save and candidate construction;
2. thin the WASM bridge;
3. thin the Tauri bridge while keeping a private stale-webview epoch;
4. reduce the TypeScript `GameBackend` contract;
5. remove JavaScript backend ownership coordination;
6. minimally adapt runtime Save, Load, and New City call sites;
7. remove unused dispatch impact data;
8. delete tests, fixtures, benchmarks, and documentation that specify removed behavior.

These changes land together. Temporary dual APIs, deprecated aliases, compatibility adapters, and old fixtures are explicitly rejected.

### Left to HPA-548

HPA-548 replaces the current `SaveStore` and envelope surface with the six essential multi-city operations: list, read, create, update, rename, and delete.

### Left to HPA-543

HPA-543 replaces persistence leases, queues, revisions, pending/finalize reconciliation, recovery state, and supersession handling with active city metadata, one busy gate, and one dirty boolean.

HPA-547 may remove New City backend rollback that becomes unnecessary after sandbox construction is pure. It must not otherwise implement HPA-543 early.

## Design Principles

1. **One gameplay authority.** Gameplay rules, snapshot construction, and engine invariants live in `caelum-core`.
2. **Two justified wrappers, not a host platform.** `GameBackend` exists because there are two current implementations. It is not a plugin API.
3. **Candidate first.** Build or restore a complete candidate before replacing the active engine.
4. **Small UI errors.** UI behavior depends on three snapshot categories, not internal Rust reason trees.
5. **Normalize known derived values.** Recompute cheap deterministic values instead of rejecting same-app saves for forensic mismatches.
6. **Protect construction, not every corruption theory.** Retain checks needed to prevent panic, unsafe indexing, impossible topology, or immediate unusable state.
7. **Breaking changes are preferred.** Development saves are disposable; old contracts are deleted in the same change.
8. **Tests follow player behavior.** Happy path plus one representative failure per operation; no parity cross product.
9. **Net deletion is a requirement.** Replacing removed machinery with a new abstraction fails the design.

## Public TypeScript Contract

`src/runtime/backend/types.ts` owns the small runtime contract and raw Rust wire types.

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

Exact type names may follow existing repository conventions. The resulting surface must preserve these semantics.

### Contract rules

- Remove `runtimeIdentity`, `RuntimeIdentity`, `RuntimeSession`, and public `beginRuntime`.
- Remove public `validateSnapshot`.
- Pass the snapshot directly to `restoreSnapshot`; do not keep a `{ snapshot }` wrapper unless a current call site proves useful.
- Keep sandbox form errors separate because New City currently benefits from field-level validation feedback.
- `diagnostic` is optional developer information. It is not a parity contract and may differ by host.
- Production UI branches only on `unsupportedSchema`, `invalidSnapshot`, and `hostFailure`.
- Do not add capabilities, factories, registries, dependency-injection containers, generated interfaces, or host plugin infrastructure.

## Snapshot Error Mapping

### `unsupportedSchema`

Return when a schema probe identifies a version other than the current development schema. Missing or unreadable schema identity may also map here when the host cannot identify a supported current snapshot.

The UI may offer clear/reset behavior. No migration path is provided.

### `invalidSnapshot`

Return when the value has the current schema but cannot deserialize into a usable `GameSnapshot`, violates a construction-safety requirement, or cannot compile into a usable engine.

The UI does not display the detailed Rust reason. A development diagnostic may be logged.

### `hostFailure`

Return for transport, serializer, managed-state, mutex, or unexpected adapter failures outside candidate validity.

Host diagnostics may differ. Exact error serialization parity is not required.

## `caelum-core` Save and Restore Policy

### Save capture

`GameEngine::snapshot_for_save` returns a cloned, persistence-ready snapshot and does not validate the active engine against the removed forensic catalogue.

Conceptually:

```rust
pub fn snapshot_for_save(&self) -> GameSnapshot {
    let mut snapshot = self.snapshot();
    normalize_for_persistence(&mut snapshot);
    snapshot
}
```

The normalization is direct and bounded:

- set `paused = true`;
- recompute `day` and `clock_minutes` from authoritative simulation time;
- apply an existing cheap canonical ordering helper only where one already exists and avoids downstream instability.

The live engine is unchanged.

### Candidate construction

`GameEngine::from_snapshot` remains the single typed construction boundary. It:

1. receives a fully deserialized current-schema `GameSnapshot`;
2. applies the same direct persistence normalization;
3. checks only structural and reference properties required for safe engine use;
4. rebuilds non-serialized `RoadTopology` and other required caches;
5. returns a complete candidate engine.

Conceptually:

```rust
pub enum SnapshotLoadError {
    UnsupportedSchema { expected: u16, actual: u16 },
    InvalidSnapshot(String),
}

impl GameEngine {
    pub fn from_snapshot(
        snapshot: GameSnapshot,
    ) -> Result<Self, SnapshotLoadError>;

    pub fn restore_snapshot(
        &mut self,
        snapshot: GameSnapshot,
    ) -> Result<GameSnapshot, SnapshotLoadError>;
}
```

`restore_snapshot` constructs the candidate first and assigns `self` only after construction succeeds. A failed restore leaves the active engine unchanged.

### Retained checks

Keep checks that prevent one of the following:

- unsupported schema interpretation;
- invalid fixed map dimensions or tile count;
- out-of-bounds tile/entity access;
- duplicate identities where indexes require uniqueness;
- missing required references used immediately by the engine;
- invalid route, trip, vehicle, or platform indexes that would panic or immediately dereference invalid data;
- impossible topology compilation;
- non-finite or out-of-range values that would break immediate simulation arithmetic;
- engine construction that would produce an immediately unusable state.

The exact implementation may reuse small parts of the current validator. It must not preserve the public error taxonomy merely because a check remains.

### Normalized instead of rejected

Normalize a value only when it has one obvious, existing derivation:

- `day` and `clock_minutes` from `time`;
- paused persistence state;
- non-serialized topology and caches;
- cheap deterministic ordering through an existing helper.

Do not add a repair registry, migration pipeline, warning list, or partial recovery model.

### Removed validation policy

Delete checks whose primary purpose is explaining exactly how a same-app snapshot differs from the current in-memory catalogue, including:

- canonical ID string formatting when uniqueness and references are sufficient;
- exact serialized collection ordering that can be normalized or is irrelevant to construction;
- route oracle equality and idempotence;
- exact route-leg cache equality;
- exact trip position and derived trip state matching;
- trip sequence and derived counter forensics that do not protect indexing;
- metrics relationship and rolling outcome-window catalogues;
- objective/loss-state forensic matching;
- active-engine validation during save capture.

## WASM Host

`WasmGameEngine` remains instance-local. No epoch or ownership coordination is required.

### `buildSandboxSnapshot`

Construct a temporary `WasmGameEngine` or core candidate from the request and return its snapshot. Do not assign it to the active WASM engine.

### `restore_snapshot`

- probe schema;
- deserialize the value;
- call candidate-first core construction;
- assign `inner` only on success;
- return the accepted snapshot.

### Error boundary

The Rust/WASM bridge may return compact internal failures. `wasmBackend.ts` maps them to the three TypeScript categories. It does not validate a mirrored exhaustive reason tree.

### Removed WASM machinery

- exported `validate_snapshot`;
- `PersistenceBridgeError` exact-shape encoding;
- prepared restore encoding helpers;
- synthetic exact encode-before-commit tests;
- exhaustive bridge-error variant tests.

## Tauri Host

Tauri remains the native desktop product path with one managed `GameEngine`.

A small `src-tauri/src/game_host.rs` extraction is allowed and recommended because `src-tauri/src/lib.rs` currently mixes application bootstrap, gameplay commands, bridge errors, and a large test module. This is a responsibility split, not a framework.

### Private epoch

Keep:

```rust
struct OwnedEngine {
    engine: GameEngine,
    runtime_epoch: u64,
}
```

Keep an internal `game_begin_runtime` command that increments the epoch and returns the epoch plus current snapshot atomically.

`createTauriBackend()` calls `game_begin_runtime` before returning. It closes over the epoch and sends it with mutating commands and `snapshotForSave`. The returned `GameBackend` exposes neither `beginRuntime` nor the epoch.

This retains stale-webview protection while removing host-specific lifecycle policy from the shared runtime.

### Native commands

Keep transport-only commands for snapshot, dispatch, tick, save capture, restore, reset, route preview, and road preview.

Replace mutating sandbox creation with pure candidate construction:

```text
game_build_sandbox_snapshot(request) -> snapshot
```

The command does not lock or replace the managed engine.

Delete `game_validate_snapshot`.

Restore performs decode and candidate construction before taking the managed-engine lock. Immediately before assignment it verifies the private epoch. A stale epoch or failed candidate leaves managed state unchanged.

Exact encode-before-commit response parity is removed. A response serialization failure is a host failure, not a reason to preserve a prepared-token protocol.

## Shared Runtime Integration

HPA-547 changes only the host-facing seams necessary to consume the new contract.

### Initialization

- remove backend ownership coordinator acquisition and release;
- remove `beginRuntime` fallback;
- initialize from `await backend.snapshot()`.

The existing persistence lease/coordinator remains until HPA-543.

### Load

- read the stored snapshot through the current store/envelope path;
- call `restoreSnapshot(snapshot)` once;
- publish new active gameplay identity only after success;
- preserve current gameplay and identity on failure.

There is no separate validation call.

### Save

Use `snapshotForSave()` and map the small error result into the current runtime persistence error surface. Do not redesign save queues, revisions, envelopes, or stores in this issue.

### New City

The current implementation mutates the backend before storage and then requires rollback, orphan cleanup, and recovery branches. Pure sandbox construction removes that need.

The minimal sequence is:

1. use the existing admission/drain mechanism;
2. capture prior public/UI state required to restore the view before activation;
3. call `buildSandboxSnapshot(request)` without changing active gameplay;
4. persist and finalize through the current store contract;
5. activate through candidate-first `restoreSnapshot(candidate)`;
6. publish the new city only after activation succeeds.

If activation unexpectedly fails after storage succeeds, leave the city record available for retry and report a retryable load/host failure. Do not delete the record and do not restore a backend that was never changed.

Remove backend rollback and cleanup branches that exist only because `createSandbox` mutated active state. Do not broadly rewrite pending/finalize recovery; HPA-543 and HPA-548 own that deletion.

## Dispatch Result Reduction

Production TypeScript does not consume `DispatchResult.context`. Remove it from the apply path and stop calculating full-map dispatch impact solely for the unused result.

Keep impact data in route and road preview responses because the current UI consumes it before applying a mutation.

This change must not alter gameplay application, rejection, cost policy, snapshot publication, or preview behavior.

## Modules and File Boundaries

Target shape:

```text
crates/caelum-core/
  authoritative gameplay, snapshot construction, restore safety

crates/caelum-wasm/
  thin WASM serialization and instance-local engine wrapper

src-tauri/src/game_host.rs
  optional focused native gameplay command/state module

src-tauri/src/lib.rs
  Tauri application bootstrap and command registration

src/runtime/backend/types.ts
  minimal GameBackend and wire types

src/runtime/backend/wasmBackend.ts
src/runtime/backend/tauriBackend.ts
  direct adapters with no gameplay rules
```

The following are removed or substantially collapsed:

```text
src/runtime/backendOwnership.ts
src/runtime/backend/persistenceContract.ts
src/runtime/backend/persistence.ts
crates/caelum-core/src/persistence_bridge.rs
```

Keep a small helper module only when both adapters actually share compact error mapping or wire normalization. Do not retain the current exhaustive taxonomy under a different name.

## Testing Strategy

### Core

Keep focused tests for:

- save capture pauses a clone without mutating live state;
- valid candidate construction;
- unsupported schema;
- one representative structurally invalid candidate;
- failed restore preserves active state;
- one deterministic save/restore behavior proof if it catches a meaningful regression.

### WASM

Keep focused tests for:

- pure sandbox candidate construction;
- dispatch and tick;
- save snapshot;
- valid restore;
- invalid restore preserving active state.

### Tauri

Keep focused tests for:

- pure sandbox candidate construction;
- dispatch and tick;
- save snapshot;
- valid restore;
- invalid restore preserving active state;
- one private stale-session check.

### TypeScript/runtime

Keep focused tests for:

- `GameBackend` contains only current methods;
- three-category snapshot mapping;
- initialization uses `snapshot` directly;
- load performs one candidate-first restore;
- New City does not mutate gameplay before persistence;
- activation failure leaves the persisted record and current gameplay intact;
- removed ownership registry no longer participates in construction/disposal.

### Delete

Delete tests and fixtures that exist only for:

- exact native/WASM error-shape parity;
- exhaustive Rust field/reason branches;
- hostile JavaScript prototype/sparse-array/exact-key guards;
- prepared-token and encode-before-commit parity;
- complete host cross-product matrices;
- backend ownership registry semantics;
- persistence benchmark evidence for the removed validation pipeline;
- generated giant corruption fixtures.

Coverage percentage is not a reason to retain deleted behavior.

## Security and Compatibility

The current input boundary is same-application local development saves. Retain candidate construction, structural safety, narrow Tauri commands, and generic errors.

Do not add:

- encryption, signing, checksums, or HMAC;
- import limits or public file hardening;
- fuzz/security matrices;
- forensic repair;
- migration or fallback formats;
- compatibility aliases;
- multi-process or multi-window coordination.

This is a breaking development change. Update both hosts, runtime call sites, current fixtures, and documentation together. Increment the development schema if the serialized snapshot changes and clear old saves.

## Documentation Updates

Update `docs/architecture.md` and `CLAUDE.md` only where they describe the current public session, validation, parity, or dispatch-context behavior.

Retire or mark superseded the earlier HPA-340/HPA-341 documents only where needed to prevent future implementers from treating their exhaustive parity requirements as current architecture. Git history remains the detailed archive.

Do not broadly rewrite unrelated architecture documentation.

## Acceptance Criteria

- [ ] Native Tauri gameplay remains the desktop release path.
- [ ] Browser/WASM remains functional for development and tests.
- [ ] All gameplay rules live only in `caelum-core`.
- [ ] `GameBackend` contains only methods the current runtime calls.
- [ ] Runtime identity, public sessions, JavaScript ownership coordination, and host registries are removed.
- [ ] Tauri epoch handling is private to `createTauriBackend` and the native host.
- [ ] Both hosts build a sandbox candidate without mutating active gameplay.
- [ ] Restore is candidate-first and exposes only the small UI error contract.
- [ ] `snapshotForSave` does not run the active engine through the exhaustive corruption validator.
- [ ] The detailed field/reason taxonomy is no longer a frontend or cross-host parity contract.
- [ ] Exact error parity, giant fixtures, persistence benchmarks, and exhaustive host matrices are removed.
- [ ] `DispatchResult.context` is removed while preview impact remains.
- [ ] HPA-548 and HPA-543 responsibilities are not implemented prematurely.
- [ ] Production and test code show material net deletion.

## Non-goals

- Replacing native gameplay with WASM.
- Removing the browser target without measured evidence.
- Rewriting `createGameRuntime.ts` outside the affected host call sites.
- Replacing the current save store or envelope.
- Removing persistence coordination beyond backend ownership and New City backend rollback.
- Native performance optimization without profiling.
- Public import/export, migrations, cloud sync, accounts, mods, networking, autosave, checkpoints, or recovery.
- Formal Clean Architecture layers or a host plugin platform.
