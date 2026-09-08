# HPA-348 Route Choice Batching and Traffic-Demand Design

**Linear:** HPA-348 — [Scale] Batch route choice and traffic-demand processing for large commute waves

**Status:** Proposed implementation design

## Context

HPA-347 is now merged. Caelum's latent population is ECS-owned and wakes through an exact-time scheduler instead of scanning the full population every tick. The HPA-347 reference evidence shows the next CPU-side scale seam clearly:

| Due demand wave | Scheduler emission | Route spawning |
| ---: | ---: | ---: |
| 1,000 | 370 µs | 243 µs |
| 5,000 | 1,626 µs | 1,272 µs |
| 20,000 | 6,175 µs | 4,784 µs |

Route spawning is already a close second to scheduler emission and grows linearly with the number of due demands. HPA-348 owns that route-choice term.

The current route-spawn path is intentionally simple:

```text
ECS due activities
  -> Vec<TripDemand> in canonical order
  -> derive one mutable RoadFlow
  -> for each demand
       find walk/transit plan
       find private-car candidate
       choose faster mode
       if car wins, add its path to RoadFlow immediately
       create ActiveTrip
```

That sequential `RoadFlow` mutation is a gameplay invariant, not incidental implementation detail. A car admitted for citizen N can make a later citizen's private-car path or bus ride slower and can therefore change citizen N+1's mode choice. HPA-348 must remove repeated **static network work** without freezing the dynamic congestion-sensitive result for an entire batch.

There is also an evidence gap in the current HPA-347 wave fixture: its synthetic home points are not placed buildings, so `traffic::private_car_candidate` cannot produce a car candidate, and no Bus/Metro service exists. The current `route_spawn_us` row therefore measures a walking-heavy bridge rather than the mixed road/transit workload HPA-348 is meant to optimize.

## Goals

- Measure a real mixed road/transit peak before changing algorithms.
- Reuse static route work across exact repeated origin/destination pairs in one due-demand batch.
- Preserve flow-sensitive car ETA, bus ETA, and strict mode-choice semantics in canonical demand order.
- Build the active transit service catalog once per batch instead of once per citizen.
- Resolve building road access and road Dijkstra paths once per exact OD pair per batch instead of once per citizen.
- Keep private-car congestion mesoscopic through the existing aggregate `RoadFlow`; do not introduce one Bevy entity per car.
- Preserve detailed `ActiveTrip`, waiting, transfer, capacity, transit vehicle, route-health, and trip-resolution behavior.
- Record 1k/5k/20k representative peak evidence and the dominant remaining CPU cost.
- Deliver design, implementation, deterministic regression tests, and evidence in the same HPA-348 PR.

## Non-goals

- No WebGPU, viewport/LOD, presentation cadence, or interpolation work; HPA-640 owns those.
- No full Bevy application or Bevy renderer/UI.
- No generic routing service, cache framework, cache eviction policy, LRU, TTL, or cross-city cache.
- No spatial zoning system solely to create cache keys.
- No frozen one-mode answer for a whole commute wave.
- No microscopic lane changing or persistent ECS car entity.
- No broad migration of the established `ActiveTrip`, passenger, or transit-vehicle lifecycle into ECS unless Task 0 profiling proves that shell-side lifecycle processing becomes the dominant HPA-348 cost after route batching.
- No save compatibility layer. If a measured, load-bearing change later requires a schema break, development saves can move directly to the new schema.

## Approaches considered

### A. Batch-local exact-OD preparation — chosen

Create one demand-batch planning context for each `drain_and_spawn` call. It owns a transit planner built once from the current snapshot and lazy exact-OD caches for non-car candidate preparation and private-car road paths. Each citizen still gets a fresh congestion-sensitive score against the current mutable `RoadFlow`.

Advantages:

- preserves current semantics exactly;
- cache invalidation is automatic because the context dies at the end of the batch;
- no network revision counter or persistent cache lifecycle;
- repeated households/jobs naturally reuse work;
- exact OD keys are already present in `TripDemand`, so no new zoning abstraction is needed.

Trade-off: work is repeated across later substeps even when the network is unchanged. That is acceptable until profiling proves cross-batch reuse is necessary.

### B. Persistent cache keyed by network revision — rejected for this slice

A long-lived cache could reuse results across ticks, but it immediately requires a stable revision model covering road edits, stop/station lifecycle, route edits, fleet availability, line activation, and other service changes. Flow-sensitive scoring would still need to run per demand.

This adds invalidation complexity before the existing benchmark proves it is useful. HPA-348 starts batch-local; a cross-batch cache is a later profiling-driven optimization, not scaffolding for this PR.

### C. Aggregate by zones/time bands and choose one mode for each cohort — rejected

This would reduce work further, but it changes current semantics. Different exact buildings can have different road access and walking distance, and same-time cars alter later congestion. A zone-wide or frozen cohort answer can therefore change mode choice, service use, and road flow.

HPA-348 can batch exact repeated OD work without inventing a new behavioral approximation.

## Chosen architecture

Add one small orchestration module over the existing routing authorities:

```text
population::TripDemand (already canonicalized)
              |
              v
       route_choice::DemandBatchPlanner
          /                         \
         v                           v
 router::RoutePlanner       traffic::PrivateCarPlanner
 (transit catalog +          (building access +
  exact-OD candidates)        exact-OD road path)
         \                           /
          \                         /
           +---- current RoadFlow --+
                     |
              per-demand score
                     |
        NonCar | PrivateCar | Unserved
                     |
             existing ActiveTrip
```

The new module coordinates mode choice only. It does not own topology, transit lifecycle, traffic progression, trip progression, or persistence.

### `router::RoutePlanner`

Refactor the current `find_route_plan` implementation behind an owned planner that extracts the active Bus/Metro service catalog once.

Conceptual interface:

```rust
pub(crate) struct RoutePlanner { /* owned active-service data + OD cache */ }

impl RoutePlanner {
    pub(crate) fn new(state: &GameSnapshot) -> Self;

    pub(crate) fn find_route_plan(
        &mut self,
        flow: &RoadFlow,
        origin: Point,
        destination: Point,
    ) -> Option<RoutePlan>;
}
```

`find_route_plan` lazily prepares the candidate **shape** for an exact `(origin, destination)` pair and caches that prepared set. A prepared set contains enough stable information to rebuild the winning `RoutePlan` without enumerating services/ride-edge combinations again.

Scoring remains dynamic:

- walking time is static;
- Metro ride time is static while the prepared service shape is alive;
- Bus ride time is recomputed from the current `RoadFlow` through the existing `effective_road_path_seconds` behavior;
- equal-time plans keep the existing `estimated_seconds` then `plan_identity_key` ordering.

The existing public `router::find_route_plan(...)` remains a thin one-shot wrapper around `RoutePlanner` so focused router tests and non-batch callers do not need a second routing algorithm.

### `traffic::PrivateCarPlanner`

Refactor private-car preparation into two phases:

1. static access/path preparation;
2. current-flow ETA scoring.

Conceptual interface:

```rust
pub(crate) struct PrivateCarPlanner { /* building access index + OD path cache */ }

impl PrivateCarPlanner {
    pub(crate) fn new(state: &GameSnapshot) -> Self;

    pub(crate) fn candidate(
        &mut self,
        road_topology: &RoadTopology,
        flow: &RoadFlow,
        origin: Point,
        destination: Point,
    ) -> Option<PrivateCarCandidate>;
}
```

Construction builds a point-to-building-road-access lookup once from the current buildings and map. On the first exact OD request, it runs `RoadTopology::find_path_between_access_tiles` and stores the resulting static path plus access-walk seconds. Later requests for the same OD reuse that path.

Every call still computes `estimated_seconds` from the **current** `RoadFlow`, including the existing `+1` candidate load on every road step. A cached path is not a cached ETA.

The existing public `traffic::private_car_candidate(...)` remains a one-shot wrapper for focused tests and callers outside demand batching.

### `route_choice::DemandBatchPlanner`

This is the only new cross-module seam.

Conceptual interface:

```rust
pub(crate) enum RouteChoice {
    PrivateCar(PrivateCarCandidate),
    NonCar(RoutePlan),
    Unserved,
}

pub(crate) struct DemandBatchPlanner {
    non_car: router::RoutePlanner,
    private_car: traffic::PrivateCarPlanner,
}

impl DemandBatchPlanner {
    pub(crate) fn new(state: &GameSnapshot) -> Self;

    pub(crate) fn choose(
        &mut self,
        road_topology: &RoadTopology,
        road_flow: &RoadFlow,
        origin: Point,
        destination: Point,
        current_time: f64,
    ) -> RouteChoice;
}
```

It reuses the existing strict private-car-vs-non-car comparison. It does not mutate `RoadFlow`; `trips::spawn_pending_trip_demands` retains that responsibility immediately after a car wins, preserving the current ordering contract.

`DemandBatchPlanner` is created exactly once inside each `spawn_pending_trip_demands` invocation and dropped when that batch is complete.

## Cache key and lifetime

Use exact points, not zones or departure bands:

```text
(origin.x, origin.y, destination.x, destination.y)
```

Current route choice has no independent departure-time-band input. Adding one to the cache key would be speculative.

Cache lifetime is the invalidation strategy:

- a batch sees one current map/transit structure;
- edits cannot interleave inside the synchronous demand-spawn loop;
- the next `drain_and_spawn` creates fresh planners from the next snapshot;
- no network revision or explicit invalidation API is required.

Hash-map iteration order must never affect gameplay. Caches are lookup-only; all user-visible selection continues through existing deterministic candidate ordering and the already canonical `TripDemand` sequence.

## Sequential congestion invariant

The critical regression is:

```text
base RoadFlow
  -> demand A scores
  -> if A chooses car, add A path to RoadFlow
  -> demand B scores against the new RoadFlow
  -> ...
```

The implementation must not:

- pre-score all demands against the base flow;
- cache `PrivateCarCandidate.estimated_seconds` across citizens;
- cache a final `RoutePlan.estimated_seconds` for Bus across citizens;
- group all identical OD rows and assign one frozen mode.

A targeted test will use repeated identical OD demand where the first admitted car raises congestion enough for a later demand to make a different choice. Batched output must match a reference sequence using the existing one-shot planners step by step.

## Private-car simulation boundary

HPA-348 keeps the existing per-citizen `ActiveTrip` lifecycle because that row currently owns:

- citizen/purpose linkage;
- trip deadline and outcome;
- population terminal resolution;
- presentation/metrics inputs;
- save/restore of in-flight travel.

It does **not** create a separate Bevy car entity. Road congestion remains the aggregate `RoadFlow` derived from driving trips, and same-time new car demand is accumulated directly into that flow.

This is the smallest interpretation of the roadmap's mesoscopic-car requirement that preserves existing lifecycle semantics. Migrating `ActiveTrip`/passenger/vehicle storage itself into ECS is a distinct subsystem change. Task 0 records active-trip progression separately; if that becomes the dominant HPA-348 cost after batching, the design must be amended with that measured seam before implementation expands. Otherwise it remains out of scope.

## Representative benchmark

### Correct the fixture first

The HPA-347 wave fixture is retained for scheduler history, but HPA-348 adds a new peak fixture that actually exercises mode choice:

- use real residential building tiles as origins so private-car access can resolve;
- use real job/optional-destination building tiles as destinations;
- author connected road access;
- provide at least one operational Bus service and one operational Metro service on useful OD paths;
- generate 1k/5k/20k same-time demands across a bounded set of repeated exact OD pairs;
- retain a mix where walk, private car, Bus, and Metro are all reachable outcomes;
- keep the fixture deterministic and generated in Rust; no external benchmark data.

The fixture may repeat a small number of authored origin/destination buildings rather than pretending to represent 200k unique buildings. HPA-348 is testing route-choice work under a 200k-population-style **demand wave**, not city generation.

### Evidence rows

Record at minimum:

- due demand count;
- distinct exact OD count;
- total route-spawn wall time;
- transit prepared-OD misses;
- private-car path misses;
- final mode counts (walk/car/bus/metro/unserved);
- resulting road-flow cardinality/load summary.

Run the same fixture through the pre-batching reference path and the batch planner in Task 0/implementation evidence where practical. Wall-clock values remain reference evidence, not CI thresholds.

Structural tests, not wall-clock CI thresholds, enforce that repeated exact OD input does not cause one static route search per citizen.

## Testing strategy

### Router parity

Existing router planning tests continue to call the one-shot wrapper. Add focused parity coverage showing one `RoutePlanner` reused across repeated OD requests returns the same plan as the one-shot API under:

- free flow;
- changed bus congestion between calls;
- equal-time deterministic tie ordering;
- Bus and Metro service availability.

### Private-car parity

Add focused tests showing:

- repeated exact OD uses one prepared road path;
- ETA changes when `RoadFlow` changes despite path reuse;
- different OD creates a separate prepared path;
- no-road-access remains `None`.

Test-only cache statistics may be exposed behind `#[cfg(test)]`; do not add production telemetry or public cache APIs only for assertions.

### Batch equivalence

Add a new integration test file for the real demand-spawn seam. For an identical ordered demand vector:

1. run a reference one-shot route choice sequence, mutating `RoadFlow` after every chosen car;
2. run the batch planner path;
3. compare trip mode, route plan/path identity, arrival time, final `RoadFlow`, and deterministic trip order.

Include the congestion-switch case where identical OD rows do not all choose the same mode.

### Granularity

Extend the scale/lifecycle proof with a mixed due wave and assert coarse vs split advancement reaches the same durable simulation state. HPA-347 already established the exact-time population scheduler; HPA-348 must prove batching does not weaken that invariant.

## Files and ownership

Expected production changes stay focused:

- `crates/caelum-core/src/route_choice.rs` — new batch-level mode-choice orchestration only;
- `crates/caelum-core/src/router.rs` — reusable active-service/OD preparation plus dynamic scoring;
- `crates/caelum-core/src/traffic.rs` — reusable building-access/road-path preparation plus dynamic scoring;
- `crates/caelum-core/src/trips.rs` — construct one batch planner in `spawn_pending_trip_demands`, preserve ordered flow mutation;
- `crates/caelum-core/src/lib.rs` — register the private module/test seam;
- `crates/caelum-core/examples/presentation_scale.rs` — representative mixed peak harness;
- `crates/caelum-core/tests/router_planning.rs` — planner parity;
- `crates/caelum-core/tests/traffic.rs` — private-car path/ETA parity;
- `crates/caelum-core/tests/route_choice_batching.rs` — end-to-end batch equivalence and deterministic congestion switch;
- `crates/caelum-core/tests/population_scale.rs` — coarse/split mixed-wave scale proof if the existing harness seam fits cleanly;
- `docs/performance/hpa-348-route-choice-batching.md` — baseline/final evidence.

No TypeScript, Svelte, host backend, persistence-store, renderer, or WebGPU file should change unless implementation profiling exposes a concrete contract break that this design does not currently predict.

## Acceptance

HPA-348 is complete when:

1. the representative mixed peak exercises real road access plus Bus/Metro route choice;
2. repeated exact OD input does not rebuild the active transit service catalog or run road Dijkstra once per citizen;
3. flow-sensitive ETA and strict mode choice still run in canonical demand order;
4. a congestion-switch regression proves batching does not freeze one answer for an OD cohort;
5. private-car load still contributes to aggregate `RoadFlow` without a separate per-car ECS entity;
6. existing Bus/Metro waiting, transfers, capacity, vehicle movement, route health, and income behavior remain green;
7. coarse/split deterministic behavior remains green;
8. 1k/5k/20k benchmark evidence records throughput, cache reuse, mode mix, and the dominant remaining cost;
9. full Rust/frontend/browser gates pass, even though no frontend behavior is expected to change;
10. the work remains one HPA-348 PR.

## Follow-up boundary

The evidence may show that scheduler emission remains the dominant peak cost after route batching. That is a result, not a reason to absorb scheduler redesign into HPA-348.

Likewise, if active-trip progression rather than route planning becomes the dominant measured cost, create/amend a later focused scale slice for that lifecycle ownership change instead of pre-building a broad ECS trip/vehicle migration here. HPA-640 remains independently responsible for GPU presentation, viewport/LOD extraction, and publication/interpolation cadence.