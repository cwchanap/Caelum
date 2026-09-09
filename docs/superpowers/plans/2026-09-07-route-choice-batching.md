# HPA-348 Route Choice Batching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make large same-time commute/leisure waves reuse static transit and private-car route work while preserving Caelum's sequential congestion-sensitive mode choice exactly.

**Architecture:** Build one crate-private `DemandBatchPlanner` per `spawn_pending_trip_demands` call. Transit candidate shapes are cached by exact tile OD; private-car road paths are cached by resolved building road-access pair while exact-tile access walk and all flow-sensitive ETA are re-scored per citizen. One shared mixed-peak fixture feeds the benchmark, integration smoke, and coarse/split scale proof.

**Tech Stack:** Rust 1.95+, `caelum-core`, existing `bevy_ecs` 0.19.1 population runtime, `RoadTopology`, existing Rust release benchmark; no new dependency.

**Spec:** `docs/superpowers/specs/2026-09-07-route-choice-batching-design.md`

## Global Constraints

- One Linear ticket = one GitHub PR; all implementation and evidence stay on PR #57.
- Preserve canonical `TripDemand` order.
- Preserve strict car choice: car wins only when `car.estimated_seconds < non_car.estimated_seconds`; ties remain non-car.
- Mutate `RoadFlow` only after a private-car win and before scoring the next demand.
- Never cache Bus/private-car congestion ETA or final mode choice across citizens.
- Transit preparation cache key is exact `(origin, destination)` tile OD.
- Private-car Dijkstra cache key is resolved origin/destination road access point + preferred heading, not exact citizen tile OD.
- Cache lifetime is one `spawn_pending_trip_demands` call. No revision counter, persistent cache, eviction, TTL, zones, or time bands.
- `RoutePlanner`, `PrivateCarPlanner`, `DemandBatchPlanner`, and their internal cache counters stay `pub(crate)`.
- External integration tests continue through one-shot public routing APIs or the existing `GameEngine` scale-harness seam.
- Keep `ActiveTrip`, passenger, and transit-vehicle lifecycle ownership unchanged unless measured evidence requires a separately reviewed design revision.
- No per-car Bevy entity; congestion remains aggregate `RoadFlow`.
- No TypeScript/Svelte/WebGPU/persistence-store changes.
- No compatibility layer for development saves.
- Wall-clock numbers are evidence, not CI thresholds.

## Main Risk

The correctness regression needs a real point where admitting one car flips a later identical OD from car to non-car. Existing access/boarding penalties may make the gap too wide in the first geometry.

Use actual production scoring to search a deterministic initial `RoadFlow` level where this one-car switch exists. If the mixed benchmark geometry cannot provide a clean switch, create a smaller dedicated Rust test fixture. Change fixture geometry only; do not alter gameplay costs to force the test.

---

### Task 0: Create one shared mixed-peak fixture and record the pre-batching baseline

**Files:**
- Create: `crates/caelum-core/src/scale_fixture.rs`
- Modify: `crates/caelum-core/src/lib.rs`
- Modify: `crates/caelum-core/examples/presentation_scale.rs`
- Create: `crates/caelum-core/tests/route_choice_batching.rs`
- Create: `docs/performance/hpa-348-route-choice-batching.md`

**Interfaces:**
- Consumes: `GameEngine`, `GameIntent`, sandbox creation, building catalog, existing Bus/Metro authoring paths, `run_due_and_drain_for_scale_harness`, `spawn_drained_demands_for_scale_harness`.
- Produces: one documentation-hidden `mixed_peak_snapshot(count)` constructor used by every HPA-348 scale/composition test, plus measured 1k/5k/20k pre-batching rows.

- [ ] **Step 1: Add the shared evidence fixture**

Create `crates/caelum-core/src/scale_fixture.rs` with one external-test/example-visible helper:

```rust
use crate::model::{CitizenRoutine, GameSnapshot, Point, ScheduledActivity, ScheduledActivityKind, Sim, TransitMode};
use crate::{GameEngine, GameIntent, SandboxCreationRequest};

#[doc(hidden)]
pub fn mixed_peak_snapshot(count: usize) -> GameSnapshot {
    assert!(count > 0);

    let mut engine = GameEngine::from_sandbox_request(SandboxCreationRequest {
        template_id: "blankGrid".to_string(),
        economy_preset: "creative".to_string(),
        starting_capital: Some(crate::DEFAULT_STARTING_CAPITAL.into()),
        demand_multiplier: Some(1.0),
    })
    .expect("mixed peak sandbox must construct");

    author_mixed_network(&mut engine);
    let mut snapshot = engine.snapshot();
    snapshot.day = 0;
    snapshot.time = 0.0;
    snapshot.paused = true;
    snapshot.speed = 1;
    snapshot.active_trips.clear();

    let origins = residential_tiles(&snapshot);
    let destinations = job_tiles(&snapshot);
    assert!(origins.len() >= 4);
    assert!(destinations.len() >= 4);
    assert!(origins.len() * destinations.len() <= 64);

    snapshot.sims = repeated_due_workers(count, &origins, &destinations);
    snapshot
}
```

Keep the helper's subordinate functions private to `scale_fixture.rs`.

`author_mixed_network` must author through `GameIntent`, not by mutating route internals:

- four `smallHouse` buildings on retained tiles adjacent to a connected road corridor;
- two job buildings (`supermarket` and `factory`) with multiple occupied destination tiles;
- one connected road corridor serving every residential/job building;
- one Bus route with two present stops and one assigned Bus;
- one Metro line with two present stations and one assigned train;
- enough spatial separation that walk/car/transit can compete naturally.

Use the same production authoring operations already exercised by `tests/router_planning.rs`: `LayRoad`, `LayTrack`, `PlaceBuilding`, `AddBusStop`, `AddMetroStation`, `CreateRoute`, `AssignVehicle`.

`repeated_due_workers` must generate only canonical Worker IDs that are not day-0 days off and are not canonical Student ordinals. Every row has:

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

Cycle through the bounded exact-tile OD matrix. Deliberately include multiple occupied tiles from the same residential/job building so exact tile OD cardinality is larger than private-car road-access-pair cardinality.

In `lib.rs` register only the evidence module as documentation-hidden:

```rust
#[doc(hidden)]
pub mod scale_fixture;
```

Do not export planner/cache types.

- [ ] **Step 2: Add a fast non-ignored mixed-fixture smoke test**

Create `tests/route_choice_batching.rs` with a composition smoke that uses only public/hidden harness APIs:

```rust
use caelum_core::model::TransitMode;
use caelum_core::scale_fixture::mixed_peak_snapshot;
use caelum_core::{GameEngine, GameIntent};

#[test]
fn mixed_peak_fixture_produces_real_car_and_transit_choices() {
    let mut engine = GameEngine::from_snapshot(mixed_peak_snapshot(64)).unwrap();
    assert!(engine.dispatch(GameIntent::SetPaused { paused: false }).applied);

    let demands = engine.run_due_and_drain_for_scale_harness(301.0);
    assert_eq!(demands.len(), 64);
    engine.spawn_drained_demands_for_scale_harness(demands);

    let snapshot = engine.snapshot();
    assert!(snapshot.active_trips.iter().any(|trip| trip.private_car_trip.is_some()));
    assert!(snapshot.active_trips.iter().any(|trip| {
        trip.route_plan.as_ref().is_some_and(|plan| {
            plan.legs.iter().any(|leg| matches!(leg.mode, TransitMode::Bus | TransitMode::Metro))
        })
    }));
}
```

Both Bus and Metro services must be operational/reachable in the fixture. The smoke requires at least one transit winner rather than making CI depend on both modes winning a narrow cost race.

- [ ] **Step 3: Observe fixture RED/GREEN before routing abstraction**

Run:

```bash
cargo test -p caelum-core --test route_choice_batching mixed_peak_fixture_produces_real_car_and_transit_choices -- --nocapture
```

Expected: first RED while the shared fixture is absent or walking-only; after fixture geometry is corrected, PASS with both a car trip and a Bus/Metro route-plan trip.

Do not modify production route scoring to make this pass.

- [ ] **Step 4: Extend the release example with mixed rows**

In `examples/presentation_scale.rs`, keep HPA-347 rows unchanged and add:

```rust
fn measure_mixed_wave(label: &str, count: usize) {
    let mut engine = GameEngine::from_snapshot(
        caelum_core::scale_fixture::mixed_peak_snapshot(count),
    )
    .expect("mixed peak fixture loads");
    assert!(engine.dispatch(caelum_core::GameIntent::SetPaused { paused: false }).applied);

    let demands = engine.run_due_and_drain_for_scale_harness(301.0);
    assert_eq!(demands.len(), count);

    let started = std::time::Instant::now();
    engine.spawn_drained_demands_for_scale_harness(demands);
    let route_spawn_us = started.elapsed().as_micros();

    let snapshot = engine.snapshot();
    let distinct_od = snapshot
        .active_trips
        .iter()
        .map(|trip| (trip.origin, trip.destination))
        .collect::<std::collections::BTreeSet<_>>()
        .len();
    let modes = mode_counts(&snapshot.active_trips);

    println!(
        "{label}\tcount={count}\tdistinct_od={distinct_od}\troute_spawn_us={route_spawn_us}\twalk={}\tcar={}\tbus={}\tmetro={}\tunserved={}",
        modes.walk, modes.car, modes.bus, modes.metro, modes.unserved
    );
}
```

`mode_counts` classifies `private_car_trip` first; otherwise Bus/Metro from route-plan legs; walking-only from a non-empty walk route; planless/unserved rows as unserved.

Run 1k/5k/20k:

```rust
for count in [1_000, 5_000, 20_000] {
    measure_mixed_wave(&format!("mixed-wave-{count}"), count);
}
```

- [ ] **Step 5: Record actual baseline evidence**

Run:

```bash
uname -a
rustc --version
cargo run --release -p caelum-core --example presentation_scale
```

Create `docs/performance/hpa-348-route-choice-batching.md` with the actual environment and rows:

```markdown
# HPA-348 Route Choice Batching — Baseline and Final Evidence

## Task 0 mixed-wave baseline

| Row | Due demands | Distinct tile OD | Route spawn µs | Walk | Car | Bus | Metro | Unserved |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| mixed-wave-1000 | <actual> |
| mixed-wave-5000 | <actual> |
| mixed-wave-20000 | <actual> |

Wall-clock values are reference evidence, not CI thresholds.
```

Replace `<actual>` with copied command output before committing; do not estimate values.

- [ ] **Step 6: Verify and commit Task 0**

Run:

```bash
cargo fmt --all -- --check
cargo test -p caelum-core --test route_choice_batching
cargo test -p caelum-core --test router_planning
cargo run --release -p caelum-core --example presentation_scale
```

Expected: PASS; `distinct_od < count`; car count > 0; Bus+Metro count > 0.

Commit:

```bash
git add crates/caelum-core/src/scale_fixture.rs crates/caelum-core/src/lib.rs crates/caelum-core/examples/presentation_scale.rs crates/caelum-core/tests/route_choice_batching.rs docs/performance/hpa-348-route-choice-batching.md
git commit -m "perf: add shared mixed route-choice baseline"
```

---

### Task 1: Reuse transit candidate preparation without exposing a planner API

**Files:**
- Modify: `crates/caelum-core/src/router.rs`

**Interfaces:**
- Consumes: current `find_route_plan`, `active_services`, `RideEdge`, `best_candidate`, `plan_identity_key`.
- Produces: crate-private `RoutePlanner::new(&GameSnapshot)` + `find_route_plan(&RoadFlow, Point, Point)`; existing public one-shot `router::find_route_plan` remains unchanged in signature.

- [ ] **Step 1: Add RED unit tests inside `router.rs`**

Under the existing `#[cfg(test)]` module add:

```rust
#[test]
fn route_planner_reuses_exact_od_and_rescores_bus_flow() {
    let state = reusable_bus_fixture();
    let origin = Point::from((1, 4));
    let destination = Point::from((13, 4));
    let mut planner = RoutePlanner::new(&state);

    let free = planner.find_route_plan(&RoadFlow::new(), origin, destination).unwrap();
    let congested_flow = flow_over_first_bus_path(&state, 6);
    let congested = planner.find_route_plan(&congested_flow, origin, destination).unwrap();

    assert!(congested.estimated_seconds > free.estimated_seconds);
    assert_eq!(planner.prepared.len(), 1);
}
```

Add a second unit test that compares `RoutePlanner` output with the public one-shot wrapper for Bus, Metro, and equal-time tie ordering.

- [ ] **Step 2: Run RED**

```bash
cargo test -p caelum-core router:: --lib -- --nocapture
```

Expected: FAIL because `RoutePlanner` does not exist.

- [ ] **Step 3: Add crate-private prepared types**

In `router.rs` change the collection import to include `BTreeMap` and add:

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

`static_seconds` contains all walking + fixed boarding time for that candidate. Each `PreparedRide` records the exact service/edge whose ride time must be scored. Metro scoring may remain fixed through its path duration; Bus scoring reads current `RoadFlow`.

- [ ] **Step 4: Extract preparation and scoring**

Add private methods:

```rust
impl RoutePlanner {
    fn prepare(&self, origin: Point, destination: Point) -> Option<Vec<PreparedCandidate>>;
    fn score(&self, prepared: &[PreparedCandidate], flow: &RoadFlow) -> Option<RoutePlan>;
}
```

`prepare` performs the current walking, one-service, and two-service enumeration exactly once per exact tile OD. Preserve route legs, line IDs, service direction, board/alight indexes, transfer walking, boarding constants, and candidate ordering.

`score` clones each prepared `RoutePlan`, recomputes the current `estimated_seconds`, then uses existing `best_candidate`. Never store a flow-sensitive Bus ETA in the cache.

- [ ] **Step 5: Add exact-OD lookup and keep one-shot wrapper**

Implement:

```rust
impl RoutePlanner {
    pub(crate) fn new(state: &GameSnapshot) -> Self {
        Self {
            map_width: state.map.width,
            map_height: state.map.height,
            services: active_services(state),
            prepared: BTreeMap::new(),
        }
    }

    pub(crate) fn find_route_plan(
        &mut self,
        flow: &RoadFlow,
        origin: Point,
        destination: Point,
    ) -> Option<RoutePlan> {
        let key = (origin, destination);
        if !self.prepared.contains_key(&key) {
            let prepared = self.prepare(origin, destination);
            self.prepared.insert(key, prepared);
        }
        self.prepared
            .get(&key)
            .and_then(|value| value.as_deref())
            .and_then(|value| self.score(value, flow))
    }
}
```

Keep the public one-shot signature:

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

- [ ] **Step 6: Run router gates and commit**

```bash
cargo test -p caelum-core router:: --lib
cargo test -p caelum-core --test router_planning
cargo fmt --all -- --check
```

Expected: PASS; external router tests still compile without seeing `RoutePlanner`.

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
- Consumes: `derive_stop_access_for_footprint`, `StopRoadAccess`, `RoadTopology::find_path_between_access_tiles`, `congestion_multiplier`, `PrivateCarCandidate`.
- Produces: crate-private `PrivateCarPlanner`; public `private_car_candidate` signature remains unchanged.

- [ ] **Step 1: Add RED unit tests inside `traffic.rs`**

Add a fixture with two exact origin tiles belonging to the same building and two exact destination tiles belonging to the same destination building. Both tiles in each building resolve to the same `StopRoadAccess`.

Add:

```rust
#[test]
fn private_car_planner_keys_dijkstra_by_access_pair_not_exact_tile_od() {
    let (state, topology, origin_a, origin_b, destination_a, destination_b) = shared_access_fixture();
    let mut planner = PrivateCarPlanner::new(&state);

    let first = planner.candidate(
        &state.map,
        &topology,
        &RoadFlow::new(),
        origin_a,
        destination_a,
    ).unwrap();
    let second = planner.candidate(
        &state.map,
        &topology,
        &RoadFlow::new(),
        origin_b,
        destination_b,
    ).unwrap();

    assert_eq!(first.path, second.path);
    assert_eq!(planner.prepared_paths.len(), 1);
    assert_ne!(first.estimated_seconds, second.estimated_seconds);
}
```

Choose tile coordinates with different Manhattan distance to the shared road access so the final assertion proves access walk remains exact-tile specific.

Add a flow-rescore test: add the first path to `RoadFlow` four times, call `candidate` again, assert same path, higher ETA, and still one prepared path.

- [ ] **Step 2: Run RED**

```bash
cargo test -p caelum-core traffic:: --lib -- --nocapture
```

Expected: FAIL because `PrivateCarPlanner` does not exist.

- [ ] **Step 3: Build one access index**

In `traffic.rs` add:

```rust
use crate::model::{GameMap, Heading, StopRoadAccess};

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

`PrivateCarPlanner::new(state)` iterates buildings once. For each building:

```rust
let access = derive_stop_access_for_footprint(&state.map, &building.occupied_tiles);
for tile in &building.occupied_tiles {
    access_by_tile.insert(*tile, access);
}
```

This removes the current per-demand `buildings.iter().find` scans and repeated access derivation.

- [ ] **Step 4: Split access-pair path lookup from exact-tile/current-flow scoring**

Add:

```rust
fn path_key(origin: StopRoadAccess, destination: StopRoadAccess) -> CarPathKey {
    (
        origin.road_point,
        origin.preferred_heading,
        destination.road_point,
        destination.preferred_heading,
    )
}
```

On a cache miss, call:

```rust
road_topology.find_path_between_access_tiles(
    map,
    origin_access.road_point,
    destination_access.road_point,
    origin_access.preferred_heading,
    destination_access.preferred_heading,
)
```

and store only the resulting static `TransitPath` (or `None`) by `CarPathKey`.

On every `candidate` call compute:

```text
access_seconds = manhattan(origin, origin_access.road_point) * WALK_SECONDS_PER_TILE
               + CAR_ACCESS_SECONDS
               + manhattan(destination_access.road_point, destination) * WALK_SECONDS_PER_TILE
```

Then compute current road seconds exactly as today, including `flow + 1` on every step, and return an owned `PrivateCarCandidate` with a cloned path.

- [ ] **Step 5: Keep the one-shot wrapper**

Implement:

```rust
pub(crate) fn candidate(
    &mut self,
    map: &GameMap,
    road_topology: &RoadTopology,
    flow: &RoadFlow,
    origin: Point,
    destination: Point,
) -> Option<PrivateCarCandidate>
```

and keep:

```rust
pub fn private_car_candidate(
    state: &GameSnapshot,
    road_topology: &RoadTopology,
    flow: &RoadFlow,
    origin: Point,
    destination: Point,
) -> Option<PrivateCarCandidate> {
    PrivateCarPlanner::new(state).candidate(
        &state.map,
        road_topology,
        flow,
        origin,
        destination,
    )
}
```

Do not change `RoadFlow`, congestion constants, Dijkstra, or `+1` candidate load.

- [ ] **Step 6: Run traffic/routing gates and commit**

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

### Task 3: Add the crate-private mode-choice coordinator without touching `trips.rs`

**Files:**
- Create: `crates/caelum-core/src/route_choice.rs`
- Modify: `crates/caelum-core/src/lib.rs`

**Interfaces:**
- Consumes: `RoutePlanner`, `PrivateCarPlanner`, current strict `<` car selection.
- Produces: crate-private `DemandBatchPlanner::choose` returning owned `PrivateCarTrip`/`RoutePlan`; does not mutate `RoadFlow`.

- [ ] **Step 1: Add RED coordinator unit tests**

In `route_choice.rs` add tests for:

- free-flow choice equals a reference one-shot calculation;
- equal ETA does not choose car;
- repeated identical OD is re-scored after the test mutates flow;
- `choose` itself leaves the supplied `RoadFlow` unchanged.

The switch test must use actual scoring. Find a deterministic starting flow:

```rust
fn flow_before_one_car_switch(
    state: &GameSnapshot,
    topology: &RoadTopology,
    origin: Point,
    destination: Point,
) -> RoadFlow {
    let mut flow = RoadFlow::new();
    for _ in 0..64 {
        let non_car = crate::router::find_route_plan(state, &flow, &origin, &destination);
        let car = crate::traffic::private_car_candidate(
            state,
            topology,
            &flow,
            origin,
            destination,
        );
        let car_wins_now = car.as_ref().is_some_and(|candidate| {
            non_car.as_ref().is_none_or(|plan| candidate.estimated_seconds < plan.estimated_seconds)
        });
        if !car_wins_now {
            break;
        }
        let candidate = car.expect("winning car candidate exists");
        let mut after = flow.clone();
        crate::traffic::add_car_path_to_flow(&mut after, &candidate.path);
        let next_non_car = crate::router::find_route_plan(state, &after, &origin, &destination);
        let next_car = crate::traffic::private_car_candidate(
            state,
            topology,
            &after,
            origin,
            destination,
        );
        let car_wins_after = next_car.as_ref().is_some_and(|next| {
            next_non_car.as_ref().is_none_or(|plan| next.estimated_seconds < plan.estimated_seconds)
        });
        if !car_wins_after {
            return flow;
        }
        flow = after;
    }
    panic!("fixture must provide a one-car congestion switch");
}
```

If this fails for the mixed fixture, use a smaller dedicated road/Bus fixture; do not modify gameplay constants.

- [ ] **Step 2: Run RED**

```bash
cargo test -p caelum-core route_choice:: --lib -- --nocapture
```

Expected: FAIL because the module/types do not exist.

- [ ] **Step 3: Add the coordinator and single strict comparison helper**

Create:

```rust
use crate::model::{GameMap, Point, PrivateCarTrip, RoutePlan};
use crate::road_topology::RoadTopology;
use crate::traffic::RoadFlow;

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

Add one private helper with today's strict behavior:

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

`choose` calls both planners against the supplied current flow, returns `PrivateCar` if the helper wins, otherwise `NonCar` when a route exists, otherwise `Unserved`. It does not modify `road_flow`.

- [ ] **Step 4: Register only a private production module**

In `lib.rs` add:

```rust
pub(crate) mod route_choice;
```

Do not re-export coordinator/planner types.

- [ ] **Step 5: Run coordinator + existing mode-choice gates and commit**

```bash
cargo test -p caelum-core route_choice:: --lib
cargo test -p caelum-core --test router_planning
cargo test -p caelum-core --test traffic
cargo test -p caelum-core --test trip_lifecycle
cargo fmt --all -- --check
```

Expected: PASS. `trips.rs` is unchanged in this task.

Commit:

```bash
git add crates/caelum-core/src/route_choice.rs crates/caelum-core/src/lib.rs
git commit -m "feat: add batch route choice coordinator"
```

---

### Task 4: Cut over the spawn loop once and lock sequential equivalence at the real seam

**Files:**
- Modify: `crates/caelum-core/src/trips.rs`
- Modify: `crates/caelum-core/tests/route_choice_batching.rs`
- Modify: `crates/caelum-core/tests/population_scale.rs`

**Interfaces:**
- Consumes: `DemandBatchPlanner`, shared `mixed_peak_snapshot`, existing `spawn_pending_trip_demands`, mutable `RoadFlow`.
- Produces: one planner per batch; ordered car admission; crate-private reference-vs-batched spawn regression; external engine-harness smoke; coarse/split mixed proof.

- [ ] **Step 1: Add the crate-private RED spawn-seam reference test before production cutover**

Inside `trips.rs`'s `#[cfg(test)]` module, construct a repeated identical-OD `Vec<population::TripDemand>` and a starting flow returned by the Task-3 congestion-switch fixture helper pattern.

Add a test-only descriptor:

```rust
#[derive(Debug, PartialEq)]
enum ChoiceDescriptor {
    Car { path: crate::model::TransitPath, arrival_time: f64 },
    NonCar(crate::model::RoutePlan),
    Planless,
}
```

Add a test-only reference helper that loops the demand vector in order and uses **only the current one-shot APIs**:

```text
non_car = router::find_route_plan(current flow)
car = traffic::private_car_candidate(current flow)
car wins only on strict <
if car wins: record car descriptor and add its path to reference flow
else if non-car exists and has non-empty legs: record route descriptor
else: record Planless
```

Run the existing production `spawn_pending_trip_demands` on cloned state/flow/demands and derive actual descriptors from appended `ActiveTrip` rows.

The final assertions must compare:

```rust
assert_eq!(actual_sim_order, expected_sim_order);
assert_eq!(actual_descriptors, expected_descriptors);
assert_eq!(actual_flow, expected_flow);
```

The chosen starting flow must make the descriptor sequence include at least one `Car` followed later by `NonCar` for the same exact OD. This is the load-bearing anti-freeze regression.

- [ ] **Step 2: Run the spawn test on the current one-shot implementation**

```bash
cargo test -p caelum-core trips::tests::same_time_batch_matches_sequential_one_shot_reference --lib -- --nocapture
```

Expected: PASS on current behavior. This records the reference before replacing the production loop.

- [ ] **Step 3: Replace per-demand route calls with one batch planner**

In `spawn_pending_trip_demands` construct one planner before the loop:

```rust
pub(crate) fn spawn_pending_trip_demands(
    state: &mut GameSnapshot,
    road_topology: &RoadTopology,
    road_flow: &mut traffic::RoadFlow,
    demands: Vec<population::TripDemand>,
) -> crate::route_choice::RouteChoiceBatchStats {
    let mut planner = crate::route_choice::DemandBatchPlanner::new(state);

    for demand in demands {
        let choice = planner.choose(
            &state.map,
            road_topology,
            road_flow,
            demand.origin,
            demand.destination,
            state.time,
        );
        let trip = build_commute_trip_from_choice(state, road_flow, &demand, choice);
        state.active_trips.push(trip);
    }

    planner.stats()
}
```

Add `RouteChoiceBatchStats` as a crate-private struct in `route_choice.rs` for now:

```rust
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct RouteChoiceBatchStats {
    pub(crate) transit_prepared_od: usize,
    pub(crate) car_prepared_access_paths: usize,
}
```

`DemandBatchPlanner::stats` reads the two internal cache lengths. Do not add separate transit/car stats types.

- [ ] **Step 4: Preserve the current ActiveTrip state transitions exactly**

Replace the old `build_commute_trip` with `build_commute_trip_from_choice`.

For `RouteChoice::PrivateCar(car)`:

```rust
traffic::add_car_path_to_flow(road_flow, &car.path);
trip.status = TripStatus::Driving;
trip.private_car_trip = Some(car);
```

This flow mutation happens inside the current loop before the next `choose` call.

For `RouteChoice::NonCar(plan)`:

```rust
if !plan.legs.is_empty() {
    trip.status = status_after_leg(&plan, 0);
    trip.route_plan = Some(plan);
}
```

For `RouteChoice::Unserved`, leave the freshly built trip `Idle`/planless. Do not mark it `Unserved` at spawn time.

Delete the old in-loop `router::find_route_plan`, `traffic::private_car_candidate`, and old `trips.rs::private_car_trip_if_faster`. Tick-time replans elsewhere in `trips.rs` remain one-shot.

- [ ] **Step 5: Re-run the spawn-seam equality test after cutover**

```bash
cargo test -p caelum-core trips::tests::same_time_batch_matches_sequential_one_shot_reference --lib -- --nocapture
```

Expected: PASS with exactly the same descriptors and final `RoadFlow` as Step 2.

- [ ] **Step 6: Strengthen the external engine integration smoke without exposing internals**

Extend `tests/route_choice_batching.rs` to build `mixed_peak_snapshot(200)`, drain/spawn through `GameEngine`, and assert:

- exactly 200 trips were spawned/resolved from the drained wave at the spawn seam;
- active-trip order follows the shared fixture's canonical sim ordering as observed in the resulting snapshot;
- at least one private-car trip exists;
- at least one Bus/Metro route-plan trip exists.

Do not instantiate `RoutePlanner`, `PrivateCarPlanner`, `DemandBatchPlanner`, or inspect private `TripDemand` fields from this integration test.

- [ ] **Step 7: Add coarse-vs-split mixed-wave proof using the same shared fixture**

In `tests/population_scale.rs` add:

```rust
#[test]
#[ignore = "release scale evidence"]
fn mixed_route_choice_wave_is_coarse_split_deterministic() {
    let fixture = caelum_core::scale_fixture::mixed_peak_snapshot(20_000);
    let mut coarse = GameEngine::from_snapshot(fixture.clone()).unwrap();
    let mut split = GameEngine::from_snapshot(fixture).unwrap();
    assert!(coarse.dispatch(GameIntent::SetPaused { paused: false }).applied);
    assert!(split.dispatch(GameIntent::SetPaused { paused: false }).applied);

    let window = 900.0;
    coarse.tick(window);
    for _ in 0..30 {
        split.tick(window / 30.0);
    }

    assert_eq!(coarse.snapshot(), split.snapshot());
}
```

The 900-second window crosses the 300-second demand wave and subsequent trip progression. If fixture travel boundaries extend beyond it, increase this fixture-local window in both branches; do not weaken equality.

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

### Task 5: Expose one hidden stats snapshot and record final scale evidence

**Files:**
- Modify: `crates/caelum-core/src/route_choice.rs`
- Modify: `crates/caelum-core/src/engine.rs`
- Modify: `crates/caelum-core/src/lib.rs`
- Modify: `crates/caelum-core/examples/presentation_scale.rs`
- Modify: `docs/performance/hpa-348-route-choice-batching.md`

**Interfaces:**
- Consumes: Task-4 internal `RouteChoiceBatchStats`, existing scale-harness spawn method, shared mixed fixture.
- Produces: one documentation-hidden stats value for the example and final 1k/5k/20k evidence; no host/wire telemetry.

- [ ] **Step 1: Make only the stats snapshot documentation-hidden public**

Change the Task-4 internal stats type to:

```rust
#[doc(hidden)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RouteChoiceBatchStats {
    pub transit_prepared_od: usize,
    pub car_prepared_access_paths: usize,
}
```

Keep `DemandBatchPlanner` and both sub-planners crate-private.

Re-export only this evidence type if needed by the public `GameEngine` harness method:

```rust
#[doc(hidden)]
pub use route_choice::RouteChoiceBatchStats;
```

- [ ] **Step 2: Return stats from the existing hidden scale-harness spawn seam**

Change:

```rust
pub fn spawn_drained_demands_for_scale_harness(
    &mut self,
    demands: Vec<TripDemand>,
) -> RouteChoiceBatchStats {
    let mut road_flow = traffic::derive_road_flow(&self.snapshot);
    trips::spawn_pending_trip_demands(
        &mut self.snapshot,
        &self.road_topology,
        &mut road_flow,
        demands,
    )
}
```

Normal callers may ignore the returned value. Do not change `tick`, `presentation`, snapshot schema, WASM/Tauri commands, or TypeScript.

- [ ] **Step 3: Add cache-grain output to mixed rows**

In `measure_mixed_wave`, store the returned stats and print:

```text
transit_prepared_od=<N>
car_prepared_access_paths=<N>
```

Also derive `distinct_od` from post-spawn `(trip.origin, trip.destination)` rows.

The shared fixture uses multiple exact tiles from the same buildings, so final evidence must show:

```text
car_prepared_access_paths < distinct_od
```

for at least one mixed row. It must never exceed the number of distinct resolved road-access pairs used by the fixture.

- [ ] **Step 4: Run final release evidence**

Run on the same reference machine:

```bash
uname -a
rustc --version
cargo run --release -p caelum-core --example presentation_scale
cargo test --release -p caelum-core --test population_scale -- --ignored --nocapture
```

Record exact output.

- [ ] **Step 5: Complete the evidence document**

Append actual final rows:

```markdown
## Final batched route-choice evidence

| Row | Due | Distinct tile OD | Route spawn µs | Transit prepared OD | Car prepared access paths | Walk | Car | Bus | Metro | Unserved |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| mixed-wave-1000 | <actual> |
| mixed-wave-5000 | <actual> |
| mixed-wave-20000 | <actual> |

### Result

- Transit static work is bounded by exact tile OD cardinality.
- Private-car Dijkstra work is bounded by road-access-pair cardinality, not citizen tile OD cardinality.
- Flow-sensitive scoring still runs once per demand in canonical order.
- <measured dominant remaining cost>.
```

Replace all bracketed values with actual output. If scheduler emission remains largest, say so and stop. If another subsystem becomes dominant, record it as follow-up evidence; do not widen this PR without revising the design first.

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
- Produces: one review-ready PR with no public planner API, no duplicate production mode-choice path, and final evidence in the PR body.

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

Expected: PASS. No new Playwright test is added solely for a Rust-internal performance refactor.

- [ ] **Step 3: Re-run scale gates**

```bash
cargo run --release -p caelum-core --example presentation_scale
cargo test --release -p caelum-core --test population_scale -- --ignored --nocapture
```

Expected: PASS and command output matches the committed performance document.

- [ ] **Step 4: Scan scope and duplicate decision paths**

Run:

```bash
git diff --stat origin/main...HEAD
git diff --name-only origin/main...HEAD
rg "private_car_trip_if_faster" crates/caelum-core/src
rg "find_route_plan\(state, road_flow|private_car_candidate\(state, road_topology, road_flow" crates/caelum-core/src/trips.rs
rg "struct (RoutePlanner|PrivateCarPlanner|DemandBatchPlanner)" crates/caelum-core/src
rg "network_revision|RouteCache|Lru|TTL" crates/caelum-core/src
```

Expected:

- exactly one `private_car_trip_if_faster`, inside `route_choice.rs`;
- no one-shot router/car calls remain in the demand-spawn loop; tick-time replans may still call `find_route_plan`;
- all three planner structs are crate-private;
- no revision/cache framework exists;
- no TS/Svelte/WebGPU/persistence-store files changed.

- [ ] **Step 5: Update PR #57 summary**

Replace the planning-only body with actual:

- Task-0 baseline 1k/5k/20k rows;
- final 1k/5k/20k rows;
- transit exact-OD and car access-pair structural counts;
- spawn-seam sequential reference equality/congestion-switch result;
- coarse/split result;
- full gate result;
- measured remaining bottleneck.

Keep PR #57 as the only delivery PR for HPA-348.
