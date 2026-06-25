# Architecture

Caelum runs as a shared browser + Tauri frontend with a Svelte shell around a canvas renderer. The authoritative simulation core is the Rust crate `crates/caelum-core`; the TypeScript simulation under `src/simulation/` is the legacy implementation, retained as the live runtime and parity oracle until plan Tasks 7–12 wire the Rust core into the frontend via a WASM facade and Tauri commands.

## Simulation core (Rust)

`crates/caelum-core` owns the simulation. It is a Cargo workspace member gated by CI (`cargo fmt --check`, `cargo clippy -D warnings`, `cargo test`, `cargo build`) and by `lint-staged`.

- `engine.rs` — `GameEngine` holds the current `GameSnapshot` and runs the fixed tick pipeline (`tick_trips` → `record_trip_outcome`) over immutable snapshots. It publishes a new snapshot only when `next != current`, mirroring the TS runtime's reference-equality dispatch.
- `transit.rs`, `network.rs`, `router.rs`, `trips.rs`, `commute.rs` — transit network, multi-leg router, trip/commute lifecycle with substep ticking across boundary times (departures, vehicle stops, walk ends, day rollovers).
- `areas.rs`, `buildings.rs`, `building_catalog.rs` — area zoning and building placement, gated by area.
- `objectives.rs`, `platforms.rs` — objective evaluation and platform capacity.
- `scenario.rs`, `clock.rs` — Growing Suburb scenario and deterministic clock.
- `intent.rs` — `GameIntent` enum mirroring the TS intent flow, with camelCase serde for the future WASM/Tauri boundary.
- `model.rs`, `state.rs`, `ids.rs` — shared data model, snapshot, monotonic ID generation.

The crate is deterministic: no `SystemTime`/`Instant`/`rand`; HashMaps/HashSets are used only for lookup, never for ordered output. Parity tests (`transit_parity`, `router_parity`, `network_parity`, `platforms_parity`) assert specific values against the TS implementation, not just shape.

## Runtime boundary (TypeScript, legacy live runtime)

`createGameRuntime()` is the single owner of mutable frontend state while the TS runtime remains live.

- It creates and stores the current `GameState` and `UiState`.
- It applies player intents such as tool changes, overlays, pause/speed toggles, selection, and UI reset.
- It advances the simulation through `tickSimulation`.
- It publishes runtime snapshots for the Svelte shell.
- It mounts the imperative canvas host and keeps rendering tied to runtime-owned state.

The TypeScript simulation, routing, map growth, transit logic, and objective evaluation remain pure TypeScript and independent of Svelte and Tauri. They are the parity oracle for `crates/caelum-core`; new gameplay logic belongs in the Rust crate, not `src/simulation/` (except to keep parity tests green).

## Area zoning layer

`Tile.area` is an independent zoning layer held on each tile alongside the physical `kind`. It is retained across `kind` transitions (painting a road over a zoned tile, then bulldozing the road, leaves the area intact) and the renderer only honors it on `kind === "empty"` tiles. The player paints areas (residential / commercial / industrial / office / civic / park) via drag rectangles in the build panel; `src/simulation/areas.ts` owns the paintability gate and the immutable `paintAreaRectangle` writer. Buildings are gated by area: a housing or destination building may only be placed on a tile whose `area` matches the catalog entry's `allowedArea` (`src/simulation/buildings.ts` → `canPlaceBuilding`). Growth waves zone the `area` layer rather than overwriting the tile `kind`, so empty ground stays empty until the player builds on it. Shared tile-query helpers (`samePoint`, `isBuildingOccupied`, `isTransitNodeAt`) live in `src/simulation/tileQueries.ts`, and the building catalog (`BUILDING_CATALOG`) lives in `src/simulation/buildingCatalog.ts` to break the `buildings.ts ↔ buildingSelectors.ts ↔ map.ts` import cycle.

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

- **Browser host:** Vite serves the Svelte app for development, tests, and the web build.
- **Tauri host:** packages the same frontend into a macOS desktop app. The Tauri crate (`src-tauri/`) is intentionally minimal today (`lib.rs` builds the app and wires the log plugin). Plan Tasks 7–8 will add a WASM facade and Tauri commands that delegate to `crates/caelum-core::GameEngine`; until then the TS runtime drives the simulation on both hosts.

Host bootstrap failures stay in the shell layer, while gameplay validation remains in the runtime and the Rust simulation core.

## Runtime flow

1. Svelte components emit user intents to the runtime.
2. The runtime validates and applies those intents through existing action helpers.
3. `tickSimulation` advances suburb growth, transit movement, and objectives.
4. The imperative canvas renderer draws from runtime-owned state.
5. Svelte rerenders from the latest runtime snapshot.

The Growing Suburb scenario remains deterministic for tests: initial state, growth thresholds, generated citizens, identifiers, and objective evaluation stay stable across repeated runs.
