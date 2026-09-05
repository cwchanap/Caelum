# HPA-347 ECS Latent Population Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move latent citizen/activity scheduling into a load-bearing standalone Bevy ECS world so Caelum can hold and advance about 200,000 citizens without scanning or cloning every citizen on ordinary simulation substeps, then add the ticket-required school/day-off/optional demand only after that migration is proven.

**Architecture:** `GameEngine` owns a `bevy_ecs::World` plus one explicitly ordered population `Schedule`. Its live `GameSnapshot` becomes the non-population shell (`sims` intentionally empty). ECS wakes only time-bucketed citizens and emits deterministic `TripDemand` rows into the existing route/private-car pipeline. Full `Sim[]` is reconstructed only for explicit durable snapshot/save operations; HPA-544 presentation reads population count/occupancy from ECS indexes without changing its wire shape.

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
- Use the final `ScheduledActivityKind` / `ScheduledActivity` types from Task 2 onward; do not create a temporary activity enum.
- Deterministic ordering is scheduler bucket -> canonical event order -> exact time -> stable citizen ID -> explicit purpose rank.
- Population system sets are explicitly chained `CollectDue -> ApplyDue -> EmitTripDemand`.
- A stale Bevy `Entity` event is dropped if the generational handle no longer exists; do not clone citizen-ID strings into every future scheduler event solely to guard against entity-slot reuse.
- `PopulationIndex` is derived and test-rebuildable. `NextCitizenOrdinal` is a separate monotonic allocator resource and is not part of derived-index equality.
- Wall-clock measurements are reference evidence, never CI thresholds.
- Tasks 1-4 use the current v9 `Sim` only as a branch-local save adapter while ECS is brought online. Task 5 removes that adapter completely; this is not a supported compatibility path.
- Task 4 is the Worker/NonWorker parity cutover. Student school trips, day-off suppression, and optional outings do not activate until Task 6, after the worker-only quiet-tick evidence gate.

---

### Task 0: Record the current high-cardinality tick baseline

**Files:**
- Modify: `crates/caelum-core/examples/presentation_scale.rs`
- Create: `docs/performance/hpa-347-ecs-population.md`

**Produces:** current 10k/50k/200k quiet-tick evidence on the HPA-544 reference harness.

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

Create `docs/performance/hpa-347-ecs-population.md` containing the literal machine/Rust output and one before-cutover table row for each 10k/50k/200k result. End the section with `Wall-clock values are reference evidence, not CI thresholds.`

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

- [ ] **Step 1: Add dependency/MSRV and compile native + real WASM targets immediately**

Add to `caelum-core`:

```toml
bevy_ecs = { version = "0.19.1", default-features = false, features = ["std"] }
```

Set `rust-version = "1.95"` in all three package manifests and run:

```bash
cargo check --workspace
bun run wasm:build
```

Expected: `Cargo.lock` records `bevy_ecs` 0.19.1, native workspace compilation succeeds, and the actual `wasm32-unknown-unknown` artifact builds before any ECS code depends on unsupported target assumptions.

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

- [ ] **Step 3: Add only runtime components needed by the migration**

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

`LegacyDayState` exists only through Task 4 so intermediate explicit v9 save snapshots remain testable. Task 5 deletes it.

- [ ] **Step 4: Add one derived `PopulationIndex` and separate allocator state**

```rust
#[derive(Resource, Default, Debug, PartialEq, Eq)]
pub(super) struct PopulationIndex {
    by_id: BTreeMap<String, Entity>,
    residents_by_building: BTreeMap<String, Vec<Entity>>,
    workers_by_building: BTreeMap<String, Vec<Entity>>,
    unassigned_workers: BTreeSet<String>,
    buildings: BTreeMap<String, PopulationBuilding>,
}

#[derive(Resource, Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct NextCitizenOrdinal(pub(super) usize);
```

`PopulationBuilding` contains only building ID/type/footprint and catalog resident/job capacities. Resolve v9 sim home/workplace points to building IDs during world construction.

Initialize `NextCitizenOrdinal` from `max(numeric_id_suffix(sim.id)) + 1`. It advances monotonically during the runtime and is intentionally excluded from index rebuild equality.

- [ ] **Step 5: Implement the v9 build/project adapter**

Map current rows as follows:

- `WorkerProfile::Worker` -> runtime Worker with current shift/workplace;
- `WorkerProfile::NonWorker` -> runtime Student identity, but Student emits no trip until Task 6;
- current daily flags -> `LegacyDayState`;
- home/workplace points -> runtime building assignments.

`snapshot_sims_v9` reverses that mapping and sorts by `Sim.id`. Never expose Bevy entity values.

- [ ] **Step 6: Add test-only index rebuild equality now**

In `population/mod.rs` tests, add a helper that rebuilds a fresh `PopulationIndex` from a full citizen-component query plus the current building list and compares it to the live resource.

Call it after initial world construction. Do not rebuild in production and do not include `NextCitizenOrdinal` in equality.

- [ ] **Step 7: Add a 200k structural world test and allocator monotonicity test**

Use the same spawn/index helper as `build_world_v9` to create 200,000 runtime citizens and assert:

```rust
assert_eq!(population_count(&world), 200_000);
assert_eq!(world.resource::<PopulationIndex>().by_id.len(), 200_000);
```

Then despawn the highest-ID test citizen and create one more through the allocator; assert the new stable ID uses a strictly greater ordinal rather than reusing the deleted runtime ordinal. No timing assertion.

- [ ] **Step 8: Verify and commit**

Run:

```bash
cargo fmt --all --check
cargo test -p caelum-core population::tests
cargo test --workspace
bun run wasm:build
```

Expected: PASS; `GameEngine` still uses snapshot population at this checkpoint.

Commit:

```bash
git add Cargo.lock crates/caelum-core crates/caelum-wasm/Cargo.toml src-tauri/Cargo.toml
git commit -m "feat: add indexed Bevy ECS population world"
```

---

### Task 2: Add final activity types, time buckets, and deterministic existing-commute demand emission

**Files:**
- Modify: `crates/caelum-core/src/model.rs`
- Modify: `crates/caelum-core/src/population/components.rs`
- Modify: `crates/caelum-core/src/population/schedule.rs`
- Modify: `crates/caelum-core/src/population/mod.rs`

**New seams:**

```rust
pub(crate) fn run_due(world: &mut World, schedule: &mut Schedule, now: f64);
pub(crate) fn drain_trip_demands(world: &mut World) -> Vec<TripDemand>;
pub(crate) fn next_population_boundary(world: &World, after: f64) -> Option<f64>;
pub(crate) fn population_boundary_count_until(world: &World, final_time: f64) -> usize;
```

- [ ] **Step 1: Introduce the final scheduled-activity types without changing schema v9**

Add to `model.rs` now:

```rust
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
```

These types are not yet fields on schema-v9 `Sim`, so this does not change the durable wire. Task 5 reuses these exact types in v10.

Change the runtime component to:

```rust
#[derive(Component, Clone, Debug, PartialEq)]
pub(super) struct NextActivity(pub(super) ScheduledActivity);
```

Do not create `ActivityKind`, `PrimaryOutbound`, or another temporary enum.

- [ ] **Step 2: Define scheduler/mailbox state**

```rust
const POPULATION_BUCKET_SECONDS: f64 = GAME_DAY_SECONDS / MINUTES_PER_DAY as f64;

#[derive(Resource, Default)]
pub(super) struct PopulationScheduler {
    buckets: BTreeMap<u64, Vec<PopulationEvent>>,
}

pub(super) enum PopulationEvent {
    Activity { entity: Entity },
}

pub(crate) struct TripDemand {
    pub(crate) citizen_id: String,
    pub(crate) purpose: TripPurpose,
    pub(crate) origin: Point,
    pub(crate) destination: Point,
    pub(crate) scheduled_time: f64,
}
```

Task 3 adds the `MoveIn` variant when move-ins leave `GameSnapshot`.

Bucket with `ceil(due_time / POPULATION_BUCKET_SECONDS)`: wakeup may be slightly late but never early; `TripDemand.scheduled_time` remains exact.

- [ ] **Step 3: Write RED due-only, stale-entity, and stable-order tests**

Create three workers due in buckets 10, 10, and 100. After bucket 10, demand IDs must be exactly `sim-001`, `sim-002`, and the future citizen must retain `NextActivity`.

Add a stale-handle regression:

1. schedule one citizen into a future bucket;
2. remove it from indexes and despawn its entity;
3. spawn another citizen before the bucket fires;
4. run the bucket;
5. assert no demand is emitted for the replacement from the stale event.

Do not assert any numeric `Entity` index reuse; the contract is only that the old generational handle cannot access a replacement.

Insert same-time activity events in reverse entity order in another test; `ApplyDue` resolves each live `CitizenId` and output remains stable-ID ordered.

- [ ] **Step 4: Configure one explicit schedule**

```rust
#[derive(SystemSet, Debug, Clone, PartialEq, Eq, Hash)]
enum PopulationSet {
    CollectDue,
    ApplyDue,
    EmitTripDemand,
}
```

Chain sets in that order.

- `CollectDue` drains scheduler keys through `PopulationClock.now`.
- Before `ApplyDue`, stale entities are dropped and live activity events are sorted by resolved `CitizenId`.
- `ApplyDue` touches only the surviving referenced entities.
- `EmitTripDemand` stable-sorts by exact due time, citizen ID, explicit purpose rank.

Do not add `App`, plugins, observers, or a second population schedule.

- [ ] **Step 5: Convert v9 daily flags into the final activity kinds once on load**

During `build_world_v9`:

- active trip for this sim -> no `NextActivity`;
- unresolved assigned Worker outbound whose departure is still eligible -> `DailyRoutine` at that existing departure time;
- successful outbound with unresolved return -> `PrimaryReturn` at the current existing return time;
- otherwise -> next day's `DailyRoutine`;
- NonWorker/Student identity -> next day's `DailyRoutine`, but Stage-A `DailyRoutine` produces no trip for it.

This conversion happens once on world construction; no new per-tick scan is allowed.

- [ ] **Step 6: Implement boundary helpers using scheduler keys only**

`next_population_boundary` finds the first populated bucket after the current timestamp. `population_boundary_count_until` counts populated keys through the final bucket. Neither queries citizens.

`run_due` reruns the schedule while processing creates another event in the already-current bucket and stops once no due key remains.

After every scheduler test run, call the Task-1 test-only index rebuild assertion.

- [ ] **Step 7: Verify and commit**

Run:

```bash
cargo test -p caelum-core population::schedule::tests
cargo test -p caelum-core population::tests
cargo test --workspace
```

Expected: PASS; production trip spawning is still old until Task 4.

Commit:

```bash
git add crates/caelum-core/src/model.rs crates/caelum-core/src/population
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
- Modify: `crates/caelum-core/src/growth.rs` tests for sandbox/campaign move-in parity

**New seam:**

```rust
pub(crate) fn reconcile_buildings(
    world: &mut World,
    game_mode: GameMode,
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
2. removing the employed house frees slots and surviving unassigned stable-ID workers fill them;
3. adding a workplace fills slots in stable citizen-ID order;
4. removing a workplace reassigns affected workers to the next stable free workplace before leaving them unassigned.

After every mutation, call the test-only index rebuild assertion from Task 1.

- [ ] **Step 2: Add sandbox-only delayed move-in tests**

Extend `PopulationEvent`:

```rust
pub(super) enum PopulationEvent {
    MoveIn { building_id: String, slot: u16 },
    Activity { entity: Entity },
}
```

Add tests proving:

- Sandbox capacity-4 housing reaches 1,2,3,4 residents at the existing move-in boundaries;
- the same housing added under `GameMode::Campaign` schedules zero `MoveIn` events and remains empty;
- campaign growth housing remains empty after its growth wave fires.

- [ ] **Step 3: Canonicalize same-bucket move-in order before allocation**

Before `ApplyDue`, sort drained events by category and stable key:

```text
MoveIn  -> (building_id, slot)
Activity -> resolved CitizenId
```

Add a two-house same-minute test that inserts the `MoveIn` events in reverse order and proves deterministic allocation:

```text
building-a slot 0 -> sim-001
building-b slot 0 -> sim-002
```

Do not let `Vec` insertion order decide `sim-NNN` identity.

- [ ] **Step 4: Use `NextCitizenOrdinal` for O(1) ID allocation**

A move-in rechecks building/slot existence, allocates `sim-{ordinal:03}`, increments `NextCitizenOrdinal`, spawns one citizen, assigns the first stable free workplace if applicable, updates indexes, and installs `DailyRoutine`.

Do not call `next_entity_id` over a population scan.

- [ ] **Step 5: Preserve the late-workplace-assignment guard explicitly**

When a previously unassigned Worker receives a workplace:

- if today's outbound departure is still in the future and the citizen is idle at home, its `DailyRoutine` may target that departure;
- if `now` is already meaningfully past today's departure, do not emit an immediate outbound and do not schedule a past bucket; keep/schedule the next eligible daily wake.

Add a regression matching the existing `commute_requirements` late-assignment behavior.

- [ ] **Step 6: Implement targeted building reconciliation**

Compare before/after building IDs and process only changed buildings:

- added housing -> schedule missing slots only in Sandbox;
- added workplace -> index slots + fill sorted unassigned workers with the late-assignment rule above;
- removed housing -> read `residents_by_building`, remove those entries from all indexes, despawn those entities, remove their active trips, scrub vehicle passenger IDs, free/refill workplace slots;
- removed workplace -> read `workers_by_building`, clear/reassign only those workers;
- affected outbound retarget -> set `Idle`, clear route/private-car, reset leg index/current-leg wait, restore `WAIT_PATIENCE_SECONDS`, reset deadline with `trip_deadline_seconds(now)`;
- if no replacement workplace exists, remove the outbound trip and schedule that citizen's next eligible `DailyRoutine`.

Do not scan every citizen in any removal path.

- [ ] **Step 7: Make pure snapshot building/removal helpers shell-only**

Remove population ownership from `buildings::assign_workplaces` callers and `transit.rs` resident/workplace cleanup. Keep generic route/vehicle cleanup.

Update direct `transit::remove_at_tile` tests to assert shell changes only. Final citizen behavior moves to `GameEngine` tests in Task 4. Delete `buildings::assign_workplaces` after its final caller is removed.

- [ ] **Step 8: Verify index consistency after all lifecycle paths**

Run the test-only full-query index rebuild assertion after:

- move-in;
- workplace assignment;
- housing removal;
- workplace removal;
- reassignment.

Test `NextCitizenOrdinal` separately; do not compare it to `max(live ID)+1` after deletions.

- [ ] **Step 9: Verify and commit**

Run:

```bash
cargo test -p caelum-core population::tests
cargo test -p caelum-core --test areas_buildings
cargo test -p caelum-core --test transit_build
cargo test -p caelum-core growth::tests
cargo test --workspace
```

Expected: PASS.

Commit:

```bash
git add crates/caelum-core/src/population crates/caelum-core/src/buildings.rs crates/caelum-core/src/transit.rs crates/caelum-core/src/growth.rs crates/caelum-core/tests
git commit -m "feat: reconcile population through ECS indexes"
```

---

### Task 4: Make ECS the live population authority for current Worker commute, retarget test seams, and prove the quiet-tick win

**Files:**
- Modify: `crates/caelum-core/src/engine.rs`
- Modify: `crates/caelum-core/src/intent.rs`
- Modify: `crates/caelum-core/src/trips.rs`
- Modify: `crates/caelum-core/src/presentation.rs`
- Modify: `crates/caelum-core/tests/common/mod.rs`
- Modify: `crates/caelum-core/tests/population.rs`
- Modify: `crates/caelum-core/tests/commute_requirements.rs`
- Modify: `crates/caelum-core/tests/trip_lifecycle.rs`
- Modify: `crates/caelum-core/tests/golden_sequences.rs`
- Modify: `crates/caelum-core/tests/shuttle_service.rs`
- Modify: `crates/caelum-core/tests/presentation_contract.rs`
- Modify: `crates/caelum-core/tests/presentation_scale.rs`
- Modify: `crates/caelum-core/tests/service_control.rs`
- Modify: `crates/caelum-core/src/growth.rs` module-test helper
- Modify: `src-tauri/src/lib.rs` test fixtures using `engine.clone()`
- Modify: `crates/caelum-core/examples/presentation_scale.rs`
- Modify: `docs/performance/hpa-347-ecs-population.md`

- [ ] **Step 1: Inventory every direct snapshot-tick caller before changing the signature**

Run:

```bash
rg -n 'tick_trips(_with_objectives)?\(' crates/caelum-core/src crates/caelum-core/tests crates/caelum-core/examples
```

Classify every current hit before editing. The known integration/module consumers include `golden_sequences.rs`, `shuttle_service.rs`, `trip_lifecycle.rs`, and `growth.rs` tests. Do not leave an accidental second production population path merely to keep old test call sites compiling.

- [ ] **Step 2: Write RED engine ownership/presentation tests**

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

- [ ] **Step 3: Cut constructors/restore to candidate-first ECS ownership**

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

- [ ] **Step 4: Reconstruct sims only in explicit durable snapshot/save**

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

- [ ] **Step 5: Route ECS due demand through the existing trip pipeline**

Change the internal trip tick core to accept `&mut World` and `&mut Schedule`; production `GameEngine::tick` owns those arguments.

At each current/substep timestamp:

1. apply due growth to the shell;
2. if buildings changed, call Task-3 reconciliation with the current `GameMode`;
3. `population::run_due(world, schedule, state.time)`;
4. drain stable-sorted demands;
5. route each demand through the existing/refactored `build_commute_trip(citizen_id, purpose, origin, destination, scheduled_time, ...)` path;
6. continue existing active-trip/private-car/traffic behavior.

Use one mutable `RoadFlow` for the same-time demand batch so same-time car admission remains deterministic.

- [ ] **Step 6: Remove population scans from trip boundaries**

Delete `reset_daily_commute_flags`, `SIM_SHIFT_BOUNDARIES_PER_DAY`, `remaining_move_in_slots`, the sim loop in `next_boundary_after`, and sim-count cap widening.

Use `next_population_boundary` and `population_boundary_count_until` instead.

Guard:

```bash
rg 'state\.sims|snapshot\.sims|for sim in .*sims|sims\.len' crates/caelum-core/src/trips.rs
```

Expected: no matches.

- [ ] **Step 7: Feed terminal results to ECS and keep the temporary v9 adapter coherent**

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

For `Arrived | Late`, update settled position and schedule the next activity. For `Unserved`, preserve settled position and schedule current recovery. Until Task 5 deletes `LegacyDayState`, update its current daily flags in the same handler so `snapshot_sims_v9` stays equivalent.

Delete `apply_arrival_to_sim` and `apply_commute_resolution_to_sim`.

- [ ] **Step 8: Preserve cross-midnight active-trip behavior explicitly**

Add a regression where a return trip is still active across the day boundary. Assert:

- the citizen has no `NextActivity` while travelling;
- `run_due` cannot emit a duplicate current-day outbound/return for that citizen;
- resolving the active trip schedules only the next valid activity;
- no home-to-home phantom completion is recorded.

This replaces reliance on the old all-sim stranded/active-trip scan.

- [ ] **Step 9: Reconcile applied player building mutations**

When an applied dispatch changes the building vector, call `reconcile_buildings` against candidate active trips/vehicles before installing the candidate shell. Rejected/no-op dispatches leave shell/world untouched. Pure previews stay snapshot-only.

- [ ] **Step 10: Add runtime population projection without changing HPA-544 wire**

Keep `presentation::project_update(&GameSnapshot, include_scene)` for durable snapshot tests/harness. Add:

```rust
pub(crate) fn project_runtime_update(
    snapshot: &GameSnapshot,
    world: &World,
    include_scene: bool,
) -> PresentationUpdate;
```

Factor one shared frame builder. Only population count/residential occupancy/job occupancy differ by source; all other HPA-544 fields reuse existing logic.

Change `GameplayUpdateResult` constructors to accept a precomputed `PresentationUpdate`; tick/dispatch/presentation must never call `snapshot()`.

- [ ] **Step 11: Retarget direct `tick_trips` tests without preserving a second production population path**

Reuse existing `tests/common::{strict_engine_from_fixture, running_engine_from_fixture}`. Add only a small helper for sandbox/current-runtime integration fixtures:

```rust
pub fn tick_running_fixture(snapshot: GameSnapshot, delta_seconds: f64) -> GameSnapshot {
    let mut engine = running_engine_from_fixture(snapshot);
    engine.tick(delta_seconds);
    engine.snapshot()
}
```

Use it in `golden_sequences.rs`, `shuttle_service.rs`, and the sandbox/no-objective `trip_lifecycle.rs` call sites.

For `growth.rs` unit tests that intentionally exercise trip ticking without objective evaluation, add a crate-private `#[cfg(test)]` adapter in `trips.rs` that builds the same ECS world/schedule and calls the same internal substep core with the no-objective callback. It exists only in the library test build.

For `trip_lifecycle.rs` objective-specific tests, keep the objective path through `GameEngine::tick` or an equivalent shared fixture helper; do not create another live population implementation.

Run the inventory command from Step 1 again and explicitly disposition every remaining direct caller.

- [ ] **Step 12: Remove `GameEngine::Clone` fixture dependency**

Replace test-only `engine.clone()` with independent fixture construction. When exact durable state is needed:

```rust
let durable = engine.snapshot();
let mut copy = GameEngine::from_snapshot(durable).expect("fixture snapshot is valid");
```

Set paused/running state explicitly in that test. Do not implement deep runtime clone.

- [ ] **Step 13: Verify current behavior before any new demand semantics**

Pin/pass:

- sandbox-only delayed move-in;
- campaign housing remains population-empty;
- late workplace assignment skips today's already-past departure;
- in-progress trip across midnight does not spawn a duplicate/phantom trip;
- workplace capacity/reassignment remains stable;
- housing demolition removes residents/trips/passenger references;
- workplace demolition retargets/cancels affected outbound trips;
- current Worker commute/private-car lifecycle remains equivalent;
- current NonWorker still emits no travel;
- presentation contains no sim rows and aggregate population/occupancy matches explicit durable snapshot.

Run:

```bash
cargo test -p caelum-core --test population
cargo test -p caelum-core --test commute_requirements
cargo test -p caelum-core --test trip_lifecycle
cargo test -p caelum-core --test golden_sequences
cargo test -p caelum-core --test shuttle_service
cargo test -p caelum-core --test presentation_contract
cargo test -p caelum-core --test presentation_scale
cargo test -p caelum-core --test service_control
cargo test -p caelum-core growth::tests
cargo test --workspace
```

Expected: PASS with ECS now live-authoritative; v9 exists only at explicit save/load adapter.

- [ ] **Step 14: Record the worker-only quiet-tick gate before Task 5/6 semantics**

Extend the native example with an ECS worker-only 200k quiet fixture. Measure the same quiet delta as Task 0 and append a `Stage A worker-only ECS cutover` row to `docs/performance/hpa-347-ecs-population.md`.

Run:

```bash
cargo run --release -p caelum-core --example presentation_scale
```

Required interpretation: record the literal value and confirm structurally that only scheduler bookkeeping occurs when no population event is due. Do not invent a pass/fail millisecond threshold.

Task 5 may proceed once the worker-only cutover is functionally green and this evidence row exists. New student/day-off/optional demand remains disabled.

- [ ] **Step 15: Commit**

```bash
git add crates/caelum-core src-tauri/src/lib.rs docs/performance/hpa-347-ecs-population.md
git commit -m "feat: make ECS the live population authority"
```

---

### Task 5: Replace the temporary adapter with final v10 scheduled persistence while preserving Stage-A demand behavior

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

Add a worker fixture using the existing Task-2 `ScheduledActivity` and assert:

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

Also add a serde round-trip for `CitizenRoutine::Student`. Do not add optional-purpose behavior tests yet.

- [ ] **Step 2: Replace durable `Sim` directly and bump schema to 10**

Use:

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

Reuse `ScheduledActivityKind` / `ScheduledActivity` from Task 2 unchanged.

At this checkpoint keep `TripPurpose` as the existing `CommuteOutbound` / `CommuteReturn`; optional purpose variants arrive with Task 6 when optional demand is activated.

Delete `WorkerProfile` after this task migrates every caller. Do not add v9 serde aliases/defaults.

- [ ] **Step 3: Delete `LegacyDayState` and map runtime directly to v10**

Rename `build_world_v9` -> `build_world` and `snapshot_sims_v9` -> `snapshot_sims`.

`build_world` maps `CitizenRoutine` directly to runtime `Routine`, inserts optional durable `next_activity`, and schedules it. `snapshot_sims` maps runtime routine/next activity back to v10 and sorts by stable ID.

Update `GameEngine` to use final names. Remove every `LegacyDayState` update from Task 4.

Student is the persisted rename of current NonWorker at this checkpoint and still emits no primary trip.

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
- for Worker workplace `Some`, require a placed building footprint whose catalog `job_capacity > 0`, otherwise `SimWorkplaceNotJob`;
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

- [ ] **Step 5: Migrate Rust schema references as one breaking sweep**

Update shared persistence fixture first, then run:

```bash
rg -l 'WorkerProfile|worker_profile|commute_day|outbound_resolved_today|outbound_arrived_today|return_resolved_today|returned_home_today|build_world_v9|snapshot_sims_v9|LegacyDayState' crates/caelum-core
```

Migrate every result in this task; final guard must be empty. Update schema tests so v9 expects `UnsupportedSchema { expected: 10, actual: 9 }`.

- [ ] **Step 6: Update durable TypeScript host types exactly**

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
```

Keep `TripPurpose` unchanged in this task.

In `src/runtime/backend/types.ts`:

```ts
export interface RustSim extends Omit<Sim, "nextActivity"> {
  nextActivity: ScheduledActivity | null | undefined;
}
```

Set the TS schema mirror to 10. Do not add sims to live `GameState` or `PresentationUpdate`.

- [ ] **Step 7: Add v10 save/restore rejection/round-trip tests**

Cover:

- Worker and Student scheduled state save -> restore -> save normalized equality;
- active trip + next activity -> `scheduledWhileTraveling` rejection;
- idle sim without next activity -> `missingNextActivity` rejection;
- home outside housing -> `simHomeNotResidential` rejection;
- Worker workplace on non-job building -> `simWorkplaceNotJob` rejection;
- normal presentation still has no `sims` key;
- Student still produces no trip at this checkpoint.

- [ ] **Step 8: Verify real WASM again at the breaking persistence boundary**

Run:

```bash
cargo fmt --all --check
cargo test --workspace
bun run wasm:build:release
bun run check
bun run test:unit
```

Expected: PASS with v10 only and Stage-A travel semantics unchanged.

- [ ] **Step 9: Commit**

```bash
git add crates/caelum-core crates/caelum-wasm src src-tauri tests Cargo.lock
git commit -m "feat: persist scheduled ECS citizen routines"
```

---

### Task 6: Activate HPA-347 student, day-off, and optional demand after the migration gate

**Files:**
- Modify: `crates/caelum-core/src/model.rs`
- Modify: `crates/caelum-core/src/commute.rs`
- Modify: `crates/caelum-core/src/population/schedule.rs`
- Modify: `crates/caelum-core/src/population/mod.rs`
- Modify: `crates/caelum-core/src/transit_income.rs` tests only unless an actual regression requires production change
- Modify: `crates/caelum-core/tests/commute_requirements.rs`
- Modify: `crates/caelum-core/tests/trip_lifecycle.rs`
- Modify: deterministic/golden tests whose expected demand intentionally changes
- Modify: `src/domain/types.ts`
- Modify: `src/runtime/backend/types.ts` only if `TripPurpose` mirrors there directly

- [ ] **Step 1: Add optional purpose variants and deterministic seed helper**

Extend `TripPurpose`:

```rust
pub enum TripPurpose {
    CommuteOutbound,
    CommuteReturn,
    OptionalOutbound,
    OptionalReturn,
}
```

Add the matching TypeScript union values.

Add a local deterministic integer mixer over `numeric_id_suffix(id)`, day, and salt in `commute.rs`; do not add `rand`.

- [ ] **Step 2: Write RED routine-expansion tests before changing scheduling behavior**

Pin these exact rules:

- day off iff `day % 7 == numeric_id_suffix(id) % 7`;
- Workers keep existing shift/departure windows on non-day-off days;
- Students choose among placed schools in stable building-ID order, outbound 07:30–08:30 and return 15:00–16:00;
- no school -> no Student primary trip that day;
- day off suppresses primary Worker/Student trip;
- one in four eligible day-off citizens takes at most one optional outing;
- optional building types are `supermarket`, `cinema`, `clinic`, `parkPlaza`;
- optional outbound window 11:00–15:00;
- successful optional arrival schedules `OptionalReturn` exactly 120 in-game minutes later;
- same citizen/day/city fixture produces identical destination/time in independent worlds.

- [ ] **Step 3: Implement final `DailyRoutine` behavior**

Order:

1. if settled position != home, emit return-home before any new outbound routine;
2. else if not day off, emit assigned Worker primary outbound or Student school primary outbound when possible;
3. else evaluate one optional outing;
4. else schedule next day's `DailyRoutine`.

Resolution rules:

- `Arrived | Late` primary outbound -> settle at destination; schedule `PrimaryReturn` at routine return time/current bucket if already passed;
- `Arrived | Late` optional outbound -> settle at destination; schedule `OptionalReturn` at `resolved_at + 120` in-game minutes;
- successful return -> settle at home; schedule next day's `DailyRoutine`;
- `Unserved` outbound -> preserve settled position; schedule next daily wake;
- `Unserved` return -> preserve settled position; schedule next daily wake so the away-from-home rule retries home before any future outbound.

Do not retry a failed return inside the same bucket.

- [ ] **Step 4: Make the transit-income consequence explicit rather than accidental**

`completed_transit_trip_income` is currently purpose-agnostic. Do not add a second fare model in HPA-347.

Extend its test fixture so `OptionalOutbound` and Student-primary `CommuteOutbound` completed via Bus/Metro receive the same existing `$200` as other completed transit journeys. This is a characterization of the existing journey rule, not a new pricing subsystem.

- [ ] **Step 5: Re-run migration-parity guards plus the intentionally changed golden demand tests**

Keep the following unchanged even after new demand activates:

- sandbox-only move-in;
- late workplace assignment;
- cross-midnight active-trip protection;
- finite workplace assignment;
- route/private-car planning mechanics;
- HPA-544 presentation wire.

Update only golden/commute expectations whose trip counts/times intentionally change because day-off/student/optional demand is now part of HPA-347.

- [ ] **Step 6: Verify and commit**

Run:

```bash
cargo test -p caelum-core population::tests
cargo test -p caelum-core population::schedule::tests
cargo test -p caelum-core --test commute_requirements
cargo test -p caelum-core --test trip_lifecycle
cargo test -p caelum-core --test golden_sequences
cargo test -p caelum-core transit_income::tests
cargo test --workspace
bun run wasm:build:release
bun run check
bun run test:unit
```

Expected: PASS with the ticket-required new demand now active.

Commit:

```bash
git add crates/caelum-core src tests
git commit -m "feat: add deterministic citizen routine demand"
```

---

### Task 7: Prove the final 200k runtime shape, update ownership docs, and run the full gate

**Files:**
- Modify: `crates/caelum-core/examples/presentation_scale.rs`
- Modify: `crates/caelum-core/tests/presentation_scale.rs`
- Modify: population/engine tests under `crates/caelum-core/src/`
- Modify: `docs/performance/hpa-347-ecs-population.md`
- Modify: `docs/architecture.md`
- Modify: `CLAUDE.md` if its runtime-ownership description is stale

- [ ] **Step 1: Extend the release harness with final runtime rows**

For labels `ecs-10000`, `ecs-50000`, `ecs-200000`, build v10 synthetic snapshots with stable citizen IDs and valid home/work building references, then construct `GameEngine::from_snapshot`.

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

Retain existing HPA-544 cardinality rows and the Task-4 Stage-A worker-only row.

- [ ] **Step 2: Add structural 200k assertions without timing thresholds**

In private engine/population tests assert a 200k runtime has:

- `population_count == 200_000`;
- live `engine.snapshot.sims.is_empty()`;
- runtime presentation `population_count == 200_000`;
- quiet tick adds no active trip when every next activity is future;
- a due bucket containing exactly N citizens emits exactly N stable-sorted IDs while the other 200k-N citizens remain future-scheduled.

Do not expose production debug accessors just for these assertions.

- [ ] **Step 3: Run index-consistency tests over representative mutations at scale shape**

The test-only rebuild equality must already cover all mutation types. Add one mixed fixture that performs:

1. due move-ins;
2. workplace addition/reassignment;
3. housing removal;
4. workplace removal;
5. another scheduler run;

and assert rebuilt `PopulationIndex == live PopulationIndex` after every step. Assert `NextCitizenOrdinal` separately remains monotonic.

- [ ] **Step 4: Record literal final evidence**

On the same reference machine as Task 0 run:

```bash
cargo run --release -p caelum-core --example presentation_scale
```

Append exact-value tables:

1. Stage-A worker-only quiet tick;
2. final 10k/50k/200k runtime build / quiet tick / runtime presentation / full snapshot;
3. 1k/5k/20k due scheduler+emit vs existing route-spawn cost.

State whether route creation is now the dominant wave cost. If yes, explicitly name HPA-348 as owner. Do not create a timing threshold from observed values.

- [ ] **Step 5: Update architecture ownership documentation**

Document final invariants:

- `GameEngine` owns shell + topology + ECS world/schedule;
- live shell sims are empty;
- explicit durable snapshot reconstructs v10 sims;
- time buckets wake only due citizens;
- scheduler stale `Entity` handles drop safely because the handle is generational and missing entities are ignored;
- `PopulationIndex` is derived/test-rebuildable while `NextCitizenOrdinal` is allocator state;
- HPA-544 presentation reads population aggregates from ECS;
- HPA-348 owns route-choice batching;
- HPA-640 owns WebGPU/viewport/LOD/cadence work.

Remove stale statements that call live `Vec<Sim>` the ticking authority.

- [ ] **Step 6: Run final source-shape guards**

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

Run the direct-tick inventory one final time:

```bash
rg -n 'tick_trips(_with_objectives)?\(' crates/caelum-core/src crates/caelum-core/tests
```

Expected: only the internal runtime core and deliberate crate-test adapter remain; integration tests use `GameEngine`-backed helpers.

- [ ] **Step 7: Run the complete project gate**

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

- [ ] **Step 8: Self-review spec coverage**

Run:

```bash
rg 'T[B]D|T[O]DO|FILL[_]ME|REPLACE[_]ME' \
  docs/superpowers/specs/2026-09-04-ecs-latent-population-design.md \
  docs/superpowers/plans/2026-09-04-ecs-latent-population.md \
  docs/performance/hpa-347-ecs-population.md
```

Expected: no matches.

Map each spec acceptance item to a passing test, a harness row, or one source-shape guard. Fix interface-name drift rather than adding compatibility aliases.

- [ ] **Step 9: Commit evidence/docs and keep the same PR**

```bash
git add crates/caelum-core docs CLAUDE.md
git commit -m "docs: record HPA-347 ECS scale evidence"
```

Update this existing HPA-347 draft PR body from planning summary to implementation/evidence summary. Do not create another PR.
