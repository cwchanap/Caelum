# HPA-348 Route Choice Batching and Traffic-Demand Design

**Linear:** HPA-348 — [Scale] Batch route choice and traffic-demand processing for large commute waves

**Status:** Proposed implementation design, revised after second performance/reuse review

## Context

HPA-347 is merged. Caelum's latent population is ECS-owned and wakes through an exact-time scheduler instead of scanning all citizens every tick. Its final release evidence measured:

| Due demand wave | Scheduler emission | Route spawning |
| ---: | ---: | ---: |
| 1,000 | 370 µs | 243 µs |
| 5,000 | 1,626 µs | 1,272 µs |
| 20,000 | 6,175 µs | 4,784 µs |

HPA-348 owns the route-choice / traffic-demand term. The current spawn path is intentionally sequential:

```text
Vec<TripDemand> in canonical order
  -> derive one mutable RoadFlow
  -> for each demand
       find walk/transit plan
       find private-car candidate
       choose car only when car ETA < non-car ETA
       if car wins, add its road path to RoadFlow immediately
       create ActiveTrip
```

That mutable-flow ordering is gameplay behavior. A chosen car may make the next citizen's car or Bus ETA slower and may change that citizen's mode. HPA-348 must remove repeated **static** network work without freezing a final answer for a cohort.

The first HPA-348 design correctly found the private-car cache grain, but its transit exact-OD cache was too narrow. In `router.rs`, the expensive transit structure is mostly OD-independent:

- `active_services` clones the active service data and enumerates ride edges;
- direct and transfer ride-edge combinations are independent of a citizen's origin/destination;
- Bus ride duration depends on current `RoadFlow`, not exact citizen OD;
- exact OD only contributes Manhattan walk-to-board / walk-from-alight terms.

Caching complete candidate plans by exact OD therefore preserves too much per-citizen allocation and makes benchmark wins depend on repeated ODs. The revised transit design hoists service/ride-shape work for the whole batch and performs allocation-free scalar scoring per citizen, materializing only the winning `RoutePlan`.

The HPA-347 wave evidence also needs a better workload: its synthetic homes are not building-owned tiles and it has no Bus/Metro service, so private-car access cannot resolve and the row is walking-heavy. HPA-348 establishes a real mixed benchmark plus a multi-service transit-stress benchmark before changing routing code.

## Goals

- Establish one reusable integration-test fixture for mixed road/Bus/Metro demand.
- Re-baseline 1k/5k/20k route spawning before abstraction.
- Add a stress row with **8 active services** and **at least 4 waypoints per service** so the existing `O(S² × E1 × E2)` transfer-enumeration term is actually exercised.
- Build active Bus/Metro service data and route-shape enumeration once per demand batch.
- Score transit candidates per citizen using scalar arithmetic with no candidate-plan allocation; materialize exactly one winning `RoutePlan`.
- Recompute Bus ride durations only after aggregate `RoadFlow` changes; Metro ride durations remain stable for the batch.
- Resolve building road access once per building and reuse private-car Dijkstra by **road-access pair**, not citizen tile pair.
- Recompute exact-tile car access walk and congestion-sensitive private-car ETA for every demand.
- Preserve strict private-car comparison (`car < non-car`; ties stay non-car), canonical demand order, and immediate `RoadFlow` mutation after every car win.
- Keep private-car traffic mesoscopic through aggregate `RoadFlow`; do not create ECS car entities.
- Measure one representative post-spawn tick so the evidence cannot claim the whole active-trip pipeline is cheap from spawn timing alone.
- Record the measured remaining bottleneck without widening into unrelated ECS/rendering work.
- Deliver everything in PR #57.

## Non-goals

- No WebGPU, viewport/LOD, presentation cadence, or interpolation; HPA-640 owns those.
- No scheduler redesign.
- No broad `ActiveTrip`, passenger, or transit-vehicle ECS migration.
- No persistent route cache, network revision counter, eviction policy, TTL, zones, or departure bands.
- No frozen cohort mode choice.
- No microscopic traffic or per-car ECS entity.
- No TypeScript/Svelte/host contract change.
- No save compatibility layer.
- No speculative tick-time replan cache solely because route planning appears in `next_boundary_after` / `tick_trip`; measure that path first.

## Reuse decisions

HPA-348 extends existing authorities rather than replacing them:

- `router::find_route_plan` remains the public one-shot transit-routing API.
- `router::active_services` remains the source of active Bus/Metro service data.
- `traffic::private_car_candidate` remains the public one-shot car-routing API.
- `trips::spawn_pending_trip_demands` remains the production same-time admission loop and owner of ordered `RoadFlow` mutation.
- `traffic::add_car_path_to_flow` and the existing strict `<` comparison remain the semantics to preserve.
- `tests/router_planning.rs` already locks Bus ETA sensitivity to current road flow and provides natural Bus-vs-car geometry; reuse those semantics rather than inventing alternate scoring.
- `tests/common/mod.rs` is already the shared integration-fixture home; HPA-348 extends it instead of creating a new production `scale_fixture` module.

New implementation concepts are justified only where the tree has no reusable equivalent: one batch-lived transit planner, one private-car access/path planner, one batch mode-choice coordinator, and one hidden benchmark stats result.

## Chosen architecture

```text
TripDemand sequence
       |
       v
route_choice::DemandBatchPlanner   (pub(crate))
   /                         \
  v                           v
router::RoutePlanner        traffic::PrivateCarPlanner
(pub(crate))                (pub(crate))
service catalog             building-access index
+ route shapes              + access-pair path cache
+ ride-duration cache
   \                           /
    +------ current RoadFlow -+
                |
         per-demand scoring
                |
   PrivateCar | NonCar | Unserved
                |
       existing ActiveTrip builder
```

All planners are crate-private. Public one-shot wrapper signatures stay unchanged.

## Transit planner: batch-wide route shapes, not exact-OD plans

### What is batch-stable

`RoutePlanner::new(&GameSnapshot)` performs the expensive structure work once:

1. call `active_services(state)` once;
2. retain the owned service data for the synchronous batch;
3. enumerate every direct and two-service ride combination once;
4. precompute the deterministic identity key for each shape once;
5. retain scalar board/alight/transfer points and service/edge indexes;
6. allocate the ride-duration table once.

Conceptually:

```rust
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

`RouteShape` is not a prepared `RoutePlan`. It is a compact description of one possible direct or transfer service journey. It contains only data needed to score and later materialize that journey, for example service/edge indexes, board/alight points, precomputed transfer-walk seconds, and one precomputed identity key.

There is **no** `BTreeMap<(Point, Point), PreparedCandidate>` and no exact-OD transit cache.

### Per-citizen scoring

For one citizen:

1. reject out-of-bounds endpoints exactly as today;
2. seed the best score with walking-only `walk_seconds(origin, destination)` and the same empty identity key semantics;
3. iterate the pre-enumerated route shapes;
4. compute only the origin→board and alight→destination Manhattan terms plus cached ride durations and precomputed transfer walk;
5. compare by `estimated_seconds.total_cmp` and the same lexicographic route identity semantics as today's `plan_identity_key`;
6. materialize **one** `RoutePlan` for the winning shape.

The scoring loop allocates no `RoutePlan`, `Vec<RouteLeg>`, or identity-key vector per candidate. The final winner materialization uses the existing `walk_leg` / `transit_leg` rules and therefore preserves the current wire/domain result.

### Road-flow refresh

Bus ride duration is flow-sensitive; Metro duration is not. The batch coordinator owns a local `flow_generation` beginning at zero.

- The first transit score refreshes the ride-duration table.
- After `spawn_pending_trip_demands` admits a car and mutates `RoadFlow`, it calls `planner.note_road_flow_changed()`.
- The next `choose` sees a new generation and recomputes Bus ride-edge durations once for that new flow.
- If several consecutive citizens choose non-car, their transit scoring reuses the same ride-duration table.
- Metro ride durations are computed once for the planner lifetime.

This is a **batch-local generation**, not a map/network revision system. It exists only to avoid rescanning Bus paths when `RoadFlow` did not change between two consecutive demands.

`router::find_route_plan(...)` remains a one-shot wrapper that creates one planner and scores once at flow generation zero.

## Private-car planner: access index + access-pair Dijkstra cache

Private-car work has three grains:

1. **building access lookup** — stable for the batch and shared by every occupied tile in the same building;
2. **road path** — determined by resolved road-access points/headings;
3. **access walk + road ETA** — exact citizen tiles and current flow matter per demand.

Use lookup-oriented `HashMap`s because cache iteration is never gameplay input and `Point`/`Heading` are hashable:

```rust
type CarPathKey = (
    Point, Option<Heading>,
    Point, Option<Heading>,
);

pub(crate) struct PrivateCarPlanner {
    access_by_tile: HashMap<Point, Option<StopRoadAccess>>,
    prepared_paths: HashMap<CarPathKey, Option<TransitPath>>,
}
```

Construction iterates `state.buildings` once. For each building:

- derive one `StopRoadAccess` from its footprint;
- map each occupied tile to that access;
- use `entry(tile).or_insert(access)` so a malformed overlapping fixture preserves the current `buildings.iter().find(...)` **first building wins** behavior rather than silently changing it to last-writer-wins.

For each demand:

1. resolve origin/destination access from `access_by_tile`;
2. cache Dijkstra by resolved road points + preferred headings;
3. compute exact-tile access walk every call;
4. score the cached road path against current `RoadFlow`, including the existing candidate `+1` load per road step;
5. return an owned `PrivateCarCandidate`.

`traffic::private_car_candidate(...)` remains a one-shot wrapper.

## Batch mode-choice coordinator

`route_choice::DemandBatchPlanner` composes the two planners and owns only mode-choice coordination:

```rust
pub(crate) enum RouteChoice {
    PrivateCar(PrivateCarTrip),
    NonCar(RoutePlan),
    Unserved,
}

pub(crate) struct DemandBatchPlanner {
    non_car: router::RoutePlanner,
    private_car: traffic::PrivateCarPlanner,
    flow_generation: u64,
}
```

Its `choose(...)` reads current `RoadFlow` and preserves the existing strict decision:

```text
car wins only when car.estimated_seconds < non_car.estimated_seconds
```

It does not mutate `RoadFlow`.

After the spawn loop applies a winning car path, it calls:

```rust
planner.note_road_flow_changed();
```

before scoring the next demand. The spawn-seam reference regression makes forgetting this notification a correctness failure.

For result construction:

- `PrivateCar` installs `Driving` + the owned `PrivateCarTrip`;
- `NonCar` installs the plan only when `plan.legs` is non-empty, preserving today's empty-leg filter;
- `Unserved` leaves the fresh spawn `Idle` and planless; normal trip progression owns the later unserved transition.

The coordinator and production spawn cutover land in the same implementation task so no non-test library commit contains an otherwise-unused `pub(crate)` planner path.

## Cache lifetime and invalidation

All route-choice planner state lives for one synchronous `spawn_pending_trip_demands` invocation and is dropped afterward.

That lifetime is the invalidation policy:

- no player edit can interleave inside one spawn loop;
- the next batch rebuilds service/access/path data from the next snapshot;
- no persistent revision counter or invalidation framework is required.

## Shared mixed/stress fixture

Do **not** add a production `scale_fixture` module. Integration tests already share helpers through `crates/caelum-core/tests/common`.

Add `tests/common/route_choice_fixture.rs` and export it from `tests/common/mod.rs`.

The constructor is test-only:

```rust
pub fn mixed_peak_snapshot(count: usize, bus_route_count: usize) -> GameSnapshot
```

It uses a Standard `blankGrid` city with a deliberately ample fixed starting capital (`1_000_000`) so the stress fixture does not fail for affordability.

Author through public `GameIntent`s and assert `applied` for every mutation. Required ordering:

1. roads/tracks;
2. `PaintAreaRectangle` for residential/commercial/industrial footprints;
3. buildings;
4. Bus/Metro nodes;
5. routes;
6. vehicles.

A representative compact layout uses:

- road corridor `y=5`, `x=1..26`;
- four Small Houses immediately south of the road;
- one Supermarket and one Factory on valid painted areas adjacent to road access;
- four Bus stops on the north side of the road;
- one Metro track corridor with four stations;
- `bus_route_count` operational Bus routes over the four Bus stops;
- one operational Metro route over the four stations.

The base mixed rows use `bus_route_count = 1` (two total services including Metro). The transit-stress row uses `bus_route_count = 7` (eight total active services including Metro), with every service carrying at least four waypoints. Reusing the same stop corridor across several Bus routes is acceptable: the stress row is intentionally testing route-choice service/ride-edge cardinality, not route-layout variety.

Worker generation reuses the existing canonical rules from `population_scale`: increasing canonical IDs, excluding Students and day-0 days off, exact same-time wake at `t=300`, and real building-owned home/workplace tiles.

The implementation is free to use multiple occupied tiles from each building, but route-choice performance must no longer depend on a hard 64-OD cap. Distinct tile OD remains an evidence column only.

## Benchmark and evidence

Add an ignored release integration benchmark `tests/route_choice_scale.rs` instead of extending the broad `presentation_scale` example. This keeps the shared fixture entirely under `tests/common` and avoids new public fixture API.

Task 0 records **before** production abstraction:

### Base mixed rows

- `mixed-wave-1000`
- `mixed-wave-5000`
- `mixed-wave-20000`

with one Bus + one Metro service.

### Transit stress row

- `transit-stress-20000`

with eight total active services and at least four waypoints each.

For every row record:

- due/spawned demand count;
- active service count;
- distinct exact tile OD count (context only);
- route-spawn wall time;
- mode counts;
- one representative post-spawn `engine.tick(...)` wall time (`post_spawn_tick_us`) to expose active-trip/boundary cost outside the spawn seam.

After implementation also record one hidden `RouteChoiceBatchStats`:

```rust
#[doc(hidden)]
pub struct RouteChoiceBatchStats {
    pub transit_service_count: usize,
    pub transit_shape_count: usize,
    pub transit_flow_refreshes: usize,
    pub car_prepared_access_paths: usize,
}
```

The hidden scale-harness spawn method may return this stats value. No normal tick, snapshot, host, or presentation contract exposes it.

Structural interpretation:

- `transit_service_count` is batch setup cardinality, not demand cardinality;
- `transit_shape_count` is enumerated once per planner, not once per citizen;
- `transit_flow_refreshes` changes only when the first score occurs or admitted cars make `RoadFlow` stale;
- `car_prepared_access_paths` follows access-pair cardinality, not exact tile OD cardinality.

Wall-clock values remain reference evidence, never CI thresholds.

## Tick-time replan measurement boundary

The review correctly identified a measurement blind spot: spawn-only timing cannot prove the subsequent active-trip pipeline is cheap. Task 0 therefore records `post_spawn_tick_us`.

The stronger claim that every transit rider performs a full replan every substep is not the current code path:

- `track_active_trip_boundary` returns immediately for a `Riding` trip that is still on a vehicle;
- normal planned Walking/Waiting trips reuse their stored `route_plan`;
- `tick_trip` replans only when the route plan is absent or a `Riding` trip is no longer vehicle-owned.

Therefore HPA-348 does **not** preemptively add a second tick-time planner cache. If `post_spawn_tick_us` becomes the dominant measured phase, record it. Only if a focused profile then points specifically to repeated `find_route_plan` calls should the same PR be revised to reuse `RoutePlanner` within the immutable-flow trip loop. A dominant active-trip clone/vehicle/metrics cost is evidence for a later focused slice, not justification to widen this routing change into an `ActiveTrip` ECS migration.

## Sequential-congestion correctness lock

The load-bearing correctness regression remains at `spawn_pending_trip_demands`, where flow actually mutates.

Inside `trips.rs` unit tests:

1. create an ordered repeated-OD `Vec<TripDemand>`;
2. run a test-only one-shot reference sequence using current public `find_route_plan` + `private_car_candidate` + strict `<` + immediate `add_car_path_to_flow`;
3. run production batching from the same starting state/flow/demands;
4. compare exact ordered citizen/trip mode, `RoutePlan`, car path/arrival time, and final `RoadFlow`.

Reuse the natural direct/detour Bus-vs-car geometry already characterized in `router_planning` as the starting point. If one admitted car does not cross the exact switch boundary, search a small deterministic starting flow range using **production scoring**. This is a test construction detail, not a project risk or reason to change gameplay constants.

## Testing strategy

### Router unit tests

Inside `router.rs`:

- one planner matches the public one-shot result for existing Bus/Metro fixtures;
- active services and route shapes are built once;
- per-citizen scoring allocates/materializes only the winner (lock structurally via shape/materialization counters or direct helper tests, not wall-clock assertions);
- changing the local flow generation refreshes Bus ride durations while unchanged generation does not;
- equal-time deterministic identity ordering remains identical.

Existing `router_planning.rs::bus_route_plan_eta_reflects_current_car_flow_without_rebuilding_path` remains the public flow-sensitivity lock; do not duplicate that behavior merely for planner visibility.

### Traffic unit tests

Inside `traffic.rs`:

- several exact tile ODs sharing one building access pair run one Dijkstra preparation;
- exact-tile access seconds still differ where Manhattan access differs;
- current flow re-scores ETA on the cached road path;
- another access pair creates a second path;
- first-building-wins index behavior is explicit;
- missing access stays `None`.

### Spawn-seam unit test

`trips.rs` owns one-shot-reference vs batched equality, including the same-time congestion switch and final flow equality.

### Integration tests

`tests/route_choice_batching.rs` uses `tests/common/route_choice_fixture` and public `GameEngine` harness methods only. It proves:

- every fixture authoring intent applied;
- base fixture produces real car + transit choices;
- the 8-service fixture actually has eight active services with at least four waypoints each;
- canonical spawned trip ordering is preserved.

### Granularity

`tests/population_scale.rs` reuses the test-common mixed fixture and compares coarse vs split advancement across the same wave/travel window.

## Risks and controls

### 1. Fixture authoring silently fails

Area-gated buildings reject placement unless every footprint tile has the matching `Tile.area`; multi-service authoring can also hit affordability if capital is implicit.

Control: explicit `PaintAreaRectangle` before every zoned building group, fixed ample starting capital, and `assert!(result.applied, ...)` on every authoring mutation.

### 2. Transit optimization measured only on trivial service cardinality

One Bus + one Metro with two stops cannot falsify whether service/transfer enumeration was fixed.

Control: mandatory 20k stress row with eight active services and at least four waypoints per service, plus structural `transit_shape_count` evidence.

### 3. Wrong private-car cache grain

Exact tile OD would rerun Dijkstra for multiple tiles of one building.

Control: key only road-access points/headings and assert reuse across shared-building tiles.

### 4. Accidental public routing surface

Control: planners stay `pub(crate)`; external tests use public one-shot APIs / hidden engine evidence seam only.

### 5. Claiming total simulation speed from spawn-only evidence

Control: record post-spawn tick cost and state the measured remaining bottleneck explicitly.

## Files and ownership

Expected changes:

- `crates/caelum-core/src/router.rs` — batch-lived service catalog, route shapes, scalar scoring, flow-sensitive ride cache, one-shot wrapper.
- `crates/caelum-core/src/traffic.rs` — building-access index + access-pair Dijkstra cache + one-shot wrapper.
- `crates/caelum-core/src/route_choice.rs` — crate-private coordinator + local flow generation + internal stats.
- `crates/caelum-core/src/trips.rs` — one production batch planner, flow-change notification, spawn-seam reference test.
- `crates/caelum-core/src/engine.rs` — hidden scale-harness stats return only.
- `crates/caelum-core/src/lib.rs` — private coordinator registration; hidden stats re-export only if required by the public harness signature.
- `crates/caelum-core/tests/common/mod.rs` — export route-choice fixture helper.
- `crates/caelum-core/tests/common/route_choice_fixture.rs` — shared mixed/stress fixture.
- `crates/caelum-core/tests/route_choice_batching.rs` — fast composition/fixture smoke.
- `crates/caelum-core/tests/route_choice_scale.rs` — ignored before/after release evidence rows.
- `crates/caelum-core/tests/population_scale.rs` — coarse/split proof using the same fixture.
- `docs/performance/hpa-348-route-choice-batching.md` — baseline/final evidence.

`examples/presentation_scale.rs` remains the HPA-544/HPA-347 harness and does not gain another fixture implementation.

No TypeScript, Svelte, persistence/store, renderer, or WebGPU files should change.

## Acceptance

HPA-348 is complete when:

1. one test-common fixture authors roads/tracks, required areas, real buildings, Bus/Metro nodes, routes, and vehicles with every mutation asserted applied;
2. a fast smoke proves real private-car + transit outcomes;
3. a mandatory 8-service / 4+-waypoint stress row exercises non-trivial transit route cardinality;
4. `RoutePlanner` builds active services and route shapes once per demand batch rather than once per citizen;
5. transit per-citizen scoring does not allocate every candidate plan and materializes only the winner;
6. Bus ride durations refresh only after batch-local road-flow changes; sequential mode choice remains current-flow correct;
7. private-car Dijkstra preparation is bounded by road-access-pair cardinality and preserves exact-tile access walk;
8. the spawn-seam reference test proves exact ordered mode/plan/path/arrival/final-flow equality and includes a car→non-car identical-OD switch;
9. strict `<`, empty-leg handling, and spawn-time planless `Idle` behavior remain unchanged;
10. planners stay crate-private and no persistent cache/revision system appears;
11. private-car load remains aggregate `RoadFlow` with no per-car ECS entity;
12. coarse/split deterministic behavior stays green;
13. base 1k/5k/20k + transit-stress evidence records route-spawn and post-spawn tick time, structural planner counts, mode mix, and the measured remaining bottleneck;
14. the full Rust/frontend/browser gate remains green;
15. the ticket remains one PR.