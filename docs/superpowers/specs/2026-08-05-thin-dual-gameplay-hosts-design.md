# HPA-547: Thin Dual Gameplay Hosts Around `caelum-core`

**Status:** Proposed for implementation

**Linear:** [HPA-547](https://linear.app/cwchanap/issue/HPA-547/foundation-minimize-nativewasm-host-duplication-around-caelum-core)

**Parent decision:** [HPA-342](https://linear.app/cwchanap/issue/HPA-342/decision-shared-rust-core-with-thin-nativewasm-hosts-and-minimal-multi)

## Outcome

Caelum keeps both current gameplay hosts while removing the ownership, parity, and forensic-validation machinery that makes them expensive to maintain.

- `caelum-core` remains the only gameplay implementation.
- Tauri/native Rust remains the intended desktop release host.
- WASM/browser remains the fast Vite, Playwright, and lightweight-demo host.
- Both expose one small TypeScript `GameBackend` used by the shared Svelte runtime.
- Tauri epoch/session details remain private to the Tauri adapter.
- Snapshot restore remains candidate-first, so a failed load never partially replaces active gameplay.
- New City builds a sandbox candidate without mutating the active engine.
- Production and test code show material net deletion.

This is a simplification project, not a host migration. Removing the native host would discard the intended product architecture. Removing WASM would slow the established development loop without evidence that its wrapper cost exceeds its value.

## Problem

HPA-340 and HPA-341 established a safe persistence boundary, but the implementation optimized for exact cross-host parity and hostile-input diagnostics before the game had a player-facing save flow.

The resulting maintenance surface includes:

- public `beginRuntime` and `RuntimeSession` concepts shared by hosts with different lifecycle needs;
- `runtimeIdentity`, a module-level backend ownership registry, and an object/`WeakMap` fallback;
- a public `validateSnapshot` operation even though candidate-first restore already validates before activation;
- prepared save/restore tokens and encode-before-commit rules maintained mainly for exact host parity;
- a large Rust persistence field/reason taxonomy mirrored through WASM, Tauri, TypeScript, fixtures, and tests;
- exact-shape JavaScript guards for values produced by the same local application;
- generated fixtures, benchmarks, and cross-product test matrices that make ordinary gameplay schema changes expensive;
- `DispatchResult.context` on the host wire even though production TypeScript ignores it.

The shared Rust core already prevents gameplay-rule duplication. The remaining cost comes from treating host transport and snapshot diagnostics as a public platform contract.

## Scope

HPA-547 owns one atomic breaking change across the gameplay host boundary:

1. simplify `caelum-core` save and candidate construction;
2. thin the WASM bridge;
3. thin the Tauri bridge while keeping a private stale-webview epoch;
4. reduce the TypeScript `GameBackend` contract;
5. remove JavaScript backend ownership coordination;
6. minimally adapt runtime Save, Load, and New City call sites;
7. remove unused dispatch impact from the public dispatch wire while preserving internal apply behavior and preview impact;
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
8. **Tests follow retained behavior.** Cover each distinct construction-safety class once, plus the player/host operations. Do not rebuild a field/reason matrix.
9. **Net deletion is a requirement.** Replacing removed machinery with a new abstraction fails the design.

## Public TypeScript Contract

`src/runtime/backend/types.ts` owns the small runtime contract and raw Rust wire types.

```ts
export type SnapshotOperation = "snapshotForSave" | "restoreSnapshot";

export type SnapshotErrorCode =
  | "unsupportedSchema"
  | "invalidSnapshot"
  | "hostFailure";

export interface SnapshotError {
  operation: SnapshotOperation;
  code: SnapshotErrorCode;
  // Development logging only. Host text may differ and the UI must not parse it.
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

Rules:

- Do not keep the `{ snapshot }` request wrapper.
- Do not expose standalone `validateSnapshot`.
- Keep sandbox form errors separate because the New City form consumes field-level feedback.
- `buildSandboxSnapshot` may reject only for an unexpected host/transport failure. The runtime catches that rejection and maps it to `SandboxHostError`.
- `diagnostic` is for logs only. UI behavior branches on `code`.
- Do not add capabilities, plugins, registries, factories, dependency-injection containers, or code generation.

## Runtime Consumer Error Seam

HPA-547 must update the existing persistence coordinator as a consumer of the new host contract, without redesigning the coordinator.

```ts
export type PersistenceCoordinatorBackendError =
  | SnapshotError
  | SandboxHostError;
```

The existing outer shape remains:

```ts
export type PersistenceCoordinatorError =
  | { kind: "store"; error: SaveStoreError }
  | { kind: "envelope"; error: SaveEnvelopeError }
  | { kind: "backend"; error: PersistenceCoordinatorBackendError }
  | { kind: "sandbox"; error: SandboxCreationError }
  | { kind: "precondition"; error: PersistenceCoordinatorPreconditionError };
```

This is a direct type replacement, not a compatibility wrapper:

- Save and Load propagate `SnapshotError`.
- An unexpected rejection from `buildSandboxSnapshot` becomes `SandboxHostError`.
- Expected sandbox request failures remain `{ kind: "sandbox", error: SandboxCreationError }`.
- Delete `PersistenceOperationError` and do not retain a three-code version of the old taxonomy.

## Core Snapshot Construction

### Target Rust surface

Exact names may follow existing Rust conventions, but the public behavior is equivalent to:

```rust
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

`SnapshotLoadError` is not serialized as a detailed public reason tree. Hosts map it to the three TypeScript categories.

### Save capture

`snapshot_for_save`:

1. clones the authoritative engine snapshot;
2. sets `paused = true` on the clone;
3. normalizes direct deterministic derived fields;
4. returns the clone without validating the active engine against the import corruption catalogue;
5. does not mutate live gameplay.

`SaveSnapshotCapture` is removed.

### Restore

Restore remains candidate-first:

1. probe schema before full decode;
2. deserialize the current `GameSnapshot`;
3. normalize direct deterministic derived values;
4. run retained construction-safety checks;
5. compile `RoadTopology` and construct a complete candidate engine;
6. replace the active engine only after all prior steps succeed.

`PreparedEngineRestore` and encode-before-commit parity ceremony are removed. A host response-encoding failure is a `hostFailure`; it does not require a second prepared-token transaction.

## Validator Retain / Normalize / Delete Matrix

The existing entry points are:

- `persistence::map::validate_shell_rules_map_and_compile`;
- `persistence::entities::validate_entities`;
- `persistence::trips::validate_trips`.

Implementation must prune these functions deliberately. Deleting their tests without deleting their forensic checks is not sufficient, and deleting a construction-safety check to achieve net LOC reduction is not acceptable.

### `map.rs`: shell, map, and topology

| Current validation class | Action | Reason |
| --- | --- | --- |
| schema version | **Retain** and map to `UnsupportedSchema` | Required breaking-schema boundary |
| finite/non-negative simulation time and bounded conversion to day index | **Retain** | Prevent invalid arithmetic and conversion behavior |
| `day` and `clock_minutes` equality with `clock::day_index` / `clock::clock_minutes` | **Normalize** from `time` | Cheap direct derivation |
| paused persistence mode | **Normalize** to `true` for save and load | Working saves always activate paused |
| supported speed values | **Retain** | Immediate engine behavior depends on the closed speed set |
| fixed map width/height and exact tile count | **Retain** | Prevent invalid indexing and topology assumptions |
| tile coordinates within the fixed row-major grid | **Retain** | Required for safe indexed map access |
| tile kind/infrastructure combinations required by topology compilation | **Retain** | Prevent impossible topology construction |
| road connection bounds, target-road existence, and reciprocal connectivity | **Retain** where not already guaranteed by `RoadTopology::compile` | Required construction safety; avoid duplicate checks when compile already proves the same invariant |
| `RoadTopology::compile` success | **Retain** | Required non-serialized engine state |
| unique/non-overlapping road-structure footprint required for compile/access | **Retain** | Prevent ambiguous ownership and unsafe lookup |
| canonical tile ID text | **Delete** | Uniqueness/coordinates are sufficient for current construction |
| canonical road-connection ordering | **Normalize** with the existing heading ordering helper or delete if ordering is not consumed | Do not reject a safely sortable collection |
| exact serialized roundabout/automatic-junction canonical reconstruction beyond compile safety | **Delete** | Forensic equality, not current player behavior |
| sandbox/campaign objective, growth-wave, metric-terminal consistency catalogues | **Delete** unless a specific condition is required for immediate safe engine use | Campaign/growth is not a current player workflow and same-app saves are disposable |
| exact growth-wave ordering/application history checks | **Delete** | Forensic consistency; not construction safety |

### `entities.rs`: indexes and references

| Current validation class | Action | Reason |
| --- | --- | --- |
| non-empty entity IDs | **Retain** | Required stable index keys |
| global duplicate entity IDs across kinds | **Retain** | Prevent ambiguous lookup |
| duplicate keys within route/platform/vehicle indexes | **Retain** | Prevent overwrite/ambiguous ownership |
| required references exist (sim, node, platform, route, vehicle, passenger) | **Retain** | Prevent immediate invalid engine access |
| point/footprint bounds used for occupancy/indexing | **Retain** | Prevent out-of-bounds access |
| route waypoint and platform indexes in range | **Retain** | Prevent unsafe indexing |
| vehicle itinerary/path indexes in range | **Retain** | Prevent unsafe indexing |
| canonical numbered ID string shape (`route-001`, `trip-day-*`, platform suffix formatting) | **Delete** | Key uniqueness and required references are sufficient |
| exact platform ordering/labels | **Delete** unless runtime indexing consumes the serialized order directly | Presentation/canonical forensics |
| exact ownership reciprocity and cached reverse-list equality | **Delete** when indexes can be rebuilt from authoritative forward references | Rebuild instead of reject |
| route-leg/path equality with a fresh routing oracle | **Delete** | Expensive forensic parity |
| route revision/value ranges required by direct indexing or arithmetic | **Retain** only where immediate use requires it | Safety, not history forensics |

### `trips.rs`: active trips and derived metrics

| Current validation class | Action | Reason |
| --- | --- | --- |
| required sim/vehicle/route references | **Retain** | Prevent invalid lookup |
| world points and itinerary/path indexes within bounds | **Retain** | Prevent invalid access |
| finite deadline/patience/position values used immediately by tick | **Retain** | Prevent invalid arithmetic |
| duplicate active-trip IDs/index keys | **Retain** through entity indexing | Prevent ambiguous lookup |
| trip ID canonical text and sequence formatting | **Delete** | Uniqueness is sufficient |
| exact worker profile/shift derivation from ID | **Delete** | Forensic deterministic catalogue |
| exact trip endpoint/state relationship | **Delete** unless a mismatch would panic on the next tick | Gameplay history forensics |
| exact trip position equality with sim position | **Delete** | Forensic derived-state equality |
| exact route-plan equality with current router output | **Delete** | Expensive oracle equality |
| trip counter and next-sequence equality with existing trips | **Normalize** only if there is one cheap authoritative derivation; otherwise retain the minimum monotonic bound needed to avoid collision | Avoid a repair framework |
| metrics counter relationships, rolling outcome window, objective state, and loss-reason equality | **Delete** | UI diagnostics/history forensics |
| collection ordering | **Normalize** only with existing helpers and only when runtime behavior depends on deterministic order | No new generic normalization pipeline |

### Error policy

All retained non-schema failures map to `invalidSnapshot`. Internal Rust diagnostics may name the failed condition, but TypeScript and UI do not mirror it.

### Test policy for the retained surface

Retain one focused test for each distinct construction-safety class:

1. unsupported schema;
2. wrong map size or tile count;
3. duplicate entity ID used as an index key;
4. missing required reference or out-of-bounds index;
5. topology compile failure;
6. failed restore preserves the active engine;
7. save capture is paused while the live engine is unchanged;
8. one deterministic round-trip of an engine-minted save.

These are not a field/reason cross product. They are the minimum regression set for materially different panic/construction classes.

## Pure Sandbox Candidate

The core already exposes:

```rust
pub fn create_sandbox_snapshot(
    request: SandboxCreationRequest,
) -> Result<GameSnapshot, SandboxCreationError>;
```

Both hosts reuse this function.

- WASM exposes a thin static/free bridge that returns the snapshot.
- Tauri exposes `game_build_sandbox_snapshot` and does not lock or mutate managed engine state.
- TypeScript calls this through `buildSandboxSnapshot`.
- `GameEngine::from_sandbox_request` remains for code that actually needs a live engine.
- Do not construct a temporary engine merely to call `.snapshot()` when the pure function already exists.

## WASM Host

`WasmGameEngine` remains instance-local.

Keep:

- ordinary `snapshot`, `dispatch`, `tick`, `reset`, and previews;
- `snapshot_for_save`;
- candidate-first `restore_snapshot`;
- a thin bridge to `create_sandbox_snapshot`.

Remove:

- `validate_snapshot`;
- exact `PersistenceBridgeError` serialization;
- prepared-token encoding helpers;
- encode-failure transaction tests;
- exact error-shape and host-parity matrices.

The TypeScript WASM adapter maps:

- schema probe mismatch to `unsupportedSchema`;
- deserialization or retained construction failure to `invalidSnapshot`;
- unexpected bridge/transport failures to `hostFailure`.

## Tauri Host

### Private epoch

Retain `OwnedEngine { engine, runtime_epoch }` and internal `game_begin_runtime`.

`createTauriBackend()` invokes `game_begin_runtime` before returning and closes over the epoch. The returned `GameBackend` exposes neither the epoch nor `beginRuntime`.

Mutating commands and `snapshotForSave` carry the private epoch. One focused native test proves that a stale epoch cannot mutate after a newer backend session starts.

### Commands

Keep thin commands for:

- snapshot;
- begin runtime (private adapter bootstrap);
- dispatch;
- tick;
- reset;
- save snapshot;
- restore snapshot;
- route preview;
- road preview.

Replace mutating `game_create_sandbox` with pure `game_build_sandbox_snapshot`.

Delete `game_validate_snapshot`.

Native diagnostics may remain strings. The frontend receives only the three snapshot error categories.

A small `src-tauri/src/game_host.rs` extraction is permitted because `lib.rs` currently mixes app bootstrap, host transport, error-wire machinery, and a large test module. Do not add a trait, host registry, or framework.

## Dispatch Impact Boundary

The design removes dispatch impact from the public host wire only. It must not remove internal information required to apply gameplay mutations.

### Layer 1: public `DispatchResult`

Change the serialized/public result to:

```rust
pub struct DispatchResult {
    pub snapshot: GameSnapshot,
    pub applied: bool,
    pub rejection: Option<GameplayRejection>,
}
```

TypeScript mirrors the same shape. `normalizeDispatchResult` continues to normalize nullable rejection but has no context branch.

### Layer 2: private core apply machinery

Keep or simplify private data needed by mutation application, including:

- changed/skipped tiles used while normalizing road mutation results;
- route lifecycle recomputation inputs;
- affected-route calculation required to commit a valid candidate;
- cost or footprint data required by mutation helpers.

`DispatchContext` may remain as a private/internal struct, be split into smaller private structs, or be replaced by local values. It must not be exported or serialized merely for tests.

Existing tests that assert `result.context.*` must be rewritten to assert observable snapshot/rejection behavior, unless the asserted value belongs to a preview response.

### Layer 3: preview responses

Route and road preview impact stays unchanged because the UI consumes it:

- changed/skipped tiles;
- cost;
- warnings;
- route impacts;
- generated structures;
- rejection context.

Before deletion, the implementation must classify every `DispatchContext`/`.context` match into public wire, private apply, or preview. Only the public-wire bucket is required to disappear.

## Runtime Integration

### Initialization

- Delete backend ownership acquisition/release.
- Delete `runtimeIdentity`, registry reset hooks, and `WeakMap` fallback.
- Initialize from `await backend.snapshot()`.
- Leave the existing persistence lease/coordinator intact for HPA-543.

### Save

- Call `snapshotForSave`.
- Propagate `SnapshotError` through `PersistenceCoordinatorBackendError`.
- Do not change queues, revisions, envelopes, or store behavior.

### Load

- Remove the separate validation call.
- Call `restoreSnapshot(snapshot)` once.
- Publish active city identity and runtime state only after restore succeeds.
- Failed restore leaves current gameplay and active identity unchanged.

### New City sequence

1. Admit/drain through the existing runtime mechanisms.
2. Preserve only prior public/UI state needed to resume the current view on failure.
3. Call pure `buildSandboxSnapshot`; the active backend remains unchanged.
4. Persist/finalize the candidate through the existing store contract.
5. Activate through candidate-first `restoreSnapshot`.
6. Publish the new runtime and active city only after activation succeeds.

Backend snapshot capture and backend rollback are removed from this sequence.

### New City post-conditions

| Failure point | Backend state | Store state | Active city/public runtime |
| --- | --- | --- | --- |
| sandbox request rejected | unchanged | no write | unchanged; field-level sandbox error |
| sandbox host/transport failure | unchanged | no write | unchanged; `SandboxHostError` |
| disposal after pure build but before persistence | unchanged | no write | disposed; no publication |
| definite create/finalize failure before commit | unchanged | no active record | unchanged; existing store error |
| ambiguous create/finalize failure | unchanged | existing coordinator reconciliation decides pending/active/unknown | unchanged unless current reconciliation proves the record active; do not add new recovery behavior |
| persistence succeeds, restore fails | unchanged because restore is candidate-first | active record remains available | unchanged; retryable backend/load error |
| disposal after persistence succeeds but before restore/publication | unchanged | active record remains available | disposed; no publication |
| restore succeeds | candidate active | active record exists | new city identity and snapshot published together |

The shorthand “persist failure means no record” is only valid for definite non-commit failures. HPA-547 retains the current pending/finalize reconciliation for ambiguous failures until HPA-543/HPA-548 remove it.

Required focused runtime tests:

1. sandbox build rejection leaves backend/store/identity unchanged;
2. definite persist failure leaves backend and active identity unchanged;
3. successful persist followed by restore failure leaves the stored record and current gameplay/identity unchanged;
4. disposal after pure build writes nothing;
5. success publishes candidate snapshot and city identity only after restore.

Do not introduce a new retry controller or recovery state. The retained record is loadable through the later city workflow.

## Test Strategy

### Core

Use the eight retained construction tests listed in the validator section. Keep ordinary domain gameplay tests where they already live.

Delete:

- error-wire catalogue tests;
- per-field/per-reason branch and coverage files;
- hostile-corruption matrices;
- prepared-token/encode-failure tests;
- persistence performance benchmarks created to justify the removed parity design.

### WASM and Tauri

For each host retain:

- pure sandbox candidate;
- dispatch/tick;
- save snapshot;
- valid restore;
- invalid restore preserving active state.

Tauri additionally retains one stale-epoch test.

No complete native/WASM cross-product parity matrix.

### Runtime

Retain:

- direct backend initialization;
- save error propagation through `SnapshotError`;
- load success and failed-load preservation;
- New City post-condition tests;
- disposal behavior affected by the pure candidate change.

Ownership-only construction/disposal tests are deleted with `backendOwnership`.

## Implementation Strategy

The public contract cannot move through independently green host/runtime commits without temporary aliases. Implementation therefore uses one **contract cut**:

1. add/adjust the focused tests against the final contract;
2. change core save/restore and construction validation;
3. change the TypeScript contract and coordinator consumer seam;
4. update both hosts;
5. update runtime call sites and remove public dispatch context;
6. run focused host/runtime checks, then full repository checks;
7. commit the contract cut only after the final interface is consistent.

During steps 2–5, partial targets may be intentionally uncompilable. Do not add temporary old/new methods to make intermediate commits green.

After the contract cut:

- delete obsolete fixtures, benchmarks, matrices, and old documentation;
- run final net-deletion and scope audits;
- update architecture documentation.

## Clean Module Target

- `crates/caelum-core` — gameplay and candidate construction only.
- `crates/caelum-wasm` — thin WASM serialization/transport.
- `src-tauri/src/game_host.rs` or existing `lib.rs` — thin native command/state wrapper.
- `src/runtime/backend/types.ts` — small runtime contract and wire mirrors.
- `src/runtime/backend/wasmBackend.ts` — direct WASM implementation.
- `src/runtime/backend/tauriBackend.ts` — direct Tauri implementation with private epoch.
- `src/runtime/persistenceCoordinator.ts` — existing coordinator with only its backend error type adapted; no lifecycle redesign.

Do not introduce abstract factories, adapter registries, generators, DI containers, host plugins, repair registries, or formal Clean Architecture layers.

## Security and Compatibility

Current snapshots come from the same local application.

Keep:

- schema probing;
- Rust deserialization;
- construction-safety bounds and required references;
- candidate-first restore;
- narrow native commands;
- generic actionable errors.

Do not add:

- encryption, signing, checksums, HMAC;
- fuzz/security matrices;
- import size limits;
- forensic repair;
- migrations or legacy readers;
- multi-process locking.

There is no backward compatibility for development saves. Increment the snapshot schema if the retained serialized shape changes, clear old saves, and delete old readers, aliases, fixtures, and tests in the same implementation PR.

## Acceptance Criteria

- [ ] Native Tauri remains the desktop release path.
- [ ] Browser/WASM remains functional for development and tests.
- [ ] All gameplay rules live only in `caelum-core`.
- [ ] `GameBackend` contains only methods the runtime currently calls.
- [ ] Runtime identity, public sessions, JavaScript backend ownership, and host registries are removed.
- [ ] Tauri epoch details are private to the Tauri adapter.
- [ ] Both hosts call the existing pure `create_sandbox_snapshot` path.
- [ ] Both hosts build a sandbox candidate without mutating active gameplay.
- [ ] Restore is candidate-first and exposes only three UI snapshot categories.
- [ ] `PersistenceCoordinatorBackendError` is concretely replaced by `SnapshotError | SandboxHostError`.
- [ ] Validator pruning follows the retain/normalize/delete matrix.
- [ ] Each retained construction-safety class has one focused regression test.
- [ ] Public `DispatchResult.context` is removed while private apply data and preview impact remain.
- [ ] New City follows the documented post-condition table.
- [ ] Exact error parity, giant fixtures, persistence benchmarks, and exhaustive host matrices are removed.
- [ ] Production and test code show material net deletion.
- [ ] No HPA-543 or HPA-548 architecture is implemented early.

## Non-goals

- Replacing native gameplay with WASM.
- Removing the browser target without measured evidence.
- Native performance optimization without profiling.
- Rewriting the SaveStore or persistence coordinator.
- Public import/export, migrations, cloud sync, accounts, mods, networking, or recovery UI.
- Formal architecture frameworks.
