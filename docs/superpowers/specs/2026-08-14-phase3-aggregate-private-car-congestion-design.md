# Phase 3 Aggregate Private-Car Congestion Design

**Linear:** HPA-622  
**Parent:** HPA-333

## Goal

Deliver one Phase 3 player-visible traffic slice:

> A due worker commute can choose a private-car road path when it is the fastest deterministic option. Active car commutes contribute aggregate road load. That load increases road travel time through one small congestion rule shared by private cars and buses. The Data panel exposes one Traffic overlay.

Cars matter here because they compete with buses for road capacity. This slice does not turn Caelum into a microscopic car simulator.

## Current seams to reuse

The repository already has the right boundaries:

- `GameEngine` owns the authoritative `GameSnapshot` plus a compiled `RoadTopology`.
- `RoadTopology::find_path_between_access_tiles` already resolves deterministic one-way/junction/roundabout-aware road paths.
- `stop_access::derive_stop_access_for_footprint` already resolves usable road access beside a multi-tile footprint.
- `router::find_route_plan` already selects the best deterministic walk/transit plan by `estimated_seconds`.
- `TransitPath::Road` and `RoadPathStep` already carry the exact structural road path used by buses.
- `transit::tick_vehicles` and `seconds_until_next_vehicle_stop` already use the path cursor and feed vehicle-arrival boundaries into the trip scheduler.
- `trips::tick_trips_substepped` already breaks coarse ticks at commute departures, move-ins, vehicle arrivals, day boundaries, and other deterministic events.
- `UiState.activeOverlay`, `DataPanel.svelte`, and `overlayRenderer.ts` already implement one-at-a-time map overlays.

Reuse those seams. Do not add a second traffic graph, top-level traffic cache, scheduler service, or second vehicle system.

## Chosen representation: aggregate car state on `ActiveTrip`

Represent a private-car commute as the existing `ActiveTrip` plus one small payload containing the captured road path and fixed arrival timestamp.

```rust
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivateCarTrip {
    pub path: TransitPath,
    pub arrival_time: f64,
}
```

Add one lifecycle state:

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

and one required nullable field:

```rust
pub struct ActiveTrip {
    // existing fields
    pub private_car_trip: Option<PrivateCarTrip>,
}
```

A valid driving trip has:

- `status == Driving`;
- `route_plan == None`;
- `current_leg_index == 0`;
- `private_car_trip == Some(...)`;
- no transit-vehicle passenger membership;
- `position == origin` until arrival because cars have no rendered/authoritative intermediate position.

When the car arrives, the payload is cleared before normal arrival scoring. Terminal trips never retain stale road-load state.

### Why not `TransitMode::Car`

Keep `TransitMode` as `Walk | Bus | Metro`. It describes route-plan legs attached to transit services. A private car has no line, platform, boarding/alighting indexes, or transit vehicle. Adding `Car` would force transit-only matches, validators, route editors, and renderers to understand a fake line mode.

### Alternatives rejected

A top-level `TrafficState { roadLoads, ... }` cache is rejected because every road edit, building edit, move-in, trip departure, trip arrival, and restore would need invalidation rules for data already derivable from active driving trips.

Individual car entities/path cursors are rejected because lane position, car-following, parking, and per-step movement are not required to make congestion affect transit operations.

## Schema v6 is a direct development break

HPA-622 bumps the disposable development snapshot schema from 5 to 6 because `ActiveTrip` gains required wire state.

Update directly:

- Rust `SNAPSHOT_SCHEMA_VERSION = 6`;
- TypeScript `SNAPSHOT_SCHEMA_VERSION = 6`;
- IndexedDB default database `caelum-city-saves-v6`, version `6`;
- native application-data directory `cities-v6`.

Old development cities disappear. Do not add migration, alias fields, serde defaults for the new car payload, dual readers, or fallback namespaces.

## Private-car endpoint access and routing

Create `crates/caelum-core/src/traffic.rs` and keep it functional rather than manager-based.

For each commute endpoint (`home` or `workplace`):

1. find the placed building whose `occupied_tiles` contains the point;
2. reuse `derive_stop_access_for_footprint(&state.map, &building.occupied_tiles)`;
3. use its `road_point` and `preferred_heading`.

If either endpoint is not inside a placed building or has no usable adjacent road, no car candidate exists. Do not search arbitrary nearby roads, add driveways, or model parking.

Use the engine's existing compiled topology:

```rust
routing.road_topology.find_path_between_access_tiles(
    &state.map,
    from_access.road_point,
    to_access.road_point,
    from_access.preferred_heading,
    to_access.preferred_heading,
)
```

Accept only a non-empty `TransitPath::Road`. A zero-step/same-access result leaves the existing walk/transit candidate in control.

## Aggregate flow is derived, not persisted

Use one fixed capacity for the current single road class:

```rust
pub const ROAD_FLOW_CAPACITY: u16 = 4;
pub const MAX_CONGESTION_MULTIPLIER: f64 = 3.0;
```

Current road flow is derived from active `Driving` trips. For one driving trip, gather the unique `RoadPathStep.position` values in its captured road path and add one flow unit to each point. Repeated visits to the same point by one path count once.

Use `BTreeSet<Point>` / `BTreeMap<Point, u16>`; `Point` already has stable ordering. Saturate pathological counts instead of panicking.

For the first slice, structure transitions are charged to their existing `RoadPathStep.position`. Do not expand junction or roundabout footprints into synthetic traffic cells.

### One congestion function

Use the same bounded multiplier everywhere road traffic matters:

```rust
pub fn congestion_multiplier(flow: u16) -> f64 {
    (f64::from(flow) / f64::from(ROAD_FLOW_CAPACITY))
        .clamp(1.0, MAX_CONGESTION_MULTIPLIER)
}
```

Semantics:

- flow `0..=4`: `1.0x` free-flow;
- flow `6`: `1.5x`;
- flow `>= 12`: capped at `3.0x`.

Effective road-step time is:

```text
step.travel_seconds * congestion_multiplier(flow_at_step)
```

Do not add BPR curves, queues, density, signals, road classes, or tunable traffic parameters yet.

## A departing car counts itself during mode choice

When estimating a new private-car candidate:

1. derive current active-car flow;
2. for each unique point in the candidate path, evaluate that step with `current_flow + 1`;
3. sum the effective step seconds.

This avoids a fixed-point/equilibrium solver while keeping simultaneous departures deterministic:

- the first due worker sees current flow plus itself;
- if it chooses car, the trip is pushed immediately;
- the next due worker in stable sim order sees the earlier chosen car in active flow.

Do not repeatedly rerun mode choice to converge traffic assignment.

## Deterministic commute mode choice

At each due outbound/return worker commute:

1. get the current best walk/transit candidate from `router::find_route_plan`;
2. get the private-car candidate from `traffic::private_car_candidate` using the existing `RoutingContext`;
3. choose private car only if its ETA is **strictly less** than the walk/transit `estimated_seconds`;
4. exact ties keep existing walk/transit behavior;
5. if only one candidate exists, use it;
6. if neither exists, preserve the existing unserved lifecycle.

Do not persist resident-level preferred mode or car ownership. Outbound and return trips may choose differently if the network changed.

When walk/transit wins, keep the current spawned-trip shape (`Idle`, no route plan) and let `tick_trip` perform its existing plan/advance flow. A temporary plan may be calculated for comparison without refactoring the established lifecycle merely to eliminate one small repeat calculation.

When car wins:

```text
status = Driving
route_plan = None
current_leg_index = 0
private_car_trip.path = chosen road path
private_car_trip.arrival_time = state.time + chosen ETA
```

No boarding time, parking penalty, or building-to-road walking penalty is included in the first slice.

## Car arrival uses the existing substep scheduler

Do not add a car timer loop.

Teach `track_active_trip_boundary` to recognize `Driving` before it attempts route-plan/wait handling:

```rust
if trip.status == TripStatus::Driving {
    if let Some(car) = &trip.private_car_trip {
        track_next_boundary(next, car.arrival_time, state.time);
    }
    return;
}
```

At or after the arrival boundary, `tick_trip` handles `Driving` before current riding/planning logic. It must be panic-free: a malformed driving trip with no car payload is marked unserved rather than calling `expect`.

For a valid arrival:

1. set trip position to destination;
2. clear `private_car_trip`;
3. call the existing `score_arrival(trip, state.time)`.

`advance_active_trips_with_zero_delta_ids` already uses `TripTickResult` to update metrics, apply commute resolution/arrival to the sim, and remove terminal trips, so no second completion pipeline is needed.

The existing per-second safety net already upper-bounds one arrival boundary per active car; add another cap term only if a focused test proves the current cap can exhaust.

## Trip invalidation must clear captured car state

Existing gameplay mutations can reset an active trip to `Idle` when its destination is removed/reassigned. Any path that makes a trip non-driving must also clear `private_car_trip`.

In particular, `transit.rs::cleanup_removed_destination_references` currently retargets an affected outbound trip by setting `status = Idle`, clearing `route_plan`, and changing destination. Add `trip.private_car_trip = None` in that same reset block.

Inventory all production resets with:

```bash
rg -n 'status = TripStatus::Idle|route_plan = None' crates/caelum-core/src
```

Only update paths that can receive a driving trip. Route-line invalidation paths that operate exclusively on trips whose `route_plan` references the changed line naturally do not match driving trips and need no new car-specific branch.

Resident demolition already removes the whole sim/trip, so no special traffic cleanup is needed: derived flow disappears with the trip.

A road removed under an already-driving car does **not** dynamically replan or cancel that car in this slice. The car completes from its captured departure path. This is deliberate to avoid dynamic assignment machinery.

## Buses use the same congestion cost at runtime

Stored `RouteLegPath.current_path` remains structural/free-flow data. Do not rewrite route paths when traffic changes.

Add one helper in `traffic.rs`:

```rust
pub fn effective_road_step_seconds(
    state: &GameSnapshot,
    step: &RoadPathStep,
) -> f64;
```

and use it for bus road steps in both runtime clocks:

1. `transit::advance_vehicle_by_seconds` movement;
2. `transit::seconds_until_next_vehicle_stop`, which feeds `next_boundary_after`.

These must agree. If movement uses congestion but the boundary estimator uses free-flow time, coarse/fine ticks diverge.

`TransitPathStepRef` already distinguishes `Road` and `Track`; use that existing enum. Metro track steps remain unchanged.

Also make current bus ride estimates in `router::find_route_plan` sum congestion-adjusted road-step seconds from the snapshot. That lets mode choice compare a car ETA with the bus time the runtime will actually experience. Metro estimates remain current static path time.

Do not rebuild route connectivity or re-run route path resolution because of congestion; only runtime travel time changes.

## Traffic overlay

Add `"traffic"` to `Overlay` and one `Traffic` button to the existing Data panel.

Create `src/domain/traffic.ts` to derive presentation flow from `state.activeTrips` using the same simple rule:

- include only `status === "driving"`;
- require `privateCarTrip.path.kind === "road"`;
- unique a trip's road points before incrementing the global count.

The selector or renderer must filter against the **current** map and paint only tiles whose current `kind === "road"`. A captured car path can outlive a later road removal; the overlay must not paint an empty/non-road tile because of that historical path.

Normalize presentation intensity against a TS display mirror of capacity `4`, capped at full intensity. TypeScript does not implement the congestion multiplier or mode choice; Rust remains gameplay authority.

Driving trips are skipped by `citizenRenderer.ts`. The Traffic overlay is the only new car visualization.

No legend, history, text labels, hover inspector, or second traffic overlay is part of HPA-622.

## Verification ownership

### Rust

Focused tests prove:

1. no car candidate without building road access at either endpoint;
2. no car candidate without a legal road path;
3. one-way/roundabout legality comes from the existing `RoadTopology`;
4. multiplier values: `0..=4 -> 1.0`, `6 -> 1.5`, high flow -> `3.0` cap;
5. one driving trip counts once per unique road point;
6. candidate ETA includes the candidate itself;
7. exact time ties keep walk/transit;
8. same-time workers choose deterministically in stable sim order;
9. driving trips resolve exactly at the arrival boundary, clear car state, and reuse normal arrived/late metrics;
10. coarse/fine ticks produce equivalent modes, car flow, sim flags, and metrics;
11. destination retarget resets captured car state;
12. bus movement and next-stop boundary use the same delayed road-step time;
13. metro timing is unchanged;
14. bus route-plan ETA includes current congestion;
15. v6 persistence accepts the valid driving shape and rejects the representative mismatches without a broad adversarial matrix.

### TypeScript/UI

Focused unit tests prove:

1. the traffic selector ignores non-driving trips and deduplicates one trip's repeated point;
2. multiple driving trips aggregate predictably;
3. a historical captured point that is no longer a current road is not painted;
4. `Traffic` toggles through the existing overlay UI;
5. `citizenRenderer` does not draw driving trips;
6. v6 snapshot/save fixtures use the new namespace/version.

### Real sandbox smoke

Extend the existing `tests/e2e/smoke.spec.ts` only enough to prove real UI wiring:

- keep the current Small House + Supermarket + occupancy flow;
- extend the existing two-way road so both building footprints have connected road access;
- verify the Data panel exposes `Traffic` and its button toggles `aria-pressed`;
- keep the existing Resume/Pause/clock journey responsive.

Do **not** wait several real minutes for a specific worker departure or inspect traffic pixels in Playwright. Rust tests own deterministic car selection/congestion, and renderer tests own exact overlay behavior from a driving fixture. This keeps E2E fast and stable.

## Non-goals

- Individual car entities, sprites, path cursors, or positions.
- Lane changing, acceleration, car-following, collision avoidance, queues, or signals.
- Parking, driveways, ownership, fuel, tolls, emissions, or congestion pricing.
- Random/probabilistic mode choice or preference profiles.
- Local/collector/arterial classes or editable road capacity.
- Traffic assignment equilibrium or repeated route/mode convergence.
- Dynamic re-timing or replanning of an already-driving car.
- Multiple traffic overlays, history, dashboards, or diagnostics.
- Transit schedules/headways/fleet operations (HPA-334).
- Campaign redesign, save migration, compatibility readers, or pre-release hardening.

## Exit criteria

HPA-622 is complete when a deterministic commute can choose a captured private-car road path, active cars derive aggregate load without a second traffic state store, that load increases both car ETA and bus road-step time through the same helper, car arrival remains coarse/fine deterministic, destination retargeting clears stale car state, and the shared UI exposes one current-road-only Traffic overlay without introducing microscopic traffic simulation infrastructure.
