# Phase 3 Aggregate Private-Car Congestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let current worker commutes choose an aggregate private-car road path, derive deterministic road congestion from active car trips, apply the same road delay to buses, and expose one Traffic overlay.

**Architecture:** Reuse the compiled `RoadTopology`, existing `ActiveTrip` lifecycle, trip substep scheduler, precomputed transit paths, and current overlay UI. Add one functional `traffic.rs` module. A private car is an `ActiveTrip` payload with a captured `TransitPath::Road` and frozen arrival timestamp; there are no car entities, lane positions, or traffic caches. Buses keep the existing fractional path cursor but read the current congestion-adjusted duration at each substep.

**Tech Stack:** Rust `caelum-core`, Serde, TypeScript, Svelte 5, Vitest, Playwright, Bun, Tauri.

## Global constraints

- Implement only HPA-622, the first child of HPA-333.
- `ROAD_FLOW_CAPACITY = 4` and `MAX_CONGESTION_MULTIPLIER = 3.0`.
- `congestion_multiplier(flow) = (flow / 4).clamp(1.0, 3.0)`; flow `0..=4` is free-flow, flow `5` is `1.25x`, flow `12+` is `3.0x`.
- Derive road flow from active `Driving` trips; do not persist a traffic/load cache.
- Count one driving trip once per unique `RoadPathStep.position`.
- Buses do not contribute to flow in this slice.
- Reuse `derive_stop_access_for_footprint` and `RoadTopology::find_path_between_access_tiles`.
- Private car wins only when strictly faster than the existing walk/transit plan; exact ties keep walk/transit.
- Keep `TransitMode = Walk | Bus | Metro`; do not add `Car`.
- Cars store only path + frozen arrival timestamp; no car entity, path cursor, intermediate position, parking, or rendering.
- Bus movement and `seconds_until_next_vehicle_stop` must use the same live effective road-step duration.
- Bus `step_progress` remains a fraction of the current effective step duration; flow changes rescale remaining wall-clock time rather than preserving free-flow seconds.
- Due commute departures stay at the existing top-of-loop spawn seam. Within `advance_tick_substep`, vehicles advance before active trips resolve.
- A car arriving at a substep end still congests that substep's bus movement; the next boundary calculation sees reduced flow after the terminal trip is removed.
- Metro/walking timing stays unchanged.
- Schema v6 is a direct disposable-save break; no migration, compatibility defaults, or fallback namespace.
- Add one Traffic overlay only, scaled to full intensity at flow `12`, not flow `4`.
- Production paths added by this work remain panic-free; `expect` is permitted only in test fixture setup.

## File map

**Create**
- `crates/caelum-core/src/traffic.rs`
- `crates/caelum-core/tests/traffic.rs`
- `src/domain/traffic.ts`
- `tests/runtime/traffic.test.ts`

**Modify**
- Core: `crates/caelum-core/src/model.rs`, `lib.rs`, `engine.rs`, `trips.rs`, `router.rs`, `transit.rs`, `growth.rs`
- Persistence: `crates/caelum-core/src/persistence/error.rs`, `persistence/trips.rs`, current persistence/wire tests
- Saves: `src/persistence/indexedDbCitySaveStore.ts`, `src-tauri/src/city_store.rs`, current adapter tests
- Frontend: `src/domain/types.ts`, `src/components/hud/panels/DataPanel.svelte`, `src/render/overlayRenderer.ts`, `citizenRenderer.ts`, `colors.ts`
- Fixtures/tests: existing `tests/helpers`, `tests/fixtures`, runtime/render/save tests, `tests/e2e/smoke.spec.ts`
- Docs: `docs/architecture.md`

---

### Task 1: Schema v6, driving-trip invariants, and payload-clear hygiene

**Produces:** the minimal wire representation and persistence rules used by later tasks.

- [ ] **Step 1: Inventory schema and trip literals.**

```bash
rg -n 'SNAPSHOT_SCHEMA_VERSION|schemaVersion[^\n]*5|caelum-city-saves-v5|DATABASE_VERSION = 5|cities-v5' crates src src-tauri tests docs
rg -n 'ActiveTrip \{' crates/caelum-core
rg -n 'activeTrips:|routePlan:|patienceRemaining:' src tests
```

Every active-trip literal becomes explicit about the new nullable car field.

- [ ] **Step 2: Add failing wire-format tests for one valid Driving trip.**

Use a one-step road path and assert JSON contains:

```text
status: "driving"
privateCarTrip.path.kind: "road"
privateCarTrip.arrivalTime: 101.25
```

The Rust fixture shape is:

```rust
private_car_trip: Some(PrivateCarTrip {
    path: road_path,
    arrival_time: 101.25,
}),
```

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

Add `Driving` to `TripStatus` and add:

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

For `Driving` require:

- car payload present;
- `route_plan == None`;
- `current_leg_index == 0`;
- non-empty `TransitPath::Road`;
- finite non-negative arrival time;
- every captured road-step point inside map bounds;
- zero transit-vehicle passenger memberships.

For non-Driving, reject a non-null car payload.

Do not require captured road-step tiles to still be current roads; a road may be bulldozed after departure and the captured path remains savable.

- [ ] **Step 6: Centralize the three payload-clear exits without a new abstraction.**

In `trips.rs`, change existing terminal helpers:

```rust
fn score_arrival(mut trip: ActiveTrip, time: f64) -> TripTickResult {
    trip.private_car_trip = None;
    // existing Arrived/Late scoring continues
}

fn mark_unserved(mut trip: ActiveTrip) -> ActiveTrip {
    trip.private_car_trip = None;
    // existing Unserved handling continues
}
```

In `transit.rs::cleanup_removed_destination_references`, the existing retarget reset becomes:

```rust
trip.status = TripStatus::Idle;
trip.route_plan = None;
trip.private_car_trip = None;
trip.current_leg_index = 0;
trip.destination = replacement;
trip.deadline = trip_deadline_seconds(state.time);
trip.patience_remaining = WAIT_PATIENCE_SECONDS;
```

Do not add car handling to line-invalidation paths that require a route plan referencing the changed line; Driving has no route plan and cannot enter those paths.

- [ ] **Step 7: Move save namespaces and documentation directly to v6.**

Browser:

```ts
const DEFAULT_DATABASE_NAME = "caelum-city-saves-v6";
const DATABASE_VERSION = 6;
```

Native directory: `cities-v6`.

Update `GameEngine::from_snapshot`'s `schema-v5` documentation to `schema-v6` and update current adapter/schema fixtures. Do not read v5 as fallback.

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

### Task 2: Traffic core—access, car path, derived flow, congestion math

**Produces:** the only traffic-domain module used by trip, router, transit, and tests.

- [ ] **Step 1: Write failing congestion and flow tests.**

```rust
assert_eq!(congestion_multiplier(0), 1.0);
assert_eq!(congestion_multiplier(4), 1.0);
assert_eq!(congestion_multiplier(5), 1.25);
assert_eq!(congestion_multiplier(6), 1.5);
assert_eq!(congestion_multiplier(12), 3.0);
assert_eq!(congestion_multiplier(u16::MAX), 3.0);
```

Add fixtures proving:

- one Driving trip counts once per unique road point;
- duplicate path positions inside one car still count once;
- non-Driving trips count zero;
- two cars sharing a point produce flow two;
- buses do not contribute flow.

- [ ] **Step 2: Implement aggregate flow without snapshot cache state.**

Create `traffic.rs` with:

```rust
pub const ROAD_FLOW_CAPACITY: u16 = 4;
pub const MAX_CONGESTION_MULTIPLIER: f64 = 3.0;

pub fn congestion_multiplier(flow: u16) -> f64 {
    (f64::from(flow) / f64::from(ROAD_FLOW_CAPACITY))
        .clamp(1.0, MAX_CONGESTION_MULTIPLIER)
}
```

Implement `active_car_flow(state) -> BTreeMap<Point, u16>` by iterating only `status == Driving` + `private_car_trip: Some`, deduplicating each trip's road positions with `BTreeSet`, and incrementing with `saturating_add(1)`.

- [ ] **Step 3: Add failing endpoint/path tests.**

Use existing area/building/road helpers to prove:

```text
home has no usable adjacent road          -> no candidate
workplace has no usable adjacent road     -> no candidate
disconnected access roads                 -> no candidate
connected two-way road                    -> Road candidate
one-way direction forbids the trip        -> no candidate
```

The legality comes from the compiled `RoadTopology`; do not build a second BFS.

- [ ] **Step 4: Reuse building footprint access and compiled topology.**

Implement:

```rust
pub fn private_car_candidate(
    state: &GameSnapshot,
    road_topology: &RoadTopology,
    origin: Point,
    destination: Point,
) -> Option<PrivateCarCandidate>
```

For each endpoint, find the containing placed building and call `derive_stop_access_for_footprint`. Call only `find_path_between_access_tiles`. Accept a non-empty `TransitPath::Road`; reject zero-step/Track results.

- [ ] **Step 5: Include the candidate itself in ETA.**

Start from `active_car_flow(state)`. For every candidate road step:

```rust
let flow_with_candidate = flow
    .get(&step.position)
    .copied()
    .unwrap_or(0)
    .saturating_add(1);
let seconds = step.travel_seconds * congestion_multiplier(flow_with_candidate);
```

One car adds only one flow unit per unique point, but a path that structurally revisits a point pays that point's candidate-adjusted multiplier on each transition.

- [ ] **Step 6: Expose shared runtime timing helpers.**

```rust
pub fn road_flow_at(state: &GameSnapshot, point: Point) -> u16;

pub fn effective_road_step_seconds(
    state: &GameSnapshot,
    step: &RoadPathStep,
) -> f64;

pub fn effective_road_path_seconds(
    state: &GameSnapshot,
    path: &TransitPath,
) -> f64;
```

Road helpers use current derived flow; Track returns stored/free-flow time unchanged.

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

### Task 3: Deterministic car-vs-walk choice and car-arrival boundary

**Produces:** end-to-end private-car commute lifecycle while reusing existing arrival metrics/sim flags.

Task 3 deliberately avoids bus-based mode-choice assertions. Bus ETA is still free-flow until Task 4; encoding a bus comparison here would create a test that is supposed to change one task later.

- [ ] **Step 1: Inventory direct trip-tick callsites.**

```bash
rg -n 'tick_trips(_with_objectives)?\(' crates/caelum-core
```

Every caller passes the already-compiled topology. Do not add an overload that recompiles topology.

- [ ] **Step 2: Add failing mode-choice tests using walk/no-plan only.**

Prove:

```text
car unavailable + walk available          -> current non-car lifecycle
car ETA strictly smaller than walk        -> Driving + car payload
car ETA exactly equal to walk             -> walk
same-time worker #2                       -> sees worker #1 car flow if #1 chose car
coarse vs fine ticks                       -> identical chosen modes/flow
```

Use stable sim order; no randomization or preference field.

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

Thread through `tick_trips_substepped` and `spawn_due_commute_trips`.

`GameEngine::tick` passes `&self.road_topology`. Direct tests/growth tests compile topology once in fixture setup and pass the borrow; production tick code never recompiles it.

- [ ] **Step 4: Initialize the base-trip field.**

`build_trip` adds only:

```rust
private_car_trip: None,
```

- [ ] **Step 5: Choose car at the existing due-departure seam.**

Before pushing each outbound/return trip:

```rust
let non_car_plan = router::find_route_plan(state, &origin, &destination);
let car = traffic::private_car_candidate(state, road_topology, origin, destination);

let chosen_car = car.filter(|car| {
    non_car_plan
        .as_ref()
        .map_or(true, |plan| car.estimated_seconds < plan.estimated_seconds)
});
```

If car wins:

```rust
trip.status = TripStatus::Driving;
trip.private_car_trip = Some(PrivateCarTrip {
    path: car.path,
    arrival_time: state.time + car.estimated_seconds,
});
```

Otherwise leave the existing `Idle`/no-plan shape and let `tick_trip` plan normally.

Push immediately in existing sim iteration order so later same-time candidates see earlier selected cars.

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

Do not allow Driving to enter the existing `route_plan.is_none()` branch.

- [ ] **Step 7: Resolve Driving through existing terminal helpers.**

At the top of `tick_trip`, before Riding/planning:

```rust
if trip.status == TripStatus::Driving {
    let Some(car) = &trip.private_car_trip else {
        return unserved_result(mark_unserved(trip.clone()), state.time);
    };

    if state.time + EPSILON < car.arrival_time {
        return unchanged(trip);
    }

    let mut arrived = trip.clone();
    arrived.position = arrived.destination.into();
    return score_arrival(arrived, state.time);
}
```

Use the repository's existing result construction rather than introducing `unserved_result` if no such helper exists; the important rule is that `mark_unserved` and `score_arrival` themselves clear `private_car_trip`.

Do not create another completion pipeline. `advance_active_trips_with_zero_delta_ids` keeps applying metrics, sim resolution/arrival, and terminal removal.

- [ ] **Step 8: Add arrival, malformed-state, persistence, and coarse/fine regressions.**

```text
before arrival boundary -> Driving, payload/flow retained
at arrival boundary     -> terminal, payload cleared, flow removed
coarse past arrival     -> same sim flags + metrics as ticks split at arrival
Driving + missing car   -> Unserved + payload null; snapshot_for_save accepts result
```

Keep `max_tick_substeps` unchanged unless these focused tests demonstrate cap exhaustion.

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

### Task 4: Apply one live congestion clock to bus ETA, movement, and boundaries

**Produces:** one road delay used consistently by bus planning and runtime while private-car timers remain frozen.

- [ ] **Step 1: Add failing static bus/metro timing tests.**

Use a bus road step at `(2,1)` with `travel_seconds: 1.25` and six active cars on that point. Assert effective time is `1.875`.

For a bus at step progress zero:

```text
seconds_until_next_vehicle_stop == 1.875
advance 1.25 seconds             -> step not complete
advance another 0.625 seconds    -> step completes
```

Use an equivalent metro Track step and assert its duration is unchanged by car flow.

- [ ] **Step 2: Lock the fractional-progress rescale rule with a threshold-crossing regression.**

Use a bus on a 1.25s road step at `step_progress = 0.5`.

Start with four existing Driving trips using that road point, so the bus is still at free-flow (`1.0x`). Schedule a fifth worker car to depart on the same point at a deterministic commute boundary. After that departure:

```text
flow = 5
congestion_multiplier(5) = 1.25
effective step duration = 1.25 * 1.25 = 1.5625s
remaining bus time = (1 - 0.5) * 1.5625 = 0.78125s
```

Assert:

- the existing `step_progress == 0.5` is not rewritten;
- no separate remaining-seconds field is introduced;
- a coarse tick crossing the scheduled fifth-car departure produces the same bus cursor/stop result as ticks explicitly split at that departure.

The one-car case is insufficient because flow `1` is still free-flow under capacity `4` and would not prove rescaling.

- [ ] **Step 3: Lock vehicle-before-trip arrival ordering.**

Create a case where a Driving trip is due to arrive exactly at a substep end while its captured path covers the bus's current road point.

Assert:

1. bus movement during that substep uses flow including the arriving car;
2. active-trip resolution then removes/terminalizes the car and clears its payload;
3. the next `next_boundary_after` calculation uses the reduced flow.

Also compare coarse vs explicitly split ticks across that arrival boundary.

- [ ] **Step 4: Make bus route-plan ETA congestion-aware.**

Change router helpers to take `&GameSnapshot` and, for Bus + Road path, call `traffic::effective_road_path_seconds(state, path)`. Metro continues using stored path time.

Do not rebuild route paths because of congestion.

- [ ] **Step 5: Reuse `TransitPathStepRef` for vehicle timing.**

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

Do not introduce another path-step enum or a stored congestion clock.

- [ ] **Step 6: Use the same helper in movement and boundary estimation.**

Pass the snapshot into `advance_vehicle_by_seconds` and replace its free-flow `step.travel_seconds()` with `vehicle_step_seconds(...)`.

In `seconds_until_next_vehicle_stop`, current-step remaining time stays fractional:

```rust
let remaining_current = if let Some(current_step) = path.step(path_step_index) {
    (1.0 - step_progress).max(0.0)
        * vehicle_step_seconds(state, vehicle.mode, current_step)
} else {
    0.0
};
```

Later steps sum the same helper.

Movement and boundary estimation land in the same task/commit.

- [ ] **Step 7: Add the first car-vs-congested-bus mode-choice regression.**

Now that router bus ETA is congestion-aware, create a case where bus is faster at zero road load but slower after active-car flow increases its ETA. Assert `router::find_route_plan` exposes the congested bus ETA and the commute's strict car-vs-non-car comparison chooses accordingly.

Metro remains unchanged.

- [ ] **Step 8: Verify Task 4 and commit.**

```bash
cargo test -p caelum-core --test traffic --test router_planning --test transit_router --test trip_lifecycle --test shuttle_service
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings

git add crates/caelum-core/src/router.rs crates/caelum-core/src/transit.rs crates/caelum-core/src/trips.rs crates/caelum-core/tests
git commit -m "feat(core): apply car congestion to bus travel time"
```

---

### Task 5: Traffic overlay, no car sprites, and lean real-UI smoke

**Produces:** one useful player-facing traffic view without turning E2E into a long simulation scenario.

- [ ] **Step 1: Add failing runtime selector tests in the Vitest-included path.**

Create `tests/runtime/traffic.test.ts`, not `tests/domain/traffic.test.ts`. `vite.config.ts` includes `tests/runtime/**/*.test.ts` but has no domain project.

Use a Driving trip whose road steps visit `(1,0)`, `(2,0)`, `(2,0)` and assert flow one at each unique point. Add a second Driving trip sharing `(2,0)` and assert flow two. Add a Waiting trip with `privateCarTrip: null` and assert it contributes zero.

Change current tile `(2,0)` to `kind: "empty"` and assert that point is omitted.

- [ ] **Step 2: Implement presentation-only current-road flow selection.**

Create `src/domain/traffic.ts` with:

```ts
export const ROAD_FLOW_CAPACITY = 4;
export const MAX_CONGESTION_MULTIPLIER = 3;

export interface TrafficFlowPoint {
  point: Point;
  flow: number;
}
```

`selectTrafficFlow(state)`:

- iterates only `status === "driving"` with a road private-car path;
- deduplicates points within each trip;
- aggregates multiple cars;
- returns only points that are still current road tiles;
- sorts deterministically by y then x.

Do not implement congestion/mode choice in TypeScript.

- [ ] **Step 3: Add exactly one Traffic overlay control.**

Add `"traffic"` to `Overlay`, add `{ id: "traffic", label: "Traffic" }` to `DataPanel.svelte`, and add one traffic fill color.

- [ ] **Step 4: Scale presentation to the actual congestion cap and restore canvas alpha.**

In `overlayRenderer.ts`:

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

Add tests proving:

```text
flow 4  -> alpha 1/3, not full
flow 12 -> alpha 1
flow >12 -> alpha remains 1
historical non-road point -> not painted
```

The TS constants are display mirrors only; do not port the Rust congestion function into frontend code.

- [ ] **Step 5: Do not draw Driving as a citizen/car.**

In `citizenRenderer.ts`:

```ts
if (entity.status === "arrived" || entity.status === "driving") {
  continue;
}
```

Add a render test proving Driving produces no `arc`/`fill`, while Walking/Waiting/Riding behavior remains unchanged.

- [ ] **Step 6: Extend existing E2E only for wiring.**

Keep the existing Small House + Supermarket + occupancy flow. Extend the current two-way road stroke so both building footprints have connected road access; update the budget assertion by the actual added road-tile count.

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

Do not wait for a specific commute departure or inspect traffic canvas pixels in Playwright. Rust owns traffic determinism; runtime/render tests own presentation semantics.

- [ ] **Step 7: Record the narrow architecture boundary.**

Add to `docs/architecture.md`:

```text
Private cars are active commute-trip payloads, not vehicle entities.
Aggregate road flow is derived from active private-car paths in traffic.rs.
Private-car arrival timestamps are frozen at departure.
Bus runtime road-step time reads live congestion while preserving fractional step_progress.
Stored route paths remain structural/free-flow.
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

- [ ] Rust/TS schema is v6; browser/native stores use only v6 namespaces; `from_snapshot` docs say v6.
- [ ] `TransitMode` remains Walk/Bus/Metro.
- [ ] Driving requires car payload, no route plan, no transit passenger membership.
- [ ] `score_arrival`, `mark_unserved`, and destination retarget clear the car payload when leaving Driving.
- [ ] Malformed Driving can become Unserved without producing an unsavable snapshot.
- [ ] No traffic/load cache is persisted.
- [ ] Car access/pathfinding reuse existing footprint access and compiled `RoadTopology`.
- [ ] One car contributes one flow unit per unique road point; buses do not contribute flow.
- [ ] Capacity/multiplier constants and exact test values match the spec.
- [ ] Candidate ETA counts the departing car itself.
- [ ] Exact ETA ties keep walk/transit; simultaneous workers remain stable-order deterministic.
- [ ] Task 3 mode-choice tests do not encode free-flow bus ETA assumptions.
- [ ] Private-car `arrival_time` remains frozen after departure.
- [ ] Bus `step_progress` remains a fraction of current live effective duration.
- [ ] Crossing flow 4 -> 5 mid-step rescales bus remaining time and coarse/fine ticks match.
- [ ] Vehicles advance before trip arrival resolution, so an arriving car congests that substep and the next boundary sees reduced flow.
- [ ] Bus movement, bus next-stop boundary, and bus route-plan ETA use the shared live congestion cost.
- [ ] Metro/walking timing is unchanged and stored route paths remain structural/free-flow.
- [ ] Traffic selector tests live under `tests/runtime/` and run under `bun run test:unit`.
- [ ] Traffic overlay paints only current road tiles and reaches full intensity at flow 12, not flow 4.
- [ ] Driving trips are not rendered as individual entities.
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
