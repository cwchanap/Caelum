# HPA-348 Route Choice Batching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make large same-time commute/leisure waves reuse static transit and private-car route work while preserving Caelum's sequential congestion-sensitive mode choice exactly.

**Architecture:** Build one crate-private `DemandBatchPlanner` per `spawn_pending_trip_demands` call. Transit candidate shapes cache by exact tile OD; private-car Dijkstra results cache by resolved road-access pair while exact-tile access walk and all flow-sensitive ETA are re-scored per citizen. One shared mixed-peak fixture feeds the benchmark, engine integration smoke, and coarse/split scale proof.

**Tech Stack:** Rust 1.95+, `caelum-core`, existing `bevy_ecs` 0.19.1 population runtime, deterministic `RoadTopology`, existing Rust release benchmark; no new dependency.

**Spec:** `docs/superpowers/specs/2026-09-07-route-choice-batching-design.md`

## Global Constraints

- One Linear ticket = one GitHub PR; all implementation/evidence remains on PR #57.
- Preserve canonical `TripDemand` order.
- Preserve strict car selection: `car.estimated_seconds < non_car.estimated_seconds`; ties remain non-car.
- Mutate `RoadFlow` only after a private-car win and before scoring the next demand.
- Never cache Bus/private-car congestion ETA or a final mode choice across citizens.
- Transit candidate cache key: exact `(origin, destination)` tile OD.
- Private-car Dijkstra cache key: resolved origin/destination road point + preferred heading.
- Cache lifetime: one `spawn_pending_trip_demands` call. No revision counter, persistent cache, eviction, TTL, zones, or departure bands.
- `RoutePlanner`, `PrivateCarPlanner`, and `DemandBatchPlanner` stay `pub(crate)`.
- External integration tests use public one-shot routing or the existing documentation-hidden `GameEngine` scale harness; they do not make planners public.
- Keep `ActiveTrip`, passenger, and transit-vehicle storage unchanged unless measured evidence causes a separately reviewed design revision.
- No per-car Bevy entity. Congestion remains aggregate `RoadFlow`.
- No TypeScript/Svelte/WebGPU/persistence-store work.
- Wall-clock benchmark values are evidence, never CI thresholds.

## Main Risk

The key correctness regression needs a flow level where admitting one car flips a later identical OD from car to non-car. Existing Bus boarding and car access penalties may leave a wide gap in the first geometry.

Search deterministic initial `RoadFlow` using actual production scoring. If the shared benchmark geometry cannot provide a clean one-car switch, build a smaller Rust-only switch fixture. Adjust fixture geometry only; never alter gameplay costs to manufacture the switch.

---

### Task 0: Create one shared mixed-peak fixture and record the pre-batching baseline

**Files:**
- Create: `crates/caelum-core/src/scale_fixture.rs`
- Modify: `crates/caelum-core/src/lib.rs`
- Modify: `crates/caelum-core/examples/presentation_scale.rs`
- Create: `crates/caelum-core/tests/route_choice_batching.rs`
- Create: `docs/performance/hpa-348-route-choice-batching.md`

**Interfaces:**
- Consumes: sandbox creation; existing road/building/Bus/Metro `GameIntent`s; `run_due_and_drain_for_scale_harness`; `spawn_drained_demands_for_scale_harness`.
- Produces: one documentation-hidden `mixed_peak_snapshot(count)` constructor and measured 1k/5k/20k pre-batching rows.

- [ ] **Step 1: Write the shared fixture constructor**

Create `scale_fixture.rs` with:

```rust
#[doc(hidden)]
pub fn mixed_peak_snapshot(count: usize) -> GameSnapshot
```

Build a Creative `blankGrid` engine through `GameEngine::from_sandbox_request`, then author this deterministic layout through existing `GameIntent`s:

| Content | Coordinates / rule |
| --- | --- |
| Two-way road | `(1,5)` through `(25,5)` |
| Small Houses | origins `(2,4)`, `(6,4)`, `(10,4)`, `(14,4)` |
| Supermarket | origin `(18,6)` |
| Factory | origin `(22,6)` |
| Bus stops | `(1,4)` and `(25,4)` |
| Bus route | Loop over the two created stops; assign one Bus |
| Track | `(1,9)` through `(25,9)` |
| Metro stations | `(2,9)` and `(24,9)` |
| Metro route | Loop over the two created stations; assign one train |

If a catalog footprint makes one listed origin overlap another authored object, move only that object along its same row while preserving road/track adjacency and record the final coordinates in a fixture comment. Do not change gameplay rules.

After authoring:

```rust
let mut snapshot = engine.snapshot();
snapshot.day = 0;
snapshot.time = 0.0;
snapshot.paused = true;
snapshot.speed = 1;
snapshot.active_trips.clear();
```

Collect every occupied tile from the four Small Houses as candidate origins and every occupied tile from the Supermarket/Factory as candidate destinations. Cap the deterministic matrix to at most 64 exact tile OD pairs while retaining at least two tiles from the same building on each side. This guarantees exact tile OD cardinality exceeds private-car access-pair cardinality.

Generate exactly `count` canonical Worker sims by scanning increasing ordinals and skipping:

- canonical Student ordinals (`shift_template_for_id(id).is_none()`);
- day-0 days off (`is_day_off(id, 0)`).

Each generated sim cycles through the retained OD matrix and uses:

```rust
Sim {
    id,
    home,
    position: home,
    routine: CitizenRoutine::Worker {
        shift_template: "standard".to_string(),
        workplace: Some(destination),
    },
    next_activity: Some(ScheduledActivity {
        kind: ScheduledActivityKind::DailyRoutine,
        due_time: 300.0,
    }),
}
```

In `lib.rs` add:

```rust
#[doc(hidden)]
pub mod scale_fixture;
```

- [ ] **Step 2: Write a fast mixed-fixture smoke test**

Create `tests/route_choice_batching.rs`:

```rust
#[test]
fn mixed_peak_fixture_produces_real_car_and_transit_choices() {
    let mut engine = GameEngine::from_snapshot(mixed_peak_snapshot(64)).unwrap();
    assert!(engine.dispatch(GameIntent::SetPaused { paused: false }).applied);

    let demands = engine.run_due_and_drain_for_scale_harness(301.0);
    assert_eq!(demands.len(), 64);
    engine.spawn_drained_demands_for_scale_harness(demands);

    let snapshot = engine.snapshot();
    assert_eq!(snapshot.active_trips.len(), 64);
    assert!(snapshot.active_trips.iter().any(|trip| trip.private_car_trip.is_some()));
    assert!(snapshot.active_trips.iter().any(|trip| {
        trip.route_plan.as_ref().is_some_and(|plan| {
            plan.legs.iter().any(|leg| {
                matches!(leg.mode, TransitMode::Bus | TransitMode::Metro)
            })
        })
    }));
}
```

Both Bus and Metro must be operational/reachable in the fixture. This smoke requires at least one transit winner rather than making CI depend on both modes winning a narrow cost race.

- [ ] **Step 3: Run the smoke and correct fixture geometry only**

```bash
cargo test -p caelum-core --test route_choice_batching mixed_peak_fixture_produces_real_car_and_transit_choices -- --nocapture
```

Expected after fixture tuning: PASS with 64 spawned trips, at least one car, and at least one Bus/Metro trip. Do not alter routing constants.

- [ ] **Step 4: Add pre-batching mixed rows to `presentation_scale`**

Add `measure_mixed_wave(label, count)` that:

1. builds `mixed_peak_snapshot(count)`;
2. resumes the engine;
3. drains exactly `count` demands at 301 seconds;
4. times only `spawn_drained_demands_for_scale_harness`;
5. takes a post-spawn snapshot;
6. derives `distinct_od` from the `BTreeSet<(trip.origin, trip.destination)>` of spawned trips;
7. counts modes with private car first, then Bus/Metro route legs, then walking-only, then planless/unserved.

Print fields in this exact order:

```text
mixed-wave-N count=N distinct_od=N route_spawn_us=N walk=N car=N bus=N metro=N unserved=N
```

Call it for `1_000`, `5_000`, and `20_000`.

- [ ] **Step 5: Record actual baseline rows**

Run:

```bash
uname -a
rustc --version
cargo run --release -p caelum-core --example presentation_scale
```

Create `docs/performance/hpa-348-route-choice-batching.md` with the exact environment output and a table whose columns are:

```text
Row | Due demands | Distinct tile OD | Route spawn µs | Walk | Car | Bus | Metro | Unserved
```

Populate every row directly from the command output. State explicitly that wall-clock values are reference evidence, not CI thresholds.

- [ ] **Step 6: Verify and commit Task 0**

```bash
cargo fmt --all -- --check
cargo test -p caelum-core --test route_choice_batching
cargo test -p caelum-core --test router_planning
cargo run --release -p caelum-core --example presentation_scale
```

Expected: PASS; every release row has `distinct_od < count`, and the smoke remains mixed.

Commit:

```bash
git add crates/caelum-core/src/scale_fixture.rs crates/caelum-core/src/lib.rs crates/caelum-core/examples/presentation_scale.rs crates/caelum-core/tests/route_choice_batching.rs docs/performance/hpa-348-route-choice-batching.md
git commit -m "perf: add shared mixed route-choice baseline"
```

---

### Task 1: Reuse transit candidate preparation without exposing planner types

**Files:**
- Modify: `crates/caelum-core/src/router.rs`

**Interfaces:**
- Consumes: `find_route_plan`, `active_services`, `RideEdge`, `best_candidate`, `plan_identity_key`.
- Produces: crate-private `RoutePlanner`; public `find_route_plan` signature remains unchanged.

- [ ] **Step 1: Write RED unit tests inside `router.rs`**

Add module tests that prove:

```text
A. RoutePlanner output == public one-shot output for Bus and Metro.
B. Repeated exact OD under changed RoadFlow uses one prepared OD and produces a larger Bus ETA.
C. Equal-time plans retain current deterministic identity ordering.
```

The key cache test uses one planner, calls the same OD with free flow and then a flow loaded over the service path, asserts `planner.prepared.len() == 1`, and asserts the second ETA is larger.

- [ ] **Step 2: Run RED**

```bash
cargo test -p caelum-core router:: --lib -- --nocapture
```

Expected: FAIL because `RoutePlanner` does not exist.

- [ ] **Step 3: Add crate-private prepared types**

In `router.rs` add:

```rust
type OdKey = (Point, Point);

pub(crate) struct RoutePlanner {
    map_width: u16,
    map_height: u16,
    services: Vec<TransitService>,
    prepared: BTreeMap<OdKey, Option<Vec<PreparedCandidate>>>,
}

#[derive(Clone)]
struct PreparedCandidate {
    plan: RoutePlan,
    static_seconds: f64,
    rides: Vec<PreparedRide>,
}

#[derive(Clone)]
struct PreparedRide {
    service_index: usize,
    edge: RideEdge,
}
```

`RoutePlanner::new` calls `active_services(state)` once.

- [ ] **Step 4: Split current enumeration into preparation and dynamic scoring**

Add private methods:

```rust
fn prepare(&self, origin: Point, destination: Point) -> Option<Vec<PreparedCandidate>>;
fn score(&self, prepared: &[PreparedCandidate], flow: &RoadFlow) -> Option<RoutePlan>;
```

`prepare` performs the current walk, one-service, and two-service enumeration with the same route legs, board/alight indexes, transfer walks, and boarding constants. `score` clones a candidate plan, recomputes each Bus ride with current `RoadFlow`, keeps Metro fixed to its captured path duration, sets `estimated_seconds`, and invokes current `best_candidate`.

- [ ] **Step 5: Add exact-OD caching and keep the one-shot wrapper**

Implement crate-private:

```rust
pub(crate) fn find_route_plan(
    &mut self,
    flow: &RoadFlow,
    origin: Point,
    destination: Point,
) -> Option<RoutePlan>
```

On first `(origin, destination)` lookup, insert `prepare` output into `prepared`; every call scores the stored shape against the supplied flow.

Keep public:

```rust
pub fn find_route_plan(
    state: &GameSnapshot,
    flow: &RoadFlow,
    origin: &Point,
    destination: &Point,
) -> Option<RoutePlan> {
    RoutePlanner::new(state).find_route_plan(flow, *origin, *destination)
}
```

- [ ] **Step 6: Run gates and commit**

```bash
cargo test -p caelum-core router:: --lib
cargo test -p caelum-core --test router_planning
cargo fmt --all -- --check
```

Expected: PASS; external integration tests never reference `RoutePlanner`.

Commit:

```bash
git add crates/caelum-core/src/router.rs
git commit -m "refactor: reuse transit route preparation"
```

---

### Task 2: Cache private-car Dijkstra at the road-access grain

**Files:**
- Modify: `crates/caelum-core/src/traffic.rs`

**Interfaces:**
- Consumes: `derive_stop_access_for_footprint`, `StopRoadAccess`, `RoadTopology::find_path_between_access_tiles`, `PrivateCarCandidate`.
- Produces: crate-private `PrivateCarPlanner`; public `private_car_candidate` signature remains unchanged.

- [ ] **Step 1: Write RED unit tests inside `traffic.rs`**

Build a fixture where two exact origin tiles belong to the same building and two exact destination tiles belong to another building. Choose tiles with different Manhattan distance to their shared road access.

Assert:

```text
- first exact OD prepares one path;
- second exact OD sharing the same access pair reuses that path (`prepared_paths.len() == 1`);
- returned paths are equal;
- access-sensitive estimated seconds differ;
- adding the path to RoadFlow repeatedly raises ETA without creating another prepared path;
- a genuinely different access pair creates the second path entry.
```

- [ ] **Step 2: Run RED**

```bash
cargo test -p caelum-core traffic:: --lib -- --nocapture
```

Expected: FAIL because `PrivateCarPlanner` does not exist.

- [ ] **Step 3: Add access index and access-pair cache**

Add:

```rust
type CarPathKey = (
    Point,
    Option<Heading>,
    Point,
    Option<Heading>,
);

pub(crate) struct PrivateCarPlanner {
    access_by_tile: BTreeMap<Point, Option<StopRoadAccess>>,
    prepared_paths: BTreeMap<CarPathKey, Option<TransitPath>>,
}
```

`PrivateCarPlanner::new(state)` iterates buildings once. For each building, call `derive_stop_access_for_footprint(&state.map, &building.occupied_tiles)` once and map every occupied tile to that `Option<StopRoadAccess>`.

- [ ] **Step 4: Cache only Dijkstra path, not exact-tile access seconds**

Resolve `origin_access` and `destination_access` from `access_by_tile`. Use this key:

```rust
(
    origin_access.road_point,
    origin_access.preferred_heading,
    destination_access.road_point,
    destination_access.preferred_heading,
)
```

On a miss, call `find_path_between_access_tiles` with those points/headings and store the path result.

On every call recompute:

```text
manhattan(origin, origin_access.road_point) * WALK_SECONDS_PER_TILE
+ CAR_ACCESS_SECONDS
+ current-flow road step seconds with existing candidate +1 load
+ manhattan(destination_access.road_point, destination) * WALK_SECONDS_PER_TILE
```

Return an owned `PrivateCarCandidate` with a cloned cached path.

- [ ] **Step 5: Keep public one-shot wrapper unchanged**

The public function constructs one `PrivateCarPlanner` and delegates once. Do not change congestion constants, `RoadFlow`, Dijkstra, or candidate-load semantics.

- [ ] **Step 6: Run gates and commit**

```bash
cargo test -p caelum-core traffic:: --lib
cargo test -p caelum-core --test traffic
cargo test -p caelum-core --test router_planning
cargo fmt --all -- --check
```

Expected: PASS.

Commit:

```bash
git add crates/caelum-core/src/traffic.rs
git commit -m "refactor: reuse private car access paths"
```

---

### Task 3: Add the crate-private mode-choice coordinator without editing `trips.rs`

**Files:**
- Create: `crates/caelum-core/src/route_choice.rs`
- Modify: `crates/caelum-core/src/lib.rs`

**Interfaces:**
- Consumes: `RoutePlanner`, `PrivateCarPlanner`, current strict `<` comparison.
- Produces: crate-private `DemandBatchPlanner::choose`; no `RoadFlow` mutation.

- [ ] **Step 1: Write RED coordinator unit tests**

Add tests for:

```text
- representative choice equals a reference one-shot calculation;
- equal ETA keeps non-car;
- repeated identical OD is re-scored after the test mutates RoadFlow;
- choose itself does not mutate RoadFlow.
```

For the switch case, search at most 64 candidate load levels using current one-shot route/car scoring. Return the first flow where car wins now but loses after one `add_car_path_to_flow`. Panic with a fixture-specific message if none exists so geometry must be corrected rather than semantics weakened.

- [ ] **Step 2: Run RED**

```bash
cargo test -p caelum-core route_choice:: --lib -- --nocapture
```

Expected: FAIL because the module/types do not exist.

- [ ] **Step 3: Add one coordinator and one strict decision helper**

Create:

```rust
pub(crate) enum RouteChoice {
    PrivateCar(PrivateCarTrip),
    NonCar(RoutePlan),
    Unserved,
}

pub(crate) struct DemandBatchPlanner {
    non_car: crate::router::RoutePlanner,
    private_car: crate::traffic::PrivateCarPlanner,
}
```

Add private:

```rust
fn private_car_trip_if_faster(
    non_car_plan: Option<&RoutePlan>,
    car: Option<crate::traffic::PrivateCarCandidate>,
    current_time: f64,
) -> Option<PrivateCarTrip> {
    let car = car.filter(|candidate| {
        non_car_plan.is_none_or(|plan| candidate.estimated_seconds < plan.estimated_seconds)
    })?;
    Some(PrivateCarTrip {
        path: car.path,
        arrival_time: current_time + car.estimated_seconds,
    })
}
```

Implement:

```rust
pub(crate) fn choose(
    &mut self,
    map: &GameMap,
    road_topology: &RoadTopology,
    road_flow: &RoadFlow,
    origin: Point,
    destination: Point,
    current_time: f64,
) -> RouteChoice
```

It queries both planners against current flow, returns owned `PrivateCarTrip` if strict comparison wins, otherwise returns the non-car plan or `Unserved`. It never mutates flow.

- [ ] **Step 4: Register only a private module**

In `lib.rs` add:

```rust
pub(crate) mod route_choice;
```

Do not re-export planners/coordinator.

- [ ] **Step 5: Run gates and commit**

```bash
cargo test -p caelum-core route_choice:: --lib
cargo test -p caelum-core --test router_planning
cargo test -p caelum-core --test traffic
cargo test -p caelum-core --test trip_lifecycle
cargo fmt --all -- --check
```

Expected: PASS and `git diff -- crates/caelum-core/src/trips.rs` is empty for this task.

Commit:

```bash
git add crates/caelum-core/src/route_choice.rs crates/caelum-core/src/lib.rs
git commit -m "feat: add batch route choice coordinator"
```

---

### Task 4: Cut over the spawn loop once and lock sequential equivalence at the real seam

**Files:**
- Modify: `crates/caelum-core/src/trips.rs`
- Modify: `crates/caelum-core/src/route_choice.rs`
- Modify: `crates/caelum-core/tests/route_choice_batching.rs`
- Modify: `crates/caelum-core/tests/population_scale.rs`

**Interfaces:**
- Consumes: `DemandBatchPlanner`, shared `mixed_peak_snapshot`, current `spawn_pending_trip_demands`.
- Produces: one planner per batch; ordered car admission; reference-vs-batched spawn unit test; external composition smoke; coarse/split scale proof.

- [ ] **Step 1: Add a reference-vs-current spawn unit test before cutover**

Inside `trips.rs`'s `#[cfg(test)]` module, create an ordered repeated-OD `Vec<population::TripDemand>` and deterministic switch-starting flow.

Define test-only:

```rust
#[derive(Debug, PartialEq)]
enum ChoiceDescriptor {
    Car { path: TransitPath, arrival_time: f64 },
    NonCar(RoutePlan),
    Planless,
}
```

The reference helper loops cloned demands and uses current public one-shot functions:

```text
non_car = router::find_route_plan(current flow)
car = traffic::private_car_candidate(current flow)
car wins only on strict <
if car wins: record Car and mutate reference flow immediately
else if non-car plan exists and legs are non-empty: record NonCar
else: record Planless
```

Run current `spawn_pending_trip_demands` on cloned state/flow/demands. Derive actual descriptors from appended `ActiveTrip` rows and assert exact sim order, descriptor equality, and final `RoadFlow` equality. Also assert the repeated identical OD sequence contains a car choice followed later by non-car.

- [ ] **Step 2: Run the reference test before production replacement**

```bash
cargo test -p caelum-core trips::tests::same_time_batch_matches_sequential_one_shot_reference --lib -- --nocapture
```

Expected: PASS on current production behavior.

- [ ] **Step 3: Add one internal stats shape**

In `route_choice.rs` add:

```rust
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct RouteChoiceBatchStats {
    pub(crate) transit_prepared_od: usize,
    pub(crate) car_prepared_access_paths: usize,
}
```

`DemandBatchPlanner::stats()` returns the two internal cache lengths. Do not create separate stats types.

- [ ] **Step 4: Replace the spawn loop with one planner**

Change `spawn_pending_trip_demands` to construct one planner before the loop, call `choose` once per demand, build the `ActiveTrip`, push it, then return `planner.stats()`.

For private car:

```rust
traffic::add_car_path_to_flow(road_flow, &car.path);
trip.status = TripStatus::Driving;
trip.private_car_trip = Some(car);
```

This mutation must complete before the loop's next `choose`.

For non-car:

```rust
if !plan.legs.is_empty() {
    trip.status = status_after_leg(&plan, 0);
    trip.route_plan = Some(plan);
}
```

For `RouteChoice::Unserved`, leave the fresh trip `Idle`, planless, and without `private_car_trip`, matching current spawn behavior. Do not mark it unserved early.

Delete the demand-spawn copy of `private_car_trip_if_faster` from `trips.rs` and the old in-loop one-shot route/car calls. Tick-time replan calls elsewhere stay unchanged.

- [ ] **Step 5: Re-run the exact spawn-seam regression**

```bash
cargo test -p caelum-core trips::tests::same_time_batch_matches_sequential_one_shot_reference --lib -- --nocapture
```

Expected: PASS with byte-for-byte-equal route plans/paths, equal car arrival times, equal order, and equal final flow.

- [ ] **Step 6: Keep external integration at the engine seam**

Extend `tests/route_choice_batching.rs` with `mixed_peak_snapshot(200)`. Before moving the fixture into `GameEngine`, store the expected sim ID order from `fixture.sims`. Drain/spawn at 301 seconds, then assert post-spawn `active_trips` sim IDs equal that expected canonical order, and retain car + transit assertions.

Do not access private `TripDemand` fields or planner types from integration tests.

- [ ] **Step 7: Add coarse-vs-split mixed-wave release proof**

In `tests/population_scale.rs`, build coarse/split engines from the same `mixed_peak_snapshot(20_000)`, resume both, advance coarse by 900 seconds and split by thirty 30-second ticks, then compare complete durable snapshots.

If a real trip boundary extends beyond 900 seconds and causes both snapshots to remain mid-wave, increase the shared window equally for both engines until the test covers spawn plus travel progression. Keep exact snapshot equality.

- [ ] **Step 8: Run Task-4 gates and commit**

```bash
cargo test -p caelum-core --lib
cargo test -p caelum-core --test route_choice_batching
cargo test -p caelum-core --test trip_lifecycle
cargo test -p caelum-core --test router_planning
cargo test -p caelum-core --test traffic
cargo test --release -p caelum-core --test population_scale mixed_route_choice_wave_is_coarse_split_deterministic -- --ignored --nocapture
cargo fmt --all -- --check
```

Expected: all PASS.

Commit:

```bash
git add crates/caelum-core/src/trips.rs crates/caelum-core/src/route_choice.rs crates/caelum-core/tests/route_choice_batching.rs crates/caelum-core/tests/population_scale.rs
git commit -m "perf: batch repeated route choice work"
```

---

### Task 5: Expose one hidden stats snapshot and record final evidence

**Files:**
- Modify: `crates/caelum-core/src/route_choice.rs`
- Modify: `crates/caelum-core/src/engine.rs`
- Modify: `crates/caelum-core/src/lib.rs`
- Modify: `crates/caelum-core/examples/presentation_scale.rs`
- Modify: `docs/performance/hpa-348-route-choice-batching.md`

**Interfaces:**
- Consumes: Task-4 internal stats and existing scale-harness spawn method.
- Produces: one documentation-hidden stats value for the benchmark; no normal host/wire telemetry.

- [ ] **Step 1: Make only the stats snapshot documentation-hidden public**

Change the internal struct to:

```rust
#[doc(hidden)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RouteChoiceBatchStats {
    pub transit_prepared_od: usize,
    pub car_prepared_access_paths: usize,
}
```

Keep all planners crate-private. Re-export only the stats type from `lib.rs` if required by the public harness return type:

```rust
#[doc(hidden)]
pub use route_choice::RouteChoiceBatchStats;
```

- [ ] **Step 2: Return stats from the existing scale-harness spawn method**

Change `GameEngine::spawn_drained_demands_for_scale_harness` to return `RouteChoiceBatchStats` from `trips::spawn_pending_trip_demands`. Normal tick and host methods remain unchanged. Existing callers may ignore the returned value.

- [ ] **Step 3: Print final preparation counts**

Update `measure_mixed_wave` to print:

```text
transit_prepared_od=N car_prepared_access_paths=N
```

alongside the existing count, distinct tile OD, route time, and mode counts.

Because the shared fixture deliberately uses multiple exact tiles per building, assert in the release harness that `car_prepared_access_paths < distinct_od` for the mixed rows. Transit preparation may equal the distinct exact tile OD count.

- [ ] **Step 4: Run final release evidence**

```bash
uname -a
rustc --version
cargo run --release -p caelum-core --example presentation_scale
cargo test --release -p caelum-core --test population_scale -- --ignored --nocapture
```

Record the output verbatim.

- [ ] **Step 5: Complete the performance document**

Add a final table with these columns:

```text
Row | Due | Distinct tile OD | Route spawn µs | Transit prepared OD | Car prepared access paths | Walk | Car | Bus | Metro | Unserved
```

Populate every row directly from command output. Under the table write three evidence conclusions supported by the numbers:

1. whether transit preparation is bounded by exact tile OD cardinality;
2. whether car Dijkstra preparation is bounded by access-pair cardinality and lower than distinct tile OD on the shared-building fixture;
3. which measured phase is now the dominant remaining cost.

If scheduler emission remains dominant, state that and stop. If another subsystem dominates, record it as follow-up evidence without widening HPA-348.

- [ ] **Step 6: Commit final evidence**

```bash
git add crates/caelum-core/src/route_choice.rs crates/caelum-core/src/engine.rs crates/caelum-core/src/lib.rs crates/caelum-core/examples/presentation_scale.rs docs/performance/hpa-348-route-choice-batching.md
git commit -m "docs: record HPA-348 route choice evidence"
```

---

### Task 6: Run the whole-product gate and close scope

**Files:**
- Modify only task-owned files if verification reveals a concrete HPA-348 defect.

**Interfaces:**
- Consumes: completed HPA-348 branch.
- Produces: one review-ready PR with no public planner API, duplicate production mode-choice path, frontend drift, or unmeasured follow-on subsystem.

- [ ] **Step 1: Run Rust gates**

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace
cargo build --workspace --locked
```

Expected: PASS.

- [ ] **Step 2: Run frontend/browser gates**

```bash
bun install --frozen-lockfile
bun run wasm:build:release
bun run check
bun run lint:svelte
bun run lint:css
bun run test:unit
bun run test:e2e
bun run build
```

Expected: PASS. Do not add a Playwright test solely for this Rust-internal optimization.

- [ ] **Step 3: Re-run scale gates**

```bash
cargo run --release -p caelum-core --example presentation_scale
cargo test --release -p caelum-core --test population_scale -- --ignored --nocapture
```

Expected: PASS and output matches the committed performance document.

- [ ] **Step 4: Scan for scope and duplicate routing decisions**

```bash
git diff --stat origin/main...HEAD
git diff --name-only origin/main...HEAD
rg "private_car_trip_if_faster" crates/caelum-core/src
rg "find_route_plan\(state, road_flow|private_car_candidate\(state, road_topology, road_flow" crates/caelum-core/src/trips.rs
rg "struct (RoutePlanner|PrivateCarPlanner|DemandBatchPlanner)" crates/caelum-core/src
rg "network_revision|RouteCache|Lru|TTL" crates/caelum-core/src
```

Expected:

- exactly one `private_car_trip_if_faster`, in `route_choice.rs`;
- no one-shot route/car calls inside the pending-demand spawn loop;
- tick-time one-shot replans may remain;
- all three planners are crate-private;
- no revision/cache framework exists;
- no TS/Svelte/WebGPU/persistence-store files changed.

- [ ] **Step 5: Update PR #57 with final evidence**

Replace the planning-only PR summary with the actual baseline/final 1k/5k/20k rows, preparation counts, spawn-seam reference equality + congestion-switch result, coarse/split result, full gate result, and measured remaining bottleneck. Keep PR #57 as the only delivery PR for HPA-348.
