# HPA-347 ECS Latent Population Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move latent citizen/activity scheduling into a load-bearing standalone Bevy ECS world so Caelum can hold and advance about 200,000 citizens without scanning or cloning every citizen on ordinary simulation substeps.

**Architecture:** `GameEngine` will own a `bevy_ecs::World` plus one explicitly ordered population `Schedule`. The live `GameSnapshot` becomes the non-population shell (`sims` intentionally empty); ECS wakes only time-bucketed citizens and emits deterministic `TripDemand` rows into the existing routing/active-trip pipeline. Full `Sim[]` is reconstructed only for durable snapshot/save operations, while HPA-544 presentation reads population counts/occupancy from runtime indexes.

**Tech Stack:** Rust 1.95+, `bevy_ecs` 0.19.1 (`default-features = false`, `std` only), serde/serde_json, existing Caelum router/transit/traffic modules, TypeScript/Bun persistence host tests.

**Spec:** `docs/superpowers/specs/2026-09-04-ecs-latent-population-design.md`

## Global Constraints

- One HPA-347 PR only. Keep implementation commits on this same draft PR.
- `bevy_ecs = { version = "0.19.1", default-features = false, features = ["std"] }`.
- Set `rust-version = "1.95"` in `caelum-core`, `caelum-wasm`, and `src-tauri`.
- Do not add full `bevy`, `bevy_app`, Bevy reflection/serialization, async executor, `multi_threaded`, or `rand`.
- ECS is the sole final live owner of latent citizens; never finish with a runtime `GameSnapshot.sims` mirror.
- Stable Caelum string IDs are durable. Bevy `Entity` is runtime-only and never serialized/presented.
- Keep route graphs, routing, active-trip movement, traffic aggregation, economy, catalogs, and HPA-544 presentation wire outside ECS.
- Route choice remains sequential in this ticket; HPA-348 owns batching.
- Final durable schema is v10. Reject v9 instead of implementing a compatibility migration.
- Deterministic ordering is scheduler bucket/exact time -> stable citizen ID -> explicit purpose rank.
- Schedule sets are explicitly ordered `CollectDue -> ApplyDue -> EmitTripDemand`.
- Wall-clock scale data is reference evidence only, never a CI threshold.
- Tasks 1-4 may use the current v9 `Sim` only as an implementation adapter while bringing ECS online. Task 5 removes that adapter and performs the final v10 break; this is not a supported compatibility path.

---

### Task 0: Record the pre-cutover population-tick baseline

**Files:**
- Modify: `crates/caelum-core/examples/presentation_scale.rs`
- Create: `docs/performance/hpa-347-ecs-population.md`

**Interfaces:**
- Consumes: current `GameSnapshot`, `RoadTopology`, `trips::tick_trips`, existing HPA-544 synthetic sim fixture.
- Produces: retained pre-cutover 10k/50k/200k quiet-tick evidence for Task 6 comparison.

- [ ] **Step 1: Add the baseline timing helper**

Add `RoadTopology` and `trips` imports and this helper:

```rust
fn measure_population_tick(label: &str, snapshot: &GameSnapshot, delta_seconds: f64) {
    let topology = RoadTopology::compile(&snapshot.map).expect("scale topology");
    let mut running = snapshot.clone();
    running.paused = false;
    running.speed = 1;

    let started = Instant::now();
    let advanced = trips::tick_trips(&running, &topology, delta_seconds);
    let tick_us = started.elapsed().as_micros();

    println!(
        "{label}\tpopulation_tick_us={tick_us}\tadvanced_time={}",
        advanced.time - running.time,
    );
}
```

Call it for the existing 10k, 50k, and 200k sim fixtures using a quiet delta that does not intentionally cross a commute departure.

- [ ] **Step 2: Capture the reference machine and before values**

Run:

```bash
uname -a
rustc --version
cargo run --release -p caelum-core --example presentation_scale
```

Create `docs/performance/hpa-347-ecs-population.md` containing the exact command outputs needed to identify OS/CPU/Rust and a table with one row for each `sims-10000`, `sims-50000`, and `sims-200000` `population_tick_us` value. End the section with: `Wall-clock values are reference evidence, not CI thresholds.`

Do not pre-seed the document with blank or synthetic measurements; copy the literal run output.

- [ ] **Step 3: Verify the baseline change is measurement-only**

Run:

```bash
cargo test -p caelum-core --lib
cargo run --release -p caelum-core --example presentation_scale
```

Expected: tests PASS and the existing snapshot/presentation rows remain, with the three new quiet-tick rows appended.

- [ ] **Step 4: Commit**

```bash
git add crates/caelum-core/examples/presentation_scale.rs docs/performance/hpa-347-ecs-population.md
git commit -m "perf: record HPA-347 population tick baseline"
```

---

### Task 1: Add standalone Bevy ECS and the indexed citizen world behind the current save adapter

**Files:**
- Modify: `crates/caelum-core/Cargo.toml`
- Modify: `crates/caelum-wasm/Cargo.toml`
- Modify: `src-tauri/Cargo.toml`
- Modify: `Cargo.lock`
- Move: `crates/caelum-core/src/population.rs` -> `crates/caelum-core/src/population/mod.rs`
- Create: `crates/caelum-core/src/population/components.rs`
- Create: `crates/caelum-core/src/population/schedule.rs`
- Modify: `crates/caelum-core/src/population/mod.rs`

**Interfaces:**
- Produces:
  - `pub(crate) fn build_world_v9(snapshot: &GameSnapshot) -> World`
  - `pub(crate) fn build_schedule() -> Schedule`
  - `pub(crate) fn snapshot_sims_v9(world: &World, day: u32) -> Vec<Sim>`
  - `pub(crate) fn population_count(world: &World) -> u32`
  - indexed resident/job occupancy helpers.
- Consumes: current v9 `Sim`, `PlacedBuilding`, `building_definition`, current commute ID/shift helpers.

- [ ] **Step 1: Add the dependency and synchronized MSRV**

In `crates/caelum-core/Cargo.toml` add:

```toml
bevy_ecs = { version = "0.19.1", default-features = false, features = ["std"] }
```

Set:

```toml
rust-version = "1.95"
```

in all three Rust package manifests. Run:

```bash
cargo check --workspace
```

Expected: lockfile adds `bevy_ecs` 0.19.1 and the workspace compiles on the current Rust >=1.95 toolchain.

- [ ] **Step 2: Write RED round-trip/index tests before implementation**

Move `population.rs` to `population/mod.rs` without changing its existing public API yet. Add tests that create a valid snapshot with two residents and one assigned worker, then require:

```rust
#[test]
fn ecs_world_round_trips_current_durable_sims_in_stable_id_order() {
    let snapshot = population_fixture();
    let world = build_world_v9(&snapshot);

    assert_eq!(population_count(&world), snapshot.sims.len() as u32);
    assert_eq!(snapshot_sims_v9(&world, snapshot.day), snapshot.sims);
}

#[test]
fn ecs_occupancy_comes_from_indexes() {
    let snapshot = population_fixture();
    let world = build_world_v9(&snapshot);

    assert_eq!(resident_occupancy_for_building(&world, "building-home"), 2);
    assert_eq!(job_occupancy_for_building(&world, "building-work"), 1);
}
```

Run:

```bash
cargo test -p caelum-core population::tests::ecs_world_round_trips_current_durable_sims_in_stable_id_order
cargo test -p caelum-core population::tests::ecs_occupancy_comes_from_indexes
```

Expected: FAIL because the ECS seams do not exist.

- [ ] **Step 3: Define only the needed components**

`components.rs` owns:

```rust
#[derive(Component, Clone, Debug, PartialEq, Eq)]
pub(super) struct CitizenId(pub(super) String);

#[derive(Component, Clone, Debug, PartialEq)]
pub(super) struct HomeAssignment {
    pub(super) building_id: String,
    pub(super) point: Point,
}

#[derive(Clone, Debug, PartialEq)]
pub(super) struct BuildingAssignment {
    pub(super) building_id: String,
    pub(super) point: Point,
}

#[derive(Component, Clone, Debug, PartialEq)]
pub(super) struct SettledPosition(pub(super) Point);

#[derive(Component, Clone, Debug, PartialEq)]
pub(super) enum Routine {
    Worker {
        shift_template: String,
        workplace: Option<BuildingAssignment>,
    },
    Student,
}

#[derive(Component, Clone, Debug, PartialEq)]
pub(super) struct LegacyDayState {
    pub(super) commute_day: u32,
    pub(super) outbound_resolved: bool,
    pub(super) outbound_arrived: bool,
    pub(super) return_resolved: bool,
    pub(super) returned_home: bool,
}
```

`LegacyDayState` exists only so Tasks 1-4 can round-trip the current v9 save contract while ECS ownership is introduced. Task 5 deletes it.

- [ ] **Step 4: Add one deterministic population index**

In `population/mod.rs` define:

```rust
#[derive(Resource, Default)]
pub(super) struct PopulationIndex {
    by_id: BTreeMap<String, Entity>,
    residents_by_building: BTreeMap<String, Vec<Entity>>,
    workers_by_building: BTreeMap<String, Vec<Entity>>,
    unassigned_workers: BTreeSet<String>,
    buildings: BTreeMap<String, PopulationBuilding>,
    next_citizen_ordinal: usize,
}
```

`PopulationBuilding` contains only building ID/type/footprint and catalog population/job capacities. Resolve current `Sim.home` / worker workplace to building IDs while constructing the world. Compute `next_citizen_ordinal` once from the maximum stable sim suffix.

Use BTree collections for every iteration that affects assignment/output order.

- [ ] **Step 5: Build/project the v9 adapter**

`build_world_v9` maps current v9 durable rows to components:

- `WorkerProfile::Worker` -> `Routine::Worker` with current shift/workplace;
- `WorkerProfile::NonWorker` -> `Routine::Student` (temporary name; no school routine is emitted before Task 5);
- daily booleans -> `LegacyDayState`;
- map home/workplace points to runtime building assignments.

`snapshot_sims_v9` performs the inverse mapping and sorts by `Sim.id`. Never serialize an `Entity`.

- [ ] **Step 6: Add a 200k structural world smoke test**

Inside the population module test (where private components are available), spawn/index 200,000 simple citizens through the same component/index helper used by `build_world_v9`, then assert:

```rust
assert_eq!(population_count(&world), 200_000);
assert_eq!(world.resource::<PopulationIndex>().by_id.len(), 200_000);
```

No duration assertion is added.

- [ ] **Step 7: Verify and commit**

Run:

```bash
cargo fmt --all --check
cargo test -p caelum-core population::tests
cargo test --workspace
```

Expected: PASS; production `GameEngine` still uses the snapshot population at this checkpoint.

Commit:

```bash
git add Cargo.lock crates/caelum-core crates/caelum-wasm/Cargo.toml src-tauri/Cargo.toml
git commit -m "feat: add indexed Bevy ECS population world"
```

---

### Task 2: Add due-event buckets and existing commute demand generation

**Files:**
- Modify: `crates/caelum-core/src/population/schedule.rs`
- Modify: `crates/caelum-core/src/population/mod.rs`
- Modify: `crates/caelum-core/src/commute.rs`

**Interfaces:**
- Produces:
  - runtime `NextActivity`
  - `TripDemand`
  - `run_due`
  - `drain_trip_demands`
  - `next_population_boundary`
  - `population_boundary_count_until`.
- Consumes: Task 1 world/index, existing worker shift/departure rules, current v9 flags to initialize the temporary adapter.

- [ ] **Step 1: Define scheduler data and one activity component**

In `schedule.rs` add:

```rust
const POPULATION_BUCKET_SECONDS: f64 =
    GAME_DAY_SECONDS / MINUTES_PER_DAY as f64;

#[derive(Component, Clone, Debug, PartialEq)]
pub(super) struct NextActivity {
    pub(super) kind: ActivityKind,
    pub(super) due_time: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ActivityKind {
    PrimaryOutbound,
    PrimaryReturn,
}

#[derive(Resource, Default)]
pub(super) struct PopulationScheduler {
    buckets: BTreeMap<u64, Vec<PopulationEvent>>,
}

pub(crate) struct TripDemand {
    pub(crate) citizen_id: String,
    pub(crate) purpose: TripPurpose,
    pub(crate) origin: Point,
    pub(crate) destination: Point,
    pub(crate) scheduled_time: f64,
}
```

Use `ceil(due_time / POPULATION_BUCKET_SECONDS)` so wakeup never occurs before the exact due time.

- [ ] **Step 2: Write RED due-bucket/order tests**

Create a world with three workers whose exact next activities map to buckets 10, 10, and 100. Run bucket 10 and assert the drained demand citizen IDs are exactly `sim-001`, then `sim-002`, while the far-future citizen retains `NextActivity`.

Add another test that inserts the two same-time events into the scheduler in reverse runtime-entity order and still expects `sim-001`, `sim-002` output. This pins stable-ID ordering rather than Bevy allocation order.

Run:

```bash
cargo test -p caelum-core population::schedule::tests
```

Expected: FAIL before systems are implemented.

- [ ] **Step 3: Configure the one explicit schedule**

Define:

```rust
#[derive(SystemSet, Debug, Clone, PartialEq, Eq, Hash)]
enum PopulationSet {
    CollectDue,
    ApplyDue,
    EmitTripDemand,
}
```

Configure those sets as a chained sequence and add one focused system per set. Do not use `App`, plugins, observers, or another schedule.

`CollectDue` drains populated buckets through `PopulationClock.now`. `ApplyDue` accesses only entities referenced by drained events. `EmitTripDemand` sorts by exact due time, stable citizen ID, then explicit purpose rank before appending to `PendingTripDemands`.

- [ ] **Step 4: Initialize the temporary v9 adapter's next activity without scanning during ticks**

During `build_world_v9`, derive one `NextActivity` from the current v9 `LegacyDayState`, active-trip membership, current day/time, current worker workplace, and existing shift helper:

- active trip exists -> no `NextActivity`;
- unresolved outbound still due today -> `PrimaryOutbound` at current exact departure time;
- outbound arrived and return unresolved -> `PrimaryReturn` at the existing return window;
- otherwise -> next day's `PrimaryOutbound`;
- non-worker or unassigned worker -> next day's wake with no emitted trip at this stage.

This adapter exists only until Task 5 and must not introduce a second per-tick population scan.

- [ ] **Step 5: Add scheduler boundary helpers**

Implement:

```rust
pub(crate) fn next_population_boundary(world: &World, after: f64) -> Option<f64>;
pub(crate) fn population_boundary_count_until(world: &World, final_time: f64) -> usize;
pub(crate) fn run_due(world: &mut World, schedule: &mut Schedule, now: f64);
pub(crate) fn drain_trip_demands(world: &mut World) -> Vec<TripDemand>;
```

Boundary helpers inspect scheduler BTree keys only, never citizen queries.

`run_due` reruns the schedule while processing creates another event in the current bucket; break once no due bucket remains.

- [ ] **Step 6: Verify scheduler structural behavior and commit**

Run:

```bash
cargo test -p caelum-core population::schedule::tests
cargo test -p caelum-core population::tests
cargo test --workspace
```

Expected: PASS; existing gameplay still uses snapshot commute logic until Task 4.

Commit:

```bash
git add crates/caelum-core/src/population crates/caelum-core/src/commute.rs
git commit -m "feat: schedule ECS commute demand by due bucket"
```

---

### Task 3: Move move-in/workplace/demolition semantics into indexed ECS reconciliation

**Files:**
- Modify: `crates/caelum-core/src/population/mod.rs`
- Modify: `crates/caelum-core/src/population/schedule.rs`
- Modify: `crates/caelum-core/src/buildings.rs`
- Modify: `crates/caelum-core/src/transit.rs`
- Modify: `crates/caelum-core/tests/population.rs`
- Modify: `crates/caelum-core/tests/areas_buildings.rs`
- Modify: `crates/caelum-core/tests/transit_build.rs`

**Interfaces:**
- Produces:

```rust
pub(crate) fn reconcile_buildings(
    world: &mut World,
    before: &[PlacedBuilding],
    after: &[PlacedBuilding],
    active_trips: &mut Vec<ActiveTrip>,
    vehicles: &mut Vec<Vehicle>,
    now: f64,
);
```

- Consumes: Task 1 index, Task 2 scheduler, current building catalog capacities, current trip reset constants.

- [ ] **Step 1: Port capacity semantics into ECS-level RED tests**

Add focused population tests with exact assertions:

1. two four-resident houses + one four-job supermarket -> 8 residents and exactly 4 assigned workers;
2. removing the employed house frees four slots and the four surviving stable-ID workers fill those slots;
3. adding a workplace to an existing unassigned population fills slots in stable citizen-ID order;
4. removing a workplace reassigns to the next stable free workplace before leaving workers unassigned.

Run the four new tests and confirm they fail before reconciliation is implemented.

- [ ] **Step 2: Move sim ID allocation to the index**

Stop deriving new sim IDs by scanning a vector. Use `PopulationIndex.next_citizen_ordinal`, incrementing once per successful move-in. Preserve current `sim-{number:03}` formatting through the existing ID helper.

- [ ] **Step 3: Schedule delayed move-ins by building/slot**

Add `PopulationEvent::MoveIn { building_id, slot }`. When housing is indexed, schedule only unoccupied slots from `PlacedBuilding.placed_at` using current `MOVE_IN_INTERVAL_SECONDS`.

A move-in event rechecks that the building still exists and the slot is still free, spawns one citizen, assigns the first stable workplace slot if the citizen is a worker, updates reverse indexes, and installs its first `NextActivity`.

Add a test for capacity 4 whose due processing reaches resident counts 1, 2, 3, 4 on successive move-in boundaries.

- [ ] **Step 4: Implement targeted `reconcile_buildings`**

Compare before/after building IDs and handle only changed buildings:

- added housing -> index + schedule remaining slots;
- added workplace -> index slots and fill sorted unassigned workers;
- removed housing -> read `residents_by_building`, despawn those entities, remove their active trips, scrub their trip IDs from every vehicle passenger list, free their workplace slots, refill those slots from sorted unassigned workers;
- removed workplace -> read `workers_by_building`, clear/reassign affected workers, and retarget affected outbound commute trips;
- outbound retarget -> `Idle`, `route_plan = None`, `private_car_trip = None`, leg index/wait reset to zero, patience reset to `WAIT_PATIENCE_SECONDS`, deadline reset with `trip_deadline_seconds(now)`;
- if no replacement workplace exists, drop the affected outbound trip and schedule that citizen's next wake rather than leaving it permanently unscheduled.

No case above iterates every citizen.

- [ ] **Step 5: Make snapshot mutation helpers shell-only**

Delete population mutation from `buildings::assign_workplaces` callers and from `transit.rs::{cleanup_removed_destination_references, cleanup_removed_resident_references}`. Keep route/vehicle cleanup that is independent of latent population.

Pure `transit::remove_at_tile` / preview behavior becomes shell-only. Update direct pure-function tests in `areas_buildings.rs` / `transit_build.rs` to stop expecting citizen mutation; keep final population behavior assertions for `GameEngine` integration in Task 4.

Delete `buildings::assign_workplaces` once no production caller remains.

- [ ] **Step 6: Verify and commit**

Run:

```bash
cargo test -p caelum-core population::tests
cargo test -p caelum-core --test areas_buildings
cargo test -p caelum-core --test transit_build
cargo test --workspace
```

Expected: PASS.

Commit:

```bash
git add crates/caelum-core/src/population crates/caelum-core/src/buildings.rs crates/caelum-core/src/transit.rs crates/caelum-core/tests
git commit -m "feat: reconcile population through ECS indexes"
```

---

### Task 4: Make ECS the live population authority and bridge it into trips/presentation

**Files:**
- Modify: `crates/caelum-core/src/engine.rs`
- Modify: `crates/caelum-core/src/intent.rs`
- Modify: `crates/caelum-core/src/trips.rs`
- Modify: `crates/caelum-core/src/presentation.rs`
- Modify: `crates/caelum-core/src/growth.rs` only where building-change reconciliation needs a seam
- Modify: `crates/caelum-core/tests/population.rs`
- Modify: `crates/caelum-core/tests/commute_requirements.rs`
- Modify: `crates/caelum-core/tests/trip_lifecycle.rs`
- Modify: `crates/caelum-core/tests/presentation_contract.rs`
- Modify: `crates/caelum-core/tests/presentation_scale.rs`
- Modify: `crates/caelum-core/tests/service_control.rs`
- Modify: `src-tauri/src/lib.rs` test fixtures using `engine.clone()`

**Interfaces:**
- `GameEngine` becomes `{ snapshot, road_topology, world, population_schedule }`.
- `GameEngine.snapshot.sims` is empty after construction/restore.
- Explicit `snapshot()` temporarily reconstructs current v9 durable sims via Task 1 adapter; Task 5 replaces this with v10.
- `trips` accepts `&mut World` + `&mut Schedule` and routes Task 2 `TripDemand`.
- runtime presentation reads ECS counts/indexed occupancy without reconstructing durable sims.

- [ ] **Step 1: Write the engine ownership invariant test**

Inside `engine.rs` tests add:

```rust
#[test]
fn live_engine_shell_does_not_mirror_population() {
    let engine = GameEngine::from_snapshot(populated_v9_snapshot()).unwrap();

    assert!(engine.snapshot.sims.is_empty());
    assert_eq!(population::population_count(&engine.world), 2);
    assert_eq!(engine.snapshot().sims.len(), 2);
}
```

Add another private test asserting `engine.presentation().frame.population_count == 2` while the live shell `sims` remains empty.

Run both and confirm RED.

- [ ] **Step 2: Cut constructors/restore to candidate-first ECS ownership**

Change the engine struct to:

```rust
pub struct GameEngine {
    snapshot: GameSnapshot,
    road_topology: RoadTopology,
    world: World,
    population_schedule: Schedule,
}
```

For `from_snapshot` at this checkpoint:

```rust
let PreparedSnapshot {
    mut snapshot,
    road_topology,
} = prepare_snapshot(snapshot)?;
let world = population::build_world_v9(&snapshot);
let population_schedule = population::build_schedule();
snapshot.sims.clear();
Ok(Self {
    snapshot,
    road_topology,
    world,
    population_schedule,
})
```

Use the same candidate-first construction for `new`, sandbox factory/reset, and restore. Do not touch the current engine until the replacement shell/topology/world/schedule all exist.

Remove `#[derive(Clone)]` from `GameEngine`.

- [ ] **Step 3: Reconstruct population only for explicit durable snapshots**

At this checkpoint implement:

```rust
pub fn snapshot(&self) -> GameSnapshot {
    let mut snapshot = self.snapshot.clone();
    snapshot.sims = population::snapshot_sims_v9(&self.world, snapshot.day);
    populate_service_metrics(&mut snapshot);
    snapshot
}
```

`snapshot_for_save()` may call `snapshot()`; ordinary tick, dispatch, and presentation must not.

- [ ] **Step 4: Change trip ticking to drain due ECS demand**

Change both `tick_trips` and `tick_trips_with_objectives` to accept:

```rust
world: &mut World,
population_schedule: &mut Schedule,
```

Delete `spawn_due_commute_trips`'s `state.sims.clone()` loop. At each current/substep timestamp:

1. apply growth to the shell;
2. reconcile any building delta into ECS;
3. `population::run_due(world, population_schedule, state.time)`;
4. drain stable-sorted demands;
5. feed each demand through a refactored `build_commute_trip` taking citizen ID/purpose/origin/destination/scheduled time rather than `&Sim`;
6. continue existing route/private-car/traffic behavior.

Keep one mutable `RoadFlow` for the whole same-time demand batch exactly as current spawning does, so admitted cars affect later same-time route choices deterministically.

- [ ] **Step 5: Replace all population-derived trip boundaries**

Delete:

- `reset_daily_commute_flags`;
- sim iteration in `next_boundary_after`;
- `SIM_SHIFT_BOUNDARIES_PER_DAY`;
- `remaining_move_in_slots`;
- sim-count cap widening.

Use `next_population_boundary(world, state.time)` and `population_boundary_count_until(world, final_time)` instead. Active-trip/vehicle/outcome/growth terms remain.

Run:

```bash
rg 'state\.sims|snapshot\.sims|for sim in .*sims|sims\.len' crates/caelum-core/src/trips.rs
```

Expected: no matches.

- [ ] **Step 6: Feed terminal trip results back to ECS**

Before terminal trips are dropped, collect:

```rust
pub(crate) struct PopulationTripResolution {
    pub(crate) citizen_id: String,
    pub(crate) purpose: TripPurpose,
    pub(crate) status: TripStatus,
    pub(crate) destination: Point,
    pub(crate) resolved_at: f64,
}
```

Add:

```rust
pub(crate) fn apply_trip_resolutions(
    world: &mut World,
    resolutions: Vec<PopulationTripResolution>,
);
```

Use each row's `resolved_at`. `Arrived | Late` updates settled position and schedules the next activity; `Unserved` leaves settled position unchanged and schedules recovery. Delete `apply_arrival_to_sim` and `apply_commute_resolution_to_sim`.

- [ ] **Step 7: Reconcile committed player building mutations**

When an applied dispatch changes `buildings`, call Task 3 `reconcile_buildings` against the candidate active trips/vehicles before installing the candidate shell. Rejected/no-op dispatches leave both shell and world untouched.

Pure previews remain snapshot-only.

- [ ] **Step 8: Add runtime presentation without changing wire shape**

Keep `presentation::project_update(&GameSnapshot, include_scene)` for durable snapshot tests/harness.

Add:

```rust
pub(crate) fn project_runtime_update(
    snapshot: &GameSnapshot,
    world: &World,
    include_scene: bool,
) -> PresentationUpdate;
```

Factor one shared frame builder so only population source differs. Runtime population count/residential/job occupancy come from `PopulationIndex`; every other HPA-544 scene/frame field uses existing projection code.

Change `GameplayUpdateResult` constructors to accept a precomputed update:

```rust
pub fn present(update: PresentationUpdate) -> Self {
    Self {
        update,
        applied: true,
        rejection: None,
    }
}

pub fn frame_only(update: PresentationUpdate, applied: bool) -> Self {
    Self {
        update,
        applied,
        rejection: None,
    }
}

pub fn rejected(update: PresentationUpdate, rejection: GameplayRejection) -> Self {
    Self {
        update,
        applied: false,
        rejection: Some(rejection),
    }
}
```

`GameEngine` tick/dispatch/presentation uses `project_runtime_update`; none calls `snapshot()`.

- [ ] **Step 9: Remove `GameEngine::Clone` fixture dependency**

Replace test-only `engine.clone()` uses with explicit independent construction. When a test genuinely needs the exact durable state:

```rust
let durable = engine.snapshot();
let mut copy = GameEngine::from_snapshot(durable).expect("fixture snapshot is valid");
```

Then set paused/running state explicitly for that test. Do not implement deep runtime clone.

Guard:

```bash
rg 'engine\.clone\(\)|derive\(Clone\).*GameEngine' crates/caelum-core src-tauri
```

Expected: no production clone contract.

- [ ] **Step 10: Restore existing gameplay parity at the engine level**

Update integration tests to assert through `engine.snapshot()` and `engine.presentation()`:

- paused housing does not move residents in;
- due move-ins fill current catalog capacity;
- finite workplace allocation stays deterministic;
- housing demolition removes residents/trips/passenger references;
- workplace demolition reassigns or cancels affected outbound trips;
- existing commute lifecycle/route/private-car outcomes remain equivalent;
- presentation contract has no sim rows and aggregate values match durable snapshot values.

Run:

```bash
cargo test -p caelum-core --test population
cargo test -p caelum-core --test commute_requirements
cargo test -p caelum-core --test trip_lifecycle
cargo test -p caelum-core --test presentation_contract
cargo test -p caelum-core --test presentation_scale
cargo test -p caelum-core --test service_control
cargo test --workspace
```

Expected: PASS with ECS now the live authority, still using v9 only as explicit save adapter.

- [ ] **Step 11: Commit**

```bash
git add crates/caelum-core src-tauri/src/lib.rs
git commit -m "feat: make ECS the live population authority"
```

---

### Task 5: Replace the temporary v9 adapter with v10 scheduled routines, school/day-off/optional trips, and host persistence types

**Files:**
- Modify: `crates/caelum-core/src/model.rs`
- Modify: `crates/caelum-core/src/commute.rs`
- Modify: `crates/caelum-core/src/population/components.rs`
- Modify: `crates/caelum-core/src/population/schedule.rs`
- Modify: `crates/caelum-core/src/population/mod.rs`
- Modify: `crates/caelum-core/src/persistence/error.rs`
- Modify: `crates/caelum-core/src/persistence/trips.rs`
- Modify: `crates/caelum-core/src/persistence/entities.rs` only for v10 reference validation/index use
- Modify: `crates/caelum-core/tests/common/persistence_fixtures.rs`
- Modify: Rust test/example fixtures returned by `rg -l 'WorkerProfile|worker_profile|commute_day|outbound_resolved_today|outbound_arrived_today|return_resolved_today|returned_home_today' crates/caelum-core`
- Modify: `src/domain/types.ts`
- Modify: `src/runtime/backend/types.ts`
- Modify: persistence/restore tests returned by `rg -l 'schemaVersion|RustSim|workerProfile|commuteDay' src tests crates/caelum-wasm src-tauri`

**Interfaces:**
- Deletes: `LegacyDayState`, `build_world_v9`, `snapshot_sims_v9`, `WorkerProfile`, daily commute flags.
- Produces: final v10 `CitizenRoutine`, `ScheduledActivityKind`, `ScheduledActivity`, compact durable `Sim`, optional trip purposes, `build_world`, `snapshot_sims`.

- [ ] **Step 1: Write exact v10 serde RED tests**

In `model.rs` tests add:

```rust
#[test]
fn sim_v10_serializes_worker_schedule_without_daily_flags() {
    let sim = Sim {
        id: "sim-001".to_string(),
        home: Point { x: 2, y: 3 },
        position: Point { x: 2, y: 3 },
        routine: CitizenRoutine::Worker {
            shift_template: "standard".to_string(),
            workplace: Some(Point { x: 8, y: 4 }),
        },
        next_activity: Some(ScheduledActivity {
            kind: ScheduledActivityKind::DailyRoutine,
            due_time: 120.0,
        }),
    };

    let value = serde_json::to_value(sim).unwrap();
    assert_eq!(value["routine"]["worker"]["shiftTemplate"], "standard");
    assert_eq!(value["nextActivity"]["kind"], "dailyRoutine");
    assert!(value.get("commuteDay").is_none());
    assert!(value.get("outboundResolvedToday").is_none());
}
```

Add round-trips for `CitizenRoutine::Student`, `TripPurpose::OptionalOutbound`, and `TripPurpose::OptionalReturn`.

Run the tests and confirm RED.

- [ ] **Step 2: Replace the durable model and bump schema directly**

Set:

```rust
pub const SNAPSHOT_SCHEMA_VERSION: u16 = 10;
```

Add the exact types from the design spec, including:

```rust
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum CitizenRoutine { /* Worker fields + Student */ }
```

Implement the enum with exactly these variants/fields:

- `Worker { shift_template: String, workplace: Option<Point> }`
- `Student`

Implement `ScheduledActivityKind::{DailyRoutine, PrimaryReturn, OptionalReturn}` and `ScheduledActivity { kind, due_time }`.

Final `Sim` fields are exactly `id`, `home`, `position`, `routine`, `next_activity`.

Final `TripPurpose` is exactly `CommuteOutbound`, `CommuteReturn`, `OptionalOutbound`, `OptionalReturn`.

Delete `WorkerProfile` after all callers in this task are migrated. Do not add v9 deserialization aliases/defaults.

- [ ] **Step 3: Replace temporary runtime day state with final `NextActivity` projection**

Delete `LegacyDayState`. `build_world(snapshot)` now maps each durable v10 `Sim` directly into `Routine`, `SettledPosition`, and optional `NextActivity`; it schedules the activity when present.

`snapshot_sims(world)` maps components back to v10 and sorts by stable ID. Runtime `BuildingAssignment` is projected back to worker workplace point only.

Update `GameEngine::{from_snapshot,snapshot}` to call these final names.

- [ ] **Step 4: Add structured persistence validation for final activity ownership**

In `SnapshotField`, remove the old sim worker/shift/commute/day-flag fields and add:

```rust
SimRoutine,
SimWorkplace,
SimNextActivity,
SimNextActivityDueTime,
```

Add exact `AssignmentError` variants:

```rust
SimHomeNotResidential,
SimWorkplaceNotJob,
ScheduledWhileTraveling,
MissingNextActivity,
```

In `validate_sims`:

- validate home/position points;
- require home point inside a placed housing building footprint;
- for worker workplace `Some`, require it inside a placed building whose catalog `job_capacity > 0`;
- validate `next_activity.due_time` with existing `finite_non_negative` and `SnapshotField::SimNextActivityDueTime`.

After active-trip references are indexed, build a `BTreeSet<&str>` of active `sim_id`s and enforce:

```rust
if active_sim_ids.contains(sim.id.as_str()) && sim.next_activity.is_some() {
    return Err(PersistenceError::InvalidAssignment {
        entity: entity_ref(EntityKind::Sim, &sim.id),
        reason: AssignmentError::ScheduledWhileTraveling,
    });
}
if !active_sim_ids.contains(sim.id.as_str()) && sim.next_activity.is_none() {
    return Err(PersistenceError::InvalidAssignment {
        entity: entity_ref(EntityKind::Sim, &sim.id),
        reason: AssignmentError::MissingNextActivity,
    });
}
```

Use the existing `InvalidAssignment { entity, reason }` shape exactly; do not introduce a string diagnostic path.

- [ ] **Step 5: Implement stable daily seed/day-off/student/optional routine rules**

Keep `numeric_id_suffix`, `shift_template_for_id`, and worker departure windows. Replace `worker_profile_for_id` with `routine_for_new_citizen`:

```rust
pub fn routine_for_new_citizen(id: &str) -> CitizenRoutine {
    if numeric_id_suffix(id) % 10 == 0 {
        CitizenRoutine::Student
    } else {
        CitizenRoutine::Worker {
            shift_template: shift_template_for_id(id)
                .expect("worker ids have a shift template")
                .to_string(),
            workplace: None,
        }
    }
}
```

Add the deterministic integer mixer from the spec (SplitMix64-style over citizen suffix/day/salt) and exact rule tests:

- `sim-001` has day off when `day % 7 == 1` and exactly once in days 0..6;
- same citizen/day/fixture chooses identical optional outing in two independent worlds;
- student without a school emits no primary trip and schedules the next daily wake;
- day off suppresses primary work/school trip;
- only one in four eligible day-off citizens emits an optional outing;
- optional destination type is one of `supermarket`, `cinema`, `clinic`, `parkPlaza`;
- successful optional outbound schedules `OptionalReturn` exactly 120 in-game minutes later.

Use school outbound 07:30–08:30 and return 15:00–16:00, optional outbound 11:00–15:00.

- [ ] **Step 6: Implement the final one-next-activity state machine**

`DailyRoutine` processing follows this order:

1. if settled position != home, emit a return-home demand first;
2. otherwise, on non-day-off, emit worker primary outbound when assigned or student primary outbound when a school exists;
3. otherwise, evaluate the one-in-four optional outing;
4. otherwise schedule next day's `DailyRoutine`.

Trip resolution rules:

- `Arrived | Late` primary outbound -> settle at destination, schedule `PrimaryReturn` at return window/current bucket if already passed;
- `Arrived | Late` optional outbound -> settle at destination, schedule `OptionalReturn` at `resolved_at + 120 in-game minutes`;
- successful return -> settle at home, schedule next day's `DailyRoutine`;
- `Unserved` outbound -> keep settled position, schedule next daily wake;
- `Unserved` return -> keep settled position, schedule next daily wake so the away-from-home rule retries before any new outbound activity.

No retry loop is scheduled into the same broken bucket.

- [ ] **Step 7: Migrate Rust fixtures as one schema-breaking sweep**

Update the shared `tests/common/persistence_fixtures.rs` helper first, then run:

```bash
rg -l 'WorkerProfile|worker_profile|commute_day|outbound_resolved_today|outbound_arrived_today|return_resolved_today|returned_home_today' crates/caelum-core
```

Every current result must be migrated to `CitizenRoutine` / `next_activity` semantics in this task. Do not leave deprecated fields/aliases for compilation convenience.

Update schema assertions so v9 now expects `UnsupportedSchema { expected: 10, actual: 9 }`.

- [ ] **Step 8: Update the durable TypeScript host types exactly**

In `src/domain/types.ts` use the observed Rust externally tagged representation:

```ts
export type CitizenRoutine =
  | {
      worker: {
        shiftTemplate: "standard" | "early" | "late" | "offPeak";
        workplace?: Point;
      };
    }
  | "student";

export type ScheduledActivityKind =
  | "dailyRoutine"
  | "primaryReturn"
  | "optionalReturn";

export interface ScheduledActivity {
  kind: ScheduledActivityKind;
  dueTime: number;
}

export interface Sim {
  id: string;
  home: Point;
  position: Point;
  routine: CitizenRoutine;
  nextActivity: ScheduledActivity | null;
}

export type TripPurpose =
  | "commuteOutbound"
  | "commuteReturn"
  | "optionalOutbound"
  | "optionalReturn";
```

For raw WASM Option encoding in `src/runtime/backend/types.ts`:

```ts
export interface RustSim extends Omit<Sim, "nextActivity"> {
  nextActivity: ScheduledActivity | null | undefined;
}
```

Set the TS schema mirror to 10. Do not add `sims` to live `GameState` or `PresentationUpdate`.

- [ ] **Step 9: Add restore/save routine tests and cross-host validation**

Add tests covering:

- worker next activity save -> restore -> save exact durable equality after normalization;
- student next activity round-trip;
- active trip + scheduled activity rejection with `scheduledWhileTraveling` diagnostic;
- idle sim without next activity rejection with `missingNextActivity` diagnostic;
- worker workplace on non-job building rejection;
- home outside housing rejection;
- normal presentation JSON still contains no `sims` key.

Run:

```bash
cargo fmt --all --check
cargo test --workspace
bun run wasm:build:release
bun run check
bun run test:unit
```

Expected: PASS with v10 only.

- [ ] **Step 10: Commit**

```bash
git add crates/caelum-core crates/caelum-wasm src src-tauri tests Cargo.lock
git commit -m "feat: persist scheduled ECS citizen routines"
```

---

### Task 6: Prove the 200k runtime shape, document ownership, and run the full gate

**Files:**
- Modify: `crates/caelum-core/examples/presentation_scale.rs`
- Modify: `crates/caelum-core/tests/presentation_scale.rs`
- Modify: population scheduler tests under `crates/caelum-core/src/population/`
- Modify: `docs/performance/hpa-347-ecs-population.md`
- Modify: `docs/architecture.md`
- Modify: `CLAUDE.md` if its runtime-ownership description is stale

**Interfaces:**
- Consumes: final ECS engine/runtime and Task 0 baseline.
- Produces: final construction/quiet-tick/presentation/save evidence plus separate due-wave scheduler vs route-spawn evidence.

- [ ] **Step 1: Extend the release harness with final runtime rows**

For `ecs-10000`, `ecs-50000`, and `ecs-200000`, construct v10 snapshots with stable synthetic citizen IDs and valid in-map home/work points, then create `GameEngine::from_snapshot`. The persistence boundary validates references/shape, not gameplay housing occupancy count, so the scale fixture may intentionally place many synthetic residents on the same valid housing footprint; document this as a performance fixture, not gameplay-produced state.

Measure separately:

```text
runtime_build_us
quiet_tick_us
runtime_presentation_us
full_snapshot_us
```

For `wave-1000`, `wave-5000`, `wave-20000`, schedule exactly that many citizens in one due bucket and measure separately:

```text
schedule_emit_us
route_spawn_us
```

Keep the existing HPA-544 snapshot/presentation cardinality rows too.

- [ ] **Step 2: Add structural 200k assertions without timing thresholds**

Add tests proving:

```rust
assert_eq!(population::population_count(&engine.world), 200_000);
assert!(engine.snapshot.sims.is_empty());
assert_eq!(engine.presentation().frame.population_count, 200_000);
```

Because `world`/live shell are private, place these assertions in `engine.rs`/population module tests rather than exposing debug accessors.

Add a 200k scheduler test with exactly N due citizens and assert `drain_trip_demands` returns exactly N stable-sorted IDs while all other citizens remain future-scheduled.

- [ ] **Step 3: Record the final reference evidence**

Run on the same reference machine used in Task 0:

```bash
cargo run --release -p caelum-core --example presentation_scale
```

Append exact measured values to `docs/performance/hpa-347-ecs-population.md` in two tables:

- rows `ecs-10000`, `ecs-50000`, `ecs-200000` with ECS citizens, runtime build, quiet tick, runtime presentation, full snapshot;
- rows `wave-1000`, `wave-5000`, `wave-20000` with due citizens, scheduler+emit, existing route spawn.

State whether route creation is now the dominant due-wave cost. If it is, explicitly name HPA-348 as owner. Do not derive a pass/fail millisecond threshold from the numbers.

- [ ] **Step 4: Update architecture ownership docs**

Document final invariants:

- `GameEngine` owns shell + topology + ECS world/schedule;
- live shell `sims` is empty;
- durable snapshot reconstructs v10 sims;
- time buckets wake only due citizens;
- HPA-544 presentation reads ECS population aggregates;
- HPA-348 remains route-choice batching;
- HPA-640 remains viewport/LOD/WebGPU work.

Delete stale wording that describes live `Vec<Sim>` as the ticking authority.

- [ ] **Step 5: Run final source-shape guards**

Run:

```bash
rg 'state\.sims|snapshot\.sims|\.sims\.iter|\.sims\.len' crates/caelum-core/src
```

Expected matches are limited to deliberate durable/persistence/pure durable-presentation conversion paths. `trips.rs`, `buildings.rs`, and population-dependent `transit.rs` cleanup must have no ordinary live-population scan.

Run:

```bash
rg 'bevy::|bevy_app|multi_threaded|bevy_reflect|rand::' crates/caelum-core Cargo.toml
```

Expected: no matches for prohibited dependencies/features.

Run:

```bash
rg 'bevy_ecs::.*Entity|\bEntity\b' crates/caelum-core/src/model.rs src/domain/types.ts src/runtime/backend/types.ts crates/caelum-core/src/presentation.rs
```

Expected: no Bevy runtime entity handle in durable/public presentation types.

Run:

```bash
rg 'WorkerProfile|worker_profile|commute_day|outbound_resolved_today|outbound_arrived_today|return_resolved_today|returned_home_today|build_world_v9|snapshot_sims_v9|LegacyDayState' crates/caelum-core src tests
```

Expected: no final legacy adapter/state references.

- [ ] **Step 6: Run the complete project gate**

Run:

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace
cargo build --workspace --all-targets --locked
bun install --frozen-lockfile
bun run wasm:build:release
bun run check
bun run lint:svelte
bun run lint:css
bun run test:unit
bun run test:e2e
bun run build
cargo run --release -p caelum-core --example presentation_scale
```

Expected: every command PASS and the release harness prints the recorded final rows.

- [ ] **Step 7: Self-review spec coverage and plan drift**

Verify no unfinished planning markers remain:

```bash
rg 'TBD|TODO|FILL_ME|REPLACE_ME' \
  docs/superpowers/specs/2026-09-04-ecs-latent-population-design.md \
  docs/superpowers/plans/2026-09-04-ecs-latent-population.md \
  docs/performance/hpa-347-ecs-population.md
```

Expected: no matches.

Read the design spec once more and map every acceptance item to a passing test, harness row, or source-shape guard. Fix interface-name drift instead of adding aliases.

- [ ] **Step 8: Commit evidence/docs and update this same PR**

```bash
git add crates/caelum-core docs CLAUDE.md
git commit -m "docs: record HPA-347 ECS scale evidence"
```

Update this HPA-347 draft PR body from planning summary to implementation/evidence summary. Do not create another PR.
