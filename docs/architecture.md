# Architecture

Caelum runs as a shared browser + Tauri frontend with a Svelte shell around a canvas renderer. The authoritative simulation core is the Rust crate `crates/caelum-core`; browser and Tauri gameplay both go through the Rust `GameEngine` facade.

## Simulation core (Rust)

`crates/caelum-core` owns the simulation. It is a Cargo workspace member gated by CI (`cargo fmt --check`, `cargo clippy -D warnings`, `cargo test`, `cargo build`) and by `lint-staged`.

- `engine.rs` — `GameEngine` holds the current `GameSnapshot` and runs `tick_trips_with_objectives`, which advances immutable snapshots in deterministic boundary-aware substeps and evaluates objectives after each substep. Trip outcomes are recorded inline by the trip pipeline (via `update_metrics`); there is no separate `record_trip_outcome` step. It publishes a new snapshot only when `next != current`, matching the TS runtime's reference-equality dispatch.
- `transit.rs`, `network.rs`, `router.rs`, `trips.rs`, `commute.rs` — transit network, multi-leg router, trip/commute lifecycle with substep ticking across boundary times (departures, vehicle stops, walk ends, day rollovers).
- `areas.rs`, `buildings.rs`, `building_catalog.rs` — area zoning and building placement, gated by area.
- `objectives.rs`, `platforms.rs` — objective evaluation and platform capacity.
- `sandbox.rs` — validated sandbox creation requests, deterministic Blank Grid/Crossroads maps, canonical defaults, template invariants, and reset reconstruction.
- `scenario.rs`, `clock.rs` — Growing Suburb campaign configuration and deterministic clock.
- `intent.rs` — `GameIntent` enum mirroring the TS intent flow, with camelCase serde used by the active WASM and Tauri host boundaries.
- `model.rs`, `state.rs`, `ids.rs` — shared data model, snapshot, monotonic ID generation.

The crate is deterministic: no `SystemTime`/`Instant`/`rand`; HashMaps/HashSets are used only for lookup, never for ordered output. The `transit_build`, `router_planning`, `network_paths`, and `platforms` tests are golden/characterization tests that pin the Rust core's behavior to specific values.

### Purchase cost policy

Rust derives a transient purchase `CostPolicy` from the active snapshot's
`rules.economyPreset` for every player purchase. Standard requires and deducts
the full catalog price; Creative treats the same quote as affordable and
deducts zero. Both retain the same positive nominal price in dispatch and
preview responses. Nominal cost is carried explicitly rather than inferred
from a budget delta.

Atomic purchases remain atomic, while road and track strokes authorize and
accumulate each newly authored paid tile in input order. Scenario-authored
`place_building_core()` remains free. WASM and Tauri only forward the existing
Rust results. TypeScript never derives or enforces authoritative cost policy:
it consumes Rust-provided route-preview affordability for route-draft
presentation and save gating, and its only direct economy-preset
interpretation for affordability or cost behavior is the read-only
building-hover helper.

## Runtime boundary (TypeScript host)

Rust owns gameplay state. `createGameRuntime()` owns UI state, subscriptions, animation scheduling, host backend calls, canvas mounting, and snapshot publication.

- It stores the latest Rust-derived `GameState` snapshot and local `UiState`.
- It applies local-only UI intents such as tool changes, overlays, selection, and UI reset.
- It dispatches gameplay intents and ticks to the selected host backend.
- It publishes runtime snapshots for the Svelte shell.
- It mounts the imperative canvas host and keeps rendering tied to runtime-owned state.

Browser builds call the `WasmGameEngine` wrapper generated from `crates/caelum-wasm`; Tauri builds invoke managed commands in `src-tauri` that hold the same `caelum-core::GameEngine`. These are the active production host paths, not planned adapters. TypeScript gameplay code is limited to UI/read-only helpers and host adapters; new gameplay logic belongs in the Rust crate.

The two host adapters implement exactly the nine-method `GameBackend` contract:
`snapshot`, `snapshotForSave`, `buildSandboxSnapshot`, `restoreSnapshot`,
`dispatch`, `tick`, `reset`, `previewRoute`, and `previewRoadMutation`. The
contract is deliberately a shared runtime seam, not a plugin or host-platform
API. Neither adapter exposes a runtime identity, session object, validation
operation, or mutating sandbox operation.

The host contract is `SNAPSHOT_SCHEMA_VERSION = 5`. Every snapshot carries
required Rust-owned `GameRules` plus a required `ScenarioConfig`.
`rules.sandbox.startingCapital` is required and records the exact amount reset
must restore; it is an integer from `0` through `i32::MAX`.
`scenario.objectives` is a required-but-nullable wire key: it is an object or
explicit JSON `null`; a present WASM `undefined` represents Rust `None` and
the host normalizes it to `null`.
`scenario.growthWaves` is also required and may be empty. Omitting either key,
omitting `startingCapital`, omitting a placed building's required `placedAt`, or
supplying any other malformed schema-v5 content,
rejects the snapshot. Schema-v3 and older snapshots are never heuristically
migrated.

Rejected mutations cross the host boundary as `GameplayRejection { code, context }`, so browser and Tauri surface the same typed failure without parsing messages. Route previews and road-mutation previews have separate monotonically increasing generations; a late response can update only the matching current draft or gesture.

The contextual Select inspector keeps transit-node resolution first. When no
transit node occupies the selected tile, it derives a building view from the
snapshot's placed-building footprint and the read-only TypeScript building
catalog: resident membership uses each sim's `home`, workplace membership uses
`workplace`, and the catalog supplies the capacity. Occupancy and capacity are
not persisted or queried through a backend method.

Linear road, track, remove, and area strokes may partially apply in authored order where their intent allows skipped tiles. Direction changes, route creation/updates, and roundabout placement/removal are atomic mutations. A tile owned by any road structure blocks every other infrastructure or zoning operation until that structure is removed through its owning mutation.

### Persistence host boundary

`snapshotForSave` returns an infallible, paused, normalized clone of the live
snapshot without mutating the engine. `restoreSnapshot(snapshot)` is
candidate-first: each host decodes the candidate, constructs a complete
`GameEngine` with `from_snapshot`, and replaces the active engine only after
construction succeeds. A definitive `{ ok: false }` therefore leaves active
gameplay unchanged.

Snapshot failures cross the TypeScript host boundary through exactly three
categories: `unsupportedSchema`, `invalidSnapshot`, and `hostFailure`. The
optional `diagnostic` is for development logging; these errors have no
`operation` field because the direct caller already knows whether it is saving or
restoring. Sandbox form failures remain separate field-level
`SandboxCreationError` values, while an unexpected sandbox adapter rejection is a
`SandboxHostError` with `hostFailure`. The runtime-facing backend error is the
small union `SnapshotError | SandboxHostError`.

An adapter-thrown or rejected restore is ambiguous: the host may have committed a
candidate before delivery failed. The working-save runtime does not roll back or
reconcile that ambiguity. It clears active-city identity before publishing the
failure, so a later Save cannot overwrite the prior city's record. A definitive
`{ ok: false }` leaves active gameplay and identity unchanged because
candidate-first construction proves that no replacement occurred. Save capture is
non-mutating, so a thrown save operation reports `hostFailure`.

Tauri's runtime epoch is private to `createTauriBackend()` and the native
commands. The adapter calls the private `game_begin_runtime` bootstrap before it
returns, closes over the returned epoch, and exposes no epoch or session method.
Mutating commands, save capture, and restore carry the private epoch and retain
stale-epoch checks; pure snapshot, sandbox-build, and preview operations do not
become public lifecycle APIs.

The public `DispatchResult` contains only the snapshot, `applied`, and optional
rejection. Private apply data still supports mutation commits, route lifecycle
work, and cost/footprint handling, while route and road preview responses retain
the impact data consumed by the UI. Dispatch impact was removed from the public
host wire, not from the internal mutation or preview paths.

Persistence responses use a JSON-compatible serializer only on the persistence
path. Ordinary `snapshot`, `dispatch`, and `tick` retain their existing host
wire serialization. Persistence adapters therefore return the canonical raw
`RustGameSnapshot` and never view-normalize it. The shared runtime-view boundary
uses `normalizeRustSnapshot` to recursively turn host-specific
`undefined`/`null` option representations into the equal read-only `GameState`
view consumed by UI and rendering.

`workingSaveRuntime.ts` owns runtime persistence: one active city, one busy gate,
one dirty boolean, one current persistence error, and the six-operation
`CitySaveStore` boundary. The active-development scope supports one runtime and
no multi-window workflow, so persistence needs no ownership handoff or
cross-runtime coordination.

The browser persistence adapter is `indexedDbCitySaveStore.ts`: one
`caelum-city-saves-v1` IndexedDB database, one `cities` object store, and full
`CitySaveRecord` values keyed by opaque city ID. It implements the six
`CitySaveStore` operations directly, derives/sorts list summaries from the same
records, lets IndexedDB clone values at `add`/`put`, and has no metadata index,
migration layer, recovery model, or multi-tab ownership. Multi-request
transactions keep only IndexedDB request awaits between requests so the
transaction remains active.

The native persistence adapter is `tauriCitySaveStore.ts`: six narrow Tauri
commands own application-data JSON files under
`<app_data_dir>/cities/city-<hex-id>.json`. Create payloads are written to a
sibling temporary file first and committed with a create-only hard link;
update and rename payloads are likewise temp-first and replace the committed
file only after the complete payload is written. Listing ignores malformed,
misnamed, stale temporary, and non-file entries so healthy cities remain
available. TypeScript owns the shared `sortCitySummaries` list ordering for
both hosts. `MemoryCitySaveStore` remains a test double used by
runtime/persistence tests, not a production host.

The first-city bootstrap and city-library flow are deliberately narrow:

```text
startup
  -> runtime.persistence.listCities()
  -> empty: New City
  -> list failure: Retry city list OR New City
  -> existing: City Library
       -> Continue / Load / inline Rename / Delete? / New City
  -> active game shell
       -> City panel: Save Now / city list / New City

Browser/WASM startup wiring:
  createWasmBackend
  -> createIndexedDbCitySaveStore
  -> createGameRuntime(activeCity = null)
  -> runtime.persistence.listCities()

Tauri startup:
  createTauriBackend
  -> createTauriCitySaveStore
       -> city_store_* Tauri commands
       -> <app_data_dir>/cities/city-<hex-id>.json
  -> same city-list/create-city/runtime flow
```

The UI calls `RuntimePersistenceController`, which is the only runtime-facing
persistence boundary; it delegates to `CitySaveStore` rather than exposing a
store adapter to Svelte:

```text
UI -> RuntimePersistenceController -> CitySaveStore
browser store: IndexedDB
native Tauri store: application-data JSON files through narrow Tauri commands
```

HPA-346 owns the city library and the Save, Load, Rename, and Delete actions;
HPA-345 only creates the first city through the shared runtime flow. The Tauri
city store owns native application-data files through the six narrow commands;
it is not an IndexedDB-on-Tauri fallback. HPA-344 automatically covers the
production command/serialization seam and direct disk reopen behavior with
isolated Rust tests. HPA-349 closes the remaining packaged composition gate
with the representative browser Playwright multi-city journey and one
operator-run packaged Tauri restart/load smoke; no permanent native UI
automation layer is required for the current Phase 1 architecture.

Saving is a manual player action. Autosave, save history, and recovery are
deferred (HPA-347), so no animation-frame latency budget applies yet; revisit a
worker or other host-execution boundary only if background saving is actually
adopted and causes observable jank.

### Sandbox factory and reset

Rust owns sandbox construction through `create_sandbox_snapshot()` and
`GameEngine::from_sandbox_request()`. The raw request contains `templateId`,
`economyPreset`, `startingCapital`, and `demandMultiplier`;
validation returns typed `SandboxCreationError` values for unsupported or
invalid fields before any engine state changes. The canonical default request
is exactly Crossroads, Standard economy, `$120,000` starting capital, demand
multiplier `1`, and paused move-in. `GameEngine::new()` delegates to that
request, so the browser and Tauri defaults share the factory rather than
maintaining separate startup snapshots.

Both host adapters use the pure factory for New City candidates:
`WasmGameEngine.build_sandbox_snapshot()` calls `create_sandbox_snapshot`
without touching its active engine, while Tauri's
`game_build_sandbox_snapshot` command calls the same function without locking or
mutating managed engine state. TypeScript exposes this as
`buildSandboxSnapshot`; candidate persistence and later candidate-first restore
are separate steps.

Both templates use the shared 28×18 map:

- **Blank Grid** contains the deterministic row-major tile inventory and no
  authored roads, connections, structures, zoning, track, buildings,
  residents, trips, transit nodes, routes, lines, or vehicles.
- **Crossroads** starts from Blank Grid and authors row 8 westbound, row 9
  eastbound, column 14 southbound, and column 15 northbound. Refreshing
  automatic junctions produces one existing, routable 2×2 center structure at
  `(14,8)`, `(15,8)`, `(14,9)`, and `(15,9)`. Its compiled topology must expose
  the required 12-movement subset: straight, right, and left transitions for
  each of the four accepted inbound approaches. The current compiler also
  exposes four center U-turns, but those are characterized separately rather
  than required by the template contract.

Equal validated requests produce equal complete snapshots, including stable
tile and structure IDs. Changing economy, starting capital, or demand settings
changes rules/budget only; it does not change the authored template map.
Checked-in deterministic characterizations cover the complete ordered tile
IDs, non-default tiles, structures, rules, budget, counters, scenario, and
entity-ID collections.

`GameEngine::reset()` reconstructs a candidate from the active snapshot's
persisted sandbox rules, then swaps snapshot and compiled topology together
only after successful construction. Reset therefore discards every player
mutation and restores the exact active template, economy, starting capital,
demand multiplier, and paused move-in setting; Blank Grid cannot reset to
Crossroads or vice versa. Campaign reset is deliberately unsupported: it
returns `SandboxResetError { code: "unsupportedGameMode", context:
{ gameMode: "campaign" } }` and leaves the complete campaign state unchanged.

WASM and Tauri keep domain failures separate from host failures. Their adapters
recognize complete typed creation/reset error objects and return `{ ok: false,
error }`; module loading, serialization, IPC, mutex, and other transport
failures still reject. Built-artifact WASM tests and real Tauri command tests
compare creation, canonical defaults, typed invalid-request errors, and reset
behavior with the direct Rust factory, preventing either host from inventing
fallback state.

At the TypeScript runtime boundary, a recognized reset domain failure is stored
as `sandboxResetError`. It is nonfatal: the current gameplay state, UI state,
existing gameplay rejection, subscriptions, and animation lifecycle remain
active. The next successful reset clears it. An unrecognized rejected reset
promise remains a fatal `backendError`.

### Authored roads and cached topology

Road occupancy is not connectivity. Rust serializes reciprocal tile-edge connections plus stable automatic-junction/roundabout structures. `GameEngine` compiles those authored facts into a non-serialized heading-state `RoadTopology` and commits a candidate snapshot/topology together.

Bus routes use deterministic weighted movement steps (straight, right, left, U-turn, roundabout entry/circulation/exit); metro routes continue to use deterministic track paths. The same Rust-provided step durations drive previews, trip estimates, and vehicle movement.

**Plan deviation — arc vs. bezier geometry.** The route-direction-editing plan called for a `PathGeometry::Arc` variant in the Rust wire format for roundabout curves. The implementation replaced it with `PathGeometry::QuadraticBezier` in the Rust model (`crates/caelum-core/src/model.rs`) to avoid transcendental functions in the deterministic step-progress pipeline. The TypeScript `PathGeometry` type (`src/domain/types.ts`) retains an `arc` variant that is **render-only** — `roundaboutRenderer.ts` generates arc geometry locally for circulation-curve drawing, and `routeGeometry.ts` handles it for offset/projection/keying. The Rust wire format never produces `arc`; route and road path steps from Rust only use `line` and `quadraticBezier`.

### Route lifecycle and editing

Routes store Loop/Shuttle directional service legs with current and last-valid tagged paths. Missing referenced nodes remain non-physical tombstones; exact same-kind/same-anchor rebuilding restores their identity. Route creation and revision-checked updates are atomic Rust intents. TypeScript owns only the unsaved ordered-ID draft and generation-safe rendering of Rust previews.

### Road structures

Roundabouts are Rust-owned fixed counterclockwise 2x2/3x3 stamps. Placement captures compatible boundary ports, may replace only fully contained bare roads/automatic junctions, preserves latent area, and removes as one structure.

## Area zoning layer

`Tile.area` is an independent zoning layer held on each tile alongside the physical `kind`. It is retained across `kind` transitions (painting a road over a zoned tile, then bulldozing the road, leaves the area intact) and the renderer only honors it on `kind === "empty"` tiles. The player paints areas (residential / commercial / industrial / office / civic / park) via drag rectangles in the build panel; Rust owns the paintability gate and the immutable `paintAreaRectangle` intent. Buildings are gated by area: a housing or destination building may only be placed on a tile whose `area` matches the catalog entry's `allowedArea`. Read-only TypeScript catalog data lives under `src/domain/catalog/` for UI and rendering.

The fresh game is the canonical Standard Crossroads sandbox: `$120,000`
starting capital, demand multiplier `1.0`, paused move-in, no campaign
objectives, and no growth waves.
Sandbox ticks continue trips and metrics but never newly win, lose, or apply
authored growth. Explicit campaign snapshots may independently attach
objective thresholds and ordered growth waves; Rust evaluates and applies
those features only in campaign mode.

Serialized campaign thresholds are authoritative: hosts display the values
Rust enforces and do not derive or hard-code a local copy. When an objectives
object is present, its `rollingWindowSeconds` field is required; omitting it is
malformed. Each `ObjectiveThresholds` field is a validated newtype, so invalid
values (non-finite, negative, or — for `rollingWindowSeconds` and
`survivalTimeSeconds` — non-positive) are rejected at the Rust deserialization
boundary as a serde error (surfaced by both hosts as a shell/runtime error —
see the design spec's Error Handling section: serde boundary mismatches are
distinct from `GameplayRejection`) rather than coerced at evaluation time. The
deterministic 300-second constant applies to both trip-outcome retention and
objective scoring when objectives are inactive or absent in their allowed mode
configuration; a present-but-invalid configured rolling window is unreachable
because the newtype rejects it at load.

Growing Suburb remains a campaign scenario name, independent from sandbox
template identity. Its campaign helper currently reuses the canonical
Crossroads sandbox settings while retaining campaign mode, objectives/growth
ownership, and the `"Growing Suburb"` scenario name. Sandboxes use only the
`"Blank Grid"` and `"Crossroads"` scenario/template labels.

## UI shell

The shell is fully Svelte-owned:

- `App.svelte` composes the runtime-backed shell and handles visible shell errors.
- `Topbar.svelte` renders live metrics and pause/speed controls from derived runtime state.
- `CommandShelf.svelte` owns four permanent desktop destinations plus Select and Demolish.
- `CommandPanel.svelte` hosts one non-modal Build, Lines, Data, or City workspace; a route draft pins Lines until Save or Cancel.
- `BuildPanel.svelte` uses four checked-in presentation-only command plates and existing runtime arming paths.
- Contextual Inspect and `ActionFeedback.svelte` are independent of destination navigation.
- `GameCanvas.svelte` provides the imperative canvas host and DOM focus handoff while rendering stays in `src/render`.
- Opening a destination moves focus into its panel. Escape closes a closable panel and returns focus to its shelf trigger; saving or canceling a route draft returns focus to the Lines list, while Escape in a route-name input only cancels that input edit.

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
