# HPA-347 ECS Latent Population Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move latent citizen scheduling into a load-bearing standalone Bevy ECS world so Caelum can hold and advance about 200,000 citizens without scanning or cloning every citizen on ordinary substeps, prove current Worker behavior first, then add the ticket-required school/day-off/optional demand on the same PR.

**Architecture:** `GameEngine` will own `GameSnapshot` shell state, `RoadTopology`, a `bevy_ecs::World`, and one explicitly ordered population `Schedule`. The live shell keeps `sims` empty; ECS is the sole live citizen owner. A sparse exact-time event map wakes only due citizens and emits stable `TripDemand` rows into the existing routing/trip pipeline. One presentation projector consumes `PopulationAggregates` built either from durable sims or ECS indexes.

**Tech Stack:** Rust 1.95+, `bevy_ecs` 0.19.1 (`default-features = false`, `std` only), serde/serde_json, existing Caelum router/transit/traffic modules, Bun/WASM/Playwright host gates.

**Spec:** `docs/superpowers/specs/2026-09-04-ecs-latent-population-design.md`

## Global constraints

- One HPA-347 PR only. Stage A and Stage B are internal commit/review gates on PR #56.
- Add only `bevy_ecs = { version = "0.19.1", default-features = false, features = ["std"] }`.
- Set `rust-version = "1.95"` in `caelum-core`, `caelum-wasm`, and `src-tauri`.
- Do not add full `bevy`, `bevy_app`, reflection/serialization, async executor, `multi_threaded`, or `rand`.
- Final live population authority is ECS only; never finish with a mirrored runtime `GameSnapshot.sims`.
- Stable Caelum string IDs are durable; Bevy `Entity` is runtime-only and never serialized/presented.
- Keep route graphs, route choice, active-trip movement, traffic aggregation, economy, catalogs, and HPA-544 presentation outside ECS.
- Route choice remains sequential; HPA-348 owns batching it.
- Final durable schema is v10; reject v9 rather than writing a migration layer.
- Determinism uses exact due timestamp -> event kind/stable domain ID -> explicit purpose rank, never entity/index insertion order.
- Population system sets are explicitly chained `CollectDue -> ApplyDue -> EmitTripDemand`.
- Preserve coarse-tick/fine-tick equivalence.
- Wall-clock and WASM-size measurements are evidence, never thresholds.
- Tasks 1-5 may use current v9 `Sim` as a branch-local adapter. Task 6 deletes the adapter completely.
- Tasks 1-3 intentionally do not run `clippy -D warnings`: their new module-private/crate-private seams are staged before their production callers land. Do not add temporary `allow(dead_code)` attributes. Task 5 makes the seams live and runs full clippy; Tasks 6-8 keep it green.

## Risks

- **Shell/ECS partial commit:** solve by treating shell + world as one tick commit and tracking `population_changed` separately from shell equality.
- **New scheduler boundaries after cap calculation:** scheduler counts newly created exact-time keys; the trip driver widens its cap as they appear.
- **Floating bucket drift:** no quotient/minute bucketing; exact finite due timestamps are BTree keys ordered with `f64::total_cmp`.
- **Index drift:** rebuild derived index from ECS in tests after every mutation class and compare; allocator state stays separate.
- **Test migration cost:** move direct tick loops to one `GameEngine` per branch/scenario before live cutover.
- **WASM dependency cost:** build the actual release WASM target when `bevy_ecs` lands and record bytes before/after.

---

### Task 0: Record the pre-ECS tick and WASM baseline

**Files:**
- Modify: `crates/caelum-core/examples/presentation_scale.rs`
- Create: `docs/performance/hpa-347-ecs-population.md`

**Produces:** current 10k/50k/200k quiet-tick values and release WASM byte size on one reference machine.

- [ ] **Step 1: Add current-runtime population tick measurement**

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

Call it for the existing 10k, 50k, and 200k synthetic sim fixtures using a small delta that does not intentionally cross a commute departure.

- [ ] **Step 2: Build the current release WASM and capture literal bytes**

Run:

```bash
bun run wasm:build:release
wc -c src/generated/caelum_wasm/caelum_wasm_bg.wasm
uname -a
rustc --version
cargo run --release -p caelum-core --example presentation_scale
```

Record the literal `wc -c` value as **Before HPA-347 release WASM bytes**. Do not reuse the dev artifact size.

- [ ] **Step 3: Create the evidence document**

Write `docs/performance/hpa-347-ecs-population.md` with:

- command list above;
- exact OS / CPU / Rust / build mode;
- 10k/50k/200k current quiet-tick values;
- release WASM bytes;
- statement: `Wall-clock and artifact-size values are reference evidence, not CI thresholds.`

The committed file contains literal values from the run, not placeholders.

- [ ] **Step 4: Verify and commit**

Run:

```bash
cargo test -p caelum-core --lib
cargo run --release -p caelum-core --example presentation_scale
```

Expected: PASS; original HPA-544 rows remain plus the three tick rows.

Commit:

```bash
git add crates/caelum-core/examples/presentation_scale.rs docs/performance/hpa-347-ecs-population.md
git commit -m "perf: record HPA-347 population baseline"
```

---

### Task 1: Add standalone Bevy ECS, population components, and derived indexes

**Files:**
- Modify: `crates/caelum-core/Cargo.toml`
- Modify: `crates/caelum-wasm/Cargo.toml`
- Modify: `src-tauri/Cargo.toml`
- Modify: `Cargo.lock`
- Move: `crates/caelum-core/src/population.rs` -> `crates/caelum-core/src/population/mod.rs`
- Create: `crates/caelum-core/src/population/components.rs`
- Create: `crates/caelum-core/src/population/schedule.rs`
- Modify: `crates/caelum-core/src/population/mod.rs`

**Interfaces introduced for later tasks:**

```rust
pub(crate) fn build_world_v9(snapshot: &GameSnapshot) -> World;
pub(crate) fn snapshot_sims_v9(world: &World, day: u32) -> Vec<Sim>;
pub(crate) fn population_count(world: &World) -> u32;
pub(crate) fn resident_occupancy_for_building(world: &World, building_id: &str) -> u32;
pub(crate) fn job_occupancy_for_building(world: &World, building_id: &str) -> u32;
```

- [ ] **Step 1: Add dependency/MSRV and verify the real WASM target immediately**

Set the package floor to `1.95` in all three manifests and add:

```toml
bevy_ecs = { version = "0.19.1", default-features = false, features = ["std"] }
```

Run:

```bash
cargo check --workspace
bun run wasm:build:release
```

Expected: both PASS. This is the first compatibility gate for `bevy_ecs` on `wasm32-unknown-unknown`.

- [ ] **Step 2: Move the existing population module without changing behavior**

Move `population.rs` to `population/mod.rs`, preserve current functions, and make `lib.rs` module registration continue to compile.

Run:

```bash
cargo test -p caelum-core population::
```

Expected: current tests PASS before ECS data is added.

- [ ] **Step 3: Define focused runtime components**

`components.rs` contains:

```rust
use bevy_ecs::prelude::*;
use crate::model::{Point, ScheduledActivity};

#[derive(Component, Clone, Debug, PartialEq, Eq)]
pub(super) struct CitizenId(pub(super) String);

#[derive(Component, Clone, Debug, PartialEq)]
pub(super) struct HomeAssignment {
    pub(super) building_id: Option<String>,
    pub(super) point: Point,
}

#[derive(Clone, Debug, PartialEq)]
pub(super) struct BuildingAssignment {
    pub(super) building_id: Option<String>,
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
pub(super) struct NextActivity(pub(super) ScheduledActivity);
```

For the temporary v9 adapter only, keep one `LegacyDayState` component carrying the five current day/arrival flags. Task 6 deletes it.

`building_id: None` is allowed for legacy/unit fixtures whose point does not resolve to a real population building. HPA-347 does not add stricter home/workplace persistence hardening solely to make ECS indexes work; gameplay-produced citizens still resolve to real buildings.

- [ ] **Step 4: Add rebuildable derived index and separate monotonic allocator**

Define:

```rust
#[derive(Resource, Clone, Debug, Default, PartialEq)]
pub(super) struct PopulationIndex {
    by_id: BTreeMap<String, Entity>,
    residents_by_building: BTreeMap<String, Vec<Entity>>,
    workers_by_building: BTreeMap<String, Vec<Entity>>,
    unassigned_workers: BTreeSet<String>,
    buildings: BTreeMap<String, PopulationBuilding>,
}

#[derive(Resource, Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct NextCitizenOrdinal(pub(super) usize);
```

Initialize `NextCitizenOrdinal` once from `max(numeric_id_suffix(sim.id)) + 1`; never recompute it after despawn.

- [ ] **Step 5: Write RED then GREEN v9 round-trip/index tests**

Add tests requiring:

```rust
#[test]
fn ecs_world_round_trips_current_durable_sims_in_stable_id_order() {
    let snapshot = population_fixture();
    let world = build_world_v9(&snapshot);
    assert_eq!(population_count(&world), snapshot.sims.len() as u32);
    assert_eq!(snapshot_sims_v9(&world, snapshot.day), snapshot.sims);
}

#[test]
fn allocator_does_not_reuse_a_deleted_highest_id() {
    let snapshot = population_fixture();
    let mut world = build_world_v9(&snapshot);
    let before = world.resource::<NextCitizenOrdinal>().0;
    despawn_highest_fixture_citizen(&mut world);
    assert_eq!(world.resource::<NextCitizenOrdinal>().0, before);
}
```

Implement the minimum world construction/projection needed to make them green. Durable projection never includes `Entity`.

- [ ] **Step 6: Add test-only full index rebuild equality**

Implement under `#[cfg(test)]`:

```rust
fn rebuilt_index(world: &mut World) -> PopulationIndex;
```

It reconstructs all derived index fields from ECS components + `PopulationBuilding` data, but never reconstructs `NextCitizenOrdinal`.

Assert equality immediately after `build_world_v9`.

- [ ] **Step 7: Add a 200k structural construction test**

Use the same spawn/index helper to create 200,000 citizens and assert only cardinality/index consistency. No duration assertion.

- [ ] **Step 8: Verify staged code and commit**

Run:

```bash
cargo fmt --all --check
cargo test -p caelum-core population::tests
cargo check --workspace
bun run wasm:build:release
```

Do not run `clippy -D warnings` yet; staged production callers land in Task 5.

Commit:

```bash
git add Cargo.lock crates/caelum-core crates/caelum-wasm/Cargo.toml src-tauri/Cargo.toml
git commit -m "feat: add indexed Bevy ECS population world"
```

---

### Task 2: Add exact-time scheduling for current Worker commute

**Files:**
- Modify: `crates/caelum-core/src/population/schedule.rs`
- Modify: `crates/caelum-core/src/population/mod.rs`
- Modify: `crates/caelum-core/src/model.rs` only to expose the final activity kind internally before v10 serialization replaces the old `Sim`

**Interfaces introduced:**

```rust
pub(crate) fn build_schedule() -> Schedule;
pub(crate) fn run_due(world: &mut World, schedule: &mut Schedule, now: f64) -> PopulationRunResult;
pub(crate) fn drain_trip_demands(world: &mut World) -> Vec<TripDemand>;
pub(crate) fn next_population_boundary(world: &World, now: f64) -> Option<f64>;
pub(crate) fn scheduler_boundary_generation(world: &World) -> u64;
```

- [ ] **Step 1: Define the final activity kinds once**

Use from the start:

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

No `PrimaryOutbound` temporary enum exists. `DailyRoutine` decides whether a Worker outbound is due.

- [ ] **Step 2: Replace quotient buckets with an exact ordered timestamp key**

Implement:

```rust
#[derive(Clone, Copy, Debug)]
struct ScheduledTime(f64);

impl ScheduledTime {
    fn new(value: f64) -> Self {
        debug_assert!(value.is_finite() && value >= 0.0);
        Self(if value == 0.0 { 0.0 } else { value })
    }
}

impl PartialEq for ScheduledTime {
    fn eq(&self, other: &Self) -> bool {
        self.0.total_cmp(&other.0).is_eq()
    }
}

impl Eq for ScheduledTime {}

impl PartialOrd for ScheduledTime {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for ScheduledTime {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.0.total_cmp(&other.0)
    }
}
```

Define scheduler state:

```rust
#[derive(Resource, Default)]
struct PopulationScheduler {
    buckets: BTreeMap<ScheduledTime, Vec<PopulationEvent>>,
    boundary_generation: u64,
}
```

Increment `boundary_generation` only when inserting into a previously vacant exact-time key.

- [ ] **Step 3: Define events/mailboxes and explicit schedule sets**

```rust
enum PopulationEvent {
    MoveIn { building_id: String, slot: u16 },
    Activity { entity: Entity },
}

#[derive(Resource, Default)]
struct DuePopulationEvents(Vec<(f64, PopulationEvent)>);

#[derive(Resource, Default)]
struct PendingTripDemands(Vec<TripDemand>);

#[derive(SystemSet, Debug, Clone, PartialEq, Eq, Hash)]
enum PopulationSet {
    CollectDue,
    ApplyDue,
    EmitTripDemand,
}
```

Configure the three sets with `.chain()` in that order.

- [ ] **Step 4: Canonicalize same-time events before applying them**

For each drained exact timestamp:

- MoveIn sorts before Activity;
- MoveIn sorts by `(building_id, slot)`;
- Activity resolves its current `CitizenId` and sorts by that ID;
- stale entity handles that no longer resolve are dropped.

Add a two-house same-timestamp test proving IDs allocate by building ID + slot regardless of insertion order.

- [ ] **Step 5: Pin generational stale-handle behavior**

Write a test that:

1. schedules an `Activity` for citizen A in the future;
2. despawns A;
3. spawns citizen B;
4. advances to A's old due timestamp;
5. asserts B emits no demand and A's stale event is dropped.

Do not depend on the replacement receiving the same entity index; the assertion is semantic.

- [ ] **Step 6: Convert current v9 daily state into final scheduler kinds once on load**

During `build_world_v9`:

- active trip exists -> no `NextActivity`;
- Worker outbound unresolved and not late-assigned -> `DailyRoutine` at current existing departure timestamp;
- Worker outbound arrived, return unresolved -> `PrimaryReturn` at current existing return timestamp;
- otherwise assigned Worker -> next day's `DailyRoutine`;
- current NonWorker -> next day's `DailyRoutine` that emits no trip in Stage A.

No per-tick population scan is used after construction.

- [ ] **Step 7: Expose exact next boundary and run-until-current closure**

`run_due` drains keys with exact time in the current due/equality band, runs the chained schedule, and repeats if processing created another event already due now.

`next_population_boundary` returns the earliest exact remaining scheduler key; do not reconstruct it through clock-minute arithmetic.

- [ ] **Step 8: Stable-sort demands**

Before `drain_trip_demands` returns, sort by exact scheduled time, citizen ID, and an explicit purpose-rank match. Do not sort by entity handle or enum discriminant cast.

- [ ] **Step 9: Assert index rebuild parity after due processing**

After `run_due` mutation tests, compare live `PopulationIndex` with `rebuilt_index`.

- [ ] **Step 10: Verify and commit**

Run:

```bash
cargo fmt --all --check
cargo test -p caelum-core population::schedule::tests
cargo test -p caelum-core population::tests
cargo check --workspace
```

Do not run clippy yet for staged dead-code reasons documented globally.

Commit:

```bash
git add crates/caelum-core/src/population crates/caelum-core/src/model.rs
git commit -m "feat: schedule ECS population by exact due time"
```

---

### Task 3: Move housing/workplace lifecycle into targeted ECS reconciliation

**Files:**
- Modify: `crates/caelum-core/src/population/mod.rs`
- Modify: `crates/caelum-core/src/population/schedule.rs`
- Modify: `crates/caelum-core/src/buildings.rs`
- Modify: `crates/caelum-core/src/transit.rs`
- Modify: `crates/caelum-core/tests/population.rs`
- Modify: `crates/caelum-core/tests/areas_buildings.rs`
- Modify: `crates/caelum-core/tests/transit_build.rs`

**Interface introduced:**

```rust
pub(crate) fn reconcile_buildings(
    world: &mut World,
    before: &GameSnapshot,
    after: &mut GameSnapshot,
) -> PopulationMutation;
```

- [ ] **Step 1: Write RED lifecycle-order tests**

Pin:

1. two four-resident houses + four job slots -> 8 residents, exactly 4 assigned;
2. a lower-ID Worker already unassigned receives a freed job before a higher-ID Worker cleared by workplace removal;
3. added workplace fills from the global unassigned set in stable citizen-ID order;
4. removing housing removes only residents owned by that housing and scrubs their trips/passenger IDs.

- [ ] **Step 2: Make move-ins Sandbox-only and exact-time**

For added/existing Sandbox housing, schedule each unoccupied slot at:

```rust
let due_time = building.placed_at
    + f64::from(slot) * MOVE_IN_INTERVAL_SECONDS;
```

Campaign reconciliation must not schedule resident move-ins. Add/retain a campaign growth assertion where houses appear and population remains zero.

- [ ] **Step 3: Allocate citizen IDs without scanning**

Use `NextCitizenOrdinal`, format through existing `ids::entity_id("sim", ordinal)`, increment monotonically, never reuse deleted IDs.

- [ ] **Step 4: Preserve global workplace allocation order**

When a workplace disappears:

1. clear its assigned Workers;
2. insert those IDs into the existing global `unassigned_workers` BTreeSet;
3. expose all free workplace slots in stable building-ID/slot order;
4. assign from the globally lowest unassigned IDs.

Do not preferentially process only the just-cleared workers.

- [ ] **Step 5: Preserve late-assignment and cross-midnight guards**

Add tests proving:

- a Worker assigned after today's departure does not get a retroactive outbound;
- an active cross-midnight trip leaves the citizen without `NextActivity` and cannot be woken by `CollectDue`;
- a stranded citizen without an active trip schedules recovery rather than a zero-distance phantom outbound.

- [ ] **Step 6: Retarget/drop affected outbound trips with existing reset semantics**

For a removed destination and replacement workplace:

```rust
trip.status = TripStatus::Idle;
trip.route_plan = None;
trip.private_car_trip = None;
trip.current_leg_index = 0;
trip.current_leg_wait_seconds = 0.0;
trip.destination = replacement;
trip.deadline = trip_deadline_seconds(after.time);
trip.patience_remaining = WAIT_PATIENCE_SECONDS;
```

If no replacement exists, remove the outbound trip, scrub passenger references, and give the citizen the next sensible daily activity.

- [ ] **Step 7: Make pure snapshot building/removal helpers shell-only**

Remove live population mutation from `buildings::assign_workplaces` call sites and `transit.rs` resident/workplace cleanup. Keep generic route/vehicle cleanup. Preview continues to use pure shell helpers and never receives ECS.

Delete `buildings::assign_workplaces` once no production/test caller needs it.

- [ ] **Step 8: Assert derived-index rebuild equality after every lifecycle mutation class**

After move-in, workplace assign, workplace removal/reassign, housing despawn, and building reconciliation, compare live index with test-only rebuild. Assert `NextCitizenOrdinal` separately for monotonicity.

- [ ] **Step 9: Verify and commit**

Run:

```bash
cargo fmt --all --check
cargo test -p caelum-core population::tests
cargo test -p caelum-core --test areas_buildings
cargo test -p caelum-core --test transit_build
cargo check --workspace
```

Commit:

```bash
git add crates/caelum-core/src/population crates/caelum-core/src/buildings.rs crates/caelum-core/src/transit.rs crates/caelum-core/tests
git commit -m "feat: reconcile population through ECS indexes"
```

---

### Task 4: Migrate direct trip-tick fixtures before the live cutover

**Files:**
- Modify: `crates/caelum-core/tests/common/mod.rs`
- Modify: `crates/caelum-core/tests/common/persistence_fixtures.rs` only where shared sim construction is beneficial
- Modify: `crates/caelum-core/tests/golden_sequences.rs`
- Modify: `crates/caelum-core/tests/shuttle_service.rs`
- Modify: `crates/caelum-core/tests/trip_lifecycle.rs`
- Modify: `crates/caelum-core/src/growth.rs` module tests
- Modify: every additional current file returned by the tick-call inventory

**Goal:** stop treating `trips::tick_trips(&GameSnapshot, ...)` as the end-to-end test runtime before its production signature disappears.

- [ ] **Step 1: Inventory all current direct tick seams**

Run:

```bash
rg -n 'trips::tick_trips(_with_objectives)?\(|\btick_trips(_with_objectives)?\(' crates/caelum-core/src crates/caelum-core/tests
```

Record the live hits in the implementation commit message/PR notes; historical docs are not migration targets.

- [ ] **Step 2: Reuse `running_engine_from_fixture` for integration scenarios**

For each end-to-end scenario:

```rust
let mut engine = common::running_engine_from_fixture(snapshot);
let result = engine.tick(delta_seconds);
assert!(result.rejection.is_none());
let snapshot = engine.snapshot();
```

Do not add `tick_running_fixture(snapshot, delta)` that constructs a new engine per call.

- [ ] **Step 3: Convert coarse/fine loops to one engine per branch**

Use:

```rust
let mut coarse = common::running_engine_from_fixture(base.clone());
coarse.tick(total_delta);
let coarse_snapshot = coarse.snapshot();

let mut fine = common::running_engine_from_fixture(base);
for _ in 0..step_count {
    fine.tick(step_delta);
}
let fine_snapshot = fine.snapshot();

assert_eq!(coarse_snapshot, fine_snapshot);
```

For a final partial delta, call it once after the loop. Do not validate/compile a fresh engine at every substep.

- [ ] **Step 4: Remove unnecessary no-objective tick dependencies**

Tests that previously called plain `tick_trips` only to avoid campaign objective evaluation should make that fixture Sandbox or set `scenario.objectives = None`, then use `GameEngine::tick`. Keep a direct low-level trip helper only where the test is genuinely testing an isolated pure trip function rather than the game runtime.

- [ ] **Step 5: Move growth module tests to `GameEngine`**

Construct `GameEngine::from_snapshot` from the prepared campaign/sandbox fixture, resume it when needed, call `tick`, and inspect `engine.snapshot()`. Preserve the existing assertions that Campaign growth houses do not create Sandbox residents.

- [ ] **Step 6: Centralize v10-ready sim fixture construction without adding building hardening**

Where multiple integration files create the same Worker row, add a shared helper under `tests/common`. Keep home/workplace points exactly as the test needs. Do **not** add artificial buildings to every trip fixture merely to satisfy new validation; Task 6 preserves the current point-in-bounds home/workplace contract and adds only schedule-ownership validation.

- [ ] **Step 7: Verify the migrated tests before production tick changes**

Run:

```bash
cargo test -p caelum-core --test golden_sequences
cargo test -p caelum-core --test shuttle_service
cargo test -p caelum-core --test trip_lifecycle
cargo test -p caelum-core growth::tests
cargo test --workspace
```

Expected: PASS while production `GameEngine` still uses the old snapshot-backed trip implementation.

- [ ] **Step 8: Commit**

```bash
git add crates/caelum-core/src/growth.rs crates/caelum-core/tests
git commit -m "test: migrate trip runtime fixtures to GameEngine"
```

---

### Task 5: Cut live Worker population ownership to ECS and prove Stage A

**Files:**
- Modify: `crates/caelum-core/src/engine.rs`
- Modify: `crates/caelum-core/src/intent.rs`
- Modify: `crates/caelum-core/src/trips.rs`
- Modify: `crates/caelum-core/src/presentation.rs`
- Modify: `crates/caelum-core/src/population/mod.rs`
- Modify: `crates/caelum-core/src/population/schedule.rs`
- Modify: `crates/caelum-core/tests/population.rs`
- Modify: `crates/caelum-core/tests/presentation_contract.rs`
- Modify: `crates/caelum-core/tests/presentation_scale.rs`
- Modify: `crates/caelum-core/tests/service_control.rs`
- Modify: `src-tauri/src/lib.rs` test fixtures using `engine.clone()`
- Create: `crates/caelum-core/tests/population_scale.rs`
- Modify: `docs/performance/hpa-347-ecs-population.md`

**Core interfaces:**

```rust
struct TickAdvance {
    snapshot: GameSnapshot,
    population_changed: bool,
}

pub struct PopulationAggregates {
    pub population_count: u32,
    pub building_occupancy: BTreeMap<String, u32>,
}

pub fn project_update(
    snapshot: &GameSnapshot,
    population: &PopulationAggregates,
    include_scene: bool,
) -> PresentationUpdate;
```

- [ ] **Step 1: Write RED engine ownership/commit tests**

Inside `engine.rs` tests require:

```rust
#[test]
fn live_shell_has_no_population_mirror() {
    let engine = GameEngine::from_snapshot(populated_v9_snapshot()).unwrap();
    assert!(engine.snapshot.sims.is_empty());
    assert_eq!(population::population_count(&engine.world), 2);
    assert_eq!(engine.snapshot().sims.len(), 2);
}
```

Also pin:

- paused tick -> no shell or population mutation, `applied == false`;
- speed-0 tick -> no shell or population mutation;
- running `tick(0.0)` with no due event -> no mutation;
- running `tick(0.0)` with a due Worker activity -> due work is retained and `applied == true` if shell or ECS changes.

- [ ] **Step 2: Make constructors/restore candidate-first ECS owners**

Use:

```rust
pub struct GameEngine {
    snapshot: GameSnapshot,
    road_topology: RoadTopology,
    world: World,
    population_schedule: Schedule,
}
```

Build/validate the full candidate, construct world/schedule/index/allocator, clear `snapshot.sims`, then install. Remove `#[derive(Clone)]`.

- [ ] **Step 3: Reconstruct sims only for explicit durable snapshots**

At the v9 Stage-A checkpoint:

```rust
pub fn snapshot(&self) -> GameSnapshot {
    let mut snapshot = self.snapshot.clone();
    snapshot.sims = population::snapshot_sims_v9(&self.world, snapshot.day);
    crate::service_control::populate_snapshot_metrics(&mut snapshot);
    snapshot
}
```

`snapshot_for_save` may call `snapshot()`. Ordinary tick/dispatch/presentation must not.

- [ ] **Step 4: Route pending ECS demand through the existing trip builder**

Refactor current commute spawning into:

```rust
fn spawn_pending_trip_demands(
    state: &mut GameSnapshot,
    road_topology: &RoadTopology,
    road_flow: &mut traffic::RoadFlow,
    demands: Vec<TripDemand>,
) {
    for demand in demands {
        let trip = build_commute_trip(
            state,
            road_topology,
            road_flow,
            &demand.citizen_id,
            demand.purpose,
            demand.origin,
            demand.destination,
            demand.scheduled_time,
        );
        state.active_trips.push(trip);
    }
}
```

Keep one mutable `RoadFlow` for the same-time batch.

- [ ] **Step 5: Make population mutation part of the tick result**

Change the internal production tick driver to return:

```rust
struct TickAdvance {
    snapshot: GameSnapshot,
    population_changed: bool,
}
```

Aggregate `population_changed` from `run_due`, building reconciliation, move-ins, and terminal trip resolutions.

In `GameEngine::tick`:

```rust
let TickAdvance {
    snapshot: next,
    population_changed,
} = trips::tick_trips_with_objectives(
    &self.snapshot,
    &self.road_topology,
    &mut self.world,
    &mut self.population_schedule,
    delta_seconds,
);

let shell_changed = next != self.snapshot;
self.snapshot = next;
let applied = shell_changed || population_changed;
```

Always keep the world mutations. Do not treat equal shell state as a reason to roll back or discard ECS changes.

- [ ] **Step 6: Replace sim boundary scans and preserve dynamic cap widening**

Delete `reset_daily_commute_flags`, `SIM_SHIFT_BOUNDARIES_PER_DAY`, `remaining_move_in_slots`, the sim loop in `next_boundary_after`, and sim-count cap widening.

Initial cap includes current scheduler due-time keys. Capture:

```rust
let mut last_population_boundary_generation =
    population::scheduler_boundary_generation(world);
```

After every `run_due` / tick-time `reconcile_buildings` pass:

```rust
let generation = population::scheduler_boundary_generation(world);
let added = generation.saturating_sub(last_population_boundary_generation);
cap = cap.saturating_add(added as usize);
last_population_boundary_generation = generation;
```

This may conservatively count a new key outside the current tick window; overcount is safe. Existing outcome-expiry widening remains unchanged.

- [ ] **Step 7: Feed terminal trip resolutions back to ECS**

Collect terminal transition rows before removing trips and apply them to ECS. Until Task 6 deletes `LegacyDayState`, update those v9 flags in the same handler so explicit v9 snapshots remain equivalent.

Delete `apply_arrival_to_sim` and `apply_commute_resolution_to_sim`.

- [ ] **Step 8: Use one presentation projector with two aggregate builders**

Refactor `presentation.rs` to:

```rust
pub struct PopulationAggregates {
    pub population_count: u32,
    pub building_occupancy: BTreeMap<String, u32>,
}

pub fn population_aggregates_from_snapshot(
    snapshot: &GameSnapshot,
) -> PopulationAggregates;

pub fn project_update(
    snapshot: &GameSnapshot,
    population: &PopulationAggregates,
    include_scene: bool,
) -> PresentationUpdate;
```

Add `population::presentation_aggregates(&World) -> PopulationAggregates` from ECS indexes.

Remove population computation from `project_frame`/`building_occupancy`; they consume the supplied aggregate. All other projection logic stays single-source.

Add parity test:

```rust
let durable = engine.snapshot();
let durable_population = population_aggregates_from_snapshot(&durable);
let runtime_population = population::presentation_aggregates(&engine.world);
assert_eq!(runtime_population, durable_population);
```

- [ ] **Step 9: Make `GameplayUpdateResult` accept precomputed presentation**

Implement:

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

`intent.rs` no longer calls `project_update` from a raw shell snapshot.

- [ ] **Step 10: Reconcile applied player and growth building candidates**

Before installing a building-changing dispatch candidate, call `population::reconcile_buildings(&mut world, before, &mut candidate)`. Rejected/no-op dispatches do not mutate world. Tick-time growth calls the same reconciliation after growth mutates its shell candidate.

- [ ] **Step 11: Remove `GameEngine::Clone` fixture use**

For current Tauri/service-control clone hits, build an independent engine from the explicit durable snapshot or recreate the fixture. Do not deep-clone World.

Run:

```bash
rg 'engine\.clone\(\)|derive\(Clone\).*GameEngine' crates/caelum-core src-tauri
```

Expected: no production clone contract.

- [ ] **Step 12: Add Stage-A 200k structural and granularity tests**

In `tests/population_scale.rs`, add one `#[ignore]` release-scale test that builds two equivalent 200k engines where exactly `N = 1_000` Workers are due within the interval and all others are future-scheduled.

Assert:

- population count is 200,000;
- only those 1,000 produce demand/trips;
- one coarse tick and equivalent fine ticks produce equal `engine.snapshot()`;
- a separate quiet interval with all 200k future-scheduled creates no trip/population mutation.

Run explicitly:

```bash
cargo test --release -p caelum-core --test population_scale -- --ignored --nocapture
```

This is a required HPA-347 gate but is not added to every default debug test run.

- [ ] **Step 13: Record Stage-A evidence and enforce the gate**

Run the release example on the Task-0 reference machine and append the worker-only 200k quiet-tick result.

Task 6 may start only after:

- the ignored 200k structural/granularity test passes;
- current Worker/golden/growth/shuttle tests pass;
- source scan shows no ordinary trip population scan;
- the Stage-A timing row is recorded.

There is no numeric performance threshold.

- [ ] **Step 14: Run the Stage-A complete gate, including clippy now that staged seams are live**

Run:

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace
bun run wasm:build:release
bun run check
bun run test:unit
```

Also run:

```bash
rg 'state\.sims|snapshot\.sims|for sim in .*sims|sims\.len' crates/caelum-core/src/trips.rs
```

Expected: no matches.

- [ ] **Step 15: Commit**

```bash
git add crates/caelum-core src-tauri/src/lib.rs docs/performance/hpa-347-ecs-population.md
git commit -m "feat: make ECS the live Worker population authority"
```

---

### Task 6: Cut persistence directly to schema v10

**Files:**
- Modify: `crates/caelum-core/src/model.rs`
- Modify: `crates/caelum-core/src/population/components.rs`
- Modify: `crates/caelum-core/src/population/mod.rs`
- Modify: `crates/caelum-core/src/population/schedule.rs`
- Modify: `crates/caelum-core/src/persistence/error.rs`
- Modify: `crates/caelum-core/src/persistence/trips.rs`
- Modify: `crates/caelum-core/tests/common/persistence_fixtures.rs`
- Modify: current Rust fixtures returned by the legacy-field guard
- Modify: `src/domain/types.ts`
- Modify: `src/runtime/backend/types.ts`
- Modify: persistence/restore tests returned by schema/type search

- [ ] **Step 1: Write RED serde tests for the final v10 shape**

Use exactly:

```rust
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

Test Worker and Student JSON, plus `nextActivity: null` for a travelling citizen.

- [ ] **Step 2: Bump schema 9 -> 10 and delete the daily-flag model**

Set:

```rust
pub const SNAPSHOT_SCHEMA_VERSION: u16 = 10;
```

Delete `WorkerProfile`, `commute_day`, and the four daily flags from `Sim`. Keep `ScheduledActivityKind` from Task 2; do not redefine it.

Final `TripPurpose` becomes:

```rust
pub enum TripPurpose {
    CommuteOutbound,
    CommuteReturn,
    OptionalOutbound,
    OptionalReturn,
}
```

- [ ] **Step 3: Delete the v9 ECS adapter**

Rename `build_world_v9` -> `build_world`, `snapshot_sims_v9` -> `snapshot_sims`, remove `LegacyDayState`, and map v10 routine/next activity directly.

Current NonWorker maps to `Student`, but Stage-B travel remains disabled until Task 7.

- [ ] **Step 4: Keep persistence validation focused on state the scheduler actually requires**

Preserve current point-in-bounds validation for home/position/workplace. Add only:

- `SimNextActivityDueTime` finite/non-negative validation;
- active trip + `next_activity.is_some()` -> `AssignmentError::ScheduledWhileTraveling`;
- idle sim + `next_activity.is_none()` -> `AssignmentError::MissingNextActivity`.

Do not add `SimHomeNotResidential` / `SimWorkplaceNotJob` hardening in HPA-347. Runtime world construction resolves building IDs when present and leaves fixture-only unresolved assignments detached from occupancy indexes.

- [ ] **Step 5: Update Rust fixtures in one breaking sweep**

Run:

```bash
rg -l 'WorkerProfile|worker_profile|commute_day|outbound_resolved_today|outbound_arrived_today|return_resolved_today|returned_home_today|build_world_v9|snapshot_sims_v9|LegacyDayState' crates/caelum-core
```

Update every current source/test result. Idle fixture sims receive a valid future `DailyRoutine`; fixture sims with active trips receive `next_activity = None`.

Final guard is empty.

- [ ] **Step 6: Update TypeScript durable types only**

Use:

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

`RustSim` only widens Rust `Option` encoding if WASM returns `undefined`. Do not add sims back to live `GameState`/`PresentationUpdate`.

- [ ] **Step 7: Add v10 restore/round-trip tests**

Cover:

- Worker idle schedule round-trip;
- Student idle schedule round-trip;
- travelling sim with no next activity round-trip;
- travelling sim with a next activity rejects `scheduledWhileTraveling`;
- idle sim without next activity rejects `missingNextActivity`;
- schema 9 rejects `UnsupportedSchema { expected: 10, actual: 9 }`.

- [ ] **Step 8: Run the v10 cross-host gate and commit**

Run:

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace
bun run wasm:build:release
bun run check
bun run test:unit
```

Commit:

```bash
git add crates/caelum-core crates/caelum-wasm src src-tauri tests Cargo.lock
git commit -m "feat: persist v10 ECS citizen schedules"
```

---

### Task 7: Enable Student, day-off, and bounded optional demand after Stage A

**Files:**
- Modify: `crates/caelum-core/src/commute.rs`
- Modify: `crates/caelum-core/src/population/schedule.rs`
- Modify: `crates/caelum-core/src/population/mod.rs`
- Modify: `crates/caelum-core/src/transit_income.rs` tests only for purpose characterization
- Modify: `crates/caelum-core/tests/commute_requirements.rs`
- Modify: `crates/caelum-core/tests/trip_lifecycle.rs`

- [ ] **Step 1: Add deterministic seed helper without `rand`**

Implement:

```rust
pub fn stable_daily_seed(id: &str, day: u32, salt: u64) -> u64 {
    let mut x = numeric_id_suffix(id) as u64
        ^ u64::from(day).wrapping_mul(0x9E37_79B9_7F4A_7C15)
        ^ salt;
    x = (x ^ (x >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    x = (x ^ (x >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    x ^ (x >> 31)
}
```

Pin same input -> same output and distinct salt/day changes.

- [ ] **Step 2: Enable Student primary routine**

Student destination choice:

- sorted placed `school` building IDs;
- deterministic seed chooses building and footprint tile;
- outbound 07:30–08:30;
- return 15:00–16:00;
- no school -> no primary trip, next DailyRoutine is scheduled.

Add deterministic independent-world test.

- [ ] **Step 3: Enable one day off in seven**

Use exactly:

```rust
fn is_day_off(citizen_id: &str, day: u32) -> bool {
    day % 7 == (numeric_id_suffix(citizen_id) as u32 % 7)
}
```

Pin all seven days for representative Worker and Student IDs. Day off suppresses primary work/school outbound.

- [ ] **Step 4: Add at most one optional outing on a day off**

Eligibility: `stable_daily_seed(id, day, OPTIONAL_SALT) % 4 == 0`.

Eligible building types are exactly:

- `supermarket`
- `cinema`
- `clinic`
- `parkPlaza`

Depart 11:00–15:00; destination building/tile are deterministic. Do not add visitor capacity or chained stops.

- [ ] **Step 5: Add optional return and recovery rules**

On successful optional outbound, schedule `OptionalReturn` at exactly 120 in-game minutes after `resolved_at`. Successful return settles home and schedules next DailyRoutine. Unserved return waits until the next DailyRoutine; do not retry within the same due timestamp.

- [ ] **Step 6: Characterize existing transit income for new purposes**

`completed_transit_trip_income` currently qualifies by terminal status + route plan, not purpose. Add tests using `OptionalOutbound` and Student `CommuteOutbound` proving completed Bus/Metro travel receives the same existing `$200` rule. Do not change production fare logic.

- [ ] **Step 7: Add Stage-B granularity/determinism tests**

Pin coarse/fine equivalence for:

- Student outbound/return;
- day-off no-primary day;
- optional outbound + dwell + return;
- failed return recovery to next DailyRoutine.

- [ ] **Step 8: Run the behavior gate and commit**

Run:

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test -p caelum-core population::
cargo test -p caelum-core --test commute_requirements
cargo test -p caelum-core --test trip_lifecycle
cargo test -p caelum-core transit_income::
cargo test --workspace
```

Commit:

```bash
git add crates/caelum-core
git commit -m "feat: add scheduled student and optional demand"
```

---

### Task 8: Record final scale evidence, update ownership docs, and run the full gate

**Files:**
- Modify: `crates/caelum-core/examples/presentation_scale.rs`
- Modify: `crates/caelum-core/tests/presentation_scale.rs`
- Modify: `crates/caelum-core/tests/population_scale.rs`
- Modify: `docs/performance/hpa-347-ecs-population.md`
- Modify: `docs/architecture.md`
- Modify: `CLAUDE.md` if its population ownership description is stale

- [ ] **Step 1: Extend the release harness with final runtime rows**

For `ecs-10000`, `ecs-50000`, `ecs-200000`, measure separately:

```text
runtime_build_us
quiet_tick_us
runtime_presentation_us
full_snapshot_us
```

For `wave-1000`, `wave-5000`, `wave-20000`, measure separately:

```text
schedule_emit_us
route_spawn_us
```

Retain HPA-544 presentation-cardinality rows.

- [ ] **Step 2: Re-run the required 200k structural Stage-A-style proof on final v10 behavior**

Run:

```bash
cargo test --release -p caelum-core --test population_scale -- --ignored --nocapture
```

Expected: PASS for 200k cardinality, due-only processing, quiet future population, and coarse/fine durable equality.

- [ ] **Step 3: Record final release WASM bytes**

Run:

```bash
bun run wasm:build:release
wc -c src/generated/caelum_wasm/caelum_wasm_bg.wasm
```

Append the literal **After HPA-347 release WASM bytes** and before/after delta to the performance document. No size threshold.

- [ ] **Step 4: Complete the performance document**

Append exact tables for:

- 10k/50k/200k runtime build/quiet tick/presentation/full snapshot;
- 1k/5k/20k scheduler emission and route spawning;
- release WASM bytes before/after.

State which component is the dominant due-wave cost. If route spawning dominates, name HPA-348 explicitly.

- [ ] **Step 5: Update architecture ownership docs**

Document:

- `GameEngine` owns shell + topology + ECS world/schedule;
- live shell sims are empty;
- exact-time scheduler wakes only due events;
- shell + ECS are one tick commit unit;
- explicit durable snapshot reconstructs v10 sims;
- one `project_update` consumes `PopulationAggregates`;
- HPA-348 owns route-choice batching;
- HPA-640 owns WebGPU/viewport/LOD/cadence.

- [ ] **Step 6: Run final source-shape guards**

```bash
rg 'state\.sims|snapshot\.sims|\.sims\.iter|\.sims\.len' crates/caelum-core/src
```

Expected: matches only explicit durable/persistence aggregate/projection paths; none in ordinary `trips.rs`, `buildings.rs`, or population-dependent `transit.rs` cleanup.

```bash
rg 'bevy::|bevy_app|multi_threaded|bevy_reflect|rand::' crates/caelum-core Cargo.toml
```

Expected: no prohibited full-Bevy/reflection/multithreading/rand usage.

```bash
rg 'bevy_ecs::.*Entity|\bEntity\b' crates/caelum-core/src/model.rs src/domain/types.ts src/runtime/backend/types.ts crates/caelum-core/src/presentation.rs
```

Expected: no Bevy entity handle in durable/public presentation types.

```bash
rg 'WorkerProfile|worker_profile|commute_day|outbound_resolved_today|outbound_arrived_today|return_resolved_today|returned_home_today|build_world_v9|snapshot_sims_v9|LegacyDayState' crates/caelum-core src tests
```

Expected: no legacy adapter/state references.

```bash
rg 'tick_trips(_with_objectives)?\(' crates/caelum-core/tests crates/caelum-core/src/growth.rs
```

Expected: no old snapshot-driven end-to-end tick seam remains.

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
cargo test --release -p caelum-core --test population_scale -- --ignored --nocapture
```

Expected: every command PASS and the release outputs match the literal evidence recorded in the performance document.

- [ ] **Step 8: Self-review spec coverage and marker consistency**

Run:

```bash
rg 'T[B]D|T[O]DO|FILL[_]ME|REPLACE[_]ME' \
  docs/superpowers/specs/2026-09-04-ecs-latent-population-design.md \
  docs/superpowers/plans/2026-09-04-ecs-latent-population.md \
  docs/performance/hpa-347-ecs-population.md
```

Expected: no matches.

Map every spec acceptance item to a passing test, source guard, or recorded evidence row. Fix interface-name drift rather than adding compatibility aliases.

- [ ] **Step 9: Commit evidence/docs and update this same draft PR**

```bash
git add crates/caelum-core docs CLAUDE.md
git commit -m "docs: record HPA-347 ECS scale evidence"
```

Update PR #56 from planning summary to final implementation/evidence summary. Do not create a second HPA-347 PR.
