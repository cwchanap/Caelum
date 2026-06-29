# Rust Simulation Commute Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Caelum gameplay authority into a shared Rust simulation core, expose it to browser and Tauri, and add recurring daily commute requirements with deterministic shift variation.

**Architecture:** Add a `caelum-core` Rust crate that owns state, intents, ticks, validation, routing, transit, commute requirements, metrics, and objectives. Add thin WASM and Tauri adapters around the same `GameEngine`, then reduce TypeScript runtime code to UI state, event handling, rendering, and backend calls. Migrate as a vertical slice: Rust first proves parity with focused tests, then the frontend switches to snapshots and typed intents from the Rust backend.

**Tech Stack:** Rust 2021, Cargo workspace, serde/serde_json, wasm-bindgen, serde-wasm-bindgen, wasm-pack, Tauri 2 commands/state, TypeScript, Svelte 5, Vite, Bun, Vitest, Playwright.

---

## File Structure

- `Cargo.toml`
  - Create a root workspace containing `src-tauri` and `crates/caelum-core`.
  - `crates/caelum-wasm` is added to the workspace in Task 7 when that crate is created.
- `crates/caelum-core/Cargo.toml`
  - New Rust simulation crate with serde-only dependencies.
- `crates/caelum-core/src/lib.rs`
  - Public module exports for the core.
- `crates/caelum-core/src/model.rs`
  - Rust equivalents of gameplay snapshot types: map, buildings, transit, sims, trips, metrics, scenario.
- `crates/caelum-core/src/ids.rs`
  - Stable id helpers matching existing zero-padded ids.
- `crates/caelum-core/src/clock.rs`
  - 24-hour compressed game clock and speed scaling helpers.
- `crates/caelum-core/src/scenario.rs`
  - Growing Suburb map dimensions, starter roads, seed growth wave, objectives.
- `crates/caelum-core/src/state.rs`
  - Initial `GameState` construction.
- `crates/caelum-core/src/areas.rs`
  - Area paintability, rectangle geometry, area painting.
- `crates/caelum-core/src/building_catalog.rs`
  - Building catalog, costs, footprints, allowed areas, effects.
- `crates/caelum-core/src/buildings.rs`
  - Placement validation, building effects, sim creation, workplace retargeting.
- `crates/caelum-core/src/network.rs`
  - Road/track route pathing and segment validation.
- `crates/caelum-core/src/platforms.rs`
  - Platform capacity and boarding eligibility derivations.
- `crates/caelum-core/src/router.rs`
  - Walk/bus/metro route planning.
- `crates/caelum-core/src/transit.rs`
  - Stops, stations, routes, lines, vehicles, movement, boarding, disembarking.
- `crates/caelum-core/src/commute.rs`
  - Worker/non-worker profiles, shift templates, deterministic jitter, daily requirements.
- `crates/caelum-core/src/trips.rs`
  - Active trip lifecycle, walking/waiting/riding statuses, trip outcomes.
- `crates/caelum-core/src/objectives.rs`
  - Win/loss evaluation and rolling trip-outcome filtering.
- `crates/caelum-core/src/intent.rs`
  - `GameIntent`, `DispatchResult`, rejection reasons.
- `crates/caelum-core/src/engine.rs`
  - `GameEngine` facade with `snapshot`, `dispatch`, `tick`, and `reset`.
- `crates/caelum-core/tests/*.rs`
  - Rust authority tests, grouped by module.
- `crates/caelum-wasm/Cargo.toml`
  - WASM wrapper crate for browser import.
- `crates/caelum-wasm/src/lib.rs`
  - wasm-bindgen facade around `caelum_core::GameEngine`.
- `src-tauri/Cargo.toml`
  - Depend on `caelum-core`.
- `src-tauri/src/lib.rs`
  - Tauri command adapter around managed `GameEngine` state.
- `package.json`
  - Add WASM build scripts and update Rust lint/check scripts to use the workspace.
- `src/runtime/backend/types.ts`
  - TypeScript backend interface plus intent/result aliases used by UI runtime.
- `src/runtime/backend/wasmBackend.ts`
  - Browser WASM backend loader.
- `src/runtime/backend/tauriBackend.ts`
  - Tauri command backend.
- `src/runtime/backend/index.ts`
  - Host backend selection.
- `src/runtime/createGameRuntime.ts`
  - Accept a `GameBackend`; dispatch Rust intents instead of mutating TypeScript gameplay state.
- `src/main.ts`
  - Async backend initialization before mounting `App`.
- `src/runtime/runtimeSelectors.ts`
  - Consume Rust-backed snapshot shape and keep UI-only derivations local.
- `tests/runtime/backend.test.ts`
  - Backend/runtime adapter tests.
- `tests/e2e/smoke.spec.ts`, `tests/e2e/routes.spec.ts`
  - Rust-backed playable smoke coverage.
- Existing `legacy-ts-simulation/*.ts` and `tests/simulation/*.test.ts`
  - Keep as reference during migration, then delete or isolate after Rust parity tests cover the behavior.

---

### Task 1: Rust Workspace And Engine Skeleton

**Files:**
- Create: `Cargo.toml`
- Create: `crates/caelum-core/Cargo.toml`
- Create: `crates/caelum-core/src/lib.rs`
- Create: `crates/caelum-core/src/model.rs`
- Create: `crates/caelum-core/src/engine.rs`
- Create: `crates/caelum-core/src/intent.rs`
- Create: `crates/caelum-core/tests/engine_smoke.rs`
- Modify: `src-tauri/Cargo.toml`
- Modify: `package.json`
- Create/Modify: `Cargo.lock`

- [ ] **Step 1: Write the failing Rust engine smoke test**

Create `crates/caelum-core/tests/engine_smoke.rs`:

```rust
use caelum_core::{GameEngine, GameIntent};

#[test]
fn new_engine_exposes_initial_snapshot() {
    let engine = GameEngine::new();
    let snapshot = engine.snapshot();

    assert_eq!(snapshot.time, 0.0);
    assert_eq!(snapshot.day, 0);
    assert_eq!(snapshot.clock_minutes, 0);
    assert!(snapshot.paused);
    assert_eq!(snapshot.speed, 1);
    assert_eq!(snapshot.map.width, 28);
    assert_eq!(snapshot.map.height, 18);
    assert_eq!(snapshot.metrics.state, "running");
}

#[test]
fn invalid_intent_returns_rejection_and_unchanged_snapshot() {
    let mut engine = GameEngine::new();
    let before = engine.snapshot();

    let result = engine.dispatch(GameIntent::AssignVehicle {
        mode: "bus".to_string(),
        line_id: "missing-route".to_string(),
    });

    assert!(!result.applied);
    assert_eq!(result.snapshot, before);
    assert_eq!(
        result.rejection.as_deref(),
        Some("line not found: missing-route")
    );
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```sh
cargo test -p caelum-core --test engine_smoke
```

Expected: FAIL because the workspace and `caelum-core` crate do not exist.

- [ ] **Step 3: Create the Cargo workspace**

Create root `Cargo.toml`:

```toml
[workspace]
members = [
  "src-tauri",
  "crates/caelum-core",
]
resolver = "2"
```

- [ ] **Step 4: Create `caelum-core` package metadata**

Create `crates/caelum-core/Cargo.toml`:

```toml
[package]
name = "caelum-core"
version = "0.1.0"
edition = "2021"
rust-version = "1.77.2"

[dependencies]
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"
```

- [ ] **Step 5: Add initial model, intent, and engine code**

Create `crates/caelum-core/src/lib.rs`:

```rust
pub mod engine;
pub mod intent;
pub mod model;

pub use engine::GameEngine;
pub use intent::{DispatchResult, GameIntent};
pub use model::GameSnapshot;
```

Create `crates/caelum-core/src/model.rs`:

```rust
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameSnapshot {
    pub time: f64,
    pub day: u32,
    pub clock_minutes: u16,
    pub speed: u8,
    pub paused: bool,
    pub budget: i32,
    pub map: GameMap,
    pub buildings: Vec<PlacedBuilding>,
    pub transit: TransitNetwork,
    pub sims: Vec<Sim>,
    pub active_trips: Vec<ActiveTrip>,
    pub metrics: Metrics,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameMap {
    pub width: u8,
    pub height: u8,
    pub tiles: Vec<Tile>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tile {
    pub id: String,
    pub x: i32,
    pub y: i32,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub area: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub has_track: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub one_way: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlacedBuilding {
    pub id: String,
    pub building_type: String,
    pub origin: Point,
    pub rotation: u16,
    pub occupied_tiles: Vec<Point>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transit_node_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Point {
    pub x: i32,
    pub y: i32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransitNetwork {
    pub stops: Vec<Stop>,
    pub stations: Vec<Station>,
    pub routes: Vec<Route>,
    pub metro_lines: Vec<MetroLine>,
    pub vehicles: Vec<Vehicle>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stop {
    pub id: String,
    pub kind: String,
    pub position: Point,
    pub platforms: Vec<Platform>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Station {
    pub id: String,
    pub position: Point,
    pub platforms: Vec<Platform>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Platform {
    pub id: String,
    pub label: String,
    pub capacity: u16,
    pub route_ids: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Route {
    pub id: String,
    pub name: String,
    pub color: String,
    pub stop_ids: Vec<String>,
    pub vehicle_ids: Vec<String>,
    pub active: bool,
    pub segments: Vec<Vec<Point>>,
    pub path_broken: bool,
}

pub type MetroLine = Route;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Vehicle {
    pub id: String,
    pub mode: String,
    pub line_id: String,
    pub capacity: u16,
    pub passenger_ids: Vec<String>,
    pub segment_index: usize,
    pub progress: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sim {
    pub id: String,
    pub home: Point,
    pub position: Point,
    pub worker_profile: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shift_template: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workplace: Option<Point>,
    pub commute_day: u32,
    pub outbound_arrived_today: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveTrip {
    pub id: String,
    pub sim_id: String,
    pub purpose: String,
    pub origin: Point,
    pub destination: Point,
    pub position: Point,
    pub status: String,
    pub deadline: f64,
    pub route_plan: Option<RoutePlan>,
    pub current_leg_index: usize,
    pub patience_remaining: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutePlan {
    pub legs: Vec<RouteLeg>,
    pub estimated_seconds: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteLeg {
    pub mode: String,
    pub from: Point,
    pub to: Point,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Metrics {
    pub late_trips: u32,
    pub completed_trips: u32,
    pub unserved_trips: u32,
    pub total_wait_seconds: f64,
    pub waiting_trip_count: u32,
    pub average_wait_seconds: f64,
    pub state: String,
    pub loss_reason: Option<String>,
}
```

Create `crates/caelum-core/src/intent.rs`:

```rust
use serde::{Deserialize, Serialize};

use crate::model::GameSnapshot;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum GameIntent {
    AssignVehicle { mode: String, line_id: String },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchResult {
    pub snapshot: GameSnapshot,
    pub applied: bool,
    pub rejection: Option<String>,
}
```

Create `crates/caelum-core/src/engine.rs`:

```rust
use crate::intent::{DispatchResult, GameIntent};
use crate::model::{GameMap, GameSnapshot, Metrics, TransitNetwork};

#[derive(Clone, Debug)]
pub struct GameEngine {
    snapshot: GameSnapshot,
}

impl Default for GameEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl GameEngine {
    pub fn new() -> Self {
        Self {
            snapshot: initial_snapshot(),
        }
    }

    pub fn snapshot(&self) -> GameSnapshot {
        self.snapshot.clone()
    }

    pub fn reset(&mut self) -> GameSnapshot {
        self.snapshot = initial_snapshot();
        self.snapshot()
    }

    pub fn tick(&mut self, _delta_seconds: f64) -> DispatchResult {
        DispatchResult {
            snapshot: self.snapshot(),
            applied: false,
            rejection: None,
        }
    }

    pub fn dispatch(&mut self, intent: GameIntent) -> DispatchResult {
        match intent {
            GameIntent::AssignVehicle { line_id, .. } => DispatchResult {
                snapshot: self.snapshot(),
                applied: false,
                rejection: Some(format!("line not found: {line_id}")),
            },
        }
    }
}

fn initial_snapshot() -> GameSnapshot {
    GameSnapshot {
        time: 0.0,
        day: 0,
        clock_minutes: 0,
        speed: 1,
        paused: true,
        budget: 120_000,
        map: GameMap {
            width: 28,
            height: 18,
            tiles: Vec::new(),
        },
        buildings: Vec::new(),
        transit: TransitNetwork {
            stops: Vec::new(),
            stations: Vec::new(),
            routes: Vec::new(),
            metro_lines: Vec::new(),
            vehicles: Vec::new(),
        },
        sims: Vec::new(),
        active_trips: Vec::new(),
        metrics: Metrics {
            late_trips: 0,
            completed_trips: 0,
            unserved_trips: 0,
            total_wait_seconds: 0.0,
            waiting_trip_count: 0,
            average_wait_seconds: 0.0,
            state: "running".to_string(),
            loss_reason: None,
        },
    }
}
```

- [ ] **Step 6: Link Tauri to the workspace without changing commands yet**

Modify `src-tauri/Cargo.toml` dependencies:

```toml
caelum-core = { path = "../crates/caelum-core" }
```

- [ ] **Step 7: Add workspace Rust scripts**

In `package.json`, replace the Rust scripts with:

```json
"lint:rust": "cargo clippy --workspace --all-targets -- -D warnings",
"format": "prettier --write . --ignore-unknown && cargo fmt --all",
"format:check": "prettier --check . --ignore-unknown && cargo fmt --all --check",
"rust:test": "cargo test --workspace",
"rust:check": "cargo check --workspace"
```

Keep all existing Bun, Vite, and Tauri scripts unchanged.

- [ ] **Step 8: Run scaffold verification**

Run:

```sh
cargo test -p caelum-core --test engine_smoke
bun run rust:check
```

Expected: PASS.

- [ ] **Step 9: Commit**

```sh
git add Cargo.toml Cargo.lock crates/caelum-core src-tauri/Cargo.toml package.json
git commit -m "feat: scaffold rust simulation core"
```

---

### Task 2: Initial Scenario, Ids, And Clock

**Files:**
- Create: `crates/caelum-core/src/ids.rs`
- Create: `crates/caelum-core/src/clock.rs`
- Create: `crates/caelum-core/src/scenario.rs`
- Create: `crates/caelum-core/src/state.rs`
- Modify: `crates/caelum-core/src/lib.rs`
- Modify: `crates/caelum-core/src/engine.rs`
- Test: `crates/caelum-core/tests/scenario_clock.rs`

- [ ] **Step 1: Write failing scenario and clock tests**

Create `crates/caelum-core/tests/scenario_clock.rs`:

```rust
use caelum_core::clock::{clock_minutes, day_index, scaled_delta, GAME_DAY_SECONDS};
use caelum_core::state::create_initial_snapshot;

#[test]
fn game_day_is_twenty_real_minutes_at_one_x() {
    assert_eq!(GAME_DAY_SECONDS, 1_200.0);
    assert_eq!(day_index(0.0), 0);
    assert_eq!(day_index(1_199.9), 0);
    assert_eq!(day_index(1_200.0), 1);
    assert_eq!(clock_minutes(0.0), 0);
    assert_eq!(clock_minutes(600.0), 720);
    assert_eq!(clock_minutes(1_199.9), 1_439);
    assert_eq!(scaled_delta(10.0, 4), 40.0);
}

#[test]
fn initial_map_matches_growing_suburb_surface() {
    let snapshot = create_initial_snapshot();
    assert_eq!(snapshot.map.width, 28);
    assert_eq!(snapshot.map.height, 18);
    assert_eq!(snapshot.map.tiles.len(), 28 * 18);

    let roads = snapshot
        .map
        .tiles
        .iter()
        .filter(|tile| tile.kind == "road")
        .count();
    assert_eq!(roads, 88);

    let west_lane = snapshot
        .map
        .tiles
        .iter()
        .find(|tile| tile.x == 2 && tile.y == 8)
        .unwrap();
    assert_eq!(west_lane.one_way.as_deref(), Some("west"));

    let east_lane = snapshot
        .map
        .tiles
        .iter()
        .find(|tile| tile.x == 2 && tile.y == 9)
        .unwrap();
    assert_eq!(east_lane.one_way.as_deref(), Some("east"));
}
```

- [ ] **Step 2: Run the tests and verify they fail**

Run:

```sh
cargo test -p caelum-core --test scenario_clock
```

Expected: FAIL because `clock`, `ids`, `scenario`, and `state` modules do not exist.

- [ ] **Step 3: Add id helpers**

Create `crates/caelum-core/src/ids.rs`:

```rust
pub fn tile_id(x: i32, y: i32) -> String {
    format!("{x},{y}")
}

pub fn entity_id(prefix: &str, number: usize) -> String {
    format!("{prefix}-{number:03}")
}

pub fn next_entity_id(prefix: &str, existing: impl IntoIterator<Item = String>) -> String {
    let max = existing
        .into_iter()
        .filter_map(|id| {
            id.strip_prefix(&format!("{prefix}-"))
                .and_then(|suffix| suffix.parse::<usize>().ok())
        })
        .max()
        .unwrap_or(0);
    entity_id(prefix, max + 1)
}
```

- [ ] **Step 4: Add clock helpers**

Create `crates/caelum-core/src/clock.rs`:

```rust
pub const GAME_DAY_SECONDS: f64 = 1_200.0;
pub const MINUTES_PER_DAY: u16 = 1_440;

pub fn scaled_delta(delta_seconds: f64, speed: u8) -> f64 {
    delta_seconds.max(0.0) * f64::from(speed)
}

pub fn day_index(time_seconds: f64) -> u32 {
    (time_seconds.max(0.0) / GAME_DAY_SECONDS).floor() as u32
}

pub fn clock_minutes(time_seconds: f64) -> u16 {
    let day_time = time_seconds.max(0.0) % GAME_DAY_SECONDS;
    ((day_time / GAME_DAY_SECONDS) * f64::from(MINUTES_PER_DAY)).floor() as u16
}
```

- [ ] **Step 5: Add Growing Suburb scenario map**

Create `crates/caelum-core/src/scenario.rs`:

```rust
use crate::ids::tile_id;
use crate::model::{GameMap, Tile};

pub const MAP_WIDTH: u8 = 28;
pub const MAP_HEIGHT: u8 = 18;

fn starter_road_direction(x: i32, y: i32) -> Option<String> {
    let horizontal = y == 8 || y == 9;
    let vertical = x == 14 || x == 15;

    if horizontal && vertical {
        None
    } else if y == 8 {
        Some("west".to_string())
    } else if y == 9 {
        Some("east".to_string())
    } else if x == 14 {
        Some("south".to_string())
    } else if x == 15 {
        Some("north".to_string())
    } else {
        None
    }
}

fn is_starter_road(x: i32, y: i32) -> bool {
    y == 8 || y == 9 || x == 14 || x == 15
}

pub fn create_growing_suburb_map() -> GameMap {
    let mut tiles = Vec::new();

    for y in 0..i32::from(MAP_HEIGHT) {
        for x in 0..i32::from(MAP_WIDTH) {
            tiles.push(Tile {
                id: tile_id(x, y),
                x,
                y,
                kind: if is_starter_road(x, y) { "road" } else { "empty" }.to_string(),
                area: None,
                has_track: false,
                one_way: starter_road_direction(x, y),
            });
        }
    }

    GameMap {
        width: MAP_WIDTH,
        height: MAP_HEIGHT,
        tiles,
    }
}
```

- [ ] **Step 6: Move initial snapshot creation out of `engine.rs`**

Create `crates/caelum-core/src/state.rs`:

```rust
use crate::clock::{clock_minutes, day_index};
use crate::model::{GameSnapshot, Metrics, TransitNetwork};
use crate::scenario::create_growing_suburb_map;

pub fn create_initial_snapshot() -> GameSnapshot {
    GameSnapshot {
        time: 0.0,
        day: day_index(0.0),
        clock_minutes: clock_minutes(0.0),
        speed: 1,
        paused: true,
        budget: 120_000,
        map: create_growing_suburb_map(),
        buildings: Vec::new(),
        transit: TransitNetwork {
            stops: Vec::new(),
            stations: Vec::new(),
            routes: Vec::new(),
            metro_lines: Vec::new(),
            vehicles: Vec::new(),
        },
        sims: Vec::new(),
        active_trips: Vec::new(),
        metrics: Metrics {
            late_trips: 0,
            completed_trips: 0,
            unserved_trips: 0,
            total_wait_seconds: 0.0,
            waiting_trip_count: 0,
            average_wait_seconds: 0.0,
            state: "running".to_string(),
            loss_reason: None,
        },
    }
}
```

Modify `crates/caelum-core/src/lib.rs`:

```rust
pub mod clock;
pub mod engine;
pub mod ids;
pub mod intent;
pub mod model;
pub mod scenario;
pub mod state;

pub use engine::GameEngine;
pub use intent::{DispatchResult, GameIntent};
pub use model::GameSnapshot;
```

Modify `crates/caelum-core/src/engine.rs` to import and use `create_initial_snapshot()`:

```rust
use crate::intent::{DispatchResult, GameIntent};
use crate::model::GameSnapshot;
use crate::state::create_initial_snapshot;
```

Replace both calls to `initial_snapshot()` with `create_initial_snapshot()`, then remove the private `initial_snapshot()` function.

- [ ] **Step 7: Run scenario and engine tests**

Run:

```sh
cargo test -p caelum-core --test scenario_clock
cargo test -p caelum-core --test engine_smoke
```

Expected: PASS.

- [ ] **Step 8: Commit**

```sh
git add crates/caelum-core
git commit -m "feat: add rust scenario clock"
```

---

### Task 3: Areas, Buildings, And Sims

**Files:**
- Create: `crates/caelum-core/src/areas.rs`
- Create: `crates/caelum-core/src/building_catalog.rs`
- Create: `crates/caelum-core/src/buildings.rs`
- Create: `crates/caelum-core/src/commute.rs`
- Modify: `crates/caelum-core/src/lib.rs`
- Modify: `crates/caelum-core/src/model.rs`
- Modify: `crates/caelum-core/src/intent.rs`
- Modify: `crates/caelum-core/src/engine.rs`
- Test: `crates/caelum-core/tests/areas_buildings.rs`

- [ ] **Step 1: Write failing area/building/sim tests**

Create `crates/caelum-core/tests/areas_buildings.rs`:

```rust
use caelum_core::{GameEngine, GameIntent};

#[test]
fn paint_area_rectangle_skips_starter_roads() {
    let mut engine = GameEngine::new();

    let result = engine.dispatch(GameIntent::PaintAreaRectangle {
        area: "residential".to_string(),
        start: (13, 8).into(),
        end: (16, 10).into(),
    });

    assert!(result.applied);
    let road = result
        .snapshot
        .map
        .tiles
        .iter()
        .find(|tile| tile.x == 14 && tile.y == 8)
        .unwrap();
    assert_eq!(road.kind, "road");
    assert_eq!(road.area, None);

    let empty = result
        .snapshot
        .map
        .tiles
        .iter()
        .find(|tile| tile.x == 13 && tile.y == 10)
        .unwrap();
    assert_eq!(empty.area.as_deref(), Some("residential"));
}

#[test]
fn housing_requires_residential_area_and_creates_deterministic_sims() {
    let mut engine = GameEngine::new();

    let rejected = engine.dispatch(GameIntent::PlaceBuilding {
        building_type: "smallHouse".to_string(),
        origin: (2, 3).into(),
        rotation: 0,
    });
    assert!(!rejected.applied);
    assert_eq!(rejected.rejection.as_deref(), Some("area mismatch"));

    engine.dispatch(GameIntent::PaintAreaRectangle {
        area: "residential".to_string(),
        start: (2, 3).into(),
        end: (3, 4).into(),
    });
    let placed = engine.dispatch(GameIntent::PlaceBuilding {
        building_type: "smallHouse".to_string(),
        origin: (2, 3).into(),
        rotation: 0,
    });

    assert!(placed.applied);
    assert_eq!(placed.snapshot.buildings.len(), 1);
    assert_eq!(placed.snapshot.sims.len(), 10);
    assert_eq!(placed.snapshot.sims[0].id, "sim-001");
    assert_eq!(placed.snapshot.sims[0].home.x, 2);
    assert_eq!(placed.snapshot.sims[0].worker_profile, "worker");
}

#[test]
fn destination_assigns_workplaces_to_unassigned_workers() {
    let mut engine = GameEngine::new();
    engine.dispatch(GameIntent::PaintAreaRectangle {
        area: "residential".to_string(),
        start: (2, 3).into(),
        end: (3, 4).into(),
    });
    engine.dispatch(GameIntent::PlaceBuilding {
        building_type: "smallHouse".to_string(),
        origin: (2, 3).into(),
        rotation: 0,
    });
    engine.dispatch(GameIntent::PaintAreaRectangle {
        area: "commercial".to_string(),
        start: (8, 3).into(),
        end: (9, 4).into(),
    });
    let result = engine.dispatch(GameIntent::PlaceBuilding {
        building_type: "supermarket".to_string(),
        origin: (8, 3).into(),
        rotation: 0,
    });

    assert!(result.applied);
    let assigned = result
        .snapshot
        .sims
        .iter()
        .filter(|sim| sim.worker_profile == "worker" && sim.workplace.is_some())
        .count();
    assert_eq!(assigned, 9);
}
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```sh
cargo test -p caelum-core --test areas_buildings
```

Expected: FAIL because area and building intents do not exist.

- [ ] **Step 3: Add tuple-to-point conversion for concise tests**

Modify `crates/caelum-core/src/model.rs` after `Point`:

```rust
impl From<(i32, i32)> for Point {
    fn from(value: (i32, i32)) -> Self {
        Self {
            x: value.0,
            y: value.1,
        }
    }
}
```

- [ ] **Step 4: Add area helpers**

Create `crates/caelum-core/src/areas.rs`:

```rust
use crate::model::{GameSnapshot, Point};

pub const AREAS: [&str; 6] = [
    "residential",
    "commercial",
    "industrial",
    "office",
    "civic",
    "park",
];

pub fn rectangle_points(start: &Point, end: &Point) -> Vec<Point> {
    let min_x = start.x.min(end.x);
    let max_x = start.x.max(end.x);
    let min_y = start.y.min(end.y);
    let max_y = start.y.max(end.y);
    let mut points = Vec::new();
    for y in min_y..=max_y {
        for x in min_x..=max_x {
            points.push(Point { x, y });
        }
    }
    points
}

pub fn is_area_paintable(state: &GameSnapshot, point: &Point) -> bool {
    let tile = state
        .map
        .tiles
        .iter()
        .find(|tile| tile.x == point.x && tile.y == point.y);
    let Some(tile) = tile else {
        return false;
    };
    if tile.kind != "empty" || tile.has_track {
        return false;
    }
    let building_occupied = state.buildings.iter().any(|building| {
        building
            .occupied_tiles
            .iter()
            .any(|tile| tile.x == point.x && tile.y == point.y)
    });
    let stop_occupied = state
        .transit
        .stops
        .iter()
        .any(|stop| stop.position.x == point.x && stop.position.y == point.y);
    let station_occupied = state.transit.stations.iter().any(|station| {
        station.position.x == point.x && station.position.y == point.y
    });
    !building_occupied && !stop_occupied && !station_occupied
}

pub fn paint_area_rectangle(
    state: &GameSnapshot,
    area: &str,
    start: &Point,
    end: &Point,
) -> Option<GameSnapshot> {
    if !AREAS.contains(&area) {
        return None;
    }

    let points = rectangle_points(start, end);
    let mut next = state.clone();
    let mut changed = false;

    for tile in &mut next.map.tiles {
        if points.iter().any(|point| point.x == tile.x && point.y == tile.y)
            && is_area_paintable(state, &Point { x: tile.x, y: tile.y })
            && tile.area.as_deref() != Some(area)
        {
            tile.area = Some(area.to_string());
            changed = true;
        }
    }

    changed.then_some(next)
}
```

- [ ] **Step 5: Add commute profile assignment**

Create `crates/caelum-core/src/commute.rs`:

```rust
pub fn numeric_id_suffix(id: &str) -> usize {
    id.rsplit('-')
        .next()
        .and_then(|suffix| suffix.parse::<usize>().ok())
        .unwrap_or(1)
}

pub fn worker_profile_for_id(id: &str) -> String {
    if numeric_id_suffix(id) % 10 == 0 {
        "nonWorker".to_string()
    } else {
        "worker".to_string()
    }
}

pub fn shift_template_for_id(id: &str) -> Option<String> {
    if worker_profile_for_id(id) != "worker" {
        return None;
    }
    let bucket = numeric_id_suffix(id) % 10;
    let template = match bucket {
        1..=7 => "standard",
        8 => "early",
        9 => "late",
        _ => "offPeak",
    };
    Some(template.to_string())
}
```

- [ ] **Step 6: Add building catalog and placement**

Create `crates/caelum-core/src/building_catalog.rs` with catalog entries matching `legacy-ts-simulation/buildingCatalog.ts`. Use this structure:

```rust
#[derive(Clone, Debug, PartialEq)]
pub struct BuildingDefinition {
    pub building_type: &'static str,
    pub label: &'static str,
    pub width: i32,
    pub height: i32,
    pub cost: i32,
    pub allowed_area: Option<&'static str>,
    pub effect: &'static str,
    pub citizen_count: usize,
}

pub const BUILDINGS: &[BuildingDefinition] = &[
    BuildingDefinition {
        building_type: "smallHouse",
        label: "Small House",
        width: 1,
        height: 1,
        cost: 2_500,
        allowed_area: Some("residential"),
        effect: "housing",
        citizen_count: 10,
    },
    BuildingDefinition {
        building_type: "supermarket",
        label: "Supermarket",
        width: 2,
        height: 2,
        cost: 12_000,
        allowed_area: Some("commercial"),
        effect: "destination",
        citizen_count: 0,
    },
];

pub fn building_definition(building_type: &str) -> Option<&'static BuildingDefinition> {
    BUILDINGS
        .iter()
        .find(|definition| definition.building_type == building_type)
}
```

Add the remaining existing catalog entries in the same file before running full tests: `largeHouse`, `cinema`, `factory`, `warehouse`, `officeTower`, `businessPark`, `clinic`, `school`, `parkPlaza`, `busStop`, `busTerminal`, and `metroStation`, using the costs, dimensions, and effects from `legacy-ts-simulation/buildingCatalog.ts`.

Create `crates/caelum-core/src/buildings.rs`:

```rust
use crate::building_catalog::{building_definition, BuildingDefinition};
use crate::commute::{shift_template_for_id, worker_profile_for_id};
use crate::ids::{entity_id, next_entity_id};
use crate::model::{GameSnapshot, PlacedBuilding, Point, Sim};

pub fn footprint(definition: &BuildingDefinition, origin: &Point, rotation: u16) -> Vec<Point> {
    let (width, height) = if rotation == 90 || rotation == 270 {
        (definition.height, definition.width)
    } else {
        (definition.width, definition.height)
    };
    let mut points = Vec::new();
    for y in 0..height {
        for x in 0..width {
            points.push(Point {
                x: origin.x + x,
                y: origin.y + y,
            });
        }
    }
    points
}

pub fn destination_points(state: &GameSnapshot) -> Vec<Point> {
    state
        .buildings
        .iter()
        .filter(|building| {
            building_definition(&building.building_type)
                .map(|definition| definition.effect == "destination")
                .unwrap_or(false)
        })
        .flat_map(|building| building.occupied_tiles.clone())
        .collect()
}

pub fn can_place_building(
    state: &GameSnapshot,
    building_type: &str,
    origin: &Point,
    rotation: u16,
) -> Result<Vec<Point>, String> {
    let definition = building_definition(building_type)
        .ok_or_else(|| format!("unknown building: {building_type}"))?;
    let points = footprint(definition, origin, rotation);

    for point in &points {
        let tile = state
            .map
            .tiles
            .iter()
            .find(|tile| tile.x == point.x && tile.y == point.y)
            .ok_or_else(|| "off map".to_string())?;
        if tile.kind != "empty" {
            return Err("tile is not empty".to_string());
        }
        if tile.has_track {
            return Err("track occupied".to_string());
        }
        if definition.allowed_area.is_some() && tile.area.as_deref() != definition.allowed_area {
            return Err("area mismatch".to_string());
        }
    }

    let building_occupied = state.buildings.iter().any(|building| {
        building.occupied_tiles.iter().any(|occupied| {
            points
                .iter()
                .any(|point| point.x == occupied.x && point.y == occupied.y)
        })
    });
    if building_occupied {
        return Err("building occupied".to_string());
    }

    Ok(points)
}

pub fn place_building(
    state: &GameSnapshot,
    building_type: &str,
    origin: &Point,
    rotation: u16,
) -> Result<GameSnapshot, String> {
    let definition = building_definition(building_type)
        .ok_or_else(|| format!("unknown building: {building_type}"))?;
    if state.budget < definition.cost {
        return Err("insufficient budget".to_string());
    }
    let occupied_tiles = can_place_building(state, building_type, origin, rotation)?;
    let mut next = state.clone();
    let building_id = next_entity_id(
        "building",
        next.buildings.iter().map(|building| building.id.clone()),
    );
    next.budget -= definition.cost;
    next.buildings.push(PlacedBuilding {
        id: building_id,
        building_type: building_type.to_string(),
        origin: origin.clone(),
        rotation,
        occupied_tiles: occupied_tiles.clone(),
        transit_node_id: None,
    });

    if definition.effect == "housing" {
        let start = next.sims.len();
        for index in 0..definition.citizen_count {
            let id = entity_id("sim", start + index + 1);
            let home = occupied_tiles[index % occupied_tiles.len()].clone();
            let worker_profile = worker_profile_for_id(&id);
            next.sims.push(Sim {
                id: id.clone(),
                home: home.clone(),
                position: home,
                worker_profile,
                shift_template: shift_template_for_id(&id),
                workplace: None,
                commute_day: 0,
                outbound_arrived_today: false,
            });
        }
    }

    if definition.effect == "destination" {
        assign_workplaces(&mut next);
    }

    Ok(next)
}

pub fn assign_workplaces(state: &mut GameSnapshot) {
    let destinations = destination_points(state);
    if destinations.is_empty() {
        return;
    }
    let mut worker_index = 0;
    for sim in &mut state.sims {
        if sim.worker_profile == "worker" && sim.workplace.is_none() {
            sim.workplace = Some(destinations[worker_index % destinations.len()].clone());
            worker_index += 1;
        }
    }
}
```

- [ ] **Step 7: Wire modules and intents**

Modify `crates/caelum-core/src/lib.rs`:

```rust
pub mod areas;
pub mod building_catalog;
pub mod buildings;
pub mod clock;
pub mod commute;
pub mod engine;
pub mod ids;
pub mod intent;
pub mod model;
pub mod scenario;
pub mod state;
```

Modify `crates/caelum-core/src/intent.rs`:

```rust
use crate::model::{GameSnapshot, Point};

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum GameIntent {
    AssignVehicle { mode: String, line_id: String },
    PaintAreaRectangle { area: String, start: Point, end: Point },
    PlaceBuilding {
        building_type: String,
        origin: Point,
        rotation: u16,
    },
}
```

Modify `crates/caelum-core/src/engine.rs` dispatch match:

```rust
GameIntent::PaintAreaRectangle { area, start, end } => {
    match crate::areas::paint_area_rectangle(&self.snapshot, &area, &start, &end) {
        Some(next) => {
            self.snapshot = next;
            DispatchResult {
                snapshot: self.snapshot(),
                applied: true,
                rejection: None,
            }
        }
        None => DispatchResult {
            snapshot: self.snapshot(),
            applied: false,
            rejection: Some("no paintable tiles".to_string()),
        },
    }
}
GameIntent::PlaceBuilding {
    building_type,
    origin,
    rotation,
} => match crate::buildings::place_building(
    &self.snapshot,
    &building_type,
    &origin,
    rotation,
) {
    Ok(next) => {
        self.snapshot = next;
        DispatchResult {
            snapshot: self.snapshot(),
            applied: true,
            rejection: None,
        }
    }
    Err(rejection) => DispatchResult {
        snapshot: self.snapshot(),
        applied: false,
        rejection: Some(rejection),
    },
},
```

- [ ] **Step 8: Run tests**

Run:

```sh
cargo test -p caelum-core --test areas_buildings
cargo test -p caelum-core --test engine_smoke
```

Expected: PASS.

- [ ] **Step 9: Commit**

```sh
git add crates/caelum-core
git commit -m "feat: add rust areas buildings sims"
```

---

### Task 4: Transit, Network, Routing, And Vehicle Parity

**Files:**
- Create: `crates/caelum-core/src/network.rs`
- Create: `crates/caelum-core/src/platforms.rs`
- Create: `crates/caelum-core/src/router.rs`
- Create: `crates/caelum-core/src/transit.rs`
- Modify: `crates/caelum-core/src/lib.rs`
- Modify: `crates/caelum-core/src/intent.rs`
- Modify: `crates/caelum-core/src/engine.rs`
- Test: `crates/caelum-core/tests/transit_router.rs`

- [ ] **Step 1: Write failing transit/router tests**

Create `crates/caelum-core/tests/transit_router.rs`:

```rust
use caelum_core::{GameEngine, GameIntent};

fn road_line(engine: &mut GameEngine, y: i32, from_x: i32, to_x: i32) {
    for x in from_x..=to_x {
        engine.dispatch(GameIntent::LayRoad { point: (x, y).into() });
    }
}

#[test]
fn bus_route_vehicle_carries_commute_trip() {
    let mut engine = GameEngine::new();
    road_line(&mut engine, 5, 2, 12);

    engine.dispatch(GameIntent::AddBusStop {
        point: (2, 5).into(),
        kind: "busStop".to_string(),
    });
    engine.dispatch(GameIntent::AddBusStop {
        point: (12, 5).into(),
        kind: "busStop".to_string(),
    });
    let route = engine.dispatch(GameIntent::AddBusRoute {
        stop_ids: vec!["stop-001".to_string(), "stop-002".to_string()],
    });
    assert!(route.applied);
    assert_eq!(route.snapshot.transit.routes[0].path_broken, false);

    let vehicle = engine.dispatch(GameIntent::AssignVehicle {
        mode: "bus".to_string(),
        line_id: "route-001".to_string(),
    });
    assert!(vehicle.applied);
    assert_eq!(vehicle.snapshot.transit.vehicles.len(), 1);
}

#[test]
fn removing_road_marks_route_broken() {
    let mut engine = GameEngine::new();
    road_line(&mut engine, 5, 2, 12);
    engine.dispatch(GameIntent::AddBusStop {
        point: (2, 5).into(),
        kind: "busStop".to_string(),
    });
    engine.dispatch(GameIntent::AddBusStop {
        point: (12, 5).into(),
        kind: "busStop".to_string(),
    });
    engine.dispatch(GameIntent::AddBusRoute {
        stop_ids: vec!["stop-001".to_string(), "stop-002".to_string()],
    });

    let removed = engine.dispatch(GameIntent::RemoveAtTile { point: (7, 5).into() });

    assert!(removed.applied);
    assert!(removed.snapshot.transit.routes[0].path_broken);
}
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```sh
cargo test -p caelum-core --test transit_router
```

Expected: FAIL because transit intents and modules do not exist.

- [ ] **Step 3: Add transit intents**

Extend `GameIntent` in `crates/caelum-core/src/intent.rs`:

```rust
LayRoad { point: Point },
CycleRoadDirection { point: Point },
LayTrack { point: Point },
RemoveAtTile { point: Point },
AddBusStop { point: Point, kind: String },
AddMetroStation { point: Point },
AddBusRoute { stop_ids: Vec<String> },
AddMetroLine { station_ids: Vec<String> },
SetRouteActive { route_id: String, active: bool },
RenameRoute { route_id: String, name: String },
RecolorRoute { route_id: String, color: String },
DeleteRoute { route_id: String },
AssignRouteToPlatform {
    node_id: String,
    route_id: String,
    platform_id: String,
},
```

- [ ] **Step 4: Implement pathing and routing by translating current TypeScript behavior**

Create `crates/caelum-core/src/network.rs`, `platforms.rs`, `router.rs`, and `transit.rs` by translating these current TypeScript modules:

- `legacy-ts-simulation/network.ts` -> `network.rs`
- `legacy-ts-simulation/platforms.ts` -> `platforms.rs`
- `legacy-ts-simulation/router.ts` -> `router.rs`
- `legacy-ts-simulation/transit.ts` -> `transit.rs`
- `legacy-ts-simulation/tileQueries.ts` helper behavior -> small private helpers in the modules that need them

Use these public Rust function signatures:

```rust
// network.rs
pub fn compute_route_segments(map: &crate::model::GameMap, anchors: &[crate::model::Point], mode: &str) -> Vec<Vec<crate::model::Point>>;
pub fn has_broken_segment(segments: &[Vec<crate::model::Point>]) -> bool;

// platforms.rs
pub fn bus_platforms(stop_id: &str, kind: &str) -> Vec<crate::model::Platform>;
pub fn metro_platforms(station_id: &str) -> Vec<crate::model::Platform>;
pub fn on_platform_trip_ids(state: &crate::model::GameSnapshot) -> std::collections::HashSet<String>;

// router.rs
pub fn find_route_plan(
    state: &crate::model::GameSnapshot,
    origin: &crate::model::Point,
    destination: &crate::model::Point,
) -> Option<crate::model::RoutePlan>;

// transit.rs
pub fn lay_road(state: &crate::model::GameSnapshot, point: &crate::model::Point) -> Result<crate::model::GameSnapshot, String>;
pub fn lay_track(state: &crate::model::GameSnapshot, point: &crate::model::Point) -> Result<crate::model::GameSnapshot, String>;
pub fn remove_at_tile(state: &crate::model::GameSnapshot, point: &crate::model::Point) -> Result<crate::model::GameSnapshot, String>;
pub fn add_bus_stop(state: &crate::model::GameSnapshot, point: &crate::model::Point, kind: &str) -> Result<crate::model::GameSnapshot, String>;
pub fn add_metro_station(state: &crate::model::GameSnapshot, point: &crate::model::Point) -> Result<crate::model::GameSnapshot, String>;
pub fn add_bus_route(state: &crate::model::GameSnapshot, stop_ids: Vec<String>) -> Result<crate::model::GameSnapshot, String>;
pub fn add_metro_line(state: &crate::model::GameSnapshot, station_ids: Vec<String>) -> Result<crate::model::GameSnapshot, String>;
pub fn assign_vehicle(state: &crate::model::GameSnapshot, mode: &str, line_id: &str) -> Result<crate::model::GameSnapshot, String>;
pub fn tick_vehicles(state: &crate::model::GameSnapshot, delta_seconds: f64) -> crate::model::GameSnapshot;
```

Keep constants aligned with current TypeScript:

```rust
pub const BUS_STOP_COST: i32 = 2_000;
pub const METRO_STATION_COST: i32 = 25_000;
pub const BUS_COST: i32 = 8_000;
pub const METRO_COST: i32 = 50_000;
pub const ROAD_COST: i32 = 100;
pub const TRACK_COST: i32 = 500;
pub const BUS_TILES_PER_SECOND: f64 = 0.8;
pub const METRO_TILES_PER_SECOND: f64 = 1.6;
```

- [ ] **Step 5: Wire engine dispatch to transit functions**

Add match arms in `crates/caelum-core/src/engine.rs` that call the public functions listed above. Each `Ok(next)` must assign `self.snapshot = next` and return `applied: true`; each `Err(rejection)` must return unchanged snapshot with `applied: false`.

- [ ] **Step 6: Run focused transit tests**

Run:

```sh
cargo test -p caelum-core --test transit_router
```

Expected: PASS.

- [ ] **Step 7: Add golden/characterization tests from existing TypeScript tests**

Translate the behavior asserted in these files into Rust tests under `crates/caelum-core/tests/`:

- `tests/simulation/network.test.ts` -> `network_paths.rs`
- `tests/simulation/router.test.ts` -> `router_planning.rs`
- `tests/simulation/transit.test.ts` -> `transit_build.rs`
- `tests/simulation/platforms.test.ts` -> `platforms.rs`

Each Rust test should use `GameEngine` intents rather than private mutation helpers when the behavior is player-visible. Use module functions directly only for pure helper tests such as path segment computation. These pin Rust behavior to values derived from the TS oracle at authoring time; a live cross-implementation harness is deferred to Tasks 7–12.

- [ ] **Step 8: Run transit characterization suite**

Run:

```sh
cargo test -p caelum-core --test network_paths --test router_planning --test transit_build --test platforms
```

Expected: PASS.

- [ ] **Step 9: Commit**

```sh
git add crates/caelum-core
git commit -m "feat: port transit routing to rust"
```

---

### Task 5: Daily Commute Requirements And Trip Lifecycle

**Files:**
- Modify: `crates/caelum-core/src/commute.rs`
- Create: `crates/caelum-core/src/trips.rs`
- Modify: `crates/caelum-core/src/engine.rs`
- Modify: `crates/caelum-core/src/lib.rs`
- Modify: `crates/caelum-core/src/model.rs`
- Test: `crates/caelum-core/tests/commute_requirements.rs`

- [ ] **Step 1: Write failing commute requirement tests**

Create `crates/caelum-core/tests/commute_requirements.rs`:

```rust
use caelum_core::commute::{departure_minute_for_sim, shift_template_for_id, worker_profile_for_id};
use caelum_core::{GameEngine, GameIntent};

#[test]
fn deterministic_worker_and_shift_distribution() {
    assert_eq!(worker_profile_for_id("sim-001"), "worker");
    assert_eq!(worker_profile_for_id("sim-010"), "nonWorker");
    assert_eq!(shift_template_for_id("sim-001").as_deref(), Some("standard"));
    assert_eq!(shift_template_for_id("sim-008").as_deref(), Some("early"));
    assert_eq!(shift_template_for_id("sim-009").as_deref(), Some("late"));
    assert_eq!(shift_template_for_id("sim-020"), None);
}

#[test]
fn departure_jitter_is_stable_and_inside_window() {
    let first = departure_minute_for_sim("sim-001", "standard", "outbound");
    let second = departure_minute_for_sim("sim-001", "standard", "outbound");
    assert_eq!(first, second);
    assert!((420..=540).contains(&first));
}

#[test]
fn outbound_requirement_spawns_for_assigned_workers() {
    let mut engine = GameEngine::new();
    engine.dispatch(GameIntent::PaintAreaRectangle {
        area: "residential".to_string(),
        start: (2, 3).into(),
        end: (3, 4).into(),
    });
    engine.dispatch(GameIntent::PlaceBuilding {
        building_type: "smallHouse".to_string(),
        origin: (2, 3).into(),
        rotation: 0,
    });
    engine.dispatch(GameIntent::PaintAreaRectangle {
        area: "commercial".to_string(),
        start: (8, 3).into(),
        end: (9, 4).into(),
    });
    engine.dispatch(GameIntent::PlaceBuilding {
        building_type: "supermarket".to_string(),
        origin: (8, 3).into(),
        rotation: 0,
    });
    engine.dispatch(GameIntent::SetPaused { paused: false });

    let result = engine.tick(360.0);

    assert!(result.snapshot.active_trips.iter().any(|trip| {
        trip.sim_id == "sim-001" && trip.purpose == "commuteOutbound"
    }));
}

#[test]
fn return_requirement_requires_successful_outbound() {
    let mut engine = GameEngine::new();
    engine.dispatch(GameIntent::PaintAreaRectangle {
        area: "residential".to_string(),
        start: (2, 3).into(),
        end: (2, 3).into(),
    });
    engine.dispatch(GameIntent::PlaceBuilding {
        building_type: "smallHouse".to_string(),
        origin: (2, 3).into(),
        rotation: 0,
    });
    engine.dispatch(GameIntent::SetPaused { paused: false });

    let evening = engine.tick(900.0);

    assert_eq!(evening.snapshot.active_trips.len(), 0);
    assert_eq!(evening.snapshot.metrics.unserved_trips, 0);
}
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```sh
cargo test -p caelum-core --test commute_requirements
```

Expected: FAIL because `SetPaused`, `departure_minute_for_sim`, and trip generation do not exist.

- [ ] **Step 3: Add commute windows and deterministic jitter**

Extend `crates/caelum-core/src/commute.rs`:

```rust
pub fn departure_minute_for_sim(sim_id: &str, template: &str, direction: &str) -> u16 {
    let (start, end) = match (template, direction) {
        ("standard", "outbound") => (420, 540),
        ("standard", "return") => (1_020, 1_140),
        ("early", "outbound") => (330, 420),
        ("early", "return") => (900, 990),
        ("late", "outbound") => (600, 690),
        ("late", "return") => (1_170, 1_260),
        ("offPeak", "outbound") => (780, 870),
        ("offPeak", "return") => (1_080, 1_170),
        _ => (420, 540),
    };
    let span = end - start;
    let jitter = numeric_id_suffix(sim_id) as u16 % (span + 1);
    start + jitter
}

pub fn trip_deadline_seconds(scheduled_time: f64) -> f64 {
    scheduled_time + 900.0
}
```

- [ ] **Step 4: Add pause/speed intents**

Extend `GameIntent`:

```rust
SetPaused { paused: bool },
SetSpeed { speed: u8 },
```

Add engine match arms:

```rust
GameIntent::SetPaused { paused } => {
    self.snapshot.paused = paused;
    DispatchResult {
        snapshot: self.snapshot(),
        applied: true,
        rejection: None,
    }
}
GameIntent::SetSpeed { speed } if matches!(speed, 0 | 1 | 2 | 4) => {
    self.snapshot.speed = speed;
    DispatchResult {
        snapshot: self.snapshot(),
        applied: true,
        rejection: None,
    }
}
GameIntent::SetSpeed { speed } => DispatchResult {
    snapshot: self.snapshot(),
    applied: false,
    rejection: Some(format!("invalid speed: {speed}")),
},
```

- [ ] **Step 5: Implement trip generation and ticking**

Create `crates/caelum-core/src/trips.rs`:

```rust
use crate::clock::{clock_minutes, day_index, scaled_delta};
use crate::commute::{departure_minute_for_sim, trip_deadline_seconds};
use crate::ids::entity_id;
use crate::model::{ActiveTrip, GameSnapshot, Point};
use crate::router::find_route_plan;

pub fn tick_trips(state: &GameSnapshot, delta_seconds: f64) -> GameSnapshot {
    if state.paused || state.metrics.state != "running" || state.speed == 0 {
        return state.clone();
    }
    let delta = scaled_delta(delta_seconds, state.speed);
    let mut next = state.clone();
    next.time += delta;
    next.day = day_index(next.time);
    next.clock_minutes = clock_minutes(next.time);
    spawn_due_commutes(&mut next);
    advance_active_trips(&mut next, delta);
    next
}

fn spawn_due_commutes(state: &mut GameSnapshot) {
    let day = state.day;
    let now = state.clock_minutes;
    let mut spawned = state.active_trips.len();

    for sim in &mut state.sims {
        if sim.worker_profile != "worker" {
            continue;
        }
        let Some(template) = sim.shift_template.clone() else {
            continue;
        };
        let Some(workplace) = sim.workplace.clone() else {
            continue;
        };
        if sim.commute_day != day {
            sim.commute_day = day;
            sim.outbound_arrived_today = false;
        }
        let outbound = departure_minute_for_sim(&sim.id, &template, "outbound");
        let already_outbound = state.active_trips.iter().any(|trip| {
            trip.sim_id == sim.id && trip.purpose == "commuteOutbound" && trip.id.contains(&format!("day-{day}"))
        });
        if now >= outbound && !already_outbound && !sim.outbound_arrived_today {
            spawned += 1;
            let scheduled = (f64::from(day) * crate::clock::GAME_DAY_SECONDS)
                + (f64::from(outbound) / f64::from(crate::clock::MINUTES_PER_DAY))
                    * crate::clock::GAME_DAY_SECONDS;
            state.active_trips.push(ActiveTrip {
                id: format!("trip-day-{day}-{}", entity_id("trip", spawned)),
                sim_id: sim.id.clone(),
                purpose: "commuteOutbound".to_string(),
                origin: sim.home.clone(),
                destination: workplace,
                position: sim.position.clone(),
                status: "idle".to_string(),
                deadline: trip_deadline_seconds(scheduled),
                route_plan: None,
                current_leg_index: 0,
                patience_remaining: 240.0,
            });
        }
    }
}

fn advance_active_trips(state: &mut GameSnapshot, _delta_seconds: f64) {
    let snapshot = state.clone();
    for trip in &mut state.active_trips {
        if trip.status == "idle" && trip.route_plan.is_none() {
            trip.route_plan = find_route_plan(&snapshot, &trip.position, &trip.destination);
            trip.status = if trip.route_plan.is_some() {
                "walking".to_string()
            } else {
                "unserved".to_string()
            };
        }
    }
}
```

After adding this skeleton, complete `advance_active_trips` by moving the existing walking/waiting/riding advancement from TypeScript `legacy-ts-simulation/citizens.ts` into Rust, using `ActiveTrip` instead of `Citizen`. Preserve these constants:

```rust
const WALK_SECONDS_PER_TILE: f64 = 20.0;
const WAIT_PATIENCE_SECONDS: f64 = 240.0;
const DEADLINE_GRACE_SECONDS: f64 = 300.0;
```

- [ ] **Step 6: Wire engine tick to trips**

Modify `crates/caelum-core/src/lib.rs`:

```rust
pub mod trips;
```

Modify `GameEngine::tick`:

```rust
pub fn tick(&mut self, delta_seconds: f64) -> DispatchResult {
    let next = crate::trips::tick_trips(&self.snapshot, delta_seconds);
    let applied = next != self.snapshot;
    self.snapshot = next;
    DispatchResult {
        snapshot: self.snapshot(),
        applied,
        rejection: None,
    }
}
```

- [ ] **Step 7: Run commute tests**

Run:

```sh
cargo test -p caelum-core --test commute_requirements
```

Expected: PASS.

- [ ] **Step 8: Port citizen lifecycle parity into trip lifecycle**

Translate behavior from `tests/simulation/citizens.test.ts` into `crates/caelum-core/tests/trip_lifecycle.rs`. Use `ActiveTrip` and `GameEngine::tick` instead of `Citizen` and `tickCitizens`. Cover:

- Walking movement scales by simulated time.
- Terminal `arrived`, `late`, and `unserved` trips do not advance again.
- Riding trips stay attached to vehicles until disembarked.
- Removed/broken vehicle line returns riders to idle planning from current position.
- Fractional walking positions snap before replanning.
- Waiting trips lose patience and become unserved.

Run:

```sh
cargo test -p caelum-core --test trip_lifecycle
```

Expected: PASS.

- [ ] **Step 9: Commit**

```sh
git add crates/caelum-core
git commit -m "feat: add rust commute trips"
```

---

### Task 6: Objectives, Metrics, And Golden Intent Sequences

**Files:**
- Create: `crates/caelum-core/src/objectives.rs`
- Modify: `crates/caelum-core/src/trips.rs`
- Modify: `crates/caelum-core/src/engine.rs`
- Test: `crates/caelum-core/tests/objectives_metrics.rs`
- Test: `crates/caelum-core/tests/golden_sequences.rs`

- [ ] **Step 1: Write failing objective and golden-sequence tests**

Create `crates/caelum-core/tests/objectives_metrics.rs`:

```rust
use caelum_core::{GameEngine, GameIntent};

#[test]
fn completed_trips_increment_metrics() {
    let mut engine = GameEngine::new();
    engine.dispatch(GameIntent::RecordTripOutcome {
        outcome: "arrived".to_string(),
        wait_seconds: 30.0,
        time: 100.0,
    });

    let snapshot = engine.snapshot();
    assert_eq!(snapshot.metrics.completed_trips, 1);
    assert_eq!(snapshot.metrics.late_trips, 0);
    assert_eq!(snapshot.metrics.unserved_trips, 0);
    assert_eq!(snapshot.metrics.total_wait_seconds, 30.0);
}

#[test]
fn survival_requires_served_demand() {
    let mut engine = GameEngine::new();
    engine.dispatch(GameIntent::SetPaused { paused: false });
    let result = engine.tick(1_201.0);

    assert_eq!(result.snapshot.metrics.state, "running");
}
```

Create `crates/caelum-core/tests/golden_sequences.rs`:

```rust
use caelum_core::{GameEngine, GameIntent};

#[test]
fn zone_build_and_route_sequence_has_stable_counts() {
    let mut engine = GameEngine::new();
    engine.dispatch(GameIntent::PaintAreaRectangle {
        area: "residential".to_string(),
        start: (2, 3).into(),
        end: (3, 4).into(),
    });
    engine.dispatch(GameIntent::PlaceBuilding {
        building_type: "smallHouse".to_string(),
        origin: (2, 3).into(),
        rotation: 0,
    });
    engine.dispatch(GameIntent::PaintAreaRectangle {
        area: "commercial".to_string(),
        start: (8, 3).into(),
        end: (9, 4).into(),
    });
    engine.dispatch(GameIntent::PlaceBuilding {
        building_type: "supermarket".to_string(),
        origin: (8, 3).into(),
        rotation: 0,
    });

    let snapshot = engine.snapshot();
    assert_eq!(snapshot.buildings.len(), 2);
    assert_eq!(snapshot.sims.len(), 10);
    assert_eq!(snapshot.budget, 105_500);
}
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```sh
cargo test -p caelum-core --test objectives_metrics
cargo test -p caelum-core --test golden_sequences
```

Expected: FAIL because `RecordTripOutcome` and objective evaluation do not exist.

- [ ] **Step 3: Add explicit test-only outcome intent**

Extend `GameIntent`:

```rust
RecordTripOutcome {
    outcome: String,
    wait_seconds: f64,
    time: f64,
},
```

Wire this intent in `engine.rs` by calling `objectives::record_trip_outcome`.

- [ ] **Step 4: Implement objective helpers**

Create `crates/caelum-core/src/objectives.rs`:

```rust
use crate::model::GameSnapshot;

pub const MAX_LATE_RATIO: f64 = 0.25;
pub const MAX_UNSERVED_RATIO: f64 = 0.20;
pub const MAX_AVERAGE_WAIT: f64 = 180.0;
pub const SURVIVAL_TIME: f64 = 1_200.0;

pub fn record_trip_outcome(
    state: &GameSnapshot,
    outcome: &str,
    wait_seconds: f64,
    _time: f64,
) -> GameSnapshot {
    let mut next = state.clone();
    match outcome {
        "arrived" => next.metrics.completed_trips += 1,
        "late" => {
            next.metrics.completed_trips += 1;
            next.metrics.late_trips += 1;
        }
        "unserved" => next.metrics.unserved_trips += 1,
        _ => {}
    }
    next.metrics.total_wait_seconds += wait_seconds.max(0.0);
    next
}

pub fn evaluate_objectives(state: &GameSnapshot) -> GameSnapshot {
    let mut next = state.clone();
    let completed = f64::from(next.metrics.completed_trips.max(1));
    let late_ratio = f64::from(next.metrics.late_trips) / completed;
    let unserved_ratio = f64::from(next.metrics.unserved_trips) / completed;

    if late_ratio > MAX_LATE_RATIO {
        next.metrics.state = "lost".to_string();
        next.metrics.loss_reason = Some("Too many late trips".to_string());
    } else if unserved_ratio > MAX_UNSERVED_RATIO {
        next.metrics.state = "lost".to_string();
        next.metrics.loss_reason = Some("Too many unserved trips".to_string());
    } else if next.metrics.average_wait_seconds > MAX_AVERAGE_WAIT {
        next.metrics.state = "lost".to_string();
        next.metrics.loss_reason = Some("Average wait is too high".to_string());
    } else if next.time >= SURVIVAL_TIME && next.metrics.completed_trips > 0 {
        next.metrics.state = "won".to_string();
        next.metrics.loss_reason = None;
    }

    next
}
```

- [ ] **Step 5: Evaluate objectives after ticks and outcome records**

Modify `GameEngine::tick` to call `evaluate_objectives` after `tick_trips`:

```rust
let next = crate::objectives::evaluate_objectives(&crate::trips::tick_trips(
    &self.snapshot,
    delta_seconds,
));
```

Modify the `RecordTripOutcome` dispatch arm to evaluate after recording:

```rust
let next = crate::objectives::evaluate_objectives(
    &crate::objectives::record_trip_outcome(&self.snapshot, &outcome, wait_seconds, time),
);
```

- [ ] **Step 6: Run objective and golden tests**

Run:

```sh
cargo test -p caelum-core --test objectives_metrics
cargo test -p caelum-core --test golden_sequences
```

Expected: PASS.

- [ ] **Step 7: Commit**

```sh
git add crates/caelum-core
git commit -m "feat: add rust metrics objectives"
```

---

### Task 7: WASM Facade And Browser Backend

**Files:**
- Create: `crates/caelum-wasm/Cargo.toml`
- Create: `crates/caelum-wasm/src/lib.rs`
- Modify: `Cargo.toml`
- Modify: `package.json`
- Create: `src/runtime/backend/types.ts`
- Create: `src/runtime/backend/wasmBackend.ts`
- Create: `tests/runtime/backend.test.ts`

- [ ] **Step 1: Write failing TypeScript backend test**

Create `tests/runtime/backend.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { GameBackend, GameIntent, GameSnapshot } from "../../src/runtime/backend/types";

const snapshot: GameSnapshot = {
  time: 0,
  day: 0,
  clockMinutes: 0,
  speed: 1,
  paused: true,
  budget: 120000,
  map: { width: 28, height: 18, tiles: [] },
  buildings: [],
  transit: { stops: [], stations: [], routes: [], metroLines: [], vehicles: [] },
  sims: [],
  activeTrips: [],
  metrics: {
    lateTrips: 0,
    completedTrips: 0,
    unservedTrips: 0,
    totalWaitSeconds: 0,
    waitingTripCount: 0,
    averageWaitSeconds: 0,
    state: "running",
    lossReason: null,
  },
};

describe("GameBackend contract", () => {
  it("returns snapshots from dispatch results", () => {
    const dispatch = vi.fn((intent: GameIntent) => ({
      snapshot: { ...snapshot, paused: intent.type === "setPaused" ? intent.paused : snapshot.paused },
      applied: true,
      rejection: null,
    }));
    const backend: GameBackend = {
      snapshot: () => snapshot,
      dispatch,
      tick: () => ({ snapshot, applied: false, rejection: null }),
      reset: () => snapshot,
    };

    const result = backend.dispatch({ type: "setPaused", paused: false });

    expect(dispatch).toHaveBeenCalledWith({ type: "setPaused", paused: false });
    expect(result.snapshot.paused).toBe(false);
  });
});
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```sh
bunx vitest run tests/runtime/backend.test.ts --project runtime
```

Expected: FAIL because backend types do not exist.

- [ ] **Step 3: Add WASM crate**

Modify root `Cargo.toml` so the workspace includes the new WASM crate:

```toml
[workspace]
members = [
  "src-tauri",
  "crates/caelum-core",
  "crates/caelum-wasm",
]
resolver = "2"
```

Create `crates/caelum-wasm/Cargo.toml`:

```toml
[package]
name = "caelum-wasm"
version = "0.1.0"
edition = "2021"
rust-version = "1.77.2"

[lib]
crate-type = ["cdylib", "rlib"]

[dependencies]
caelum-core = { path = "../caelum-core" }
serde-wasm-bindgen = "0.6"
wasm-bindgen = "0.2"
```

Create `crates/caelum-wasm/src/lib.rs`:

```rust
use caelum_core::{GameEngine, GameIntent};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct WasmGameEngine {
    inner: GameEngine,
}

#[wasm_bindgen]
impl WasmGameEngine {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            inner: GameEngine::new(),
        }
    }

    pub fn snapshot(&self) -> Result<JsValue, JsValue> {
        serde_wasm_bindgen::to_value(&self.inner.snapshot())
            .map_err(|err| JsValue::from_str(&err.to_string()))
    }

    pub fn dispatch(&mut self, intent: JsValue) -> Result<JsValue, JsValue> {
        let intent: GameIntent = serde_wasm_bindgen::from_value(intent)
            .map_err(|err| JsValue::from_str(&err.to_string()))?;
        serde_wasm_bindgen::to_value(&self.inner.dispatch(intent))
            .map_err(|err| JsValue::from_str(&err.to_string()))
    }

    pub fn tick(&mut self, delta_seconds: f64) -> Result<JsValue, JsValue> {
        serde_wasm_bindgen::to_value(&self.inner.tick(delta_seconds))
            .map_err(|err| JsValue::from_str(&err.to_string()))
    }

    pub fn reset(&mut self) -> Result<JsValue, JsValue> {
        serde_wasm_bindgen::to_value(&self.inner.reset())
            .map_err(|err| JsValue::from_str(&err.to_string()))
    }
}
```

- [ ] **Step 4: Add WASM build scripts**

Modify `package.json` scripts:

```json
"wasm:build": "wasm-pack build crates/caelum-wasm --target web --out-dir ../../src/generated/caelum_wasm --out-name caelum_wasm --dev",
"wasm:build:release": "wasm-pack build crates/caelum-wasm --target web --out-dir ../../src/generated/caelum_wasm --out-name caelum_wasm --release"
```

- [ ] **Step 5: Add backend TypeScript types**

Create `src/runtime/backend/types.ts`:

```ts
import type { GameState, Point } from "../../domain/types";

export type GameSnapshot = GameState & {
  day: number;
  clockMinutes: number;
  sims: unknown[];
  activeTrips: unknown[];
};

export type GameIntent =
  | { type: "setPaused"; paused: boolean }
  | { type: "setSpeed"; speed: 0 | 1 | 2 | 4 }
  | { type: "paintAreaRectangle"; area: string; start: Point; end: Point }
  | { type: "placeBuilding"; buildingType: string; origin: Point; rotation: number }
  | { type: "layRoad"; point: Point }
  | { type: "cycleRoadDirection"; point: Point }
  | { type: "layTrack"; point: Point }
  | { type: "removeAtTile"; point: Point }
  | { type: "addBusStop"; point: Point; kind: string }
  | { type: "addMetroStation"; point: Point }
  | { type: "addBusRoute"; stopIds: string[] }
  | { type: "addMetroLine"; stationIds: string[] }
  | { type: "assignVehicle"; mode: "bus" | "metro"; lineId: string }
  | { type: "setRouteActive"; routeId: string; active: boolean }
  | { type: "renameRoute"; routeId: string; name: string }
  | { type: "recolorRoute"; routeId: string; color: string }
  | { type: "deleteRoute"; routeId: string }
  | { type: "assignRouteToPlatform"; nodeId: string; routeId: string; platformId: string }
  | { type: "reset" };

export interface DispatchResult {
  snapshot: GameSnapshot;
  applied: boolean;
  rejection: string | null;
}

export interface GameBackend {
  snapshot(): GameSnapshot;
  dispatch(intent: GameIntent): DispatchResult;
  tick(deltaSeconds: number): DispatchResult;
  reset(): GameSnapshot;
}
```

- [ ] **Step 6: Add WASM backend loader**

Create `src/runtime/backend/wasmBackend.ts`:

```ts
import init, { WasmGameEngine } from "../../generated/caelum_wasm/caelum_wasm";
import type { DispatchResult, GameBackend, GameIntent, GameSnapshot } from "./types";

function normalizeResult(value: unknown): DispatchResult {
  return value as DispatchResult;
}

export async function createWasmBackend(): Promise<GameBackend> {
  await init();
  const engine = new WasmGameEngine();

  return {
    snapshot(): GameSnapshot {
      return engine.snapshot() as GameSnapshot;
    },
    dispatch(intent: GameIntent): DispatchResult {
      return normalizeResult(engine.dispatch(intent));
    },
    tick(deltaSeconds: number): DispatchResult {
      return normalizeResult(engine.tick(deltaSeconds));
    },
    reset(): GameSnapshot {
      return engine.reset() as GameSnapshot;
    },
  };
}
```

- [ ] **Step 7: Build WASM and run backend test**

Run:

```sh
bun run wasm:build
bunx vitest run tests/runtime/backend.test.ts --project runtime
```

Expected: PASS.

- [ ] **Step 8: Commit**

```sh
git add crates/caelum-wasm src/runtime/backend package.json src/generated/caelum_wasm tests/runtime/backend.test.ts
git commit -m "feat: expose rust engine to browser"
```

---

### Task 8: Tauri Native Backend Adapter

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Create: `src/runtime/backend/tauriBackend.ts`
- Create: `src/runtime/backend/index.ts`
- Test: `tests/runtime/backendSelection.test.ts`

- [ ] **Step 1: Write failing backend selection test**

Create `tests/runtime/backendSelection.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isTauriRuntime } from "../../src/runtime/backend";

describe("backend host detection", () => {
  it("detects browser when Tauri globals are absent", () => {
    expect(isTauriRuntime({})).toBe(false);
  });

  it("detects Tauri when internal marker is present", () => {
    expect(isTauriRuntime({ __TAURI_INTERNALS__: {} })).toBe(true);
  });
});
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```sh
bunx vitest run tests/runtime/backendSelection.test.ts --project runtime
```

Expected: FAIL because `src/runtime/backend/index.ts` does not exist.

- [ ] **Step 3: Add Tauri commands**

Modify `src-tauri/src/lib.rs`:

```rust
use std::sync::Mutex;

use caelum_core::{DispatchResult, GameEngine, GameIntent, GameSnapshot};
use tauri::State;

struct EngineState(Mutex<GameEngine>);

#[tauri::command]
fn game_snapshot(state: State<'_, EngineState>) -> Result<GameSnapshot, String> {
    state
        .0
        .lock()
        .map_err(|err| err.to_string())
        .map(|engine| engine.snapshot())
}

#[tauri::command]
fn game_dispatch(
    state: State<'_, EngineState>,
    intent: GameIntent,
) -> Result<DispatchResult, String> {
    state
        .0
        .lock()
        .map_err(|err| err.to_string())
        .map(|mut engine| engine.dispatch(intent))
}

#[tauri::command]
fn game_tick(state: State<'_, EngineState>, delta_seconds: f64) -> Result<DispatchResult, String> {
    state
        .0
        .lock()
        .map_err(|err| err.to_string())
        .map(|mut engine| engine.tick(delta_seconds))
}

#[tauri::command]
fn game_reset(state: State<'_, EngineState>) -> Result<GameSnapshot, String> {
    state
        .0
        .lock()
        .map_err(|err| err.to_string())
        .map(|mut engine| engine.reset())
}
```

Add `.manage(EngineState(Mutex::new(GameEngine::new())))` and `.invoke_handler(tauri::generate_handler![game_snapshot, game_dispatch, game_tick, game_reset])` to the Tauri builder.

- [ ] **Step 4: Add Tauri backend**

Create `src/runtime/backend/tauriBackend.ts`:

```ts
import { invoke } from "@tauri-apps/api/core";
import type { DispatchResult, GameBackend, GameIntent, GameSnapshot } from "./types";

export async function createTauriBackend(): Promise<GameBackend> {
  return {
    snapshot(): GameSnapshot {
      throw new Error("Use createAsyncTauriBackend for snapshot calls");
    },
    dispatch(_intent: GameIntent): DispatchResult {
      throw new Error("Use createAsyncTauriBackend for dispatch calls");
    },
    tick(_deltaSeconds: number): DispatchResult {
      throw new Error("Use createAsyncTauriBackend for tick calls");
    },
    reset(): GameSnapshot {
      throw new Error("Use createAsyncTauriBackend for reset calls");
    },
  };
}

export async function tauriSnapshot(): Promise<GameSnapshot> {
  return invoke<GameSnapshot>("game_snapshot");
}

export async function tauriDispatch(intent: GameIntent): Promise<DispatchResult> {
  return invoke<DispatchResult>("game_dispatch", { intent });
}

export async function tauriTick(deltaSeconds: number): Promise<DispatchResult> {
  return invoke<DispatchResult>("game_tick", { deltaSeconds });
}

export async function tauriReset(): Promise<GameSnapshot> {
  return invoke<GameSnapshot>("game_reset");
}
```

The synchronous `GameBackend` interface is kept for the browser/WASM runtime. The Tauri async commands are exposed separately so the runtime can switch to an async controller in Task 9 without hiding command latency.

- [ ] **Step 5: Add host detection**

Create `src/runtime/backend/index.ts`:

```ts
export type { DispatchResult, GameBackend, GameIntent, GameSnapshot } from "./types";
export { createWasmBackend } from "./wasmBackend";

export function isTauriRuntime(source: unknown = globalThis.window): boolean {
  return (
    typeof source === "object" &&
    source !== null &&
    "__TAURI_INTERNALS__" in source
  );
}
```

- [ ] **Step 6: Run Tauri/Rust checks and backend selection test**

Run:

```sh
cargo check --workspace
bunx vitest run tests/runtime/backendSelection.test.ts --project runtime
```

Expected: PASS.

- [ ] **Step 7: Commit**

```sh
git add src-tauri/src/lib.rs src/runtime/backend tests/runtime/backendSelection.test.ts
git commit -m "feat: add tauri rust engine commands"
```

---

### Task 9: Runtime Uses Rust Backend For Gameplay Mutation

**Files:**
- Modify: `src/main.ts`
- Modify: `src/runtime/createGameRuntime.ts`
- Modify: `src/runtime/types.ts`
- Modify: `src/runtime/runtimeSelectors.ts`
- Modify: `src/App.svelte`
- Test: `tests/runtime/gameRuntime.test.ts`
- Test: `tests/ui/appShell.test.ts`

- [ ] **Step 1: Write failing runtime backend test**

Add to `tests/runtime/gameRuntime.test.ts`:

```ts
import type { GameBackend, GameIntent } from "../../src/runtime/backend";

function backendSpy(initial = createInitialGameState()): GameBackend & { intents: GameIntent[] } {
  const intents: GameIntent[] = [];
  let snapshot = {
    ...initial,
    day: 0,
    clockMinutes: 0,
    sims: [],
    activeTrips: [],
  };
  return {
    intents,
    snapshot: () => snapshot,
    dispatch: (intent) => {
      intents.push(intent);
      if (intent.type === "setPaused") {
        snapshot = { ...snapshot, paused: intent.paused };
      }
      return { snapshot, applied: true, rejection: null };
    },
    tick: () => ({ snapshot, applied: false, rejection: null }),
    reset: () => snapshot,
  };
}

it("dispatches pause changes through the backend", () => {
  const backend = backendSpy();
  const runtime = createGameRuntime({ backend });

  runtime.togglePause();

  expect(backend.intents).toContainEqual({ type: "setPaused", paused: false });
});
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```sh
bunx vitest run tests/runtime/gameRuntime.test.ts --project runtime
```

Expected: FAIL because `createGameRuntime` does not accept a backend.

- [ ] **Step 3: Change runtime constructor**

Modify `src/runtime/createGameRuntime.ts` signature:

```ts
import type { GameBackend, GameIntent, GameSnapshot } from "./backend";

interface CreateGameRuntimeOptions {
  backend: GameBackend;
}

export function createGameRuntime({ backend }: CreateGameRuntimeOptions): RuntimeController {
  let state = backend.snapshot() as GameSnapshot;
  // keep existing ui/running/canvas/listener locals
}
```

Replace gameplay calls:

```ts
tick(deltaSeconds) {
  return commit(backend.tick(deltaSeconds).snapshot, ui);
},
reset() {
  state = backend.reset();
  ui = createUiState();
  return publish();
},
togglePause() {
  return commit(backend.dispatch({ type: "setPaused", paused: !state.paused }).snapshot, ui);
},
setSpeed(speed) {
  return commit(backend.dispatch({ type: "setSpeed", speed }).snapshot, ui);
},
```

- [ ] **Step 4: Convert tile/building/drag commits into intents**

In `createGameRuntime.ts`, replace direct calls to `applyTileClick`, `paintAreaRectangle`, `applyDragGesture`, route management helpers, and transit management helpers with `backend.dispatch(...)`.

Use these mappings:

```ts
const intentForToolClick = (point: Point): GameIntent | null => {
  if (ui.selectedBuilding !== null) {
    return {
      type: "placeBuilding",
      buildingType: ui.selectedBuilding,
      origin: point,
      rotation: ui.buildingRotation,
    };
  }
  if (ui.activeTool === "road") return { type: "layRoad", point };
  if (ui.activeTool === "track") return { type: "layTrack", point };
  if (ui.activeTool === "remove") return { type: "removeAtTile", point };
  if (ui.activeTool === "busStop") return { type: "addBusStop", point, kind: "busStop" };
  if (ui.activeTool === "metroStation") return { type: "addMetroStation", point };
  return null;
};
```

For area drag commit:

```ts
backend.dispatch({
  type: "paintAreaRectangle",
  area: gesture.area,
  start: gesture.start,
  end: gesture.current,
}).snapshot
```

For route finish:

```ts
backend.dispatch(
  ui.activeTool === "busRoute"
    ? { type: "addBusRoute", stopIds: ui.draftStopIds }
    : { type: "addMetroLine", stationIds: ui.draftStationIds },
).snapshot
```

Keep route drafting arrays in `UiState`; only final route creation is a Rust intent.

- [ ] **Step 5: Update app bootstrap for async WASM**

Modify `src/main.ts`:

```ts
import "./styles.css";
import { mount } from "svelte";
import App from "./App.svelte";
import { createWasmBackend } from "./runtime/backend";
import { createGameRuntime } from "./runtime/createGameRuntime";

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("Missing #app root");
}

const target = app;

async function mountApp(): Promise<void> {
  const backend = await createWasmBackend();
  mount(App, {
    target,
    props: {
      runtime: createGameRuntime({ backend }),
      error: null,
    },
  });
}

function mountError(error: string): void {
  target.innerHTML = "";
  const fallbackBackend = {
    snapshot: () => {
      throw new Error(error);
    },
    dispatch: () => {
      throw new Error(error);
    },
    tick: () => {
      throw new Error(error);
    },
    reset: () => {
      throw new Error(error);
    },
  };
  mount(App, {
    target,
    props: {
      runtime: createGameRuntime({ backend: fallbackBackend }),
      error,
    },
  });
}

mountApp().catch((err: unknown) => {
  mountError(err instanceof Error ? err.message : "Bootstrap failed");
});
```

- [ ] **Step 6: Update selectors for 24-hour clock and sims**

Modify `formatTime` in `src/runtime/runtimeSelectors.ts`:

```ts
export function formatTimeFromClock(day: number, clockMinutes: number): string {
  const hours = Math.floor(clockMinutes / 60)
    .toString()
    .padStart(2, "0");
  const minutes = (clockMinutes % 60).toString().padStart(2, "0");
  return `Day ${day + 1} ${hours}:${minutes}`;
}
```

Use `formatTimeFromClock(state.day ?? 0, state.clockMinutes ?? 0)` for topbar time and `${state.sims?.length ?? state.citizens.length}` for population while the renderer transition is in progress.

- [ ] **Step 7: Run runtime and UI tests**

Run:

```sh
bunx vitest run tests/runtime/gameRuntime.test.ts --project runtime
bunx vitest run tests/ui/appShell.test.ts --project ui
```

Expected: PASS.

- [ ] **Step 8: Commit**

```sh
git add src/main.ts src/runtime src/App.svelte tests/runtime/gameRuntime.test.ts tests/ui/appShell.test.ts
git commit -m "feat: route runtime through rust backend"
```

---

### Task 10: Rendering And E2E On Rust Snapshots

**Files:**
- Modify: `src/domain/types.ts`
- Modify: `src/render/citizenRenderer.ts`
- Modify: `src/render/overlayRenderer.ts`
- Modify: `src/render/canvas.ts`
- Modify: `tests/e2e/smoke.spec.ts`
- Modify: `tests/e2e/routes.spec.ts`
- Test: `tests/render/*.test.ts`

- [ ] **Step 1: Add snapshot fields to TypeScript read types**

Modify `src/domain/types.ts`:

```ts
export interface Sim {
  id: string;
  home: Point;
  position: Point;
  workerProfile: "worker" | "nonWorker";
  shiftTemplate?: "standard" | "early" | "late" | "offPeak";
  workplace?: Point;
  commuteDay: number;
  outboundArrivedToday: boolean;
}

export interface ActiveTrip {
  id: string;
  simId: string;
  purpose: "commuteOutbound" | "commuteReturn";
  origin: Point;
  destination: Point;
  position: Point;
  status: CitizenStatus;
  deadline: number;
  routePlan: RoutePlan | null;
  currentLegIndex: number;
  patienceRemaining: number;
}
```

Extend `GameState`:

```ts
day?: number;
clockMinutes?: number;
sims?: Sim[];
activeTrips?: ActiveTrip[];
```

- [ ] **Step 2: Render active trips instead of old citizens when present**

Modify `src/render/citizenRenderer.ts`:

```ts
const travelers = state.activeTrips ?? state.citizens;
for (const traveler of travelers) {
  // keep existing drawing body using traveler.position and traveler.status
}
```

Modify `src/render/overlayRenderer.ts` demand/lateness loops:

```ts
const travelers = state.activeTrips ?? state.citizens;
```

Use `traveler.destination`, `traveler.status`, and `traveler.position` exactly as the old citizen loop did.

- [ ] **Step 3: Update e2e smoke flow expectations**

In `tests/e2e/smoke.spec.ts`, add assertions after unpausing that the Rust-backed clock appears:

```ts
await expect(page.getByText(/Day 1/)).toBeVisible();
```

In the route smoke, after building a route and running time, assert either completed trips or active trip pressure:

```ts
await expect(page.getByText(/Unserved|Late|Avg Wait/)).toBeVisible();
```

- [ ] **Step 4: Run render and e2e tests**

Run:

```sh
bunx vitest run --project ui --project runtime
bun run test:e2e
```

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add src/domain/types.ts src/render tests/e2e tests/render
git commit -m "feat: render rust trip snapshots"
```

---

### Task 11: Retire TypeScript Simulation Authority

**Files:**
- Modify/Delete: `legacy-ts-simulation/*.ts`
- Modify/Delete: `tests/simulation/*.test.ts`
- Modify: `vite.config.ts`
- Modify: `docs/architecture.md`
- Modify: `package.json`

- [ ] **Step 1: Confirm Rust parity coverage**

Run:

```sh
cargo test -p caelum-core
bunx vitest run --project runtime --project ui
bun run test:e2e
```

Expected: PASS.

- [ ] **Step 2: Remove old TypeScript simulation tests from Vitest project**

Modify `vite.config.ts` simulation project include to target any remaining read-only fixtures only:

```ts
{
  extends: true,
  test: {
    name: "simulation",
    include: ["tests/simulation/**/*.test.ts"],
    environment: "node",
  },
},
```

Then delete migrated tests under `tests/simulation` when their Rust equivalent exists. Keep only tests for TypeScript read-only helpers that still exist.

- [ ] **Step 3: Delete TypeScript mutation modules after all imports are gone**

Run:

```sh
rg "legacy-ts-simulation|\\.\\./simulation|\\.\\./\\.\\./legacy-ts-simulation" src tests
```

Expected: output only from render/selectors that still import read-only constants, or no output.

Delete mutation modules no longer imported:

```sh
git rm legacy-ts-simulation/citizens.ts legacy-ts-simulation/simulation.ts legacy-ts-simulation/transit.ts legacy-ts-simulation/router.ts legacy-ts-simulation/network.ts legacy-ts-simulation/objectives.ts
```

Keep `legacy-ts-simulation/areas.ts`, `buildingCatalog.ts`, and read-only UI constants only if TypeScript UI still imports labels/catalog display data. If they remain, rename them to `src/ui/catalogLabels.ts` and `src/ui/areaLabels.ts` so they are not confused with simulation authority.

- [ ] **Step 4: Update architecture docs**

Modify `docs/architecture.md` so the runtime boundary says:

```md
The Rust simulation core is the single owner of gameplay state. `createGameRuntime()` owns frontend UI state, subscriptions, animation scheduling, and canvas mounting, then dispatches typed intents to the Rust backend. Svelte and canvas render from Rust snapshots and never mutate gameplay directly.
```

Also document:

```md
Browser uses the Rust core through WASM generated by `wasm-pack`. Tauri links the same `caelum-core` crate through managed Rust command state. Both hosts share the same `GameEngine` facade.
```

- [ ] **Step 5: Run full verification**

Run:

```sh
bun run check
bun run format:check
bun run build
bun run test
bun run test:e2e
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
```

Expected: PASS.

- [ ] **Step 6: Commit**

```sh
git add src tests vite.config.ts docs/architecture.md package.json Cargo.toml crates src-tauri
git commit -m "refactor: retire typescript simulation authority"
```

---

### Task 12: Final Browser And Desktop Verification

**Files:**
- No planned source edits unless verification reveals a defect.

- [ ] **Step 1: Run browser dev server**

Run:

```sh
bun run dev
```

Expected: Vite serves at `http://127.0.0.1:5281`.

- [ ] **Step 2: Manually verify browser vertical slice**

In the browser:

1. Paint residential area.
2. Place a Small House.
3. Paint commercial area.
4. Place a Supermarket.
5. Build roads, bus stops, a bus route, and a bus vehicle.
6. Start simulation.
7. Observe Day 1 clock movement and commute travelers.
8. Confirm completed/late/unserved metrics change from Rust snapshots.

- [ ] **Step 3: Run Tauri development shell**

Run:

```sh
bun run tauri:dev
```

Expected: desktop app opens, loads the same UI, and the vertical slice from Step 2 works.

- [ ] **Step 4: Run release build checks**

Run:

```sh
bun run tauri:build
```

Expected: Tauri build succeeds.

- [ ] **Step 5: Commit verification fixes**

If verification required source fixes, return to the task that owns the changed file and use that task's commit step after rerunning its verification command. For example, a `src/render/citizenRenderer.ts` fix belongs to Task 10, and a `crates/caelum-core/src/trips.rs` fix belongs to Task 5.

```sh
git status --short
```

If no fixes were needed, do not create an empty commit.

---

## Self-Review

- Spec coverage:
  - Rust single authority: Tasks 1, 8, 9, 11.
  - Browser and Tauri playable from same core: Tasks 7, 8, 12.
  - Current gameplay surface parity: Tasks 3, 4, 6, 10, 11.
  - Daily commute model: Task 5.
  - 24-hour clock and 1,200-second day: Task 2 and Task 5.
  - Determinism and tests: every task includes focused tests; Task 6 adds golden sequences.
  - TypeScript reduced to UI/render/host: Tasks 9, 10, 11.
- Completeness scan:
  - This plan intentionally names exact files, commands, interfaces, and verification expectations. No unspecified implementation steps are required before an engineer can begin.
- Type consistency:
  - Rust boundary types use camelCase serde to match TypeScript intent/snapshot names.
  - `GameEngine`, `GameIntent`, `DispatchResult`, and `GameSnapshot` are introduced before any adapter task consumes them.
  - UI-only state stays in `UiState`; gameplay-changing commits use `GameIntent`.
