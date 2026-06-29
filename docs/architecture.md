# Architecture

Caelum runs as a shared browser + Tauri frontend with a Svelte shell around a canvas renderer. The authoritative simulation core is the Rust crate `crates/caelum-core`; browser and Tauri gameplay both go through the Rust `GameEngine` facade.

## Simulation core (Rust)

`crates/caelum-core` owns the simulation. It is a Cargo workspace member gated by CI (`cargo fmt --check`, `cargo clippy -D warnings`, `cargo test`, `cargo build`) and by `lint-staged`.

- `engine.rs` — `GameEngine` holds the current `GameSnapshot` and runs the fixed tick pipeline (`tick_trips` → `evaluate_objectives`) over immutable snapshots. Trip outcomes are recorded inline by `tick_trips` (via `update_metrics`); there is no separate `record_trip_outcome` step. It publishes a new snapshot only when `next != current`, mirroring the TS runtime's reference-equality dispatch.
- `transit.rs`, `network.rs`, `router.rs`, `trips.rs`, `commute.rs` — transit network, multi-leg router, trip/commute lifecycle with substep ticking across boundary times (departures, vehicle stops, walk ends, day rollovers).
- `areas.rs`, `buildings.rs`, `building_catalog.rs` — area zoning and building placement, gated by area.
- `objectives.rs`, `platforms.rs` — objective evaluation and platform capacity.
- `scenario.rs`, `clock.rs` — Growing Suburb scenario and deterministic clock.
- `intent.rs` — `GameIntent` enum mirroring the TS intent flow, with camelCase serde for the future WASM/Tauri boundary.
- `model.rs`, `state.rs`, `ids.rs` — shared data model, snapshot, monotonic ID generation.

The crate is deterministic: no `SystemTime`/`Instant`/`rand`; HashMaps/HashSets are used only for lookup, never for ordered output. The `transit_build`, `router_planning`, `network_paths`, and `platforms` tests are golden/characterization tests that pin the Rust core's behavior to specific values.

## Runtime boundary (TypeScript host)

Rust owns gameplay state. `createGameRuntime()` owns UI state, subscriptions, animation scheduling, host backend calls, canvas mounting, and snapshot publication.

- It stores the latest Rust-derived `GameState` snapshot and local `UiState`.
- It applies local-only UI intents such as tool changes, overlays, selection, and UI reset.
- It dispatches gameplay intents and ticks to the selected host backend.
- It publishes runtime snapshots for the Svelte shell.
- It mounts the imperative canvas host and keeps rendering tied to runtime-owned state.

Browser builds use the WASM backend generated from `crates/caelum-wasm`. Tauri builds use command calls into managed Rust command state. Both backends share the same `caelum-core::GameEngine` facade. TypeScript gameplay code is limited to UI/read-only helpers and host adapters; new gameplay logic belongs in the Rust crate.

## Area zoning layer

`Tile.area` is an independent zoning layer held on each tile alongside the physical `kind`. It is retained across `kind` transitions (painting a road over a zoned tile, then bulldozing the road, leaves the area intact) and the renderer only honors it on `kind === "empty"` tiles. The player paints areas (residential / commercial / industrial / office / civic / park) via drag rectangles in the build panel; Rust owns the paintability gate and the immutable `paintAreaRectangle` intent. Buildings are gated by area: a housing or destination building may only be placed on a tile whose `area` matches the catalog entry's `allowedArea`. Growth waves zone the `area` layer rather than overwriting the tile `kind`, so empty ground stays empty until the player builds on it. Read-only TypeScript catalog data lives under `src/domain/catalog/` for UI and rendering.

The Growing Suburb scenario ships as a sandbox: the map starts empty (no pre-seeded districts, no timed growth waves, no starting citizens), and growth is entirely player-driven through area painting and building placement. The growth-wave mechanism remains in place and tested for future scenarios.

## UI shell

The shell is fully Svelte-owned:

- `App.svelte` composes the runtime-backed shell and handles visible shell errors.
- `Topbar.svelte` renders live metrics and pause/speed controls from derived runtime state.
- `ControlTower.svelte` renders tools, overlays, and scenario brief data from runtime selectors.
- `GameCanvas.svelte` provides the Svelte host for the imperative canvas while leaving drawing inside the existing render modules.

Svelte consumes derived runtime snapshots and never becomes a second source of truth for gameplay state.

## Canvas rendering

Canvas rendering remains imperative for parity and performance.

- `GameCanvas.svelte` provides the board host element.
- `createGameRuntime()` attaches the real `<canvas>` to that host.
- `src/render/canvas.ts` still owns board sizing, coordinate mapping, and the render pass.
- The existing map, overlay, transit, and citizen renderers remain unchanged aside from runtime call-site integration.

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
