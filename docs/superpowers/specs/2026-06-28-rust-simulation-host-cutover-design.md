# Rust Simulation Host Cutover Design

## Context

Caelum already has a tested Rust simulation core in `crates/caelum-core`.
`GameEngine` owns snapshots, gameplay intents, ticking, commute trips, objectives,
metrics, zoning, buildings, transit, routing, and trip lifecycle behavior. The
browser and Tauri hosts are not wired to that core yet: the browser runtime still
constructs a TypeScript `GameState`, calls `tickSimulation`, and applies gameplay
mutations through TypeScript helpers; the Tauri shell still launches the frontend
without native engine commands.

The previous Rust commute design and implementation plan established the broad
direction. This refresh tightens Tasks 7-12 into a strict cutover: Rust must be
the only gameplay authority by the end, and any TypeScript simulation code that
is no longer needed should be removed rather than left as a dormant second
engine.

## Goals

- Route browser gameplay through the Rust core via WebAssembly.
- Route Tauri gameplay through the same Rust core via native commands and
  managed `GameEngine` state.
- Make `createGameRuntime` delegate all gameplay mutation and ticking to a
  `GameBackend` boundary.
- Keep TypeScript responsible only for UI state, event handling, canvas mounting,
  rendering, shell selectors, host selection, and read-only snapshot adaptation.
- Preserve the existing gameplay surface while switching authority to Rust.
- Render and test Rust-shaped snapshots, including day clock, sims, active trips,
  commute metrics, zoning, buildings, transit, and objectives.
- Remove legacy TypeScript simulation mutation modules when they no longer serve
  a read-only fixture or catalog purpose.

## Non-Goals

- Adding a long-lived dual-engine feature flag.
- Rewriting the visual design or replacing the canvas renderer.
- Expanding commute simulation beyond the current Rust core behavior.
- Adding new gameplay features unrelated to host cutover.
- Keeping TypeScript simulation as a fallback once Rust backend selection
  succeeds.

## Architecture

`caelum-core::GameEngine` is the single gameplay authority. At the Rust core
boundary it exposes:

```ts
snapshot(): GameSnapshot
dispatch(intent: GameIntent): DispatchResult
tick(deltaSeconds: number): DispatchResult
reset(): GameSnapshot
```

The browser host wraps this facade through a new `crates/caelum-wasm` crate using
`wasm-bindgen` and serde-backed values. The Tauri host wraps the same facade in
native commands using managed application state, for example a
`Mutex<GameEngine>`.

TypeScript introduces a narrow `GameBackend` interface that mirrors the facade
with asynchronous initialization and mutation calls. Browser WASM can resolve
those calls immediately; Tauri resolves them through `invoke`. The runtime is
created after the first backend snapshot is available, then serializes gameplay
operations so overlapping clicks, ticks, and route edits cannot race the single
Rust engine state. Runtime-local UI state remains in TypeScript: selected tool,
selected building, selected area, hover tile, drag preview, route draft arrays,
selected route row, active overlay, HUD category, and canvas lifecycle. A UI
gesture may be previewed locally, but the committed action becomes a Rust
`GameIntent`.

Any compatibility layer must be read-only and named as snapshot normalization or
view adaptation. It may shape Rust snapshots for selectors/renderers while those
call sites are migrated, but it must not contain routing, objective, budget,
building, transit, commute, or trip mutation logic.

## Component And Data Flow

### Task 7: WASM Facade And Browser Backend

Add `crates/caelum-wasm` to the workspace and expose `GameEngine` to the browser.
Add shared TypeScript backend types that match the Rust serde wire format,
including `GameIntent`, `DispatchResult`, and Rust-shaped `GameSnapshot` fields
such as `day`, `clockMinutes`, `sims`, and `activeTrips`.

The browser backend initializes the generated WASM module, owns one
`WasmGameEngine`, and implements the `GameBackend` methods by wrapping
WASM-returned values in resolved promises. Contract tests should prove
TypeScript calls receive snapshots from Rust dispatch/tick results and that
intent casing matches Rust's externally tagged serde enum.

### Task 8: Tauri Native Backend Adapter

Add Tauri commands for `game_snapshot`, `game_dispatch`, `game_tick`, and
`game_reset`. These commands lock managed engine state and delegate directly to
`caelum-core::GameEngine`. They return Rust snapshots or dispatch results with
serde-compatible camelCase fields.

Add host detection and Tauri backend helpers in TypeScript. Because Tauri
`invoke` is asynchronous, the backend returns promises and the runtime queues
gameplay operations. Command failures reject through the backend and surface as
runtime errors; they are not converted into TypeScript simulation fallback.

### Task 9: Runtime Uses Rust Backend For Gameplay Mutation

Change runtime bootstrap so gameplay state comes from `await backend.snapshot()`
before the app starts. Replace direct calls to TypeScript mutation helpers with
queued `backend.dispatch` or `backend.tick` operations:

- pause and speed changes
- reset
- area paint commits
- building placement
- road, track, road-direction, and remove commits
- bus stops, metro stations, bus routes, and metro lines
- vehicle assignment
- route rename, recolor, active toggle, delete
- platform assignment

The runtime keeps UI-only operations local. Drag previews and draft route arrays
remain TypeScript state, but final commits dispatch Rust intents. Rejections
return unchanged Rust snapshots and do not trigger a TypeScript fallback. If a
gameplay operation is already in flight, later gameplay operations wait behind
it; UI-only hover/selection changes can still update local UI state immediately.

### Task 10: Selectors And Renderers Consume Rust Snapshots

Update TypeScript domain/read types for Rust snapshot data. Render active trips
from Rust snapshots. Any temporary fallback for old citizen-shaped test fixtures
must be fixture-only and must not be reachable from live runtime snapshots. The
top bar uses `day` and `clockMinutes`; population uses `sims.length`; metrics
and objective status come from Rust.

Add a read-only normalization layer only where needed to bridge existing
selectors and renderers. This layer can provide static scenario copy, labels, and
view-ready aliases. It cannot compute gameplay outcomes or mutate state.

E2E tests must run through the Rust browser backend and assert the visible Rust
clock, commute travelers or trip metrics, route/vehicle workflow, and absence of
shell backend errors.

### Task 11: Retire TypeScript Simulation Authority

Search every runtime, UI, render, component, and test import path for
`src/simulation`. Delete mutation modules once no live code imports them. If a
file is still needed for labels, costs, or catalogs, move it to an explicit
read-only location such as `src/ui/catalog` or `src/domain/catalog` and remove
simulation naming.

Delete legacy simulation tests whose behavior is now covered by Rust tests or
Rust-backed runtime/e2e tests. Keep only compatibility fixtures or read-only
frontend tests that do not imply TypeScript gameplay authority.

Update architecture documentation so Rust is described as the sole gameplay
owner and TypeScript as UI/render/host code.

### Task 12: Final Browser And Desktop Verification

Verify the browser and Tauri hosts use the Rust backend in real play:

1. Paint residential and commercial areas.
2. Place homes and destinations.
3. Build roads, bus stops, a route, and a vehicle.
4. Start time.
5. Observe Day 1 clock movement.
6. Observe active commute trips or completed/late/unserved metric changes.
7. Confirm no TS simulation imports are reachable from live runtime code.
8. Confirm Tauri uses native engine commands rather than a browser-only fallback.

No empty verification commit is needed when no source fixes are made.

## Error Handling

Gameplay rejections are ordinary Rust dispatch results. Invalid placement,
invalid routes, unaffordable actions, missing nodes, broken paths, inactive
lines, and similar gameplay states return:

```ts
{ applied: false, rejection: string | null, snapshot: GameSnapshot }
```

The runtime publishes the returned snapshot and may expose the rejection through
existing shell status or error affordances. It must not reinterpret the rejection
by re-running TypeScript gameplay logic.

Host failures are runtime errors. WASM initialization failure, missing generated
module, Tauri command failure, serde mismatch, poisoned engine lock, corrupted
snapshot, or malformed backend result means the frontend cannot safely continue
with gameplay. The shell should show a clear backend error instead of falling
back to TypeScript simulation.

## Cutover Rules

- Rust is the only gameplay authority in the final state.
- No live TypeScript path may call `tickSimulation` or TypeScript gameplay
  mutation helpers.
- No final dual-authority feature flag or TypeScript simulation fallback.
- Snapshot normalization is read-only and must not include routing, trip,
  objective, budget, building, zoning, or transit mutation behavior.
- Legacy TS simulation files are deleted when unnecessary.
- Any retained read-only catalog/fixture files are moved out of
  `src/simulation` and named according to their actual frontend purpose.

## Testing

Rust tests cover authoritative gameplay behavior:

- intent dispatch
- commute scheduling and day rollover
- trip lifecycle and active trip positions
- objectives and metrics
- zoning and building placement
- road/track/network behavior
- route, platform, vehicle, boarding, and transfer behavior
- golden sequences for important user-visible flows

TypeScript tests cover frontend responsibilities only:

- backend contract and host selection
- runtime intent mapping
- UI-only state transitions
- snapshot normalization
- shell selectors against Rust-shaped fixtures
- canvas renderers against Rust-shaped fixtures
- browser e2e through the WASM backend

Final verification should include:

```sh
bun run check
bun run format:check
bun run build
bun run test
bun run test:e2e
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
bun run tauri:build
```

Manual browser and Tauri smoke checks should be used when automated coverage
cannot prove host-specific runtime wiring.

## Approved Direction

Use a hard Rust host cutover with a narrow compatibility adapter. The adapter
exists only to help TypeScript selectors and renderers consume Rust snapshots
during the migration. It is not a second simulation engine. By the end of Tasks
7-12, Rust owns all gameplay state and mutation, browser and Tauri both use the
same Rust core, and unused TypeScript simulation code is removed.
