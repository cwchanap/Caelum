# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Caelum is a 2D city / public-transport simulation. The player places roads, bus stops/routes, metro stations/lines, and buildings to keep citizens commuting in a deterministic "Growing Suburb" scenario. It ships as both a browser app (Vite dev server) and a macOS desktop app (Tauri 2).

**The authoritative simulation core is the Rust crate `crates/caelum-core`.** It owns the tick pipeline, transit routing, trip/commute lifecycle, objectives, metrics, and gameplay mutations, and is gated by CI (fmt/clippy/test/build) and `lint-staged`. Browser gameplay uses WASM from `crates/caelum-wasm`; Tauri gameplay uses managed Rust command state. TypeScript contains UI, rendering, host adapters, and read-only helpers only. New gameplay logic belongs in `crates/caelum-core`.

## Commands

This repo uses **Bun** (see `bun.lock`); CI runs `bun install --frozen-lockfile`. Do not use npm/yarn.

```sh
bun install
bun run dev          # Vite dev server at http://127.0.0.1:5281
bun run tauri:dev    # Tauri desktop shell (same frontend)

bun run check        # tsc --noEmit + svelte-check (type check)
bun run lint         # lint:svelte (eslint) + lint:rust (cargo clippy -D warnings)
bun run format:check # prettier --check + cargo fmt --check
bun run build        # svelte-check + tsc + vite build

bun run test         # all vitest projects (ui, runtime)
bun run test:unit    # same two projects, explicit
bun run test:e2e     # Playwright (tests/e2e), excluded from vitest
```

Vitest is split into two projects by directory (`vite.config.ts`): `ui` (jsdom; `tests/ui` + `tests/render`) and `runtime` (node).

**WASM prerequisite (browser build).** The browser backend loads `crates/caelum-wasm` compiled to `src/generated/caelum_wasm/` (generated, git-ignored). `dev`, `check`, `build`, and `test` each run a `pre*` hook (`ensure-wasm`, or `wasm:build:release` for `build`) that rebuilds the artifact whenever any `caelum-core`/`caelum-wasm` source is newer than the output — so **`wasm-pack` must be installed** (`cargo install wasm-pack`), and a local Rust change is automatically reflected on the next `bun run dev`/`check`/`test`. Rebuild manually with `bun run wasm:build` (dev) or `bun run wasm:build:release`. The Tauri host compiles `caelum-core` directly and needs no WASM artifact.

```sh
bunx vitest run tests/runtime/gameRuntime.test.ts   # one file
bunx vitest run --project runtime                   # one project
bunx vitest run -t "vehicle advances"               # by test name

# Rust (workspace root is the repo root; members are src-tauri and crates/caelum-core)
cargo test   --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt    --all --check
```

CI (`.github/workflows/ci.yml`) gates on: TS check+lint+build, TS unit coverage, Playwright, Rust fmt+clippy+build, Rust test. `lint-staged` runs eslint/prettier and Rust fmt/clippy on commit.

## Architecture

The central rule: **Rust owns gameplay state; `createGameRuntime()` (`src/runtime/createGameRuntime.ts`) owns the frontend runtime boundary.** It holds the latest Rust-derived `GameState` snapshot and local `UiState`, publishes subscriptions, schedules animation, calls the host backend, and mounts the canvas. Svelte renders from runtime snapshots and emits intents back — it is never a second source of truth. See `docs/architecture.md` for the full description.

**Intent flow:** a Svelte component calls a `RuntimeController` method (e.g. `setTool`, `handleTileClick`, `togglePause`) → the runtime applies local UI helpers or dispatches a gameplay intent/tick to the active backend → `commit()` swaps in the new snapshot/UI state, re-renders the canvas, and publishes a `RuntimeSnapshot` to subscribers. The runtime drives its own `requestAnimationFrame` loop and sends ticks to the backend when unpaused.

**Simulation core is Rust (`crates/caelum-core`)**, independent of Svelte and Tauri. `GameEngine` (`engine.rs`) is the facade both hosts drive: `tick(delta_seconds)` advances game time (real seconds scaled by the current speed), and `dispatch(GameIntent)` applies one player action (build / paint area / transit edit / speed / pause). A tick runs `trips::tick_trips_with_objectives`, which **substeps** the delta at growth-wave boundaries — firing due growth waves (`growth::apply_due_growth_waves`) and re-evaluating objectives/metrics after each substep — bounded by a `max_tick_substeps` cap. Every step takes an immutable `GameSnapshot` and returns a new one; the engine commits and returns `applied` only when `next != current`, otherwise `applied == false` (reference-equality dispatch). Browser and Tauri hosts both wrap this same `GameEngine`.

**Layers (`src/`):**

- `domain/` — `types.ts` is the shared data model (`GameState`, `Citizen`, `TransitNetwork`, `Tool`, etc.); `ids.ts` generates stable IDs (`tileId`, zero-padded `entityId`, `nextEntityId`).
- `scenario/growingSuburb.ts` — authoritative Growing Suburb map dimension constants (`MAP_WIDTH`/`MAP_HEIGHT`) mirroring `crates/caelum-core/src/scenario.rs`, exported so e2e helpers and tests reference the source of truth. The authoritative map layout, scenario, objectives, and clock all live in `crates/caelum-core`; the Growing Suburb sandbox ships with no timed growth waves and no starting citizens (see `docs/architecture.md`).
- `runtime/` — `createGameRuntime.ts` (the owner), `runtimeSelectors.ts` (derives the display-ready `ShellState` from state+ui), `types.ts` (`RuntimeController`/`RuntimeSnapshot`), `snapshotView.ts` (read-only views over a snapshot).
- `runtime/backend/` — the host boundary. `createBackend()` (`index.ts`) picks `wasmBackend.ts` or `tauriBackend.ts` via `isTauriRuntime()` (presence of `__TAURI_INTERNALS__`); both implement the `GameBackend` interface (`types.ts`) and forward ticks/intents to the Rust `GameEngine`. Wire types (`RustGameSnapshot`, `GameIntent`, `DispatchResult`) live here.
- `ui/` — `actions.ts` (local UI click handling), `routeDraft.ts` (ordered-ID draft reducers), and `uiState.ts` (`UiState` + factory). Production TypeScript has no route pathfinder.
- `domain/catalog/` — read-only TypeScript catalogs shared by UI and render code.
- `render/` — imperative canvas drawing. `canvas.ts` owns board sizing, tile↔pixel mapping (`tileSize = 32`), and the render pass; it composes per-concern renderers (map/buildings/transit/citizens/overlays). The runtime creates the real `<canvas>` and attaches it to `GameCanvas.svelte`'s host element.
- `components/` — `Topbar.svelte` (stats), `GameCanvas.svelte`, and the bottom HUD: `hud/BottomHud.svelte` (slim always-docked bar) + `hud/HudDrawer.svelte` opening one of `hud/panels/*` (Build · Routes · Manage · Data · Brief, plus contextual Inspect). `App.svelte` composes them and surfaces shell errors. (The old monolithic `ControlTower.svelte` was split into these.)

**Rust crate `crates/caelum-core`** is the authoritative simulation core (engine, transit, router, trips, objectives, metrics, areas/buildings, scenario/clock, platforms). It is a workspace member gated by CI and `lint-staged`. See `docs/superpowers/specs/2026-06-23-rust-simulation-commute-design.md` for the design.

**Tauri host (`src-tauri/`)** exposes gameplay commands backed by managed Rust state and delegates to `caelum-core::GameEngine`.

### Authored roads and cached topology

Road occupancy is not connectivity. Rust serializes reciprocal tile-edge connections plus stable automatic-junction/roundabout structures. `GameEngine` compiles those authored facts into a non-serialized heading-state `RoadTopology` and commits a candidate snapshot/topology together.

Bus routes use deterministic weighted movement steps (straight, right, left, U-turn, roundabout entry/circulation/exit); metro routes continue to use deterministic track paths. The same Rust-provided step durations drive previews, trip estimates, and vehicle movement.

### Route lifecycle and editing

Routes store Loop/Shuttle directional service legs with current and last-valid tagged paths. Missing referenced nodes remain non-physical tombstones; exact same-kind/same-anchor rebuilding restores their identity. Route creation and revision-checked updates are atomic Rust intents. TypeScript owns only the unsaved ordered-ID draft and generation-safe rendering of Rust previews.

### Road structures

Roundabouts are Rust-owned fixed counterclockwise 2x2/3x3 stamps. Placement captures compatible boundary ports, may replace only fully contained bare roads/automatic junctions, preserves latent area, and removes as one structure.

## Conventions

- **Svelte 5 runes mode** is enabled globally (`svelte.config.js`). Use `$state`, `$props`, `$derived`, `$effect` — not legacy `export let` / stores.
- **Immutable state, reference-equality dispatch.** Sim and action functions return new `GameState` objects; the runtime's `commit` publishes only when `nextState !== state` (or ui changed). Never mutate `GameState` in place, or the runtime will skip the re-render.
- **Determinism is a contract.** The Growing Suburb scenario — initial state, growth thresholds, generated citizens, IDs, and objective evaluation — must stay stable across runs. Don't introduce nondeterminism (`Math.random`, wall-clock time) into gameplay code.
- **Schema and rejection contract.** `SNAPSHOT_SCHEMA_VERSION = 2`; hosts reject other versions instead of heuristically loading legacy snapshots. Gameplay failures use `GameplayRejection { code, context }`, not message parsing.
- **Preview generations are independent.** Route previews and road-mutation previews use separate generation counters, and late responses may update only the matching current draft or gesture.
- **Mutation boundaries are explicit.** Linear strokes may partially apply where their intent permits skipped tiles; direction, route, and roundabout mutations are atomic. Structure-owned tiles block every other infrastructure and zoning operation.
- **`tests/` mirrors `src/`** by domain. Put runtime/host tests under `tests/runtime` (node env) and DOM/Svelte/render tests under `tests/ui` or `tests/render` (jsdom). End-to-end smoke flows go in `tests/e2e` (Playwright).
- Lint is strict (Rust `clippy -D warnings`). Unused vars must be prefixed `_` to pass eslint.
