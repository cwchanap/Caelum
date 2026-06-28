# Rust Simulation Host Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route browser and Tauri gameplay through `caelum-core::GameEngine`, then remove the legacy TypeScript simulation authority from live code.

**Architecture:** Rust owns gameplay snapshots, intents, ticking, validation, commute trips, objectives, and metrics. TypeScript owns host selection, UI state, event handling, rendering, and read-only snapshot/view helpers. The runtime is initialized from a Rust backend snapshot and serializes gameplay operations so browser WASM and Tauri native commands share the same state contract.

**Tech Stack:** Rust 2021, Cargo workspace, serde, wasm-bindgen, serde-wasm-bindgen, wasm-pack, Tauri 2, TypeScript, Svelte 5 runes, Vite, Bun, Vitest, Playwright.

---

## File Structure

- `crates/caelum-core/src/intent.rs` - Rust wire intents and dispatch result types.
- `crates/caelum-core/src/transit.rs` - Rust transit/build/remove helpers, including new line/preset placement helpers for frontend drag commits.
- `crates/caelum-core/src/engine.rs` - single dispatch point from host intents into Rust gameplay.
- `crates/caelum-wasm/` - new WASM wrapper crate around `caelum-core::GameEngine`.
- `src/runtime/backend/types.ts` - TypeScript backend contract and Rust-shaped snapshot/intent types.
- `src/runtime/backend/wasmBackend.ts` - browser backend using generated wasm-bindgen bindings.
- `src/runtime/backend/tauriBackend.ts` - Tauri command backend using `@tauri-apps/api/core.invoke`.
- `src/runtime/backend/index.ts` - host detection and backend factory.
- `src/runtime/snapshotView.ts` - read-only adaptation from Rust snapshot to frontend view state.
- `src/runtime/createGameRuntime.ts` - runtime owner of UI state, subscriptions, canvas lifecycle, and Rust intent dispatch.
- `src/runtime/runtimeSelectors.ts` - shell selectors over Rust-backed view state.
- `src/domain/types.ts` - frontend read types for Rust snapshots, sims, active trips, and UI catalogs.
- `src/ui/routeDraft.ts` - read-only route draft helpers formerly mixed into `src/ui/actions.ts`.
- `src/ui/roadDrag.ts` - read-only drag geometry and preview helpers; no gameplay mutation.
- `src/render/*.ts` - canvas renderers that consume Rust active trips and Rust snapshot fields.
- `src-tauri/src/lib.rs` - Tauri managed `GameEngine` state and commands.
- `tests/fixtures/rustSnapshot.ts` - Rust-shaped frontend fixture builder.
- `tests/runtime/*.test.ts`, `tests/ui/*.test.ts`, `tests/render/*.test.ts`, `tests/e2e/*.spec.ts` - frontend proof that only UI/render/backend wiring remains in TypeScript.
- `docs/architecture.md` and `CLAUDE.md` - update once the live runtime no longer uses TypeScript simulation.

---

### Task 1: Rust Drag-Line Intents For Road Presets

**Files:**
- Modify: `crates/caelum-core/src/intent.rs`
- Modify: `crates/caelum-core/src/lib.rs`
- Modify: `crates/caelum-core/src/engine.rs`
- Modify: `crates/caelum-core/src/transit.rs`
- Test: `crates/caelum-core/tests/transit_build.rs`
- Test: `crates/caelum-core/tests/model_wire_format.rs`

- [ ] **Step 1: Write failing Rust tests for line/preset intents**

Add these imports to `crates/caelum-core/tests/transit_build.rs`:

```rust
use caelum_core::RoadPreset;
```

Add these tests near the existing road-direction tests:

```rust
#[test]
fn lay_road_line_one_way_sets_axis_direction_and_charges_new_tiles() {
    let mut engine = GameEngine::new();

    let result = engine.dispatch(GameIntent::LayRoadLine {
        points: vec![(1, 1).into(), (2, 1).into(), (3, 1).into()],
        preset: RoadPreset::OneWay,
    });

    assert!(result.applied);
    assert_eq!(result.rejection, None);
    assert_eq!(result.snapshot.budget, 120_000 - 3 * 100);
    let directions: Vec<Option<&str>> = result
        .snapshot
        .map
        .tiles
        .iter()
        .filter(|tile| tile.y == 1 && (1..=3).contains(&tile.x))
        .map(|tile| tile.one_way.as_deref())
        .collect();
    assert_eq!(directions, vec![Some("east"), Some("east"), Some("east")]);
}

#[test]
fn lay_road_line_dual_bidirectional_adds_left_reverse_lane_without_hijacking_existing_roads() {
    let mut engine = GameEngine::new();
    engine.dispatch(GameIntent::LayRoad {
        point: (1, 0).into(),
    });

    let result = engine.dispatch(GameIntent::LayRoadLine {
        points: vec![(1, 1).into(), (2, 1).into(), (3, 1).into()],
        preset: RoadPreset::DualBidirectional,
    });

    assert!(result.applied);
    let tile = |x: i32, y: i32| {
        result
            .snapshot
            .map
            .tiles
            .iter()
            .find(|tile| tile.x == x && tile.y == y)
            .expect("tile exists")
    };
    assert_eq!(tile(1, 1).one_way.as_deref(), Some("east"));
    assert_eq!(tile(2, 1).one_way.as_deref(), Some("east"));
    assert_eq!(tile(3, 1).one_way.as_deref(), Some("east"));
    assert_eq!(tile(1, 0).one_way.as_deref(), None);
    assert_eq!(tile(2, 0).one_way.as_deref(), Some("west"));
    assert_eq!(tile(3, 0).one_way.as_deref(), Some("west"));
}

#[test]
fn lay_track_line_and_remove_at_tiles_skip_invalid_tiles_but_apply_valid_tiles() {
    let mut engine = GameEngine::new();
    let track = engine.dispatch(GameIntent::LayTrackLine {
        points: vec![(4, 4).into(), (5, 4).into(), (100, 100).into()],
    });

    assert!(track.applied);
    assert_eq!(track.snapshot.budget, 120_000 - 2 * 500);
    assert!(track
        .snapshot
        .map
        .tiles
        .iter()
        .find(|tile| tile.x == 4 && tile.y == 4)
        .expect("tile exists")
        .has_track);

    let removed = engine.dispatch(GameIntent::RemoveAtTiles {
        points: vec![(4, 4).into(), (5, 4).into(), (100, 100).into()],
    });

    assert!(removed.applied);
    assert!(!removed
        .snapshot
        .map
        .tiles
        .iter()
        .find(|tile| tile.x == 4 && tile.y == 4)
        .expect("tile exists")
        .has_track);
}
```

Add this wire-format test to `crates/caelum-core/tests/model_wire_format.rs`:

```rust
#[test]
fn line_intents_use_camel_case_wire_names() {
    let intent = GameIntent::LayRoadLine {
        points: vec![(1, 2).into(), (3, 2).into()],
        preset: RoadPreset::DualBidirectional,
    };

    let json = serde_json::to_value(intent).expect("intent serializes");

    assert_eq!(json["type"], "layRoadLine");
    assert_eq!(json["preset"], "dualBidirectional");
    assert_eq!(json["points"][0]["x"], 1);
    assert_eq!(json["points"][1]["y"], 2);
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```sh
cargo test -p caelum-core --test transit_build lay_road_line -- --nocapture
cargo test -p caelum-core --test model_wire_format line_intents_use_camel_case_wire_names -- --nocapture
```

Expected: FAIL because `RoadPreset`, `LayRoadLine`, `LayTrackLine`, and `RemoveAtTiles` do not exist.

- [ ] **Step 3: Add intent types**

Modify `crates/caelum-core/src/intent.rs`:

```rust
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RoadPreset {
    TwoWay,
    OneWay,
    DualBidirectional,
}
```

Add these variants to `GameIntent`:

```rust
    LayRoadLine {
        points: Vec<Point>,
        preset: RoadPreset,
    },
    LayTrackLine {
        points: Vec<Point>,
    },
    RemoveAtTiles {
        points: Vec<Point>,
    },
```

Modify `crates/caelum-core/src/lib.rs`:

```rust
pub use intent::{DispatchResult, GameIntent, RoadPreset};
```

- [ ] **Step 4: Add Rust transit line helpers**

Add `RoadPreset` to the imports in `crates/caelum-core/src/transit.rs`:

```rust
use crate::intent::RoadPreset;
```

Add these helpers after `lay_track`:

```rust
pub fn lay_road_line(
    state: &GameSnapshot,
    points: &[Point],
    preset: RoadPreset,
) -> Result<GameSnapshot, String> {
    if points.is_empty() {
        return Err("empty road line".to_string());
    }

    let forward = line_direction(points);
    let mut next = state.clone();
    let mut changed = false;

    for point in points {
        let direction = match preset {
            RoadPreset::TwoWay => None,
            RoadPreset::OneWay | RoadPreset::DualBidirectional => forward,
        };
        changed |= lay_lane(&mut next, state, point, direction)?;
    }

    if preset == RoadPreset::DualBidirectional {
        if let Some(forward_direction) = forward {
            let reverse_direction = opposite_direction(forward_direction);
            for point in reverse_lane_points(points, forward_direction) {
                changed |= lay_reverse_lane(&mut next, state, &point, reverse_direction)?;
            }
        }
    }

    if !changed {
        return Err("road line unchanged".to_string());
    }
    Ok(recompute_route_paths(&next))
}

pub fn lay_track_line(state: &GameSnapshot, points: &[Point]) -> Result<GameSnapshot, String> {
    if points.is_empty() {
        return Err("empty track line".to_string());
    }

    let mut next = state.clone();
    let mut changed = false;
    for point in points {
        if next.budget < TRACK_COST || !is_valid_track_placement(&next, point) {
            continue;
        }
        next.budget -= TRACK_COST;
        set_tile_track(&mut next.map, point, true);
        changed = true;
    }

    if !changed {
        return Err("track line unchanged".to_string());
    }
    Ok(recompute_route_paths(&next))
}

pub fn remove_at_tiles(state: &GameSnapshot, points: &[Point]) -> Result<GameSnapshot, String> {
    if points.is_empty() {
        return Err("empty remove line".to_string());
    }

    let mut next = state.clone();
    let mut changed = false;
    for point in points {
        if let Ok(candidate) = remove_at_tile(&next, point) {
            if candidate != next {
                next = candidate;
                changed = true;
            }
        }
    }

    if !changed {
        return Err("remove line unchanged".to_string());
    }
    Ok(next)
}
```

Add these private helpers near the existing tile helpers:

```rust
fn line_direction(points: &[Point]) -> Option<&'static str> {
    if points.len() < 2 {
        return None;
    }
    let dx = points[1].x - points[0].x;
    let dy = points[1].y - points[0].y;
    if dx > 0 {
        Some("east")
    } else if dx < 0 {
        Some("west")
    } else if dy > 0 {
        Some("south")
    } else if dy < 0 {
        Some("north")
    } else {
        None
    }
}

fn opposite_direction(direction: &str) -> &'static str {
    match direction {
        "north" => "south",
        "east" => "west",
        "south" => "north",
        "west" => "east",
        _ => "north",
    }
}

fn left_of_direction(direction: &str) -> (i32, i32) {
    match direction {
        "north" => (-1, 0),
        "east" => (0, -1),
        "south" => (1, 0),
        "west" => (0, 1),
        _ => (0, 0),
    }
}

fn reverse_lane_points(points: &[Point], direction: &str) -> Vec<Point> {
    let (offset_x, offset_y) = left_of_direction(direction);
    points
        .iter()
        .map(|point| Point {
            x: point.x + offset_x,
            y: point.y + offset_y,
        })
        .collect()
}

fn lay_lane(
    next: &mut GameSnapshot,
    original: &GameSnapshot,
    point: &Point,
    direction: Option<&str>,
) -> Result<bool, String> {
    let existing = get_tile(&next.map, point).cloned();
    if existing.as_ref().is_some_and(|tile| tile.kind == "road") {
        if existing.and_then(|tile| tile.one_way) != direction.map(str::to_string) {
            set_tile_one_way(&mut next.map, point, direction);
            return Ok(true);
        }
        return Ok(false);
    }

    if next.budget < ROAD_COST || !is_valid_road_placement(original, point) {
        return Ok(false);
    }
    next.budget -= ROAD_COST;
    set_tile_kind(&mut next.map, point, "road");
    set_tile_one_way(&mut next.map, point, direction);
    Ok(true)
}

fn lay_reverse_lane(
    next: &mut GameSnapshot,
    original: &GameSnapshot,
    point: &Point,
    direction: &str,
) -> Result<bool, String> {
    if get_tile(&next.map, point).is_some_and(|tile| tile.kind != "empty") {
        return Ok(false);
    }
    if next.budget < ROAD_COST || !is_valid_road_placement(original, point) {
        return Ok(false);
    }
    next.budget -= ROAD_COST;
    set_tile_kind(&mut next.map, point, "road");
    set_tile_one_way(&mut next.map, point, Some(direction));
    Ok(true)
}
```

- [ ] **Step 5: Wire engine dispatch**

Modify `crates/caelum-core/src/engine.rs` match arms:

```rust
            GameIntent::LayRoadLine { points, preset } => {
                self.commit_result(transit::lay_road_line(&self.snapshot, &points, preset))
            }
            GameIntent::LayTrackLine { points } => {
                self.commit_result(transit::lay_track_line(&self.snapshot, &points))
            }
            GameIntent::RemoveAtTiles { points } => {
                self.commit_result(transit::remove_at_tiles(&self.snapshot, &points))
            }
```

- [ ] **Step 6: Run focused Rust tests**

Run:

```sh
cargo test -p caelum-core --test transit_build lay_road_line -- --nocapture
cargo test -p caelum-core --test model_wire_format line_intents_use_camel_case_wire_names -- --nocapture
cargo test -p caelum-core --test transit_build lay_track_line_and_remove_at_tiles -- --nocapture
```

Expected: PASS.

- [ ] **Step 7: Format and commit**

Run:

```sh
cargo fmt --all
cargo test -p caelum-core --test transit_build
git add crates/caelum-core/src/intent.rs crates/caelum-core/src/lib.rs crates/caelum-core/src/engine.rs crates/caelum-core/src/transit.rs crates/caelum-core/tests/transit_build.rs crates/caelum-core/tests/model_wire_format.rs
git commit -m "feat: add rust line placement intents"
```

---

### Task 2: Rust Snapshot Types And Frontend Backend Contract

**Files:**
- Modify: `src/domain/types.ts`
- Create: `src/runtime/backend/types.ts`
- Create: `src/runtime/snapshotView.ts`
- Create: `tests/fixtures/rustSnapshot.ts`
- Test: `tests/runtime/backendContract.test.ts`

- [ ] **Step 1: Add failing backend contract test**

Create `tests/runtime/backendContract.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { normalizeRustSnapshot } from "../../src/runtime/snapshotView";
import { createRustSnapshot } from "../fixtures/rustSnapshot";
import type { GameBackend, GameIntent } from "../../src/runtime/backend/types";

describe("Rust backend contract", () => {
  it("normalizes a Rust snapshot into shell-readable frontend state", () => {
    const snapshot = normalizeRustSnapshot(
      createRustSnapshot({
        day: 1,
        clockMinutes: 9 * 60 + 15,
        sims: [
          {
            id: "sim-001",
            home: { x: 1, y: 1 },
            position: { x: 1, y: 1 },
            workerProfile: "worker",
            shiftTemplate: "standard",
            workplace: { x: 5, y: 1 },
            commuteDay: 1,
            outboundResolvedToday: false,
            outboundArrivedToday: false,
            returnResolvedToday: false,
            returnedHomeToday: false,
          },
        ],
      }),
    );

    expect(snapshot.scenario.name).toBe("Growing Suburb");
    expect(snapshot.day).toBe(1);
    expect(snapshot.clockMinutes).toBe(555);
    expect(snapshot.sims).toHaveLength(1);
  });

  it("backend methods return promises so browser and Tauri share one runtime contract", async () => {
    const intent: GameIntent = { type: "setPaused", paused: false };
    const snapshot = createRustSnapshot();
    const backend: GameBackend = {
      snapshot: async () => snapshot,
      dispatch: async (received) => ({
        snapshot: { ...snapshot, paused: received.type === "setPaused" ? received.paused : snapshot.paused },
        applied: true,
        rejection: null,
      }),
      tick: async () => ({ snapshot, applied: false, rejection: null }),
      reset: async () => snapshot,
    };

    await expect(backend.dispatch(intent)).resolves.toMatchObject({
      applied: true,
      snapshot: { paused: false },
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```sh
bunx vitest run tests/runtime/backendContract.test.ts --project runtime
```

Expected: FAIL because backend types, fixture, and snapshot normalization do not exist.

- [ ] **Step 3: Extend frontend domain types**

Modify `src/domain/types.ts` by adding these types after `Citizen`:

```ts
export type WorkerProfile = "worker" | "nonWorker";
export type TripPurpose = "commuteOutbound" | "commuteReturn";

export interface Sim {
  id: string;
  home: Point;
  position: Point;
  workerProfile: WorkerProfile;
  shiftTemplate?: "standard" | "early" | "late" | "offPeak";
  workplace?: Point;
  commuteDay: number;
  outboundResolvedToday: boolean;
  outboundArrivedToday: boolean;
  returnResolvedToday: boolean;
  returnedHomeToday: boolean;
}

export interface TripPosition {
  x: number;
  y: number;
}

export interface ActiveTrip {
  id: string;
  simId: string;
  purpose: TripPurpose;
  origin: Point;
  destination: Point;
  position: TripPosition;
  status: CitizenStatus;
  deadline: number;
  routePlan: RoutePlan | null;
  currentLegIndex: number;
  patienceRemaining: number;
}
```

Replace `GameState` with:

```ts
export interface GameState {
  time: number;
  day: number;
  clockMinutes: number;
  speed: 0 | 1 | 2 | 4;
  paused: boolean;
  budget: number;
  map: GameMap;
  buildings: PlacedBuilding[];
  scenario: Scenario;
  transit: TransitNetwork;
  sims: Sim[];
  activeTrips: ActiveTrip[];
  tripSequenceDay: number;
  nextTripSequence: number;
  metrics: Metrics;
}
```

- [ ] **Step 4: Add backend types**

Create `src/runtime/backend/types.ts`:

```ts
import type {
  ActiveTrip,
  AreaKind,
  BuildingRotation,
  BuildingType,
  GameMap,
  Metrics,
  PlacedBuilding,
  Point,
  Sim,
  TransitNetwork,
} from "../../domain/types";

export type RoadPresetIntent = "twoWay" | "oneWay" | "dualBidirectional";

export interface RustGameSnapshot {
  time: number;
  day: number;
  clockMinutes: number;
  speed: 0 | 1 | 2 | 4;
  paused: boolean;
  budget: number;
  map: GameMap;
  buildings: PlacedBuilding[];
  transit: TransitNetwork;
  sims: Sim[];
  activeTrips: ActiveTrip[];
  tripSequenceDay: number;
  nextTripSequence: number;
  metrics: Metrics;
}

export type GameIntent =
  | { type: "setPaused"; paused: boolean }
  | { type: "setSpeed"; speed: 0 | 1 | 2 | 4 }
  | { type: "assignVehicle"; mode: "bus" | "metro"; lineId: string }
  | { type: "layRoad"; point: Point }
  | { type: "layRoadLine"; points: Point[]; preset: RoadPresetIntent }
  | { type: "cycleRoadDirection"; point: Point }
  | { type: "layTrack"; point: Point }
  | { type: "layTrackLine"; points: Point[] }
  | { type: "removeAtTile"; point: Point }
  | { type: "removeAtTiles"; points: Point[] }
  | { type: "addBusStop"; point: Point }
  | { type: "addMetroStation"; point: Point }
  | { type: "addBusRoute"; stopIds: string[] }
  | { type: "addMetroLine"; stationIds: string[] }
  | { type: "setRouteActive"; routeId: string; active: boolean }
  | { type: "renameRoute"; routeId: string; name: string }
  | { type: "recolorRoute"; routeId: string; color: string }
  | { type: "deleteRoute"; routeId: string }
  | { type: "assignRouteToPlatform"; nodeId: string; routeId: string; platformId: string }
  | { type: "paintAreaRectangle"; area: AreaKind; start: Point; end: Point }
  | {
      type: "placeBuilding";
      buildingType: BuildingType;
      origin: Point;
      rotation: BuildingRotation;
    };

export interface DispatchResult {
  snapshot: RustGameSnapshot;
  applied: boolean;
  rejection: string | null;
}

export interface GameBackend {
  snapshot(): Promise<RustGameSnapshot>;
  dispatch(intent: GameIntent): Promise<DispatchResult>;
  tick(deltaSeconds: number): Promise<DispatchResult>;
  reset(): Promise<RustGameSnapshot>;
}
```

- [ ] **Step 5: Add snapshot normalization**

Create `src/runtime/snapshotView.ts`:

```ts
import type { GameState, GrowthWave, Scenario } from "../domain/types";
import type { RustGameSnapshot } from "./backend/types";

const scenario: Scenario = {
  name: "Growing Suburb",
  growthWaves: [
    {
      id: "intro",
      triggerTime: 0,
      message: "First residents arrive — build destinations so they can commute.",
      applied: false,
      tiles: [],
    },
  ],
  objectives: {
    maxLateRatio: 0.25,
    maxUnservedRatio: 0.2,
    maxAverageWait: 180,
    rollingWindowSeconds: 600,
    survivalTime: 1_200,
  },
};

export function normalizeRustSnapshot(snapshot: RustGameSnapshot): GameState {
  const nextGrowth: GrowthWave[] =
    snapshot.metrics.state === "running" ? scenario.growthWaves : [];
  return {
    ...snapshot,
    scenario: {
      ...scenario,
      growthWaves: nextGrowth,
    },
  };
}
```

- [ ] **Step 6: Add Rust snapshot fixture builder**

Create `tests/fixtures/rustSnapshot.ts`:

```ts
import type { RustGameSnapshot } from "../../src/runtime/backend/types";

export function createRustSnapshot(
  overrides: Partial<RustGameSnapshot> = {},
): RustGameSnapshot {
  return {
    time: 0,
    day: 0,
    clockMinutes: 0,
    speed: 1,
    paused: true,
    budget: 120_000,
    map: { width: 28, height: 18, tiles: [] },
    buildings: [],
    transit: {
      stops: [],
      stations: [],
      routes: [],
      metroLines: [],
      vehicles: [],
    },
    sims: [],
    activeTrips: [],
    tripSequenceDay: 0,
    nextTripSequence: 1,
    metrics: {
      lateTrips: 0,
      completedTrips: 0,
      unservedTrips: 0,
      totalWaitSeconds: 0,
      waitingCitizenCount: 0,
      averageWaitSeconds: 0,
      tripOutcomes: [],
      state: "running",
      lossReason: null,
    },
    ...overrides,
  };
}
```

- [ ] **Step 7: Run focused TypeScript test**

Run:

```sh
bunx vitest run tests/runtime/backendContract.test.ts --project runtime
```

Expected: PASS.

- [ ] **Step 8: Commit**

```sh
git add src/domain/types.ts src/runtime/backend/types.ts src/runtime/snapshotView.ts tests/fixtures/rustSnapshot.ts tests/runtime/backendContract.test.ts
git commit -m "feat: add rust backend contract types"
```

---

### Task 3: WASM Facade And Browser Backend

**Files:**
- Modify: `Cargo.toml`
- Create: `crates/caelum-wasm/Cargo.toml`
- Create: `crates/caelum-wasm/src/lib.rs`
- Modify: `package.json`
- Create: `src/runtime/backend/wasmBackend.ts`
- Test: `tests/runtime/wasmBackend.test.ts`

- [ ] **Step 1: Write failing WASM backend test**

Create `tests/runtime/wasmBackend.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createWasmBackend } from "../../src/runtime/backend/wasmBackend";

describe("createWasmBackend", () => {
  it("loads the Rust engine and dispatches intents", async () => {
    const backend = await createWasmBackend();
    const initial = await backend.snapshot();

    expect(initial.paused).toBe(true);
    expect(initial.day).toBe(0);
    expect(initial.clockMinutes).toBe(0);

    const result = await backend.dispatch({ type: "setPaused", paused: false });

    expect(result.applied).toBe(true);
    expect(result.rejection).toBeNull();
    expect(result.snapshot.paused).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```sh
bunx vitest run tests/runtime/wasmBackend.test.ts --project runtime
```

Expected: FAIL because `src/runtime/backend/wasmBackend.ts` and generated WASM bindings do not exist.

- [ ] **Step 3: Add WASM crate to Cargo workspace**

Modify root `Cargo.toml`:

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

- [ ] **Step 4: Add wasm-bindgen wrapper**

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

impl Default for WasmGameEngine {
    fn default() -> Self {
        Self::new()
    }
}
```

- [ ] **Step 5: Add WASM build scripts**

Modify `package.json` scripts:

```json
"wasm:build": "wasm-pack build crates/caelum-wasm --target web --out-dir ../../src/generated/caelum_wasm --out-name caelum_wasm --dev",
"wasm:build:release": "wasm-pack build crates/caelum-wasm --target web --out-dir ../../src/generated/caelum_wasm --out-name caelum_wasm --release",
"prebuild": "bun run wasm:build:release"
```

- [ ] **Step 6: Generate WASM bindings**

Run:

```sh
bun run wasm:build
```

Expected: PASS and creates `src/generated/caelum_wasm/caelum_wasm.js`, `src/generated/caelum_wasm/caelum_wasm_bg.wasm`, and TypeScript declarations.

- [ ] **Step 7: Add browser backend**

Create `src/runtime/backend/wasmBackend.ts`:

```ts
import init, {
  WasmGameEngine,
} from "../../generated/caelum_wasm/caelum_wasm";
import type {
  DispatchResult,
  GameBackend,
  GameIntent,
  RustGameSnapshot,
} from "./types";

function asSnapshot(value: unknown): RustGameSnapshot {
  return value as RustGameSnapshot;
}

function asDispatchResult(value: unknown): DispatchResult {
  return value as DispatchResult;
}

export async function createWasmBackend(): Promise<GameBackend> {
  await init();
  const engine = new WasmGameEngine();

  return {
    async snapshot(): Promise<RustGameSnapshot> {
      return asSnapshot(engine.snapshot());
    },
    async dispatch(intent: GameIntent): Promise<DispatchResult> {
      return asDispatchResult(engine.dispatch(intent));
    },
    async tick(deltaSeconds: number): Promise<DispatchResult> {
      return asDispatchResult(engine.tick(deltaSeconds));
    },
    async reset(): Promise<RustGameSnapshot> {
      return asSnapshot(engine.reset());
    },
  };
}
```

- [ ] **Step 8: Run WASM backend test**

Run:

```sh
bunx vitest run tests/runtime/wasmBackend.test.ts --project runtime
```

Expected: PASS.

- [ ] **Step 9: Commit**

```sh
git add Cargo.toml Cargo.lock crates/caelum-wasm package.json bun.lock src/generated/caelum_wasm src/runtime/backend/wasmBackend.ts tests/runtime/wasmBackend.test.ts
git commit -m "feat: expose rust engine through wasm"
```

---

### Task 4: Tauri Commands And Backend Selection

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Create: `src/runtime/backend/tauriBackend.ts`
- Create: `src/runtime/backend/index.ts`
- Test: `tests/runtime/backendSelection.test.ts`

- [ ] **Step 1: Write failing backend selection test**

Create `tests/runtime/backendSelection.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createBackend, isTauriRuntime } from "../../src/runtime/backend";

describe("backend host selection", () => {
  it("detects browser when Tauri internals are absent", () => {
    expect(isTauriRuntime({})).toBe(false);
  });

  it("detects Tauri when internal marker is present", () => {
    expect(isTauriRuntime({ __TAURI_INTERNALS__: {} })).toBe(true);
  });

  it("creates the Tauri backend when Tauri internals are present", async () => {
    const backend = { snapshot: vi.fn() };
    const created = await createBackend({
      windowLike: { __TAURI_INTERNALS__: {} },
      createTauri: async () => backend as never,
      createWasm: async () => {
        throw new Error("wasm should not load");
      },
    });

    expect(created).toBe(backend);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```sh
bunx vitest run tests/runtime/backendSelection.test.ts --project runtime
```

Expected: FAIL because backend index and Tauri backend do not exist.

- [ ] **Step 3: Add Tauri Rust commands**

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(EngineState(Mutex::new(GameEngine::new())))
        .invoke_handler(tauri::generate_handler![
            game_snapshot,
            game_dispatch,
            game_tick,
            game_reset
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 4: Add Tauri backend**

Create `src/runtime/backend/tauriBackend.ts`:

```ts
import { invoke } from "@tauri-apps/api/core";
import type {
  DispatchResult,
  GameBackend,
  GameIntent,
  RustGameSnapshot,
} from "./types";

export async function createTauriBackend(): Promise<GameBackend> {
  return {
    snapshot(): Promise<RustGameSnapshot> {
      return invoke<RustGameSnapshot>("game_snapshot");
    },
    dispatch(intent: GameIntent): Promise<DispatchResult> {
      return invoke<DispatchResult>("game_dispatch", { intent });
    },
    tick(deltaSeconds: number): Promise<DispatchResult> {
      return invoke<DispatchResult>("game_tick", { deltaSeconds });
    },
    reset(): Promise<RustGameSnapshot> {
      return invoke<RustGameSnapshot>("game_reset");
    },
  };
}
```

- [ ] **Step 5: Add host selection**

Create `src/runtime/backend/index.ts`:

```ts
import { createTauriBackend } from "./tauriBackend";
import { createWasmBackend } from "./wasmBackend";
import type { GameBackend } from "./types";

export type {
  DispatchResult,
  GameBackend,
  GameIntent,
  RustGameSnapshot,
} from "./types";

interface BackendFactoryOptions {
  windowLike?: unknown;
  createTauri?: () => Promise<GameBackend>;
  createWasm?: () => Promise<GameBackend>;
}

export function isTauriRuntime(source: unknown = globalThis.window): boolean {
  return (
    typeof source === "object" &&
    source !== null &&
    "__TAURI_INTERNALS__" in source
  );
}

export async function createBackend({
  windowLike = globalThis.window,
  createTauri = createTauriBackend,
  createWasm = createWasmBackend,
}: BackendFactoryOptions = {}): Promise<GameBackend> {
  return isTauriRuntime(windowLike) ? createTauri() : createWasm();
}
```

- [ ] **Step 6: Run focused checks**

Run:

```sh
bunx vitest run tests/runtime/backendSelection.test.ts --project runtime
cargo check --workspace
```

Expected: PASS.

- [ ] **Step 7: Commit**

```sh
git add src-tauri/src/lib.rs src/runtime/backend/tauriBackend.ts src/runtime/backend/index.ts tests/runtime/backendSelection.test.ts
git commit -m "feat: add tauri rust backend"
```

---

### Task 5: Runtime Bootstrap And Rust Intent Mapping

**Files:**
- Modify: `src/runtime/types.ts`
- Modify: `src/runtime/createGameRuntime.ts`
- Modify: `src/main.ts`
- Modify: `src/App.svelte`
- Test: `tests/runtime/gameRuntime.test.ts`
- Test: `tests/ui/appShell.test.ts`

- [ ] **Step 1: Add failing runtime intent-mapping tests**

In `tests/runtime/gameRuntime.test.ts`, replace direct `createGameRuntime()` setup for new backend-focused tests with this helper:

```ts
import { createRustSnapshot } from "../fixtures/rustSnapshot";
import type {
  DispatchResult,
  GameBackend,
  GameIntent,
  RustGameSnapshot,
} from "../../src/runtime/backend/types";

function backendSpy(
  initial: RustGameSnapshot = createRustSnapshot(),
): GameBackend & { intents: GameIntent[]; setSnapshot(next: RustGameSnapshot): void } {
  const intents: GameIntent[] = [];
  let snapshot = initial;
  return {
    intents,
    setSnapshot(next) {
      snapshot = next;
    },
    async snapshot() {
      return snapshot;
    },
    async dispatch(intent): Promise<DispatchResult> {
      intents.push(intent);
      if (intent.type === "setPaused") {
        snapshot = { ...snapshot, paused: intent.paused };
      }
      if (intent.type === "setSpeed") {
        snapshot = { ...snapshot, speed: intent.speed };
      }
      return { snapshot, applied: true, rejection: null };
    },
    async tick(deltaSeconds): Promise<DispatchResult> {
      snapshot =
        snapshot.paused || snapshot.speed === 0
          ? snapshot
          : { ...snapshot, time: snapshot.time + deltaSeconds * snapshot.speed };
      return { snapshot, applied: snapshot.time !== initial.time, rejection: null };
    },
    async reset() {
      snapshot = createRustSnapshot();
      return snapshot;
    },
  };
}
```

Add these tests:

```ts
it("dispatches pause and speed through the Rust backend", async () => {
  const backend = backendSpy();
  const runtime = await createGameRuntime({ backend });

  await runtime.togglePause();
  await runtime.setSpeed(4);

  expect(backend.intents).toContainEqual({ type: "setPaused", paused: false });
  expect(backend.intents).toContainEqual({ type: "setSpeed", speed: 4 });
  expect(runtime.getSnapshot().state.paused).toBe(false);
  expect(runtime.getSnapshot().state.speed).toBe(4);
});

it("commits road drag as one Rust layRoadLine intent", async () => {
  const backend = backendSpy();
  const runtime = await createGameRuntime({ backend });

  runtime.setTool("road");
  runtime.setRoadPreset("oneWay");
  runtime.startDrag({ x: 1, y: 0 });
  runtime.setDragCurrent({ x: 3, y: 0 });
  await runtime.commitDrag();

  expect(backend.intents).toContainEqual({
    type: "layRoadLine",
    points: [
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 3, y: 0 },
    ],
    preset: "oneWay",
  });
});

it("dispatches route finish and clears the draft only after Rust accepts it", async () => {
  const backend = backendSpy(
    createRustSnapshot({
      transit: {
        stops: [
          { id: "stop-001", kind: "busStop", position: { x: 1, y: 1 }, platforms: [] },
          { id: "stop-002", kind: "busStop", position: { x: 2, y: 1 }, platforms: [] },
        ],
        stations: [],
        routes: [],
        metroLines: [],
        vehicles: [],
      },
    }),
  );
  const runtime = await createGameRuntime({ backend });

  runtime.setTool("busRoute");
  runtime.handleTileClick({ x: 1, y: 1 });
  runtime.handleTileClick({ x: 2, y: 1 });
  await runtime.finishRoute();

  expect(backend.intents).toContainEqual({
    type: "addBusRoute",
    stopIds: ["stop-001", "stop-002"],
  });
  expect(runtime.getSnapshot().ui.draftStopIds).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```sh
bunx vitest run tests/runtime/gameRuntime.test.ts --project runtime
```

Expected: FAIL because `createGameRuntime` is still synchronous and still constructs TypeScript simulation state internally.

- [ ] **Step 3: Update runtime types for async command results**

Modify `src/runtime/types.ts`:

```ts
export interface RuntimeSnapshot {
  state: GameState;
  ui: UiState;
  shell: ShellState;
  backendError: string | null;
}

export type RuntimeCommandResult = RuntimeSnapshot | Promise<RuntimeSnapshot>;
```

Change gameplay methods in `RuntimeController` to return `RuntimeCommandResult`:

```ts
  tick: (deltaSeconds: number) => RuntimeCommandResult;
  reset: () => RuntimeCommandResult;
  commitDrag: () => RuntimeCommandResult;
  togglePause: () => RuntimeCommandResult;
  setSpeed: (speed: GameState["speed"]) => RuntimeCommandResult;
  handleTileClick: (point: Point) => RuntimeCommandResult;
  assignRouteToPlatform: (
    nodeId: string,
    routeId: string,
    platformId: string,
  ) => RuntimeCommandResult;
  finishRoute: () => RuntimeCommandResult;
  renameRoute: (routeId: string, name: string) => RuntimeCommandResult;
  recolorRoute: (routeId: string, color: string) => RuntimeCommandResult;
  toggleRouteActive: (routeId: string) => RuntimeCommandResult;
  deleteRoute: (routeId: string) => RuntimeCommandResult;
```

- [ ] **Step 4: Change runtime constructor to async backend initialization**

Modify `src/runtime/createGameRuntime.ts` imports:

```ts
import type { GameBackend, GameIntent } from "./backend";
import { normalizeRustSnapshot } from "./snapshotView";
```

Change the constructor shape:

```ts
interface CreateGameRuntimeOptions {
  backend: GameBackend;
}

export async function createGameRuntime({
  backend,
}: CreateGameRuntimeOptions): Promise<RuntimeController> {
  let state = normalizeRustSnapshot(await backend.snapshot());
  let ui = createUiState();
  let backendError: string | null = null;
  let gameplayQueue = Promise.resolve();
```

Update `getSnapshot`:

```ts
  const getSnapshot = (): RuntimeSnapshot => ({
    state,
    ui,
    shell: selectShellState(state, ui),
    backendError,
  });
```

Add helpers before the `api` object:

```ts
  const failBackend = (error: unknown): RuntimeSnapshot => {
    backendError = error instanceof Error ? error.message : String(error);
    stop();
    return publish();
  };

  const enqueueDispatch = (
    intent: GameIntent,
    nextUi: UiState | ((applied: boolean) => UiState) = ui,
  ): Promise<RuntimeSnapshot> => {
    const run = gameplayQueue.then(async () => {
      const result = await backend.dispatch(intent);
      const resolvedUi =
        typeof nextUi === "function" ? nextUi(result.applied) : nextUi;
      return commit(normalizeRustSnapshot(result.snapshot), resolvedUi);
    });
    gameplayQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run.catch(failBackend);
  };

  const enqueueTick = (deltaSeconds: number): Promise<RuntimeSnapshot> => {
    const run = gameplayQueue.then(async () => {
      const result = await backend.tick(deltaSeconds);
      return commit(normalizeRustSnapshot(result.snapshot), ui);
    });
    gameplayQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run.catch(failBackend);
  };
```

- [ ] **Step 5: Replace gameplay mutations with backend intents**

Replace runtime methods with intent dispatches:

```ts
    tick(deltaSeconds) {
      return enqueueTick(deltaSeconds);
    },
    reset() {
      const run = gameplayQueue.then(async () => {
        const snapshot = await backend.reset();
        state = normalizeRustSnapshot(snapshot);
        ui = createUiState();
        return publish();
      });
      gameplayQueue = run.then(
        () => undefined,
        () => undefined,
      );
      return run.catch(failBackend);
    },
    togglePause() {
      return enqueueDispatch({ type: "setPaused", paused: !state.paused });
    },
    setSpeed(speed) {
      return enqueueDispatch({ type: "setSpeed", speed });
    },
```

Use this helper for tile clicks:

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
    if (ui.activeTool === "busStop") return { type: "addBusStop", point };
    if (ui.activeTool === "metroStation") return { type: "addMetroStation", point };
    if (ui.activeTool === "track") return { type: "layTrack", point };
    if (ui.activeTool === "remove") return { type: "removeAtTile", point };
    if (ui.activeTool === "road") {
      const tile = state.map.tiles.find((candidate) => candidate.x === point.x && candidate.y === point.y);
      return tile?.kind === "road"
        ? { type: "cycleRoadDirection", point }
        : { type: "layRoad", point };
    }
    return null;
  };
```

Update `handleTileClick`:

```ts
    handleTileClick(point) {
      if (ui.activeTool === "inspect" || ui.activeTool === "busRoute" || ui.activeTool === "metroLine") {
        const nextUi = applyUiTileClick(state, ui, point);
        return commit(state, nextUi);
      }
      const intent = intentForToolClick(point);
      return intent === null ? commit(state, ui) : enqueueDispatch(intent);
    },
```

Use this line intent in `commitDrag`:

```ts
      if (gesture.tool === "area") {
        return enqueueDispatch(
          {
            type: "paintAreaRectangle",
            area: gesture.area,
            start: gesture.start,
            end: gesture.current,
          },
          { ...ui, drag: null },
        );
      }
      const line = axisLockedLine(gesture.start, gesture.current);
      if (line.length <= 1) {
        const intent = intentForToolClick(line[0]);
        return intent === null
          ? commit(state, { ...ui, drag: null })
          : enqueueDispatch(intent, { ...ui, drag: null });
      }
      if (gesture.tool === "remove") {
        return enqueueDispatch({ type: "removeAtTiles", points: line }, { ...ui, drag: null });
      }
      if (gesture.tool === "track") {
        return enqueueDispatch({ type: "layTrackLine", points: line }, { ...ui, drag: null });
      }
      return enqueueDispatch(
        { type: "layRoadLine", points: line, preset: ui.roadPreset },
        { ...ui, drag: null },
      );
```

For route management methods:

```ts
    finishRoute() {
      if (ui.activeTool === "busRoute") {
        return enqueueDispatch(
          { type: "addBusRoute", stopIds: ui.draftStopIds },
          (applied) => (applied ? { ...ui, draftStopIds: [], draftStopPaths: [] } : ui),
        );
      }
      if (ui.activeTool === "metroLine") {
        return enqueueDispatch(
          { type: "addMetroLine", stationIds: ui.draftStationIds },
          (applied) => (applied ? { ...ui, draftStationIds: [], draftStationPaths: [] } : ui),
        );
      }
      return commit(state, ui);
    },
    renameRoute(routeId, name) {
      return enqueueDispatch({ type: "renameRoute", routeId, name });
    },
    recolorRoute(routeId, color) {
      return enqueueDispatch({ type: "recolorRoute", routeId, color });
    },
    toggleRouteActive(routeId) {
      const route =
        state.transit.routes.find((r) => r.id === routeId) ??
        state.transit.metroLines.find((l) => l.id === routeId);
      return route === undefined
        ? commit(state, ui)
        : enqueueDispatch({ type: "setRouteActive", routeId, active: !route.active });
    },
    deleteRoute(routeId) {
      const nextUi =
        ui.selectedRouteId === routeId ? { ...ui, selectedRouteId: null } : ui;
      return enqueueDispatch({ type: "deleteRoute", routeId }, nextUi);
    },
```

- [ ] **Step 6: Update app bootstrap**

Modify `src/main.ts`:

```ts
import "./styles.css";
import { mount } from "svelte";
import App from "./App.svelte";
import { createBackend } from "./runtime/backend";
import { createGameRuntime } from "./runtime/createGameRuntime";

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("Missing #app root");
}

async function mountApp(): Promise<void> {
  const backend = await createBackend();
  const runtime = await createGameRuntime({ backend });
  mount(App, {
    target: app,
    props: { runtime, error: null },
  });
}

mountApp().catch((err: unknown) => {
  mount(App, {
    target: app,
    props: {
      runtime: null,
      error: err instanceof Error ? err.message : "Bootstrap failed",
    },
  });
});
```

Modify `src/App.svelte` props:

```ts
  interface Props {
    runtime: RuntimeController | null;
    error?: string | null;
  }
```

Guard runtime usage in effects and markup so error-only boot does not require a runtime:

```svelte
{#if shellError || runtime === null}
  <main class="shell" data-testid="game-shell">
    <div class="shell-error" role="alert">
      <strong>Shell Error:</strong>
      {shellError ?? "Runtime unavailable"}
    </div>
  </main>
{:else}
```

Add an async result helper in `src/App.svelte`:

```ts
  async function applyRuntimeResult(result: RuntimeCommandResult): Promise<void> {
    try {
      const nextSnapshot = await result;
      snapshot = nextSnapshot;
      if (nextSnapshot.backendError !== null) {
        shellError = nextSnapshot.backendError;
      }
    } catch (err) {
      shellError = err instanceof Error ? err.message : "Runtime command failed";
    }
  }
```

Change gameplay handlers to call `void applyRuntimeResult` with concrete runtime calls:

```ts
  function handleTogglePause(): void {
    if (runtime !== null) {
      void applyRuntimeResult(runtime.togglePause());
    }
  }

  function handleSetSpeed(speed: 1 | 2 | 4): void {
    if (runtime !== null) {
      void applyRuntimeResult(runtime.setSpeed(speed));
    }
  }

  function handleFinishRoute(): void {
    if (runtime !== null) {
      void applyRuntimeResult(runtime.finishRoute());
    }
  }
```

- [ ] **Step 7: Run runtime and UI tests**

Run:

```sh
bunx vitest run tests/runtime/gameRuntime.test.ts --project runtime
bunx vitest run tests/ui/appShell.test.ts --project ui
```

Expected: PASS after changing runtime test setup from `const runtime = createGameRuntime()` to `const runtime = await createGameRuntime({ backend: backendSpy() })` and changing gameplay assertions to await calls such as `await runtime.togglePause()` and `await runtime.commitDrag()`.

- [ ] **Step 8: Commit**

```sh
git add src/runtime/createGameRuntime.ts src/runtime/types.ts src/main.ts src/App.svelte tests/runtime/gameRuntime.test.ts tests/ui/appShell.test.ts
git commit -m "feat: route runtime gameplay through rust backend"
```

---

### Task 6: Read-Only UI Helpers And Rust Snapshot Rendering

**Files:**
- Create: `src/domain/catalog/areas.ts`
- Create: `src/domain/catalog/buildings.ts`
- Create: `src/domain/catalog/transit.ts`
- Create: `src/ui/routeDraft.ts`
- Modify: `src/ui/actions.ts`
- Modify: `src/ui/roadDrag.ts`
- Modify: `src/runtime/runtimeSelectors.ts`
- Modify: `src/render/citizenRenderer.ts`
- Modify: `src/render/overlayRenderer.ts`
- Modify: `src/render/cursorBadge.ts`
- Test: `tests/runtime/runtimeSelectors.test.ts`
- Test: `tests/render/overlayRenderer.test.ts`
- Test: `tests/render/cursorBadge.test.ts`

- [ ] **Step 1: Add failing selector/render tests for Rust active trips**

In `tests/runtime/runtimeSelectors.test.ts`, add:

```ts
import { normalizeRustSnapshot } from "../../src/runtime/snapshotView";
import { createRustSnapshot } from "../fixtures/rustSnapshot";

it("formats Rust day clock and population from sims", () => {
  const state = normalizeRustSnapshot(
    createRustSnapshot({
      day: 1,
      clockMinutes: 8 * 60 + 5,
      sims: [
        {
          id: "sim-001",
          home: { x: 1, y: 1 },
          position: { x: 1, y: 1 },
          workerProfile: "worker",
          commuteDay: 1,
          outboundResolvedToday: false,
          outboundArrivedToday: false,
          returnResolvedToday: false,
          returnedHomeToday: false,
        },
      ],
    }),
  );

  const shell = selectShellState(state, createUiState());

  expect(shell.topbar.time).toBe("Day 2 08:05");
  expect(shell.topbar.population).toBe("1");
});
```

In `tests/render/overlayRenderer.test.ts`, add a demand/lateness fixture with `activeTrips`:

```ts
it("renders demand and lateness overlays from Rust active trips", () => {
  const state = normalizeRustSnapshot(
    createRustSnapshot({
      activeTrips: [
        {
          id: "trip-001",
          simId: "sim-001",
          purpose: "commuteOutbound",
          origin: { x: 1, y: 1 },
          destination: { x: 5, y: 5 },
          position: { x: 2, y: 2 },
          status: "late",
          deadline: 100,
          routePlan: null,
          currentLegIndex: 0,
          patienceRemaining: 30,
        },
      ],
    }),
  );
  const ctx = createMockContext();

  renderOverlays(ctx, state, { ...createUiState(), activeOverlay: "demand" });
  renderOverlays(ctx, state, { ...createUiState(), activeOverlay: "lateness" });

  expect(ctx.fillRect).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```sh
bunx vitest run tests/runtime/runtimeSelectors.test.ts --project runtime
bunx vitest run tests/render/overlayRenderer.test.ts --project ui
```

Expected: FAIL because selectors/renderers still read `citizens` and `T+mm:ss`.

- [ ] **Step 3: Move read-only catalogs out of simulation**

Create `src/domain/catalog/areas.ts`:

```ts
import type { AreaKind } from "../types";

export const AREA_KINDS = [
  "residential",
  "commercial",
  "industrial",
  "office",
  "civic",
  "park",
] as const satisfies AreaKind[];

export const AREA_LABELS: Record<AreaKind, string> = {
  residential: "Residential",
  commercial: "Commercial",
  industrial: "Industrial",
  office: "Office",
  civic: "Civic",
  park: "Park",
};
```

Create `src/domain/catalog/buildings.ts`:

```ts
import type {
  AreaKind,
  BuildingRotation,
  BuildingType,
  Point,
} from "../types";

export type BuildingEffect =
  | "busStop"
  | "busTerminal"
  | "metroStation"
  | "housing"
  | "destination";

export interface BuildingDefinition {
  type: BuildingType;
  label: string;
  width: number;
  height: number;
  cost: number;
  effect: BuildingEffect;
  allowedArea?: AreaKind;
  citizenCount?: number;
}

export const BUILDING_CATALOG: Record<BuildingType, BuildingDefinition> = {
  busStop: {
    type: "busStop",
    label: "Bus Stop",
    width: 1,
    height: 1,
    cost: 2_000,
    effect: "busStop",
  },
  busTerminal: {
    type: "busTerminal",
    label: "Bus Terminal",
    width: 3,
    height: 2,
    cost: 12_000,
    effect: "busTerminal",
  },
  metroStation: {
    type: "metroStation",
    label: "Metro Station",
    width: 1,
    height: 1,
    cost: 25_000,
    effect: "metroStation",
  },
  smallHouse: {
    type: "smallHouse",
    label: "Small House",
    width: 2,
    height: 1,
    cost: 4_000,
    effect: "housing",
    allowedArea: "residential",
    citizenCount: 4,
  },
  largeHouse: {
    type: "largeHouse",
    label: "Large House",
    width: 3,
    height: 2,
    cost: 10_000,
    effect: "housing",
    allowedArea: "residential",
    citizenCount: 10,
  },
  supermarket: {
    type: "supermarket",
    label: "Supermarket",
    width: 2,
    height: 2,
    cost: 8_000,
    effect: "destination",
    allowedArea: "commercial",
  },
  cinema: {
    type: "cinema",
    label: "Cinema",
    width: 3,
    height: 2,
    cost: 14_000,
    effect: "destination",
    allowedArea: "commercial",
  },
  factory: {
    type: "factory",
    label: "Factory",
    width: 3,
    height: 2,
    cost: 16_000,
    effect: "destination",
    allowedArea: "industrial",
  },
  warehouse: {
    type: "warehouse",
    label: "Warehouse",
    width: 3,
    height: 2,
    cost: 12_000,
    effect: "destination",
    allowedArea: "industrial",
  },
  officeTower: {
    type: "officeTower",
    label: "Office Tower",
    width: 2,
    height: 2,
    cost: 18_000,
    effect: "destination",
    allowedArea: "office",
  },
  businessPark: {
    type: "businessPark",
    label: "Business Park",
    width: 3,
    height: 2,
    cost: 15_000,
    effect: "destination",
    allowedArea: "office",
  },
  clinic: {
    type: "clinic",
    label: "Clinic",
    width: 2,
    height: 2,
    cost: 12_000,
    effect: "destination",
    allowedArea: "civic",
  },
  school: {
    type: "school",
    label: "School",
    width: 3,
    height: 2,
    cost: 18_000,
    effect: "destination",
    allowedArea: "civic",
  },
  parkPlaza: {
    type: "parkPlaza",
    label: "Park Plaza",
    width: 2,
    height: 2,
    cost: 6_000,
    effect: "destination",
    allowedArea: "park",
  },
};

export function getRotatedFootprintSize(
  type: BuildingType,
  rotation: BuildingRotation,
): { width: number; height: number } {
  const definition = BUILDING_CATALOG[type];
  return rotation === 90 || rotation === 270
    ? { width: definition.height, height: definition.width }
    : { width: definition.width, height: definition.height };
}

export function getBuildingFootprint(
  type: BuildingType,
  origin: Point,
  rotation: BuildingRotation,
): Point[] {
  const size = getRotatedFootprintSize(type, rotation);
  const points: Point[] = [];

  for (let y = 0; y < size.height; y += 1) {
    for (let x = 0; x < size.width; x += 1) {
      points.push({ x: origin.x + x, y: origin.y + y });
    }
  }

  return points;
}
```

Create `src/domain/catalog/transit.ts`:

```ts
import type { Stop } from "../types";

export const COSTS = {
  road: 100,
  busStop: 2_000,
  busTerminal: 12_000,
  metroStation: 25_000,
  bus: 8_000,
  track: 500,
  metro: 50_000,
} as const;

export function stopCoverageRadius(stop: Stop): number {
  return stop.kind === "busTerminal" ? 4 : 2;
}
```

- [ ] **Step 4: Convert UI tile helpers to read-only snapshot helpers**

Replace `src/ui/actions.ts` with a read-only file that exports `resolveNodesAtTile`, `resolveNodeAtTile`, and `applyUiTileClick`. The file must not import mutation helpers such as `placeBuilding`, `addBusStop`, `layRoad`, or `deleteRoute`. The inspect branch should keep this exact empty-tile behavior:

```ts
export function applyUiTileClick(
  state: GameState,
  ui: UiState,
  point: Point,
): UiState {
  if (ui.activeTool === "inspect") {
    const nodes = resolveNodesAtTile(state, point);
    if (nodes.length === 0) {
      return {
        ...ui,
        selectedId: `${point.x},${point.y}`,
        selectedNodeKind: null,
        activeHudCategory:
          ui.activeHudCategory === "inspect" ? null : ui.activeHudCategory,
      };
    }

    const isSameTile = ui.selectedId === `${point.x},${point.y}`;
    let selectedNodeKind: "stop" | "station";
    if (isSameTile && nodes.length > 1) {
      const otherNode = nodes.find((node) => node.kind !== ui.selectedNodeKind);
      selectedNodeKind = otherNode?.kind ?? nodes[0].kind;
    } else {
      selectedNodeKind = nodes[0].kind;
    }

    return {
      ...ui,
      selectedId: `${point.x},${point.y}`,
      selectedNodeKind,
      activeHudCategory: "inspect",
    };
  }

  return ui;
}
```

Add these bus-route and metro-line branches after the inspect branch:

```ts
  if (ui.activeTool === "busRoute") {
    const stop = resolveStopAtTile(state.transit.stops, point);
    if (stop === undefined || ui.draftStopIds.at(-1) === stop.id) {
      return ui;
    }
    return {
      ...ui,
      draftStopIds: [...ui.draftStopIds, stop.id],
      draftStopPaths: ui.draftStopPaths,
    };
  }

  if (ui.activeTool === "metroLine") {
    const station = resolveStationAtTile(state.transit.stations, point);
    if (
      station === undefined ||
      ui.draftStationIds.at(-1) === station.id
    ) {
      return ui;
    }
    return {
      ...ui,
      draftStationIds: [...ui.draftStationIds, station.id],
      draftStationPaths: ui.draftStationPaths,
    };
  }
```

Route creation remains authoritative in Rust through `addBusRoute` and `addMetroLine`; the draft arrays are only UI state.

Create `src/ui/routeDraft.ts`:

```ts
import type { GameMap, Point, Station, Stop, TransitMode } from "../domain/types";

function samePoint(left: Point, right: Point): boolean {
  return left.x === right.x && left.y === right.y;
}

export function resolveStopAtTile(stops: Stop[], point: Point): Stop | undefined {
  return stops.find((candidate) => samePoint(candidate.position, point));
}

export function resolveStationAtTile(
  stations: Station[],
  point: Point,
): Station | undefined {
  return stations.find((candidate) => samePoint(candidate.position, point));
}

export function tilePathExists(
  map: GameMap,
  from: Point,
  to: Point,
  mode: Exclude<TransitMode, "walk">,
): boolean {
  if (from.x === to.x && from.y === to.y) {
    return true;
  }
  const traversable = new Set(
    map.tiles
      .filter((tile) => (mode === "bus" ? tile.kind === "road" : tile.hasTrack === true))
      .map((tile) => `${tile.x},${tile.y}`),
  );
  return traversable.has(`${from.x},${from.y}`) || traversable.has(`${to.x},${to.y}`);
}
```

This helper is only a route-draft guard. Rust route creation remains authoritative.

- [ ] **Step 5: Update selectors and renderers**

Modify `src/runtime/runtimeSelectors.ts`:

```ts
export function formatTimeFromClock(day: number, clockMinutes: number): string {
  const hours = Math.floor(clockMinutes / 60)
    .toString()
    .padStart(2, "0");
  const minutes = (clockMinutes % 60).toString().padStart(2, "0");
  return `Day ${day + 1} ${hours}:${minutes}`;
}
```

Use these topbar fields:

```ts
time: formatTimeFromClock(state.day, state.clockMinutes),
population: `${state.sims.length}`,
```

Modify `src/render/citizenRenderer.ts`:

```ts
export function renderCitizens(
  ctx: CanvasRenderingContext2D,
  state: GameState,
): void {
  for (const trip of state.activeTrips) {
    if (trip.status === "arrived") {
      continue;
    }

    ctx.fillStyle = statusColor(trip.status);
    ctx.beginPath();
    ctx.arc(
      trip.position.x * tileSize + 10,
      trip.position.y * tileSize + 10,
      3,
      0,
      Math.PI * 2,
    );
    ctx.fill();
  }
}
```

Modify demand/lateness loops in `src/render/overlayRenderer.ts`:

```ts
  if (ui.activeOverlay === "lateness") {
    ctx.fillStyle = colors.lateness;

    for (const trip of state.activeTrips) {
      if (trip.status === "late" || trip.status === "unserved") {
        fillTile(ctx, trip.position);
      }
    }
  }

  if (ui.activeOverlay === "demand") {
    ctx.fillStyle = colors.demand;

    for (const trip of state.activeTrips) {
      if (trip.status !== "arrived") {
        fillTile(ctx, trip.destination);
      }
    }
  }
```

- [ ] **Step 6: Run focused tests**

Run:

```sh
bunx vitest run tests/runtime/runtimeSelectors.test.ts --project runtime
bunx vitest run tests/render/overlayRenderer.test.ts tests/render/cursorBadge.test.ts --project ui
```

Expected: PASS.

- [ ] **Step 7: Commit**

```sh
git add src/domain/catalog src/ui/actions.ts src/ui/routeDraft.ts src/ui/roadDrag.ts src/runtime/runtimeSelectors.ts src/render/citizenRenderer.ts src/render/overlayRenderer.ts src/render/cursorBadge.ts tests/runtime/runtimeSelectors.test.ts tests/render/overlayRenderer.test.ts tests/render/cursorBadge.test.ts
git commit -m "refactor: render rust snapshots without simulation mutation"
```

---

### Task 7: Rust-Backed Browser E2E

**Files:**
- Modify: `tests/e2e/smoke.spec.ts`
- Modify: `tests/e2e/routes.spec.ts`
- Modify: `tests/e2e/helpers.ts`
- Modify: `tests/ui/appShell.test.ts`
- Test: `tests/runtime/gameRuntime.test.ts`

- [ ] **Step 1: Update E2E expectations for Rust clock and sims**

Modify `tests/e2e/smoke.spec.ts` after the initial topbar assertions:

```ts
await expect(topbar.getByText("Day 1 00:00")).toBeVisible();
```

After placing the small house, keep the population assertion but read it from the population readout:

```ts
await expect(populationReadout.getByText("4")).toBeVisible();
```

At the end of the smoke test, add:

```ts
await page.getByRole("button", { name: "Resume" }).click();
await expect(topbar.getByText(/Day 1/)).toBeVisible();
```

Modify `tests/e2e/routes.spec.ts` after finishing the bus route:

```ts
await expect(page.getByTestId("route-name-route-001")).toBeVisible();
await expect(page.getByText(/Avg Wait|Unserved|Late/)).toBeVisible();
```

- [ ] **Step 2: Run browser e2e to verify current failures**

Run:

```sh
bun run test:e2e
```

Expected: FAIL until runtime/bootstrap/render updates from prior tasks are complete.

- [ ] **Step 3: Update UI shell harness for async runtime results**

In `tests/ui/appShell.test.ts`, make runtime methods that can be async return promises and await the visible update. For example, change the topbar-control test to:

```ts
await fireEvent.click(screen.getByRole("button", { name: "Resume" }));
expect(runtime.togglePause).toHaveBeenCalledTimes(1);
expect(await screen.findByText("Live")).toBeVisible();

await fireEvent.click(screen.getByRole("button", { name: "4x" }));
expect(runtime.setSpeed).toHaveBeenCalledWith(4);
expect(screen.getByRole("button", { name: "4x" })).toHaveAttribute(
  "aria-pressed",
  "true",
);
```

Use this pattern in the harness:

Use this pattern in the harness:

```ts
const asyncPublish = vi.fn(async () => publish());

togglePause: vi.fn(async () => {
  state = { ...state, paused: !state.paused };
  return publish();
}),
setSpeed: vi.fn(async (speed: GameState["speed"]) => {
  state = { ...state, speed };
  return publish();
}),
```

- [ ] **Step 4: Run focused UI and runtime suites**

Run:

```sh
bunx vitest run tests/ui/appShell.test.ts --project ui
bunx vitest run tests/runtime/gameRuntime.test.ts --project runtime
```

Expected: PASS.

- [ ] **Step 5: Run E2E**

Run:

```sh
bun run test:e2e
```

Expected: PASS.

- [ ] **Step 6: Commit**

```sh
git add tests/e2e/smoke.spec.ts tests/e2e/routes.spec.ts tests/e2e/helpers.ts tests/ui/appShell.test.ts tests/runtime/gameRuntime.test.ts
git commit -m "test: verify rust-backed browser flows"
```

---

### Task 8: Retire Legacy TypeScript Simulation

**Files:**
- Delete or move: `src/simulation/*.ts`
- Modify: `vite.config.ts`
- Modify: `tests/simulation/*.test.ts`
- Modify: `tests/render/*.test.ts`
- Modify: `tests/runtime/*.test.ts`
- Modify: `tests/ui/*.test.ts`
- Modify: `docs/architecture.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Prove no live source path imports `src/simulation`**

Run:

```sh
rg -n "from \"\\.\\./simulation|from \"\\.\\./\\.\\./src/simulation|src/simulation" src tests vite.config.ts
```

Expected before cleanup: output from tests and any remaining files that still need migration.

- [ ] **Step 2: Delete migrated simulation tests**

Delete TypeScript simulation tests whose coverage exists in Rust tests:

```sh
git rm tests/simulation/areas.test.ts
git rm tests/simulation/buildings.test.ts
git rm tests/simulation/buildingSelectors.test.ts
git rm tests/simulation/citizens.test.ts
git rm tests/simulation/map.test.ts
git rm tests/simulation/network.test.ts
git rm tests/simulation/objectives.test.ts
git rm tests/simulation/platforms.test.ts
git rm tests/simulation/router.test.ts
git rm tests/simulation/scenario.test.ts
git rm tests/simulation/transit.test.ts
```

- [ ] **Step 3: Remove Vitest simulation project**

Modify `vite.config.ts` test projects by deleting the simulation project block:

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

Modify `package.json` scripts:

```json
"test:unit": "vitest run --project ui --project runtime",
"test:unit:coverage": "vitest run --project ui --project runtime --coverage --coverage.provider=v8 --coverage.reporter=lcov"
```

- [ ] **Step 4: Remove legacy simulation modules**

After live imports are gone, delete the legacy simulation directory:

```sh
git rm src/simulation/areas.ts
git rm src/simulation/buildingCatalog.ts
git rm src/simulation/buildingSelectors.ts
git rm src/simulation/buildings.ts
git rm src/simulation/citizens.ts
git rm src/simulation/gameState.ts
git rm src/simulation/map.ts
git rm src/simulation/network.ts
git rm src/simulation/objectives.ts
git rm src/simulation/platforms.ts
git rm src/simulation/router.ts
git rm src/simulation/simulation.ts
git rm src/simulation/tileQueries.ts
git rm src/simulation/transit.ts
```

- [ ] **Step 5: Update architecture docs**

In `docs/architecture.md`, replace the TypeScript-live-simulation language with:

```md
The Rust simulation core in `crates/caelum-core` is the single owner of gameplay
state. `createGameRuntime()` owns frontend UI state, subscriptions, animation
scheduling, host backend calls, and canvas mounting. Svelte and canvas render
from Rust snapshots and never mutate gameplay directly.

The browser uses the Rust core through WebAssembly generated from
`crates/caelum-wasm`. Tauri links the same `caelum-core` crate through managed
Rust command state. Both hosts share the same `GameEngine` facade.
```

In `CLAUDE.md`, update the project overview so it no longer says the TypeScript simulation is the live runtime. Keep a note that TypeScript contains UI/read-only helpers only.

- [ ] **Step 6: Re-run import search**

Run:

```sh
rg -n "src/simulation|\\.\\./simulation|\\.\\./\\.\\./src/simulation" src tests vite.config.ts docs CLAUDE.md
```

Expected: no output.

- [ ] **Step 7: Run focused verification**

Run:

```sh
bun run check
bun run test:unit
cargo test --workspace
```

Expected: PASS.

- [ ] **Step 8: Commit**

```sh
git add src tests vite.config.ts package.json bun.lock docs/architecture.md CLAUDE.md
git commit -m "refactor: retire typescript simulation authority"
```

---

### Task 9: Final Verification And Host Smoke

**Files:**
- Modify source only if verification reveals defects.

- [ ] **Step 1: Run full static and unit verification**

Run:

```sh
bun run check
bun run format:check
bun run build
bun run test
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

Expected: PASS.

- [ ] **Step 2: Run browser e2e**

Run:

```sh
bun run test:e2e
```

Expected: PASS.

- [ ] **Step 3: Run browser dev smoke**

Run:

```sh
bun run dev
```

Open `http://127.0.0.1:5281` and verify:

1. The app loads with no shell backend error.
2. The topbar shows `Day 1 00:00`.
3. Paint residential and commercial areas.
4. Place a Small House and a Supermarket.
5. Build roads, two bus stops, a bus route, and a bus vehicle.
6. Press Resume.
7. Observe the Day 1 clock move and metrics remain visible.

- [ ] **Step 4: Run Tauri build and smoke**

Run:

```sh
bun run tauri:build
```

Expected: PASS.

If a local desktop smoke is practical, run:

```sh
bun run tauri:dev
```

Verify the same vertical slice as the browser smoke. Confirm Tauri uses `game_snapshot`, `game_dispatch`, `game_tick`, and `game_reset` commands by checking that the app still works when `createBackend` selects the Tauri path.

- [ ] **Step 5: Confirm strict cutover**

Run:

```sh
rg -n "tickSimulation|createInitialGameState|src/simulation|\\.\\./simulation|GameBackend.*fallback|typescript simulation fallback" src tests docs CLAUDE.md
```

Expected: no live runtime/import path references TypeScript simulation. Documentation may mention the removed legacy simulation only in historical notes.

- [ ] **Step 6: Commit verification fixes if needed**

If Step 1 through Step 5 required source changes, rerun the relevant command and commit:

```sh
git status --short
git add src tests crates src-tauri docs CLAUDE.md package.json Cargo.toml Cargo.lock bun.lock
git commit -m "fix: complete rust host cutover verification"
```

If there are no source changes, do not create an empty commit.

---

## Self-Review

- Spec coverage:
  - Browser Rust backend: Task 3.
  - Tauri native backend: Task 4.
  - Runtime delegates gameplay mutation to Rust: Task 5.
  - TypeScript remains UI/read-only: Tasks 5 and 6.
  - Rust-shaped rendering and selectors: Task 6.
  - Legacy TypeScript simulation cleanup: Task 8.
  - Browser and desktop verification: Tasks 7 and 9.
- Placeholder scan:
  - The plan contains no unresolved marker text or unnamed files.
  - Every code-changing task names exact files, commands, and expected results.
- Type consistency:
  - `RoadPreset` serializes as `twoWay`, `oneWay`, and `dualBidirectional`.
  - TypeScript `GameIntent` uses Rust serde camelCase field names.
  - Runtime backend calls are promise-based for both WASM and Tauri.
