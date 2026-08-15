# Phase 3 Aggregate Private-Car Congestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let current worker commutes naturally choose walk/transit or an aggregate private-car road path, derive deterministic road congestion from active car trips, apply that live road delay to buses, and expose one Traffic overlay.

**Architecture:** Reuse compiled `RoadTopology`, the existing `ActiveTrip` lifecycle, trip substep scheduler, precomputed transit paths, and current overlay UI. Add one functional `traffic.rs` module. A private car remains an `ActiveTrip` payload with captured `TransitPath::Road` + frozen arrival timestamp. Road load is an ephemeral `RoadFlow` derived once per scheduling iteration/substep boundary and borrowed by router/transit timing; it is never persisted or stored on `GameEngine`.

**Tech Stack:** Rust `caelum-core`, Serde, TypeScript, Svelte 5, Vitest, Playwright, Bun, Tauri.

## Global constraints

- Implement only HPA-622, the first child of HPA-333.
- `CAR_ACCESS_SECONDS = 120.0` is the only new private-car generalized cost constant.
- Reuse the existing `20 s/tile` walk cost for car endpoint access; move that existing constant to a shared commute timing constant rather than duplicating it.
- `ROAD_FLOW_CAPACITY = 4`, `MAX_CONGESTION_MULTIPLIER = 3.0`.
- `congestion_multiplier(flow) = (flow / 4).clamp(1.0, 3.0)`; flow `0..=4` is free-flow, flow `5` is `1.25x`, flow `12+` is `3.0x`.
- `RoadFlow` is ephemeral derived data, not `GameSnapshot`/`GameEngine` state.
- One driving trip contributes once per unique `RoadPathStep.position` for the entire driving-trip lifetime.
- `ROAD_FLOW_CAPACITY = 4` therefore means four overlapping active commute routes, not four physical cars currently on one tile.
- Every event that changes flow must already be a substep boundary: car departure or car arrival/removal.
- Buses do not contribute to `RoadFlow` in this slice; bus path-step movement is not currently a scheduler boundary.
- Reuse `derive_stop_access_for_footprint` and `RoadTopology::find_path_between_access_tiles`; no second BFS/topology compile.
- Private car wins only when strictly faster than current best walk/transit; exact ties keep walk/transit.
- Keep `TransitMode = Walk | Bus | Metro`; no `Car` variant.
- Cars have no entity, cursor, intermediate position, parking model, or sprite.
- Private-car `arrival_time` is frozen at departure.
- Bus `step_progress` remains a fraction of the current effective duration; flow changes between substeps rescale remaining wall-clock time.
- Due commute departures remain at the current top-of-loop spawn seam; within a substep vehicles advance before active trips resolve.
- A car arriving at a substep end still congests that substep; the next scheduling iteration rebuilds flow without it.
- Schema v6 is a direct disposable-save break; no migration/default/fallback reader.
- New persistence validation stays structural; runtime Driving handling stays panic-free.
- Traffic overlay reaches full intensity at flow `12`, not free-flow threshold `4`.
- Production paths added by this work remain panic-free; `expect` is only for test fixture construction.

## Cost sanity contract

Before behavior tests are written, lock the arithmetic that prevents car from becoming the universal winner.

For one-tile access at each end and 12 road steps:

```text
walk-only = 12 * 20 = 240s
car free-flow = 20 + 120 + (12 * 1.25) + 20 = 175s
direct bus free-flow = 20 + 90 + (12 * 1.25) + 20 = 145s
```

Expected behavior:

- short six-tile trip: walk can beat car;
- long trip with no useful transit: car can beat walk;
- good direct bus service: bus can beat car;
- poor/detouring bus service: car can beat bus.

Do not require a synthetic congestion-triggered mode-flip fixture. Router/bus tests must use topology-produced path times; separately prove that bus ETA responds to car flow.

## Risks / blast radius

1. **Mode-choice behavior changes existing commute fixtures.** `golden_sequences.rs`, `commute_requirements.rs`, `population.rs`, `objectives_metrics.rs`, and `trip_lifecycle.rs` already assert commute timing/arrival/wait behavior. Task 3 inventories them before changing expectations.
2. **Road-flow derivation can become accidentally quadratic.** Never call `derive_road_flow` from a road-step helper. Derive once per scheduling iteration and pass `&RoadFlow` through router/transit paths.
3. **Granularity independence depends on flow-change boundaries.** Car departure/arrival are boundaries; bus path-step completions are not. Do not later count buses in flow without revisiting scheduler boundaries.
4. **Whole-path occupancy is deliberately coarse.** Capacity is an aggregate overlap threshold, not physical lane occupancy. Do not tune it as if it were vehicles-per-tile.

## File map

**Create**
- `crates/caelum-core/src/traffic.rs`
- `crates/caelum-core/tests/traffic.rs`
- `src/domain/traffic.ts`
- `tests/runtime/traffic.test.ts`

**Modify**
- Core: `crates/caelum-core/src/model.rs`, `lib.rs`, `commute.rs`, `engine.rs`, `trips.rs`, `router.rs`, `transit.rs`, `growth.rs`
- Persistence: `crates/caelum-core/src/persistence/error.rs`, `persistence/trips.rs`, current persistence/wire tests
- Saves: `src/persistence/indexedDbCitySaveStore.ts`, `src-tauri/src/city_store.rs`, current adapter tests
- Frontend: `src/domain/types.ts`, `src/components/hud/panels/DataPanel.svelte`, `src/render/overlayRenderer.ts`, `citizenRenderer.ts`, `colors.ts`
- Fixtures/tests: current Rust commute/router/transit tests, `tests/helpers`, `tests/fixtures`, runtime/render/save tests, `tests/e2e/smoke.spec.ts`
- Docs: `docs/architecture.md`

---

### Task 1: Schema v6, lean Driving validation, and payload-clear hygiene

**Produces:** the minimal wire shape and lifecycle safety used by later tasks.

- [ ] **Step 1: Inventory schema and trip literals.**

```bash
rg -n 'SNAPSHOT_SCHEMA_VERSION|schemaVersion[^\n]*5|caelum-city-saves-v5|DATABASE_VERSION = 5|cities-v5|schema-v5' crates src src-tauri tests docs
rg -n 'ActiveTrip \{' crates/caelum-core
rg -n 'activeTrips:|routePlan:|patienceRemaining:' src tests
```

Every active-trip literal becomes explicit about the new nullable car field.

- [ ] **Step 2: Add failing wire-format tests for one valid Driving trip.**

Use a non-empty one-step road path and assert JSON contains:

```text
status: "driving"
privateCarTrip.path.kind: "road"
privateCarTrip.arrivalTime: 101.25
```

- [ ] **Step 3: Add only structural persistence rejection tests.**

Cover representative failures:

```text
Driving + privateCarTrip null            -> reject
Driving + empty/Track car path           -> reject
Driving + negative/non-finite arrivalTime -> reject
Driving + out-of-bounds captured point   -> reject
```

Do **not** add new rejection cases for Driving + route plan, nonzero current leg, or a dedicated Driving passenger-membership case.

The existing generic `validate_vehicle_membership` remains unchanged; do not weaken or duplicate it.

- [ ] **Step 4: Implement the direct model break.**

In `model.rs`:

```rust
pub const SNAPSHOT_SCHEMA_VERSION: u16 = 6;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivateCarTrip {
    pub path: TransitPath,
    pub arrival_time: f64,
}
```

Add `Driving` to `TripStatus` and add:

```rust
pub private_car_trip: Option<PrivateCarTrip>,
```

Do not add `serde(default)`.

Mirror in TypeScript with `"driving"` and required nullable `privateCarTrip`.

- [ ] **Step 5: Implement lean Driving persistence handling.**

`validate_route_plan` currently rejects any no-plan status except Idle/Unserved, so `validate_trips` needs a narrow Driving branch:

```rust
if trip.status == TripStatus::Driving {
    validate_private_car_trip(snapshot, trip, entity.clone())?;
} else {
    validate_route_plan(snapshot, trip, entity.clone())?;
}
validate_vehicle_membership(indexes, trip, entity)?;
```

`validate_private_car_trip` checks only:

- car payload exists;
- `TransitPath::Road` and non-empty steps;
- finite non-negative `arrival_time`;
- every captured step position is inside map bounds.

Do not require captured points to still be road tiles; an active car may outlive a road edit.

Do not enforce `route_plan == None` / `current_leg_index == 0` in persistence. Those remain production construction invariants, while runtime Driving handling is defensive.

- [ ] **Step 6: Clear car payload at the three existing lifecycle exits.**

In `trips.rs`:

```rust
fn score_arrival(mut trip: ActiveTrip, time: f64) -> TripTickResult {
    trip.private_car_trip = None;
    // existing Arrived/Late logic
}

fn mark_unserved(mut trip: ActiveTrip) -> ActiveTrip {
    trip.private_car_trip = None;
    // existing Unserved logic
}
```

In `transit.rs::cleanup_removed_destination_references`, add `trip.private_car_trip = None` beside the existing Idle/route-plan reset.

Do not create a reset abstraction.

- [ ] **Step 7: Move save namespaces/documentation directly to v6.**

Browser:

```ts
const DEFAULT_DATABASE_NAME = "caelum-city-saves-v6";
const DATABASE_VERSION = 6;
```

Native directory: `cities-v6`.

Update `GameEngine::from_snapshot` documentation from schema v5 to v6. No v5 fallback.

- [ ] **Step 8: Verify Task 1 and commit.**

```bash
cargo test -p caelum-core --test model_wire_format
cargo test -p caelum-core persistence
cargo test -p caelum-core --test transit_build --test trip_lifecycle
bun run test:unit
bun run check
cargo clippy -p caelum-core --all-targets -- -D warnings
rg -n 'caelum-city-saves-v5|cities-v5|SNAPSHOT_SCHEMA_VERSION: u16 = 5|schema-v5' crates src src-tauri tests docs

git add crates/caelum-core src src-tauri tests docs
git commit -m "refactor(core): add schema v6 private car trip state"
```

---

### Task 2: Traffic core—shared walk cost, car generalized cost, RoadFlow, and routing

**Produces:** the only traffic-domain module and cost rules used by trip/router/transit code.

- [ ] **Step 1: Write failing pure cost/flow tests.**

Lock constants:

```rust
assert_eq!(commute::WALK_SECONDS_PER_TILE, 20.0);
assert_eq!(CAR_ACCESS_SECONDS, 120.0);
assert_eq!(congestion_multiplier(0), 1.0);
assert_eq!(congestion_multiplier(4), 1.0);
assert_eq!(congestion_multiplier(5), 1.25);
assert_eq!(congestion_multiplier(6), 1.5);
assert_eq!(congestion_multiplier(12), 3.0);
```

Add flow fixtures proving:

- one Driving trip counts once per unique point;
- repeated positions in one car path count once;
- non-Driving trips count zero;
- two cars sharing a point produce flow two;
- buses do not contribute flow.

- [ ] **Step 2: Move the existing walking cost to shared commute timing.**

In `commute.rs`:

```rust
pub const WALK_SECONDS_PER_TILE: f64 = 20.0;
```

Replace `trips.rs`'s private 20s constant and `router.rs`'s `* 20.0` literal with this existing shared value. This is not a new tuning knob; it prevents car access cost from silently drifting away from current walking behavior.

- [ ] **Step 3: Add the ephemeral RoadFlow type and derivation.**

In `traffic.rs`:

```rust
pub type RoadFlow = BTreeMap<Point, u16>;

pub const CAR_ACCESS_SECONDS: f64 = 120.0;
pub const ROAD_FLOW_CAPACITY: u16 = 4;
pub const MAX_CONGESTION_MULTIPLIER: f64 = 3.0;

pub fn derive_road_flow(state: &GameSnapshot) -> RoadFlow;
pub fn add_car_path_to_flow(flow: &mut RoadFlow, path: &TransitPath);
```

`derive_road_flow` iterates only `status == Driving` + car payload, deduplicates positions per trip with `BTreeSet`, and saturating-adds to the map.

`add_car_path_to_flow` uses the same per-trip dedupe rule. It exists only so same-time departures can update the already-derived local map after a selected car is pushed.

Do not store `RoadFlow` in snapshot/engine state.

- [ ] **Step 4: Add failing endpoint/path tests.**

Using existing area/building/road helpers, prove:

```text
home lacks adjacent usable road      -> no car candidate
workplace lacks adjacent usable road -> no car candidate
disconnected accesses                -> no car candidate
connected two-way road               -> road candidate
one-way direction forbids trip       -> no car candidate
```

Path legality comes only from compiled `RoadTopology`.

- [ ] **Step 5: Implement private-car candidate with endpoint cost.**

Signature:

```rust
pub fn private_car_candidate(
    state: &GameSnapshot,
    road_topology: &RoadTopology,
    flow: &RoadFlow,
    origin: Point,
    destination: Point,
) -> Option<PrivateCarCandidate>
```

For each endpoint, find its containing placed building and call `derive_stop_access_for_footprint`.

Resolve one non-empty `TransitPath::Road` through `find_path_between_access_tiles`.

ETA:

```text
manhattan(origin, from_access.road_point) * WALK_SECONDS_PER_TILE
+ CAR_ACCESS_SECONDS
+ road path seconds using current flow + candidate itself
+ manhattan(to_access.road_point, destination) * WALK_SECONDS_PER_TILE
```

No driveway/parking search and no dynamic car reroute.

- [ ] **Step 6: Prove car is not a universal winner.**

Use topology-produced path steps and natural endpoint distances.

Required assertions:

```text
short ~6-tile commute, no transit -> walk ETA < car ETA
long ~12-tile commute, no transit -> car ETA < walk ETA
```

Task 4 will add the good-bus case after bus ETA reads `RoadFlow`.

Do not hand-write impossible road-step times to force a result.

- [ ] **Step 7: Make road timing helpers borrow RoadFlow.**

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

No public `road_flow_at(state, point)` helper. No road-step helper may derive flow from `GameSnapshot`.

- [ ] **Step 8: Verify Task 2 and commit.**

```bash
cargo test -p caelum-core --test traffic
cargo test -p caelum-core --test road_topology --test router_planning
cargo clippy -p caelum-core --all-targets -- -D warnings

git add crates/caelum-core/src/commute.rs crates/caelum-core/src/traffic.rs crates/caelum-core/src/lib.rs crates/caelum-core/src/router.rs crates/caelum-core/src/trips.rs crates/caelum-core/tests/traffic.rs
git commit -m "feat(core): add aggregate private car cost and road flow"
```

---

### Task 3: Deterministic mode choice, RoadFlow threading, and car-arrival boundaries

**Produces:** end-to-end private-car commute lifecycle without hidden fixture churn or repeated flow scans.

Task 3 mode-choice tests use walk/no-plan only. Bus-specific choice lands in Task 4 after router bus ETA becomes congestion-aware.

- [ ] **Step 0: Inventory existing commute-fixture impact before behavior changes.**

Run:

```bash
rg -n 'tick_trips|tick\(|CommuteOutbound|CommuteReturn|completed_trips|late_trips|unserved_trips|average_wait|outbound_arrived_today|returned_home_today' \
  crates/caelum-core/tests/golden_sequences.rs \
  crates/caelum-core/tests/commute_requirements.rs \
  crates/caelum-core/tests/population.rs \
  crates/caelum-core/tests/objectives_metrics.rs \
  crates/caelum-core/tests/trip_lifecycle.rs
```

Record the number of affected fixtures in the implementation PR/task notes.

For each affected fixture choose one of two intentional outcomes:

1. **Feature expectation changes:** the fixture is about real commute behavior and should now allow car selection; update expected time/mode/metrics.
2. **Preserve old test intent:** the fixture is testing waiting, transit, objective, or failure behavior; remove/deny building road access so private car is unavailable rather than rewriting unrelated expected behavior.

Do not bulk-update snapshots/timings without classifying fixture intent.

- [ ] **Step 1: Inventory direct trip-tick callsites.**

```bash
rg -n 'tick_trips(_with_objectives)?\(' crates/caelum-core
```

Every production caller passes the engine's already-compiled `&RoadTopology`.

- [ ] **Step 2: Thread `&RoadTopology` and one RoadFlow through scheduling.**

Change public trip ticking:

```rust
pub fn tick_trips(
    state: &GameSnapshot,
    road_topology: &RoadTopology,
    delta_seconds: f64,
) -> GameSnapshot;

pub fn tick_trips_with_objectives(
    state: &GameSnapshot,
    road_topology: &RoadTopology,
    delta_seconds: f64,
) -> GameSnapshot;
```

At each current-time processing site in `tick_trips_substepped` (initial pre-loop, main loop, fallback loop, final current-time processing):

```rust
let mut road_flow = traffic::derive_road_flow(&next);
spawn_due_commute_trips(&mut next, road_topology, &mut road_flow);
```

Then use that same post-spawn map for:

```rust
next_boundary_after(&next, &road_flow)
advance_tick_substep(&next, &road_flow, substep_delta)
```

Do not rederive flow inside `next_boundary_after`, router, or vehicle step loops.

`advance_tick_substep` passes the same immutable `&RoadFlow` to transit movement and active-trip planning for the whole substep. Flow changes only after the substep ends and the next scheduling iteration rebuilds it.

- [ ] **Step 3: Thread RoadFlow through planning paths.**

Change the internal route-planning seam:

```rust
router::find_route_plan(state, flow, origin, destination)
```

and thread `&RoadFlow` through:

- `next_boundary_after` -> `track_active_trip_boundary` -> `plan_route`;
- `advance_active_trips_with_zero_delta_ids` -> `tick_trip`;
- due commute mode comparison.

No wrapper that silently derives flow.

- [ ] **Step 4: Initialize the base-trip field.**

`build_trip` adds:

```rust
private_car_trip: None,
```

- [ ] **Step 5: Choose car at the existing due-departure seam and update local flow immediately.**

For each due outbound/return:

```rust
let non_car_plan = router::find_route_plan(state, flow, &origin, &destination);
let car = traffic::private_car_candidate(
    state,
    road_topology,
    flow,
    origin,
    destination,
);
```

Car wins only with strict `<`.

If selected:

```rust
trip.status = TripStatus::Driving;
trip.private_car_trip = Some(PrivateCarTrip {
    path: car.path.clone(),
    arrival_time: state.time + car.estimated_seconds,
});
state.active_trips.push(trip);
traffic::add_car_path_to_flow(flow, &car.path);
```

If non-car wins, keep the existing Idle/no-plan shape.

Push/update in existing stable sim order so worker #2 sees worker #1's chosen car.

- [ ] **Step 6: Add failing mode-choice tests using natural walk/car costs.**

Prove:

```text
car unavailable + walk available -> existing non-car lifecycle
short trip                       -> walk wins
long trip                        -> car wins
exact cost tie                   -> walk/transit wins
same-time worker #2              -> sees worker #1 updated local flow
coarse vs fine                   -> same selected modes + flow
```

No bus comparison in Task 3.

- [ ] **Step 7: Track and resolve Driving before route-plan logic.**

At the top of `track_active_trip_boundary` after terminal handling:

```rust
if trip.status == TripStatus::Driving {
    if let Some(car) = &trip.private_car_trip {
        track_next_boundary(next, car.arrival_time, state.time);
    }
    return;
}
```

At the top of `tick_trip` before Riding/planning:

```rust
if trip.status == TripStatus::Driving {
    let Some(car) = &trip.private_car_trip else {
        return /* existing unserved result using mark_unserved */;
    };

    if state.time + EPSILON < car.arrival_time {
        return unchanged(trip);
    }

    let mut arrived = trip.clone();
    arrived.position = arrived.destination.into();
    return score_arrival(arrived, state.time);
}
```

`score_arrival` / `mark_unserved` own payload clearing from Task 1.

- [ ] **Step 8: Lock max-substep accounting instead of relying on per-second safety net.**

Update `max_tick_substeps`'s doc comment:

```text
SIM_SHIFT_BOUNDARIES_PER_DAY = 6 covers outbound spawn + outbound resolution
+ return spawn + return resolution + two headroom boundaries. A Driving arrival
is the existing commute-resolution boundary, not an additional per-sim category.
```

Add a focused test with many active Driving trips whose `arrival_time`s are staggered within one coarse tick. Assert:

- final snapshot reaches the requested final time;
- all due cars resolve;
- coarse result matches equivalent explicitly split ticks;
- no extra cap term is required.

If this test disproves the counting argument, add an explicit car-arrival bound then; do not wait for a silent truncation in later tests.

- [ ] **Step 9: Add malformed-state and destination-reset regressions.**

```text
Driving + missing payload -> Unserved, no panic
workplace retarget         -> Idle + privateCarTrip null
road removed under car     -> captured car still resolves at frozen arrival time
```

The malformed result must remain saveable under Task 1's structural validation.

- [ ] **Step 10: Verify Task 3 and commit.**

```bash
cargo test -p caelum-core --test traffic --test trip_lifecycle --test golden_sequences --test commute_requirements --test population --test objectives_metrics
cargo test -p caelum-core growth::tests
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings

git add crates/caelum-core/src/engine.rs crates/caelum-core/src/trips.rs crates/caelum-core/src/growth.rs crates/caelum-core/src/router.rs crates/caelum-core/tests
git commit -m "feat(core): add deterministic private car commute trips"
```

---

### Task 4: Apply borrowed RoadFlow to bus ETA, movement, and scheduler boundaries

**Produces:** live bus congestion using the same immutable flow snapshot for one substep, while private-car timers remain frozen.

- [ ] **Step 1: Add failing static bus/metro timing tests.**

Use a bus road step at `(2,1)` with `travel_seconds: 1.25` and a prebuilt `RoadFlow` of six on that point:

```text
effective road step = 1.875s
seconds_until_next_vehicle_stop at progress 0 = 1.875s
advance 1.25s -> step incomplete
advance another 0.625s -> completes
```

Equivalent metro Track timing remains unchanged.

- [ ] **Step 2: Make router bus ETA consume borrowed RoadFlow.**

Change:

```rust
pub fn find_route_plan(
    state: &GameSnapshot,
    flow: &RoadFlow,
    origin: &Point,
    destination: &Point,
) -> Option<RoutePlan>
```

Thread `flow` through one-service/two-transfer candidate helpers.

For Bus + `current_path`, use:

```rust
traffic::effective_road_path_seconds(flow, path)
```

Metro keeps stored path time. Do not rebuild connectivity because of congestion.

- [ ] **Step 3: Prove useful bus service is not dominated by car.**

Build a topology-valid fixture with one-tile access at each endpoint and comparable direct road/bus path lengths.

Assert the natural cost ordering from the design:

```text
direct bus ~145s < direct car ~175s < long walk ~240s
```

Use actual topology-produced `RoadPathStep.travel_seconds`; do not override them to force the result.

Add a second naturally poor bus fixture (extra access walk and/or itinerary detour) where car wins. This proves both modes are reachable without a congestion-specific synthetic flip.

- [ ] **Step 4: Reuse `TransitPathStepRef` for vehicle timing.**

In `transit.rs`:

```rust
fn vehicle_step_seconds(
    flow: &RoadFlow,
    mode: TransitMode,
    step: TransitPathStepRef<'_>,
) -> f64 {
    match (mode, step) {
        (TransitMode::Bus, TransitPathStepRef::Road(step)) => {
            crate::traffic::effective_road_step_seconds(flow, step)
        }
        (_, step) => step.travel_seconds(),
    }
}
```

No new path-step enum or stored congestion clock.

- [ ] **Step 5: Pass the same flow into vehicle movement and next-stop estimation.**

Change `tick_vehicles`, `advance_vehicle_by_seconds`, and `seconds_until_next_vehicle_stop` to accept `&RoadFlow`.

Current-step remaining time remains:

```rust
(1.0 - step_progress).max(0.0)
    * vehicle_step_seconds(flow, vehicle.mode, current_step)
```

Later steps sum the same helper.

Movement and boundary estimation must land in the same commit.

- [ ] **Step 6: Lock fractional-progress rescaling across a 4 -> 5 flow boundary.**

Bus road step: free-flow `1.25s`, `step_progress = 0.5`.

Before departure: flow 4 => `1.0x`.

After fifth car is selected at the scheduled departure boundary:

```text
flow = 5
multiplier = 1.25
effective duration = 1.5625s
remaining = 0.5 * 1.5625 = 0.78125s
```

Assert coarse tick crossing the departure equals ticks explicitly split there. `step_progress` remains `0.5`; no remaining-seconds field is added.

- [ ] **Step 7: Lock vehicle-before-trip arrival ordering.**

Create a Driving trip due exactly at substep end whose captured path covers the bus's current road point.

Assert:

1. bus movement in that substep uses flow including the arriving car;
2. active-trip resolution then clears/removes the car;
3. next scheduling iteration derives lower flow;
4. coarse and explicitly split ticks agree.

- [ ] **Step 8: Prove bus ETA responds to active car flow without a fake mode-flip fixture.**

Using topology-valid route paths, compare `router::find_route_plan` for the same bus route with:

```text
empty RoadFlow -> free-flow bus ETA
nonzero RoadFlow on route -> strictly larger bus ETA
```

Also assert the commute mode comparison consumes that returned ETA.

Do **not** require "bus wins at zero flow, car wins after congestion" in one fixture. The design arithmetic establishes the crossover scale; a topology test should not hand-author impossible travel times merely to force a flip.

- [ ] **Step 9: Verify Task 4 and commit.**

```bash
cargo test -p caelum-core --test traffic --test router_planning --test router_estimate_branches --test transit_router --test trip_lifecycle --test shuttle_service
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings

git add crates/caelum-core/src/router.rs crates/caelum-core/src/transit.rs crates/caelum-core/src/trips.rs crates/caelum-core/tests
git commit -m "feat(core): apply aggregate car flow to bus travel time"
```

---

### Task 5: Traffic overlay, no car sprites, and lean real-UI smoke

**Produces:** one useful player-facing traffic view without turning E2E into a simulation-duration test.

- [ ] **Step 1: Add failing runtime selector tests in the Vitest-included path.**

Create `tests/runtime/traffic.test.ts`, not `tests/domain/traffic.test.ts`.

Use a Driving trip whose road steps visit `(1,0)`, `(2,0)`, `(2,0)` and assert flow one at each unique point. Add a second Driving trip sharing `(2,0)` and assert flow two. Add a Waiting trip with no car payload and assert zero contribution.

Change current tile `(2,0)` to `kind: "empty"` and assert the historical captured point is omitted.

- [ ] **Step 2: Implement presentation-only current-road flow selection.**

Create `src/domain/traffic.ts` with display mirrors:

```ts
export const ROAD_FLOW_CAPACITY = 4;
export const MAX_CONGESTION_MULTIPLIER = 3;
```

`selectTrafficFlow(state)`:

- iterates `status === "driving"` + road car path only;
- deduplicates points within each trip;
- aggregates trips;
- filters to current road tiles;
- sorts y then x.

Do not port mode choice or Rust congestion logic into TypeScript.

- [ ] **Step 3: Add exactly one Traffic overlay control.**

Add `"traffic"` to `Overlay`, add `{ id: "traffic", label: "Traffic" }` to `DataPanel.svelte`, and add one traffic fill color.

- [ ] **Step 4: Scale presentation to aggregate cap and restore canvas alpha.**

```ts
const fullScaleFlow = ROAD_FLOW_CAPACITY * MAX_CONGESTION_MULTIPLIER;
ctx.save();
for (const { point, flow } of selectTrafficFlow(state)) {
  ctx.globalAlpha = Math.min(flow / fullScaleFlow, 1);
  ctx.fillStyle = colors.traffic;
  fillTile(ctx, point);
}
ctx.restore();
```

Tests:

```text
flow 4  -> alpha 1/3
flow 12 -> alpha 1
flow >12 -> alpha 1
historical non-road point -> not painted
```

- [ ] **Step 5: Do not draw Driving as an individual citizen/car.**

In `citizenRenderer.ts` skip `"driving"` alongside existing `"arrived"` rendering exclusion. Add a render regression.

- [ ] **Step 6: Extend existing E2E only for wiring.**

Keep Small House + Supermarket + occupancy flow. Extend the authored two-way road so both footprints have road access and update the exact budget assertion by actual additional road-tile count.

Then verify only:

```ts
await openCommandDestination(page, "data");
const data = page.getByTestId("panel-data");
const traffic = data.getByRole("button", { name: "Traffic" });
await expect(traffic).toBeVisible();
await traffic.click();
await expect(traffic).toHaveAttribute("aria-pressed", "true");
await traffic.click();
await expect(traffic).toHaveAttribute("aria-pressed", "false");
```

Retain current Resume/Pause/population/clock assertions.

Do not wait for a real commute or inspect traffic canvas pixels in Playwright.

- [ ] **Step 7: Record the narrow architecture boundary.**

Add to `docs/architecture.md`:

```text
Private cars are active commute-trip payloads, not vehicle entities.
CAR_ACCESS_SECONDS is one generalized fixed car access cost; walking remains shared 20s/tile.
RoadFlow is ephemeral derived data rebuilt at scheduling boundaries, never persisted.
Every RoadFlow change is a car departure/arrival substep boundary.
Private-car arrival timestamps are frozen at departure.
Bus runtime road-step time consumes one borrowed RoadFlow while preserving fractional step_progress.
Stored route paths remain structural/free-flow.
TypeScript derives only the Traffic overlay from snapshot trip state.
```

Do not document road classes, traffic managers, or service-planning machinery.

- [ ] **Step 8: Run full implementation gate and commit.**

```bash
bun run test:unit
bun run check
bun run test:e2e -- tests/e2e/smoke.spec.ts
bun run format:check
bun run lint
cargo test --workspace
bun run build

git add src tests docs/architecture.md
git commit -m "feat(ui): add aggregate traffic overlay"
```

---

## Final verification checklist

- [ ] Rust/TS schema is v6; browser/native stores use only v6 namespaces; `from_snapshot` docs say v6.
- [ ] `TransitMode` remains Walk/Bus/Metro.
- [ ] Engine-produced Driving trips use car payload + frozen arrival timestamp and no microscopic car state.
- [ ] New persistence checks are limited to Driving payload structure/time/bounds; existing generic vehicle-membership validation is unchanged.
- [ ] `score_arrival`, `mark_unserved`, and destination retarget clear car payload.
- [ ] `WALK_SECONDS_PER_TILE == 20` is shared; `CAR_ACCESS_SECONDS == 120`.
- [ ] Natural topology fixtures prove short-walk, long-car, good-bus, and poor-bus outcomes are all reachable.
- [ ] No persisted traffic/load cache exists.
- [ ] `RoadFlow` is derived once per scheduling iteration and borrowed by router/transit code.
- [ ] Same-time selected cars update local flow immediately in stable sim order.
- [ ] No road-step timing helper scans `GameSnapshot.active_trips`.
- [ ] One car contributes once per unique captured road point for its whole trip; capacity 4 is documented as route-overlap units.
- [ ] Every flow-changing event is a known departure/arrival substep boundary; buses do not contribute flow.
- [ ] Car candidate ETA includes endpoint walks + fixed access overhead + self-inclusive road load.
- [ ] Exact ETA ties keep walk/transit.
- [ ] Task 3 fixture-impact inventory is classified before expectation rewrites.
- [ ] Driving arrival is counted as an existing per-sim commute-resolution boundary in `max_tick_substeps` docs and stress-tested with staggered arrivals.
- [ ] Private-car timers stay frozen after departure.
- [ ] Bus `step_progress` remains a fraction of current effective duration.
- [ ] Crossing flow 4 -> 5 at a departure boundary rescales remaining bus time and coarse/fine ticks match.
- [ ] Vehicles advance before car arrival resolution; next scheduling iteration sees reduced flow.
- [ ] Bus movement, next-stop boundary, and route-plan ETA all consume the same borrowed flow map.
- [ ] Metro/walking timing is unchanged and stored route paths remain structural/free-flow.
- [ ] Traffic selector tests live under `tests/runtime/`.
- [ ] Traffic overlay paints current road tiles only and reaches full intensity at flow 12.
- [ ] Driving trips are not rendered individually.
- [ ] No road classes, signals, parking subsystem, lane physics, random preferences, assignment solver, or compatibility layer was added.

## Final commands

```bash
cargo fmt --all -- --check
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
bun run test:unit
bun run check
bun run test:e2e
bun run format:check
bun run lint
bun run build
```

If an unrelated pre-existing failure appears, record the exact command/failure in the implementation PR instead of expanding HPA-622.
