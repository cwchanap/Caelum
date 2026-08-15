# Phase 3 Aggregate Private-Car Congestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let existing worker commute trips choose an aggregate private-car road path, turn active car paths into deterministic road congestion shared with buses, and expose that load through one Traffic overlay.

**Architecture:** Reuse the current `RoadTopology`, trip substep scheduler, precomputed transit paths, and Svelte overlay pipeline. Add one `traffic.rs` module that derives flow from active driving-trip road paths and owns one fixed-capacity congestion function. Cars are `ActiveTrip` payloads with a captured road path and arrival timestamp—never separate vehicle entities or moving sprites. Bus runtime step timing and next-stop boundary timing call the same congestion helper.

**Tech Stack:** Rust `caelum-core`, Serde, TypeScript, Svelte 5, Vitest, Playwright, Bun, Tauri.

## Global constraints

- Scope is HPA-622, the first implementation child of HPA-333. Do not implement the rest of Phase 3.
- `ROAD_FLOW_CAPACITY = 4` for the existing single road class.
- `MAX_CONGESTION_MULTIPLIER = 3.0`.
- Multiplier is `(flow / 4).clamp(1.0, 3.0)`; flow `<= 4` remains free-flow.
- Flow is derived from active `Driving` trips; do not persist a road-load/traffic cache.
- One driving trip contributes at most one unit to each unique `RoadPathStep.position` in its captured path.
- Car pathfinding reuses `RoadTopology::find_path_between_access_tiles` and existing building-footprint road access.
- Car wins only when its congestion-adjusted ETA is strictly less than the existing walk/transit plan. Exact ties keep walk/transit.
- `TransitMode` stays `Walk | Bus | Metro`; do not add `Car` to transit route legs.
- A private-car trip stores only a road path and arrival timestamp; no car entity, lane position, path cursor, parking, collision, or rendering.
- Bus movement and `seconds_until_next_vehicle_stop` must use the same congestion-adjusted road-step duration.
- Metro and walking timing remain unchanged.
- Schema v6 is a direct development break with v6 browser/native namespaces; no migration or compatibility reader.
- The UI gains exactly one Traffic overlay; no legend, dashboard, history, or road classes.

## File map

**Create:**
- `crates/caelum-core/src/traffic.rs` — access/path candidate, flow aggregation, congestion math, effective road-step/path time.
- `crates/caelum-core/tests/traffic.rs` — focused traffic/mode-choice/arrival/bus-delay tests.
- `src/domain/traffic.ts` — presentation-only traffic-flow selector.
- `tests/domain/traffic.test.ts` — selector tests.

**Modify:**
- Core: `crates/caelum-core/src/model.rs`, `lib.rs`, `engine.rs`, `trips.rs`, `router.rs`, `transit.rs`.
- Persistence: `crates/caelum-core/src/persistence/error.rs`, `persistence/trips.rs`, existing persistence/wire tests.
- Saves: `src/persistence/indexedDbCitySaveStore.ts`, `src-tauri/src/city_store.rs`, existing adapter tests.
- Frontend: `src/domain/types.ts`, `src/render/overlayRenderer.ts`, `citizenRenderer.ts`, `colors.ts`, `src/components/hud/panels/DataPanel.svelte`.
- Fixtures/tests: `tests/helpers/gameState.ts`, `tests/fixtures/rustSnapshot.ts`, existing runtime/render/save tests, `tests/e2e/smoke.spec.ts`.
- Docs: `docs/architecture.md`.

---

### Task 1: Schema v6, private-car wire state, and reset hygiene

**Files:**
- Modify: `crates/caelum-core/src/model.rs`
- Modify: `crates/caelum-core/src/persistence/error.rs`
- Modify: `crates/caelum-core/src/persistence/trips.rs`
- Modify: `crates/caelum-core/src/transit.rs`
- Modify: `src/domain/types.ts`
- Modify: `src/persistence/indexedDbCitySaveStore.ts`
- Modify: `src-tauri/src/city_store.rs`
- Modify: existing Rust/TS snapshot, persistence, and save-adapter fixtures/tests found by Step 1.

**Interfaces:**
- Produces `TripStatus::Driving`.
- Produces `PrivateCarTrip { path: TransitPath, arrival_time: f64 }`.
- Produces required `ActiveTrip.private_car_trip: Option<PrivateCarTrip>` / TS `privateCarTrip: PrivateCarTrip | null`.
- All later tasks rely on the invariant: Driving iff the active trip carries private-car state; a trip reset to Idle carries none.

- [ ] **Step 1: Inventory the breaking surface before editing.**

Run:

```bash
rg -n 'SNAPSHOT_SCHEMA_VERSION|schemaVersion[^\n]*5|caelum-city-saves-v5|DATABASE_VERSION = 5|cities-v5' crates src src-tauri tests docs
rg -n 'ActiveTrip \{' crates/caelum-core
rg -n 'activeTrips:|routePlan:|patienceRemaining:' src tests
rg -n 'status = TripStatus::Idle|route_plan = None' crates/caelum-core/src
```

The last inventory is important: every production reset that can receive a Driving trip must clear `private_car_trip` in the same block.

- [ ] **Step 2: Add failing v6 wire tests with a concrete driving trip.**

Use a road step with real values rather than a placeholder:

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

let trip = ActiveTrip {
    id: "trip-day-1-trip-1".into(),
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
        path: road_path,
        arrival_time: 101.25,
    }),
};
```

Assert serialized JSON contains:

```text
status == "driving"
privateCarTrip.path.kind == "road"
privateCarTrip.arrivalTime == 101.25
```

- [ ] **Step 3: Add only representative persistence mismatch tests.**

Cover these six cases:

```text
Driving + privateCarTrip null                 -> reject
Driving + routePlan Some                      -> reject
non-Driving + privateCarTrip Some             -> reject
Driving trip listed in a transit vehicle      -> reject
Driving + Track privateCarTrip path           -> reject
non-finite/negative arrivalTime               -> reject
```

Do not build a combinatorial malformed-path matrix.

- [ ] **Step 4: Implement the v6 model directly.**

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

to `ActiveTrip` without `serde(default)`.

Mirror in `src/domain/types.ts`:

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
  // existing required fields
  privateCarTrip: PrivateCarTrip | null;
}
```

Update every existing Rust/TS active-trip literal from Step 1 with `private_car_trip: None` / `privateCarTrip: null`. Do not make the field optional to reduce fixture work.

- [ ] **Step 5: Add explicit persistence field names and validation.**

Add to `SnapshotField`:

```rust
TripPrivateCar,
TripPrivateCarArrivalTime,
```

In `validate_trips`, branch before normal route-plan validation:

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

Keep vehicle membership simple: Riding requires exactly one membership; all other statuses, including Driving, require zero.

- [ ] **Step 6: Clear captured car state in generic trip resets that can target a car.**

In `transit.rs::cleanup_removed_destination_references`, the retarget block becomes:

```rust
trip.status = TripStatus::Idle;
trip.route_plan = None;
trip.private_car_trip = None;
trip.current_leg_index = 0;
trip.destination = replacement;
trip.deadline = trip_deadline_seconds(state.time);
trip.patience_remaining = WAIT_PATIENCE_SECONDS;
```

Review the Step-1 reset inventory. Do **not** add car branches to route-line invalidation that first requires `route_plan` to reference the line; Driving trips have no route plan and cannot enter that path.

Add one regression: an active driving outbound whose workplace is demolished/reassigned is either removed by the existing no-replacement path or becomes Idle with `private_car_trip == None` when retargeted.

- [ ] **Step 7: Move save namespaces directly to v6.**

Browser:

```ts
const DEFAULT_DATABASE_NAME = "caelum-city-saves-v6";
const DATABASE_VERSION = 6;
```

Native directory:

```text
cities-v6
```

Update current adapter/schema fixture expectations. Do not open/read v5 as fallback.

- [ ] **Step 8: Run the schema/reset gate and commit.**

```bash
cargo test -p caelum-core --test model_wire_format
cargo test -p caelum-core persistence
cargo test -p caelum-core --test transit_build --test trip_lifecycle
bun run test:unit
bun run check
cargo clippy -p caelum-core --all-targets -- -D warnings

rg -n 'caelum-city-saves-v5|cities-v5|SNAPSHOT_SCHEMA_VERSION: u16 = 5' crates src src-tauri tests
# Expected: no active code/test references. Historical dated docs may still mention v5.

git add crates/caelum-core src src-tauri tests
git commit -m "refactor(core): add schema v6 private car trip state"
```

---

### Task 2: Traffic core—road access, car candidate, aggregate flow, congestion

**Files:**
- Create: `crates/caelum-core/src/traffic.rs`
- Create: `crates/caelum-core/tests/traffic.rs`
- Modify: `crates/caelum-core/src/lib.rs`

**Interfaces:**
- Produces `PrivateCarCandidate { path: TransitPath, estimated_seconds: f64 }`.
- Produces `private_car_candidate(state, road_topology, origin, destination)`.
- Produces `active_car_flow`, `road_flow_at`, `congestion_multiplier`, `effective_road_step_seconds`, and `effective_road_path_seconds`.
- Later trip/router/transit tasks must consume these helpers rather than reimplement traffic math.

- [ ] **Step 1: Write failing congestion/flow tests first.**

Pin exact math:

```rust
assert_eq!(congestion_multiplier(0), 1.0);
assert_eq!(congestion_multiplier(4), 1.0);
assert_eq!(congestion_multiplier(6), 1.5);
assert_eq!(congestion_multiplier(12), 3.0);
assert_eq!(congestion_multiplier(u16::MAX), 3.0);
```

Add active-flow fixtures proving:

- one driving trip contributes one unit to each unique road point;
- repeating the same `RoadPathStep.position` within one trip still contributes one;
- a waiting/riding/walking trip contributes zero;
- two driving trips sharing a point produce flow two.

- [ ] **Step 2: Implement fixed-capacity aggregate flow.**

Start `traffic.rs` with:

```rust
use std::collections::{BTreeMap, BTreeSet};

use crate::model::{
    GameSnapshot, Point, PrivateCarTrip, RoadPathStep, StopRoadAccess,
    TransitPath, TripStatus,
};
use crate::road_topology::RoadTopology;

pub const ROAD_FLOW_CAPACITY: u16 = 4;
pub const MAX_CONGESTION_MULTIPLIER: f64 = 3.0;

pub fn congestion_multiplier(flow: u16) -> f64 {
    (f64::from(flow) / f64::from(ROAD_FLOW_CAPACITY))
        .clamp(1.0, MAX_CONGESTION_MULTIPLIER)
}
```

Use a private helper:

```rust
fn unique_road_points(path: &TransitPath) -> BTreeSet<Point> {
    path.road_steps().iter().map(|step| step.position).collect()
}
```

and derive `BTreeMap<Point, u16>` only from active Driving trips with car payloads, using saturating increments.

- [ ] **Step 3: Add failing endpoint/path tests.**

Build one Small House and one Supermarket using existing zoning/building helpers and a short road. Prove:

```text
no adjacent road at home       -> None
no adjacent road at workplace  -> None
disconnected access roads      -> None
connected two-way road         -> Some Road path
one-way reversed against trip  -> None
```

For one-way/structure legality, assert the result from `private_car_candidate` matches what the same fixture's compiled `RoadTopology` permits; do not create another BFS fixture helper.

- [ ] **Step 4: Reuse building-footprint access and compiled topology.**

Implement:

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
```

Define:

```rust
#[derive(Clone, Debug, PartialEq)]
pub struct PrivateCarCandidate {
    pub path: TransitPath,
    pub estimated_seconds: f64,
}

pub fn private_car_candidate(
    state: &GameSnapshot,
    road_topology: &RoadTopology,
    origin: Point,
    destination: Point,
) -> Option<PrivateCarCandidate>;
```

Call only:

```rust
road_topology.find_path_between_access_tiles(
    &state.map,
    from.road_point,
    to.road_point,
    from.preferred_heading,
    to.preferred_heading,
)
```

Require a non-empty `TransitPath::Road`. Do not compile topology in this function.

- [ ] **Step 5: Make candidate ETA include the candidate itself.**

For the candidate road path, start from `active_car_flow(state)`. For each road step use the candidate-adjusted flow for that point:

```rust
let candidate_points = unique_road_points(path);
let estimated_seconds = path
    .road_steps()
    .iter()
    .map(|step| {
        let current = flow.get(&step.position).copied().unwrap_or(0);
        let flow_with_candidate = if candidate_points.contains(&step.position) {
            current.saturating_add(1)
        } else {
            current
        };
        step.travel_seconds * congestion_multiplier(flow_with_candidate)
    })
    .sum();
```

Because every road step is on the candidate path, the membership guard documents the once-per-point flow rule while still charging every transition's time.

- [ ] **Step 6: Expose runtime effective-time helpers.**

Implement:

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

Do not cache `active_car_flow` on the snapshot. If later profiling proves repeated derivation expensive, optimize then with evidence.

- [ ] **Step 7: Verify and commit.**

```bash
cargo test -p caelum-core --test traffic
cargo test -p caelum-core --test road_topology --test router_planning
cargo clippy -p caelum-core --all-targets -- -D warnings

git add crates/caelum-core/src/traffic.rs crates/caelum-core/src/lib.rs crates/caelum-core/tests/traffic.rs
git commit -m "feat(core): add aggregate private car congestion"
```

---

### Task 3: Deterministic commute mode choice and car-arrival lifecycle

**Files:**
- Modify: `crates/caelum-core/src/engine.rs`
- Modify: `crates/caelum-core/src/trips.rs`
- Modify: `crates/caelum-core/src/growth.rs`
- Modify: `crates/caelum-core/tests/traffic.rs`
- Modify: direct `tick_trips` test callsites found by Step 1.

**Interfaces:**
- Trip ticking receives the already-compiled `RoadTopology`; it must not compile topology during a tick.
- `spawn_due_commute_trips` compares existing walk/transit ETA against `traffic::private_car_candidate`.
- Driving trips are normal substep-boundary events and reuse `score_arrival` plus existing metrics/sim-resolution code.

- [ ] **Step 1: Inventory every direct trip-tick callsite.**

```bash
rg -n 'tick_trips(_with_objectives)?\(' crates/caelum-core
```

Every production/test caller must supply a topology explicitly; do not preserve an overload that silently compiles a new topology.

- [ ] **Step 2: Add failing deterministic mode-choice tests.**

Build fixtures with one worker and assert:

```text
car absent + walk/transit present          -> existing non-car lifecycle
car ETA lower than walk/transit             -> Driving + private_car_trip Some
car ETA exactly equal                       -> walk/transit wins
```

Add a two-worker same-departure fixture where both use the same road. Process workers in existing sim order and assert the second candidate observes the first chosen car's additional flow. Run the same scenario as one coarse tick and fine ticks; chosen modes/active flow must match.

- [ ] **Step 3: Thread the compiled topology into trips.**

Use the simpler dependency, not the engine facade:

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

Thread `road_topology` through `tick_trips_substepped` and `spawn_due_commute_trips`.

`GameEngine::tick` calls:

```rust
let next = trips::tick_trips_with_objectives(
    &self.snapshot,
    &self.road_topology,
    delta_seconds,
);
```

Tests compile their fixture map once:

```rust
let topology = RoadTopology::compile(&state.map).expect("fixture topology compiles");
let next = trips::tick_trips(&state, &topology, 1.0);
```

The `expect` is acceptable in a test fixture; production trip handling remains panic-free.

- [ ] **Step 4: Make `build_trip` initialize the new field.**

Existing base trip creation gets exactly:

```rust
private_car_trip: None,
```

No other lifecycle behavior changes here.

- [ ] **Step 5: Compare mode candidates at the due-departure seam.**

Immediately before each outbound/return trip is pushed:

```rust
let transit_plan = router::find_route_plan(state, &origin, &destination);
let car = traffic::private_car_candidate(
    state,
    road_topology,
    origin,
    destination,
);

let choose_car = match (&transit_plan, &car) {
    (None, Some(_)) => true,
    (Some(transit), Some(car)) => {
        car.estimated_seconds < transit.estimated_seconds
    }
    _ => false,
};
```

If `choose_car`:

```rust
let car = car.expect("choose_car implies candidate in this local branch");
trip.status = TripStatus::Driving;
trip.private_car_trip = Some(PrivateCarTrip {
    path: car.path,
    arrival_time: state.time + car.estimated_seconds,
});
```

Avoid even this local `expect` in production by writing the branch as `if let Some(car) = car.filter(|candidate| choose_car) { ... }` or equivalent. The intended production shape is panic-free.

If car does not win, leave the trip exactly as current code expects: `Idle`, no route plan, no car payload. Let `tick_trip` run its existing planner rather than refactoring the transit lifecycle merely to reuse the temporary comparison plan.

Push each trip immediately in the existing sim iteration order so the next same-time candidate sees new active-car flow.

- [ ] **Step 6: Track Driving directly in `track_active_trip_boundary`.**

Before route-plan/wait boundary logic:

```rust
if trip.status == TripStatus::Driving {
    if let Some(car) = &trip.private_car_trip {
        track_next_boundary(next, car.arrival_time, state.time);
    }
    return;
}
```

Do not let Driving fall into the current `route_plan.is_none()` branch, which would incorrectly plan a walk/transit route for boundary tracking.

- [ ] **Step 7: Resolve Driving with `score_arrival` and no panic.**

At the top of `tick_trip`, after terminal handling and before Riding/planning:

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

Do not add another completion helper. `score_arrival` already creates the normal arrived/late `TripTickResult`; `advance_active_trips_with_zero_delta_ids` already applies sim flags/metrics and removes terminal trips.

- [ ] **Step 8: Add arrival/coarse-fine regressions.**

Start a Driving trip with known `arrival_time` and assert:

```text
tick ending before arrival    -> Driving, payload retained, flow retained
tick ending at arrival        -> terminal result, payload cleared, flow removed
coarse tick past arrival      -> same sim flags/metrics as fine ticks split at arrival
```

Keep `max_tick_substeps` unchanged initially. One car contributes at most one future arrival and the existing per-second safety net is already denser. Add another cap term only if this focused coarse-tick test proves exhaustion.

- [ ] **Step 9: Verify and commit.**

```bash
cargo test -p caelum-core --test traffic --test trip_lifecycle --test golden_sequences
cargo test -p caelum-core growth::tests
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings

git add crates/caelum-core/src/engine.rs crates/caelum-core/src/trips.rs crates/caelum-core/src/growth.rs crates/caelum-core/tests
git commit -m "feat(core): add deterministic private car commute trips"
```

---

### Task 4: Apply the same congestion clock to bus estimates and movement

**Files:**
- Modify: `crates/caelum-core/src/router.rs`
- Modify: `crates/caelum-core/src/transit.rs`
- Modify: `crates/caelum-core/tests/traffic.rs`
- Modify: existing router/transit timing tests as needed.

**Interfaces:**
- Stored `RouteLegPath.current_path` remains free-flow structural path data.
- Bus route-plan ETA uses current active-car congestion.
- Bus step movement and `seconds_until_next_vehicle_stop` use one shared helper.
- Metro stays on existing track-step timing.

- [ ] **Step 1: Add a failing bus-delay fixture.**

Create a bus road step:

```rust
RoadPathStep {
    position: Point { x: 2, y: 1 },
    entering_heading: Heading::East,
    leaving_heading: Heading::East,
    movement: MovementKind::Straight,
    geometry: PathGeometry::Line {
        from: TripPosition { x: 2.0, y: 1.0 },
        to: TripPosition { x: 3.0, y: 1.0 },
    },
    travel_seconds: 1.25,
}
```

Seed six active driving trips whose paths include `(2,1)`. Assert the effective bus step is `1.875` seconds (`1.25 * 1.5`).

With a bus at progress `0.0` on that step:

```text
seconds_until_next_vehicle_stop == 1.875
advance 1.25s                    -> step not complete
advance another 0.625s           -> step completes
```

Add a matched metro test proving its track step is unchanged under the same car flow.

- [ ] **Step 2: Make current bus route-plan estimates congestion-aware.**

Change router helpers to receive the snapshot:

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

For current paths:

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

Pass `state` through both one-service and two-service candidate calculations. Do not rebuild paths because traffic changes.

- [ ] **Step 3: Add one exact mode-aware vehicle-step helper.**

Import the existing `TransitPathStepRef` and add in `transit.rs`:

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

Do not introduce another path-step enum.

- [ ] **Step 4: Pass state into `advance_vehicle_by_seconds` and use the helper.**

Change the signature:

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

Change its caller in `tick_vehicles` to pass `state`.

Replace:

```rust
let step_seconds = step.travel_seconds();
```

with:

```rust
let step_seconds = vehicle_step_seconds(state, vehicle.mode, step);
```

Keep existing zero-duration defenses and cursor logic unchanged.

- [ ] **Step 5: Use the same helper in `seconds_until_next_vehicle_stop`.**

For the current step:

```rust
let remaining_current = if let Some(current_step) = path.step(path_step_index) {
    (1.0 - step_progress).max(0.0)
        * vehicle_step_seconds(state, vehicle.mode, current_step)
} else {
    0.0
};
```

For later steps:

```rust
let remaining_later: f64 = (path_step_index + 1..path.step_count())
    .filter_map(|index| path.step(index))
    .map(|step| vehicle_step_seconds(state, vehicle.mode, step))
    .sum();
```

Movement and scheduler boundary timing must land in the same commit.

- [ ] **Step 6: Recheck route-choice behavior with congested bus ETA.**

Add one test where a bus candidate is faster at zero load but becomes slower after flow raises its road-step time. Assert `router::find_route_plan` exposes the congested ETA used by Task 3 mode choice. Metro estimates remain unchanged.

- [ ] **Step 7: Verify and commit.**

```bash
cargo test -p caelum-core --test traffic --test router_planning --test transit_router --test trip_lifecycle --test shuttle_service
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings

git add crates/caelum-core/src/router.rs crates/caelum-core/src/transit.rs crates/caelum-core/tests
git commit -m "feat(core): apply car congestion to bus travel time"
```

---

### Task 5: Traffic overlay, no car sprites, and lean real-UI smoke

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
- Produces `selectTrafficFlow(state): TrafficFlowPoint[]` as the only TypeScript aggregation seam.
- `Overlay` gains exactly `"traffic"`.
- Overlay paints only points that are roads in the current map, even if an active car captured a path before a later road removal.

- [ ] **Step 1: Add failing selector tests.**

Use a concrete TS fixture:

```ts
const driving = {
  ...baseTrip,
  status: "driving" as const,
  privateCarTrip: {
    arrivalTime: 100,
    path: {
      kind: "road" as const,
      totalTravelSeconds: 3.75,
      steps: [
        roadStep({ x: 1, y: 0 }),
        roadStep({ x: 2, y: 0 }),
        roadStep({ x: 2, y: 0 }),
      ],
    },
  },
};
```

Assert one trip yields flow 1 at `(1,0)` and `(2,0)`, not 2 at the repeated point. Add a second driving trip sharing `(2,0)` and assert flow 2. Add a waiting trip with `privateCarTrip: null` and assert it contributes nothing.

- [ ] **Step 2: Implement the presentation selector.**

In `src/domain/traffic.ts`:

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

TypeScript mirrors only raw flow/capacity for display. Do not duplicate Rust's delay multiplier.

- [ ] **Step 3: Add exactly one Traffic overlay control.**

Extend `Overlay` with `"traffic"` and add to `DataPanel.svelte`:

```ts
{ id: "traffic", label: "Traffic" },
```

Add one traffic overlay color in `colors.ts`:

```ts
traffic: "rgba(224, 79, 57, 0.32)",
```

Keep all existing overlays.

- [ ] **Step 4: Render only the selector's current-road points.**

In `overlayRenderer.ts`:

```ts
if (ui.activeOverlay === "traffic") {
  for (const { point, flow } of selectTrafficFlow(state)) {
    const intensity = Math.min(flow / ROAD_FLOW_CAPACITY, 1);
    ctx.globalAlpha = intensity;
    ctx.fillStyle = colors.traffic;
    fillTile(ctx, point);
  }
  ctx.globalAlpha = 1;
}
```

Wrap the alpha mutation in the renderer's normal `save`/`restore` pattern if the surrounding function already uses it; the post-condition is `globalAlpha` restored so later preview/cursor rendering is unaffected.

Add a renderer test proving an active captured path point whose current tile has been changed to `empty` is not filled.

- [ ] **Step 5: Never draw a driving trip as a citizen.**

In `citizenRenderer.ts`:

```ts
if (entity.status === "arrived" || entity.status === "driving") {
  continue;
}
```

Add a focused render test: Driving produces no `arc`/`fill`; existing Walking/Waiting/Riding behavior remains unchanged.

- [ ] **Step 6: Extend the existing E2E smoke only for wiring.**

Keep the existing Small House + Supermarket + occupancy path. Extend the two-way road stroke so there is one connected road adjacent to both building footprints. Update the expected budget by `ROAD_COST` for each additional road tile actually authored.

Then:

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

Retain the existing Resume/Pause/population/clock assertions.

Do **not** wait for a specific worker departure or inspect canvas pixels in Playwright. Rust tests own actual car choice/congestion; unit renderer tests own traffic painting. This E2E proves the real shared UI exposes the feature without making the suite slow/flaky.

- [ ] **Step 7: Update architecture docs with the actual boundary only.**

Add a short note to `docs/architecture.md`:

```text
Private cars are active commute-trip payloads, not vehicle entities.
Aggregate road flow is derived from active private-car paths in `traffic.rs`.
Bus runtime road-step time reads the same congestion helper; stored route paths remain structural/free-flow.
TypeScript derives only the Traffic overlay from snapshot trip state.
```

Do not add future road classes, traffic managers, or service-planning architecture to this doc.

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

- [ ] Rust/TS snapshot schema is v6; browser/native stores use only v6 namespaces.
- [ ] `TransitMode` remains Walk/Bus/Metro.
- [ ] Driving means private-car payload present, route plan absent, zero transit-vehicle memberships.
- [ ] Any generic trip reset that can receive Driving clears `private_car_trip`.
- [ ] No top-level traffic/load cache is persisted.
- [ ] Car access reuses building footprints + `derive_stop_access_for_footprint`.
- [ ] Car routing reuses the engine's compiled `RoadTopology`.
- [ ] One car counts once per unique road point.
- [ ] Capacity is 4; flow 6 is 1.5x; multiplier caps at 3x.
- [ ] New-car ETA counts the candidate itself.
- [ ] Exact time ties keep current walk/transit behavior.
- [ ] Same-time workers remain deterministic in existing sim order.
- [ ] Driving arrival is a normal substep boundary; coarse/fine ticks agree.
- [ ] Car payload is cleared before terminal arrival result leaves active flow.
- [ ] Bus step movement and `seconds_until_next_vehicle_stop` use the same traffic clock.
- [ ] Bus route-plan ETA uses current congestion; metro/walking timing is unchanged.
- [ ] Stored route paths remain structural/free-flow and are not rewritten for congestion.
- [ ] Traffic overlay paints only current road tiles.
- [ ] Driving trips are not rendered as individual citizens/cars.
- [ ] No road classes, signals, parking, lane physics, random mode choice, assignment equilibrium, or compatibility layer was added.

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

If a final command exposes an unrelated pre-existing failure, record the exact command and failure in the implementation PR rather than broadening HPA-622.
