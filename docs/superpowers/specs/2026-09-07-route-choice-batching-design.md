# HPA-348 Route Choice Batching and Traffic-Demand Design

**Linear:** HPA-348 — [Scale] Batch route choice and traffic-demand processing for large commute waves

**Status:** Proposed implementation design, revised after reuse/scope review

## Context

HPA-347 is merged. Caelum's latent population is ECS-owned and wakes through an exact-time scheduler instead of scanning all citizens every tick. Its final release evidence measured:

| Due demand wave | Scheduler emission | Route spawning |
| ---: | ---: | ---: |
| 1,000 | 370 µs | 243 µs |
| 5,000 | 1,626 µs | 1,272 µs |
| 20,000 | 6,175 µs | 4,784 µs |

HPA-348 owns the route-spawn term. The current production path is intentionally sequential:

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

That mutable-flow ordering is gameplay behavior. A chosen car may make the next citizen's car or Bus ETA slower and may change that citizen's mode. HPA-348 must remove repeated static route work without freezing a final answer for an OD cohort.

The HPA-347 wave evidence also needs a better workload: its synthetic home points are not building-owned tiles and it has no Bus/Metro service, so private-car access cannot resolve and the row is walking-heavy. HPA-348 establishes a real mixed benchmark before changing routing code.

## Goals

- Establish one deterministic mixed road/transit peak fixture and reuse it across benchmark, batch integration, and coarse/split tests.
- Build active Bus/Metro service preparation once per demand batch.
- Reuse transit candidate enumeration per exact `(origin, destination)` tile pair.
- Resolve building road access once per building and reuse road Dijkstra by **road-access pair**, not by citizen tile pair.
- Recompute exact-tile access walk time and all congestion-sensitive Bus/private-car ETA for every demand.
- Preserve strict private-car comparison (`car < non-car`; ties stay non-car), canonical demand order, and immediate `RoadFlow` mutation after each car win.
- Keep private-car traffic mesoscopic through aggregate `RoadFlow`; do not create ECS car entities.
- Keep existing detailed trip/passenger/transit-vehicle operations behavior.
- Record 1k/5k/20k reference evidence and the dominant remaining cost.
- Deliver everything in the existing HPA-348 PR.

## Non-goals

- No WebGPU, viewport/LOD, presentation cadence, or interpolation; HPA-640 owns those.
- No scheduler redesign.
- No broad `ActiveTrip`, passenger, or transit-vehicle ECS migration unless profiling proves that lifecycle becomes the dominant HPA-348 cost after batching and the design is explicitly revised first.
- No persistent route cache, network revision counter, eviction policy, TTL, zones, or departure bands.
- No frozen cohort mode choice.
- No microscopic traffic or per-car ECS entity.
- No TypeScript/Svelte/host contract change.
- No save compatibility layer.

## Reuse decisions

HPA-348 extends the existing authorities rather than replacing them:

- `router::find_route_plan` / `active_services` remain the transit-routing authority.
- `traffic::private_car_candidate` remains the car-routing authority.
- `trips::spawn_pending_trip_demands` remains the only production same-time admission loop and the owner of ordered `RoadFlow` mutation.
- `traffic::add_car_path_to_flow` and the existing strict `<` comparison remain the semantics to preserve.
- Tick-time replans stay on the one-shot route path unless Task 0 profiling shows they dominate.

Prepared transit candidates, prepared private-car road paths, the batch coordinator, cache maps, and benchmark stats are new because no equivalent cache/planner types exist today.

## Chosen architecture

Use one batch-local coordinator per `spawn_pending_trip_demands` call:

```text
TripDemand sequence
       |
       v
route_choice::DemandBatchPlanner   (pub(crate))
   /                         \
  v                           v
router::RoutePlanner        traffic::PrivateCarPlanner
(pub(crate))                (pub(crate))
exact-tile OD cache         building-access index
                            + access-pair path cache
   \                           /
    +------ current RoadFlow -+
                |
         per-demand scoring
                |
   PrivateCar | NonCar | Unserved
                |
       existing ActiveTrip builder
```

The planners are crate-private implementation details. Integration tests continue to use one-shot public APIs or the existing `GameEngine` scale-harness seam; they do not make planner structs into public crate API.

### `router::RoutePlanner`

Refactor the current `find_route_plan` implementation behind an owned crate-private planner:

```rust
pub(crate) struct RoutePlanner {
    map_width: u16,
    map_height: u16,
    services: Vec<TransitService>,
    prepared: BTreeMap<(Point, Point), Option<Vec<PreparedCandidate>>>,
}
```

`RoutePlanner::new(&GameSnapshot)` extracts active Bus/Metro services once.

`find_route_plan(&mut self, &RoadFlow, Point, Point)` lazily prepares the exact-tile OD candidate shapes once and then re-scores them against current flow. Transit preparation remains exact-OD because walk-to-board, transfer walk, and walk-from-alight distances are citizen-tile specific.

Dynamic scoring rules remain unchanged:

- walking time is fixed for one prepared exact OD;
- Metro ride time is fixed while the batch snapshot is fixed;
- Bus road time is recomputed from current `RoadFlow`;
- candidate selection still uses `estimated_seconds` followed by the existing deterministic identity key.

`router::find_route_plan(...)` remains a thin one-shot wrapper for current integration tests and tick-time replans.

Prepared-candidate/cache tests live in `router.rs`'s `#[cfg(test)]` module so `RoutePlanner` does not become public only for tests.

### `traffic::PrivateCarPlanner`

Private-car work has three grains that must not be conflated:

1. **Building access lookup** — stable for the batch and shared by every occupied tile of a building.
2. **Road path** — determined by the resolved road access points/headings.
3. **Access walk + road ETA** — exact citizen tiles and current flow still matter per call.

The planner therefore owns:

```rust
type CarPathKey = (
    Point, Option<Heading>,
    Point, Option<Heading>,
);

pub(crate) struct PrivateCarPlanner {
    access_by_tile: BTreeMap<Point, Option<StopRoadAccess>>,
    prepared_paths: BTreeMap<CarPathKey, Option<TransitPath>>,
}
```

Construction walks `state.buildings` once. For each building it derives one `StopRoadAccess` and maps all occupied tiles to that result.

For each demand:

1. read origin/destination access from `access_by_tile`;
2. key the Dijkstra cache by resolved `(road_point, preferred_heading)` pairs;
3. run `RoadTopology::find_path_between_access_tiles` only on a path-cache miss;
4. compute the exact-tile access seconds every call:

```text
origin tile -> origin road access walk
+ CAR_ACCESS_SECONDS
+ destination road access -> destination tile walk
```

5. score the cached road path against the current `RoadFlow`, including the existing candidate `+1` load per step.

This means two occupied tiles in the same house can have different access-walk seconds while sharing one Dijkstra result. The benchmark and structural tests must demonstrate that car path preparation follows **access-pair cardinality**, not exact citizen-tile OD cardinality.

`traffic::private_car_candidate(...)` remains a one-shot wrapper. Planner/cache tests stay inside `traffic.rs`.

### `route_choice::DemandBatchPlanner`

The coordinator is crate-private:

```rust
pub(crate) enum RouteChoice {
    PrivateCar(PrivateCarTrip),
    NonCar(RoutePlan),
    Unserved,
}

pub(crate) struct DemandBatchPlanner {
    non_car: router::RoutePlanner,
    private_car: traffic::PrivateCarPlanner,
}
```

Its compiling interface is:

```rust
pub(crate) fn choose(
    &mut self,
    map: &GameMap,
    road_topology: &RoadTopology,
    road_flow: &RoadFlow,
    origin: Point,
    destination: Point,
    current_time: f64,
) -> RouteChoice;
```

It owns the one strict car-vs-non-car decision:

```text
car wins only when car.estimated_seconds < non_car.estimated_seconds
```

`choose` returns an owned `PrivateCarTrip` because arrival time depends on `current_time`. It does **not** mutate `RoadFlow` and it does not borrow the whole `GameSnapshot`, so the spawn loop can push to `active_trips` after each choice without holding a conflicting snapshot borrow.

`BTreeMap` is used for cache maps to match the deterministic collection style already used by `RoadFlow`; cache iteration is not gameplay input in any case.

### Spawn integration

`spawn_pending_trip_demands` creates exactly one `DemandBatchPlanner`, then processes the existing demand vector in order.

For each demand:

1. call `choose` against the current `RoadFlow`;
2. create the base `ActiveTrip` exactly as today;
3. for `PrivateCar`, add the car path to `RoadFlow` **before** the next demand and install `Driving` + `private_car_trip`;
4. for `NonCar`, install the route only when `plan.legs` is non-empty, preserving the existing empty-leg filter;
5. for `Unserved`, leave the spawn-time trip planless/`Idle` exactly as today's builder does. Do **not** prematurely mark it `TripStatus::Unserved`; the normal trip lifecycle owns that transition.

Task 3 adds/tests the coordinator without modifying `trips.rs`. Task 4 performs the single production cutover, so there is never an intermediate second mode-choice path in production.

## Cache lifetime and invalidation

The cache lives for one synchronous `spawn_pending_trip_demands` call and is then dropped.

That lifetime is the invalidation mechanism:

- no player edit can interleave inside the spawn loop;
- the next batch rebuilds from the next map/transit state;
- no network revision, invalidation registry, or cross-tick ownership is needed.

Transit cache key: exact `(origin, destination)` points.

Private-car path cache key: resolved origin/destination road access point + preferred heading pairs.

No congestion-sensitive ETA or final mode choice is cached across citizens.

## Shared mixed-peak fixture

The mixed workload is fiddly enough that it must have one constructor, not three copies.

Add one evidence/test helper in `caelum-core`, exposed only as a documentation-hidden harness surface because examples and integration tests compile as external crates:

```rust
#[doc(hidden)]
pub fn mixed_peak_snapshot(count: usize) -> GameSnapshot;
```

The helper lives in a focused `scale_fixture` module and is reused by:

- `examples/presentation_scale.rs`;
- `tests/route_choice_batching.rs`;
- `tests/population_scale.rs`.

The fixture:

- uses canonical non-Student/non-day-off worker IDs so exactly `count` demands wake;
- places all synthetic home/workplace points on real retained building tiles;
- deliberately reuses multiple occupied tiles from the same buildings, creating more exact tile ODs than road-access pairs;
- authors connected roads plus one operational Bus and one operational Metro line through existing `GameIntent` APIs;
- repeats a bounded deterministic OD matrix for 1k/5k/20k waves;
- starts without active trips so post-spawn mode/OD counts can be derived from the resulting snapshot.

A small non-ignored test must assert the fixture actually produces private-car demand and transit demand. CI does not require both Bus and Metro to win a fragile cost race, but both services must be operational/reachable and existing router tests continue to lock Bus/Metro correctness separately.

## Sequential-congestion correctness lock

The load-bearing regression belongs at the actual spawn seam, where `RoadFlow` is mutated.

Because `TripDemand` fields and `spawn_pending_trip_demands` are intentionally crate-private, the exact reference-vs-batched comparison lives as a `trips.rs` unit test rather than leaking those internals to integration tests.

For one ordered repeated-OD demand vector:

1. a test-only reference helper runs the current one-shot `find_route_plan` + `private_car_candidate` algorithm and the strict `<` comparison, updating a reference `RoadFlow` after each car;
2. the production batched `spawn_pending_trip_demands` runs on the same starting state/flow and cloned demands;
3. compare, in order:
   - citizen/trip order;
   - chosen mode;
   - `RoutePlan` identity for non-car trips;
   - car path identity and arrival time for driving trips;
   - final `RoadFlow`.

The fixture must include an identical-OD switch: initial flow is chosen so one demand selects car and, after that car is admitted, a later identical OD selects non-car. The test may search a deterministic starting flow level using real scoring to find the switch. It must not alter production costs to manufacture the result.

`tests/route_choice_batching.rs` remains an external engine-harness integration proof: the shared mixed fixture drains/spawns through `GameEngine`, retains canonical trip order, and yields real car + transit outcomes. It does not need access to crate-private planner or demand fields.

## Stats and benchmark evidence

Use one stats shape only:

```rust
#[doc(hidden)]
pub struct RouteChoiceBatchStats {
    pub transit_prepared_od: usize,
    pub car_prepared_access_paths: usize,
}
```

Internally it is derived from the two crate-private planners. The existing documentation-hidden scale-harness spawn method may return this value so the example can print it; normal tick/presentation/host contracts do not expose it.

The benchmark derives exact-OD count and mode counts from the post-spawn `ActiveTrip` rows, avoiding any need to make `TripDemand` fields public.

Record:

- due/spawned demand count;
- distinct exact tile OD count;
- route-spawn wall time;
- `transit_prepared_od`;
- `car_prepared_access_paths`;
- walk/car/Bus/Metro/unserved counts;
- road-flow summary.

Add one fixture row/assertion where multiple exact home tiles share a small set of building road accesses. `car_prepared_access_paths` must track access-pair cardinality rather than exact tile OD cardinality.

Wall-clock measurements are evidence only; structural counts and semantic equality are the CI locks.

## Testing strategy

### Crate-private planner unit tests

`router.rs`:

- active service catalog is built once per planner;
- repeated exact OD reuses preparation;
- changed `RoadFlow` changes Bus ETA without another prepared OD;
- tie ordering remains deterministic.

`traffic.rs`:

- several exact tile ODs sharing the same building access pair run one Dijkstra preparation;
- exact-tile access seconds still differ when tiles differ;
- current flow re-scores ETA on the cached path;
- a different access pair creates a second path entry;
- missing building road access remains `None`.

`route_choice.rs`:

- one-shot semantic parity for a representative choice;
- strict `<` tie behavior;
- repeated identical OD re-scores when flow changes;
- `choose` never mutates `RoadFlow`.

### Spawn-seam unit test

`trips.rs` owns the reference-vs-batched ordered comparison described above, including the congestion switch and final flow equality.

### Integration smoke

`tests/route_choice_batching.rs` uses only the shared hidden fixture + `GameEngine` harness. It proves the real composition yields canonical order and a mixed car/transit result without making internal planner types public.

### Granularity

`tests/population_scale.rs` uses the same `mixed_peak_snapshot` and compares coarse vs split advancement over a window that crosses the due wave and travel progression. Durable snapshots must match.

## Risks and controls

### 1. No natural congestion switch in the first fixture geometry

This is the main correctness-test risk. Bus boarding penalty, car access penalty, road step cost, and candidate `+1` load may leave a wide gap between modes.

Control: search deterministic initial flow using actual production scoring to find a one-car switch. If the mixed benchmark geometry cannot provide one cleanly, use a smaller dedicated test fixture. Adjust test/benchmark geometry only; do not change gameplay scoring.

### 2. Fixture drift

Bus/Metro/road/building authoring is easy to fork between example and tests.

Control: one hidden `mixed_peak_snapshot` constructor is the only mixed-peak source.

### 3. Accidental public routing API

Integration tests cannot access `pub(crate)` planners.

Control: keep planner/cache assertions in module tests; external tests use one-shot APIs or engine harness only. The only documentation-hidden public surfaces are evidence fixture/stats seams required by examples/integration tests.

### 4. Wrong private-car cache grain

Exact tile OD would miss reuse when different tiles share one building access.

Control: key only the road path by access point/headings and assert path-preparation count on shared-building tiles.

### 5. Premature lifecycle expansion

After route batching, another cost may become dominant.

Control: record it. Do not add scheduler redesign or `ActiveTrip` ECS migration to this PR without first revising HPA-348 around measured evidence.

## Files and ownership

Expected changes:

- `crates/caelum-core/src/scale_fixture.rs` — one documentation-hidden mixed peak constructor.
- `crates/caelum-core/src/router.rs` — crate-private transit preparation/cache + one-shot wrapper.
- `crates/caelum-core/src/traffic.rs` — crate-private access/path preparation/cache + one-shot wrapper.
- `crates/caelum-core/src/route_choice.rs` — crate-private mode-choice coordinator + one stats snapshot source.
- `crates/caelum-core/src/trips.rs` — one production batch planner and ordered flow mutation; spawn-seam unit regression.
- `crates/caelum-core/src/engine.rs` — only the existing hidden scale-harness return plumbing for batch stats.
- `crates/caelum-core/src/lib.rs` — private coordinator registration + documentation-hidden scale fixture/stats exposure.
- `crates/caelum-core/examples/presentation_scale.rs` — baseline/final mixed-wave evidence.
- `crates/caelum-core/tests/route_choice_batching.rs` — external engine-harness composition smoke.
- `crates/caelum-core/tests/population_scale.rs` — coarse/split mixed-wave proof using the same fixture.
- `docs/performance/hpa-348-route-choice-batching.md` — measured evidence.

Existing `tests/router_planning.rs` and `tests/traffic.rs` remain on the public one-shot APIs; internal planner/cache tests belong beside their crate-private types.

No TypeScript, Svelte, persistence/store, renderer, or WebGPU files should change.

## Acceptance

HPA-348 is complete when:

1. one shared mixed-peak fixture exercises real building road access and operational Bus/Metro service;
2. a non-ignored smoke prevents the benchmark from regressing to walking-only;
3. active transit catalog preparation is once per batch and transit candidate preparation is bounded by exact tile OD cardinality;
4. private-car Dijkstra preparation is bounded by **road-access-pair** cardinality, with exact-tile access walks still scored per citizen;
5. the spawn-seam reference test proves ordered mode/plan/path/arrival/final-flow equality and includes an identical-OD congestion switch;
6. strict `<` car choice, empty-leg handling, and spawn-time planless `Idle` behavior remain unchanged;
7. planners stay crate-private and no second production mode-choice path exists;
8. private-car load remains aggregate `RoadFlow` with no per-car ECS entity;
9. coarse/split deterministic behavior remains green on the shared mixed fixture;
10. 1k/5k/20k evidence records throughput, preparation counts, mode mix, and the measured remaining bottleneck;
11. the full Rust/frontend/browser gate remains green;
12. the ticket remains one PR.
