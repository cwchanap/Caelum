# Phase 3 Aggregate Private-Car Congestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let current worker commutes choose an aggregate private-car road path, derive deterministic road congestion from active car trips, apply the same road delay to buses, and expose one Traffic overlay.

**Architecture:** Reuse the compiled `RoadTopology`, existing `ActiveTrip` lifecycle, trip substep scheduler, precomputed transit paths, and current overlay UI. Add one functional `traffic.rs` module. A private car is an `ActiveTrip` payload with a captured `TransitPath::Road` and arrival timestamp; there are no car entities, lane positions, or traffic caches. Bus movement and its next-stop boundary estimator use the same congestion-adjusted step helper.

**Tech Stack:** Rust `caelum-core`, Serde, TypeScript, Svelte 5, Vitest, Playwright, Bun, Tauri.

## Global constraints

- Implement only HPA-622, the first child of HPA-333.
- `ROAD_FLOW_CAPACITY = 4` and `MAX_CONGESTION_MULTIPLIER = 3.0`.
- `congestion_multiplier(flow) = (flow / 4).clamp(1.0, 3.0)`; flow `0..=4` is free-flow.
- Derive road flow from active `Driving` trips; do not persist a traffic/load cache.
- Count one driving trip once per unique `RoadPathStep.position`.
- Reuse `derive_stop_access_for_footprint` and `RoadTopology::find_path_between_access_tiles`.
- Private car wins only when strictly faster than the existing walk/transit plan; exact ties keep walk/transit.
- Keep `TransitMode = Walk | Bus | Metro`; do not add `Car`.
- Cars store only path + arrival timestamp; no car entity, path cursor, intermediate position, parking, or rendering.
- Bus movement and `seconds_until_next_vehicle_stop` must use the same effective road-step duration.
- Metro/walking timing stays unchanged.
- Schema v6 is a direct disposable-save break; no migration, compatibility defaults, or fallback namespace.
- Add one Traffic overlay only.
- Production paths added by this work remain panic-free; `expect` is permitted only in test fixture setup.

## File map

**Create**
- `crates/caelum-core/src/traffic.rs`
- `crates/caelum-core/tests/traffic.rs`
- `src/domain/traffic.ts`
- `tests/domain/traffic.test.ts`

**Modify**
- Core: `crates/caelum-core/src/model.rs`, `lib.rs`, `engine.rs`, `trips.rs`, `router.rs`, `transit.rs`
- Persistence: `crates/caelum-core/src/persistence/error.rs`, `persistence/trips.rs`, current persistence/wire tests
- Saves: `src/persistence/indexedDbCitySaveStore.ts`, `src-tauri/src/city_store.rs`, current adapter tests
- Frontend: `src/domain/types.ts`, `src/components/hud/panels/DataPanel.svelte`, `src/render/overlayRenderer.ts`, `citizenRenderer.ts`, `colors.ts`
- Fixtures/tests: existing `tests/helpers`, `tests/fixtures`, runtime/render/save tests, `tests/e2e/smoke.spec.ts`
- Docs: `docs/architecture.md`

---

### Task 1: Schema v6, driving-trip invariants, and reset hygiene

**Produces:** the minimal wire representation used by every later task.

- [ ] **Step 1: Inventory all v5 and trip literals/reset sites.**

```bash
rg -n 'SNAPSHOT_SCHEMA_VERSION|schemaVersion[^\n]*5|caelum-city-saves-v5|DATABASE_VERSION = 5|cities-v5' crates src src-tauri tests docs
rg -n 'ActiveTrip \{' crates/caelum-core
rg -n 'activeTrips:|routePlan:|patienceRemaining:' src tests
rg -n 'status = TripStatus::Idle|route_plan = None' crates/caelum-core/src
```

Every active-trip literal becomes explicit about the new car field. Every production reset that can receive `Driving` must clear it.

- [ ] **Step 2: Add failing model/wire tests for one concrete driving trip.**

Use this road path in the fixture:

```rust
let road_path = TransitPath::Road {
    steps: vec![RoadPathStep {
        position: Point { x: 2, y: 1 },
        entering_heading: Heading::East,
        leaving_heading: Heading::East,
        movement: MovementKind::Straight,
        geometry: PathGeometry::Line {
            from: TripPosition { x: 2.0, y: 1.0 },
            to: TripPosition { x: 3.0, y: 1.0 },
        },
        travel_seconds: 1.25,
    }],
    total_travel_seconds: 1.25,
};
```

Build a trip with `status: Driving`, `route_plan: None`, `current_leg_index: 0`, and:

```rust
private_car_trip: Some(PrivateCarTrip {
    path: road_path,
    arrival_time: 101.25,
}),
```

Assert JSON contains `status: "driving"`, a `privateCarTrip.path.kind` of `"road"`, and `arrivalTime: 101.25`.

- [ ] **Step 3: Add only representative invalid persistence cases.**

```text
Driving + privateCarTrip null            -> reject
Driving + routePlan Some                 -> reject
non-Driving + privateCarTrip Some        -> reject
Driving listed in a transit vehicle      -> reject
Driving + Track privateCarTrip path      -> reject
negative/non-finite arrivalTime          -> reject
```

Do not add a combinatorial hostile-save matrix.

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

Add `Driving` to `TripStatus` and add the required field to `ActiveTrip`:

```rust
pub private_car_trip: Option<PrivateCarTrip>,
```

Do not add `serde(default)`.

Mirror in TypeScript:

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
  // existing fields stay required
  privateCarTrip: PrivateCarTrip | null;
}
```

Update every existing literal with `private_car_trip: None` / `privateCarTrip: null`.

- [ ] **Step 5: Add explicit persistence validation.**

Add `TripPrivateCar` and `TripPrivateCarArrivalTime` to `SnapshotField`.

In `validate_trips`, validate Driving before normal route-plan validation:

```rust
if trip.status == TripStatus::Driving {
    let Some(car) = trip.private_car_trip.as_ref() else {
        return Err(trip_state_error(SnapshotField::TripPrivateCar, entity.clone()));
    };
    if trip.route_plan.is_some() || trip.current_leg_index != 0 {
        return Err(trip_state_error(SnapshotField::TripRoutePlan, entity.clone()));
    }
    validate_private_car_trip(snapshot, car, entity.clone())?;
} else {
    if trip.private_car_trip.is_some() {
        return Err(trip_state_error(SnapshotField::TripPrivateCar, entity.clone()));
    }
    validate_route_plan(snapshot, trip, entity.clone())?;
}
```

Implement:

```rust
fn validate_private_car_trip(
    snapshot: &GameSnapshot,
    car: &PrivateCarTrip,
    entity: EntityRef,
) -> PersistenceResult<()> {
    super::finite_non_negative(
        Some(entity.clone()),
        SnapshotField::TripPrivateCarArrivalTime,
        car.arrival_time,
    )?;

    let TransitPath::Road { steps, .. } = &car.path else {
        return Err(trip_state_error(SnapshotField::TripPrivateCar, entity));
    };
    if steps.is_empty() {
        return Err(trip_state_error(SnapshotField::TripPrivateCar, entity));
    }
    for step in steps {
        validate_point(snapshot, &entity, SnapshotField::TripPrivateCar, step.position)?;
    }
    Ok(())
}
```

Keep vehicle membership: Riding requires exactly one membership; every other status requires zero.

- [ ] **Step 6: Clear car state in destination retarget/reset.**

In `cleanup_removed_destination_references`, change the existing reset block to:

```rust
trip.status = TripStatus::Idle;
trip.route_plan = None;
trip.private_car_trip = None;
trip.current_leg_index = 0;
trip.destination = replacement;
trip.deadline = trip_deadline_seconds(state.time);
trip.patience_remaining = WAIT_PATIENCE_SECONDS;
```

Add a regression where a Driving outbound is affected by workplace demolition: the existing no-replacement path removes it, or the retarget path leaves it Idle with no car payload.

Review the reset inventory. Do not add car handling to line-invalidation code that first requires a route plan referencing that line; Driving has no route plan and cannot enter that path.

- [ ] **Step 7: Move save namespaces directly to v6.**

Browser:

```ts
const DEFAULT_DATABASE_NAME = "caelum-city-saves-v6";
const DATABASE_VERSION = 6;
```

Native directory: `cities-v6`.

Update current adapter/schema fixtures. Do not read v5 as fallback.

- [ ] **Step 8: Verify Task 1 and commit.**

```bash
cargo test -p caelum-core --test model_wire_format
cargo test -p caelum-core persistence
cargo test -p caelum-core --test transit_build --test trip_lifecycle
bun run test:unit
bun run check
cargo clippy -p caelum-core --all-targets -- -D warnings

rg -n 'caelum-city-saves-v5|cities-v5|SNAPSHOT_SCHEMA_VERSION: u16 = 5' crates src src-tauri tests

git add crates/caelum-core src src-tauri tests
git commit -m "refactor(core): add schema v6 private car trip state"
```

---

### Task 2: Traffic core—access, car path, derived flow, congestion math

**Produces:** the only traffic-domain module used by trip, router, transit, and tests.

- [ ] **Step 1: Write failing congestion and flow tests.**

```rust
assert_eq!(congestion_multiplier(0), 1.0);
assert_eq!(congestion_multiplier(4), 1.0);
assert_eq!(congestion_multiplier(6), 1.5);
assert_eq!(congestion_multiplier(12), 3.0);
assert_eq!(congestion_multiplier(u16::MAX), 3.0);
```

Add fixtures proving one Driving trip counts once per unique road point, duplicate step positions inside one car still count once, non-Driving trips count zero, and two cars sharing a point produce flow two.

- [ ] **Step 2: Implement aggregate flow without snapshot cache state.**

Create `traffic.rs`:

```rust
use std::collections::{BTreeMap, BTreeSet};

use crate::model::{
    GameSnapshot, Point, RoadPathStep, StopRoadAccess, TransitPath, TripStatus,
};
use crate::road_topology::RoadTopology;

pub const ROAD_FLOW_CAPACITY: u16 = 4;
pub const MAX_CONGESTION_MULTIPLIER: f64 = 3.0;

pub fn congestion_multiplier(flow: u16) -> f64 {
    (f64::from(flow) / f64::from(ROAD_FLOW_CAPACITY))
        .clamp(1.0, MAX_CONGESTION_MULTIPLIER)
}

fn unique_road_points(path: &TransitPath) -> BTreeSet<Point> {
    path.road_steps().iter().map(|step| step.position).collect()
}
```

Implement `active_car_flow(state) -> BTreeMap<Point, u16>` by iterating only `status == Driving` + `private_car_trip: Some`, incrementing each unique point with `saturating_add(1)`.

- [ ] **Step 3: Add failing endpoint/path tests.**

Use existing area/building/road helpers to build Small House + Supermarket fixtures. Prove:

```text
home has no usable adjacent road          -> no candidate
workplace has no usable adjacent road     -> no candidate
disconnected access roads                 -> no candidate
connected two-way road                    -> Road candidate
one-way direction forbids the trip        -> no candidate
```

The expected legality comes from the same compiled `RoadTopology`; do not build a second BFS.

- [ ] **Step 4: Reuse building footprint access and the compiled topology.**

```rust
fn building_access_for_point(
    state: &GameSnapshot,
    point: Point,
) -> Option<StopRoadAccess> {
    let building = state
        .buildings
        .iter()
        .find(|building| building.occupied_tiles.contains(&point))?;
    crate::stop_access::derive_stop_access_for_footprint(
        &state.map,
        &building.occupied_tiles,
    )
}

#[derive(Clone, Debug, PartialEq)]
pub struct PrivateCarCandidate {
    pub path: TransitPath,
    pub estimated_seconds: f64,
}
```

Implement:

```rust
pub fn private_car_candidate(
    state: &GameSnapshot,
    road_topology: &RoadTopology,
    origin: Point,
    destination: Point,
) -> Option<PrivateCarCandidate>
```

using only `find_path_between_access_tiles`. Accept a non-empty `TransitPath::Road`; reject zero-step or Track results.

- [ ] **Step 5: Include the candidate itself in ETA.**

Start from `active_car_flow(state)`. For every candidate road step, calculate:

```rust
let flow_with_candidate = flow
    .get(&step.position)
    .copied()
    .unwrap_or(0)
    .saturating_add(1);
let seconds = step.travel_seconds * congestion_multiplier(flow_with_candidate);
```

Sum all step seconds. One car still adds only one *flow unit* per unique point; a path revisiting a point pays that same point's candidate-adjusted multiplier on each transition through it.

- [ ] **Step 6: Expose shared runtime timing helpers.**

```rust
pub fn road_flow_at(state: &GameSnapshot, point: Point) -> u16 {
    active_car_flow(state).get(&point).copied().unwrap_or(0)
}

pub fn effective_road_step_seconds(
    state: &GameSnapshot,
    step: &RoadPathStep,
) -> f64 {
    step.travel_seconds * congestion_multiplier(road_flow_at(state, step.position))
}

pub fn effective_road_path_seconds(
    state: &GameSnapshot,
    path: &TransitPath,
) -> f64 {
    match path {
        TransitPath::Road { steps, .. } => steps
            .iter()
            .map(|step| effective_road_step_seconds(state, step))
            .sum(),
        TransitPath::Track { total_travel_seconds, .. } => *total_travel_seconds,
    }
}
```

Do not optimize with a persisted or engine-owned flow cache unless profiling later proves this derivation is a bottleneck.

- [ ] **Step 7: Verify Task 2 and commit.**

```bash
cargo test -p caelum-core --test traffic
cargo test -p caelum-core --test road_topology --test router_planning
cargo clippy -p caelum-core --all-targets -- -D warnings

git add crates/caelum-core/src/traffic.rs crates/caelum-core/src/lib.rs crates/caelum-core/tests/traffic.rs
git commit -m "feat(core): add aggregate private car congestion"
```

---

### Task 3: Deterministic mode choice and car-arrival boundary

**Produces:** end-to-end private-car commute lifecycle while reusing existing arrival metrics/sim flags.

- [ ] **Step 1: Inventory all direct trip-tick callsites.**

```bash
rg -n 'tick_trips(_with_objectives)?\(' crates/caelum-core
```

Every caller will pass the already-compiled topology. Do not add an overload that recompiles topology.

- [ ] **Step 2: Add failing mode-choice tests.**

Prove:

```text
car unavailable + walk/transit available  -> current non-car lifecycle
car ETA strictly smaller                  -> Driving + car payload
car ETA exactly equal                     -> walk/transit
same-time worker #2                       -> sees worker #1 car flow if #1 chose car
coarse vs fine ticks                       -> identical chosen modes/flow
```

Use existing stable sim order; no randomization or new mode preference field.

- [ ] **Step 3: Thread `&RoadTopology` through trip ticking.**

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

Thread it through `tick_trips_substepped` and `spawn_due_commute_trips`.

`GameEngine::tick`:

```rust
let next = trips::tick_trips_with_objectives(
    &self.snapshot,
    &self.road_topology,
    delta_seconds,
);
```

Test fixtures may use:

```rust
let topology = RoadTopology::compile(&state.map).expect("fixture topology compiles");
let next = trips::tick_trips(&state, &topology, 1.0);
```

- [ ] **Step 4: Initialize the new base-trip field.**

`build_trip` adds only:

```rust
private_car_trip: None,
```

- [ ] **Step 5: Choose car at the existing due-departure seam without production `expect`.**

Before pushing each outbound/return trip:

```rust
let transit_plan = router::find_route_plan(state, &origin, &destination);
let car = traffic::private_car_candidate(
    state,
    road_topology,
    origin,
    destination,
);

let chosen_car = car.filter(|car| {
    transit_plan
        .as_ref()
        .map_or(true, |transit| car.estimated_seconds < transit.estimated_seconds)
});

if let Some(car) = chosen_car {
    trip.status = TripStatus::Driving;
    trip.private_car_trip = Some(PrivateCarTrip {
        path: car.path,
        arrival_time: state.time + car.estimated_seconds,
    });
}
```

Exact equality fails the `<` test and therefore keeps walk/transit. If car does not win, leave the existing `Idle`/no-plan trip unchanged and let `tick_trip` use the current planner.

Push each trip immediately in the existing sim iteration order so later same-time candidates see earlier active cars.

- [ ] **Step 6: Track Driving before route-plan boundary logic.**

At the top of `track_active_trip_boundary` after terminal handling:

```rust
if trip.status == TripStatus::Driving {
    if let Some(car) = &trip.private_car_trip {
        track_next_boundary(next, car.arrival_time, state.time);
    }
    return;
}
```

Do not allow Driving to enter the existing `route_plan.is_none()` boundary planner.

- [ ] **Step 7: Resolve Driving with existing `score_arrival`, panic-free.**

At the top of `tick_trip` before Riding/planning:

```rust
if trip.status == TripStatus::Driving {
    let Some(car) = &trip.private_car_trip else {
        return TripTickResult {
            trip: mark_unserved(trip.clone()),
            completed_trips: 0,
            late_trips: 0,
            unserved_trips: 1,
            wait_seconds: 0.0,
            outcome: Some(trip_outcome(
                TripOutcomeKind::Unserved,
                0.0,
                state.time,
            )),
        };
    };

    if state.time + EPSILON < car.arrival_time {
        return unchanged(trip);
    }

    let mut arrived = trip.clone();
    arrived.position = arrived.destination.into();
    arrived.private_car_trip = None;
    return score_arrival(arrived, state.time);
}
```

Do not create another completion pipeline. `score_arrival` already produces normal arrived/late metrics, and `advance_active_trips_with_zero_delta_ids` already applies sim resolution/arrival and removes terminal trips.

- [ ] **Step 8: Add arrival/coarse-fine tests.**

```text
before arrival boundary -> Driving, payload/flow retained
at arrival boundary     -> terminal, payload cleared, flow removed
coarse past arrival     -> same sim flags + metrics as ticks split at arrival
```

Keep `max_tick_substeps` unchanged unless this focused test demonstrates cap exhaustion; one car adds at most one future arrival boundary and the current per-second safety net is already denser.

- [ ] **Step 9: Verify Task 3 and commit.**

```bash
cargo test -p caelum-core --test traffic --test trip_lifecycle --test golden_sequences
cargo test -p caelum-core growth::tests
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings

git add crates/caelum-core/src/engine.rs crates/caelum-core/src/trips.rs crates/caelum-core/src/growth.rs crates/caelum-core/tests
git commit -m "feat(core): add deterministic private car commute trips"
```

---

### Task 4: Apply the same congestion clock to bus ETA and movement

**Produces:** one road delay used consistently by mode choice, bus movement, and scheduler boundaries.

- [ ] **Step 1: Add failing bus/metro timing tests.**

Use a bus road step at `(2,1)` with `travel_seconds: 1.25` and six active cars on that point. Assert effective time is `1.875`.

For a bus at step progress zero:

```text
seconds_until_next_vehicle_stop == 1.875
advance 1.25 seconds             -> step not complete
advance another 0.625 seconds    -> step completes
```

Use an equivalent metro Track step and assert its duration is unchanged by car flow.

- [ ] **Step 2: Make bus route-plan ETA congestion-aware.**

Change router helpers to take `&GameSnapshot`:

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

Use:

```rust
match (mode, leg.current_path.as_ref()) {
    (TransitMode::Bus, Some(path)) => traffic::effective_road_path_seconds(state, path),
    (_, Some(path)) => path.total_travel_seconds(),
    (_, None) => leg.estimated_seconds.unwrap_or_else(|| {
        1.0 / if mode == TransitMode::Bus {
            BUS_TILES_PER_SECOND
        } else {
            METRO_TILES_PER_SECOND
        }
    }),
}
```

Pass `state` through one-service and transfer candidate calculations. Do not rebuild route paths because of congestion.

- [ ] **Step 3: Reuse the existing `TransitPathStepRef` for vehicle timing.**

In `transit.rs`:

```rust
fn vehicle_step_seconds(
    state: &GameSnapshot,
    mode: TransitMode,
    step: TransitPathStepRef<'_>,
) -> f64 {
    match (mode, step) {
        (TransitMode::Bus, TransitPathStepRef::Road(step)) => {
            crate::traffic::effective_road_step_seconds(state, step)
        }
        (_, step) => step.travel_seconds(),
    }
}
```

Do not introduce another borrowed path-step enum.

- [ ] **Step 4: Pass state into `advance_vehicle_by_seconds`.**

Change its signature to:

```rust
fn advance_vehicle_by_seconds<F>(
    state: &GameSnapshot,
    vehicle: &mut Vehicle,
    itinerary: &[RouteLegPath],
    mut remaining_seconds: f64,
    mut on_itinerary_leg_completed: F,
) -> bool
where
    F: FnMut(&mut Vehicle, usize) -> bool,
```

Pass `state` from `tick_vehicles` and replace:

```rust
let step_seconds = step.travel_seconds();
```

with:

```rust
let step_seconds = vehicle_step_seconds(state, vehicle.mode, step);
```

Keep existing zero-step safeguards and cursor behavior.

- [ ] **Step 5: Use the same helper in `seconds_until_next_vehicle_stop`.**

Current step:

```rust
let remaining_current = if let Some(current_step) = path.step(path_step_index) {
    (1.0 - step_progress).max(0.0)
        * vehicle_step_seconds(state, vehicle.mode, current_step)
} else {
    0.0
};
```

Later steps:

```rust
let remaining_later: f64 = (path_step_index + 1..path.step_count())
    .filter_map(|index| path.step(index))
    .map(|step| vehicle_step_seconds(state, vehicle.mode, step))
    .sum();
```

Movement and boundary estimation land in this same task/commit.

- [ ] **Step 6: Add one congested-bus mode-choice regression.**

Create a case where bus is faster at zero road load but slower after active-car flow increases its ETA. Assert `router::find_route_plan` exposes the congested bus time used by Task 3's strict comparison. Metro remains unchanged.

- [ ] **Step 7: Verify Task 4 and commit.**

```bash
cargo test -p caelum-core --test traffic --test router_planning --test transit_router --test trip_lifecycle --test shuttle_service
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings

git add crates/caelum-core/src/router.rs crates/caelum-core/src/transit.rs crates/caelum-core/tests
git commit -m "feat(core): apply car congestion to bus travel time"
```

---

### Task 5: Traffic overlay, no car sprites, and lean real-UI smoke

**Produces:** one useful player-facing view without turning E2E into a long simulation scenario.

- [ ] **Step 1: Add failing TypeScript traffic selector tests.**

Create `tests/domain/traffic.test.ts` with a Driving trip whose road steps visit `(1,0)`, `(2,0)`, `(2,0)`. Assert flow is 1 at each unique point. Add a second Driving trip sharing `(2,0)` and assert flow 2. Add a Waiting trip with `privateCarTrip: null` and assert it contributes zero.

Also change the current tile for `(2,0)` to `kind: "empty"` and assert that point is omitted from presentation flow.

- [ ] **Step 2: Implement presentation-only current-road flow selection.**

Create `src/domain/traffic.ts`:

```ts
import type { GameState, Point } from "./types";

export const ROAD_FLOW_CAPACITY = 4;

export interface TrafficFlowPoint {
  point: Point;
  flow: number;
}

export function selectTrafficFlow(state: GameState): TrafficFlowPoint[] {
  const currentRoads = new Set(
    state.map.tiles
      .filter((tile) => tile.kind === "road")
      .map((tile) => `${tile.x},${tile.y}`),
  );
  const flow = new Map<string, TrafficFlowPoint>();

  for (const trip of state.activeTrips ?? []) {
    if (trip.status !== "driving" || trip.privateCarTrip?.path.kind !== "road") {
      continue;
    }
    const unique = new Map<string, Point>();
    for (const step of trip.privateCarTrip.path.steps) {
      const key = `${step.position.x},${step.position.y}`;
      if (currentRoads.has(key)) unique.set(key, step.position);
    }
    for (const [key, point] of unique) {
      const existing = flow.get(key);
      flow.set(key, { point, flow: (existing?.flow ?? 0) + 1 });
    }
  }

  return [...flow.values()].sort(
    (a, b) => a.point.y - b.point.y || a.point.x - b.point.x,
  );
}
```

Do not implement congestion/mode choice in TypeScript.

- [ ] **Step 3: Add exactly one Traffic overlay control.**

Add `"traffic"` to `Overlay` and add:

```ts
{ id: "traffic", label: "Traffic" },
```

to `DataPanel.svelte`.

Add one color:

```ts
traffic: "rgba(224, 79, 57, 0.32)",
```

- [ ] **Step 4: Render selected traffic points and restore canvas alpha.**

In `overlayRenderer.ts`, use `selectTrafficFlow(state)` and:

```ts
ctx.save();
for (const { point, flow } of selectTrafficFlow(state)) {
  ctx.globalAlpha = Math.min(flow / ROAD_FLOW_CAPACITY, 1);
  ctx.fillStyle = colors.traffic;
  fillTile(ctx, point);
}
ctx.restore();
```

Add a renderer test proving a captured historical path point is not painted after its current map tile is no longer a road.

- [ ] **Step 5: Do not draw Driving as a citizen/car.**

In `citizenRenderer.ts`:

```ts
if (entity.status === "arrived" || entity.status === "driving") {
  continue;
}
```

Add a render test proving Driving produces no `arc`/`fill`, while existing Walking/Waiting/Riding behavior is unchanged.

- [ ] **Step 6: Extend existing E2E only for wiring.**

Keep the existing Small House + Supermarket + occupancy flow. Extend the current two-way road stroke so one connected road is adjacent to both building footprints; update expected budget by the actual additional authored road-tile count.

Then use the existing Data destination:

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

Retain Resume/Pause/population/clock assertions.

Do not wait for a specific commute departure or inspect traffic canvas pixels in Playwright. Rust tests own actual car choice/congestion; unit renderer tests own painting.

- [ ] **Step 7: Record the narrow architecture boundary.**

Add to `docs/architecture.md`:

```text
Private cars are active commute-trip payloads, not vehicle entities.
Aggregate road flow is derived from active private-car paths in traffic.rs.
Bus runtime road-step time reads the same congestion helper; stored route paths remain structural/free-flow.
TypeScript derives only the Traffic overlay from snapshot trip state.
```

Do not document unimplemented road classes, traffic managers, or service planning.

- [ ] **Step 8: Run the full implementation gate and commit.**

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

- [ ] Rust/TS schema is v6; browser/native stores use only v6 namespaces.
- [ ] `TransitMode` remains Walk/Bus/Metro.
- [ ] Driving requires car payload, no route plan, no transit passenger membership.
- [ ] Retarget/reset paths that can receive Driving clear the car payload.
- [ ] No traffic/load cache is persisted.
- [ ] Car access/pathfinding reuse existing footprint access and compiled `RoadTopology`.
- [ ] One car contributes one flow unit per unique road point.
- [ ] Capacity/multiplier constants and exact test values match the spec.
- [ ] Candidate ETA counts the departing car itself.
- [ ] Exact ETA ties keep walk/transit; simultaneous workers remain stable-order deterministic.
- [ ] Car arrival is a normal substep boundary and clears flow before terminal removal.
- [ ] Bus movement, bus next-stop boundary, and bus route-plan ETA use the shared congestion cost.
- [ ] Metro/walking timing is unchanged and stored route paths remain structural/free-flow.
- [ ] Traffic overlay paints only current road tiles and Driving trips are not rendered as individual entities.
- [ ] No road classes, signals, parking, lane physics, random mode choice, equilibrium solver, or compatibility layer was added.

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
