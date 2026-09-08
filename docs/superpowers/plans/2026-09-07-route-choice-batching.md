# HPA-348 Route Choice Batching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make large same-time commute/leisure demand waves reuse static transit and private-car route work while preserving Caelum's existing sequential congestion-sensitive mode choice.

**Architecture:** Create one batch-local `DemandBatchPlanner` for each `spawn_pending_trip_demands` call. It composes a reusable `router::RoutePlanner` and `traffic::PrivateCarPlanner`; exact-OD candidate/path preparation is cached only for the lifetime of that batch, while Bus/private-car ETA scoring still reads the mutable `RoadFlow` for every citizen in canonical demand order. No persistent cache/revision system, broad trip/vehicle ECS migration, frontend change, or compatibility layer is planned.

**Tech Stack:** Rust 1.95+, `caelum-core`, existing standalone `bevy_ecs` 0.19.1 population runtime, deterministic `RoadTopology`, existing Rust benchmark example; no new dependency.

**Spec:** `docs/superpowers/specs/2026-09-07-route-choice-batching-design.md`

## Global Constraints

- One Linear ticket = one GitHub PR; implementation stays on the HPA-348 PR branch.
- Preserve the existing canonical `TripDemand` order and mutate `RoadFlow` immediately after every chosen private car.
- Cache only static exact-OD work; never cache a congestion-sensitive Bus/private-car ETA or final mode choice across citizens.
- Cache lifetime is one `spawn_pending_trip_demands` call. Do not add network revisions, persistent caches, eviction, TTLs, zones, or departure bands.
- Keep current `ActiveTrip`/passenger/transit-vehicle lifecycle storage unless Task 0 demonstrates it is the dominant HPA-348 cost after route batching; do not migrate it speculatively.
- No per-car Bevy entity. Private-car congestion remains aggregate `RoadFlow`.
- No TypeScript/Svelte/WebGPU changes are expected.
- No schema compatibility code. A schema break is only justified if a measured implementation requirement appears and the spec is amended first.
- Preserve deterministic equal-time route tie-breaking and coarse-vs-split simulation equivalence.
- Wall-clock benchmark values are evidence, never CI thresholds.

---

### Task 0: Replace the walking-only wave measurement with a representative mixed-route baseline

**Files:**
- Modify: `crates/caelum-core/examples/presentation_scale.rs`
- Create: `docs/performance/hpa-348-route-choice-batching.md`

**Interfaces:**
- Consumes: existing `GameEngine::run_due_and_drain_for_scale_harness`, `GameEngine::spawn_drained_demands_for_scale_harness`, `SandboxCreationRequest`, Bus/Metro authoring intents, `population::TripDemand` output.
- Produces: deterministic 1k/5k/20k mixed peak fixtures and the pre-batching HPA-348 baseline that every later task measures against.

- [ ] **Step 1: Add a real mixed peak fixture without touching production routing code**

Keep the HPA-347 `wave_snapshot` rows for historical comparison. Add a separate `mixed_peak_snapshot(count)` fixture that uses actual placed residential/job destinations, connected roads, one useful Bus line, and one useful Metro line. Reuse the same authoring APIs exercised by `tests/router_planning.rs`; do not write route internals by hand when the engine can author them.

The fixture must create a bounded number of exact OD pairs and then repeat them so batching potential is visible. Use 16 origins × 4 destinations (at most 64 exact OD pairs) and choose canonical sim IDs that are not day-off on the fixture day. Every synthetic citizen's `home` and `workplace` must be a tile owned by a real building retained in `snapshot.buildings`.

Add a helper with this shape:

```rust
fn mixed_peak_snapshot(count: usize) -> GameSnapshot {
    let mut engine = scale_route_engine();
    let mut snapshot = engine.snapshot();
    snapshot.day = 0;
    snapshot.time = 0.0;
    snapshot.paused = true;
    snapshot.speed = 1;

    let origins = mixed_peak_home_tiles(&snapshot);
    let destinations = mixed_peak_job_tiles(&snapshot);
    assert!(!origins.is_empty());
    assert!(!destinations.is_empty());
    assert!(origins.len() * destinations.len() <= 64);

    snapshot.sims = repeated_worker_wave(count, &origins, &destinations, 300.0);
    snapshot
}
```

`scale_route_engine()` must author the road/track/service fixture through `GameIntent` and deploy at least one Bus and one Metro vehicle, following the proven fixture pattern in `tests/router_planning.rs` (`CreateRoute` + `AssignVehicle`). Keep the geometry compact; it only needs to make all four mode classes reachable somewhere in the matrix, not model a full city.

- [ ] **Step 2: Add mode-mix and OD-count reporting to the benchmark**

After `spawn_drained_demands_for_scale_harness`, inspect the engine snapshot and report the spawned wave's final mode classes using the existing trip state:

```rust
#[derive(Default)]
struct ModeCounts {
    walk: usize,
    car: usize,
    bus: usize,
    metro: usize,
    unserved: usize,
}
```

Classify a private-car trip by `private_car_trip.is_some()`, otherwise inspect `route_plan.legs` for Bus/Metro, otherwise walking; planless/terminal-unserved rows count as unserved. Also print `distinct_od` from the drained `TripDemand` vector before it is consumed.

Use row names:

```text
mixed-wave-1000
mixed-wave-5000
mixed-wave-20000
```

and print at least:

```text
count=<N> distinct_od=<N> route_spawn_us=<N> walk=<N> car=<N> bus=<N> metro=<N> unserved=<N>
```

- [ ] **Step 3: Run the release baseline and prove the fixture is actually mixed**

Run:

```bash
cargo run --release -p caelum-core --example presentation_scale
```

Expected:

- all three `mixed-wave-*` rows appear;
- `distinct_od < count` for every row;
- private-car candidates are reachable (`car > 0` in at least one row);
- an operational transit mode is selected (`bus > 0 || metro > 0`);
- no fixture home is rejected merely because it is not a building tile.

If the first authored geometry naturally makes one of Bus/Metro never win, adjust fixture geometry/costs only; do not change production scoring to force a desired benchmark mix.

- [ ] **Step 4: Record the baseline evidence**

Create `docs/performance/hpa-348-route-choice-batching.md` with:

```markdown
# HPA-348 Route Choice Batching — Baseline and Final Evidence

## Reference environment

Reuse the HPA-347 reference-machine description and record the current `rustc --version`/OS for this run.

## Task 0 mixed-wave baseline

| Row | Due demands | Distinct OD | Route spawn µs | Walk | Car | Bus | Metro | Unserved |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| mixed-wave-1000 | ... | ... | ... | ... | ... | ... | ... | ... |
| mixed-wave-5000 | ... | ... | ... | ... | ... | ... | ... | ... |
| mixed-wave-20000 | ... | ... | ... | ... | ... | ... | ... | ... |

Wall-clock measurements are reference evidence, not CI thresholds.
```

Do not invent values; paste the actual run.

- [ ] **Step 5: Verify the baseline-only change and commit**

Run:

```bash
cargo fmt --all -- --check
cargo test -p caelum-core --test router_planning
cargo run --release -p caelum-core --example presentation_scale
```

Expected: all pass and the new benchmark rows have repeated OD plus real car/transit outcomes.

Commit:

```bash
git add crates/caelum-core/examples/presentation_scale.rs docs/performance/hpa-348-route-choice-batching.md
git commit -m "perf: add mixed route-choice wave baseline"
```

---

### Task 1: Make transit candidate preparation reusable within one demand batch

**Files:**
- Modify: `crates/caelum-core/src/router.rs`
- Modify: `crates/caelum-core/tests/router_planning.rs`

**Interfaces:**
- Consumes: current `active_services`, `RideEdge`, `ride_seconds`, `best_candidate`, and deterministic `plan_identity_key` behavior.
- Produces: `router::RoutePlanner::new(&GameSnapshot)` and mutable `RoutePlanner::find_route_plan(&RoadFlow, Point, Point)` with exact-OD preparation reuse; existing public `router::find_route_plan` remains a one-shot wrapper.

- [ ] **Step 1: Write RED planner parity tests before refactoring**

In `tests/router_planning.rs`, extend the existing natural Bus/Metro fixtures with tests that describe the new reusable interface:

```rust
#[test]
fn reusable_route_planner_matches_one_shot_route_choice() {
    let (state, _, home, workplace) = bus_commute_fixture(false);
    let flow = RoadFlow::new();
    let expected = router::find_route_plan(&state, &flow, &home, &workplace);

    let mut planner = router::RoutePlanner::new(&state);
    let actual = planner.find_route_plan(&flow, home, workplace);

    assert_eq!(actual, expected);
}
```

Add a second regression using the existing congestion fixture pattern:

```rust
#[test]
fn reusable_route_planner_rescores_bus_eta_after_flow_changes() {
    let engine = bus_route_state();
    let state = engine.snapshot();
    let origin = Point::from((1, 4));
    let destination = Point::from((13, 4));
    let mut planner = router::RoutePlanner::new(&state);

    let free = planner.find_route_plan(&RoadFlow::new(), origin, destination).unwrap();
    let congested_flow = flow_over_service_path(&state, 6);
    let congested = planner.find_route_plan(&congested_flow, origin, destination).unwrap();

    assert!(congested.estimated_seconds > free.estimated_seconds);
    assert_eq!(planner.prepared_od_count_for_test(), 1);
}
```

The test-only count is structural proof that changing flow re-scores one prepared OD instead of preparing a second candidate set.

- [ ] **Step 2: Run the targeted tests and observe RED**

Run:

```bash
cargo test -p caelum-core --test router_planning reusable_route_planner -- --nocapture
```

Expected: FAIL because `router::RoutePlanner` does not exist.

- [ ] **Step 3: Extract owned active-service preparation from `find_route_plan`**

In `router.rs`, add:

```rust
use std::collections::{BTreeMap, HashMap};

type OdKey = (Point, Point);

pub struct RoutePlanner {
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

`static_seconds` contains only walking time; each `PreparedRide` is scored dynamically through the current service and `RoadFlow`. For walking-only candidates, `rides` is empty and `static_seconds` is the full walking estimate.

`RoutePlanner::new` must call the current `active_services(state)` exactly once and copy only the map bounds needed for out-of-bounds checks.

- [ ] **Step 4: Extract OD candidate enumeration without changing candidate semantics**

Move the current walking/one-service/two-service enumeration into a private method:

```rust
impl RoutePlanner {
    fn prepare(&self, origin: Point, destination: Point) -> Option<Vec<PreparedCandidate>>;

    fn score(&self, prepared: &[PreparedCandidate], flow: &RoadFlow) -> Option<RoutePlan>;
}
```

For each prepared transit candidate, keep the exact current `RouteLeg` values and remember the service index + `RideEdge` used to score each transit ride. `score` clones only the candidate's final `RoutePlan`, sets its current `estimated_seconds`, then applies the existing `best_candidate` ordering.

Do not cache `estimated_seconds` for Bus. Do not alter `boarding_seconds`, transfer enumeration, service-operational checks, or tie-breaking.

- [ ] **Step 5: Implement exact-OD caching and keep the one-shot API**

Add:

```rust
impl RoutePlanner {
    pub fn new(state: &GameSnapshot) -> Self { /* one active_services extraction */ }

    pub fn find_route_plan(
        &mut self,
        flow: &RoadFlow,
        origin: Point,
        destination: Point,
    ) -> Option<RoutePlan> {
        let key = (origin, destination);
        if !self.prepared.contains_key(&key) {
            let value = self.prepare(origin, destination);
            self.prepared.insert(key, value);
        }
        self.prepared
            .get(&key)
            .and_then(|prepared| prepared.as_deref())
            .and_then(|prepared| self.score(prepared, flow))
    }

    #[cfg(test)]
    pub(crate) fn prepared_od_count_for_test(&self) -> usize {
        self.prepared.len()
    }
}
```

Keep:

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

If the integration test cannot access a `pub(crate)` test method, put the cache-count assertion in a `#[cfg(test)]` unit test inside `router.rs` and keep the integration test on behavioral parity. Do not make a production/public metrics API solely for tests.

- [ ] **Step 6: Run router regressions**

Run:

```bash
cargo test -p caelum-core --test router_planning
cargo test -p caelum-core router:: --lib
```

Expected: PASS, including current walk/Bus/Metro/transfers/tie behavior and the new flow-rescore parity.

- [ ] **Step 7: Commit the transit-planner extraction**

```bash
git add crates/caelum-core/src/router.rs crates/caelum-core/tests/router_planning.rs
git commit -m "refactor: reuse transit route preparation"
```

---

### Task 2: Cache building access and private-car road paths without caching congestion ETA

**Files:**
- Modify: `crates/caelum-core/src/traffic.rs`
- Modify: `crates/caelum-core/tests/traffic.rs`

**Interfaces:**
- Consumes: `derive_stop_access_for_footprint`, `RoadTopology::find_path_between_access_tiles`, `congestion_multiplier`, `PrivateCarCandidate`.
- Produces: `traffic::PrivateCarPlanner::new(&GameSnapshot)` and mutable `candidate(&GameMap, &RoadTopology, &RoadFlow, Point, Point)`; existing public `private_car_candidate` remains a one-shot wrapper.

- [ ] **Step 1: Write RED tests for exact-OD path reuse with dynamic ETA**

In `tests/traffic.rs`, add a connected two-building fixture based on the existing private-car tests and assert behavioral parity:

```rust
#[test]
fn reusable_private_car_planner_reuses_path_but_rescores_flow() {
    let (state, topology, origin, destination) = connected_car_fixture();
    let mut planner = traffic::PrivateCarPlanner::new(&state);

    let free = planner
        .candidate(&state.map, &topology, &RoadFlow::new(), origin, destination)
        .unwrap();

    let mut flow = RoadFlow::new();
    traffic::add_car_path_to_flow(&mut flow, &free.path);
    traffic::add_car_path_to_flow(&mut flow, &free.path);
    traffic::add_car_path_to_flow(&mut flow, &free.path);
    traffic::add_car_path_to_flow(&mut flow, &free.path);

    let congested = planner
        .candidate(&state.map, &topology, &flow, origin, destination)
        .unwrap();

    assert_eq!(congested.path, free.path);
    assert!(congested.estimated_seconds > free.estimated_seconds);
}
```

Add an internal unit assertion (if needed for visibility) that repeated exact OD leaves `prepared.len() == 1`, while a second destination increments it to 2.

- [ ] **Step 2: Run the new targeted test and observe RED**

```bash
cargo test -p caelum-core --test traffic reusable_private_car_planner -- --nocapture
```

Expected: FAIL because `PrivateCarPlanner` does not exist.

- [ ] **Step 3: Extract the static private-car route representation**

In `traffic.rs`, add:

```rust
use crate::model::{GameMap, StopRoadAccess};

type OdKey = (Point, Point);

#[derive(Clone, Debug, PartialEq)]
struct PreparedPrivateCarRoute {
    path: TransitPath,
    access_seconds: f64,
}

pub struct PrivateCarPlanner {
    access_by_tile: BTreeMap<Point, Option<StopRoadAccess>>,
    prepared: BTreeMap<OdKey, Option<PreparedPrivateCarRoute>>,
}
```

`PrivateCarPlanner::new(state)` must walk `state.buildings` once. For each building, call `derive_stop_access_for_footprint(&state.map, &building.occupied_tiles)` once, then map every occupied building tile to that result. This replaces the current per-demand `state.buildings.iter().find(...)` scans and access derivation.

- [ ] **Step 4: Split path preparation from ETA scoring**

Add private helpers:

```rust
fn prepare_private_car_route(
    access_by_tile: &BTreeMap<Point, Option<StopRoadAccess>>,
    map: &GameMap,
    road_topology: &RoadTopology,
    origin: Point,
    destination: Point,
) -> Option<PreparedPrivateCarRoute>;

fn score_private_car_route(
    prepared: &PreparedPrivateCarRoute,
    flow: &RoadFlow,
) -> PrivateCarCandidate;
```

`prepare_private_car_route` performs the current access lookup + Dijkstra exactly once per OD and stores:

```text
access_seconds = origin building-to-road walk
               + CAR_ACCESS_SECONDS
               + destination road-to-building walk
```

`score_private_car_route` recomputes only the current-flow road step cost, including the existing candidate `+1` load on every step, then returns an owned `PrivateCarCandidate` with `path: prepared.path.clone()`.

- [ ] **Step 5: Implement the reusable planner and one-shot wrapper**

```rust
impl PrivateCarPlanner {
    pub fn new(state: &GameSnapshot) -> Self { /* one access-index build */ }

    pub fn candidate(
        &mut self,
        map: &GameMap,
        road_topology: &RoadTopology,
        flow: &RoadFlow,
        origin: Point,
        destination: Point,
    ) -> Option<PrivateCarCandidate> {
        let key = (origin, destination);
        if !self.prepared.contains_key(&key) {
            let value = prepare_private_car_route(
                &self.access_by_tile,
                map,
                road_topology,
                origin,
                destination,
            );
            self.prepared.insert(key, value);
        }
        self.prepared
            .get(&key)
            .and_then(|prepared| prepared.as_ref())
            .map(|prepared| score_private_car_route(prepared, flow))
    }
}
```

Rewrite the current public function as:

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

Do not change `RoadFlow`, `derive_road_flow`, congestion multipliers, pathfinding, or per-step candidate-load semantics.

- [ ] **Step 6: Run traffic and routing regressions**

```bash
cargo test -p caelum-core --test traffic
cargo test -p caelum-core --test router_planning
cargo test -p caelum-core traffic:: --lib
```

Expected: PASS.

- [ ] **Step 7: Commit the private-car planner extraction**

```bash
git add crates/caelum-core/src/traffic.rs crates/caelum-core/tests/traffic.rs
git commit -m "refactor: reuse private car route preparation"
```

---

### Task 3: Add one batch-local mode-choice coordinator with a congestion-switch lock

**Files:**
- Create: `crates/caelum-core/src/route_choice.rs`
- Modify: `crates/caelum-core/src/lib.rs`
- Modify: `crates/caelum-core/src/trips.rs`

**Interfaces:**
- Consumes: `router::RoutePlanner`, `traffic::PrivateCarPlanner`, current strict private-car comparison from `trips::private_car_trip_if_faster`.
- Produces: `route_choice::DemandBatchPlanner` and `RouteChoice`; no public/wire API.

- [ ] **Step 1: Write RED unit tests for the coordinator before wiring it into trips**

Create `route_choice.rs` with a `#[cfg(test)] mod tests` that builds the proven connected Bus/car fixture through `GameEngine`/`GameIntent` and describes two requirements:

1. one planner returns the same choice as the current one-shot comparison for free flow;
2. repeated identical OD is re-scored after `RoadFlow` changes.

The important test must search or construct a deterministic flow level at which mode choice flips, then prove it is not frozen:

```rust
#[test]
fn identical_od_is_rescored_after_prior_car_changes_flow() {
    let (state, topology, origin, destination) = congestion_switch_fixture();
    let mut planner = DemandBatchPlanner::new(&state);
    let mut flow = traffic::derive_road_flow(&state);

    let first = planner.choose(
        &state.map,
        &topology,
        &flow,
        origin,
        destination,
        state.time,
    );
    if let RouteChoice::PrivateCar(ref car) = first {
        traffic::add_car_path_to_flow(&mut flow, &car.path);
    }

    let second = planner.choose(
        &state.map,
        &topology,
        &flow,
        origin,
        destination,
        state.time,
    );

    assert_ne!(choice_mode(&first), choice_mode(&second));
}
```

Do not hard-code a fabricated ETA. Build the switch fixture from actual road step costs and existing Bus/walk costs, as current router tests do.

- [ ] **Step 2: Run the module test and observe RED**

```bash
cargo test -p caelum-core route_choice:: --lib -- --nocapture
```

Expected: FAIL because the coordinator types are not implemented.

- [ ] **Step 3: Move the strict mode-choice decision behind the new coordinator**

Add:

```rust
use crate::model::{GameMap, Point, PrivateCarTrip, RoutePlan};

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

`DemandBatchPlanner::new(state)` constructs each sub-planner once.

Move the current `private_car_trip_if_faster` comparison from `trips.rs` into a private helper here **without changing its strict comparison**. `choose` must:

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

and execute:

```text
non_car = RoutePlanner::find_route_plan(current flow)
car = PrivateCarPlanner::candidate(current flow)
if existing strict comparison picks car:
    return PrivateCar(PrivateCarTrip { path, arrival_time })
else if non_car exists:
    return NonCar(plan)
else:
    return Unserved
```

The coordinator does not mutate the flow.

- [ ] **Step 4: Register only a private module**

In `lib.rs` add:

```rust
pub(crate) mod route_choice;
```

Do not export `DemandBatchPlanner` from the crate root and do not add host/TS types.

- [ ] **Step 5: Run the coordinator and existing mode-choice tests**

```bash
cargo test -p caelum-core route_choice:: --lib
cargo test -p caelum-core --test router_planning
cargo test -p caelum-core --test trip_lifecycle
```

Expected: PASS. The congestion-switch test must demonstrate two identical OD calls can produce different choices after flow mutation.

- [ ] **Step 6: Commit the coordinator**

```bash
git add crates/caelum-core/src/route_choice.rs crates/caelum-core/src/lib.rs crates/caelum-core/src/trips.rs
git commit -m "feat: add batch route choice coordinator"
```

---

### Task 4: Wire one planner per pending-demand batch and prove sequential equivalence

**Files:**
- Modify: `crates/caelum-core/src/trips.rs`
- Create: `crates/caelum-core/tests/route_choice_batching.rs`
- Modify: `crates/caelum-core/tests/population_scale.rs`

**Interfaces:**
- Consumes: `DemandBatchPlanner::new`, `DemandBatchPlanner::choose`, existing `spawn_pending_trip_demands`, mutable `RoadFlow`, `population::TripDemand` canonical order.
- Produces: production route spawning that performs one batch setup and exact-OD cache reuse without changing `ActiveTrip` results.

- [ ] **Step 1: Add an end-to-end RED regression through the existing scale-harness seam**

In `tests/route_choice_batching.rs`, build a deterministic mixed wave with repeated exact OD demand and use the existing hidden scale-harness methods to drain and spawn it. Assert:

```rust
#[test]
fn same_time_repeated_od_wave_preserves_canonical_trip_order_and_mode_mix() {
    let mut engine = mixed_wave_engine(200);
    let demands = engine.run_due_and_drain_for_scale_harness(301.0);
    let expected_sim_order = demands
        .iter()
        .map(|demand| demand.citizen_id.clone())
        .collect::<Vec<_>>();

    engine.spawn_drained_demands_for_scale_harness(demands);
    let snapshot = engine.snapshot();
    let actual_sim_order = snapshot
        .active_trips
        .iter()
        .map(|trip| trip.sim_id.clone())
        .collect::<Vec<_>>();

    assert_eq!(actual_sim_order, expected_sim_order);
    assert!(snapshot.active_trips.iter().any(|trip| trip.private_car_trip.is_some()));
    assert!(snapshot.active_trips.iter().any(|trip| {
        trip.route_plan.as_ref().is_some_and(|plan| {
            plan.legs.iter().any(|leg| matches!(leg.mode, TransitMode::Bus | TransitMode::Metro))
        })
    }));
}
```

Before production wiring, add a test-only reference helper that reproduces the **current** per-demand one-shot algorithm and compare the final ordered trip modes + final road flow with the future batched algorithm. Keep this helper in the test file; do not keep a second production route-choice implementation.

- [ ] **Step 2: Run the new integration test against the current implementation**

Run:

```bash
cargo test -p caelum-core --test route_choice_batching -- --nocapture
```

Expected before wiring: behavioral assertions may already pass, but the structural batch-cache assertion added in Step 4 must remain RED until production uses one planner. This test is both a behavior oracle and the future optimization lock.

- [ ] **Step 3: Replace per-demand one-shot planning in `spawn_pending_trip_demands`**

Change the production loop to:

```rust
pub(crate) fn spawn_pending_trip_demands(
    state: &mut GameSnapshot,
    road_topology: &RoadTopology,
    road_flow: &mut traffic::RoadFlow,
    demands: Vec<population::TripDemand>,
) {
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
        let trip = build_commute_trip_from_choice(state, &demand, choice, road_flow);
        state.active_trips.push(trip);
    }
}
```

Replace `build_commute_trip` with a smaller `build_commute_trip_from_choice` that only creates the `ActiveTrip` and installs the already-chosen car/non-car state. The private-car branch must still call:

```rust
traffic::add_car_path_to_flow(road_flow, &car.path);
```

**before the next demand is scored**.

Delete the old per-demand calls to `router::find_route_plan` and `traffic::private_car_candidate` from production trip spawning. Keep those one-shot APIs for focused tests and non-batch callers.

- [ ] **Step 4: Add a test-only structural cache snapshot at the batch seam**

Do not add production telemetry. Under `#[cfg(test)]`, expose a small `DemandBatchPlannerStats` snapshot from the planner containing:

```rust
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct DemandBatchPlannerStats {
    pub(crate) transit_prepared_od: usize,
    pub(crate) car_prepared_od: usize,
}
```

Use it in a unit-level batch test to prove a 200-demand fixture with `K` exact OD pairs ends with both prepared-OD counts `<= K`, never 200. Do not assert timing in CI.

If integration visibility makes this awkward, keep the assertion inside `route_choice.rs` unit tests and let `route_choice_batching.rs` remain the public engine behavior proof.

- [ ] **Step 5: Run trip and routing regressions**

```bash
cargo test -p caelum-core --test route_choice_batching
cargo test -p caelum-core --test trip_lifecycle
cargo test -p caelum-core --test router_planning
cargo test -p caelum-core --test traffic
```

Expected: PASS and reference one-shot vs batch output equality.

- [ ] **Step 6: Add coarse-vs-split mixed-wave proof**

In `tests/population_scale.rs`, add an ignored release-scale test next to the HPA-347 granularity proof. Build two engines from the same mixed peak fixture; advance one in one coarse interval and the other through split intervals that cross the same demand wave and trip boundaries; compare durable snapshots:

```rust
#[test]
#[ignore = "release scale evidence"]
fn mixed_route_choice_wave_is_coarse_split_deterministic() {
    let fixture = mixed_scale_fixture(20_000);
    let mut coarse = GameEngine::from_snapshot(fixture.clone()).unwrap();
    let mut split = GameEngine::from_snapshot(fixture).unwrap();
    resume(&mut coarse);
    resume(&mut split);

    coarse.tick(PEAK_WINDOW_SECONDS);
    for _ in 0..SPLIT_STEPS {
        split.tick(PEAK_WINDOW_SECONDS / SPLIT_STEPS as f64);
    }

    assert_eq!(coarse.snapshot(), split.snapshot());
}
```

Use constants that cross the due wave and enough travel progression to exercise mode choice; do not use wall-clock thresholds in this assertion.

- [ ] **Step 7: Run the release granularity proof and commit**

```bash
cargo test --release -p caelum-core --test population_scale mixed_route_choice_wave_is_coarse_split_deterministic -- --ignored --nocapture
cargo test -p caelum-core --test route_choice_batching
```

Expected: PASS.

Commit:

```bash
git add crates/caelum-core/src/trips.rs crates/caelum-core/src/route_choice.rs crates/caelum-core/tests/route_choice_batching.rs crates/caelum-core/tests/population_scale.rs
git commit -m "perf: batch repeated route choice work"
```

---

### Task 5: Record final 1k/5k/20k route-choice evidence and lock the remaining bottleneck

**Files:**
- Modify: `crates/caelum-core/examples/presentation_scale.rs`
- Modify: `docs/performance/hpa-348-route-choice-batching.md`

**Interfaces:**
- Consumes: Task 0 benchmark fixture and Task 4 production batch planner.
- Produces: final evidence rows with static-cache reuse counts and a clear next-bottleneck statement; no new optimization subsystem.

- [ ] **Step 1: Expose benchmark-only cache counts without adding production telemetry**

If the production `spawn_drained_demands_for_scale_harness` currently discards planner stats, add a `#[doc(hidden)]` scale-harness-only result type in `engine.rs`/`trips.rs` only if needed by the example. Prefer returning stats from an existing hidden harness method rather than changing normal `tick`/presentation contracts.

The benchmark needs:

```rust
pub struct RouteChoiceBatchStats {
    pub transit_prepared_od: usize,
    pub car_prepared_od: usize,
}
```

No host serialization, no snapshot field, no UI field.

- [ ] **Step 2: Extend the mixed-wave output with cache reuse counts**

Print:

```text
mixed-wave-20000 count=20000 distinct_od=64 route_spawn_us=... transit_prepared_od=64 car_prepared_od=64 ...
```

The exact counts may be lower than `distinct_od` when an OD is out of map/access, but must never exceed the number of distinct exact OD pairs processed by the batch.

- [ ] **Step 3: Run final release evidence on the same reference machine**

Run:

```bash
uname -a
rustc --version
cargo run --release -p caelum-core --example presentation_scale
cargo test --release -p caelum-core --test population_scale -- --ignored --nocapture
```

Record actual output. Do not smooth, extrapolate, or convert wall-clock values into CI gates.

- [ ] **Step 4: Complete the performance document**

Append:

```markdown
## Final batched route-choice evidence

| Row | Due demands | Distinct OD | Route spawn µs | Transit prepared OD | Car prepared OD | Walk | Car | Bus | Metro | Unserved |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| mixed-wave-1000 | ... |
| mixed-wave-5000 | ... |
| mixed-wave-20000 | ... |

### Result

- Repeated static route work is bounded by exact OD cardinality, not citizen count.
- Congestion-sensitive scoring remains per demand and sequential.
- <name the measured dominant remaining cost from the final run>.
```

Replace the final sentence with the measured result. If scheduler emission remains larger, say so and stop. If active-trip progression is now larger, record that as follow-up evidence; do not add a second subsystem to this PR without first revising the design.

- [ ] **Step 5: Commit evidence**

```bash
git add crates/caelum-core/examples/presentation_scale.rs docs/performance/hpa-348-route-choice-batching.md
git commit -m "docs: record HPA-348 scale evidence"
```

---

### Task 6: Run the whole-product gate and close the scope cleanly

**Files:**
- Modify only if verification finds a task-scoped defect in files already owned by this plan.
- Verify: all files changed by HPA-348.

**Interfaces:**
- Consumes: completed HPA-348 branch.
- Produces: review-ready single PR with no frontend/wire/schema drift and no leftover duplicate route-choice path in production.

- [ ] **Step 1: Run Rust formatting, lint, workspace tests, and build**

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace
cargo build --workspace --locked
```

Expected: PASS.

- [ ] **Step 2: Run the normal frontend/browser gates even though no frontend behavior changes**

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

Expected: PASS. Do not add a new Playwright scenario solely for a Rust-internal optimization unless a real browser behavior changed.

- [ ] **Step 3: Run the scale gates one final time**

```bash
cargo run --release -p caelum-core --example presentation_scale
cargo test --release -p caelum-core --test population_scale -- --ignored --nocapture
```

Expected: PASS and final evidence matches the committed document.

- [ ] **Step 4: Perform scope and duplicate-work scans**

Run:

```bash
git diff --stat origin/main...HEAD
git diff --name-only origin/main...HEAD
rg "find_route_plan\(state, road_flow|private_car_candidate\(state, road_topology, road_flow" crates/caelum-core/src/trips.rs
rg "RoutePlanner|PrivateCarPlanner|DemandBatchPlanner" crates/caelum-core/src
```

Expected:

- no old one-shot per-demand route calls remain in `trips.rs`;
- no TS/Svelte/WebGPU/persistence files changed;
- no second cache framework/network revision type exists;
- one batch planner composes the two focused planners.

- [ ] **Step 5: Update the PR summary with final evidence**

Add the actual 1k/5k/20k before/after rows, structural cache counts, granularity result, full-gate result, and measured remaining bottleneck to the existing HPA-348 PR body. Keep the PR as the single delivery artifact for the ticket.

No extra implementation PR is created for verification or evidence.