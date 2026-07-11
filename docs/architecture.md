# Architecture

Caelum runs as a shared browser + Tauri frontend with a Svelte shell around a canvas renderer. The authoritative simulation core is the Rust crate `crates/caelum-core`; browser and Tauri gameplay both go through the Rust `GameEngine` facade.

## Simulation core (Rust)

`crates/caelum-core` owns the simulation. It is a Cargo workspace member gated by CI (`cargo fmt --check`, `cargo clippy -D warnings`, `cargo test`, `cargo build`) and by `lint-staged`.

- `engine.rs` — `GameEngine` holds the current `GameSnapshot` and runs `tick_trips_with_objectives`, which advances immutable snapshots in deterministic boundary-aware substeps and evaluates objectives after each substep. Trip outcomes are recorded inline by the trip pipeline (via `update_metrics`); there is no separate `record_trip_outcome` step. It publishes a new snapshot only when `next != current`, matching the TS runtime's reference-equality dispatch.
- `transit.rs`, `network.rs`, `router.rs`, `trips.rs`, `commute.rs` — transit network, multi-leg router, trip/commute lifecycle with substep ticking across boundary times (departures, vehicle stops, walk ends, day rollovers).
- `areas.rs`, `buildings.rs`, `building_catalog.rs` — area zoning and building placement, gated by area.
- `objectives.rs`, `platforms.rs` — objective evaluation and platform capacity.
- `scenario.rs`, `clock.rs` — Growing Suburb scenario and deterministic clock.
- `intent.rs` — `GameIntent` enum mirroring the TS intent flow, with camelCase serde used by the active WASM and Tauri host boundaries.
- `model.rs`, `state.rs`, `ids.rs` — shared data model, snapshot, monotonic ID generation.

The crate is deterministic: no `SystemTime`/`Instant`/`rand`; HashMaps/HashSets are used only for lookup, never for ordered output. The `transit_build`, `router_planning`, `network_paths`, and `platforms` tests are golden/characterization tests that pin the Rust core's behavior to specific values.

## Runtime boundary (TypeScript host)

Rust owns gameplay state. `createGameRuntime()` owns UI state, subscriptions, animation scheduling, host backend calls, canvas mounting, and snapshot publication.

- It stores the latest Rust-derived `GameState` snapshot and local `UiState`.
- It applies local-only UI intents such as tool changes, overlays, selection, and UI reset.
- It dispatches gameplay intents and ticks to the selected host backend.
- It publishes runtime snapshots for the Svelte shell.
- It mounts the imperative canvas host and keeps rendering tied to runtime-owned state.

Browser builds call the `WasmGameEngine` wrapper generated from `crates/caelum-wasm`; Tauri builds invoke managed commands in `src-tauri` that hold the same `caelum-core::GameEngine`. These are the active production host paths, not planned adapters. TypeScript gameplay code is limited to UI/read-only helpers and host adapters; new gameplay logic belongs in the Rust crate.

The host contract is `SNAPSHOT_SCHEMA_VERSION = 2`. Loading is strict: there is no heuristic legacy-snapshot migration or fallback path. Rejected mutations cross the host boundary as `GameplayRejection { code, context }`, so browser and Tauri surface the same typed failure without parsing messages. Route previews and road-mutation previews have separate monotonically increasing generations; a late response can update only the matching current draft or gesture.

Linear road, track, remove, and area strokes may partially apply in authored order where their intent allows skipped tiles. Direction changes, route creation/updates, and roundabout placement/removal are atomic mutations. A tile owned by any road structure blocks every other infrastructure or zoning operation until that structure is removed through its owning mutation.

### Authored roads and cached topology

Road occupancy is not connectivity. Rust serializes reciprocal tile-edge connections plus stable automatic-junction/roundabout structures. `GameEngine` compiles those authored facts into a non-serialized heading-state `RoadTopology` and commits a candidate snapshot/topology together.

Bus routes use deterministic weighted movement steps (straight, right, left, U-turn, roundabout entry/circulation/exit); metro routes continue to use deterministic track paths. The same Rust-provided step durations drive previews, trip estimates, and vehicle movement.

### Route lifecycle and editing

Routes store Loop/Shuttle directional service legs with current and last-valid tagged paths. Missing referenced nodes remain non-physical tombstones; exact same-kind/same-anchor rebuilding restores their identity. Route creation and revision-checked updates are atomic Rust intents. TypeScript owns only the unsaved ordered-ID draft and generation-safe rendering of Rust previews.

### Road structures

Roundabouts are Rust-owned fixed counterclockwise 2x2/3x3 stamps. Placement captures compatible boundary ports, may replace only fully contained bare roads/automatic junctions, preserves latent area, and removes as one structure.

## Area zoning layer

`Tile.area` is an independent zoning layer held on each tile alongside the physical `kind`. It is retained across `kind` transitions (painting a road over a zoned tile, then bulldozing the road, leaves the area intact) and the renderer only honors it on `kind === "empty"` tiles. The player paints areas (residential / commercial / industrial / office / civic / park) via drag rectangles in the build panel; Rust owns the paintability gate and the immutable `paintAreaRectangle` intent. Buildings are gated by area: a housing or destination building may only be placed on a tile whose `area` matches the catalog entry's `allowedArea`. Read-only TypeScript catalog data lives under `src/domain/catalog/` for UI and rendering.

The Growing Suburb scenario ships as a sandbox with an authored dual-bidirectional arterial cross, but no pre-seeded districts, timed growth waves, buildings, or citizens. Growth is player-driven through area painting and building placement. TypeScript does not synthesize growth waves: `snapshotView.ts` passes through the Rust-owned scenario list (empty for the shipped scenario), and any future timed-growth mechanic belongs in `crates/caelum-core` so browser and Tauri hosts stay symmetric.

## UI shell

The shell is fully Svelte-owned:

- `App.svelte` composes the runtime-backed shell and handles visible shell errors.
- `Topbar.svelte` renders live metrics and pause/speed controls from derived runtime state.
- `BottomHud.svelte` keeps the Build, Area, Routes, Manage, Data, and Brief categories docked at the bottom.
- `HudDrawer.svelte` hosts the corresponding focused panels plus contextual Inspect content; the panel components render tools, route editing/management, overlays, and scenario data from runtime selectors.
- `GameCanvas.svelte` provides the Svelte host for the imperative canvas while leaving drawing inside the existing render modules.

Svelte consumes derived runtime snapshots and never becomes a second source of truth for gameplay state.

## Canvas rendering

Canvas rendering remains imperative for parity and performance.

- `GameCanvas.svelte` provides the board host element.
- `createGameRuntime()` attaches the real `<canvas>` to that host.
- `src/render/canvas.ts` owns board sizing, coordinate mapping, and render-pass composition.
- Map, building, overlay, transit, citizen, roundabout, and route-geometry renderers consume committed runtime state and local selection/draft presentation state without becoming gameplay authorities.

## Hosts

Both hosts start the same frontend:

- **Browser host:** Vite serves the Svelte app for development, tests, and the web build. Gameplay uses WASM generated from `crates/caelum-wasm`.
- **Tauri host:** packages the same frontend into a macOS desktop app. Gameplay uses Tauri commands backed by managed Rust state.

Host bootstrap failures stay in the shell layer, while gameplay validation remains in the runtime and the Rust simulation core.

## Runtime flow

1. Svelte components emit user intents to the runtime.
2. The runtime applies local UI intents directly and sends gameplay intents to the host backend.
3. The Rust `GameEngine` advances suburb growth, transit movement, and objectives.
4. The imperative canvas renderer draws from runtime-owned state.
5. Svelte rerenders from the latest runtime snapshot.

The Growing Suburb scenario remains deterministic for tests: initial state, growth thresholds, generated citizens, identifiers, and objective evaluation stay stable across repeated runs.
