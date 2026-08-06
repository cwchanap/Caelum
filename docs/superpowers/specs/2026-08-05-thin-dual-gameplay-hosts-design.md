# HPA-547: Thin Dual Gameplay Hosts Around `caelum-core`

**Status:** Implemented by HPA-547

**Linear:** [HPA-547](https://linear.app/cwchanap/issue/HPA-547/foundation-minimize-nativewasm-host-duplication-around-caelum-core)

**Parent decision:** [HPA-342](https://linear.app/cwchanap/issue/HPA-342/decision-shared-rust-core-with-thin-nativewasm-hosts-and-minimal-multi)

## Outcome

Caelum keeps both current gameplay hosts while removing the ownership, parity, and forensic validation machinery that makes them expensive to maintain.

- `caelum-core` remains the only gameplay implementation.
- Tauri/native Rust remains the intended desktop release host.
- WASM/browser remains the fast Vite, Playwright, and lightweight-demo host.
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

HPA-547 owns one breaking change across the gameplay host boundary:

1. simplify `caelum-core` save and candidate construction;
2. thin the WASM bridge;
3. thin the Tauri bridge while keeping a private stale-webview epoch;
4. reduce the TypeScript `GameBackend` contract;
5. remove JavaScript backend ownership coordination;
6. minimally adapt runtime Save, Load, and New City call sites;
7. remove unused dispatch impact from the public wire;
8. delete tests, fixtures, benchmarks, and documentation that specify removed behavior.

The save/restore API changes land together. Public dispatch-context deletion and backend-ownership deletion are independently green preparatory commits. Temporary dual snapshot APIs, deprecated aliases, compatibility adapters, and old fixtures are explicitly rejected.

### Left to HPA-548

HPA-548 replaces the current `SaveStore` and envelope surface with the six essential multi-city operations: list, read, create, update, rename, and delete.

### Left to HPA-543

HPA-543 replaces persistence leases, queues, revisions, pending/finalize reconciliation, recovery state, and supersession handling with active city metadata, one busy gate, and one dirty boolean.

HPA-547 may remove New City backend rollback that exists solely because sandbox construction mutates before persistence. It must not otherwise implement HPA-543 early.

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
export type SnapshotErrorCode =
  | "unsupportedSchema"
  | "invalidSnapshot"
  | "hostFailure";

export interface SnapshotError {
  code: SnapshotErrorCode;
  // Development logging only. Host text may differ and the UI must not parse it.
  diagnostic?: string;
}

export type SnapshotResult =
  | { ok: true; snapshot: RustGameSnapshot }
  | { ok: false; error: SnapshotError };

export interface SandboxHostError {
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
- `SnapshotError` deliberately has no `operation` field. The direct caller already knows whether it invoked save or restore, and no UI consumer branches on operation.
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
- Call sites attach operation context only in logs or local messages when useful; the shared error value does not preserve it.
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

`PreparedEngineRestore` and the cross-host encode-before-commit parity token are removed.

### Ambiguous restore transport failure

Candidate-first construction proves non-mutation only when `restoreSnapshot` resolves `{ ok: false }`. A rejected promise or thrown host/transport error is ambiguous: the host may have committed the candidate before the response was lost.

HPA-547 retains the current runtime-level prior-state rollback for operations that replace the active engine:

1. capture a canonical prior snapshot immediately before Load or New City activation;
2. call `restoreSnapshot(candidate)`;
3. on `{ ok: false }`, report the error without rollback because the candidate was not committed;
4. on a thrown/rejected restore, restore the captured prior snapshot before reporting `hostFailure`;
5. if rollback also fails or is ambiguous, enter the existing fatal backend/coherence path and stop ticks and saves;
6. if a successful restore is superseded before publication, restore the captured prior snapshot before the next queued load proceeds.

Do not replace this with “re-read the backend and publish whatever it contains.” A re-read cannot determine whether the snapshot belongs to the previous or requested city without also reconciling active-city identity, which would reintroduce a larger state machine.

`snapshotForSave` does not mutate the engine. A thrown save capture is reported as `hostFailure` without rollback or resynchronization.

## Validator Retain / Normalize / Delete Matrix

The existing entry points are:

- `persistence::map::validate_shell_rules_map_and_compile`;
- `persistence::entities::validate_entities`;
- `persistence::trips::validate_trips`.

Implementation must prune these functions deliberately. Deleting their tests without deleting their forensic checks is not sufficient, and deleting a construction-safety check to achieve net LOC reduction is not acceptable. The decisions below are resolved before implementation; the net-deletion gate must not pressure the implementer to decide safety boundaries ad hoc.

### `map.rs`: shell, map, and topology

| Current validation class | Action | Reason |
| --- | --- | --- |
| schema version | **Retain** and map to `UnsupportedSchema` | Required breaking-schema boundary |
| finite/non-negative simulation time and bounded conversion to day index | **Retain** | Prevent invalid arithmetic and conversion behavior |
| `day` and `clock_minutes` equality with `clock::day_index` / `clock::clock_minutes` | **Normalize** from `time` | Cheap direct derivation |
| paused persistence mode | **Normalize** to `true` for save and load | Working saves always activate paused |
| supported speed values | **Retain** | Immediate engine behavior depends on the closed speed set |
| finite positive demand multiplier and other scalar values used directly by tick arithmetic | **Retain** | Prevent NaN/infinite propagation |
| negative budget, starting-capital history, game-mode/economy combinations, terminal metric mode | **Delete** | Gameplay/history policy, not construction safety |
| fixed map width/height and exact tile count | **Retain** | Prevent invalid indexing and topology assumptions |
| row-major tile coordinates and in-bounds points | **Retain** | Required for safe indexed map access |
| supported tile kind and infrastructure coexistence required by gameplay/topology | **Retain** | Prevent immediately unusable map state |
| canonical tile ID text | **Delete** | Coordinates, count, and uniqueness are sufficient |
| duplicate road connections | **Retain** | Prevent ambiguous lane transitions |
| road-connection bounds, target-road existence, and reciprocal connectivity | **Retain unconditionally** | `RoadTopology::compile` does not validate these; ordinary reciprocal transitions compile infallibly |
| road-connection ordering | **Normalize** by sorting with the existing `heading_rank` helper after duplicate rejection | Deterministic direct derivation; do not reject safely sortable data |
| `RoadTopology::compile` success | **Retain** | Required non-serialized engine state |
| unique/non-overlapping structure footprint, in-bounds owned tiles, valid tile owner, unique ports, valid boundary ports | **Retain** | Compilation and map access consume these facts directly |
| roundabout/automatic-junction exact canonical reconstruction, generated IDs, lane-fact equality, movement-fact equality | **Delete** | Forensic equality beyond construction safety |
| growth-wave trigger time finiteness/non-negativity and action points/building rotations required by tick-time application | **Retain** | A loaded campaign can reach these values on the next tick; prevent invalid arithmetic or out-of-bounds application |
| growth-wave ID/order/applied-history and objective/terminal-state relationships | **Delete** | Campaign history forensics; no migration/repair promise exists |

`RoadTopology::compile` currently calls `compile_reciprocal_lane_transitions(map)` infallibly and can fail only through structure compilation. It is not a substitute for bounds, target-road, or reciprocity checks.

### `entities.rs`: indexes, ownership, routes, and vehicles

| Current validation class | Action | Reason |
| --- | --- | --- |
| non-empty entity IDs | **Retain** | Required stable index keys |
| global duplicate entity IDs across kinds | **Retain** | Prevent ambiguous lookup |
| canonical numbered ID text, trip formatting, and platform suffix formatting | **Delete** | Uniqueness and references are sufficient |
| building type/rotation and in-bounds non-overlapping footprint | **Retain** | Gameplay and removal use the footprint |
| serialized building `occupied_tiles` equality | **Normalize** from building definition, origin, and rotation | Existing direct derivation; do not reject a rebuildable cache |
| building ↔ transit-node ownership, anchor, type, and single-owner relationship | **Retain** | Both directions are consumed by gameplay/removal and cannot be inferred from one unambiguous source |
| present node bounds, structure exclusion, and spatial overlap | **Retain** | Prevent invalid indexed access and ownership |
| missing-node tombstone must still be referenced | **Retain** | Required route lifecycle invariant |
| stop `road_access` equality | **Normalize** with existing stop-access normalization | Derived cache already has an authoritative helper |
| platform count and stable platform IDs/order | **Retain** | Route assignment indexes refer to these concrete platform identities |
| platform label and capacity | **Normalize** from the existing platform factory while preserving assignments | Cheap direct derivation |
| platform route assignment uniqueness, route existence, mode, and node membership | **Retain** | Assignment is authoritative and cannot be reconstructed from waypoint membership alone |
| each route has at least two unique existing waypoints | **Retain** | Immediate route/service access invariant |
| route/line vehicle IDs exist, are unique, and agree with each vehicle’s line/mode | **Retain** | Both directions are read during tick and assignment |
| route legs and `path_broken` equality with a fresh routing oracle | **Normalize** by applying the existing route-lifecycle derivation during candidate construction | Rebuild derived paths instead of rejecting them |
| serialized route-path geometry/oracle equality after route normalization | **Delete** | Candidate uses newly derived route state |
| finite generated path durations and in-bounds generated path steps | **Retain as checks on the normalized candidate** | Prevent invalid arithmetic/index access without validating stale serialized paths |
| vehicle capacity | **Normalize** with `vehicle_capacity(mode)` | Cheap direct derivation |
| vehicle itinerary/path indexes, progress, parked position bounds | **Retain** | Tick indexes these values immediately |
| passenger IDs unique/existing and riding on the matching vehicle/line leg | **Retain** | Immediate trip/vehicle invariant |
| reverse index maps built only for validation | **Rebuild internally** | They are construction helpers, not serialized parity contracts |
| route revision | **Preserve without extra validation** | `u32` deserialization is sufficient; no additional safety range exists |

### `trips.rs`: sims, active trips, counters, and metrics

| Current validation class | Action | Reason |
| --- | --- | --- |
| sim home/position/workplace and trip origin/destination/world positions in bounds | **Retain** | Prevent invalid world access |
| finite deadline, patience, position, wait, and timestamp values used by tick | **Retain** | Prevent NaN/infinite propagation |
| required sim/vehicle/route/line references | **Retain** | Prevent invalid lookup |
| route-plan leg and current-index bounds required by current trip status | **Retain** | Tick indexes them immediately |
| duplicate active-trip IDs/index keys | **Retain** through entity indexing | Prevent ambiguous lookup |
| canonical trip ID text/zero-padding | **Delete** | Uniqueness is sufficient |
| worker profile and shift derived from sim ID | **Normalize** with the existing commute helpers | Cheap direct derivation |
| exact trip endpoint purpose/history relationship | **Delete** | Gameplay-history forensics; retain only point/reference safety |
| exact trip position equality with sim position | **Delete** | Derived-history equality |
| exact route-plan equality with a fresh router result | **Delete** | Expensive oracle equality; retain only structural/index safety |
| trip sequence day and next sequence | **Normalize** to the current day and one greater than the maximum parseable current-day generated sequence | Cheap authoritative derivation that prevents generated-ID collision without rejecting arbitrary unique IDs |
| individual metrics/outcome numeric finiteness and non-negativity used by UI/tick | **Retain** | Prevent invalid arithmetic |
| metrics counter relationships, rolling-window membership, objective state, and loss-reason equality | **Delete** | Diagnostic/history forensics |
| serialized collection ordering | **Preserve input order without validating it** | No existing consumer requires a canonical order and no new sorting framework is justified |

Candidate normalization is a small sequence of existing direct helpers, not a generic repair registry: clock fields, paused state, road-connection order, building footprints, stop access, platform display values/capacity, route lifecycle state, vehicle capacity, sim worker/shift values, and trip sequence counters.

### Candidate construction order

The implementation order is fixed so normalization helpers never consume unchecked indexes:

1. schema probe and full Rust deserialization;
2. scalar normalization (`paused`, day/clock) and road-connection sorting;
3. map dimensions/count/coordinates, road reciprocity, structure ownership, and topology compilation;
4. global entity ID registration plus required-reference and ownership checks;
5. normalize building footprints, stop access, platform display values, route lifecycle state, vehicle capacity, sim worker/shift values, and trip counters;
6. validate route/vehicle/trip indexes, finite values, and status-specific access bounds against the normalized candidate;
7. construct the candidate engine and only then replace active gameplay.

Do not call a route/trip normalization helper before the references and indexes it reads have passed their retained checks.

### Error policy

All retained non-schema failures map to `invalidSnapshot`. Internal Rust diagnostics may name the failed condition, but TypeScript and UI do not mirror it.

### Test policy for the retained surface

Retain one focused test for each distinct construction-safety class:

1. unsupported schema;
2. wrong map size or tile count;
3. duplicate entity ID used as an index key;
4. missing required reference or out-of-bounds index;
5. non-reciprocal ordinary road connection;
6. genuine `compile_structure_transitions` failure using the existing unsafe-structure setup;
7. failed restore preserves the active engine;
8. save capture is paused while the live engine is unchanged;
9. one deterministic round-trip of an engine-minted save.

These are not a field/reason cross product. They are the minimum regression set for materially different panic/construction classes. The reciprocity test must not be labeled as a topology compiler failure because ordinary lane compilation does not reject it.

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
- Initialize from `await backend.snapshot()` after the backend adapter completes any private host bootstrap.
- Leave the existing persistence lease/coordinator intact for HPA-543.

### Save

- Call `snapshotForSave`.
- Propagate `SnapshotError` through `PersistenceCoordinatorBackendError`.
- A thrown save capture is a non-mutating `hostFailure`; do not perform rollback/resync.
- Do not change queues, revisions, envelopes, or store behavior.

### Load

- Remove the separate validation call.
- Capture the canonical prior backend snapshot inside the serialized load boundary.
- Call `restoreSnapshot(snapshot)` once.
- On `{ ok: false }`, publish the backend error; candidate-first construction guarantees no mutation.
- On a thrown/rejected restore, roll back to the captured prior snapshot before reporting `hostFailure`.
- If rollback fails, enter the existing fatal backend/coherence state.
- Publish active city identity and runtime state only after restore succeeds and the load is still current.
- Keep the current superseded-success rollback until HPA-543 replaces load coordination.

### New City sequence

1. Admit/drain through the existing runtime mechanisms.
2. Preserve prior public/UI state needed to resume the current view on pre-activation failure.
3. Call pure `buildSandboxSnapshot`; the active backend remains unchanged.
4. Persist/finalize the candidate through the existing store contract.
5. Capture the canonical prior backend snapshot immediately before activation.
6. Activate through candidate-first `restoreSnapshot`.
7. On a thrown activation, roll back the prior backend snapshot; on `{ ok: false }`, no rollback is needed.
8. Publish the new runtime and active city only after activation succeeds.

The earlier snapshot capture before sandbox construction, candidate recapture, mutate-then-rollback branches, and orphan cleanup caused solely by mutating `createSandbox` are removed. The small pre-activation capture remains solely for ambiguous host delivery after `restoreSnapshot`.

### New City post-conditions owned by HPA-547

| Failure point | Backend state | Store state | Active city/public runtime |
| --- | --- | --- | --- |
| sandbox request rejected | unchanged | no write | unchanged; field-level sandbox error |
| sandbox host/transport failure | unchanged | no write | unchanged; `SandboxHostError` |
| disposal after pure build but before persistence | unchanged | no write | disposed; no publication |
| definite persistence failure before commit | unchanged | no active record | unchanged; existing store error |
| restore resolves `{ ok: false }` after persistence | unchanged | active record remains available | unchanged; backend/load error |
| restore throws after persistence and rollback succeeds | restored to prior snapshot | active record remains available | unchanged; `hostFailure` |
| restore throws and rollback fails | unknown/unsafe | active record remains available | runtime enters fatal coherence state; no further tick/save |
| restore succeeds | candidate active | active record exists | new city identity and snapshot published together |

Current ambiguous `createWorkingSave`/`finalizeWorkingSave` reconciliation remains unchanged and keeps its existing tests. HPA-547 adds no new tests that specify pending/finalize recovery semantics; HPA-543/HPA-548 own their removal.

Required focused runtime tests added or rewritten by HPA-547:

1. sandbox build rejection writes nothing and preserves backend/identity;
2. successful persist followed by definitive `{ ok: false }` activation preserves current gameplay/identity and leaves the record;
3. thrown activation rolls back the prior backend snapshot before reporting failure;
4. rollback failure enters the fatal coherence path;
5. disposal after pure build writes nothing;
6. success publishes candidate snapshot and city identity only after restore.

Do not introduce a retry controller, backend-state comparison protocol, or recovery registry.

## Test Strategy

### Core

Use the nine retained construction tests listed in the validator section. Keep ordinary domain gameplay tests where they already live.

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
- Load success, definitive rejection, ambiguous thrown restore rollback, and rollback-failure fatality;
- the HPA-547-owned New City build/activation post-conditions;
- disposal behavior affected by the pure candidate change;
- existing pending/finalize reconciliation tests unchanged, without adding new coverage for behavior HPA-543/HPA-548 will delete.

Ownership-only construction/disposal tests are deleted with `backendOwnership`.

## Implementation Strategy

Only the snapshot/save/restore API cut is inseparable. Two deletions are independently reviewable and remain repository-green:

1. remove public `DispatchResult.context` while retaining private apply and preview impact;
2. remove JavaScript backend ownership coordination and `runtimeIdentity` while leaving the existing public `beginRuntime` temporarily intact;
3. perform one atomic snapshot-contract cut across core, TypeScript types, WASM, Tauri, coordinator consumer types, and runtime call sites;
4. delete obsolete validator/parity fixtures, benchmarks, and historical contracts;
5. align architecture documentation.

No commit introduces old/new aliases. The temporary state between commits 2 and 3 still has one public `beginRuntime` used directly by the runtime; commit 3 hides it inside `createTauriBackend`.

Each commit runs formatting, lint, type checking, and both Vitest unit projects plus its focused Rust/runtime tests. The snapshot-contract cut additionally runs the production build and Playwright before commit because it changes generated WASM, runtime fixtures, and host integration.

## Risks and Mitigations

### Ambiguous restore delivery

A Tauri/WASM restore can commit and then lose its response. Treating every thrown restore as definitive failure can desynchronize gameplay from active-city identity and cause a later save to overwrite the wrong record.

Mitigation: retain prior canonical snapshot capture and rollback only for thrown/superseded active-engine replacements. Definitive `{ ok: false }` remains rollback-free. Rollback failure is fatal and stops ticks/saves.

### Over-pruning construction validation

The net-deletion target can bias an implementer toward deleting checks that prevent invalid indexing or impossible topology.

Mitigation: the retain/normalize/delete matrix is resolved by current function/field responsibility, map reciprocity is explicitly independent of `RoadTopology::compile`, pruning is split by `map.rs` / `entities.rs` / `trips.rs`, and each distinct safety class has a focused regression.

### Current New City coordinator entanglement

Pure sandbox construction changes New City ordering while pending/finalize reconciliation still exists.

Mitigation: remove only backend mutation/rollback mechanics, preserve current storage reconciliation and its tests, and add tests only for the build/activation behavior changed by HPA-547.

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

- [x] Native Tauri remains the desktop release path.
- [x] Browser/WASM remains functional for development and tests.
- [x] All gameplay rules live only in `caelum-core`.
- [x] `GameBackend` contains only methods the runtime currently calls.
- [x] Runtime identity, public sessions, JavaScript backend ownership, and host registries are removed.
- [x] Tauri epoch details are private to the Tauri adapter.
- [x] Both hosts call the existing pure `create_sandbox_snapshot` path.
- [x] Both hosts build a sandbox candidate without mutating active gameplay.
- [x] Restore is candidate-first and exposes only three UI snapshot categories.
- [x] `PersistenceCoordinatorBackendError` is concretely replaced by `SnapshotError | SandboxHostError`, without an operation field.
- [x] Validator pruning follows the resolved retain/normalize/delete matrix and construction order.
- [x] All nine retained construction-safety classes have focused regression tests, including separate reciprocity and genuine structure-compile failures.
- [x] Public `DispatchResult.context` is removed while private apply data and preview impact remain.
- [x] Load and New City roll back the prior canonical snapshot on thrown restore and enter fatal coherence state if rollback fails.
- [x] HPA-547 adds no new tests for pending/finalize reconciliation that HPA-543/HPA-548 will delete.
- [x] Exact error parity, giant fixtures, persistence benchmarks, and exhaustive host matrices are removed.
- [x] Production and test code show material net deletion.
- [x] No HPA-543 or HPA-548 architecture is implemented early.

## Non-goals

- Replacing native gameplay with WASM.
- Removing the browser target without measured evidence.
- Native performance optimization without profiling.
- Rewriting the SaveStore or persistence coordinator.
- Public import/export, migrations, cloud sync, accounts, mods, networking, or recovery UI.
- Formal architecture frameworks.
