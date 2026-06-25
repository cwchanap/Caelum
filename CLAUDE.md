# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Caelum is a 2D city / public-transport simulation. The player places roads, bus stops/routes, metro stations/lines, and buildings to keep citizens commuting in a deterministic "Growing Suburb" scenario. It ships as both a browser app (Vite dev server) and a macOS desktop app (Tauri 2).

**The authoritative simulation core is the Rust crate `crates/caelum-core`.** It owns the tick pipeline, transit routing, trip/commute lifecycle, objectives, and metrics, and is gated by CI (fmt/clippy/test/build) and `lint-staged`. The TypeScript simulation under `src/simulation/` is the legacy implementation retained for parity verification and as the live runtime until the WASM/Tauri adapters (plan Tasks 7–12) wire the Rust core into the frontend. New gameplay logic belongs in `crates/caelum-core`; do not extend `src/simulation/` except to keep parity tests green.

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

bun run test         # all vitest projects (ui, runtime, simulation)
bun run test:unit    # same three projects, explicit
bun run test:e2e     # Playwright (tests/e2e), excluded from vitest
```

Vitest is split into three projects by directory (`vite.config.ts`): `ui` (jsdom; `tests/ui` + `tests/render`), `runtime` (node), `simulation` (node).

```sh
bunx vitest run tests/simulation/transit.test.ts   # one file
bunx vitest run --project simulation                # one project
bunx vitest run -t "vehicle advances"               # by test name

# Rust (workspace root is the repo root; members are src-tauri and crates/caelum-core)
cargo test   --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt    --all --check
```

CI (`.github/workflows/ci.yml`) gates on: TS check+lint+build, TS unit coverage, Playwright, Rust fmt+clippy+build, Rust test. `lint-staged` runs eslint/prettier and Rust fmt/clippy on commit.

## Architecture

The central rule: **`createGameRuntime()` (`src/runtime/createGameRuntime.ts`) is the single owner of mutable frontend state.** It holds the current `GameState` and `UiState`. Svelte renders from runtime snapshots and emits intents back — it is never a second source of truth. See `docs/architecture.md` for the full description.

**Intent flow:** a Svelte component calls a `RuntimeController` method (e.g. `setTool`, `handleTileClick`, `togglePause`) → the runtime applies it via pure helpers (`src/ui/actions.ts`) or `tickSimulation` → `commit()` swaps in the new state, re-renders the canvas, and publishes a `RuntimeSnapshot` to subscribers. The runtime drives its own `requestAnimationFrame` loop and calls `tickSimulation(state, deltaSeconds)` each frame.

**Simulation core is Rust (`crates/caelum-core`)**, independent of Svelte and Tauri. The engine runs one tick as a fixed pipeline over an immutable `GameSnapshot`:
`tick_trips` → `record_trip_outcome` (objectives/metrics). Every step takes a `GameSnapshot` and returns a new one; the engine publishes a new snapshot only when `next != current`. The legacy TypeScript simulation (`src/simulation/simulation.ts`, pipeline `applyDueGrowthWaves` → `tickVehicles` → `tickCitizens` → `evaluateObjectives`) is retained as the live runtime and parity oracle until plan Tasks 7–12 wire the Rust core into the frontend.

**Layers (`src/`):**

- `domain/` — `types.ts` is the shared data model (`GameState`, `Citizen`, `TransitNetwork`, `Tool`, etc.); `ids.ts` generates stable IDs (`tileId`, zero-padded `entityId`, `nextEntityId`).
- `simulation/` — pure sim: `gameState.ts` (initial state), `map.ts` (growth waves), `transit.ts` (stops/routes/vehicles), `citizens.ts`, `router.ts` (multi-leg walk/bus/metro trip planning), `buildings.ts`, `objectives.ts`.
- `scenario/growingSuburb.ts` — the single built-in scenario: map layout, starting citizens, timed growth waves, win/loss objectives.
- `runtime/` — `createGameRuntime.ts` (the owner), `runtimeSelectors.ts` (derives the display-ready `ShellState` from state+ui), `types.ts` (`RuntimeController`/`RuntimeSnapshot`).
- `ui/` — `actions.ts` (`handleTileClick` applies a player click to `GameState`), `uiState.ts` (`UiState` + factory).
- `render/` — imperative canvas drawing. `canvas.ts` owns board sizing, tile↔pixel mapping (`tileSize = 32`), and the render pass; it composes per-concern renderers (map/buildings/transit/citizens/overlays). The runtime creates the real `<canvas>` and attaches it to `GameCanvas.svelte`'s host element.
- `components/` — `Topbar.svelte`, `ControlTower.svelte` (tools/overlays/brief), `GameCanvas.svelte`. `App.svelte` composes them and surfaces shell errors.

**Rust crate `crates/caelum-core`** is the authoritative simulation core (engine, transit, router, trips, objectives, metrics, areas/buildings, scenario/clock, platforms). It is a workspace member gated by CI and `lint-staged`. See `docs/superpowers/specs/2026-06-23-rust-simulation-commute-design.md` for the design.

**Tauri host (`src-tauri/`)** is intentionally minimal for now: `lib.rs` just builds the Tauri app and wires the log plugin. Plan Tasks 7–8 will add a WASM facade and Tauri commands that delegate to `caelum-core::GameEngine`; until then the TypeScript runtime remains the live simulation.

## Conventions

- **Svelte 5 runes mode** is enabled globally (`svelte.config.js`). Use `$state`, `$props`, `$derived`, `$effect` — not legacy `export let` / stores.
- **Immutable state, reference-equality dispatch.** Sim and action functions return new `GameState` objects; the runtime's `commit` publishes only when `nextState !== state` (or ui changed). Never mutate `GameState` in place, or the runtime will skip the re-render.
- **Determinism is a contract.** The Growing Suburb scenario — initial state, growth thresholds, generated citizens, IDs, and objective evaluation — must stay stable across runs; simulation tests depend on it. Don't introduce nondeterminism (`Math.random`, wall-clock time) into sim code.
- **`tests/` mirrors `src/`** by domain. Put pure-logic tests under `tests/simulation` or `tests/runtime` (node env) and DOM/Svelte tests under `tests/ui` or `tests/render` (jsdom). End-to-end smoke flows go in `tests/e2e` (Playwright).
- Lint is strict (Rust `clippy -D warnings`). Unused vars must be prefixed `_` to pass eslint.
