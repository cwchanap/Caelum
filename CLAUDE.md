# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Caelum is a 2D city / public-transport simulation and a **player-authored transport sandbox**: the player builds the city, lightweight city systems generate travel demand, and the core game is operating roads and public transport. Roads, bus stops/routes, metro stations/lines, and buildings are placed in deterministic Blank Grid or Crossroads sandboxes. It ships as both a browser app (Vite dev server) and a macOS desktop app (Tauri 2).

Campaign objectives and automatic growth waves are a **future decision**, not a current feature. Code for them still exists in the core (see "In-flight reductions" below) but no active gameplay consumes it.

**The authoritative simulation core is the Rust crate `crates/caelum-core`.** It owns the tick pipeline, transit routing, trip/commute lifecycle, metrics, and gameplay mutations, and is gated by CI (fmt/clippy/test/build) and `lint-staged`. **Both hosts execute this same core:** browser/dev runs it as WASM via `crates/caelum-wasm`; the Tauri desktop build runs it natively. Tauri is the intended release path; the browser build is the fast development, UI, and Playwright target. Host wrappers are transport and serialization only — TypeScript contains UI, rendering, host adapters, and read-only helpers. New gameplay logic belongs in `crates/caelum-core`.

## Working rules

These govern all new work. They come from the project roadmap (Linear HPA-330 / HPA-331) and exist because the persistence layer was once built as a platform before any player could save a game.

**Build the smallest complete player feature. Add an abstraction only after current implementations or measured problems justify it.**

- Keep gameplay logic once, in `caelum-core`.
- Keep the native Tauri and WASM/browser hosts thin. Don't demand forensic error or behavior parity beyond the shared player contract.
- Keep the small `GameBackend` boundary — there are two current implementations. Expose only methods the runtime consumes.
- Keep the small multi-city save boundary — browser IndexedDB and native Tauri files are two current implementations.
- Prefer one busy gate over queues, leases, fences, supersession, and multi-runtime coordination.
- Prefer candidate-first construction and atomic host swap over rollback state machines.
- Prefer disabling unsupported overlapping actions over modelling concurrency.
- Prefer breaking development changes over migrations or compatibility wrappers.
- Remove unused cross-boundary data instead of reserving it for future UI.

Do not over-correct: deleting an essential player feature or the intended native release path to make parity easier is not simplification.

**Testing rule.**

- Test player operations and important deterministic gameplay invariants.
- Start with happy path plus one representative failure.
- Internal branch tests require a reproduced bug, safety boundary, or difficult invariant.
- No `_coverage` files or exact mirror matrices solely for percentage targets.
- Delete obsolete tests with the implementation they specify; don't run a separate test-cleanup project.

**Modularity rule.** KISS does not mean one big file. Organize by current responsibility and reason to change, without ceremonial layers.

- Dependencies point inward toward gameplay and small data contracts.
- UI calls the runtime; it never parses/repairs snapshots or touches a store adapter directly.
- The runtime depends on the small save boundary, not on a storage API.
- `caelum-core` knows nothing about UI, city metadata, browser storage, or Tauri.
- Prefer plain functions and small modules over manager classes, repositories, service locators, event buses, DI containers, command buses, plugin systems, or generic frameworks.
- Keep an interface only where there are ≥2 current implementations or consumers. One implementation means a concrete module, not an interface.
- Extract a reusable abstraction after real duplication appears; never predict it.

### Security scope

The current threat model is a local, single-user hobby game reading same-application save records (browser IndexedDB or native application-data files). There is no public file import, cloud sync, account system, mod/script execution, or supported multi-window workflow. Security work must cite a concrete public input, platform permission, incident, or release requirement. **Prefer removing an unnecessary surface over hardening it.**

Keep only low-cost safety that protects ordinary progress or an immediate trust boundary:

- construct a candidate Rust/WASM engine before replacing live gameplay;
- transactional replacement, so a definite failed write preserves the previous save;
- reject an unsupported snapshot schema and offer clear/reset;
- structural bounds/checks required to prevent panic, unsafe indexing, invalid topology construction, or an immediately unusable engine;
- the default Tauri/WebView CSP and normal Svelte escaping; no new native commands or permissions without a selected feature;
- generic actionable errors, with internal diagnostics kept out of the UI.

Defer until a feature actually creates the boundary: encryption, checksums, HMAC/tamper detection, save signing, path hardening, file-size limits, hostile-input fuzzing, exact-key/prototype/sparse-array guards, sanitization frameworks, multi-process locking, quota/vendor matrices, crash/fsync certification, forensic corruption repair, and any auth/secrets/privacy/network handling.

### Breaking changes and compatibility

There are no released users. **Breaking changes are the default when they simplify the current design.**

- Increment the development snapshot schema and clear old city records; never migrate development saves. A breaking change updates both hosts, both store adapters, call sites, fixtures, and docs in one change.
- Remove old fields, methods, aliases, adapters, compatibility wrappers, fixtures, and their tests in the _same change_ as the replacement.
- Do not retain `serde(default)`, fallback parsing, dual wire formats, dual reads, or deprecated APIs solely to load previous development builds.
- Git history is the archive; production code supports only the current contract.
- Compatibility begins only when a public release makes an explicit save-preservation promise — and then only from an actually released version, not every internal schema.

## In-flight reductions

Several subsystems below are documented as they exist **today** but are scheduled for deletion. Do not extend them, build on them, or preserve their invariants in new code. If a task touches one, prefer moving toward the target shape.

| Area                | Today                                                                                            | Target                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Gameplay host       | `wasmBackend` + native `tauriBackend`, exhaustive host parity, `runtimeIdentity`, runtime epochs | **Both hosts kept**, reduced to thin wrappers over one minimal `GameBackend`; epochs private to Tauri |
| Save contract       | 19-method `SaveStore`, `SaveEnvelope`, checkpoints/autosaves/generations                         | Six ops: `list`/`read`/`create`/`update`/`rename`/`delete` over `CitySaveRecord`                      |
| Runtime persistence | `SharedPersistenceCoordinator`, leases, per-city FIFOs, city fences, revisions, pending/finalize | Active city id + one `persistenceBusy` gate + one dirty boolean                                       |
| Durable storage     | None — `MemorySaveStore` only, not wired into `src/main.ts`                                      | Two thin adapters: browser IndexedDB, native Tauri application-data files                             |
| Campaign/growth     | `GameMode`, `ScenarioConfig`, objectives, growth waves in the snapshot and tick path             | Removed, once it measurably slows sandbox work                                                        |

Nothing in the persistence stack is reachable from the running application yet: `src/main.ts` constructs no store and no UI calls a save operation.

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

**WASM prerequisite (browser build).** The browser backend loads `crates/caelum-wasm` compiled to `src/generated/caelum_wasm/` (generated, git-ignored). `dev`, `check`, `build`, and `test` each run a `pre*` hook (`ensure-wasm`, or `wasm:build:release` for `build`) that rebuilds the artifact whenever any `caelum-core`/`caelum-wasm` source is newer than the output — so **`wasm-pack` must be installed** (`cargo install wasm-pack`), and a local Rust change is automatically reflected on the next `bun run dev`/`check`/`test`. Rebuild manually with `bun run wasm:build` (dev) or `bun run wasm:build:release`. The Tauri host compiles `caelum-core` directly and needs no WASM artifact; this stays true — Tauri runs the core natively.

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
- `scenario/sandbox.ts` — shared sandbox dimension constants (`MAP_WIDTH`/`MAP_HEIGHT`) mirroring `crates/caelum-core/src/sandbox.rs`, exported so render/e2e helpers reference the source of truth. The authoritative Blank Grid and Crossroads maps, sandbox factory, scenario data, objectives, and clock all live in `crates/caelum-core` (see `docs/architecture.md`).
- `runtime/` — `createGameRuntime.ts` (the owner), `runtimeSelectors.ts` (derives the display-ready `ShellState` from state+ui), `types.ts` (`RuntimeController`/`RuntimeSnapshot`), `snapshotView.ts` (read-only views over a snapshot).
- `runtime/backend/` — the host boundary. `createBackend()` (`index.ts`) picks `wasmBackend.ts` or `tauriBackend.ts` via `isTauriRuntime()` (presence of `__TAURI_INTERNALS__`); both implement the `GameBackend` interface (`types.ts`) and forward ticks/intents to the Rust `GameEngine`. Wire types (`RustGameSnapshot`, `GameIntent`, `DispatchResult`) live here. _(In-flight: both hosts stay, but `GameBackend` shrinks to the methods the runtime actually consumes — `runtimeIdentity`, `beginRuntime`, `RuntimeSession`, and JS backend-ownership go away, and Tauri's epoch handling becomes private to its adapter. Add no new host-parity surface.)_
- `ui/` — `actions.ts` (local UI click handling), `routeDraft.ts` (ordered-ID draft reducers), and `uiState.ts` (`UiState` + factory). Production TypeScript has no route pathfinder.
- `domain/catalog/` — read-only TypeScript catalogs shared by UI and render code.
- `render/` — imperative canvas drawing. `canvas.ts` owns board sizing, tile↔pixel mapping (`tileSize = 32`), and the render pass; it composes per-concern renderers (map/buildings/transit/citizens/overlays). The runtime creates the real `<canvas>` and attaches it to `GameCanvas.svelte`'s host element.
- `components/` — `Topbar.svelte` (stats), `GameCanvas.svelte`, and the bottom HUD: `hud/BottomHud.svelte` (slim always-docked bar) + `hud/HudDrawer.svelte` opening one of `hud/panels/*` (Build · Routes · Manage · Data · Brief, plus contextual Inspect). `App.svelte` composes them and surfaces shell errors. (The old monolithic `ControlTower.svelte` was split into these.)

**Rust crate `crates/caelum-core`** is the authoritative simulation core (engine, sandbox factory/reset, transit, router, trips, objectives, metrics, areas/buildings, scenario/clock, platforms). It is a workspace member gated by CI and `lint-staged`. See `docs/superpowers/specs/2026-06-23-rust-simulation-commute-design.md` for the design.

**Tauri host (`src-tauri/`)** exposes gameplay commands backed by managed Rust state and delegates to `caelum-core::GameEngine`. This is the intended desktop release path and stays. _(In-flight: it reduces to a thin transport wrapper — no gameplay rules, session/epoch details private to the adapter — and gains a narrow application-data city-save adapter.)_

### Authored roads and cached topology

Road occupancy is not connectivity. Rust serializes reciprocal tile-edge connections plus stable automatic-junction/roundabout structures. `GameEngine` compiles those authored facts into a non-serialized heading-state `RoadTopology` and commits a candidate snapshot/topology together.

Bus routes use deterministic weighted movement steps (straight, right, left, U-turn, roundabout entry/circulation/exit); metro routes continue to use deterministic track paths. The same Rust-provided step durations drive previews, trip estimates, and vehicle movement.

### Route lifecycle and editing

Routes store Loop/Shuttle directional service legs with current and last-valid tagged paths. Missing referenced nodes remain non-physical tombstones; exact same-kind/same-anchor rebuilding restores their identity. Route creation and revision-checked updates are atomic Rust intents. TypeScript owns only the unsaved ordered-ID draft and generation-safe rendering of Rust previews.

### Road structures

Roundabouts are Rust-owned fixed counterclockwise 2x2/3x3 stamps. Placement captures compatible boundary ports, may replace only fully contained bare roads/automatic junctions, preserves latent area, and removes as one structure.

### Persistence coordination — being deleted

> **Do not build on this section.** The machinery it describes is scheduled for removal and no player-facing feature depends on it. New persistence work should target one busy gate, not extend the coordinator.

`persistenceCoordinator.ts` currently implements a `SharedPersistenceCoordinator` (exclusive leases, per-city FIFOs, reference-counted city fences, storage identity with a `WeakMap` fallback, session/load/revision tokens) so that a replacement runtime cannot race an old runtime's pending writes. It defends against a multi-runtime scenario that production does not create — `src/main.ts` mounts exactly one runtime — and it introduced a hang: if an uncancellable store operation never settles, the lease is never released and the replacement `createGameRuntime` never resolves.

The target is active-city identity plus one `persistenceBusy` gate and one dirty boolean. Save Now blocks new mutations and waits for the in-flight backend mutation to settle before capturing, so revision baselines and late-completion reconciliation are unnecessary.

**Candidate-first is the load-bearing idea.** New City and Load ask the backend for a snapshot built _without touching the active engine_, then swap only after success — so a failure leaves current gameplay untouched and rollback, leases, sessions, and supersession are unnecessary rather than merely removed. New City is also storage-first: create the record, then activate. If activation fails afterwards the record simply stays in the city list for a retry, which is why no compensation or orphan-cleanup machinery is needed.

## Conventions

- **Svelte 5 runes mode** is enabled globally (`svelte.config.js`). Use `$state`, `$props`, `$derived`, `$effect` — not legacy `export let` / stores.
- **Immutable state, reference-equality dispatch.** Sim and action functions return new `GameState` objects; the runtime's `commit` publishes only when `nextState !== state` (or ui changed). Never mutate `GameState` in place, or the runtime will skip the re-render.
- **Determinism is a contract.** Equal sandbox requests must produce equal complete snapshots and stable IDs. Don't introduce nondeterminism (`Math.random`, wall-clock time) into gameplay code.
- **Schema and rejection contract.** `SNAPSHOT_SCHEMA_VERSION = 4`; hosts reject older versions instead of heuristically loading legacy snapshots. Gameplay failures use `GameplayRejection { code, context }`, not message parsing. **Development saves are disposable** — bump the schema and clear old records rather than writing a migration.
- **Preview generations are independent.** Route previews and road-mutation previews use separate generation counters, and late responses may update only the matching current draft or gesture.
- **Mutation boundaries are explicit.** Linear strokes may partially apply where their intent permits skipped tiles; direction, route, and roundabout mutations are atomic. Structure-owned tiles block every other infrastructure and zoning operation.
- **`tests/` mirrors `src/`** by domain. Put runtime/host tests under `tests/runtime` (node env) and DOM/Svelte/render tests under `tests/ui` or `tests/render` (jsdom). End-to-end smoke flows go in `tests/e2e` (Playwright).
- Lint is strict (Rust `clippy -D warnings`). Unused vars must be prefixed `_` to pass eslint.
