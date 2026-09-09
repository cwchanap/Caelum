# HPA-348 Route Choice Batching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make large same-time commute/leisure waves reuse static transit and private-car network work while preserving Caelum's sequential congestion-sensitive route choice exactly.

**Architecture:** Construct one crate-private `DemandBatchPlanner` for each `spawn_pending_trip_demands` call. Transit work is prepared at the correct batch grain: active services and direct/transfer route shapes are enumerated once, each citizen scores those shapes with scalar Manhattan terms, Bus ride durations refresh only after a car changes `RoadFlow`, and only the winner becomes a `RoutePlan`. Private-car building access is indexed once and Dijkstra paths cache by resolved road-access pair while exact-tile access walk and current-flow ETA remain per demand.

**Tech Stack:** Rust 1.95+, `caelum-core`, standalone `bevy_ecs` 0.19.1 population runtime, existing deterministic `RoadTopology`, Rust integration/release tests; no new dependency.

**Spec:** `docs/superpowers/specs/2026-09-07-route-choice-batching-design.md`

## Global Constraints

- One Linear ticket = one GitHub PR; implementation/evidence stays on PR #57.
- Preserve canonical `TripDemand` order.
- Preserve strict car selection: `car.estimated_seconds < non_car.estimated_seconds`; ties remain non-car.
- Mutate `RoadFlow` only after a private-car win and before scoring the next demand.
- Call the batch planner's flow-change notification immediately after that mutation.
- Transit service/route-shape preparation is once per batch, **not exact-OD cached**.
- Transit per-citizen scoring must not allocate one `RoutePlan`/identity vector per candidate; materialize only the winner.
- Bus ride durations refresh only when the batch-local flow generation changes; Metro durations remain stable for the batch.
- Private-car Dijkstra cache key: resolved origin/destination road point + preferred heading.
- Private-car exact-tile walk and current-flow ETA remain per demand.
- Cache lifetime: one `spawn_pending_trip_demands` call. No persistent network revision, eviction, TTL, zones, or departure bands.
- `RoutePlanner`, `PrivateCarPlanner`, and `DemandBatchPlanner` stay `pub(crate)`.
- Use `HashMap` for lookup-only private-car indexes/caches; their iteration order is never gameplay input.
- Keep `ActiveTrip`, passenger, and transit-vehicle storage unchanged.
- No per-car Bevy entity. Congestion remains aggregate `RoadFlow`.
- No TypeScript/Svelte/WebGPU/persistence-store work.
- Wall-clock values are evidence, never CI thresholds.
- Do not claim the entire active-trip pipeline is cheap from spawn timing alone; record a post-spawn tick row too.

---

### Task 0: Build the shared mixed/stress workload and record the pre-batching baseline

**Files:**
- Modify: `crates/caelum-core/tests/common/mod.rs`
- Create: `crates/caelum-core/tests/common/route_choice_fixture.rs`
- Create: `crates/caelum-core/tests/route_choice_batching.rs`
- Create: `crates/caelum-core/tests/route_choice_scale.rs`
- Create: `docs/performance/hpa-348-route-choice-batching.md`

**Interfaces:**
- Consumes: `GameEngine::from_sandbox_request`, current `GameIntent` authoring APIs, canonical Worker helpers, `run_due_and_drain_for_scale_harness`, `spawn_drained_demands_for_scale_harness`.
- Produces: one test-common `mixed_peak_snapshot(count, bus_route_count)` fixture, a fast composition smoke, and pre-batching base/stress evidence.

- [ ] **Step 1: Add the shared fixture module and author every prerequisite explicitly**

In `tests/common/mod.rs` add:

```rust
pub mod route_choice_fixture;
```

Create `tests/common/route_choice_fixture.rs` with:

```rust
pub fn mixed_peak_snapshot(count: usize, bus_route_count: usize) -> GameSnapshot
```

Start from a Standard blank grid with enough fixed capital for the 8-service stress case:

```rust
let mut engine = GameEngine::from_sandbox_request(SandboxCreationRequest {
    template_id: "blankGrid".to_string(),
    economy_preset: "standard".to_string(),
    starting_capital: Some(1_000_000.0),
    demand_multiplier: Some(1.0),
})
.expect("route-choice fixture must construct");
```

Use one helper for every mutation so fixture failures are loud:

```rust
fn apply(engine: &mut GameEngine, intent: GameIntent, label: &str) {
    let result = engine.dispatch(intent);
    assert!(result.applied, "{label} must apply: {result:?}");
    assert!(result.rejection.is_none(), "{label} rejected: {result:?}");
}
```

Author in this order:

1. **Road:** two-way corridor `(1,5)` through `(26,5)` using the same repeated `LayRoad` pattern as `router_planning::road_line`.
2. **Track:** corridor `(1,9)` through `(26,9)`.
3. **Areas before buildings:**
   - residential rectangle `(3,6)` → `(19,6)`;
   - commercial rectangle `(22,6)` → `(23,7)`;
   - industrial rectangle `(21,3)` → `(23,4)`.
4. **Buildings:**
   - Small House origins `(3,6)`, `(8,6)`, `(13,6)`, `(18,6)`;
   - Supermarket origin `(22,6)`;
   - Factory origin `(21,3)`.
5. **Bus stops:** `(2,4)`, `(9,4)`, `(17,4)`, `(25,4)`.
6. **Bus services:** loop `bus_route_count` times, each time creating a Loop route over all four stop IDs and assigning one bus to the generated `route-{n:03}` ID.
7. **Metro stations:** `(2,9)`, `(9,9)`, `(17,9)`, `(25,9)`.
8. **Metro service:** one Loop over all four station IDs and one assigned train.

Every `PaintAreaRectangle`, `PlaceBuilding`, stop/station, route, and vehicle dispatch uses `apply(...)`. Do not add a fallback that silently moves an invalid object; the fixed coordinates are the fixture contract.

The base workload calls `mixed_peak_snapshot(count, 1)` (1 Bus + 1 Metro = 2 services). The transit-stress workload calls `mixed_peak_snapshot(count, 7)` (7 Bus + 1 Metro = 8 services). Every route has four waypoints.

- [ ] **Step 2: Populate exactly `count` same-time canonical Workers using real building tiles**

After authoring, take the snapshot and collect:

```rust
let home_tiles = snapshot
    .buildings
    .iter()
    .filter(|building| building.building_type == "smallHouse")
    .flat_map(|building| building.occupied_tiles.iter().copied())
    .collect::<Vec<_>>();

let job_tiles = snapshot
    .buildings
    .iter()
    .filter(|building| matches!(building.building_type.as_str(), "supermarket" | "factory"))
    .flat_map(|building| building.occupied_tiles.iter().copied())
    .collect::<Vec<_>>();
```

Generate IDs in increasing numeric order. Skip Students and day-0 days off using the same production helpers as `population_scale`:

```rust
if shift_template_for_id(&id).is_none() || is_day_off(&id, 0) {
    continue;
}
```

Cycle independently through `home_tiles` and `job_tiles`; do not impose a 64-OD cap. Each row is:

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

Set `day=0`, `time=0.0`, `paused=true`, `speed=1`, clear active trips, and assign the generated sims.

- [ ] **Step 3: Add a fast composition smoke before any routing refactor**

Create `tests/route_choice_batching.rs`:

```rust
mod common;

use caelum_core::model::TransitMode;
use caelum_core::{GameEngine, GameIntent};
use common::route_choice_fixture::mixed_peak_snapshot;

#[test]
fn mixed_peak_fixture_has_real_car_transit_and_service_stress() {
    let base = mixed_peak_snapshot(128, 1);
    assert_eq!(base.transit.routes.len() + base.transit.metro_lines.len(), 2);
    assert!(base.transit.routes.iter().all(|route| route.stop_ids.len() >= 4));
    assert!(base.transit.metro_lines.iter().all(|line| line.station_ids.len() >= 4));

    let mut engine = GameEngine::from_snapshot(base).unwrap();
    assert!(engine.dispatch(GameIntent::SetPaused { paused: false }).applied);
    let demands = engine.run_due_and_drain_for_scale_harness(301.0);
    assert_eq!(demands.len(), 128);
    engine.spawn_drained_demands_for_scale_harness(demands);

    let snapshot = engine.snapshot();
    assert!(snapshot.active_trips.iter().any(|trip| trip.private_car_trip.is_some()));
    assert!(snapshot.active_trips.iter().any(|trip| {
        trip.route_plan.as_ref().is_some_and(|plan| {
            plan.legs.iter().any(|leg| matches!(leg.mode, TransitMode::Bus | TransitMode::Metro))
        })
    }));

    let stress = mixed_peak_snapshot(128, 7);
    assert_eq!(stress.transit.routes.len() + stress.transit.metro_lines.len(), 8);
    assert!(stress.transit.routes.iter().all(|route| route.stop_ids.len() >= 4));
    assert!(stress.transit.metro_lines.iter().all(|line| line.station_ids.len() >= 4));
}
```

Both Bus and Metro must be operational/reachable in the base fixture. The smoke requires at least one transit winner rather than making CI depend on both modes winning a narrow cost race.

Run:

```bash
cargo test -p caelum-core --test route_choice_batching -- --nocapture
```

Expected: PASS before production routing changes. If car/transit mix fails, adjust only fixture geometry and keep every production constant unchanged.

- [ ] **Step 4: Add an ignored release benchmark that times spawn and one post-spawn tick**

Create `tests/route_choice_scale.rs` with `mod common;` and one ignored test. For each row:

```text
mixed-wave-1000      count=1000  bus_route_count=1
mixed-wave-5000      count=5000  bus_route_count=1
mixed-wave-20000     count=20000 bus_route_count=1
transit-stress-20000 count=20000 bus_route_count=7
```

The measurement helper must:

1. build the shared snapshot;
2. resume;
3. drain exactly `count` demands at `t=301`;
4. time `spawn_drained_demands_for_scale_harness`;
5. take the post-spawn snapshot and derive:
   - active service count;
   - distinct `(trip.origin, trip.destination)` count;
   - walk/car/Bus/Metro/planless counts;
6. time one `engine.tick(1.0)` after spawn as `post_spawn_tick_us`.

Print:

```text
<label> count=N services=N distinct_od=N route_spawn_us=N post_spawn_tick_us=N walk=N car=N bus=N metro=N planless=N
```

Do not try to inspect crate-private `TripDemand` fields from this integration test.

- [ ] **Step 5: Record the baseline evidence**

Run:

```bash
uname -a
rustc --version
cargo test --release -p caelum-core --test route_choice_scale -- --ignored --nocapture
```

Create `docs/performance/hpa-348-route-choice-batching.md` with the exact environment and baseline table:

```text
Row | Due | Services | Distinct tile OD | Route spawn µs | Post-spawn tick µs | Walk | Car | Bus | Metro | Planless
```

Call out explicitly:

- HPA-347's old wave row was walking-heavy and is not the HPA-348 baseline;
- `transit-stress-20000` exists to exercise the `O(S² × E1 × E2)` service/ride-edge shape term;
- wall-clock values are reference evidence only.

- [ ] **Step 6: Verify and commit Task 0**

```bash
cargo fmt --all -- --check
cargo test -p caelum-core --test route_choice_batching
cargo test -p caelum-core --test router_planning
cargo test --release -p caelum-core --test route_choice_scale -- --ignored --nocapture
```

Expected: PASS; the stress row reports 8 services; the fast smoke remains car+transit mixed.

Commit:

```bash
git add crates/caelum-core/tests/common/mod.rs \
        crates/caelum-core/tests/common/route_choice_fixture.rs \
        crates/caelum-core/tests/route_choice_batching.rs \
        crates/caelum-core/tests/route_choice_scale.rs \
        docs/performance/hpa-348-route-choice-batching.md
git commit -m "perf: add representative route-choice baseline"
```

---

### Task 1: Hoist transit service/route-shape work and materialize only the winner

**Files:**
- Modify: `crates/caelum-core/src/router.rs`

**Interfaces:**
- Consumes: current `active_services`, `RideEdge`, `ride_seconds`, `walk_seconds`, `transit_leg`, `walk_leg`, and `plan_identity_key` semantics.
- Produces: crate-private `RoutePlanner::new`, `find_route_plan(flow, flow_generation, origin, destination)`, service/shape/refresh stats; public `router::find_route_plan` signature unchanged.

- [ ] **Step 1: Add RED unit tests beside the private planner**

Inside `router.rs` add tests that require the future API:

```text
A. one RoutePlanner returns the same Bus/Metro result as the current one-shot wrapper;
B. planner.service_count() and planner.shape_count() are unchanged after scoring many different ODs;
C. two calls with the same flow_generation do not increment flow_refresh_count;
D. after flow_generation increments and RoadFlow changes, flow_refresh_count increments once and Bus ETA changes;
E. equal-time route identity ordering matches current best_candidate/plan_identity_key behavior.
```

Reuse the existing public regression `router_planning::bus_route_plan_eta_reflects_current_car_flow_without_rebuilding_path` as the external behavior lock; do not duplicate its whole integration fixture internally.

Run RED:

```bash
cargo test -p caelum-core router:: --lib -- --nocapture
```

Expected: FAIL because `RoutePlanner`/shape helpers do not exist.

- [ ] **Step 2: Introduce compact route shapes, not prepared RoutePlans**

Replace per-citizen service enumeration with batch-owned structures conceptually shaped as:

```rust
#[derive(Clone)]
enum RouteShape {
    Direct {
        service_index: usize,
        edge_index: usize,
        board_at: Point,
        alight_at: Point,
        identity_key: Vec<(String, Option<usize>, Option<usize>)>,
    },
    Transfer {
        first_service_index: usize,
        first_edge_index: usize,
        second_service_index: usize,
        second_edge_index: usize,
        first_start: Point,
        transfer_first: Point,
        transfer_second: Point,
        second_end: Point,
        transfer_walk_seconds: f64,
        identity_key: Vec<(String, Option<usize>, Option<usize>)>,
    },
}

pub(crate) struct RoutePlanner {
    map_width: u16,
    map_height: u16,
    services: Vec<TransitService>,
    shapes: Vec<RouteShape>,
    ride_seconds: Vec<Vec<f64>>,
    scored_flow_generation: Option<u64>,
    flow_refreshes: usize,
}
```

`RoutePlanner::new(state)` must call `active_services(state)` once, then enumerate:

- one `Direct` shape for every service ride edge;
- one `Transfer` shape for every ordered pair of different services and every ordered pair of their ride edges.

Precompute each shape's identity key once using the same line IDs / board/alight itinerary indexes as current `plan_identity_key`. Precompute transfer-to-transfer Manhattan walk once because it is OD-independent.

Do **not** add an exact `(origin,destination)` map.

- [ ] **Step 3: Refresh ride-edge durations only on batch-local flow generation change**

Implement:

```rust
fn refresh_ride_seconds(
    &mut self,
    flow: &RoadFlow,
    flow_generation: u64,
)
```

Rules:

- return immediately when `scored_flow_generation == Some(flow_generation)`;
- on first refresh, populate every service/edge duration through existing `ride_seconds`;
- on later refreshes, recompute Bus service edges against current `RoadFlow` and retain stable Metro values;
- set `scored_flow_generation` and increment `flow_refreshes` exactly once.

No persistent/global revision number is introduced.

- [ ] **Step 4: Score all shapes with scalar arithmetic and allocate one winner**

Implement a private winner selection that starts from walking-only:

```text
best_seconds = walk_seconds(origin, destination)
best_identity = empty identity key
best = Walk
```

For every `RouteShape`, calculate only:

- `walk_seconds(origin, board_at)`;
- cached ride duration(s);
- precomputed transfer walk for transfer shapes;
- `walk_seconds(alight_at, destination)`.

Compare with:

```text
estimated_seconds.total_cmp(best_seconds)
then precomputed identity_key lexicographic ordering
```

The empty walking identity key must preserve today's tie behavior.

After choosing the best scalar candidate, call one private `materialize_winner(...)` that creates exactly one `RoutePlan` using existing `walk_leg` / `transit_leg`. Candidate scoring must not clone a `RoutePlan` or allocate an identity key per shape.

- [ ] **Step 5: Keep the one-shot public API**

Keep:

```rust
pub fn find_route_plan(
    state: &GameSnapshot,
    flow: &RoadFlow,
    origin: &Point,
    destination: &Point,
) -> Option<RoutePlan> {
    let mut planner = RoutePlanner::new(state);
    planner.find_route_plan(flow, 0, *origin, *destination)
}
```

`router::plan_route` continues delegating to the public one-shot wrapper.

- [ ] **Step 6: Run router gates and commit**

```bash
cargo test -p caelum-core router:: --lib
cargo test -p caelum-core --test router_planning
cargo fmt --all -- --check
cargo clippy -p caelum-core --all-targets --locked -- -D warnings
```

Expected: PASS; no external integration test imports `RoutePlanner`.

Commit:

```bash
git add crates/caelum-core/src/router.rs
git commit -m "refactor: hoist transit route shapes"
```

---

### Task 2: Cache private-car access and Dijkstra at the road-access grain

**Files:**
- Modify: `crates/caelum-core/src/traffic.rs`

**Interfaces:**
- Consumes: `derive_stop_access_for_footprint`, `StopRoadAccess`, `RoadTopology::find_path_between_access_tiles`, current `PrivateCarCandidate` scoring.
- Produces: crate-private `PrivateCarPlanner`; public `private_car_candidate` signature unchanged.

- [ ] **Step 1: Add RED unit tests inside `traffic.rs`**

Build a fixture where two exact origin tiles are in one building and two destination tiles are in another. Require:

```text
- first exact OD prepares one road path;
- second exact OD sharing the same access pair keeps prepared_paths.len() == 1;
- exact-tile access distances can produce different estimated seconds even with the same path;
- repeated current-flow scoring raises ETA after car load without another Dijkstra;
- another access pair creates a second entry;
- an overlapping malformed fixture preserves current first-building-wins lookup semantics;
- no road access returns None.
```

Run RED:

```bash
cargo test -p caelum-core traffic:: --lib -- --nocapture
```

Expected: FAIL because `PrivateCarPlanner` does not exist.

- [ ] **Step 2: Add lookup-oriented access/path maps**

Use:

```rust
use std::collections::HashMap;

type CarPathKey = (
    Point,
    Option<Heading>,
    Point,
    Option<Heading>,
);

pub(crate) struct PrivateCarPlanner {
    access_by_tile: HashMap<Point, Option<StopRoadAccess>>,
    prepared_paths: HashMap<CarPathKey, Option<TransitPath>>,
}
```

`PrivateCarPlanner::new(state)` iterates `state.buildings` in current vector order. For each building:

```rust
let access = derive_stop_access_for_footprint(&state.map, &building.occupied_tiles);
for tile in &building.occupied_tiles {
    self.access_by_tile.entry(*tile).or_insert(access);
}
```

The `entry(...).or_insert(...)` is deliberate: current `buildings.iter().find(...)` chooses the first matching building, so a malformed overlapping fixture must not silently become last-writer-wins.

- [ ] **Step 3: Cache only the Dijkstra result**

For every `candidate(...)` call:

1. read exact origin/destination access from `access_by_tile`;
2. key `prepared_paths` by road points + preferred headings;
3. on miss, call `find_path_between_access_tiles` once and cache `Some(path)` / `None`;
4. reject empty road paths exactly as current `private_car_candidate` does;
5. on **every** call calculate:

```text
origin exact tile → origin access walk
+ CAR_ACCESS_SECONDS
+ current-flow road seconds with candidate +1 load
+ destination access → exact destination tile walk
```

6. return an owned `PrivateCarCandidate` with a clone of the cached path.

Do not cache congestion ETA or exact-tile access seconds.

- [ ] **Step 4: Keep the public one-shot wrapper and run gates**

Rewrite only the implementation of:

```rust
pub fn private_car_candidate(...)
```

so it constructs a `PrivateCarPlanner` and delegates once. Keep its signature and all constants unchanged.

Run:

```bash
cargo test -p caelum-core traffic:: --lib
cargo test -p caelum-core --test traffic
cargo test -p caelum-core --test router_planning
cargo fmt --all -- --check
cargo clippy -p caelum-core --all-targets --locked -- -D warnings
```

Expected: PASS.

Commit:

```bash
git add crates/caelum-core/src/traffic.rs
git commit -m "refactor: reuse private car access paths"
```

---

### Task 3: Add the batch coordinator and cut over the spawn loop in one green commit

**Files:**
- Create: `crates/caelum-core/src/route_choice.rs`
- Modify: `crates/caelum-core/src/lib.rs`
- Modify: `crates/caelum-core/src/trips.rs`
- Modify: `crates/caelum-core/tests/route_choice_batching.rs`
- Modify: `crates/caelum-core/tests/population_scale.rs`

**Interfaces:**
- Consumes: Task-1 `RoutePlanner`, Task-2 `PrivateCarPlanner`, current `spawn_pending_trip_demands`, current strict `<` helper semantics, shared test fixture.
- Produces: one `DemandBatchPlanner` per spawn batch; local flow generation; exact spawn reference equivalence; external composition smoke; coarse/split proof.

- [ ] **Step 1: Characterize current spawn behavior with a one-shot reference before changing production**

Inside `trips.rs`'s existing `#[cfg(test)]` module, create one deterministic road/Bus fixture based on the same natural direct Bus/car geometry already characterized by `router_planning`.

Create an ordered repeated-OD `Vec<population::TripDemand>`. Build a starting `RoadFlow` by trying a small deterministic range (`0..=64`) of identical pre-existing car-path loads and selecting the first level where production one-shot scoring yields:

```text
current demand: car wins
same OD after one add_car_path_to_flow: non-car wins
```

This search uses only current `router::find_route_plan` and `traffic::private_car_candidate`; never alter gameplay constants. It reuses already-characterized geometry rather than treating the switch as a new subsystem risk.

Define a test-only descriptor:

```rust
#[derive(Debug, PartialEq)]
enum ChoiceDescriptor {
    Car { path: TransitPath, arrival_time: f64 },
    NonCar(RoutePlan),
    Planless,
}
```

Write `reference_spawn_choices(...)` that runs today's exact sequence:

```text
find non-car against current flow
find car against current flow
strict < chooses car
if car: immediately add path to reference flow
else keep non-car only when plan.legs is non-empty
```

Run current `spawn_pending_trip_demands` from the same state/flow/demands and assert:

- canonical sim/trip order;
- descriptor equality for every row;
- identical final `RoadFlow`;
- at least one repeated OD is Car followed later by NonCar.

Run before implementation:

```bash
cargo test -p caelum-core trips::tests::same_time_batch_matches_sequential_one_shot_reference --lib -- --nocapture
```

Expected: PASS on current one-shot production behavior. This is a characterization oracle, not a RED test.

- [ ] **Step 2: Add RED coordinator tests, but do not commit an unused non-test module**

Create `route_choice.rs`, register `pub(crate) mod route_choice;` in `lib.rs`, and add tests requiring:

```text
- strict equal ETA remains non-car;
- choose() does not mutate RoadFlow;
- unchanged flow_generation reuses RoutePlanner ride durations;
- note_road_flow_changed() increments the local generation so the next choose refreshes Bus duration.
```

Run:

```bash
cargo test -p caelum-core route_choice:: --lib -- --nocapture
```

Expected: FAIL until coordinator implementation exists.

Do not commit at this RED/intermediate point; Task 3 finishes the production cutover before its commit so `clippy --all-targets -D warnings` never sees an otherwise-unused planner path.

- [ ] **Step 3: Implement the coordinator and move the strict decision helper once**

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
    flow_generation: u64,
}
```

Move `private_car_trip_if_faster` from `trips.rs` into `route_choice.rs` without changing its strict `<` comparison.

Implement `choose(...)` so it passes `self.flow_generation` to `RoutePlanner`, scores the car against the same `RoadFlow`, and returns an owned `RouteChoice`. It does not mutate flow.

Add:

```rust
pub(crate) fn note_road_flow_changed(&mut self) {
    self.flow_generation = self.flow_generation.saturating_add(1);
}
```

- [ ] **Step 4: Cut `spawn_pending_trip_demands` over to exactly one planner**

Construct one planner before the demand loop:

```rust
let mut planner = crate::route_choice::DemandBatchPlanner::new(state);
```

For each demand:

1. `choice = planner.choose(...)` against current flow;
2. create the base trip with current ID/deadline semantics;
3. apply choice:

Private car:

```rust
traffic::add_car_path_to_flow(road_flow, &car.path);
planner.note_road_flow_changed();
trip.status = TripStatus::Driving;
trip.private_car_trip = Some(car);
```

Non-car:

```rust
if !plan.legs.is_empty() {
    trip.status = status_after_leg(&plan, 0);
    trip.route_plan = Some(plan);
}
```

Unserved:

```text
leave the fresh trip Idle + planless; do not mark Unserved at spawn
```

Delete the old in-loop one-shot route/car calls and the old `trips.rs::private_car_trip_if_faster` helper.

- [ ] **Step 5: Re-run the exact spawn oracle after cutover**

```bash
cargo test -p caelum-core trips::tests::same_time_batch_matches_sequential_one_shot_reference --lib -- --nocapture
```

Expected: PASS with exact plan/path/arrival/order/final-flow equality. Forgetting `note_road_flow_changed` must make the car→non-car switch assertion fail.

- [ ] **Step 6: Strengthen the external engine smoke without exposing internals**

In `tests/route_choice_batching.rs`, store the expected sim order from `mixed_peak_snapshot(256, 1).sims`, then drain/spawn and compare the resulting `active_trips` sim order. Retain the car+transit assertions and the 8-service structural assertions.

Do not access crate-private `TripDemand` fields or planner types.

- [ ] **Step 7: Add coarse-vs-split mixed-wave release proof**

In `tests/population_scale.rs`, import `common::route_choice_fixture::mixed_peak_snapshot` and add:

```rust
#[test]
#[ignore]
fn mixed_route_choice_wave_is_coarse_split_deterministic() {
    let fixture = mixed_peak_snapshot(20_000, 1);
    let mut coarse = running_engine_from_fixture(fixture.clone());
    let mut split = running_engine_from_fixture(fixture);

    coarse.tick(900.0);
    for _ in 0..30 {
        split.tick(30.0);
    }

    assert_eq!(coarse.snapshot(), split.snapshot());
}
```

If 900 seconds does not cross enough real travel progression, increase the **same** total window for both engines; do not weaken exact durable-snapshot equality.

- [ ] **Step 8: Run task gates and commit**

```bash
cargo test -p caelum-core --lib
cargo test -p caelum-core --test route_choice_batching
cargo test -p caelum-core --test router_planning
cargo test -p caelum-core --test traffic
cargo test -p caelum-core --test trip_lifecycle
cargo test --release -p caelum-core --test population_scale mixed_route_choice_wave_is_coarse_split_deterministic -- --ignored --nocapture
cargo fmt --all -- --check
cargo clippy -p caelum-core --all-targets --locked -- -D warnings
```

Expected: all PASS.

Commit:

```bash
git add crates/caelum-core/src/route_choice.rs \
        crates/caelum-core/src/lib.rs \
        crates/caelum-core/src/trips.rs \
        crates/caelum-core/tests/route_choice_batching.rs \
        crates/caelum-core/tests/population_scale.rs
git commit -m "perf: batch route choice work"
```

---

### Task 4: Expose benchmark stats, record final evidence, and run the whole-product gate

**Files:**
- Modify: `crates/caelum-core/src/router.rs`
- Modify: `crates/caelum-core/src/traffic.rs`
- Modify: `crates/caelum-core/src/route_choice.rs`
- Modify: `crates/caelum-core/src/trips.rs`
- Modify: `crates/caelum-core/src/engine.rs`
- Modify: `crates/caelum-core/src/lib.rs`
- Modify: `crates/caelum-core/tests/route_choice_scale.rs`
- Modify: `docs/performance/hpa-348-route-choice-batching.md`

**Interfaces:**
- Consumes: completed batch planners and existing documentation-hidden `GameEngine` scale-harness spawn seam.
- Produces: one hidden stats snapshot, final base/stress measurements, explicit remaining-bottleneck statement, full green gate, review-ready PR #57.

- [ ] **Step 1: Add one stats shape; keep planner types private**

Inside `route_choice.rs` define:

```rust
#[doc(hidden)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RouteChoiceBatchStats {
    pub transit_service_count: usize,
    pub transit_shape_count: usize,
    pub transit_flow_refreshes: usize,
    pub car_prepared_access_paths: usize,
}
```

`DemandBatchPlanner::stats()` reads:

- service count / shape count / flow-refresh count from `RoutePlanner`;
- prepared access-path count from `PrivateCarPlanner`.

Keep `RoutePlanner`, `PrivateCarPlanner`, and `DemandBatchPlanner` `pub(crate)`.

If the public hidden engine method needs the type in its signature, re-export only this stats type from `lib.rs`:

```rust
#[doc(hidden)]
pub use route_choice::RouteChoiceBatchStats;
```

- [ ] **Step 2: Return stats only from the evidence seam**

Make `trips::spawn_pending_trip_demands` return its final internal stats (ordinary callers ignore the value).

Change:

```rust
pub fn GameEngine::spawn_drained_demands_for_scale_harness(...)
```

to return `RouteChoiceBatchStats`. Normal `tick`, snapshot, presentation, WASM/Tauri, and TypeScript contracts remain unchanged.

- [ ] **Step 3: Print final structural counts in the existing release benchmark rows**

Update `tests/route_choice_scale.rs` so final rows add:

```text
transit_service_count=N transit_shape_count=N transit_flow_refreshes=N car_prepared_access_paths=N
```

Keep baseline-compatible fields too:

```text
count services distinct_od route_spawn_us post_spawn_tick_us walk car bus metro planless
```

Assertions:

- base rows: `transit_service_count == 2`;
- stress row: `transit_service_count == 8`;
- `transit_shape_count > 0` and does not depend on demand count for the same service fixture;
- `car_prepared_access_paths <= distinct_od` and is strictly lower in at least one row using multiple tiles from shared buildings;
- no timing threshold assertion.

- [ ] **Step 4: Run final release evidence and update the performance document**

Run:

```bash
uname -a
rustc --version
cargo test --release -p caelum-core --test route_choice_scale -- --ignored --nocapture
cargo test --release -p caelum-core --test population_scale -- --ignored --nocapture
```

Append a final table:

```text
Row | Due | Services | Distinct OD | Route spawn µs | Post-spawn tick µs | Transit shapes | Flow refreshes | Car access paths | Walk | Car | Bus | Metro | Planless
```

Under the table state only conclusions supported by the numbers:

1. whether the 8-service row materially exposed transit enumeration/allocation cost and how it changed;
2. whether route-shape cardinality is batch-bound rather than citizen-bound;
3. whether car Dijkstra preparation follows access-pair cardinality;
4. whether route spawn or post-spawn trip progression is now larger;
5. the dominant remaining measured phase.

The post-spawn tick row is a measurement guard, not permission to widen scope automatically. If it dominates, state what the current data proves. Do not claim repeated routing is the cause unless a focused profile demonstrates it; normal planned Walking/Waiting trips reuse their stored plan and on-vehicle riders return early from boundary replanning.

- [ ] **Step 5: Run the complete product gate**

Rust:

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace
cargo build --workspace --locked
```

Frontend/browser:

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

Scale:

```bash
cargo test --release -p caelum-core --test route_choice_scale -- --ignored --nocapture
cargo test --release -p caelum-core --test population_scale -- --ignored --nocapture
```

Expected: all PASS.

- [ ] **Step 6: Perform final scope/duplicate-work scans**

```bash
git diff --stat origin/main...HEAD
git diff --name-only origin/main...HEAD
rg "private_car_trip_if_faster" crates/caelum-core/src
rg "PreparedCandidate|PreparedRide|prepared_od" crates/caelum-core/src
rg "network_revision|RouteCache|Lru|TTL" crates/caelum-core/src
rg "struct (RoutePlanner|PrivateCarPlanner|DemandBatchPlanner)" crates/caelum-core/src
```

Expected:

- exactly one strict car-choice helper, in `route_choice.rs`;
- no `PreparedCandidate` / exact-OD transit cache remains;
- one crate-private planner of each type;
- no persistent revision/cache framework;
- no TS/Svelte/WebGPU/persistence-store files changed.

- [ ] **Step 7: Commit evidence and update PR #57**

```bash
git add crates/caelum-core/src/router.rs \
        crates/caelum-core/src/traffic.rs \
        crates/caelum-core/src/route_choice.rs \
        crates/caelum-core/src/trips.rs \
        crates/caelum-core/src/engine.rs \
        crates/caelum-core/src/lib.rs \
        crates/caelum-core/tests/route_choice_scale.rs \
        docs/performance/hpa-348-route-choice-batching.md
git commit -m "docs: record HPA-348 route choice evidence"
```

Replace the planning-only PR summary with actual baseline/final base + 8-service stress rows, exact spawn-reference equality, congestion-switch result, coarse/split result, post-spawn tick result, full-gate result, and the measured remaining bottleneck. Keep PR #57 as the only delivery PR for HPA-348.