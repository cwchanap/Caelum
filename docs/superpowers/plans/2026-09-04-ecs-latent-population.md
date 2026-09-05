# HPA-347 ECS Latent Population Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move latent citizen/activity scheduling into a load-bearing standalone Bevy ECS world so Caelum can hold and advance about 200,000 citizens without scanning or cloning every citizen on ordinary simulation substeps.

**Architecture:** `GameEngine` will own a `bevy_ecs::World` plus one explicitly ordered population `Schedule`. The live `GameSnapshot` becomes the non-population shell (`sims` intentionally empty); ECS systems wake only time-bucketed citizens and emit deterministic `TripDemand` rows into the existing routing/active-trip pipeline. Full `Sim[]` is reconstructed only for durable snapshot/save operations, while HPA-544 presentation reads population counts/occupancy from runtime indexes.

**Tech Stack:** Rust 1.95+, `bevy_ecs` 0.19.1 (`default-features = false`, `std` only), serde/serde_json, existing Caelum router/transit/traffic modules, TypeScript/Bun persistence host tests.

**Spec:** `docs/superpowers/specs/2026-09-04-ecs-latent-population-design.md`

## Global Constraints

- This is one HPA-347 PR. Do not create a second implementation PR after the planning commits.
- `bevy_ecs = { version = "0.19.1", default-features = false, features = ["std"] }`; do not add full `bevy`, reflection, serialization, async executor, `multi_threaded`, or `rand`.
- Set `rust-version = "1.95"` in `crates/caelum-core/Cargo.toml`, `crates/caelum-wasm/Cargo.toml`, and `src-tauri/Cargo.toml`.
- ECS is the sole live owner of latent citizens. Never keep a runtime `GameSnapshot.sims` mirror.
- Stable Caelum string IDs are durable. Bevy `Entity` is runtime-only and must never be serialized or exposed in `PresentationUpdate`.
- Keep road/transit graphs, routing, active-trip movement, aggregate traffic, economy, building catalog, and presentation wire outside ECS.
- Keep route choice sequential in this ticket; HPA-348 owns batching it.
- Keep HPA-544 `PresentationUpdate` JSON shape unchanged.
- Bump the durable schema directly from v9 to v10; reject old dev saves instead of writing a migration path.
- Determinism must use scheduler bucket -> stable citizen ID -> explicit purpose rank, never Bevy entity order or hash-map iteration.
- Population schedule sets are explicitly ordered `CollectDue -> ApplyDue -> EmitTripDemand`.
- Wall-clock scale numbers are reference evidence only, never CI thresholds.

---

### Task 0: Record the pre-cutover population-tick baseline

**Files:**
- Modify: `crates/caelum-core/examples/presentation_scale.rs`
- Create: `docs/performance/hpa-347-ecs-population.md`

**Interfaces:**
- Consumes: current `GameSnapshot`, `RoadTopology`, `trips::tick_trips`, and the HPA-544 synthetic sim fixture.
- Produces: retained `measure_population_tick(...)` harness rows and a before-cutover table used for the final comparison in Task 8.

- [ ] **Step 1: Add one native timing helper around the current trip tick**

Add imports for `caelum_core::trips` and `caelum_core::road_topology::RoadTopology`, then add:

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

Call it for the existing `sims-10000`, `sims-50000`, and `sims-200000` fixtures with a small quiet delta that does not intentionally route a commute wave.

- [ ] **Step 2: Run the current release harness before any ECS dependency/model edit**

Run:

```bash
cargo run --release -p caelum-core --example presentation_scale
```

Expected: existing HPA-544 rows plus `population_tick_us` rows for 10k/50k/200k sims. The absolute time is machine-dependent; the useful evidence is that current quiet tick cost increases with `sims.len()`.

- [ ] **Step 3: Record exact environment and pre-cutover values**

Create `docs/performance/hpa-347-ecs-population.md` with:

```markdown
# HPA-347 ECS Population Baseline

## Command
`cargo run --release -p caelum-core --example presentation_scale`

## Reference environment
- OS: <copy `uname -a` output>
- CPU: <copy machine CPU description>
- Rust: <copy `rustc --version` output>
- Build: `--release`

## Before ECS cutover
| Fixture | Sims | Population tick µs |
| --- | ---: | ---: |
| sims-10000 | 10000 | <measured value> |
| sims-50000 | 50000 | <measured value> |
| sims-200000 | 200000 | <measured value> |

Wall-clock values are reference evidence, not CI thresholds.
```

Replace each angle-bracket field with the literal output from this run before committing; the final document must contain no placeholders.

- [ ] **Step 4: Verify the baseline change is measurement-only**

Run:

```bash
cargo test -p caelum-core --lib
cargo run --release -p caelum-core --example presentation_scale
```

Expected: tests PASS; the example emits the original snapshot/presentation rows unchanged plus population tick rows.

- [ ] **Step 5: Commit**

```bash
git add crates/caelum-core/examples/presentation_scale.rs docs/performance/hpa-347-ecs-population.md
git commit -m "perf: record HPA-347 population tick baseline"
```

---

### Task 1: Raise the Rust floor and replace the durable daily-flag Sim schema

**Files:**
- Modify: `crates/caelum-core/Cargo.toml`
- Modify: `crates/caelum-wasm/Cargo.toml`
- Modify: `src-tauri/Cargo.toml`
- Modify: `Cargo.lock`
- Modify: `crates/caelum-core/src/model.rs`
- Modify: `crates/caelum-core/src/commute.rs`
- Modify: `crates/caelum-core/src/persistence/trips.rs`
- Modify: `crates/caelum-core/src/persistence/entities.rs`
- Modify: `crates/caelum-core/tests/common/persistence_fixtures.rs`
- Modify: current Rust test/example files returned by `rg -l 'WorkerProfile|worker_profile|commute_day|outbound_resolved_today|outbound_arrived_today|return_resolved_today|returned_home_today' crates/caelum-core`

**Interfaces:**
- Produces: `CitizenRoutine`, `ScheduledActivityKind`, `ScheduledActivity`, v10 `Sim`, four-value `TripPurpose`, `routine_for_new_citizen`, and persistence validation for the new shape.
- Consumes: existing `numeric_id_suffix`, `shift_template_for_id`, `departure_minute_for_sim`, `Point`, and active-trip ownership validation.

- [ ] **Step 1: Write model serialization tests for the v10 citizen contract**

In the `model.rs` test module, add a worker fixture and assert the exact JSON keys:

```rust
#[test]
fn sim_v10_serializes_routine_and_next_activity_without_daily_flags() {
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

Also add a serde round-trip for `CitizenRoutine::Student` and `TripPurpose::OptionalOutbound` / `OptionalReturn`.

- [ ] **Step 2: Run the focused model test and confirm it fails**

Run:

```bash
cargo test -p caelum-core sim_v10_serializes_routine_and_next_activity_without_daily_flags -- --exact
```

Expected: FAIL because the new types/fields do not exist.

- [ ] **Step 3: Add the dependency/MSRV and v10 model**

Apply these manifest changes:

```toml
# crates/caelum-core/Cargo.toml
rust-version = "1.95"

[dependencies]
bevy_ecs = { version = "0.19.1", default-features = false, features = ["std"] }
serde = { version = "1.0.177", features = ["derive"] }
serde_json = "1.0"
```

Set the same `rust-version = "1.95"` in `caelum-wasm` and `src-tauri`, then run `cargo update -p bevy_ecs --precise 0.19.1` (or `cargo check` if the lock has no Bevy entry yet) so `Cargo.lock` records the dependency.

In `model.rs`:

```rust
pub const SNAPSHOT_SCHEMA_VERSION: u16 = 10;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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

Change `TripPurpose` to:

```rust
pub enum TripPurpose {
    CommuteOutbound,
    CommuteReturn,
    OptionalOutbound,
    OptionalReturn,
}
```

Delete `WorkerProfile` after its callers move to the new routine helper.

- [ ] **Step 4: Replace worker-profile derivation with a new-citizen routine helper**

Keep `numeric_id_suffix`, `shift_template_for_id`, and `departure_minute_for_sim`. Replace `worker_profile_for_id` with:

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

No `rand` or second profile table is added.

- [ ] **Step 5: Replace persistence normalization of profile flags with v10 activity validation**

Remove the old `normalize_direct_fields` writes that overwrite `worker_profile` / `shift_template` from ID. In persistence validation, add finite/non-negative validation for `next_activity.due_time` and enforce the active-trip scheduling invariant:

```rust
let active_sim_ids: HashSet<&str> = snapshot
    .active_trips
    .iter()
    .map(|trip| trip.sim_id.as_str())
    .collect();

for sim in &snapshot.sims {
    if active_sim_ids.contains(sim.id.as_str()) {
        if sim.next_activity.is_some() {
            return Err(PersistenceError::InvalidAssignment { /* use the existing typed assignment error variant */ });
        }
    } else if sim.next_activity.is_none() {
        return Err(PersistenceError::InvalidAssignment { /* same existing typed assignment family */ });
    }
}
```

Use the repository's existing `AssignmentError` / `EntityRef` typed error pattern rather than adding a string error. Add exact enum variants such as `AssignmentError::ScheduledWhileTraveling` and `AssignmentError::MissingNextActivity` if the current family has no suitable variant.

- [ ] **Step 6: Migrate the shared persistence fixture first, then remaining compile failures**

Change `crates/caelum-core/tests/common/persistence_fixtures.rs::sim` to construct the v10 worker row:

```rust
Sim {
    id: id.to_string(),
    home,
    position: home,
    routine: CitizenRoutine::Worker {
        shift_template: "standard".to_string(),
        workplace,
    },
    next_activity: Some(ScheduledActivity {
        kind: ScheduledActivityKind::DailyRoutine,
        due_time: 0.0,
    }),
}
```

Then run:

```bash
rg -l 'WorkerProfile|worker_profile|commute_day|outbound_resolved_today|outbound_arrived_today|return_resolved_today|returned_home_today' crates/caelum-core
```

For each current source/test/example result, replace assertions with `CitizenRoutine` / `next_activity` equivalents. The production results expected before Task 2 are `model.rs`, `commute.rs`, `population.rs`, `buildings.rs`, `trips.rs`, and persistence modules; the latter three may temporarily retain behavior logic until their owning tasks below, but they must compile against the v10 types.

- [ ] **Step 7: Verify model/persistence compile before ECS ownership work**

Run:

```bash
cargo +stable fmt --all --check
cargo +stable test -p caelum-core --lib
cargo +stable test -p caelum-core --test persistence
```

Expected: PASS on Rust >=1.95. Schema-v9 fixture tests now expect `UnsupportedSchema { expected: 10, actual: 9 }`.

- [ ] **Step 8: Commit**

```bash
git add Cargo.toml Cargo.lock crates/caelum-core crates/caelum-wasm/Cargo.toml src-tauri/Cargo.toml
git commit -m "feat: define v10 citizen schedule state"
```

---

### Task 2: Build the load-bearing ECS citizen world and indexes

**Files:**
- Move: `crates/caelum-core/src/population.rs` -> `crates/caelum-core/src/population/mod.rs`
- Create: `crates/caelum-core/src/population/components.rs`
- Create: `crates/caelum-core/src/population/schedule.rs`
- Modify: `crates/caelum-core/src/population/mod.rs`

**Interfaces:**
- Produces:
  - `pub(crate) fn build_world(snapshot: &GameSnapshot) -> World`
  - `pub(crate) fn build_schedule() -> Schedule`
  - `pub(crate) fn snapshot_sims(world: &World) -> Vec<Sim>`
  - `pub(crate) fn population_count(world: &World) -> u32`
  - `pub(crate) fn resident_occupancy_for_building(world: &World, building_id: &str) -> u32`
  - `pub(crate) fn job_occupancy_for_building(world: &World, building_id: &str) -> u32`
- Consumes: v10 `Sim`, `PlacedBuilding`, `building_definition`, stable building/citizen IDs.

- [ ] **Step 1: Write ECS round-trip/index tests inside `population/mod.rs`**

Add tests using a snapshot with two valid housing residents and one workplace assignment:

```rust
#[test]
fn world_projection_round_trips_durable_citizens_in_stable_id_order() {
    let snapshot = population_fixture();
    let world = build_world(&snapshot);

    assert_eq!(population_count(&world), snapshot.sims.len() as u32);
    assert_eq!(snapshot_sims(&world), snapshot.sims);
}

#[test]
fn occupancy_reads_runtime_indexes_not_snapshot_sim_rows() {
    let snapshot = population_fixture();
    let world = build_world(&snapshot);

    assert_eq!(resident_occupancy_for_building(&world, "building-home"), 2);
    assert_eq!(job_occupancy_for_building(&world, "building-work"), 1);
}
```

Ensure the fixture's `Sim` rows are sorted by ID so exact projection comparison is meaningful.

- [ ] **Step 2: Run the focused tests and confirm they fail**

Run:

```bash
cargo test -p caelum-core population::tests::world_projection_round_trips_durable_citizens_in_stable_id_order
cargo test -p caelum-core population::tests::occupancy_reads_runtime_indexes_not_snapshot_sim_rows
```

Expected: FAIL because `World` construction/index helpers do not exist.

- [ ] **Step 3: Split components from runtime orchestration**

`components.rs` should define only:

```rust
use bevy_ecs::prelude::*;

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
pub(super) struct NextActivity(pub(super) ScheduledActivity);
```

Do not add methods that duplicate scheduler behavior here.

- [ ] **Step 4: Add one deterministic `PopulationIndex` resource**

In `population/mod.rs`, define a `Resource` with BTree-backed ordering for any iteration that affects assignment:

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

`PopulationBuilding` holds only the existing building ID/type/footprint and catalog capacities needed by population assignment. Do not copy the map, route graph, or full `PlacedBuilding` model into ECS.

While building the index:

- resolve each `Sim.home` to its containing residential building;
- resolve worker `workplace` to its containing job-capacity building;
- put workers without a workplace in `unassigned_workers`;
- compute `next_citizen_ordinal = max(numeric_id_suffix(sim.id)) + 1` once.

- [ ] **Step 5: Spawn v10 sims into the world and project them back**

Implement `build_world` by inserting index/scheduler mailbox resources, then spawning one entity per durable `Sim`. `snapshot_sims` iterates entities, converts runtime `Routine` back to `CitizenRoutine`, preserves `NextActivity`/`None`, and sorts by `id`.

The serialized projection must contain no Bevy entity value. Do not assert that two separate worlds produce numerically different `Entity` handles; only assert that durable/presentation values are independent of them.

- [ ] **Step 6: Run module tests and a 200k construction smoke test**

Add a module test that directly spawns 200,000 simple valid citizen entities/index rows through a test fixture builder and asserts:

```rust
assert_eq!(population_count(&world), 200_000);
assert_eq!(world.resource::<PopulationIndex>().by_id.len(), 200_000);
```

This is a correctness smoke test, not a duration assertion.

Run:

```bash
cargo test -p caelum-core population::tests
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add crates/caelum-core/src/population.rs crates/caelum-core/src/population
git commit -m "feat: add ECS citizen world and indexes"
```

---

### Task 3: Add deterministic time buckets and routine demand emission

**Files:**
- Modify: `crates/caelum-core/src/population/schedule.rs`
- Modify: `crates/caelum-core/src/population/mod.rs`
- Modify: `crates/caelum-core/src/commute.rs`
- Modify: `crates/caelum-core/src/model.rs` only if helper methods on `TripPurpose` are needed

**Interfaces:**
- Produces:
  - `pub(crate) struct TripDemand { citizen_id, purpose, origin, destination, scheduled_time }`
  - `pub(crate) fn run_due(world: &mut World, schedule: &mut Schedule, now: f64)`
  - `pub(crate) fn drain_trip_demands(world: &mut World) -> Vec<TripDemand>`
  - `pub(crate) fn next_population_boundary(world: &World, after: f64) -> Option<f64>`
  - `pub(crate) fn population_boundary_count_until(world: &World, final_time: f64) -> usize`
- Consumes: `PopulationIndex`, `NextActivity`, worker shift helpers, school/optional building lists.

- [ ] **Step 1: Write a RED test proving only the due bucket emits**

In `schedule.rs` tests, create three citizens with next activities in bucket 10, 10, and 100. Run at bucket 10 and assert:

```rust
run_due(&mut world, &mut schedule, bucket_time(10));
let demands = drain_trip_demands(&mut world);

assert_eq!(demands.iter().map(|d| d.citizen_id.as_str()).collect::<Vec<_>>(), [
    "sim-001",
    "sim-002",
]);
assert!(world.get::<NextActivity>(entity_for(&world, "sim-100")).is_some());
```

The fixture should give sim-001/sim-002 valid worker destinations and keep sim-100 far in the future.

- [ ] **Step 2: Write deterministic routine tests before implementation**

Add these exact behavior tests:

```rust
#[test]
fn same_seed_and_day_emit_identical_optional_outing() { /* build two equivalent worlds; compare TripDemand */ }

#[test]
fn one_day_off_per_seven_days_suppresses_primary_trip() {
    for day in 0..7 {
        let is_off = is_day_off("sim-001", day);
        assert_eq!(is_off, day == 1);
    }
}

#[test]
fn student_without_school_schedules_next_daily_wake_without_trip() { /* no schools -> no demand */ }

#[test]
fn optional_outing_is_at_most_one_round_trip_on_day_off() { /* one outbound only; return waits for resolution */ }
```

- [ ] **Step 3: Run scheduler tests and confirm they fail**

Run:

```bash
cargo test -p caelum-core population::schedule::tests
```

Expected: FAIL on missing scheduler/systems.

- [ ] **Step 4: Implement one-minute time bucketing**

Use:

```rust
const POPULATION_BUCKET_SECONDS: f64 =
    GAME_DAY_SECONDS / f64::from(MINUTES_PER_DAY);

fn bucket_for_due_time(time: f64) -> u64 {
    (time / POPULATION_BUCKET_SECONDS).ceil() as u64
}

fn bucket_time(bucket: u64) -> f64 {
    bucket as f64 * POPULATION_BUCKET_SECONDS
}
```

`PopulationScheduler` is a `BTreeMap<u64, Vec<PopulationEvent>>`. `next_population_boundary` reads the first bucket whose boundary is strictly after `after` (within the existing `EPSILON` convention). `population_boundary_count_until` counts populated keys through the target bucket; it does not inspect citizen components.

- [ ] **Step 5: Configure the explicit Bevy schedule**

Define:

```rust
#[derive(SystemSet, Debug, Clone, PartialEq, Eq, Hash)]
enum PopulationSet {
    CollectDue,
    ApplyDue,
    EmitTripDemand,
}
```

Build a standalone `Schedule` whose sets are chained in that order. Add only the three focused systems. Do not use `App`, plugins, observers, or a second schedule.

- [ ] **Step 6: Implement deterministic primary/day-off/optional selection**

Keep the rules from the spec exact:

- student iff `numeric_id_suffix(id) % 10 == 0`;
- day off iff `day % 7 == numeric_id_suffix(id) % 7`;
- worker windows continue through `departure_minute_for_sim` and current return windows;
- student outbound 07:30–08:30, return 15:00–16:00;
- optional outing only on day off and only when `stable_seed(id, day, OPTIONAL_SALT) % 4 == 0`;
- optional building types are `supermarket`, `cinema`, `clinic`, `parkPlaza`;
- optional outbound window 11:00–15:00;
- successful optional arrival later schedules return after 120 in-game minutes.

Add a local integer mixer such as SplitMix64 in `commute.rs`:

```rust
pub fn stable_daily_seed(id: &str, day: u32, salt: u64) -> u64 {
    let mut x = numeric_id_suffix(id) as u64
        ^ (u64::from(day).wrapping_mul(0x9E37_79B9_7F4A_7C15))
        ^ salt;
    x = (x ^ (x >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    x = (x ^ (x >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    x ^ (x >> 31)
}
```

- [ ] **Step 7: Stable-sort demands before exposing them**

Before `drain_trip_demands` returns, sort by:

```rust
(
    demand.scheduled_time.to_bits(),
    demand.citizen_id.as_str(),
    purpose_rank(demand.purpose),
)
```

All scheduled times are validated non-negative/finite, so bit ordering is safe for equal/time-ordered values in this domain. `purpose_rank` is an explicit match, not enum discriminant casting.

- [ ] **Step 8: Verify scheduler behavior**

Run:

```bash
cargo test -p caelum-core population::schedule::tests
cargo test -p caelum-core population::tests
```

Expected: PASS, including far-future and deterministic ordering cases.

- [ ] **Step 9: Commit**

```bash
git add crates/caelum-core/src/population crates/caelum-core/src/commute.rs crates/caelum-core/src/model.rs
git commit -m "feat: schedule deterministic citizen activities"
```

---

### Task 4: Move housing/workplace lifecycle into indexed ECS reconciliation

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
  - `pub(crate) fn reconcile_buildings(world, before, after, active_trips, vehicles, now)`
  - indexed move-in scheduling and O(1)-sequence citizen ID allocation.
- Consumes: `PopulationIndex`, `PopulationScheduler`, current building catalog capacities, current active-trip retarget reset rules.

- [ ] **Step 1: Port the existing capacity behavior to engine-independent ECS tests**

Add tests in `population/mod.rs` for:

```rust
#[test]
fn two_four_resident_houses_with_four_job_slots_assign_exactly_four_workers() { /* 8 residents, 4 assignments */ }

#[test]
fn removing_employed_house_frees_slots_for_surviving_unassigned_workers() { /* preserve current population.rs contract */ }

#[test]
fn adding_workplace_fills_unassigned_workers_in_citizen_id_order() { /* no world-wide reassignment scan */ }
```

Assert both the durable `snapshot_sims(&world)` assignments and `job_occupancy_for_building` counts.

- [ ] **Step 2: Add delayed move-in tests**

Create a housing building at time 0 with capacity 4, run population due work before/at successive `MOVE_IN_INTERVAL_SECONDS` boundaries, and assert counts `1,2,3,4` exactly as the current sandbox behavior expects. Add a paused-engine integration assertion later in Task 6; this unit test only verifies scheduling math.

- [ ] **Step 3: Run the new tests and confirm they fail**

Run:

```bash
cargo test -p caelum-core population::tests::two_four_resident_houses_with_four_job_slots_assign_exactly_four_workers
cargo test -p caelum-core population::tests::adding_workplace_fills_unassigned_workers_in_citizen_id_order
```

Expected: FAIL because reconciliation/move-in logic still lives on `GameSnapshot.sims`.

- [ ] **Step 4: Implement indexed workplace slots and O(1) citizen sequence allocation**

Use `PopulationIndex.next_citizen_ordinal` instead of `next_entity_id(...state.sims...)` for sims. When a move-in creates a worker, assign the first free workplace slot by sorted workplace building ID, then slot index. When no slot exists, add the stable citizen ID to `unassigned_workers`.

When a slot opens, pop the lexicographically first unassigned citizen ID and resolve it through `by_id`.

- [ ] **Step 5: Implement `reconcile_buildings` around before/after building IDs**

Signature:

```rust
pub(crate) fn reconcile_buildings(
    world: &mut World,
    before: &[PlacedBuilding],
    after: &[PlacedBuilding],
    active_trips: &mut Vec<ActiveTrip>,
    vehicles: &mut Vec<Vehicle>,
    now: f64,
)
```

The function must:

- schedule remaining move-in slots for added housing;
- add/free workplace slot metadata and fill `unassigned_workers`;
- despawn residents of removed housing through `residents_by_building` and scrub their active trip IDs from vehicles;
- clear/reassign workers of removed workplaces through `workers_by_building`;
- retarget an affected outbound commute to a replacement workplace with `status = Idle`, `route_plan = None`, `private_car_trip = None`, `current_leg_index = 0`, `current_leg_wait_seconds = 0`, fresh 240s patience, and `deadline = trip_deadline_seconds(now)`;
- drop an outbound trip if its destination vanished and no replacement exists, then schedule that citizen's next `DailyRoutine` rather than leaving it permanently activity-less;
- similarly cancel/retarget student/optional outbound trips whose destination building disappeared.

Do not scan all citizens to perform any of these removal paths.

- [ ] **Step 6: Make snapshot building helpers shell-only**

Delete `buildings::assign_workplaces` and the calls to it from `place_building_core`, `population.rs` legacy logic, and `transit.rs` cleanup.

Delete population ownership from `transit.rs` helpers (`cleanup_removed_resident_references`, citizen workplace clearing/reassignment). Keep generic active-trip/vehicle route invalidation that is not population-specific.

Pure `transit::remove_at_tile` now mutates the shell only. Update direct `transit_build.rs` assertions accordingly. Preserve population behavior in `tests/population.rs` through `GameEngine` once Task 6 cuts ownership over.

- [ ] **Step 7: Verify indexed lifecycle tests**

Run:

```bash
cargo test -p caelum-core population::tests
cargo test -p caelum-core --test areas_buildings
cargo test -p caelum-core --test transit_build
```

Expected: PASS for the new runtime-unit semantics and shell-only direct mutation semantics.

- [ ] **Step 8: Commit**

```bash
git add crates/caelum-core/src/population crates/caelum-core/src/buildings.rs crates/caelum-core/src/transit.rs crates/caelum-core/tests
git commit -m "feat: reconcile building population through ECS indexes"
```

---

### Task 5: Bridge due ECS demand into the existing trip loop and feed terminal results back

**Files:**
- Modify: `crates/caelum-core/src/trips.rs`
- Modify: `crates/caelum-core/src/population/mod.rs`
- Modify: `crates/caelum-core/src/population/schedule.rs`
- Modify: `crates/caelum-core/tests/commute_requirements.rs`
- Modify: `crates/caelum-core/tests/trip_lifecycle.rs`
- Modify: other trip tests returned by `rg -l 'CommuteOutbound|CommuteReturn' crates/caelum-core/tests`

**Interfaces:**
- Changes:

```rust
pub fn tick_trips_with_objectives(
    state: &GameSnapshot,
    road_topology: &RoadTopology,
    world: &mut World,
    population_schedule: &mut Schedule,
    delta_seconds: f64,
) -> GameSnapshot;
```

- Produces: internal `PopulationTripResolution` rows and applies them through `population::apply_trip_resolutions`.
- Consumes: Task 3 `run_due`, `drain_trip_demands`, scheduler boundary functions.

- [ ] **Step 1: Write a RED integration test for a due worker without scanning snapshot sims**

Build a valid shell + ECS world fixture where the shell's `sims` is empty, one worker is due, and a walkable destination exists. Call the new tick API and assert:

```rust
assert!(shell.sims.is_empty());
let next = tick_trips_with_objectives(
    &shell,
    &topology,
    &mut world,
    &mut schedule,
    due_delta,
);
assert_eq!(next.active_trips.len(), 1);
assert_eq!(next.active_trips[0].sim_id, "sim-001");
```

- [ ] **Step 2: Write RED terminal-resolution tests**

Cover:

- primary outbound arrival -> ECS position becomes destination and `PrimaryReturn` is scheduled;
- primary return arrival -> ECS position becomes home and next `DailyRoutine` is scheduled;
- unserved outbound -> position stays at origin/home and next daily wake exists;
- optional outbound arrival -> `OptionalReturn` due after 120 in-game minutes.

Assert through `snapshot_sims(&world)`; do not add public debug component getters.

- [ ] **Step 3: Replace `spawn_due_commute_trips` with demand routing**

Delete the `state.sims.clone()` loop. After `population::run_due(...)`, drain stable-sorted demands and create trips via the existing `build_commute_trip` path:

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

Keep current private-car admission updating the same `road_flow` so same-time demand order remains deterministic.

- [ ] **Step 4: Remove all-citizen substep boundaries**

Delete `reset_daily_commute_flags`, the sim loop in `next_boundary_after`, `SIM_SHIFT_BOUNDARIES_PER_DAY`, and `remaining_move_in_slots`.

Add scheduler boundary candidates instead:

```rust
if let Some(population_boundary) = population::next_population_boundary(world, state.time) {
    track_next_boundary(&mut next, population_boundary, state.time);
}
```

In `max_tick_substeps`, replace sim-derived event budget with:

```rust
let population_bucket_bound =
    population::population_boundary_count_until(world, final_time);
```

and add that bound to the existing per-second/vehicle/growth/outcome terms.

- [ ] **Step 5: Collect terminal results before dropping terminal trips**

Define internal:

```rust
pub(crate) struct PopulationTripResolution {
    pub(crate) citizen_id: String,
    pub(crate) purpose: TripPurpose,
    pub(crate) status: TripStatus,
    pub(crate) destination: Point,
    pub(crate) resolved_at: f64,
}
```

While processing `TripTickResult`, append one resolution when a trip transitions terminal. After the new snapshot/metrics are assembled, call `population::apply_trip_resolutions(world, resolutions, state.time)`.

Delete `apply_arrival_to_sim` and `apply_commute_resolution_to_sim` completely.

- [ ] **Step 6: Reconcile growth-wave building additions before due population work**

Where `growth::apply_due_growth_waves` mutates the shell, detect a changed building set and invoke `population::reconcile_buildings` with the previous/next building lists before running the population schedule at that timestamp. Do not add another growth executor.

- [ ] **Step 7: Verify no production trip path scans `GameSnapshot.sims`**

Run:

```bash
rg 'state\.sims|snapshot\.sims|for sim in .*sims|sims\.len' crates/caelum-core/src/trips.rs
```

Expected: no matches.

Then run:

```bash
cargo test -p caelum-core --test commute_requirements
cargo test -p caelum-core --test trip_lifecycle
cargo test -p caelum-core trips::
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add crates/caelum-core/src/trips.rs crates/caelum-core/src/population crates/caelum-core/tests
git commit -m "feat: route ECS population demand through trip simulation"
```

---

### Task 6: Cut `GameEngine` over to sole ECS population ownership and runtime presentation

**Files:**
- Modify: `crates/caelum-core/src/engine.rs`
- Modify: `crates/caelum-core/src/intent.rs`
- Modify: `crates/caelum-core/src/presentation.rs`
- Modify: `crates/caelum-core/src/persistence/mod.rs`
- Modify: `crates/caelum-core/tests/presentation_contract.rs`
- Modify: `crates/caelum-core/tests/presentation_scale.rs`
- Modify: `crates/caelum-core/tests/population.rs`
- Modify: `crates/caelum-core/tests/service_control.rs`
- Modify: `src-tauri/src/lib.rs` test fixtures that use `engine.clone()`

**Interfaces:**
- `GameEngine` becomes `{ snapshot, road_topology, world, population_schedule }`.
- `GameEngine::snapshot()` reconstructs durable sims.
- `GameEngine::presentation()` reads shell + runtime population indexes.
- `GameplayUpdateResult::{present, frame_only, rejected}` consume a precomputed `PresentationUpdate`.

- [ ] **Step 1: Write private engine invariant tests first**

In `engine.rs` tests:

```rust
#[test]
fn live_engine_shell_does_not_mirror_ecs_sims() {
    let engine = GameEngine::from_snapshot(populated_snapshot()).unwrap();
    assert!(engine.snapshot.sims.is_empty());
    assert_eq!(population::population_count(&engine.world), 2);
    assert_eq!(engine.snapshot().sims.len(), 2);
}

#[test]
fn runtime_presentation_reads_ecs_population_without_reconstructing_sims() {
    let engine = GameEngine::from_snapshot(populated_snapshot()).unwrap();
    assert!(engine.snapshot.sims.is_empty());
    assert_eq!(engine.presentation().frame.population_count, 2);
}
```

- [ ] **Step 2: Make constructors build ECS candidate-first**

Update `GameEngine`:

```rust
pub struct GameEngine {
    snapshot: GameSnapshot,
    road_topology: RoadTopology,
    world: World,
    population_schedule: Schedule,
}
```

In `from_snapshot`:

```rust
let PreparedSnapshot { mut snapshot, road_topology } = prepare_snapshot(snapshot)?;
let world = population::build_world(&snapshot);
let population_schedule = population::build_schedule();
snapshot.sims.clear();
Ok(Self { snapshot, road_topology, world, population_schedule })
```

Apply the same candidate construction to `new`, sandbox-request construction/reset, and restore. Do not mutate the current engine until the entire replacement candidate exists.

Remove `#[derive(Clone)]` from `GameEngine`.

- [ ] **Step 3: Reconstruct only explicit durable snapshots**

Implement:

```rust
pub fn snapshot(&self) -> GameSnapshot {
    let mut snapshot = self.snapshot.clone();
    snapshot.sims = population::snapshot_sims(&self.world);
    populate_service_metrics(&mut snapshot);
    snapshot
}
```

`snapshot_for_save()` continues to call `snapshot()`, pause/normalize the clone, and return the full v10 durable snapshot.

No ordinary tick, dispatch, or presentation path may call `snapshot()`.

- [ ] **Step 4: Use runtime presentation population data without changing the wire**

Refactor `presentation.rs` into one shared frame builder with two population sources:

```rust
pub fn project_update(snapshot: &GameSnapshot, include_scene: bool) -> PresentationUpdate {
    let population = snapshot_population_frame_data(snapshot);
    project_update_with_population(snapshot, include_scene, population)
}

pub(crate) fn project_runtime_update(
    snapshot: &GameSnapshot,
    world: &World,
    include_scene: bool,
) -> PresentationUpdate {
    let population = population::runtime_population_frame_data(snapshot, world);
    project_update_with_population(snapshot, include_scene, population)
}
```

`project_update_with_population` must leave every existing HPA-544 field/serde name unchanged.

Change `GameEngine::presentation()` and tick/dispatch result production to `project_runtime_update`.

- [ ] **Step 5: Make `GameplayUpdateResult` wrap precomputed updates**

Use:

```rust
pub fn present(update: PresentationUpdate) -> Self { /* applied true */ }
pub fn frame_only(update: PresentationUpdate, applied: bool) -> Self { /* no rejection */ }
pub fn rejected(update: PresentationUpdate, rejection: GameplayRejection) -> Self { /* applied false */ }
```

Delete the `GameSnapshot` dependency/import from `intent.rs` if no longer otherwise needed.

- [ ] **Step 6: Reconcile population on committed building mutations**

Before installing an applied shell candidate, compare the old/new building vectors. When changed, call `population::reconcile_buildings` against the **candidate** active trips/vehicles, then install the candidate.

Rejected and no-op dispatches do not mutate the world. Pure preview remains snapshot-only.

This is the engine integration that makes Task 4's demolition/assignment tests authoritative again.

- [ ] **Step 7: Retarget `GameEngine::Clone` test conveniences**

Replace current `engine.clone()` uses in `src-tauri/src/lib.rs` and `crates/caelum-core/tests/service_control.rs` with explicit independent fixture creation. If a test needs the exact current durable state, use:

```rust
let snapshot = engine.snapshot();
let mut copy = GameEngine::from_snapshot(snapshot).expect("fixture snapshot is valid");
```

and explicitly set paused/running state required by that test afterward. Do not add a production `Clone` implementation that reconstructs the ECS world.

Use:

```bash
rg 'engine\.clone\(\)|GameEngine.*Clone|derive\(Clone\).*GameEngine' crates/caelum-core src-tauri
```

Expected after edits: no production `GameEngine` clone contract.

- [ ] **Step 8: Restore integration parity for population lifecycle**

Update `tests/population.rs` to assert through `engine.snapshot()` that:

- paused housing remains empty;
- due move-ins fill capacity;
- workplace capacity remains finite;
- housing demolition removes residents/active trips;
- workplace demolition reassigns/cancels outbound demand correctly.

Also assert `engine.presentation().frame.population_count` and building occupancy match the durable snapshot values.

- [ ] **Step 9: Verify presentation and engine tests**

Run:

```bash
cargo test -p caelum-core --test population
cargo test -p caelum-core --test presentation_contract
cargo test -p caelum-core --test presentation_scale
cargo test -p caelum-core --test service_control
cargo test -p caelum-core engine::
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add crates/caelum-core/src/engine.rs crates/caelum-core/src/intent.rs crates/caelum-core/src/presentation.rs crates/caelum-core/src/persistence/mod.rs crates/caelum-core/tests src-tauri/src/lib.rs
git commit -m "feat: make ECS the live population authority"
```

---

### Task 7: Update the durable host wire without reintroducing citizens to live UI state

**Files:**
- Modify: `src/domain/types.ts`
- Modify: `src/runtime/backend/types.ts`
- Modify: persistence/restore tests returned by `rg -l 'schemaVersion|RustSim|workerProfile|commuteDay|commuteOutbound|commuteReturn' src tests`
- Modify: WASM/core cross-host snapshot fixtures that assert schema 9

**Interfaces:**
- Consumes: v10 Rust serde shape from Task 1.
- Produces: TypeScript durable snapshot types that accept v10 `CitizenRoutine`, `ScheduledActivity`, and optional trip purposes. Live `GameState` / `PresentationUpdate` stays exactly HPA-544 shaped.

- [ ] **Step 1: Update the TS durable domain types**

Replace `WorkerProfile` and old `Sim` daily flags with:

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

Match the actual serde representation produced by Rust. If serde encodes the externally tagged enum differently than the example TS union, use the observed Rust JSON exactly; do not change Rust solely to preserve the old TS shape.

- [ ] **Step 2: Update `RustSim` only for host `Option` encoding**

If WASM returns Rust `None` as `undefined`, define:

```ts
export interface RustSim extends Omit<Sim, "nextActivity"> {
  nextActivity: ScheduledActivity | null | undefined;
}
```

Keep this type inside the durable backend contract. Do not add `sims` back to ordinary presentation/live state.

- [ ] **Step 3: Update schema constant and restore tests**

Set the TS `SNAPSHOT_SCHEMA_VERSION` mirror to 10. Update persistence tests so v9 is rejected and v10 round-trips worker/student scheduled state through both JSON/native and WASM host paths.

Add one assertion that a normal gameplay tick/dispatch response still has no `sims` key anywhere in `PresentationUpdate`.

- [ ] **Step 4: Run cross-host verification**

Run:

```bash
bun run wasm:build:release
bun run check
bun run test:unit
cargo test -p caelum-wasm
cargo test -p caelum --lib
```

Expected: PASS; durable saves use schema 10, normal presentation remains unversioned and population-aggregate only.

- [ ] **Step 5: Commit**

```bash
git add src tests crates/caelum-wasm src-tauri
git commit -m "feat: align hosts with v10 citizen persistence"
```

---

### Task 8: Prove the 200k runtime shape, document the remaining bottleneck, and close cleanup guards

**Files:**
- Modify: `crates/caelum-core/examples/presentation_scale.rs`
- Modify: `docs/performance/hpa-347-ecs-population.md`
- Modify: `docs/architecture.md`
- Modify: `CLAUDE.md` only if its simulation ownership description is now stale

**Interfaces:**
- Consumes: final ECS engine/runtime, HPA-544 harness, Task 0 before values.
- Produces: 10k/50k/200k construction/quiet-tick/save/presentation evidence and 1k/5k/20k due-wave separation between ECS emission and current route choice.

- [ ] **Step 1: Update the scale fixture to build the final v10/ECS runtime**

Retain the existing snapshot/presentation cardinality rows. Add final runtime measurements with labels:

```text
ecs-10000
secs-50000
secs-200000
wave-1000
wave-5000
wave-20000
```

Use `GameEngine::from_snapshot` for valid durable fixtures where feasible. For high-cardinality construction that cannot correspond to one small map's housing capacity, use a dedicated `#[doc(hidden)]`/example-only population fixture constructor inside the example module rather than weakening production persistence validation.

Measure separately:

```text
runtime_build_us
quiet_tick_us
runtime_presentation_us
full_snapshot_us
schedule_emit_us
route_spawn_us
```

Do not combine ECS emission and routing into one unexplained number for the wave rows.

- [ ] **Step 2: Add structural 200k tests without timing thresholds**

In `presentation_scale`/population tests, assert:

```rust
assert_eq!(population::population_count(&world), 200_000);
assert!(live_shell.sims.is_empty());
assert_eq!(runtime_update.frame.population_count, 200_000);
assert_eq!(quiet_tick_active_trip_count_before, quiet_tick_active_trip_count_after);
```

Add a due-bucket test where exactly N citizens are scheduled now and `drain_trip_demands` returns exactly N stable-sorted IDs even though the world contains 200,000 entities.

- [ ] **Step 3: Record the final reference table**

Append to `docs/performance/hpa-347-ecs-population.md`:

```markdown
## After ECS cutover
| Fixture | ECS citizens | Runtime build µs | Quiet tick µs | Runtime presentation µs | Full snapshot µs |
| --- | ---: | ---: | ---: | ---: | ---: |
...

## Due demand wave
| Fixture | Due citizens | ECS schedule+emit µs | Existing route spawn µs |
| --- | ---: | ---: | ---: |
...
```

Fill every row from one release run on the same reference machine. Explain whether route creation is now the dominant wave cost; if so, name HPA-348 as the owner. Do not invent a pass/fail millisecond threshold after seeing the values.

- [ ] **Step 4: Update architecture ownership docs**

Document:

- `GameEngine` owns shell + topology + ECS world/schedule;
- live shell `sims` is empty by invariant;
- durable snapshot reconstructs sims;
- population scheduler is time-bucketed;
- HPA-544 presentation reads aggregate ECS population data;
- HPA-348 remains route-choice batching, HPA-640 remains rendering/LOD.

Delete stale statements that say sandbox ticking owns `Vec<Sim>` directly.

- [ ] **Step 5: Run source-shape guards**

Run:

```bash
rg 'state\.sims|snapshot\.sims|\.sims\.iter|\.sims\.len' crates/caelum-core/src
```

Expected matches are limited to deliberate durable/persistence projection code (`model`, `persistence`, pure durable `presentation::project_update`, and `population::snapshot_sims` support). `trips.rs`, `buildings.rs`, and population-dependent `transit.rs` cleanup must not perform ordinary live sim scans.

Run:

```bash
rg 'bevy::|bevy_app|multi_threaded|bevy_reflect|rand::' crates/caelum-core Cargo.toml
```

Expected: no prohibited full-Bevy/reflection/multithreading/rand usage; only `bevy_ecs` imports/dependency.

Run:

```bash
rg 'Entity' crates/caelum-core/src/model.rs src/domain/types.ts src/runtime/backend/types.ts crates/caelum-core/src/presentation.rs
```

Expected: no Bevy runtime entity ID in durable/public presentation types.

- [ ] **Step 6: Run complete Rust/TS/WASM/E2E verification**

Run:

```bash
cargo +stable fmt --all --check
cargo +stable clippy --workspace --all-targets --locked -- -D warnings
cargo +stable test --workspace
cargo +stable build --workspace --all-targets --locked
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

Expected: every command PASS; the release example prints the completed before/after reference rows.

- [ ] **Step 7: Self-review spec coverage and placeholder/type consistency**

Check each spec section against the implemented files:

```bash
rg 'TBD|TODO|<measured value>|<copy |placeholder' \
  docs/superpowers/specs/2026-09-04-ecs-latent-population-design.md \
  docs/superpowers/plans/2026-09-04-ecs-latent-population.md \
  docs/performance/hpa-347-ecs-population.md
```

Expected: no plan/spec/performance placeholders. Code `TODO`s unrelated to HPA-347 are not part of this document guard.

Confirm the exact runtime interfaces used by `engine.rs` and `trips.rs` still match the names/signatures established in Tasks 2–5. Fix drift rather than adding aliases.

- [ ] **Step 8: Commit the evidence/docs and keep implementation on this PR**

```bash
git add crates/caelum-core/examples/presentation_scale.rs crates/caelum-core/tests docs CLAUDE.md
git commit -m "docs: record HPA-347 ECS scale evidence"
```

Then update the existing HPA-347 draft PR body from “planning” to an implementation summary; do not create another PR.
