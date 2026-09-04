# HPA-544 Presentation Scale Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace ordinary full-snapshot frontend traffic with a compact Rust presentation wire, preserve one flat TypeScript live view, retire individual-citizen/dead overlay presentation, and measure the scale improvement before and after the cutover.

**Architecture:** `GameEngine` keeps `GameSnapshot + RoadTopology`. Rust projects `PresentationScene + PresentationFrame`; TypeScript merges those updates into the existing flat `GameState`. Reuse existing Rust population/platform/traffic/service rules, keep Canvas rAF ticking unchanged, and introduce Bevy only in HPA-347 when latent citizens actually become ECS state.

**Tech Stack:** current repository Rust toolchain, serde/serde_json, WASM (`wasm-bindgen`, `serde-wasm-bindgen`), Tauri 2, TypeScript 5, Svelte 5, Canvas2D, Vitest, Playwright, Bun, Cargo

**Spec:** `docs/superpowers/specs/2026-09-03-presentation-scale-foundation-design.md`

## Global Constraints

- Deliver HPA-544 in one implementation PR after this planning PR is approved.
- Do not add `bevy`, `bevy_ecs`, ECS scaffolding, a Rust toolchain bump, WebGPU, lower-frequency publication, interpolation, or a worker thread.
- Keep `GameSnapshot` as complete durable/core state.
- Ordinary startup/tick/dispatch/reset/restore output uses presentation, not complete snapshots.
- Rename ordinary `GameBackend.snapshot()` to `presentation()` and keep exactly nine backend methods.
- Rust wire is scene/frame; TypeScript runtime remains one flat `GameState` live view.
- Do not introduce a per-active-trip presentation vector.
- Remove individual citizen rendering and frontend `lateness`/`growth` overlays in this slice.
- Reuse `population::resident_occupancy`, existing `platforms.rs` matching, `traffic::derive_road_flow`, and existing service-metrics logic.
- Platform crowding counts overflow; boarding/route-health capacity truncation remains separate.
- Keep Canvas `requestAnimationFrame` + `createSerializedQueue` behavior unchanged.
- Preserve the existing no-op tick identity optimization: a tick with `applied === false` must not replace the flat live state or publish a fresh object.
- Keep `std::time::Instant` out of `crates/caelum-core/src`; only the native example may use it.
- Task 0 records the old full-snapshot baseline before presentation production code lands.
- The first gameplay-wire commit must pass Rust + WASM + TypeScript + unit + Playwright gates together.
- Cleanup inventories search both `src` and `tests`.
- Do not keep a long-lived full-snapshot compatibility adapter, second save schema, generic delta engine, event bus, or plugin framework.

## File Structure

### Measurement

- Create: `crates/caelum-core/examples/presentation_scale.rs` — deterministic fixture construction plus native timing.
- Create/modify: `docs/performance/hpa-544-presentation-baseline.md` — before/after measurements.
- Create in Task 4: `crates/caelum-core/tests/presentation_scale.rs` — clock-free structural scale assertions.

### Rust projection/core

- Create: `crates/caelum-core/src/presentation.rs` — presentation serde types and pure projector.
- Modify: `crates/caelum-core/src/population.rs` — add only job occupancy beside existing resident occupancy.
- Modify: `crates/caelum-core/src/platforms.rs` — add all-waiter occupancy by composing existing platform helpers.
- Modify: `crates/caelum-core/src/service_control.rs` — extract one reusable service-metrics map.
- Modify: `crates/caelum-core/src/intent.rs` — replace snapshot-carrying facade result.
- Modify: `crates/caelum-core/src/engine.rs` — presentation output policy; storage unchanged.
- Modify: `crates/caelum-core/src/lib.rs` — exports/comments.
- Create: `crates/caelum-core/tests/presentation_contract.rs` — public engine/wire behavior.
- Modify existing core tests that read `result.snapshot` after `GameEngine` calls.

### Hosts/frontend

- Modify: `crates/caelum-wasm/src/lib.rs`.
- Modify: `src-tauri/src/lib.rs`.
- Modify: `src/runtime/backend/types.ts`.
- Modify: `src/runtime/backend/persistenceContract.ts`.
- Modify: `src/runtime/backend/persistence.ts`.
- Modify: `src/runtime/backend/shared.ts`.
- Modify: `src/runtime/backend/wasmBackend.ts`.
- Modify: `src/runtime/backend/tauriBackend.ts`.
- Create: `src/runtime/presentationView.ts` — sole scene/frame-to-flat reducer.
- Modify: `src/runtime/createGameRuntime.ts`.
- Modify: `src/runtime/workingSaveRuntime.ts` — restored engine installation consumes presentation instead of a returned snapshot.
- Modify: `src/domain/types.ts`.
- Modify: `src/runtime/runtimeSelectors.ts`.
- Modify: `src/render/canvas.ts`.
- Modify: `src/render/overlayRenderer.ts`.
- Modify: `src/render/transitRenderer.ts` only where slim vehicle typing requires it.
- Modify: `src/render/colors.ts` to remove retired presentation colors with no remaining use.
- Delete: `src/render/citizenRenderer.ts`.
- Modify: `tests/helpers/gameState.ts` — continue using this existing shared live-state fixture builder.
- Modify: `tests/runtime/workingSaveRuntime.test.ts` plus focused backend/runtime/render tests.
- Modify affected E2E assertions, including New City assertions that currently inspect live `schemaVersion`, `scenario`, `sims`, or `activeTrips`.

### Cleanup/docs

- Delete: `src/runtime/snapshotView.ts`.
- Delete: `src/domain/platformOccupancy.ts`.
- Delete: `src/domain/traffic.ts`.
- Delete obsolete citizen/lateness/growth tests.
- Modify: `docs/architecture.md`.
- Modify: `CLAUDE.md`.

---

## Task 0: Record the Existing Full-Snapshot Cost

**Interfaces:**
- Produces deterministic fixture constructors reused in Task 4.
- Produces pre-cutover serialized-byte and native-serde timing rows.
- Changes no gameplay/library API.

- [ ] **Step 1: Create the native baseline example**

Create `crates/caelum-core/examples/presentation_scale.rs`:

```rust
use std::time::Instant;

use caelum_core::model::{
    ActiveTrip, GameSnapshot, PlacedBuilding, Point, Sim, TripPosition, TripPurpose, TripStatus,
    WorkerProfile,
};
use caelum_core::GameEngine;

fn sim(index: usize) -> Sim {
    let home = Point {
        x: (index % 28) as i32,
        y: ((index / 28) % 18) as i32,
    };
    Sim {
        id: format!("sim-{index:06}"),
        home,
        position: home,
        worker_profile: WorkerProfile::Worker,
        shift_template: Some("standard".to_string()),
        workplace: Some(Point { x: 14, y: 9 }),
        commute_day: 0,
        outbound_resolved_today: false,
        outbound_arrived_today: false,
        return_resolved_today: false,
        returned_home_today: false,
    }
}

fn active_trip(index: usize, destination_count: usize) -> ActiveTrip {
    assert!((1..=504).contains(&destination_count));
    let destination_index = index % destination_count;
    let destination = Point {
        x: (destination_index % 28) as i32,
        y: (destination_index / 28) as i32,
    };
    ActiveTrip {
        id: format!("trip-{index:06}"),
        sim_id: format!("sim-{index:06}"),
        purpose: TripPurpose::CommuteOutbound,
        origin: Point { x: 1, y: 1 },
        destination,
        position: TripPosition::from(Point { x: 1, y: 1 }),
        status: TripStatus::Walking,
        deadline: 900.0,
        route_plan: None,
        current_leg_index: 0,
        patience_remaining: 240.0,
        current_leg_wait_seconds: 0.0,
        private_car_trip: None,
    }
}

fn occupancy_building(index: usize) -> PlacedBuilding {
    let point = Point {
        x: (index % 28) as i32,
        y: ((index / 28) % 18) as i32,
    };
    PlacedBuilding {
        id: format!("building-{index:06}"),
        building_type: "smallHouse".to_string(),
        origin: point,
        rotation: 0,
        occupied_tiles: vec![point],
        placed_at: 0.0,
        transit_node_id: None,
    }
}

fn measure_snapshot(label: &str, snapshot: &GameSnapshot) {
    let started = Instant::now();
    let bytes = serde_json::to_vec(snapshot).expect("snapshot serialization");
    let micros = started.elapsed().as_micros();
    println!(
        "{label}\tsims={}\ttrips={}\tbuildings={}\tvehicles={}\tbytes={}\tserialize_us={micros}",
        snapshot.sims.len(),
        snapshot.active_trips.len(),
        snapshot.buildings.len(),
        snapshot.transit.vehicles.len(),
        bytes.len(),
    );
}

fn main() {
    let baseline = GameEngine::new().snapshot();
    measure_snapshot("current", &baseline);

    for count in [10_000, 50_000, 200_000] {
        let mut fixture = baseline.clone();
        fixture.sims = (0..count).map(sim).collect();
        measure_snapshot(&format!("sims-{count}"), &fixture);
    }

    for count in [1_000, 5_000, 20_000] {
        let mut fixture = baseline.clone();
        fixture.active_trips = (0..count).map(|index| active_trip(index, 504)).collect();
        measure_snapshot(&format!("trips-{count}"), &fixture);
    }

    for count in [1_000, 5_000, 20_000] {
        let mut fixture = baseline.clone();
        fixture.buildings = (0..count).map(occupancy_building).collect();
        measure_snapshot(&format!("buildings-{count}"), &fixture);
    }
}
```

Do not derive fixtures from `smallTown.sims`; Small Town starts with zero sims.

- [ ] **Step 2: Run the baseline and capture the reference environment**

Run exactly:

```bash
cargo run --release -p caelum-core --example presentation_scale
uname -a
if command -v sysctl >/dev/null 2>&1; then
  sysctl -n machdep.cpu.brand_string 2>/dev/null || true
fi
if command -v lscpu >/dev/null 2>&1; then
  lscpu | sed -n 's/^Model name:[[:space:]]*//p'
fi
rustc --version
```

Keep the command output; Task 4 must run on the same reference machine.

- [ ] **Step 3: Create the baseline document from command output**

Create `docs/performance/hpa-544-presentation-baseline.md` with these literal headings:

```markdown
# HPA-544 Presentation Baseline

## Command

`cargo run --release -p caelum-core --example presentation_scale`

## Reference environment

### OS

### CPU

### Rust

### Build

`--release`

## Before presentation cutover

| Fixture | Sims | Active trips | Buildings | Vehicles | Snapshot bytes | Serialize µs |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
```

Paste the OS/CPU/Rust command outputs verbatim under their headings and append one table row for every example measurement. Do not commit this document until every environment heading and table row contains measured data.

- [ ] **Step 4: Verify the baseline task**

```bash
rg "Instant|SystemTime" crates/caelum-core/src
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all --check
```

Expected: no timing API under `crates/caelum-core/src`; all gates GREEN.

- [ ] **Step 5: Commit**

```bash
git add crates/caelum-core/examples/presentation_scale.rs docs/performance/hpa-544-presentation-baseline.md
git commit -m "test: baseline presentation boundary cost"
```

---

## Task 1: Build Rust Presentation by Reusing Existing Domain Rules

**Interfaces:**
- Produces public serde types: `PresentationScene`, `PresentationFrame`, `PresentationUpdate`, `PresentationMetrics`, occupancy/traffic/demand/vehicle/service rows, focused route/metro presentation rows.
- Produces public pure `presentation::project_update(&GameSnapshot, bool) -> PresentationUpdate` for the native harness and HPA-347.
- Adds crate-private `population::job_occupancy`, `platforms::platform_waiting_occupancy`, and `service_control::service_metrics_by_line`.

- [ ] **Step 1: Add the missing job-occupancy helper**

In `population.rs`:

```rust
pub(crate) fn job_occupancy(state: &GameSnapshot, building: &PlacedBuilding) -> usize {
    state
        .sims
        .iter()
        .filter(|sim| {
            sim.workplace
                .is_some_and(|workplace| building.occupied_tiles.contains(&workplace))
        })
        .count()
}
```

Add a unit test with explicit `Sim` records: one workplace inside the building footprint, one outside, and one `None`; assert occupancy `1`. Residential projection must call existing `resident_occupancy` instead of copying its loop.

- [ ] **Step 2: Add all-waiter platform occupancy inside `platforms.rs`**

Reuse existing private `platform_capacities` and `platform_waiter_candidates`:

```rust
pub(crate) fn platform_waiting_occupancy(
    state: &GameSnapshot,
) -> std::collections::BTreeMap<String, (u32, u16)> {
    let mut result = platform_capacities(state)
        .into_iter()
        .map(|(platform_id, capacity)| (platform_id, (0, capacity)))
        .collect::<std::collections::BTreeMap<_, _>>();

    for (_, _, platform_id) in platform_waiter_candidates(state) {
        if let Some((count, _)) = result.get_mut(&platform_id) {
            *count = count.saturating_add(1);
        }
    }
    result
}
```

Extend the existing `platforms.rs` test module:

```rust
#[test]
fn waiting_occupancy_counts_overflow_beyond_boarding_capacity() {
    let point = Point::from((5, 5));
    let mut snapshot = create_initial_snapshot();
    snapshot.transit.stops.push(Stop {
        id: "stop-001".to_string(),
        kind: BusStopKind::BusStop,
        status: TransitNodeStatus::Present,
        position: point,
        platforms: vec![Platform {
            id: "stop-001-p0".to_string(),
            label: "A".to_string(),
            capacity: 1,
            route_ids: vec!["route-001".to_string()],
        }],
        road_access: None,
    });
    snapshot.active_trips = vec![
        waiting_trip_for_line("trip-a", point, "route-001", 10.0),
        waiting_trip_for_line("trip-b", point, "route-001", 20.0),
    ];

    assert_eq!(
        platform_waiting_occupancy(&snapshot).get("stop-001-p0"),
        Some(&(2, 1)),
    );
    assert_eq!(on_platform_trip_ids(&snapshot).len(), 1);
}
```

Existing platform tests continue pinning waiting/current-leg/position/route matching; this new regression only pins the intentional overflow difference.

- [ ] **Step 3: Extract one shared service-metrics derivation**

Refactor `populate_snapshot_metrics` to call:

```rust
pub(crate) fn service_metrics_by_line(
    snapshot: &GameSnapshot,
) -> std::collections::BTreeMap<String, ServiceMetrics> {
    let flow = crate::traffic::derive_road_flow(snapshot);
    let waiting_health = waiting_health_by_line(snapshot);
    let mut result = std::collections::BTreeMap::new();

    for route in &snapshot.transit.routes {
        let health = waiting_health.get(&route.id).copied().unwrap_or_default();
        if let Some(value) = metrics(
            route.active,
            snapshot.paused,
            &route.legs,
            TransitMode::Bus,
            &flow,
            route.vehicle_ids.len(),
            route.target_headway_seconds,
            health,
        ) {
            result.insert(route.id.clone(), value);
        }
    }

    for line in &snapshot.transit.metro_lines {
        let health = waiting_health.get(&line.id).copied().unwrap_or_default();
        if let Some(value) = metrics(
            line.active,
            snapshot.paused,
            &line.legs,
            TransitMode::Metro,
            &flow,
            line.vehicle_ids.len(),
            line.target_headway_seconds,
            health,
        ) {
            result.insert(line.id.clone(), value);
        }
    }

    result
}
```

`populate_snapshot_metrics` writes `Some(metric.clone())` for IDs present in the map and `None` otherwise. Preserve all existing formulas and `None` semantics.

- [ ] **Step 4: Define exact presentation types**

In `presentation.rs`, reuse `GameRules`, `GameMap`, `PlacedBuilding`, `Stop`, and `Station` directly in `PresentationScene`. Define focused route/metro presentation rows excluding `service_metrics` but retaining `vehicle_ids`.

Define frame rows:

```rust
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresentationMetrics {
    pub late_trips: u32,
    pub unserved_trips: u32,
    pub average_wait_seconds: f64,
    pub state: MetricsState,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildingOccupancyPresentation {
    pub building_id: String,
    pub occupancy: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformOccupancyPresentation {
    pub platform_id: String,
    pub count: u32,
    pub capacity: u16,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrafficFlowPresentation {
    pub point: Point,
    pub flow: u16,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DemandFlowPresentation {
    pub point: Point,
    pub count: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VehiclePresentation {
    pub id: String,
    pub mode: TransitMode,
    pub line_id: String,
    pub itinerary_index: usize,
    pub path_step_index: usize,
    pub step_progress: f64,
    pub parked_position: Option<TripPosition>,
}
```

`PresentationFrame` contains time/day/clock/speed/paused/budget, `PresentationMetrics`, `population_count`, deterministic vectors for the rows above, and stable line-service rows. Do not define a trip-marker or scenario presentation type.

- [ ] **Step 5: Implement pure projection by composition**

Building occupancy:

```rust
let occupancy = if definition.resident_capacity > 0 {
    population::resident_occupancy(snapshot, building)
} else if definition.job_capacity > 0 {
    population::job_occupancy(snapshot, building)
} else {
    continue;
};
```

Platform rows map `platforms::platform_waiting_occupancy` directly.

Traffic rows start from `traffic::derive_road_flow(snapshot)`, keep only entries whose matching map tile has `tile.kind == "road"`, and sort by `(point.y, point.x)`.

Demand aggregation:

```rust
let mut demand = std::collections::BTreeMap::<(i32, i32), u32>::new();
for trip in &snapshot.active_trips {
    let count = demand.entry((trip.destination.y, trip.destination.x)).or_default();
    *count = count.saturating_add(1);
}
let demand_flow = demand
    .into_iter()
    .map(|((y, x), count)| DemandFlowPresentation {
        point: Point { x, y },
        count,
    })
    .collect::<Vec<_>>();
```

Vehicles copy only cursor fields. Service rows map `service_metrics_by_line`.

Expose:

```rust
pub fn project_update(snapshot: &GameSnapshot, include_scene: bool) -> PresentationUpdate;
```

Production hosts still call `GameEngine`; this pure function exists for measurement and the future HPA-347 storage migration.

- [ ] **Step 6: Add focused projection tests**

Pin:

```text
resident projection matches resident_occupancy
job occupancy counts workplace membership
building catalog has no mixed resident+job capacity definition
platform crowding includes overflow while boarding admission truncates
traffic filters non-road rows and sorts y/x
demand aggregates duplicate destinations and sorts y/x
presentation JSON contains no sims/activeTrips/routePlan/privateCarTrip/passengerIds
vehicle cursor fields survive
service metrics match GameEngine::snapshot() output for the same state
```

Add a scale property with a fixture containing no buildings, trips, or transit entities:

```rust
#[test]
fn frame_has_no_row_per_latent_sim_growth() {
    let small = fixture_with_sims(0);
    let large = fixture_with_sims(200_000);

    let small_frame = project_update(&small, false).frame;
    let large_frame = project_update(&large, false).frame;

    assert!(small_frame.building_occupancy.is_empty());
    assert!(large_frame.building_occupancy.is_empty());
    assert_eq!(small_frame.demand_flow.len(), large_frame.demand_flow.len());

    let small_bytes = serde_json::to_vec(&small_frame).unwrap().len();
    let large_bytes = serde_json::to_vec(&large_frame).unwrap().len();
    assert!(large_bytes.saturating_sub(small_bytes) < 64);
}
```

Define `fixture_with_sims` inside the same test module:

```rust
fn fixture_with_sims(count: usize) -> GameSnapshot {
    let mut snapshot = crate::state::create_initial_snapshot();
    snapshot.buildings.clear();
    snapshot.active_trips.clear();
    snapshot.transit.stops.clear();
    snapshot.transit.stations.clear();
    snapshot.transit.routes.clear();
    snapshot.transit.metro_lines.clear();
    snapshot.transit.vehicles.clear();
    snapshot.sims = (0..count).map(sim_fixture).collect();
    snapshot
}

fn sim_fixture(index: usize) -> Sim {
    let home = Point { x: 1, y: 1 };
    Sim {
        id: format!("sim-{index:06}"),
        home,
        position: home,
        worker_profile: WorkerProfile::Worker,
        shift_template: Some("standard".to_string()),
        workplace: None,
        commute_day: 0,
        outbound_resolved_today: false,
        outbound_arrived_today: false,
        return_resolved_today: false,
        returned_home_today: false,
    }
}
```

The `< 64` byte bound permits aggregate numeric digit-width changes while rejecting row-per-sim serialization.

- [ ] **Step 7: Run and commit**

```bash
cargo test -p caelum-core presentation
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all --check
```

Expected: GREEN; public host wire still unchanged.

```bash
git add crates/caelum-core/src/presentation.rs crates/caelum-core/src/population.rs crates/caelum-core/src/platforms.rs crates/caelum-core/src/service_control.rs crates/caelum-core/src/lib.rs
git commit -m "feat: add scalable presentation projection"
```

---

## Task 2: Cut Core, Hosts, Persistence Runtime, and Flat Frontend View to Presentation Atomically

**Interfaces:**
- Produces `GameplayUpdateResult { update, applied, rejection }`.
- Produces `GameEngine::presentation() -> PresentationUpdate`.
- Tick results are frame-only.
- Applied dispatches include scene; rejected/no-op dispatches are frame-only.
- Successful reset/restore/current presentation include scene.
- Frontend produces `applyPresentationUpdate(current: GameState | null, update: PresentationUpdate) -> GameState`.
- `GameBackend.presentation()` replaces `snapshot()`.
- `WorkingSaveRuntimeHost.installRestoredGameplay` consumes a full `PresentationUpdate`.

- [ ] **Step 1: Add RED public core contract tests**

Create `crates/caelum-core/tests/presentation_contract.rs`:

```rust
use caelum_core::model::Point;
use caelum_core::{GameEngine, GameIntent, RejectionCode};

fn point(x: i32, y: i32) -> Point {
    Point { x, y }
}

#[test]
fn current_presentation_contains_scene() {
    assert!(GameEngine::new().presentation().scene.is_some());
}

#[test]
fn tick_is_frame_only() {
    let mut engine = GameEngine::new();
    let _ = engine.dispatch(GameIntent::SetPaused { paused: false });
    assert!(engine.tick(0.1).update.scene.is_none());
}

#[test]
fn applied_dispatch_includes_scene() {
    let mut engine = GameEngine::new();
    let result = engine.dispatch(GameIntent::SetPaused { paused: false });
    assert!(result.applied);
    assert!(result.update.scene.is_some());
}

#[test]
fn rejected_dispatch_is_frame_only() {
    let mut engine = GameEngine::new();
    assert!(engine.dispatch(GameIntent::LayRoad { point: point(4, 5) }).applied);
    assert!(engine.dispatch(GameIntent::LayRoad { point: point(5, 5) }).applied);

    let result = engine.dispatch(GameIntent::AddBusStop { point: point(4, 5) });

    assert!(!result.applied);
    assert_eq!(
        result.rejection.as_ref().map(|rejection| &rejection.code),
        Some(&RejectionCode::BlockedTile),
    );
    assert!(result.update.scene.is_none());
}
```

- [ ] **Step 2: Replace snapshot-carrying `DispatchResult` at the engine facade**

In `intent.rs`:

```rust
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameplayUpdateResult {
    pub update: PresentationUpdate,
    pub applied: bool,
    pub rejection: Option<GameplayRejection>,
}
```

Lower-level road/transit mutation structs remain domain structs. `GameEngine` converts them to presentation results after commit/rejection.

Mechanically retarget existing engine-facing tests like this:

```rust
let mut engine = GameEngine::new();
let result = engine.dispatch(GameIntent::SetPaused { paused: false });
assert!(result.applied);
assert!(!engine.snapshot().paused);
```

Do not keep `result.snapshot` for compatibility.

- [ ] **Step 3: Implement scene emission policy**

```rust
pub fn presentation(&self) -> PresentationUpdate {
    presentation::project_update(&self.snapshot(), true)
}
```

Policy:

```text
tick -> include_scene = false
applied dispatch -> true
rejected/no-op dispatch -> false
successful reset/restore -> full presentation
```

Do not add `scene_changed`, a scene revision, or a cached projected scene.

- [ ] **Step 4: Cut WASM and Tauri ordinary outputs**

Ordinary current view, tick, dispatch, reset, and restore success serialize presentation types. Durable operations stay snapshot-based:

```text
snapshotForSave -> RustGameSnapshot
buildSandboxSnapshot -> RustGameSnapshot
restore input -> RustGameSnapshot
```

Keep Tauri runtime-epoch behavior unchanged.

- [ ] **Step 5: Define TypeScript wire types and the nine-method backend**

In `src/runtime/backend/types.ts`, add raw presentation types matching Rust camelCase and change the backend interface to:

```ts
export interface GameBackend {
  presentation(): Promise<PresentationUpdate>;
  snapshotForSave(): Promise<SnapshotResult>;
  buildSandboxSnapshot(request: SandboxCreationRequest): Promise<SandboxCreationResult>;
  restoreSnapshot(snapshot: unknown): Promise<RestoreResult>;
  dispatch(intent: GameIntent): Promise<GameplayUpdateResult>;
  tick(deltaSeconds: number): Promise<GameplayUpdateResult>;
  reset(): Promise<SandboxResetPresentationResult>;
  previewRoute(request: RoutePreviewRequest): Promise<RoutePreviewResponse>;
  previewRoadMutation(request: RoadMutationPreviewRequest): Promise<RoadMutationPreviewResponse>;
}
```

Define:

```ts
export type RestoreResult =
  | { ok: true; update: PresentationUpdate }
  | { ok: false; error: SnapshotError };

export type SandboxResetPresentationResult =
  | { ok: true; update: PresentationUpdate }
  | { ok: false; error: SandboxResetError };
```

Do not leave a `snapshot()` alias. Presentation is unversioned; Rust persistence remains authoritative for restore validation.

- [ ] **Step 6: Split persistence success types without adding a second schema validator**

Keep `runSnapshotOperation` for `snapshotForSave`: it still validates a returned durable `RustGameSnapshot` and schema version.

Change the restore helper so its only model-level responsibility is mapping structured definitive Rust rejection versus ambiguous host failure. Its success value is the presentation update returned by the host; it does not compare a presentation `schemaVersion` because presentation has none.

In `workingSaveRuntime.ts`, change:

```ts
export interface WorkingSaveRuntimeHost {
  backend: GameBackend;
  saveStore?: CitySaveStore;
  initialCity: CitySummary | null;
  now: () => string;
  createCityId: () => string;
  awaitGameplayIdle: () => Promise<void>;
  installRestoredGameplay: (update: PresentationUpdate) => void;
  publish: () => void;
  isRuntimeDead: () => boolean;
}
```

Change `restoreAndInstall` to:

```ts
const restoreAndInstall = async (
  snapshot: unknown,
): Promise<WorkingSaveResult<void>> => {
  if (!isLive()) {
    return { ok: false, error: { kind: "unavailable" } };
  }

  let restored: Awaited<ReturnType<GameBackend["restoreSnapshot"]>>;
  try {
    restored = await host.backend.restoreSnapshot(snapshot);
  } catch (thrown: unknown) {
    if (isLive()) {
      activeCity = null;
      dirty = false;
    }
    return { ok: false, error: backendHostFailure(thrown) };
  }

  if (!restored.ok) {
    return { ok: false, error: { kind: "backend", error: restored.error } };
  }
  if (!isLive()) {
    return { ok: false, error: { kind: "unavailable" } };
  }

  try {
    host.installRestoredGameplay(restored.update);
  } catch (thrown: unknown) {
    if (isLive()) {
      activeCity = null;
      dirty = false;
    }
    return { ok: false, error: backendHostFailure(thrown) };
  }

  return { ok: true, value: undefined };
};
```

`load` and `createCity` already use this result only as a success/error gate, so their city-return behavior remains unchanged.

Update `tests/runtime/workingSaveRuntime.test.ts` mocks so successful restore returns `{ ok: true, update }` and installation receives that update.

- [ ] **Step 7: Keep live `GameState` flat and unversioned**

In `src/domain/types.ts`, remove from ordinary live `GameState`:

```text
schemaVersion
scenario
sims
activeTrips
tripSequenceDay
nextTripSequence
vehicle passengerIds/capacity
waitingCitizenCount/waitingTripCount/totalWaitSeconds/tripOutcomes/lossReason
```

Remove `"lateness"` and `"growth"` from `Overlay`.

Add:

```ts
export interface PresentationMetrics {
  lateTrips: number;
  unservedTrips: number;
  averageWaitSeconds: number;
  state: "running" | "won" | "lost";
}

export interface BuildingOccupancyView {
  buildingId: string;
  occupancy: number;
}

export interface PlatformOccupancyView {
  platformId: string;
  count: number;
  capacity: number;
}

export interface TrafficFlowView {
  point: Point;
  flow: number;
}

export interface DemandFlowView {
  point: Point;
  count: number;
}
```

`GameState` retains rules/map/buildings/transit/time/day/clock/speed/paused/budget and adds `populationCount`, `buildingOccupancy`, `platformOccupancy`, `trafficFlow`, and `demandFlow`.

Keep `SNAPSHOT_SCHEMA_VERSION` and raw snapshot interfaces for persistence; only remove schema version from the live presentation view.

- [ ] **Step 8: Add the sole scene/frame reducer with correct frame-only fallback**

Create `src/runtime/presentationView.ts`:

```ts
export function applyPresentationUpdate(
  current: GameState | null,
  update: PresentationUpdate,
): GameState {
  if (current === null && update.scene === null) {
    throw new Error("initial presentation update must include scene");
  }

  const scene = update.scene;
  const rules = scene?.rules ?? current!.rules;
  const map = scene?.map ?? current!.map;
  const buildings = scene?.buildings ?? current!.buildings;
  const stops = scene?.stops ?? current!.transit.stops;
  const stations = scene?.stations ?? current!.transit.stations;
  const baseRoutes = scene?.routes ?? current!.transit.routes;
  const baseMetroLines = scene?.metroLines ?? current!.transit.metroLines;

  const metricsByLine = new Map(
    update.frame.serviceMetrics.map((row) => [row.lineId, row.metrics]),
  );

  const routes = baseRoutes.map((route) => ({
    ...route,
    serviceMetrics: metricsByLine.get(route.id) ?? null,
  }));
  const metroLines = baseMetroLines.map((line) => ({
    ...line,
    serviceMetrics: metricsByLine.get(line.id) ?? null,
  }));

  return {
    rules,
    map,
    buildings,
    transit: {
      stops,
      stations,
      routes,
      metroLines,
      vehicles: update.frame.vehicles,
    },
    time: update.frame.time,
    day: update.frame.day,
    clockMinutes: update.frame.clockMinutes,
    speed: update.frame.speed,
    paused: update.frame.paused,
    budget: update.frame.budget,
    metrics: update.frame.metrics,
    populationCount: update.frame.populationCount,
    buildingOccupancy: update.frame.buildingOccupancy,
    platformOccupancy: update.frame.platformOccupancy,
    trafficFlow: update.frame.trafficFlow,
    demandFlow: update.frame.demandFlow,
  };
}
```

The scene route/metro wire types do not carry `serviceMetrics`; the live route/metro types do. Structural fallback therefore reads current live route rows, and the map spread replaces their service metric with the newest frame value.

Move `isPresentTransitNode` and any other still-used small view helper from `snapshotView.ts` into this file.

- [ ] **Step 9: Cut `createGameRuntime` and restore installation without cadence changes**

Initialization:

```ts
let state = applyPresentationUpdate(null, await backend.presentation());
```

Gameplay dispatch commit:

```ts
if (result.applied) workingSave.markDirty();
return commit(applyPresentationUpdate(state, result.update), nextUi);
```

Preserve existing no-op tick behavior:

```ts
const enqueueTick = (deltaSeconds: number): Promise<RuntimeSnapshot> =>
  queueBackend(async () => {
    const result = await backend.tick(deltaSeconds);
    backendError = null;
    if (!result.applied) {
      return commit(state, ui);
    }
    return commit(applyPresentationUpdate(state, result.update), ui);
  });
```

Change restored gameplay installation to consume a full presentation update:

```ts
const installRestoredGameplay = (update: PresentationUpdate): void => {
  clearHoverPreviewTimer();
  previewRuntimeEpoch += 1;
  previewCoordinator.invalidateRoute();
  previewCoordinator.invalidateRoadMutation();
  invalidateRoadPreview();
  activeRouteSaveTokens.clear();
  nextRouteDraftInstanceId = 1;
  state = applyPresentationUpdate(null, update);
  ui = createUiState();
  backendError = null;
  rejection = null;
  sandboxResetError = null;
  activeRoadMutation = null;
};
```

Preserve every other existing lifecycle side effect from the current helper if its exact current body contains additional cleanup when implementation starts; the state-conversion change is specifically `normalizeRustSnapshot(rawSnapshot)` -> `applyPresentationUpdate(null, update)`.

Keep `createSerializedQueue`, Canvas `onTick`, rAF delta clamping, pause/speed handling, persistence-busy behavior, and fatal-backend lifecycle unchanged.

- [ ] **Step 10: Change only high-cardinality/dead presentation consumers**

`runtimeSelectors.ts`:

```text
topbar/city population -> state.populationCount
building inspector -> lookup state.buildingOccupancy by building ID
platform inspector/crowding -> state.platformOccupancy
remove growth/lateness overlay labels
```

`overlayRenderer.ts`:

```text
traffic -> state.trafficFlow
crowding -> state.platformOccupancy
demand -> state.demandFlow
delete lateness branch
delete growth branch
```

Preserve repeated demand opacity:

```ts
function demandAlpha(count: number): number {
  return 1 - Math.pow(1 - 0.24, count);
}
```

Render each demand destination once using this alpha.

`canvas.ts`: remove `renderCitizens` import/call and delete `citizenRenderer.ts`.

`transitRenderer.ts`: preserve current route geometry/cursor logic; adjust only the vehicle type if required.

`mapRenderer`, `buildingRenderer`, `cursorBadge`, `placementValidation`, `routeDraft`, `actions`, `Topbar`, and `createCanvasHost` should not need logic changes because the live state remains flat.

- [ ] **Step 11: Retarget the existing shared test helper**

Edit `tests/helpers/gameState.ts`:

- remove its `normalizeRustSnapshot` import;
- preserve its existing exported helper API used by current tests;
- initialize new presentation fields directly in its base state;
- keep `tests/fixtures/rustSnapshot.ts` only for raw persistence/backend snapshot tests.

Do not add a parallel presentation fixture tree.

- [ ] **Step 12: Update E2E/runtime assertions to shipped presentation facts**

Replace assertions on removed live internals:

```text
snapshot.state.schemaVersion
snapshot.state.scenario
snapshot.state.sims
snapshot.state.activeTrips
```

For the New City save assertion that currently compares `stored.snapshot.schemaVersion` with `after.state.schemaVersion`, compare the durable stored snapshot against imported `SNAPSHOT_SCHEMA_VERSION` (or the raw saved snapshot contract already available in that test) instead. Do not re-add schema version to presentation.

For Small Town, assert sandbox template ID, building count, `populationCount`, routes, and visible UI state instead of scenario/sim/trip internals.

- [ ] **Step 13: Run the full cutover gate before commit**

```bash
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all --check
bun run wasm:build
bun run check
bun run test:unit
bun run test:e2e
```

Expected: all GREEN before committing the public wire change.

- [ ] **Step 14: Commit**

```bash
git add crates/caelum-core crates/caelum-wasm src-tauri src tests
git commit -m "refactor: cut gameplay to compact presentation wire"
```

---

## Task 3: Delete Superseded Snapshot/Selector Paths

**Interfaces:**
- Leaves `presentationView.ts` as the only ordinary Rust-wire-to-live-view reducer.
- Leaves Rust population/platform/traffic/service modules as domain sources of truth.

- [ ] **Step 1: Inventory source and tests before deleting**

```bash
rg "normalizeRustSnapshot|snapshotView|selectPlatformOccupancy|selectTrafficFlow" src tests
```

Every match must either be in a file scheduled for deletion or be retargeted first.

- [ ] **Step 2: Delete superseded modules/tests**

Delete:

```text
src/runtime/snapshotView.ts
src/domain/platformOccupancy.ts
src/domain/traffic.ts
tests/runtime/snapshotView.test.ts
tests/runtime/platformOccupancy.test.ts
tests/runtime/traffic.test.ts
obsolete citizen/lateness/growth renderer tests
```

Only delete a listed test after its product behavior is covered by Task 1 Rust tests or Task 2 presentation-consumer tests.

- [ ] **Step 3: Prove raw high-cardinality state is absent from the live frontend path**

```bash
rg "activeTrips|\.sims\b|\bActiveTrip\b|\bSim\b|routePlan|privateCarTrip|passengerIds" src tests
```

Expected production result: no live runtime/render/UI usage. Explicit Rust-prefixed raw snapshot/backend types and save-format fixtures may remain under backend/persistence tests where complete durable state is intentionally exercised.

Also run:

```bash
rg '"lateness"|"growth"|renderCitizens|citizenRenderer' src tests
```

Expected: no shipped frontend usage. Rust core growth code is intentionally outside this guard.

- [ ] **Step 4: Verify**

```bash
bun run check
bun run test:unit
bun run test:e2e
```

Expected: GREEN.

- [ ] **Step 5: Commit**

```bash
git add -A src tests
git commit -m "refactor: remove snapshot-derived frontend state"
```

---

## Task 4: Re-measure the New Boundary and Lock Structural Scale Properties

**Interfaces:**
- Reuses Task 0 fixture constructors and reference machine.
- Measures pure `presentation::project_update` directly against synthetic snapshots.
- Adds no timing threshold to CI.

- [ ] **Step 1: Extend the example with presentation measurement**

Add:

```rust
use caelum_core::presentation::project_update;

fn measure_presentation(label: &str, snapshot: &GameSnapshot) {
    let started = Instant::now();
    let update = project_update(snapshot, true);
    let projection_us = started.elapsed().as_micros();

    let started = Instant::now();
    let update_bytes = serde_json::to_vec(&update).expect("presentation serialization");
    let serialize_us = started.elapsed().as_micros();
    let frame_bytes = serde_json::to_vec(&update.frame)
        .expect("frame serialization")
        .len();

    println!(
        "{label}\tpresentation_bytes={}\tframe_bytes={}\tprojection_us={}\tpresentation_serialize_us={}",
        update_bytes.len(),
        frame_bytes,
        projection_us,
        serialize_us,
    );
}
```

Call `measure_presentation` for every Task 0 fixture immediately after `measure_snapshot`.

- [ ] **Step 2: Add explicit 1k/5k vehicle fixtures**

Add:

```rust
use caelum_core::model::{TransitMode, Vehicle};

fn vehicle(index: usize) -> Vehicle {
    Vehicle {
        id: format!("vehicle-{index:06}"),
        mode: TransitMode::Bus,
        line_id: "route-scale".to_string(),
        capacity: 30,
        passenger_ids: Vec::new(),
        itinerary_index: 0,
        path_step_index: 0,
        step_progress: (index % 100) as f64 / 100.0,
        parked_position: Some(TripPosition::from(Point {
            x: (index % 28) as i32,
            y: ((index / 28) % 18) as i32,
        })),
    }
}
```

Extend `main`:

```rust
for count in [1_000, 5_000] {
    let mut fixture = baseline.clone();
    fixture.transit.vehicles = (0..count).map(vehicle).collect();
    measure_snapshot(&format!("vehicles-{count}"), &fixture);
    measure_presentation(&format!("vehicles-{count}"), &fixture);
}
```

These are projection/serialization fixtures; they are not passed through restore validation.

- [ ] **Step 3: Add clock-free scale tests with fully defined fixtures**

Create `crates/caelum-core/tests/presentation_scale.rs`:

```rust
use caelum_core::model::{
    ActiveTrip, GameSnapshot, PlacedBuilding, Point, Sim, TransitMode, TripPosition, TripPurpose,
    TripStatus, Vehicle, WorkerProfile,
};
use caelum_core::presentation::project_update;
use caelum_core::state::create_initial_snapshot;

fn sim(index: usize) -> Sim {
    let home = Point { x: 1, y: 1 };
    Sim {
        id: format!("sim-{index:06}"),
        home,
        position: home,
        worker_profile: WorkerProfile::Worker,
        shift_template: Some("standard".to_string()),
        workplace: None,
        commute_day: 0,
        outbound_resolved_today: false,
        outbound_arrived_today: false,
        return_resolved_today: false,
        returned_home_today: false,
    }
}

fn fixture_with_sims(count: usize) -> GameSnapshot {
    let mut snapshot = create_initial_snapshot();
    snapshot.buildings.clear();
    snapshot.active_trips.clear();
    snapshot.transit.stops.clear();
    snapshot.transit.stations.clear();
    snapshot.transit.routes.clear();
    snapshot.transit.metro_lines.clear();
    snapshot.transit.vehicles.clear();
    snapshot.sims = (0..count).map(sim).collect();
    snapshot
}

fn trip(index: usize, destination_count: usize) -> ActiveTrip {
    assert!((1..=504).contains(&destination_count));
    let destination_index = index % destination_count;
    ActiveTrip {
        id: format!("trip-{index:06}"),
        sim_id: format!("sim-{index:06}"),
        purpose: TripPurpose::CommuteOutbound,
        origin: Point { x: 1, y: 1 },
        destination: Point {
            x: (destination_index % 28) as i32,
            y: (destination_index / 28) as i32,
        },
        position: TripPosition::from(Point { x: 1, y: 1 }),
        status: TripStatus::Walking,
        deadline: 900.0,
        route_plan: None,
        current_leg_index: 0,
        patience_remaining: 240.0,
        current_leg_wait_seconds: 0.0,
        private_car_trip: None,
    }
}

fn fixture_with_active_trips(trip_count: usize, destination_count: usize) -> GameSnapshot {
    let mut snapshot = create_initial_snapshot();
    snapshot.active_trips = (0..trip_count)
        .map(|index| trip(index, destination_count))
        .collect();
    snapshot
}

fn building(index: usize) -> PlacedBuilding {
    let point = Point {
        x: (index % 28) as i32,
        y: ((index / 28) % 18) as i32,
    };
    PlacedBuilding {
        id: format!("building-{index:06}"),
        building_type: "smallHouse".to_string(),
        origin: point,
        rotation: 0,
        occupied_tiles: vec![point],
        placed_at: 0.0,
        transit_node_id: None,
    }
}

fn vehicle(index: usize) -> Vehicle {
    Vehicle {
        id: format!("vehicle-{index:06}"),
        mode: TransitMode::Bus,
        line_id: "route-scale".to_string(),
        capacity: 30,
        passenger_ids: Vec::new(),
        itinerary_index: 0,
        path_step_index: 0,
        step_progress: (index % 100) as f64 / 100.0,
        parked_position: Some(TripPosition::from(Point {
            x: (index % 28) as i32,
            y: ((index / 28) % 18) as i32,
        })),
    }
}
```

Add tests:

```rust
#[test]
fn latent_population_has_no_row_per_sim_payload_growth() {
    let small = fixture_with_sims(0);
    let large = fixture_with_sims(200_000);

    let small_frame = project_update(&small, false).frame;
    let large_frame = project_update(&large, false).frame;

    assert_eq!(small_frame.building_occupancy.len(), large_frame.building_occupancy.len());
    assert_eq!(small_frame.demand_flow.len(), large_frame.demand_flow.len());

    let small_bytes = serde_json::to_vec(&small_frame).unwrap().len();
    let large_bytes = serde_json::to_vec(&large_frame).unwrap().len();
    assert!(large_bytes.saturating_sub(small_bytes) < 64);
}

#[test]
fn demand_rows_follow_distinct_destinations_not_trip_count() {
    let one_destination = fixture_with_active_trips(20_000, 1);
    let map_destinations = fixture_with_active_trips(20_000, 504);

    assert_eq!(project_update(&one_destination, false).frame.demand_flow.len(), 1);
    assert_eq!(project_update(&map_destinations, false).frame.demand_flow.len(), 504);
}

#[test]
fn scale_fixtures_exercise_building_and_vehicle_terms() {
    for count in [1_000, 5_000, 20_000] {
        let mut snapshot = create_initial_snapshot();
        snapshot.sims.clear();
        snapshot.buildings = (0..count).map(building).collect();
        assert_eq!(snapshot.buildings.len(), count);
        assert_eq!(project_update(&snapshot, false).frame.building_occupancy.len(), count);
    }

    for count in [1_000, 5_000] {
        let mut snapshot = create_initial_snapshot();
        snapshot.transit.vehicles = (0..count).map(vehicle).collect();
        assert_eq!(snapshot.transit.vehicles.len(), count);
        assert_eq!(project_update(&snapshot, false).frame.vehicles.len(), count);
    }
}
```

Do not read wall clock in these tests.

- [ ] **Step 4: Append actual post-cutover measurements**

Add this literal header to `docs/performance/hpa-544-presentation-baseline.md`:

```markdown
## After presentation cutover

| Fixture | Snapshot bytes | Scene+frame bytes | Frame-only bytes | Presentation / snapshot | Projection µs | Presentation serialize µs |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
```

Populate it from Task 4 command output on the same reference machine used by Task 0.

Add:

```markdown
## Contract interpretation

- Latent sims no longer create one ordinary wire row per sim.
- Active-trip demand rows are bounded by distinct destination tiles rather than trip count.
- Building occupancy remains O(occupancy-capable buildings) and is measured at 1k/5k/20k.
- Transit vehicle presentation remains O(presented vehicles) and is measured at 1k/5k; HPA-640 owns viewport/LOD extraction and GPU batching.
- Wall-clock values are reference evidence, not CI thresholds.
```

Reference the measured ratios/byte counts in the prose immediately below these bullets.

- [ ] **Step 5: Update architecture guidance**

Update `docs/architecture.md` and `CLAUDE.md` to state:

```text
GameSnapshot = durable/core authority
PresentationUpdate = ordinary Rust host wire
GameState = flat TypeScript presentation view, not a save model
Rust owns occupancy/crowding/traffic/aggregate-demand/service projection
individual citizen rendering removed
lateness/growth shipped overlays removed
Canvas rAF remains tick owner until HPA-640
HPA-347 introduces load-bearing standalone Bevy ECS
Instant exists only in native example tooling
```

- [ ] **Step 6: Run final verification**

```bash
cargo run --release -p caelum-core --example presentation_scale
rg "Instant|SystemTime" crates/caelum-core/src
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all --check
bun run wasm:build:release
bun run check
bun run test:unit
bun run test:e2e
bun run build
```

Expected: the measurement command reproduces the checked-in rows; no timing API exists under deterministic library source; all product gates GREEN.

- [ ] **Step 7: Commit**

```bash
git add crates/caelum-core/examples/presentation_scale.rs crates/caelum-core/tests/presentation_scale.rs docs/performance/hpa-544-presentation-baseline.md docs/architecture.md CLAUDE.md
git commit -m "docs: record compact presentation scale boundary"
```

---

## Self-review Checklist

- [ ] Task 0 contains real measured pre-cutover numbers.
- [ ] Platform projection reuses existing platform matching and counts overflow separately from boarding capacity.
- [ ] Residential occupancy reuses `resident_occupancy`; only job occupancy is new.
- [ ] No per-active-trip presentation type/vector exists.
- [ ] Individual citizen dots and frontend lateness/growth overlays are gone.
- [ ] `PresentationScene` contains no scenario/campaign presentation.
- [ ] No scene comparator/cache exists; ticks are frame-only and applied dispatches may resend scene.
- [ ] TypeScript remains one flat `GameState`; low-cardinality renderer/tool modules avoid logic rewrites.
- [ ] `workingSaveRuntime` installs `PresentationUpdate`, not a restore-returned snapshot.
- [ ] No-op ticks preserve current `GameState` identity/publication behavior.
- [ ] Live `schemaVersion` is removed and E2E durable-schema assertions use the persistence constant/path.
- [ ] `tests/helpers/gameState.ts` is retargeted; no parallel fixture tree is created.
- [ ] Wire cutover gate includes `bun run test:e2e`.
- [ ] Cleanup guards cover `src` and `tests`.
- [ ] Post-cutover measurement uses the Task 0 matrix and same reference machine.
- [ ] HPA-347 still owns first Bevy ECS implementation; HPA-640 still owns cadence/interpolation/WebGPU.