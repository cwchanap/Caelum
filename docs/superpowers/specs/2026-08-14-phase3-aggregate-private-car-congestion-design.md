# Phase 3 Aggregate Private-Car Congestion Design

**Linear:** HPA-622  
**Parent:** HPA-333

## Goal

Deliver one Phase 3 player-visible traffic slice without turning Caelum into a microscopic car simulator:

> A due worker commute can choose a private-car path when the existing road network makes it the fastest deterministic option. Active car commutes contribute aggregate road load. That load increases road travel time through one small congestion rule shared by cars and buses. The Data panel exposes one Traffic overlay so the player can see where the load is.

The slice must preserve the current product direction: city systems exist to create transport-operating problems. Cars matter because they compete for road capacity with buses, not because Caelum needs lane-changing AI, parking, or vehicle physics.

## Current seams that matter

The repository already has nearly all of the structural pieces this feature needs:

- `GameEngine` owns a compiled `RoadTopology` and already passes one authoritative snapshot through every tick and accepted mutation.
- `RoadTopology::find_path_between_access_tiles` resolves deterministic road paths with the same one-way, junction, and roundabout rules used by buses.
- `stop_access::derive_stop_access_for_footprint` already turns a multi-tile footprint into one usable adjacent road access point.
- `router::find_route_plan` already chooses the best deterministic walk/transit plan by `estimated_seconds`, with stable tie-breaking.
- `TransitPath::Road` and `RoadPathStep` already carry the road geometry and free-flow `travel_seconds` used by bus movement.
- `transit::tick_vehicles` and `seconds_until_next_vehicle_stop` already advance buses through those path steps and expose the next stop boundary to the trip substep scheduler.
- `trips::tick_trips_substepped` already breaks a coarse tick at commute departures, vehicle arrivals, move-ins, day boundaries, and other deterministic events.
- `UiState.activeOverlay`, `DataPanel.svelte`, and `overlayRenderer.ts` already support one-at-a-time map overlays.

Reuse those seams. Do not create a second traffic graph, road-state cache, scheduler, or vehicle system.

## Alternatives considered

### A. Aggregate car state on existing `ActiveTrip` — chosen

Represent a private-car commute as the existing `ActiveTrip` plus one small `PrivateCarTrip` payload containing the resolved road path and its fixed arrival timestamp. While that trip is active, its path contributes one unit of aggregate flow to each road step it uses.

This is the smallest approach that gives us:

- deterministic mode choice;
- a real car commute lifecycle with an arrival boundary;
- aggregate road load without car entities or positions;
- enough snapshot data for the Traffic overlay;
- one place for buses to read congestion from the same authoritative state.

### B. Persist a top-level traffic matrix — rejected for now

A `TrafficState { roadLoads, speeds, ... }` cache would make the overlay easy, but every road edit, building edit, move-in, workplace reassignment, trip departure, trip arrival, and load would need cache invalidation/rebuild rules. It would duplicate information already derivable from active car paths and would create a second state lifecycle before there is a second traffic feature.

### C. Simulate individual cars along road steps — rejected

Adding car entities, path cursors, positions, lane occupancy, or per-step replanning would produce a more literal traffic simulation but directly violates the Phase 3 first-slice boundary. It also duplicates the bus vehicle machinery without a current player need.

## Schema v6: add only active private-car trip state

HPA-622 is a breaking development-save change. Bump `SNAPSHOT_SCHEMA_VERSION` from 5 to 6 and update the browser/native save namespaces directly. Old development cities disappear; there is no migration, dual reader, compatibility default, or fallback parser.

Add one trip status:

```rust
pub enum TripStatus {
    Idle,
    Walking,
    Waiting,
    Riding,
    Driving,
    Arrived,
    Late,
    Unserved,
}
```

Add one small payload:

```rust
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivateCarTrip {
    pub path: TransitPath,
    pub arrival_time: f64,
}
```

and one required nullable field on `ActiveTrip`:

```rust
pub private_car_trip: Option<PrivateCarTrip>,
```

TypeScript mirrors the wire shape as `CitizenStatus = ... | "driving"` and `privateCarTrip: PrivateCarTrip | null`.

Do **not** add a `Car` variant to `TransitMode`. `TransitMode` describes the existing route-plan legs (`walk`, `bus`, `metro`). A private car is intentionally not modelled as another transit line leg; it bypasses `RoutePlan` and uses the road payload above. This avoids forcing every transit-only match, renderer, route editor, platform rule, and route validator to understand a fake transit mode.

A valid driving trip has:

- `status == Driving`;
- `route_plan == None`;
- `current_leg_index == 0`;
- `private_car_trip == Some(...)`;
- no vehicle passenger membership;
- `position == origin` until arrival because cars are not rendered/moved individually.

When the trip reaches `arrival_time`, clear `private_car_trip`, move `position` to the trip destination, and reuse the existing arrived/late completion path and commute-flag updates. Terminal trips therefore do not retain a stale car path.

## Private-car access and routing

Create `crates/caelum-core/src/traffic.rs`. Keep the module small and functional.

### Endpoint access

For each commute endpoint (`home` or `workplace` point):

1. find the placed building whose `occupied_tiles` contains the point;
2. call the existing `derive_stop_access_for_footprint(&state.map, &building.occupied_tiles)`;
3. use the resulting `StopRoadAccess.road_point` and `preferred_heading`.

If either endpoint has no matching placed building or no usable adjacent road access, there is no private-car candidate. Do not invent curb searching, driveway objects, parking lots, or a fallback to arbitrary nearby roads.

### Road path

Use the engine's existing compiled `RoadTopology`:

```rust
road_topology.find_path_between_access_tiles(
    &state.map,
    from_access.road_point,
    to_access.road_point,
    from_access.preferred_heading,
    to_access.preferred_heading,
)
```

Accept only a non-empty `TransitPath::Road`. A same-access-point/zero-step result does not create a private-car candidate; the existing walk/transit plan remains the fallback.

This keeps one-way roads, automatic junctions, roundabouts, and terminal road rules aligned with bus routing without a second graph or Dijkstra implementation.

## Aggregate road flow

There is no persisted traffic cache. Aggregate flow is derived from the current active driving trips.

Use one fixed capacity for the current single road class:

```rust
pub const ROAD_FLOW_CAPACITY: u16 = 4;
pub const MAX_CONGESTION_MULTIPLIER: f64 = 3.0;
```

For a road point, flow is the count of `status == Driving` trips whose `private_car_trip.path` contains that `RoadPathStep.position`.

A single car counts at most once per road point even if a path happens to revisit the same step position. Implement path point collection through a small unique-point helper rather than incrementing once per transition.

For the first slice, structure transitions are charged to their existing `RoadPathStep.position`; do not expand automatic-junction or roundabout footprints into artificial per-tile traffic cells. Revisit this only if the Traffic overlay or congestion behavior around structures is visibly misleading.

## One congestion function

Use one monotonic, bounded multiplier for both private-car ETA and bus road-step timing:

```rust
pub fn congestion_multiplier(flow: u16) -> f64 {
    let utilization = f64::from(flow) / f64::from(ROAD_FLOW_CAPACITY);
    utilization.clamp(1.0, MAX_CONGESTION_MULTIPLIER)
}
```

Semantics:

- `flow <= 4`: `1.0x` free-flow;
- `flow == 6`: `1.5x`;
- `flow >= 12`: capped at `3.0x`.

Use the existing road step's `travel_seconds` as the free-flow base:

```text
effective step seconds = step.travel_seconds * congestion_multiplier(flow_at_step)
```

Do not add BPR curves, queue lengths, density, signal delay, stochastic noise, road classes, or tunable parameters in this slice.

## Candidate flow includes the departing car

When estimating a new private-car candidate, compute current active flow first, then add one unit on each unique point in the candidate path before applying the congestion multiplier.

This gives stable simultaneous-departure behavior without a fixed-point solver:

- the first due worker sees the currently active load plus itself;
- after it is accepted as a car trip, it becomes part of snapshot flow;
- the next due worker in stable sim order sees that extra load;
- exact same-time departures therefore produce the same result under coarse and fine ticks.

Do not repeatedly re-run mode choice to find a traffic equilibrium. That is a future model decision, not a first-slice requirement.

## Deterministic mode choice

Keep the current walk/transit planner intact. At each due outbound or return worker commute, before pushing the new trip:

1. ask `router::find_route_plan(state, origin, destination)` for the current best walk/transit candidate;
2. ask `traffic::private_car_candidate(state, routing_context, origin, destination)` for the car path and congestion-adjusted ETA;
3. choose private car only when its ETA is **strictly less** than the existing plan's `estimated_seconds`;
4. if the times are equal, keep the existing walk/transit behavior;
5. if only one candidate exists, use it;
6. if neither exists, keep the existing unserved lifecycle.

Do not persist a resident-level preferred mode. Mode choice happens when each commute is due, using the road/transit state at that departure. Outbound and return trips may therefore choose differently if the network changed during the day.

The current sim iteration order is the tie/order authority. Do not add random choice, percentages, household car ownership, or preferences.

### Preserve the existing transit trip path

When walk/transit wins, leave the newly spawned trip in the same state the current code expects (`Idle`, `route_plan == None`) and let `tick_trip` use the existing planner. The comparison may compute a temporary route plan once at spawn, but do not rewrite the established walk/transit lifecycle solely to avoid that small duplicate calculation.

When car wins, initialize:

```text
status = Driving
private_car_trip.path = chosen road path
private_car_trip.arrival_time = state.time + candidate estimated seconds
route_plan = None
current_leg_index = 0
```

There is no car boarding time, parking penalty, or building-to-road walk penalty in this first slice. Those are mode-choice refinements to add only if the simple model is confusing in playtests.

## Car arrival is a normal substep boundary

Extend `next_boundary_after` to track every active driving trip's future `arrival_time`.

A driving trip remains unchanged until `state.time` reaches that boundary. At the boundary:

- set its position to the destination;
- clear `private_car_trip`;
- resolve arrived vs late from the same deadline rule used by existing trips;
- emit the existing `TripOutcome`/metric delta;
- update the sim's outbound/return completion flags through the same existing completion code path.

Do not add a second car timer loop. The existing substep scheduler already exists to make coarse and fine ticks equivalent.

Persistence validation should enforce only cheap local invariants:

- `arrival_time` is finite and non-negative;
- driving trips have `PrivateCarTrip` and no `RoutePlan`;
- non-driving active trips do not carry `PrivateCarTrip`;
- the private-car path is a non-empty `TransitPath::Road`;
- every road-step position is within map bounds;
- driving trips are not present in any transit vehicle passenger list.

Do not re-run the road router during save validation or reject a local save because a historical car path no longer matches the current topology. Player mutations already operate through the single engine and an active car finishes from its captured departure path.

## Buses share the same congestion helper

Congestion must affect bus timing without mutating or rebuilding stored route paths.

The existing `RouteLegPath.current_path` remains structural/free-flow data. Do not rewrite `RoadPathStep.travel_seconds` every time traffic changes.

Instead, route all runtime bus road-step timing through the traffic helper:

```rust
traffic::effective_road_step_seconds(state, step)
```

Use it in both places that must agree:

1. bus movement inside `transit::tick_vehicles` / its step-advance helper;
2. `transit::seconds_until_next_vehicle_stop`, which feeds `trips::next_boundary_after`.

If one path uses congestion and the other keeps free-flow time, the scheduler will break at the wrong timestamp and coarse/fine ticks can diverge. Treat these two edits as one atomic task.

Metro `TrackPathStep` timing remains unchanged.

Also make current bus ride estimates used by `router::find_route_plan` sum effective road-step seconds from the snapshot rather than the stored free-flow total. This keeps private-car mode choice comparing against the bus time the runtime will actually experience. Metro estimates remain the existing static path time.

Do not change route-preview structural path resolution in this slice. Congestion is runtime travel time, not route connectivity.

## Traffic overlay

Add `"traffic"` to the TypeScript `Overlay` union and one `Traffic` button to the existing Data panel.

Create a small `src/domain/traffic.ts` selector that derives current per-point flow from `state.activeTrips` using only `status === "driving"` and each `privateCarTrip.path`'s road steps. Keep aggregation out of `overlayRenderer.ts` so the renderer only paints selected values.

The overlay should shade road points by flow intensity, normalized against a presentation mirror of the current fixed road capacity (`4`) and capped at full intensity. This mirror is display metadata only; Rust remains the congestion authority.

No legend panel, history chart, route heatmap, speed text, hover inspector, or multiple traffic overlays yet.

Driving trips are not drawn by `citizenRenderer.ts`. The Traffic overlay is the only new car visualization in this slice.

## Save namespaces

Schema v6 is intentionally disposable:

- Rust `SNAPSHOT_SCHEMA_VERSION = 6`;
- TypeScript `SNAPSHOT_SCHEMA_VERSION = 6`;
- IndexedDB default database becomes `caelum-city-saves-v6` and database version `6`;
- native application-data directory becomes `cities-v6`;
- schema-related tests/fixtures move directly to v6.

Do not migrate v5 saves or retain the old namespace as a fallback.

## Verification ownership

### Rust core

Focused tests must prove:

1. a car candidate is absent when either endpoint has no building-road access;
2. a car candidate is absent when the access points have no legal road path;
3. the private-car path reuses one-way/roundabout-aware `RoadTopology` output rather than a separate graph;
4. `congestion_multiplier(0..=4) == 1.0`, `6 -> 1.5`, and high flow caps at `3.0`;
5. one driving trip contributes one unit per unique road point in its captured path;
6. candidate ETA includes the candidate itself in flow;
7. exact equal estimated time keeps the existing walk/transit candidate;
8. multiple same-time workers choose deterministically in stable sim order as earlier car choices increase later candidate load;
9. a driving trip resolves at `arrival_time`, clears its car payload, and records the normal arrived/late result;
10. `next_boundary_after` breaks at a future car arrival so one coarse tick and equivalent fine ticks produce the same active trips, sim flags, traffic flow, and metrics;
11. a bus road step at flow 6 takes `1.5x` its free-flow step time and `seconds_until_next_vehicle_stop` reports the same delayed boundary;
12. metro timing is unchanged;
13. current route-plan bus estimates include congestion while metro estimates do not;
14. v6 persistence accepts a well-formed driving trip and rejects mismatched driving/route-plan/private-car state without introducing a broad adversarial matrix.

### TypeScript/UI

Unit tests must prove:

1. `traffic` is accepted as an overlay and the Data panel exposes `Traffic`;
2. the traffic selector ignores non-driving trips and counts each driving path once per road point;
3. `overlayRenderer` shades the road points produced by the selector and leaves unrelated tiles untouched;
4. `citizenRenderer` does not draw a driving trip as a pedestrian/transit passenger;
5. v6 snapshot fixtures and save-adapter expectations use the new namespace/version.

### Real sandbox smoke

Extend the existing `tests/e2e/smoke.spec.ts` rather than creating a second end-to-end suite.

Keep the current area/building/occupancy flow. Add the minimum road access needed by the existing Small House and Supermarket, resume until the commute system has had a chance to create a real worker trip, open Data, toggle `Traffic`, and assert the overlay control is active while the game remains responsive. Rust and renderer unit tests own exact flow math/pixel behavior; Playwright owns the real player wiring.

Do not turn this into a long simulation scenario or screenshot-diff suite.

## Non-goals

- Per-car entities, sprites, path cursors, or authoritative positions.
- Lane changing, acceleration, car following, collision avoidance, queues, or signals.
- Parking supply/search, driveways, ownership, fuel, tolls, emissions, or congestion pricing.
- Random/probabilistic mode choice or preference models.
- Local/collector/arterial classes or editable road capacity.
- Traffic assignment equilibrium or repeated mode-choice convergence.
- Dynamic re-timing of a car already in flight when later cars enter/leave its path.
- Multiple traffic overlays, historical charts, traffic dashboards, or diagnostics.
- Transit headways, schedules, fleet plans, or service bands (HPA-334).
- Campaign redesign, save migration, compatibility readers, or pre-release hardening.

## Exit criteria

HPA-622 is complete when one real sandbox commute can choose a private car, active car paths create deterministic aggregate road load, that load increases both new-car ETA and bus road-step time through the same helper, coarse/fine ticks agree at car-arrival boundaries, the Traffic overlay exposes the load in the shared Svelte UI, and the implementation adds no generalized traffic framework beyond the small seams above.
