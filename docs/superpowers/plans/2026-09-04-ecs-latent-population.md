# HPA-347 ECS Latent Population Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move latent citizen/activity scheduling into a load-bearing standalone Bevy ECS world so Caelum can hold and advance about 200,000 citizens without scanning or cloning every citizen on ordinary simulation substeps.

**Architecture:** `GameEngine` will own a `bevy_ecs::World` plus one explicitly ordered population `Schedule`. Its live `GameSnapshot` becomes the non-population shell (`sims` intentionally empty). ECS wakes only time-bucketed citizens and emits deterministic `TripDemand` rows into the existing routing/active-trip pipeline. Full `Sim[]` is reconstructed only for explicit durable snapshot/save operations. HPA-544 presentation reads population count/occupancy from ECS indexes without changing its wire shape.

**Tech Stack:** Rust 1.95+, `bevy_ecs` 0.19.1 (`default-features = false`, `std` only), serde/serde_json, existing Caelum route/transit/traffic modules, TypeScript/Bun host persistence tests.

**Spec:** `docs/superpowers/specs/2026-09-04-ecs-latent-population-design.md`

## Global constraints

- One HPA-347 PR only. All implementation commits stay on this same draft PR.
- Add only `bevy_ecs = { version = "0.19.1", default-features = false, features = ["std"] }`.
- Set `rust-version = "1.95"` in `caelum-core`, `caelum-wasm`, and `src-tauri`.
- Do not add full `bevy`, `bevy_app`, Bevy reflection/serialization, async executor, `multi_threaded`, or `rand`.
- Final live population authority is ECS only; never finish with a mirrored runtime `GameSnapshot.sims`.
- Stable Caelum string IDs are durable; Bevy `Entity` is runtime-only and never serialized/presented.
- Keep route graphs, route choice, active-trip movement, traffic aggregation, economy, catalogs, and HPA-544 presentation outside ECS.
- Route choice remains sequential; HPA-348 owns batching it.
- Final durable schema is v10; reject v9 rather than writing a migration layer.
- Deterministic ordering is scheduler bucket/exact time -> stable citizen ID -> explicit purpose rank.
- Population system sets are explicitly chained `CollectDue -> ApplyDue -> EmitTripDemand`.
- Wall-clock measurements are reference evidence, never CI thresholds.
- Tasks 1-4 use the current v9 `Sim` only as a branch-local adapter while ECS is brought online. Task 5 removes that adapter completely; this is not a supported compatibility path.

---

### Task 0: Record the current high-cardinality tick baseline

**Files:**
- Modify: `crates/caelum-core/examples/presentation_scale.rs`
- Create: `docs/performance/hpa-347-ecs-population.md`

- [ ] **Step 1: Add a current-runtime tick measurement**

Add imports for `RoadTopology` and `trips`, then add:

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

Call it for the existing 10k, 50k, and 200k synthetic sim fixtures with a small delta that does not intentionally cross a commute departure.

- [ ] **Step 2: Capture literal reference evidence**

Run:

```bash
uname -a
rustc --version
cargo run --release -p caelum-core --example presentation_scale
```

Create `docs/performance/hpa-347-ecs-population.md` with the literal machine/Rust output and one before-cutover table row for each 10k/50k/200k `population_tick_us` result. End the section with `Wall-clock values are reference evidence, not CI thresholds.` Do not invent or prefill measurements.

- [ ] **Step 3: Verify and commit**

Run:

```bash
cargo test -p caelum-core --lib
cargo run --release -p caelum-core --example presentation_scale
```

Expected: PASS; existing HPA-544 rows remain and three tick rows are added.

Commit:

```bash
git add crates/caelum-core/examples/presentation_scale.rs docs/performance/hpa-347-ecs-population.md
git commit -m "perf: record HPA-347 population tick baseline"
```

---

### Task 1: Add standalone Bevy ECS and deterministic population indexes behind the current save adapter

**Files:**
- Modify: `crates/caelum-core/Cargo.toml`
- Modify: `crates/caelum-wasm/Cargo.toml`
- Modify: `src-tauri/Cargo.toml`
- Modify: `Cargo.lock`
- Move: `crates/caelum-core/src/population.rs` -> `crates/caelum-core/src/population/mod.rs`
- Create: `crates/caelum-core/src/population/components.rs`
- Create: `crates/caelum-core/src/population/schedule.rs`
- Modify: `crates/caelum-core/src/population/mod.rs`

**New seams:**

```rust
pub(crate) fn build_world_v9(snapshot: &GameSnapshot) -> World;
pub(crate) fn build_schedule() -> Schedule;
pub(crate) fn snapshot_sims_v9(world: &World, day: u32) -> Vec<Sim>;
pub(crate) fn population_count(world: &World) -> u32;
pub(crate) fn resident_occupancy_for_building(world: &World, building_id: &str) -> u32;
pub(crate) fn job_occupancy_for_building(world: &World, building_id: &str) -> u32;
```

- [ ] **Step 1: Add dependency/MSRV and make the workspace compile**

Add to `caelum-core`:

```toml
bevy_ecs = { version = "0.19.1", default-features = false, features = ["std"] }
```

Set `rust-version = "1.95"` in all three package manifests and run:

```bash
cargo check --workspace
```

Expected: `Cargo.lock` records `bevy_ecs` 0.19.1 and the workspace compiles.

- [ ] **Step 2: Move `population.rs` and write RED round-trip/index tests**

Move the file to `population/mod.rs` without changing existing behavior first. Add a fixture with two residents and one assigned worker, then tests requiring:

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

Run these tests and confirm RED.

- [ ] **Step 3: Add only the runtime components needed by the migration**

`components.rs` defines:

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

`LegacyDayState` exists only through Task 4 to keep intermediate v9 save snapshots testable. Task 5 deletes it.

- [ ] **Step 4: Add one BTree-backed `PopulationIndex`**

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

`PopulationBuilding` contains only building ID/type/footprint and catalog resident/job capacities. Resolve v9 sim home/workplace points to building IDs during world construction. Compute `next_citizen_ordinal` once from the maximum stable sim suffix.

- [ ] **Step 5: Implement the v9 build/project adapter**

Map current rows as follows:

- `WorkerProfile::Worker` -> runtime worker with current shift/workplace;
- `WorkerProfile::NonWorker` -> runtime `Student` (no student travel until Task 5);
- current daily flags -> `LegacyDayState`;
- home/workplace points -> runtime building assignments.

`snapshot_sims_v9` reverses that mapping and sorts by `Sim.id`. Never expose Bevy entity values.

- [ ] **Step 6: Add a 200k structural world test**

Inside the population module, use the same spawn/index helper as `build_world_v9` to create 200,000 runtime citizens and assert:

```rust
assert_eq!(population_count(&world), 200_000);
assert_eq!(world.resource::<PopulationIndex>().by_id.len(), 200_000);
```

No timing assertion.

- [ ] **Step 7: Verify and commit**

Run:

```bash
cargo fmt --all --check
cargo test -p caelum-core population::tests
cargo test --workspace
```

Expected: PASS; `GameEngine` still uses snapshot population at this checkpoint.

Commit:

```bash
git add Cargo.lock crates/caelum-core crates/caelum-wasm/Cargo.toml src-tauri/Cargo.toml
git commit -m "feat: add indexed Bevy ECS population world"
```

---

### Task 2: Add time buckets and deterministic existing-commute demand emission

**Files:**
- Modify: `crates/caelum-core/src/population/schedule.rs`
- Modify: `crates/caelum-core/src/population/mod.rs`
- Modify: `crates/caelum-core/src/commute.rs`

**New seams:**

```rust
pub(crate) fn run_due(world: &mut World, schedule: &mut Schedule, now: f64);
pub(crate) fn drain_trip_demands(world: &mut World) -> Vec<TripDemand>;
pub(crate) fn next_population_boundary(world: &World, after: f64) -> Option<f64>;
pub(crate) fn population_boundary_count_until(world: &World, final_time: f64) -> usize;
```

- [ ] **Step 1: Define scheduler state**

```rust
const POPULATION_BUCKET_SECONDS: f64 = GAME_DAY_SECONDS / MINUTES_PER_DAY as f64;

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

Bucket with `ceil(due_time / POPULATION_BUCKET_SECONDS)`: wakeup may be slightly late but never early; `TripDemand.scheduled_time` remains the exact activity time.

- [ ] **Step 2: Write RED due-only and stable-order tests**

Create three workers due in buckets 10, 10, and 100. After running bucket 10, demand IDs must be exactly `sim-001`, `sim-002`, and the future citizen must retain `NextActivity`.

Insert same-time scheduler events in reverse runtime-entity order in a second test; output must still be `sim-001`, `sim-002`.

Run:

```bash
cargo test -p caelum-core population::schedule::tests
```

Expected: RED.

- [ ] **Step 3: Configure one explicit schedule**

```rust
#[derive(SystemSet, Debug, Clone, PartialEq, Eq, Hash)]
enum PopulationSet {
    CollectDue,
    ApplyDue,
    EmitTripDemand,
}
```

Chain sets in that order. `CollectDue` drains scheduler keys through `PopulationClock.now`; `ApplyDue` touches only entities referenced by drained events; `EmitTripDemand` stable-sorts by exact due time, citizen ID, explicit purpose rank.

Do not add `App`, plugins, observers, or a second population schedule.

- [ ] **Step 4: Initialize one next activity from the temporary v9 adapter**

During `build_world_v9`:

- active trip for this sim -> no next activity;
- unresolved worker outbound still due today -> `PrimaryOutbound` at current existing departure time;
- outbound arrived and return unresolved -> `PrimaryReturn` at current existing return time;
- otherwise assigned worker -> next day's outbound;
- non-worker/unassigned worker -> next-day wake that emits no trip at this stage.

This conversion happens once on load; no new per-tick scan is allowed.

- [ ] **Step 5: Implement boundary helpers using scheduler keys only**

`next_population_boundary` finds the first populated bucket after the current timestamp. `population_boundary_count_until` counts populated keys through the final bucket. Neither queries citizens.

`run_due` reruns the schedule while processing creates another event in the already-current bucket and stops once no due key remains.

- [ ] **Step 6: Verify and commit**

Run:

```bash
cargo test -p caelum-core population::schedule::tests
cargo test -p caelum-core population::tests
cargo test --workspace
```

Expected: PASS; production trip spawning is still old until Task 4.

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

**New seam:**

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

- [ ] **Step 1: Write RED capacity/reassignment tests**

Pin these exact outcomes in population module tests:

1. two four-resident houses + one four-job supermarket -> 8 residents, exactly 4 workers assigned;
2. removing the employed house frees slots and the surviving unassigned stable-ID workers fill them;
3. adding a workplace fills slots in stable citizen-ID order;
4. removing a workplace reassigns affected workers to the next stable free workplace before leaving them unassigned.

Run the new tests and confirm RED.

- [ ] **Step 2: Move sim ID allocation into `PopulationIndex`**

Use `next_citizen_ordinal`; stop scanning population to allocate IDs. Keep existing `sim-{number:03}` formatting helper.

- [ ] **Step 3: Schedule delayed move-ins as events**

Add:

```rust
enum PopulationEvent {
    MoveIn { building_id: String, slot: u16 },
    Activity { entity: Entity },
}
```

When housing is indexed, schedule only unoccupied slots from `PlacedBuilding.placed_at` using current `MOVE_IN_INTERVAL_SECONDS`. A move-in rechecks building/slot existence, spawns one citizen, assigns the first stable workplace slot for a worker, updates indexes, and installs a first next activity.

Add a capacity-4 test that reaches resident counts 1, 2, 3, 4 on successive move-in boundaries.

- [ ] **Step 4: Implement targeted building reconciliation**

Compare before/after IDs and process only changed buildings:

- added housing -> index + schedule missing slots;
- added workplace -> index slots + fill sorted unassigned workers;
- removed housing -> read `residents_by_building`, despawn those entities, remove their trips, scrub vehicle passenger IDs, free/refill workplace slots;
- removed workplace -> read `workers_by_building`, clear/reassign only those workers;
- affected outbound retarget -> set `Idle`, clear route/private-car, reset leg index/current-leg wait, restore `WAIT_PATIENCE_SECONDS`, reset deadline with `trip_deadline_seconds(now)`;
- if no replacement workplace exists, remove the outbound trip and schedule that citizen's next wake.

Do not scan every citizen in any removal path.

- [ ] **Step 5: Make pure snapshot building/removal helpers shell-only**

Remove population ownership from `buildings::assign_workplaces` callers and `transit.rs` resident/workplace cleanup. Keep generic route/vehicle cleanup.

Update direct `transit::remove_at_tile` tests to assert shell changes only. Final citizen behavior moves to `GameEngine` tests in Task 4. Delete `buildings::assign_workplaces` after its final caller is removed.

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

### Task 4: Make ECS the live population authority and integrate trips/presentation

**Files:**
- Modify: `crates/caelum-core/src/engine.rs`
- Modify: `crates/caelum-core/src/intent.rs`
- Modify: `crates/caelum-core/src/trips.rs`
- Modify: `crates/caelum-core/src/presentation.rs`
- Modify: `crates/caelum-core/tests/population.rs`
- Modify: `crates/caelum-core/tests/commute_requirements.rs`
- Modify: `crates/caelum-core/tests/trip_lifecycle.rs`
- Modify: `crates/caelum-core/tests/presentation_contract.rs`
- Modify: `crates/caelum-core/tests/presentation_scale.rs`
- Modify: `crates/caelum-core/tests/service_control.rs`
- Modify: `src-tauri/src/lib.rs` test fixtures using `engine.clone()`

- [ ] **Step 1: Write RED engine ownership/presentation tests**

Inside `engine.rs` tests require:

```rust
#[test]
fn live_engine_shell_does_not_mirror_population() {
    let engine = GameEngine::from_snapshot(populated_v9_snapshot()).unwrap();
    assert!(engine.snapshot.sims.is_empty());
    assert_eq!(population::population_count(&engine.world), 2);
    assert_eq!(engine.snapshot().sims.len(), 2);
}
```

Also assert `engine.presentation().frame.population_count == 2` while private live shell `sims` is empty. Confirm RED.

- [ ] **Step 2: Cut constructors/restore to candidate-first ECS ownership**

Final engine storage shape begins here:

```rust
pub struct GameEngine {
    snapshot: GameSnapshot,
    road_topology: RoadTopology,
    world: World,
    population_schedule: Schedule,
}
```

At this checkpoint `from_snapshot` uses:

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

Use the same candidate-first ordering for `new`, sandbox/reset, and restore. Remove `#[derive(Clone)]` from `GameEngine`.

- [ ] **Step 3: Reconstruct sims only in explicit durable snapshot/save**

At this checkpoint:

```rust
pub fn snapshot(&self) -> GameSnapshot {
    let mut snapshot = self.snapshot.clone();
    snapshot.sims = population::snapshot_sims_v9(&self.world, snapshot.day);
    populate_service_metrics(&mut snapshot);
    snapshot
}
```

`snapshot_for_save` may call this. Ordinary tick/dispatch/presentation must not.

- [ ] **Step 4: Route ECS due demand through the existing trip pipeline**

Change `tick_trips` and `tick_trips_with_objectives` to accept `&mut World` and `&mut Schedule`.

At each current/substep timestamp:

1. apply due growth to the shell;
2. if buildings changed, call Task 3 reconciliation;
3. `population::run_due(world, schedule, state.time)`;
4. drain stable-sorted demands;
5. route each demand through a refactored `build_commute_trip` that takes citizen ID/purpose/origin/destination/scheduled time instead of `&Sim`;
6. continue existing active-trip/private-car/traffic behavior.

Use one mutable `RoadFlow` for the same-time demand batch so same-time car admission remains deterministic.

- [ ] **Step 5: Remove population scans from trip boundaries**

Delete `reset_daily_commute_flags`, `SIM_SHIFT_BOUNDARIES_PER_DAY`, `remaining_move_in_slots`, the sim loop in `next_boundary_after`, and sim-count cap widening.

Use `next_population_boundary` and `population_boundary_count_until` instead.

Guard:

```bash
rg 'state\.sims|snapshot\.sims|for sim in .*sims|sims\.len' crates/caelum-core/src/trips.rs
```

Expected: no matches.

- [ ] **Step 6: Feed terminal results to ECS and keep the temporary v9 adapter coherent**

Collect before terminal trips disappear:

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

For `Arrived | Late`, update settled position and schedule the next activity. For `Unserved`, preserve settled position and schedule recovery. Use each row's `resolved_at`.

Until Task 5 removes `LegacyDayState`, update it in the same resolution handler so `snapshot_sims_v9` preserves current save semantics:

- terminal outbound -> `outbound_resolved = true`;
- successful/late outbound -> also `outbound_arrived = true`;
- terminal return -> `return_resolved = true`;
- successful/late return -> also `returned_home = true`.

Delete `apply_arrival_to_sim` and `apply_commute_resolution_to_sim`.

- [ ] **Step 7: Reconcile applied player building mutations**

When an applied dispatch changes the building vector, call `reconcile_buildings` against candidate active trips/vehicles before installing the candidate shell. Rejected/no-op dispatches leave shell/world untouched. Pure previews stay snapshot-only.

- [ ] **Step 8: Add runtime population projection without changing HPA-544 wire**

Keep `presentation::project_update(&GameSnapshot, include_scene)` for durable snapshot tests/harness. Add:

```rust
pub(crate) fn project_runtime_update(
    snapshot: &GameSnapshot,
    world: &World,
    include_scene: bool,
) -> PresentationUpdate;
```

Factor one shared frame builder. Only population count/residential occupancy/job occupancy differ by source; all other HPA-544 fields reuse existing logic.

Change `GameplayUpdateResult` constructors to accept a precomputed `PresentationUpdate`:

```rust
pub fn present(update: PresentationUpdate) -> Self {
    Self { update, applied: true, rejection: None }
}

pub fn frame_only(update: PresentationUpdate, applied: bool) -> Self {
    Self { update, applied, rejection: None }
}

pub fn rejected(update: PresentationUpdate, rejection: GameplayRejection) -> Self {
    Self { update, applied: false, rejection: Some(rejection) }
}
```

Tick/dispatch/presentation uses `project_runtime_update` and never calls `snapshot()`.

- [ ] **Step 9: Remove `GameEngine::Clone` fixture dependency**

Replace test-only `engine.clone()` with independent fixture construction. When exact durable state is needed:

```rust
let durable = engine.snapshot();
let mut copy = GameEngine::from_snapshot(durable).expect("fixture snapshot is valid");
```

Set paused/running state explicitly in that test. Do not implement deep runtime clone.

Guard:

```bash
rg 'engine\.clone\(\)|derive\(Clone\).*GameEngine' crates/caelum-core src-tauri
```

Expected: no production clone contract.

- [ ] **Step 10: Verify existing behavior through the engine**

Pin/pass:

- paused housing does not move residents in;
- move-ins fill current catalog capacity;
- workplace capacity/reassignment remains stable;
- housing demolition removes residents/trips/passenger references;
- workplace demolition retargets/cancels affected outbound trips;
- existing commute/private-car lifecycle remains equivalent;
- presentation contains no sim rows and aggregate population/occupancy matches explicit durable snapshot.

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

Expected: PASS with ECS now live-authoritative; v9 exists only at explicit save/load adapter.

- [ ] **Step 11: Commit**

```bash
git add crates/caelum-core src-tauri/src/lib.rs
git commit -m "feat: make ECS the live population authority"
```

---

### Task 5: Replace the temporary adapter with final v10 scheduled routines and host persistence types

**Files:**
- Modify: `crates/caelum-core/src/model.rs`
- Modify: `crates/caelum-core/src/commute.rs`
- Modify: `crates/caelum-core/src/population/components.rs`
- Modify: `crates/caelum-core/src/population/schedule.rs`
- Modify: `crates/caelum-core/src/population/mod.rs`
- Modify: `crates/caelum-core/src/persistence/error.rs`
- Modify: `crates/caelum-core/src/persistence/trips.rs`
- Modify: `crates/caelum-core/src/persistence/entities.rs` as required by new sim-reference validation
- Modify: `crates/caelum-core/tests/common/persistence_fixtures.rs`
- Modify: all current Rust fixtures returned by the legacy-field guard below
- Modify: `src/domain/types.ts`
- Modify: `src/runtime/backend/types.ts`
- Modify: current host persistence/restore tests returned by the schema/type guard below

- [ ] **Step 1: Write exact v10 serde RED tests**

Add:

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

Also add serde round-trips for `CitizenRoutine::Student`, `TripPurpose::OptionalOutbound`, and `TripPurpose::OptionalReturn`. Confirm RED.

- [ ] **Step 2: Replace durable `Sim` directly and bump schema to 10**

Use exactly:

```rust
pub const SNAPSHOT_SCHEMA_VERSION: u16 = 10;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum CitizenRoutine {
    Worker {
        shift_template: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        workplace: Option<Point>,
    },
    Student,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ScheduledActivityKind {
    DailyRoutine,
    PrimaryReturn,
    OptionalReturn,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledActivity {
    pub kind: ScheduledActivityKind,
    pub due_time: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sim {
    pub id: String,
    pub home: Point,
    pub position: Point,
    pub routine: CitizenRoutine,
    pub next_activity: Option<ScheduledActivity>,
}
```

Final `TripPurpose` variants are `CommuteOutbound`, `CommuteReturn`, `OptionalOutbound`, `OptionalReturn`.

Delete `WorkerProfile` after this task migrates every caller. Do not add v9 serde aliases/defaults.

- [ ] **Step 3: Delete `LegacyDayState` and map runtime directly to v10**

Rename `build_world_v9` -> `build_world` and `snapshot_sims_v9` -> `snapshot_sims`.

`build_world` maps `CitizenRoutine` directly to runtime `Routine`, inserts optional durable `next_activity`, and schedules it. `snapshot_sims` maps runtime routine/next activity back to v10 and sorts by stable ID.

Update `GameEngine` to use final names. Remove every `LegacyDayState` update from Task 4.

- [ ] **Step 4: Add structured persistence rules for scheduled ownership**

In `SnapshotField`, remove obsolete sim worker/shift/commute/day-flag fields and add:

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

`validate_sims` must:

- validate home/position points;
- require home inside a placed housing building footprint, otherwise `InvalidAssignment` + `SimHomeNotResidential`;
- for worker workplace `Some`, require a placed building footprint whose catalog `job_capacity > 0`, otherwise `SimWorkplaceNotJob`;
- validate `next_activity.due_time` with existing `finite_non_negative` and `SimNextActivityDueTime`.

Build an active-sim ID set and enforce:

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

Use the existing structured error channel only.

- [ ] **Step 5: Add stable day-off/student/optional rules**

Replace `worker_profile_for_id` with:

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

Add a local deterministic SplitMix64-style mixer over citizen suffix/day/salt; do not add `rand`.

Pin tests for these exact rules:

- day off iff `day % 7 == numeric_id_suffix(id) % 7`;
- workers keep existing shift/departure rules;
- students choose among placed schools in stable building-ID order, outbound 07:30–08:30, return 15:00–16:00;
- no school -> no student primary trip that day;
- day off suppresses primary work/school trip;
- one in four eligible day-off citizens takes one optional outing;
- optional types: `supermarket`, `cinema`, `clinic`, `parkPlaza`;
- optional outbound window 11:00–15:00;
- successful optional arrival schedules return exactly 120 in-game minutes later;
- same citizen/day/city fixture produces identical destination/time in independent worlds.

- [ ] **Step 6: Implement final one-next-activity state machine**

`DailyRoutine` order:

1. if settled position != home, emit return-home first;
2. else on non-day-off emit assigned worker primary outbound or student primary outbound when school exists;
3. else evaluate optional outing;
4. else schedule next day's `DailyRoutine`.

Resolution rules:

- `Arrived | Late` primary outbound -> settle at destination; schedule `PrimaryReturn` at routine return time/current bucket if already passed;
- `Arrived | Late` optional outbound -> settle at destination; schedule `OptionalReturn` at `resolved_at + 120` in-game minutes;
- successful return -> settle at home; schedule next day's `DailyRoutine`;
- `Unserved` outbound -> preserve settled position; schedule next daily wake;
- `Unserved` return -> preserve settled position; schedule next daily wake so rule 1 retries home before any future outbound.

Do not retry a failed return inside the same bucket.

- [ ] **Step 7: Migrate Rust schema references as one breaking sweep**

Update shared persistence fixture first, then run:

```bash
rg -l 'WorkerProfile|worker_profile|commute_day|outbound_resolved_today|outbound_arrived_today|return_resolved_today|returned_home_today|build_world_v9|snapshot_sims_v9|LegacyDayState' crates/caelum-core
```

Migrate every result in this task; final guard must be empty. Update schema tests so v9 expects `UnsupportedSchema { expected: 10, actual: 9 }`.

- [ ] **Step 8: Update durable TypeScript host types exactly**

In `src/domain/types.ts`:

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

In `src/runtime/backend/types.ts`:

```ts
export interface RustSim extends Omit<Sim, "nextActivity"> {
  nextActivity: ScheduledActivity | null | undefined;
}
```

Set the TS schema mirror to 10. Do not add sims to live `GameState` or `PresentationUpdate`.

- [ ] **Step 9: Add v10 save/restore rejection/round-trip tests**

Cover:

- worker and student scheduled state save -> restore -> save normalized equality;
- active trip + next activity -> `scheduledWhileTraveling` rejection;
- idle sim without next activity -> `missingNextActivity` rejection;
- home outside housing -> `simHomeNotResidential` rejection;
- worker workplace on non-job building -> `simWorkplaceNotJob` rejection;
- normal presentation still has no `sims` key.

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

### Task 6: Prove the 200k runtime shape, update ownership docs, and run the full gate

**Files:**
- Modify: `crates/caelum-core/examples/presentation_scale.rs`
- Modify: `crates/caelum-core/tests/presentation_scale.rs`
- Modify: population/engine tests under `crates/caelum-core/src/`
- Modify: `docs/performance/hpa-347-ecs-population.md`
- Modify: `docs/architecture.md`
- Modify: `CLAUDE.md` if its runtime-ownership description is stale

- [ ] **Step 1: Extend the release harness with final runtime rows**

For labels `ecs-10000`, `ecs-50000`, `ecs-200000`, build v10 synthetic snapshots with stable citizen IDs and valid home/work building references, then construct `GameEngine::from_snapshot`. The scale fixture may intentionally place many synthetic citizens on one valid residential footprint because final persistence validates the home reference but does not enforce gameplay-produced occupancy capacity; document that this is a performance fixture.

Measure separately:

```text
runtime_build_us
quiet_tick_us
runtime_presentation_us
full_snapshot_us
```

For `wave-1000`, `wave-5000`, `wave-20000`, schedule exactly that many citizens in one bucket and separately measure:

```text
schedule_emit_us
route_spawn_us
```

Retain existing HPA-544 cardinality rows.

- [ ] **Step 2: Add structural 200k assertions without timing thresholds**

In private engine/population tests assert a 200k runtime has:

- `population_count == 200_000`;
- live `engine.snapshot.sims.is_empty()`;
- runtime presentation `population_count == 200_000`;
- quiet tick adds no active trip when every next activity is future;
- a due bucket containing exactly N citizens emits exactly N stable-sorted IDs while the other 200k-N citizens remain future-scheduled.

Do not expose production debug accessors just for these assertions.

- [ ] **Step 3: Record literal after-cutover evidence**

On the same reference machine as Task 0 run:

```bash
cargo run --release -p caelum-core --example presentation_scale
```

Append two exact-value tables to `docs/performance/hpa-347-ecs-population.md`:

1. `ecs-10000`, `ecs-50000`, `ecs-200000`: population, runtime build, quiet tick, runtime presentation, full snapshot;
2. `wave-1000`, `wave-5000`, `wave-20000`: due citizens, scheduler+emit, existing route spawn.

State whether route creation is now the dominant wave cost. If yes, explicitly name HPA-348 as owner. Do not create a new timing threshold from observed values.

- [ ] **Step 4: Update architecture ownership documentation**

Document final invariants:

- `GameEngine` owns shell + topology + ECS world/schedule;
- live shell sims are empty;
- explicit durable snapshot reconstructs v10 sims;
- time buckets wake only due citizens;
- HPA-544 presentation reads population aggregates from ECS;
- HPA-348 owns route-choice batching;
- HPA-640 owns WebGPU/viewport/LOD/cadence work.

Remove stale statements that call live `Vec<Sim>` the ticking authority.

- [ ] **Step 5: Run final source-shape guards**

```bash
rg 'state\.sims|snapshot\.sims|\.sims\.iter|\.sims\.len' crates/caelum-core/src
```

Expected: matches only in explicit durable/persistence/pure durable-presentation conversion paths; none in ordinary `trips.rs`, `buildings.rs`, or population-dependent `transit.rs` cleanup.

```bash
rg 'bevy::|bevy_app|multi_threaded|bevy_reflect|rand::' crates/caelum-core Cargo.toml
```

Expected: no prohibited dependency/feature usage.

```bash
rg 'bevy_ecs::.*Entity|\bEntity\b' crates/caelum-core/src/model.rs src/domain/types.ts src/runtime/backend/types.ts crates/caelum-core/src/presentation.rs
```

Expected: no Bevy entity handle in durable/public presentation types.

```bash
rg 'WorkerProfile|worker_profile|commute_day|outbound_resolved_today|outbound_arrived_today|return_resolved_today|returned_home_today|build_world_v9|snapshot_sims_v9|LegacyDayState' crates/caelum-core src tests
```

Expected: no legacy adapter/state references.

- [ ] **Step 6: Run the complete project gate**

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

Expected: all PASS; the release harness prints the values recorded in the performance document.

- [ ] **Step 7: Self-review spec coverage**

Run a marker guard without matching the guard expression itself:

```bash
rg 'T[B]D|T[O]DO|FILL[_]ME|REPLACE[_]ME' \
  docs/superpowers/specs/2026-09-04-ecs-latent-population-design.md \
  docs/superpowers/plans/2026-09-04-ecs-latent-population.md \
  docs/performance/hpa-347-ecs-population.md
```

Expected: no matches.

Read the design spec once more and map each acceptance item to a passing test, a harness row, or one source-shape guard. Fix interface-name drift rather than adding compatibility aliases.

- [ ] **Step 8: Commit evidence/docs and keep the same PR**

```bash
git add crates/caelum-core docs CLAUDE.md
git commit -m "docs: record HPA-347 ECS scale evidence"
```

Update this existing HPA-347 draft PR body from planning summary to implementation/evidence summary. Do not create another PR.
