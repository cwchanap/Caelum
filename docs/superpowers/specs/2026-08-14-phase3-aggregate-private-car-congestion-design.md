# Phase 3 Aggregate Private-Car Congestion Design

**Linear:** HPA-622  
**Parent:** HPA-333

## Goal

Deliver one Phase 3 player-visible traffic slice:

> A due worker commute can choose walk/transit or a private-car road path from deterministic generalized travel cost. Active car commutes create aggregate road load. That load slows live bus road movement through the same bounded congestion function, while the Data panel exposes one Traffic overlay.

Cars matter because a worker with road access no longer automatically chooses transit, but a well-served bus must remain competitive. This slice therefore includes one fixed private-car access overhead; it does not turn Caelum into a microscopic car simulator or a calibrated transport-demand model.

## Current seams to reuse

The repository already has the right boundaries:

- `GameEngine` owns the authoritative `GameSnapshot` plus a compiled `RoadTopology`.
- `RoadTopology::find_path_between_access_tiles` resolves deterministic one-way/junction/roundabout-aware road paths.
- `stop_access::derive_stop_access_for_footprint` resolves usable road access beside a multi-tile footprint.
- `router::find_route_plan` selects the best deterministic walk/transit plan by `estimated_seconds`.
- `TransitPath::Road` and `RoadPathStep` carry structural/free-flow road paths used by buses.
- `transit::tick_vehicles` and `seconds_until_next_vehicle_stop` share the path cursor and feed vehicle-arrival boundaries into the trip scheduler.
- `trips::tick_trips_substepped` already breaks coarse ticks at commute departures, trip resolution, move-ins, vehicle arrivals, day boundaries, and other deterministic events.
- `UiState.activeOverlay`, `DataPanel.svelte`, and `overlayRenderer.ts` already implement one-at-a-time map overlays.

Reuse those seams. Do not add a second traffic graph, persisted traffic cache, scheduler service, or second vehicle system.

## Chosen representation: aggregate car state on `ActiveTrip`

Represent a private-car commute as the existing `ActiveTrip` plus one small payload containing the captured road path and frozen arrival timestamp.

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

Engine-produced driving trips use this invariant:

- `status == Driving`;
- `route_plan == None`;
- `current_leg_index == 0`;
- `private_car_trip == Some(...)`;
- no transit-vehicle passenger membership;
- `position == origin` until arrival because cars have no rendered/authoritative intermediate position.

When a trip leaves `Driving`, its car payload is cleared at the existing lifecycle helper that changes the status.

### Why not `TransitMode::Car`

Keep `TransitMode` as `Walk | Bus | Metro`. It describes route-plan legs attached to transit services. A private car has no line, platform, boarding/alighting indexes, or transit vehicle. Adding `Car` would force transit-only matches, validators, route editors, and renderers to understand a fake service mode.

### Alternatives rejected

A top-level persisted `TrafficState` is rejected because the load is derivable from active driving trips.

Individual car entities/path cursors are rejected because lane position, car-following, parking, and per-step movement are not required to make road traffic affect transit operations.

## Schema v6 is a direct development break

HPA-622 bumps the disposable development snapshot schema from 5 to 6 because `ActiveTrip` gains required wire state.

Update directly:

- Rust `SNAPSHOT_SCHEMA_VERSION = 6`;
- TypeScript `SNAPSHOT_SCHEMA_VERSION = 6`;
- IndexedDB default database `caelum-city-saves-v6`, version `6`;
- native application-data directory `cities-v6`;
- `GameEngine::from_snapshot` documentation says schema v6.

Old development cities disappear. Do not add migration, alias fields, serde defaults for the new car payload, dual readers, or fallback namespaces.

## Private-car endpoint access, cost, and routing

Create `crates/caelum-core/src/traffic.rs` and keep it functional rather than manager-based.

For each commute endpoint (`home` or `workplace`):

1. find the placed building whose `occupied_tiles` contains the point;
2. reuse `derive_stop_access_for_footprint(&state.map, &building.occupied_tiles)`;
3. use its `road_point` and `preferred_heading`.

If either endpoint is not inside a placed building or has no usable adjacent road, no car candidate exists. Do not search arbitrary nearby roads, add driveways, or model parking.

Use the engine's already-compiled `RoadTopology`; thread a borrowed topology through trip ticking instead of recompiling it:

```rust
road_topology.find_path_between_access_tiles(
    &state.map,
    from_access.road_point,
    to_access.road_point,
    from_access.preferred_heading,
    to_access.preferred_heading,
)
```

Accept only a non-empty `TransitPath::Road`. A zero-step/same-access result leaves the walk/transit candidate in control.

### One fixed private-car overhead

The repository already prices walking at `20 s/tile` and bus boarding at `90 s`. A car with only `1.25 s` road steps would otherwise dominate every ordinary commute. Keep the model small by adding exactly one new generalized cost constant:

```rust
pub const CAR_ACCESS_SECONDS: f64 = 120.0;
```

Move the existing `20 s/tile` walking constant to a shared commute timing constant so router, trip walking, and private-car endpoint access use the same number; do not add a second independently tunable walking cost.

Private-car candidate ETA is:

```text
origin -> origin road access walk
+ CAR_ACCESS_SECONDS
+ congestion-adjusted captured road path
+ destination road access -> destination walk
```

The two endpoint walks use Manhattan distance at the existing `20 s/tile` rate.

`CAR_ACCESS_SECONDS` is a deliberately coarse access/parking/generalized-cost term. It is not a new parking subsystem and has no per-building or per-road knobs.

### Cost sanity check

The cost must allow all three useful outcomes rather than making car a universal winner.

For a 12-tile commute with one tile of endpoint access on each side:

- walk-only: `12 * 20 = 240s`;
- direct car at free flow: `20 + 120 + (12 * 1.25) + 20 = 175s`;
- direct bus with equivalent one-tile access: `20 + 90 + (12 * 1.25) + 20 = 145s`.

So a good bus beats the car, while the car beats a long walk when no useful transit exists.

A short six-tile trip remains walk-favored: `120s` walk versus at least `167.5s` for the same one-tile-access car shape.

A detouring bus can cross back behind the car as road cost rises. With equal endpoint access, a direct 12-step car and a 22-step bus route differ by ten road steps. The bus has a 30s fixed-cost advantage (`90` vs `120`), so it wins while `1.25 * multiplier * 10 < 30`, but the car wins once the shared multiplier exceeds `2.4`. This is the intended scale: useful transit can win, poor/detouring transit can lose, and congestion can matter without preferences or an assignment solver.

Do not add household car ownership, random mode choice, value-of-time profiles, or additional tuning constants in HPA-622.

## Aggregate flow is derived once per scheduling iteration, not persisted

Use an ephemeral derived map:

```rust
pub type RoadFlow = BTreeMap<Point, u16>;
```

`RoadFlow` is not part of `GameSnapshot` or `GameEngine`; it is rebuilt from current active driving trips at each scheduling iteration/substep boundary and then borrowed by router/transit timing code. This avoids rescanning every active trip path inside each road-step cost lookup without creating invalidation state.

For one driving trip, gather the unique `RoadPathStep.position` values in its captured road path and add one flow unit to each point. Repeated visits to the same point by one path count once. Use `BTreeSet<Point>` / `BTreeMap<Point, u16>` and saturating increments.

When several workers depart at the same timestamp, start with the derived flow map and update that local map immediately after each selected car is pushed. Later workers in stable sim order therefore see earlier same-time car choices without recomputing the whole map.

### Flow-change boundary invariant

**Every event that changes `RoadFlow` in HPA-622 is already a substep boundary.**

- car departure changes flow at the existing top-of-loop scheduled-departure seam;
- car arrival/removal changes flow at the new active-trip arrival boundary.

Within a substep, the borrowed `RoadFlow` is immutable.

Buses do **not** contribute to flow in HPA-622. Position-based bus load would change at path-step completions, which are not current scheduler boundaries; adding buses as flow is therefore a later timing-model change, not a one-line extension to the derived-flow loop.

### Whole-path occupancy is intentionally aggregate

A driving trip contributes one unit to **every road point in its captured route for the trip's whole lifetime**. Therefore `ROAD_FLOW_CAPACITY = 4` means four active commutes whose captured routes overlap a point, not four physically present cars on that tile. The value is an aggregate gameplay threshold, not a lane-capacity claim.

Keep that approximation explicit before tuning the number later.

## One congestion function

Use one fixed capacity for the current single road class:

```rust
pub const ROAD_FLOW_CAPACITY: u16 = 4;
pub const MAX_CONGESTION_MULTIPLIER: f64 = 3.0;

pub fn congestion_multiplier(flow: u16) -> f64 {
    (f64::from(flow) / f64::from(ROAD_FLOW_CAPACITY))
        .clamp(1.0, MAX_CONGESTION_MULTIPLIER)
}
```

Semantics:

- flow `0..=4`: `1.0x` free-flow;
- flow `5`: `1.25x`;
- flow `6`: `1.5x`;
- flow `>= 12`: capped at `3.0x`.

Effective road-step time is:

```text
step.travel_seconds * congestion_multiplier(flow_at_step)
```

The helper takes `&RoadFlow`, not `&GameSnapshot`, so it never derives the whole flow map from inside a hot path.

Do not add BPR curves, queues, density, signals, road classes, or tunable traffic parameters yet.

## A departing car counts itself during mode choice

When estimating a new private-car candidate:

1. use the current borrowed `RoadFlow`;
2. for each candidate road point, evaluate its road steps with `current_flow + 1`;
3. add endpoint walks and `CAR_ACCESS_SECONDS`;
4. sum to one candidate ETA.

If the car wins, push the trip immediately and add that captured path to the local mutable flow map before evaluating the next same-time worker.

Do not repeatedly rerun mode choice to converge traffic assignment.

## Deterministic commute mode choice

At each due outbound/return worker commute:

1. get the current best walk/transit candidate from `router::find_route_plan(state, flow, ...)`;
2. get the private-car candidate from `traffic::private_car_candidate(state, road_topology, flow, ...)`;
3. choose private car only if its ETA is **strictly less** than the walk/transit `estimated_seconds`;
4. exact ties keep existing walk/transit behavior;
5. if only one candidate exists, use it;
6. if neither exists, preserve the existing unserved lifecycle.

Do not persist resident-level preferred mode or car ownership. Outbound and return trips may choose differently if the network changed.

When walk/transit wins, keep the current spawned-trip shape (`Idle`, no route plan) and let `tick_trip` perform its established plan/advance flow.

When car wins:

```text
status = Driving
route_plan = None
current_leg_index = 0
private_car_trip.path = chosen road path
private_car_trip.arrival_time = state.time + chosen ETA
```

The arrival timestamp is frozen at departure.

## Car arrival uses the existing substep scheduler

Do not add a car timer loop.

Teach `track_active_trip_boundary` to recognize `Driving` before route-plan/wait handling:

```rust
if trip.status == TripStatus::Driving {
    if let Some(car) = &trip.private_car_trip {
        track_next_boundary(next, car.arrival_time, state.time);
    }
    return;
}
```

At or after the boundary, `tick_trip` handles `Driving` before current riding/planning logic. A malformed driving trip with no payload is marked unserved rather than panicking.

For a valid arrival:

1. set trip position to destination;
2. pass through existing `score_arrival`;
3. `score_arrival` clears `private_car_trip` before setting `Arrived`/`Late`.

For malformed driving state, `mark_unserved` clears `private_car_trip` before setting `Unserved`.

`advance_active_trips_with_zero_delta_ids` continues to own metrics, sim resolution/arrival, and terminal removal.

### Substep-cap accounting

Do not justify car arrivals with the per-second safety net. `SIM_SHIFT_BOUNDARIES_PER_DAY = 6` already budgets, per worker/day, outbound spawn + outbound resolution + return spawn + return resolution plus two boundaries of headroom. A private-car arrival consumes the existing outbound/return **resolution** slot; it is not a seventh independent per-sim event category.

Update the `max_tick_substeps` doc comment to state that counting argument and add a focused coarse-tick regression with many staggered driving arrivals. Add a new cap term only if that counting test disproves the existing bound.

## Exact bus/car clock semantics

The bus clock is live; the car clock is frozen.

1. **Cars keep their captured arrival timestamp.** Later congestion does not re-time or re-route an active car in this slice.
2. **Bus `step_progress` remains a fraction of the current effective step duration.** If flow changes between substeps, the fraction is unchanged and remaining wall-clock time becomes `(1 - step_progress) * new_effective_step_seconds`. Do not add a stored remaining-seconds field.
3. **Boundary ordering stays deterministic.** Due departures are spawned before the next substep. Within `advance_tick_substep`, vehicles advance before active trips resolve. A car arriving at the substep end therefore still contributes to that substep's bus movement; the next scheduling iteration rebuilds `RoadFlow` after terminal removal and sees the reduced load.

A coarse tick crossing car departure/arrival boundaries must match an explicitly split tick.

## Trip invalidation and persistence validation

There are three intentional production exits from `Driving`:

- `score_arrival`: clear `private_car_trip`, then set `Arrived`/`Late`;
- `mark_unserved`: clear `private_car_trip`, then set `Unserved`;
- `transit.rs::cleanup_removed_destination_references`: when retargeting to `Idle`, clear `route_plan` and `private_car_trip` together.

Do not grow a reset abstraction.

Persistence adds only the structural checks needed for the new payload:

- `Driving` requires a car payload;
- the captured path is a non-empty `TransitPath::Road`;
- `arrival_time` is finite and non-negative;
- captured road-step points are inside map bounds.

Do **not** add new persistence checks for `route_plan == None` or `current_leg_index == 0`; engine construction keeps those invariants and runtime Driving handling is panic-free. Do not add a car-specific passenger-membership validator/test either; keep the repository's existing generic `validate_vehicle_membership` behavior unchanged.

A captured path does not need to remain a road after departure. Road removal does not dynamically replan/cancel a driving car in this slice.

## Buses use borrowed `RoadFlow` for the same live congestion cost

Stored `RouteLegPath.current_path` remains structural/free-flow data. Do not rewrite paths when traffic changes.

Add helpers in `traffic.rs`:

```rust
pub fn effective_road_step_seconds(
    flow: &RoadFlow,
    step: &RoadPathStep,
) -> f64;

pub fn effective_road_path_seconds(
    flow: &RoadFlow,
    path: &TransitPath,
) -> f64;
```

Use the same borrowed map for:

1. `router::find_route_plan` bus ride estimates;
2. `transit::seconds_until_next_vehicle_stop`;
3. `transit::advance_vehicle_by_seconds`.

`TransitPathStepRef` already distinguishes Road and Track. Metro timing remains unchanged.

The scheduling loop derives/updates one flow map before `next_boundary_after`, then passes that same map into boundary estimation and `advance_tick_substep`. Do not derive flow again inside each router candidate, path step, or vehicle loop.

Do not rebuild route connectivity because of congestion; only travel cost changes.

## Traffic overlay

Add `"traffic"` to `Overlay` and one `Traffic` button to the existing Data panel.

Create `src/domain/traffic.ts` as a plain selector module, parallel to `platformOccupancy.ts`:

- include only `status === "driving"` with a road car payload;
- unique a trip's road points before incrementing flow;
- aggregate multiple trips;
- paint only tiles whose current `kind === "road"`.

A captured path can outlive a later road removal; presentation must not paint historical non-road tiles.

Mirror only the display constants in TypeScript:

```ts
export const ROAD_FLOW_CAPACITY = 4;
export const MAX_CONGESTION_MULTIPLIER = 3;
```

Normalize presentation intensity to the gameplay cap:

```text
alpha = min(flow / (ROAD_FLOW_CAPACITY * MAX_CONGESTION_MULTIPLIER), 1)
```

So flow `4` is one-third intensity and flow `12` is full intensity. TypeScript does not implement mode choice or congestion math.

Driving trips are skipped by `citizenRenderer.ts`. The Traffic overlay is the only new car visualization.

No legend, history, text labels, hover inspector, or second traffic overlay is part of HPA-622.

## Verification ownership

### Rust

Focused tests prove:

1. no car candidate without building road access or a legal road path;
2. one-way/roundabout legality comes from existing `RoadTopology`;
3. shared walking cost remains `20 s/tile`;
4. `CAR_ACCESS_SECONDS == 120` and natural cost fixtures allow walk, bus, and car each to win in appropriate layouts;
5. multiplier values remain `0..=4 -> 1.0`, `5 -> 1.25`, `6 -> 1.5`, high flow -> `3.0`;
6. one driving trip counts once per unique road point and buses do not contribute;
7. candidate ETA includes itself plus endpoint walks/access overhead;
8. one derived `RoadFlow` is reused through router, boundary, and vehicle timing for a substep;
9. same-time workers update local flow in stable sim order;
10. exact ETA ties keep walk/transit;
11. driving arrival clears payload and reuses normal metrics/sim resolution;
12. malformed Driving becomes `Unserved` panic-free;
13. many staggered car arrivals stay within the documented per-sim substep bound and coarse/fine ticks match;
14. destination retarget clears captured car state;
15. bus movement and next-stop boundary use the same delayed road-step time;
16. fractional bus progress rescales when flow crosses `4 -> 5` at a departure boundary;
17. a car arriving at a substep end still congests that substep and the next scheduling iteration sees reduced flow;
18. bus route-plan ETA reads current borrowed flow; a topology-valid good bus can beat a car at free flow;
19. metro timing is unchanged;
20. v6 persistence accepts the valid driving payload and rejects only representative structural payload failures.

Do not require a synthetic "bus wins before congestion, car wins after" topology fixture. The arithmetic above establishes that such a crossover exists; implementation tests should use topology-produced path times and separately prove (a) good bus service is not dominated and (b) bus ETA responds to active car flow.

### TypeScript/UI

Focused unit tests prove:

1. `tests/runtime/traffic.test.ts` runs under the existing Vitest runtime project;
2. the traffic selector ignores non-driving trips, deduplicates repeated points, aggregates multiple cars, and omits non-road historical points;
3. overlay intensity reaches full only at flow `12`, not flow `4`;
4. `Traffic` toggles through the existing overlay UI;
5. `citizenRenderer` does not draw driving trips;
6. v6 snapshot/save fixtures use the new namespace/version.

### Real sandbox smoke

Extend `tests/e2e/smoke.spec.ts` only enough to prove UI wiring:

- keep the current Small House + Supermarket + occupancy flow;
- extend the existing two-way road so both building footprints have connected road access;
- update the exact budget assertion by the actual added authored road-tile count;
- expose/toggle `Traffic`;
- retain Resume/Pause/clock responsiveness.

Do **not** wait for a specific commute departure or inspect traffic pixels in Playwright.

## Non-goals

- Individual car entities, sprites, path cursors, or positions.
- Lane changing, acceleration, car-following, collisions, queues, or signals.
- Parking simulation, driveways, ownership, fuel, tolls, emissions, or congestion pricing.
- Random mode choice, preference/value-of-time profiles, or household car ownership.
- Road classes or editable capacity.
- Traffic-assignment equilibrium or repeated mode/mode convergence.
- Dynamic re-timing/replanning of active cars.
- Buses contributing to `RoadFlow` before path-step completions become deterministic scheduler boundaries.
- Multiple traffic overlays, history, dashboards, or diagnostics.
- Transit schedules/headways/fleet operations (HPA-334).
- Save migration, compatibility readers, recovery, or pre-release hardening.

## Exit criteria

HPA-622 is complete when deterministic commute cost can naturally select walk, a useful bus, or a private car; active cars derive one ephemeral road-flow map per scheduling iteration; every flow-changing event is a known substep boundary; live bus timing consumes that borrowed flow without rescanning trip paths; car timers remain frozen; structural save validation stays lean; and one current-road-only Traffic overlay exposes the aggregate result without microscopic traffic infrastructure.
