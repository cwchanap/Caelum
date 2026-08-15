# Phase 3 Aggregate Private-Car Congestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let existing worker commute trips choose an aggregate private-car road path, turn active car paths into deterministic road congestion shared with buses, and expose that load through one Traffic overlay.

**Architecture:** Keep the existing road topology, transit paths, trip scheduler, and Svelte overlay pipeline. Add one `traffic.rs` module that derives active-car flow directly from `ActiveTrip.private_car_trip`, computes one fixed-capacity congestion multiplier, and resolves private-car candidates through the already-compiled `RoadTopology`. Cars never get vehicle entities or positions: a driving trip captures a road path plus an arrival timestamp, while bus runtime step timing calls the same congestion helper dynamically.

**Tech Stack:** Rust `caelum-core`, Serde, TypeScript, Svelte 5, Vitest, Playwright, Bun, Tauri.

## Global constraints

- Linear scope is HPA-622, the first child of HPA-333; do not expand into the rest of Phase 3.
- `ROAD_FLOW_CAPACITY = 4` for the existing single road class.
- `MAX_CONGESTION_MULTIPLIER = 3.0`.
- Congestion multiplier is `(flow / capacity).clamp(1.0, 3.0)`; flow `<= 4` is free-flow.
- Aggregate flow is derived from active `Driving` trips; no persisted traffic matrix/cache.
- A car contributes at most one unit to each unique `RoadPathStep.position` in its captured path.
- Car pathfinding reuses `RoadTopology::find_path_between_access_tiles`; no second graph or routing algorithm.
- Endpoint road access reuses `derive_stop_access_for_footprint` on the matching placed-building footprint.
- Private car wins only when its congestion-adjusted ETA is strictly less than the existing walk/transit plan. Exact ties keep current walk/transit behavior.
- Existing `TransitMode` stays `Walk | Bus | Metro`; do not add `Car` to the transit route model.
- A private-car trip stores only its road path and arrival timestamp; no car entity, path cursor, position, lane state, parking, or rendering.
- Bus runtime road-step timing and next-stop boundary timing must both use the same congestion helper.
- Metro and walking timing remain unchanged.
- Schema v6 is a direct development break: no migration, serde compatibility default, fallback reader, or old save namespace.
- The UI gets one `Traffic` overlay only; no legend/dashboard/history/road classes.

## File map

**Create:**
- `crates/caelum-core/src/traffic.rs` — car access/path candidate, active-flow aggregation, congestion math, effective road-step/path time.
- `crates/caelum-core/tests/traffic.rs` — focused road access, flow, congestion, mode-choice, arrival, bus-delay determinism.
- `src/domain/traffic.ts` — presentation-only aggregate-flow selector for the Traffic overlay.
- `tests/domain/traffic.test.ts` — TypeScript selector coverage.

**Modify:**
- Core model/tick: `crates/caelum-core/src/model.rs`, `lib.rs`, `engine.rs`, `trips.rs`, `router.rs`, `transit.rs`.
- Persistence validation: `crates/caelum-core/src/persistence/trips.rs`, schema/wire tests under `crates/caelum-core/tests/`.
- Save namespace: `src/persistence/indexedDbCitySaveStore.ts`, `src-tauri/src/city_store.rs` and their existing tests.
- TS wire/UI: `src/domain/types.ts`, `src/render/overlayRenderer.ts`, `src/render/citizenRenderer.ts`, `src/render/colors.ts`, `src/components/hud/panels/DataPanel.svelte`.
- Fixtures/tests: `tests/helpers/gameState.ts`, `tests/fixtures/rustSnapshot.ts`, `tests/render/overlayRenderer.test.ts`, `tests/render/citizenRenderer.test.ts`, `tests/e2e/smoke.spec.ts`, plus schema/save-adapter tests found by the Task 1 inventory.
- Docs: `docs/architecture.md`.

---

### Task 1: Schema v6 + minimal private-car trip wire state

**Files:**
- Modify: `crates/caelum-core/src/model.rs`
- Modify: `crates/caelum-core/src/persistence/trips.rs`
- Modify: `src/domain/types.ts`
- Modify: `src/persistence/indexedDbCitySaveStore.ts`
- Modify: `src-tauri/src/city_store.rs`
- Modify: existing Rust/TS snapshot and storage tests/fixtures returned by the inventory commands below.

**Interfaces:**
- Produces Rust `TripStatus::Driving` and `PrivateCarTrip { path: TransitPath, arrival_time: f64 }`.
- Produces required `ActiveTrip.private_car_trip: Option<PrivateCarTrip>` / TS `privateCarTrip: PrivateCarTrip | null`.
- Later tasks rely on `Driving` being valid only with a private-car payload and no transit vehicle membership.

- [ ] **Step 1: Inventory every schema-v5 and `ActiveTrip` literal before editing.**

Run:

```bash
rg -n 'SNAPSHOT_SCHEMA_VERSION|schemaVersion[^\n]*5|caelum-city-saves-v5|DATABASE_VERSION = 5|cities-v5' crates src src-tauri tests docs
rg -n 'ActiveTrip \{' crates/caelum-core
rg -n 'activeTrips:|routePlan:|patienceRemaining:' src tests
```

Keep this list in the task notes while implementing. Do not hide missing literals behind serde defaults or optional TS fields.

- [ ] **Step 2: Add failing v6 wire/validator tests.**

Extend the existing model/persistence wire tests with a driving trip shaped like:

```rust
ActiveTrip {
    id: "trip-1-1".into(),
    sim_id: "sim-001".into(),
    purpose: TripPurpose::CommuteOutbound,
    origin: Point { x: 1, y: 1 },
    destination: Point { x: 5, y: 1 },
    position: Point { x: 1, y: 1 }.into(),
    status: TripStatus::Driving,
    deadline: 600.0,
    route_plan: None,
    current_leg_index: 0,
    patience_remaining: WAIT_PATIENCE_SECONDS,
    private_car_trip: Some(PrivateCarTrip {
        path: TransitPath::Road {
            steps: vec![/* one valid RoadPathStep fixture */],
            total_travel_seconds: 1.25,
        },
        arrival_time: 101.25,
    }),
}
```

Assert JSON emits `status: "driving"`, `privateCarTrip.path.kind: "road"`, and `privateCarTrip.arrivalTime`.

Add representative invalid-state tests only:

```text
Driving + privateCarTrip null                     -> reject
Driving + routePlan Some                          -> reject
non-Driving + privateCarTrip Some                  -> reject
Driving trip present in a transit vehicle          -> reject
Driving + track privateCarTrip path                -> reject
non-finite/negative privateCarTrip.arrivalTime      -> reject
```

Do not add a combinatorial malformed-path matrix.

- [ ] **Step 3: Implement the direct schema break.**

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

Add `Driving` to `TripStatus` and add this required field to `ActiveTrip`:

```rust
pub private_car_trip: Option<PrivateCarTrip>,
```

Mirror it in `src/domain/types.ts`:

```ts
export type CitizenStatus =
  | "idle"
  | "walking"
  | "waiting"
  | "riding"
  | "driving"
  | "arrived"
  | "late"
  | "unserved";

export interface PrivateCarTrip {
  path: TransitPath;
  arrivalTime: number;
}

export interface ActiveTrip {
  // existing fields
  privateCarTrip: PrivateCarTrip | null;
}
```

Set `private_car_trip: None` / `privateCarTrip: null` in every existing literal and fixture found in Step 1. Do not make the field optional.

- [ ] **Step 4: Teach persistence validation the one legal driving shape.**

In `persistence/trips.rs`, keep current walk/transit route-plan validation, but branch before the `route_plan == None` mismatch check:

```rust
if trip.status == TripStatus::Driving {
    let car = trip.private_car_trip.as_ref()
        .ok_or_else(|| trip_state_error(SnapshotField::TripStatus, entity.clone()))?;
    if trip.route_plan.is_some() || trip.current_leg_index != 0 {
        return Err(trip_state_error(SnapshotField::TripRoutePlan, entity.clone()));
    }
    validate_private_car_trip(snapshot, car, entity.clone())?;
} else if trip.private_car_trip.is_some() {
    return Err(trip_state_error(SnapshotField::TripStatus, entity.clone()));
} else {
    validate_route_plan(snapshot, trip, entity.clone())?;
}
```

`validate_private_car_trip` must require:

```text
arrival_time finite and >= 0
path variant == TransitPath::Road
road steps non-empty
each step.position inside map bounds
```

Update vehicle membership to:

```rust
let valid = match trip.status {
    TripStatus::Riding => memberships == 1,
    _ => memberships == 0,
};
```

- [ ] **Step 5: Move both active save stores to v6 with no compatibility path.**

Browser:

```ts
const DEFAULT_DATABASE_NAME = "caelum-city-saves-v6";
const DATABASE_VERSION = 6;
```

Native:

```text
cities-v6
```

Update exact schema/namespace expectations in existing IndexedDB, Tauri city-store, persistence, and E2E setup tests. Do not open/read v5 after this change.

- [ ] **Step 6: Run the schema gate and commit.**

```bash
cargo test -p caelum-core --test model_wire_format
cargo test -p caelum-core persistence
bun run test:unit
bun run check
cargo clippy -p caelum-core --all-targets -- -D warnings

rg -n 'caelum-city-saves-v5|cities-v5|SNAPSHOT_SCHEMA_VERSION: u16 = 5' crates src src-tauri tests
# Expected: no active implementation/test references; historical docs may remain intentionally.

git add crates/caelum-core/src/model.rs crates/caelum-core/src/persistence/trips.rs crates/caelum-core/tests src/domain/types.ts src/persistence/indexedDbCitySaveStore.ts src-tauri/src/city_store.rs tests
git commit -m "refactor(core): add schema v6 private car trip state"
```

---

### Task 2: Aggregate car flow, road access, congestion, and private-car candidate

**Files:**
- Create: `crates/caelum-core/src/traffic.rs`
- Create: `crates/caelum-core/tests/traffic.rs`
- Modify: `crates/caelum-core/src/lib.rs`
- Modify: `crates/caelum-core/src/stop_access.rs` only if visibility must widen from the current `pub(crate)` boundary; do not duplicate its logic.

**Interfaces:**
- Produces `traffic::private_car_candidate(state, routing, origin, destination) -> Option<PrivateCarCandidate>`.
- Produces `traffic::road_flow_at(state, point) -> u16`.
- Produces `traffic::congestion_multiplier(flow) -> f64`.
- Produces `traffic::effective_road_step_seconds(state, step) -> f64` and `effective_road_path_seconds(state, path) -> f64`.
- Later trip and bus tasks consume these functions; they must not reimplement congestion arithmetic.

- [ ] **Step 1: Write failing focused traffic tests.**

Create `crates/caelum-core/tests/traffic.rs` with helpers that build a small zoned house/workplace pair plus a straight road.

Cover:

```rust
assert_eq!(congestion_multiplier(0), 1.0);
assert_eq!(congestion_multiplier(4), 1.0);
assert_eq!(congestion_multiplier(6), 1.5);
assert_eq!(congestion_multiplier(12), 3.0);
assert_eq!(congestion_multiplier(u16::MAX), 3.0);
```

Add tests proving:

- no candidate if home has no adjacent usable road;
- no candidate if workplace has no adjacent usable road;
- no candidate if two access roads are disconnected;
- one-way legality is inherited from `RoadTopology`;
- one active driving path contributes one unit to each unique step position;
- the same point repeated in one captured path contributes only one unit;
- candidate estimation adds the candidate itself before calculating ETA.

- [ ] **Step 2: Add the fixed-capacity helpers.**

Start `traffic.rs` with:

```rust
use std::collections::{BTreeMap, BTreeSet};

pub const ROAD_FLOW_CAPACITY: u16 = 4;
pub const MAX_CONGESTION_MULTIPLIER: f64 = 3.0;

pub fn congestion_multiplier(flow: u16) -> f64 {
    (f64::from(flow) / f64::from(ROAD_FLOW_CAPACITY))
        .clamp(1.0, MAX_CONGESTION_MULTIPLIER)
}
```

Use `BTreeSet<Point>` for unique road points and `BTreeMap<Point, u16>` for deterministic aggregate counts. Saturate the count at `u16::MAX`; do not panic on a pathological test fixture.

- [ ] **Step 3: Derive aggregate flow only from active driving trips.**

Implement:

```rust
pub fn active_car_flow(state: &GameSnapshot) -> BTreeMap<Point, u16>;
pub fn road_flow_at(state: &GameSnapshot, point: Point) -> u16;
```

Rules:

```text
status must be Driving
private_car_trip must be Some
path must be TransitPath::Road
one trip increments each unique RoadPathStep.position once
all other trips contribute zero
```

No top-level `TrafficState` is added to `GameSnapshot`.

- [ ] **Step 4: Reuse building footprint road access and compiled topology.**

Add:

```rust
fn building_access_for_point(state: &GameSnapshot, point: Point) -> Option<StopRoadAccess> {
    let building = state.buildings.iter()
        .find(|building| building.occupied_tiles.contains(&point))?;
    crate::stop_access::derive_stop_access_for_footprint(
        &state.map,
        &building.occupied_tiles,
    )
}
```

Define:

```rust
pub struct PrivateCarCandidate {
    pub path: TransitPath,
    pub estimated_seconds: f64,
}

pub fn private_car_candidate(
    state: &GameSnapshot,
    routing: crate::engine::RoutingContext<'_>,
    origin: Point,
    destination: Point,
) -> Option<PrivateCarCandidate>;
```

Resolve both endpoint accesses, then call exactly the existing:

```rust
routing.road_topology.find_path_between_access_tiles(
    &state.map,
    from.road_point,
    to.road_point,
    from.preferred_heading,
    to.preferred_heading,
)
```

Require a non-empty `TransitPath::Road`. Do not compile topology inside `traffic.rs`.

- [ ] **Step 5: Estimate the candidate with current flow + itself.**

Implement a helper that takes a flow map and candidate road path. For every road step:

```rust
let candidate_flow = current_flow_at_step.saturating_add(1);
let seconds = step.travel_seconds * congestion_multiplier(candidate_flow);
```

Only add the candidate once per unique point for flow lookup. Sum the effective seconds for the full candidate and store the result in `PrivateCarCandidate.estimated_seconds`.

Expose normal runtime helpers:

```rust
pub fn effective_road_step_seconds(state: &GameSnapshot, step: &RoadPathStep) -> f64 {
    step.travel_seconds * congestion_multiplier(road_flow_at(state, step.position))
}

pub fn effective_road_path_seconds(state: &GameSnapshot, path: &TransitPath) -> f64;
```

For a non-road path, `effective_road_path_seconds` returns its existing `total_travel_seconds()` so callers can stay simple, but congestion is applied only to road steps.

- [ ] **Step 6: Verify and commit.**

```bash
cargo test -p caelum-core --test traffic
cargo test -p caelum-core --test road_topology --test router_planning
cargo clippy -p caelum-core --all-targets -- -D warnings

git add crates/caelum-core/src/traffic.rs crates/caelum-core/src/lib.rs crates/caelum-core/tests/traffic.rs
git commit -m "feat(core): add aggregate private car congestion"
```

---

### Task 3: Deterministic commute mode choice + car arrival boundaries

**Files:**
- Modify: `crates/caelum-core/src/engine.rs`
- Modify: `crates/caelum-core/src/trips.rs`
- Modify: `crates/caelum-core/tests/traffic.rs`
- Modify: direct `tick_trips` test callsites in `crates/caelum-core/src/growth.rs` and `crates/caelum-core/tests/` as required by the signature inventory.

**Interfaces:**
- `tick_trips` / `tick_trips_with_objectives` receive the existing `RoutingContext` so car path creation never recompiles topology.
- Driving trips reach the existing completion/metrics pipeline at `PrivateCarTrip.arrival_time`.
- Walk/transit winning the comparison preserves the current Idle/no-plan spawn behavior.

- [ ] **Step 1: Inventory direct trip-tick callers.**

```bash
rg -n 'tick_trips(_with_objectives)?\(' crates/caelum-core
```

Update production and tests explicitly; do not keep an overload that recompiles topology behind the caller's back.

- [ ] **Step 2: Add failing mode-choice tests.**

In `tests/traffic.rs`, build deterministic fixtures and assert:

```text
car absent + transit present                 -> spawned trip stays existing Idle path
car ETA < walk/transit ETA                   -> status Driving + privateCarTrip Some
car ETA == walk/transit ETA                  -> keep existing walk/transit path
earlier same-time car raises later flow      -> later candidate sees higher ETA
coarse tick and equivalent fine ticks        -> same chosen modes and active flow
```

Use stable sim IDs/order; do not randomize or sort by a new key.

- [ ] **Step 3: Thread `RoutingContext` into the trip scheduler.**

Change the APIs to the explicit shape:

```rust
pub fn tick_trips(
    state: &GameSnapshot,
    routing: RoutingContext<'_>,
    delta_seconds: f64,
) -> GameSnapshot;

pub fn tick_trips_with_objectives(
    state: &GameSnapshot,
    routing: RoutingContext<'_>,
    delta_seconds: f64,
) -> GameSnapshot;
```

`GameEngine::tick` calls:

```rust
let next = trips::tick_trips_with_objectives(
    &self.snapshot,
    self.routing_context(),
    delta_seconds,
);
```

Thread the same context through `tick_trips_substepped` to `spawn_due_commute_trips`. Test helpers compile one `RoadTopology` from their fixture map and pass `RoutingContext { road_topology: &topology }`.

- [ ] **Step 4: Choose car at spawn without rewriting the transit lifecycle.**

When a worker trip is due, create the current base `ActiveTrip` with `private_car_trip: None`. Before pushing it, compare:

```rust
let transit = router::find_route_plan(state, &origin, &destination);
let car = traffic::private_car_candidate(state, routing, origin, destination);
let choose_car = match (&transit, &car) {
    (None, Some(_)) => true,
    (Some(transit), Some(car)) => car.estimated_seconds < transit.estimated_seconds,
    _ => false,
};
```

If `choose_car`:

```rust
trip.status = TripStatus::Driving;
trip.private_car_trip = Some(PrivateCarTrip {
    path: car.path,
    arrival_time: state.time + car.estimated_seconds,
});
```

Otherwise leave `status == Idle`, `route_plan == None`, `private_car_trip == None` and preserve the existing `tick_trip` planning path.

Process the existing cloned sims in current order and push each chosen trip immediately so the next simultaneous worker sees its flow.

- [ ] **Step 5: Make car arrival a scheduler boundary.**

In `next_boundary_after`, add:

```rust
for trip in &state.active_trips {
    if trip.status == TripStatus::Driving {
        if let Some(car) = &trip.private_car_trip {
            track_next_boundary(&mut next, car.arrival_time, state.time);
        }
    }
}
```

Do not add this to the substep-cap formula separately: each active trip can contribute at most one future car-arrival boundary and the existing per-second safety net already exceeds that density. Add a targeted regression if the debug cap proves otherwise rather than pre-allocating another broad bound.

- [ ] **Step 6: Resolve `Driving` before transit route-plan logic.**

At the top of `tick_trip`, after terminal-status handling and before the existing `Riding` branch:

```rust
if trip.status == TripStatus::Driving {
    let car = trip.private_car_trip.as_ref()
        .expect("validated driving trip carries private car state");
    if state.time + EPSILON < car.arrival_time {
        return unchanged(trip);
    }

    let mut arrived = trip.clone();
    arrived.position = trip.destination.into();
    arrived.private_car_trip = None;
    // Reuse the existing trip completion helper/metric construction that
    // resolves arrived vs late from trip.deadline and updates commute flags.
    return completed_trip_result(state, arrived, tick_start_time);
}
```

If the existing completion logic is currently inline rather than named `completed_trip_result`, extract **only** the shared terminal-result block to a small private helper and call it from both the existing final-leg path and Driving. Do not introduce a trip-state class or generic state machine.

- [ ] **Step 7: Verify arrival timing and coarse/fine determinism.**

Add tests that start one car with a known `arrival_time` and assert:

```text
tick ending before arrival   -> still Driving, flow remains
tick ending at arrival       -> Arrived/Late, privateCarTrip cleared, flow removed
one coarse tick past arrival -> identical sim flags/metrics to fine ticks split at arrival
```

Then run:

```bash
cargo test -p caelum-core --test traffic --test trip_lifecycle --test golden_sequences
cargo test -p caelum-core growth::tests
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings

git add crates/caelum-core/src/engine.rs crates/caelum-core/src/trips.rs crates/caelum-core/src/growth.rs crates/caelum-core/tests
git commit -m "feat(core): add deterministic private car commute trips"
```

---

### Task 4: Apply the same congestion cost to bus estimates and movement

**Files:**
- Modify: `crates/caelum-core/src/router.rs`
- Modify: `crates/caelum-core/src/transit.rs`
- Modify: `crates/caelum-core/tests/traffic.rs`
- Modify: existing router/transit timing tests as needed.

**Interfaces:**
- Bus route-plan `estimated_seconds` uses current active-car congestion.
- Bus movement step duration and `seconds_until_next_vehicle_stop` use `traffic::effective_road_step_seconds` from Task 2.
- Stored `RouteLegPath.current_path` remains free-flow structural path data.

- [ ] **Step 1: Add the failing shared-delay tests before touching transit.**

Construct a bus route whose current road step has free-flow `travel_seconds = 1.25` and active car flow `6` on that point. Assert:

```rust
assert_eq!(traffic::congestion_multiplier(6), 1.5);
assert_eq!(effective_bus_step_seconds, 1.875);
assert_eq!(seconds_until_next_vehicle_stop(...), expected_delayed_remaining);
```

Advance exactly `1.25` seconds and prove the bus has **not** completed the loaded step; advance the remaining `0.625` seconds and prove it does.

Add a matched metro fixture proving its step time is unchanged with the same active car trips in the snapshot.

- [ ] **Step 2: Make route-plan bus estimates dynamic without mutating paths.**

Change the private router helpers to receive `&GameSnapshot`:

```rust
fn ride_seconds(
    state: &GameSnapshot,
    mode: TransitMode,
    legs: &[RouteLegPath],
    edge: &RideEdge,
) -> f64;

fn leg_travel_seconds(
    state: &GameSnapshot,
    mode: TransitMode,
    leg: &RouteLegPath,
) -> f64;
```

For Bus + `current_path: Some(path)`, return:

```rust
traffic::effective_road_path_seconds(state, path)
```

For Metro, preserve `path.total_travel_seconds()`. Preserve existing fallback `estimated_seconds` and tiles-per-second behavior for missing paths.

Update both one-service and transfer candidate calculations in `find_route_plan` to pass `state`.

- [ ] **Step 3: Route bus step advancement through the same helper.**

Where the bus vehicle loop currently reads:

```rust
let step_seconds = step.travel_seconds();
```

use mode-aware timing:

```rust
let step_seconds = if vehicle.mode == TransitMode::Bus {
    match step {
        PathStepRef::Road(road_step) => traffic::effective_road_step_seconds(state, road_step),
        _ => step.travel_seconds(),
    }
} else {
    step.travel_seconds()
};
```

Use the actual existing path-step reference/enum names in `transit.rs`; do not create `PathStepRef` if the file already exposes a different borrowed-step abstraction. The invariant is that only Bus + Road uses the traffic helper.

- [ ] **Step 4: Apply identical timing in `seconds_until_next_vehicle_stop`.**

Replace every sum of remaining/current/later bus road-step `travel_seconds()` with the same mode-aware helper used in Step 3. Current-step remaining time remains:

```text
(1 - step_progress) * effective step seconds
```

Later road steps use full effective seconds. Metro remains static.

This step and Step 3 must land in the same commit; never leave movement and scheduler boundaries on different clocks.

- [ ] **Step 5: Re-run route-choice tests after bus estimates become congested.**

Add/adjust one case where active road load makes a previously faster bus candidate slower than the private car or walk candidate, and assert the deterministic comparison uses the current congested bus estimate.

Do not add traffic-aware route path rebuilding: only travel-time ranking changes.

- [ ] **Step 6: Verify and commit.**

```bash
cargo test -p caelum-core --test traffic --test router_planning --test transit_router --test trip_lifecycle --test shuttle_service
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings

git add crates/caelum-core/src/router.rs crates/caelum-core/src/transit.rs crates/caelum-core/tests
git commit -m "feat(core): apply car congestion to bus travel time"
```

---

### Task 5: Traffic overlay + no individual car rendering + real sandbox smoke

**Files:**
- Create: `src/domain/traffic.ts`
- Create: `tests/domain/traffic.test.ts`
- Modify: `src/domain/types.ts`
- Modify: `src/components/hud/panels/DataPanel.svelte`
- Modify: `src/render/overlayRenderer.ts`
- Modify: `src/render/citizenRenderer.ts`
- Modify: `src/render/colors.ts`
- Modify: `tests/render/overlayRenderer.test.ts`
- Modify: `tests/render/citizenRenderer.test.ts`
- Modify: `tests/e2e/smoke.spec.ts`
- Modify: `docs/architecture.md`

**Interfaces:**
- `selectTrafficFlow(state) -> Array<{ point: Point; flow: number }>` is the only TS aggregation seam.
- `Overlay` gains exactly `"traffic"`.
- The canvas renders aggregate road load; it never renders a car entity.

- [ ] **Step 1: Write the failing TS traffic selector tests.**

Create `tests/domain/traffic.test.ts` with a fixture containing:

```ts
activeTrips: [
  {
    ...baseTrip,
    status: "driving",
    privateCarTrip: {
      arrivalTime: 100,
      path: {
        kind: "road",
        totalTravelSeconds: 2.5,
        steps: [roadStepAt(1, 0), roadStepAt(2, 0), roadStepAt(2, 0)],
      },
    },
  },
  { ...baseTransitTrip, status: "waiting", privateCarTrip: null },
]
```

Assert the selector returns flow `1` for `(1,0)` and `(2,0)`, not `2` for the repeated point, and ignores the waiting trip.

Add a second driving trip sharing `(2,0)` and assert that point becomes flow `2`.

- [ ] **Step 2: Implement the presentation selector.**

In `src/domain/traffic.ts`:

```ts
export const ROAD_FLOW_CAPACITY = 4;

export interface TrafficFlowPoint {
  point: Point;
  flow: number;
}

export function selectTrafficFlow(state: GameState): TrafficFlowPoint[] {
  // aggregate Driving + road privateCarTrip steps by `${x},${y}`
  // unique each trip's road points before incrementing global flow
  // return deterministic y/x or x/y ordering matching existing renderer conventions
}
```

This is display derivation only. Do not duplicate the Rust delay multiplier or perform mode choice in TypeScript.

- [ ] **Step 3: Add the one overlay toggle and paint traffic intensity.**

Add `"traffic"` to `Overlay` and this Data-panel entry:

```ts
{ id: "traffic", label: "Traffic" }
```

Add one traffic fill color in `colors.ts`. In `overlayRenderer.ts`, when `activeOverlay === "traffic"`, iterate `selectTrafficFlow(state)` and compute alpha/intensity from:

```ts
Math.min(flow / ROAD_FLOW_CAPACITY, 1)
```

Use the existing tile fill primitive. Do not add text, legend, hover behavior, or multiple traffic colors in this slice.

- [ ] **Step 4: Do not render driving trips as citizens.**

At the top of the `renderCitizens` entity loop:

```ts
if (entity.status === "arrived" || entity.status === "driving") {
  continue;
}
```

Add a render test proving a driving trip does not call `arc`/`fill` while existing walking/waiting/riding rendering stays unchanged.

- [ ] **Step 5: Extend the existing overlay renderer test with one real driving fixture.**

Use the shared fixture with `privateCarTrip.path.kind === "road"`, set `ui.activeOverlay = "traffic"`, render, and assert fills occur only at the aggregated road step points. Keep exact color/alpha assertions local to this renderer test; do not add screenshot snapshots.

- [ ] **Step 6: Extend the existing E2E smoke instead of adding a traffic suite.**

Keep the current Small House + Supermarket occupancy journey. Make their road access connected by extending the existing two-way road stroke so one continuous road is adjacent to both building footprints. Update the road-cost assertion for the longer stroke.

Open the existing Data panel and assert the new `Traffic` button exists and toggles `aria-pressed=true`, then toggle it off/on once while the simulation can still Resume/Pause and the clock still advances.

Do **not** wait several real minutes for a specific worker departure solely to inspect canvas pixels. Exact car selection, congestion, and traffic rendering with a driving fixture are already owned by Rust/Vitest tests. Playwright proves the real shared UI exposes the overlay and that the road-connected sandbox journey remains wired.

- [ ] **Step 7: Update architecture docs with only the new boundary.**

Add a short Phase 3 note to `docs/architecture.md`:

```text
Private cars are active commute-trip payloads, not vehicle entities.
Road congestion is derived from active private-car paths in `traffic.rs`.
Bus runtime travel time reads the same congestion helper; stored route paths remain structural/free-flow.
TypeScript derives only the Traffic overlay from the snapshot.
```

Do not add a future traffic architecture section.

- [ ] **Step 8: Run the full gate and commit.**

```bash
bun run test:unit
bun run check
bun run test:e2e -- tests/e2e/smoke.spec.ts
bun run format:check
bun run lint
cargo test --workspace
bun run build

git add src/domain src/components/hud/panels/DataPanel.svelte src/render tests docs/architecture.md
git commit -m "feat(ui): add aggregate traffic overlay"
```

---

## Final verification checklist

- [ ] `SNAPSHOT_SCHEMA_VERSION == 6` in Rust and TS; browser/native stores use only v6 namespaces.
- [ ] `TransitMode` is still only Walk/Bus/Metro.
- [ ] `TripStatus::Driving` always means `private_car_trip: Some`, no route plan, no transit vehicle membership.
- [ ] No `TrafficState`/road-load matrix is persisted on `GameSnapshot`.
- [ ] Car access uses placed-building footprints + existing `derive_stop_access_for_footprint`.
- [ ] Car pathfinding uses the engine's existing compiled `RoadTopology`.
- [ ] Flow counts one active car once per unique `RoadPathStep.position`.
- [ ] `ROAD_FLOW_CAPACITY == 4`; free-flow through capacity; flow 6 = 1.5x; high flow capped at 3x.
- [ ] New-car ETA includes the candidate itself.
- [ ] Exact time ties keep current walk/transit behavior.
- [ ] Same-time workers remain deterministic under stable sim order.
- [ ] Car arrival is a normal substep boundary and coarse/fine ticks agree.
- [ ] Car payload is cleared when the trip resolves.
- [ ] Bus step movement and `seconds_until_next_vehicle_stop` use the same congestion helper.
- [ ] Router bus ETA uses congestion; metro/walk remain unchanged.
- [ ] Stored route paths are not rewritten when congestion changes.
- [ ] Traffic overlay is the only new car visualization; driving trips are not drawn as citizens.
- [ ] No road classes, signals, parking, lane physics, random mode choice, traffic equilibrium, or compatibility layer was added.

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

If a final test exposes only an unrelated pre-existing failure, document it in the implementation PR with the exact command/output rather than broadening HPA-622 to fix unrelated work.
