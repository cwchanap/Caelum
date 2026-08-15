# HPA-622 Live-Baseline Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Align the existing HPA-622 private-car implementation with the current Linear issue: natural generalized car cost and one scheduler-owned ephemeral road-flow map shared by car choice, bus ETA, bus movement, and vehicle boundaries.

**Architecture:** Keep aggregate ActiveTrip::Driving, compiled RoadTopology, and the current Traffic overlay. Move the established walking cost to commute, add only CAR_ACCESS_SECONDS = 120.0, and make RoadFlow an explicit borrowed value. trips::tick_trips_substepped derives and owns the map at each scheduling iteration, mutates it only while admitting same-time cars, then passes it through router and transit work for that substep.

**Tech Stack:** Rust caelum-core, Serde, TypeScript/Svelte 5, Vitest, Playwright, Bun, Tauri.

## Global Constraints

- Implement only HPA-622; do not add car entities, TransitMode::Car, lane state, queues, parking, road classes, or compatibility code.
- CAR_ACCESS_SECONDS = 120.0 is the only new private-car generalized cost.
- commute::WALK_SECONDS_PER_TILE == 20.0 is shared by route walking, active walking, and car endpoint access.
- ROAD_FLOW_CAPACITY = 4, MAX_CONGESTION_MULTIPLIER = 3.0, and congestion_multiplier(flow) = (flow / 4).clamp(1.0, 3.0) remain unchanged.
- RoadFlow is ephemeral BTreeMap<Point, u16> data, never GameSnapshot or GameEngine state.
- Driving contributes once per unique captured road position for its entire lifetime; buses never contribute to RoadFlow.
- Derive RoadFlow once per scheduling iteration/substep boundary. No timing helper, router helper, or vehicle loop may rescan active_trips.
- Same-time selected cars update the one mutable local RoadFlow in stable sim order.
- Car choice uses strict <; ties preserve walk/transit. Car ETA is endpoint walk + CAR_ACCESS_SECONDS + self-inclusive effective road path + endpoint walk.
- Bus ETA, movement, and next-stop boundaries receive the same borrowed map. Metro timing, stored route paths, and frozen car arrival timestamps remain unchanged.
- Keep persistence structural, production additions panic-free, and expect fixture-construction-only.
- Keep one current-road-only Traffic overlay that reaches full intensity at flow 12.

## Current Boundary

Schema v6, structural Driving persistence, payload clearing, aggregate-path selection, the overlay, and Driving sprite suppression are already complete. The remaining mismatch is concentrated in traffic.rs: it derives from GameSnapshot inside candidate/timing helpers, the car candidate has no access/walk cost, and router/transit/trips do not receive one shared map. The old synthetic congested-bus mode-flip regression must become topology-produced natural-cost coverage.

## File Map

**Modify**

- crates/caelum-core/src/commute.rs — shared walking-time constant.
- crates/caelum-core/src/traffic.rs — RoadFlow derivation/update, generalized car ETA, borrowed timing helpers.
- crates/caelum-core/src/router.rs, transit.rs, trips.rs — flow-taking interfaces and scheduler ownership.
- crates/caelum-core/tests/traffic.rs, router_planning.rs, router_estimate_branches.rs, transit_router.rs, transit_build.rs, shuttle_service.rs, golden_sequences.rs, and trip_lifecycle.rs — explicit flow inputs and live-baseline proofs.
- docs/architecture.md — durable boundary documentation.

**Do not modify TypeScript production code unless Rust snapshot behavior proves it necessary.** The current selector, Data-panel control, renderer, and thin Playwright smoke already meet the live UI contract.

---

### Task 1: Shared commute cost and scheduler-owned RoadFlow

**Produces:** one explicit RoadFlow passed through car choice, router estimates, bus timing, and trip scheduling without hidden snapshot rescans.

**Files:**

- Modify: crates/caelum-core/src/commute.rs, traffic.rs, router.rs, transit.rs, trips.rs.
- Test: crates/caelum-core/tests/traffic.rs, router_planning.rs, router_estimate_branches.rs, transit_router.rs, transit_build.rs, shuttle_service.rs, golden_sequences.rs, and direct-signature callers in trip_lifecycle.rs.

**Interfaces:**

~~~rust
pub const WALK_SECONDS_PER_TILE: f64 = 20.0;
pub type RoadFlow = BTreeMap<Point, u16>;
pub const CAR_ACCESS_SECONDS: f64 = 120.0;

pub fn derive_road_flow(state: &GameSnapshot) -> RoadFlow;
pub fn add_car_path_to_flow(flow: &mut RoadFlow, path: &TransitPath);

pub fn private_car_candidate(
    state: &GameSnapshot,
    road_topology: &RoadTopology,
    flow: &RoadFlow,
    origin: Point,
    destination: Point,
) -> Option<PrivateCarCandidate>;

pub fn effective_road_step_seconds(flow: &RoadFlow, step: &RoadPathStep) -> f64;
pub fn effective_road_path_seconds(flow: &RoadFlow, path: &TransitPath) -> f64;

pub fn find_route_plan(
    state: &GameSnapshot,
    flow: &RoadFlow,
    origin: &Point,
    destination: &Point,
) -> Option<RoutePlan>;

pub fn plan_route(
    state: &GameSnapshot,
    flow: &RoadFlow,
    origin: &Point,
    destination: &Point,
) -> Option<RoutePlan>;

pub fn tick_vehicles(
    state: &GameSnapshot,
    flow: &RoadFlow,
    delta_seconds: f64,
) -> GameSnapshot;

pub fn seconds_until_next_vehicle_stop(
    state: &GameSnapshot,
    flow: &RoadFlow,
    vehicle: &Vehicle,
) -> Option<f64>;
~~~

tick_vehicles, seconds_until_next_vehicle_stop, all private vehicle helpers, and all route-planning seams take the same borrowed RoadFlow. trips is the only production owner of derive_road_flow; direct tests construct their own explicit local flow.

- [ ] **Step 1: Write failing explicit-flow and generalized-cost tests.**

In tests/traffic.rs, replace active_car_flow and road_flow_at imports with derive_road_flow, add_car_path_to_flow, RoadFlow, and CAR_ACCESS_SECONDS. Preserve the existing unique-road-path fixtures and write assertions such as:

~~~rust
assert_eq!(commute::WALK_SECONDS_PER_TILE, 20.0);
assert_eq!(CAR_ACCESS_SECONDS, 120.0);
assert_eq!(derive_road_flow(&state), BTreeMap::from([(shared, 2), (other, 1)]));

let mut flow = derive_road_flow(&state);
add_car_path_to_flow(&mut flow, &candidate.path);
assert_eq!(flow.get(&shared), Some(&3));
assert_eq!(effective_road_step_seconds(&flow, &step), 1.875);
~~~

Update all direct router/transit test callers to pass RoadFlow::new() or derive_road_flow(&state) as appropriate. Run:

~~~bash
cargo test -p caelum-core --test traffic
~~~

Expected: compilation fails because the explicit-flow API and shared cost are absent.

- [ ] **Step 2: Implement the shared-cost and RoadFlow primitives.**

Add WALK_SECONDS_PER_TILE to commute.rs, use it from router.rs and trips.rs, and remove the old private/literal copies. In traffic.rs, define RoadFlow and use a private helper that deduplicates TransitPath::Road positions in a BTreeSet before saturating increments.

~~~rust
pub fn derive_road_flow(state: &GameSnapshot) -> RoadFlow {
    let mut flow = RoadFlow::new();
    for trip in &state.active_trips {
        if trip.status == TripStatus::Driving {
            if let Some(car) = &trip.private_car_trip {
                add_car_path_to_flow(&mut flow, &car.path);
            }
        }
    }
    flow
}
~~~

Remove road_flow_at and all snapshot-taking effective-road helpers. Retain the existing building/access/topology lookup, but calculate candidate ETA as endpoint Manhattan walks at the shared cost, 120.0, and road steps at flow[position] + 1. The candidate itself adds one unit per visited step for time calculation; add_car_path_to_flow still deduplicates when an admitted car joins the map.

- [ ] **Step 3: Thread RoadFlow through router and transit.**

Make both public router entry points take RoadFlow; pass it through ride_seconds and leg_travel_seconds. Only Bus + TransitPath::Road calls effective_road_path_seconds(flow, path); walking and Metro retain current timing.

Make tick_vehicles, seconds_until_next_vehicle_stop, advance_vehicle_by_seconds, and vehicle_step_seconds take/forward the same map. The bus road arm is:

~~~rust
(TransitMode::Bus, TransitPathStepRef::Road(step)) => {
    crate::traffic::effective_road_step_seconds(flow, step)
}
~~~

Do not add vehicle state or change fractional step_progress math.

- [ ] **Step 4: Make trip scheduling the only production RoadFlow owner.**

Thread RoadFlow through private trip planning, boundary, active-trip, and vehicle helpers. At every current-time processing site in tick_trips_substepped (initial, main loop, fallback loop, final processing), derive once, admit due trips, then reuse that map for boundary and substep work:

~~~rust
let mut road_flow = traffic::derive_road_flow(&next);
spawn_due_commute_trips(&mut next, road_topology, &mut road_flow);
let substep_end = next_boundary_after(&next, &road_flow);
next = advance_tick_substep(&next, &road_flow, substep_delta);
~~~

Both outbound and return mode comparison pass road_flow to find_route_plan and private_car_candidate. If strict car choice wins, push it and immediately call add_car_path_to_flow(road_flow, &car.path). next_boundary_after passes the same map to active-trip planning and seconds_until_next_vehicle_stop; advance_tick_substep passes it to tick_vehicles before active trips resolve. No other production timing path derives flow.

Update SIM_SHIFT_BOUNDARIES_PER_DAY documentation to say the existing six per-sim boundaries already include outbound/return resolution, so a Driving arrival is not a seventh category.

- [ ] **Step 5: Verify Task 1 and commit.**

~~~bash
cargo test -p caelum-core --test traffic --test router_planning --test router_estimate_branches --test transit_router --test transit_build --test shuttle_service --test golden_sequences --test trip_lifecycle
cargo clippy -p caelum-core --all-targets -- -D warnings
cargo fmt --all --check

git add crates/caelum-core/src crates/caelum-core/tests
git commit -m "refactor(core): share HPA-622 road flow timing"
~~~

---

### Task 2: Natural mode-choice and timing-boundary acceptance proof

**Produces:** topology-valid proof that walk, car, and bus remain naturally selectable and that the borrowed map preserves deterministic substep timing.

**Files:**

- Modify: crates/caelum-core/tests/traffic.rs, router_planning.rs, transit_router.rs, trip_lifecycle.rs, and docs/architecture.md.
- Modify production only if a failing acceptance regression exposes a missing Task 1 flow propagation or arithmetic defect.

**Interfaces:**

- Consumes Task 1 RoadFlow, CAR_ACCESS_SECONDS, and explicit timing APIs.
- Uses tick_trips(state, road_topology, delta_seconds) as the authoritative end-to-end scheduler seam.
- Uses compiled topology (RoadTopology::compile and GameEngine road/route intents), never hand-written impossible travel durations.

- [ ] **Step 1: Inventory commute-fixture impact before changing expectations.**

Run and record exact hits in the report:

~~~bash
rg -n 'tick_trips|tick\(|CommuteOutbound|CommuteReturn|completed_trips|late_trips|unserved_trips|average_wait|outbound_arrived_today|returned_home_today' \
  crates/caelum-core/tests/golden_sequences.rs \
  crates/caelum-core/tests/commute_requirements.rs \
  crates/caelum-core/tests/population.rs \
  crates/caelum-core/tests/objectives_metrics.rs \
  crates/caelum-core/tests/trip_lifecycle.rs
~~~

For each altered fixture, report one explicit rationale: update a real commute expectation because car behavior is intended, or deny usable building road access to preserve an unrelated waiting/transit/objective test. Do not bulk-rewrite timings or snapshots.

- [ ] **Step 2: Replace the synthetic bus-mode-flip test with natural cost fixtures.**

Delete or rewrite due_commute_uses_direct_bus_at_zero_flow_and_car_after_bus_congestion; it relies on a stale bus shortcut and a hand-built detour and is no longer an acceptance contract. Add topology-produced assertions for:

~~~text
short roughly-six-tile no-transit commute: walk ETA < car ETA
long roughly-twelve-tile no-transit commute: car ETA < walk ETA
direct bus with one-tile endpoint access: bus ETA < car ETA < long walk ETA
poor/detouring bus topology: car ETA < bus ETA
~~~

Calculate from actual RoadPathStep.travel_seconds, find_route_plan(state, &flow, &home, &workplace), and private_car_candidate(state, &topology, &flow, home, workplace). Assert mode and relative costs, not a fabricated path time. Retain strict-tie coverage.

- [ ] **Step 3: Lock RoadFlow boundary and determinism behavior.**

Adapt lifecycle fixtures to explicit derive_road_flow assertions and add these focused cases:

~~~text
same-time worker #2 sees worker #1's updated local map;
flow 4 -> 5 at a scheduled car departure preserves fractional bus progress;
an arriving car delays that substep's bus movement, then next iteration sees reduced flow;
many staggered Driving arrivals in one coarse tick all resolve and match split ticks.
~~~

For the 4 -> 5 fixture, use free-flow 1.25 seconds, four existing cars, and a fifth due car. Assert flow 5, multiplier 1.25, duration 1.5625, and 0.78125 seconds remaining from a 0.5 cursor. For staggered cars, use valid frozen payloads with sequential arrival times inside the coarse interval; assert final time, cleared active cars, metrics, and coarse/split equality. Keep the bus ETA test comparing RoadFlow::new() to a nonzero map on one unchanged topology path, and keep the Metro control unchanged.

- [ ] **Step 4: Document the boundary and keep the UI lean.**

Update the private-car paragraph in docs/architecture.md to state:

~~~text
Private cars are active commute-trip payloads, not vehicle entities.
CAR_ACCESS_SECONDS is one fixed generalized car access cost; walking remains the shared 20s/tile cost.
RoadFlow is ephemeral data rebuilt at scheduling boundaries, never persisted.
Every RoadFlow change is a car departure or arrival boundary.
Private-car arrival timestamps are frozen at departure.
Bus runtime road-step time consumes one borrowed RoadFlow while preserving fractional step_progress.
Stored route paths remain structural/free-flow.
TypeScript derives only the current-road Traffic overlay from snapshot trip state.
~~~

Do not change the existing selector, Data panel, renderer, or Playwright merely to restate already-passing UI behavior.

- [ ] **Step 5: Verify Task 2 and commit.**

~~~bash
cargo test -p caelum-core --test traffic --test trip_lifecycle --test router_planning --test router_estimate_branches --test transit_router --test shuttle_service --test golden_sequences --test commute_requirements --test population --test objectives_metrics
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all --check
bun run test:unit
bun run check
bun run test:e2e -- tests/e2e/smoke.spec.ts
bun run format:check
bun run lint

git add crates/caelum-core/src crates/caelum-core/tests docs/architecture.md
git commit -m "test(core): lock HPA-622 live traffic behavior"
~~~

---

## Final Verification Checklist

- [ ] One shared 20-second walk constant and the sole CAR_ACCESS_SECONDS = 120.0 exist.
- [ ] All production road timing receives borrowed RoadFlow; no helper derives from GameSnapshot.
- [ ] Scheduler derives once, admits same-time cars into its local map, and reuses it for planning, vehicle boundary estimation, and movement.
- [ ] Car ETA includes endpoint walks, fixed access cost, and self-inclusive flow; exact ties retain non-car behavior.
- [ ] Natural topology fixtures prove short-walk, long-car, good-bus, and poor-bus outcomes without a synthetic mode flip.
- [ ] Bus ETA, next-stop timing, and movement use one map; Metro and frozen car timers remain unchanged.
- [ ] Car arrival remains an existing commute-resolution boundary and coarse/fine timing remains deterministic.
- [ ] Schema/persistence/overlay behavior stays intact with no added host or UI abstraction.

## Final Commands

~~~bash
cargo fmt --all --check
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
bun run test:unit
bun run check
bun run test:e2e
bun run format:check
bun run lint
bun run build
~~~
