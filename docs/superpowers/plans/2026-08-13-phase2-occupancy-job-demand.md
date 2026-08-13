# Phase 2 Occupancy and Job Demand Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make player-built Small Houses fill deterministically into four resident slots, cap player-built Supermarket employment at four jobs, feed those workers into the existing commute engine, and expose both occupancy values through the current Select inspector.

**Architecture:** Keep `Sim.home`/`workplace` point-based. Schema v5 stores placement time plus resident/job capacities on each placed building. The existing placement function receives explicit capacities, the existing trip substep scheduler processes move-ins, commute/workplace membership comes only from placed `jobCapacity > 0`, demolition removes occupied-house residents and retires the old home-fallback path, and the shell derives occupancy from the snapshot.

**Tech Stack:** Rust `caelum-core`, Serde, TypeScript, Svelte 5, Vitest, Playwright, Bun.

## Global Constraints

- Player Small House resident capacity is exactly `4`.
- Player Supermarket job capacity is exactly `4`.
- Every other current player building has zero resident/job capacity for this slice.
- Growth/campaign placement passes explicit `0, 0` capacities through the existing placement function; do not add a world-placement API or persisted source flag.
- Move-in cadence is exactly one resident slot per in-game hour: `GAME_DAY_SECONDS / 24.0`.
- A due move-in is processed when `due_time <= state.time`.
- Keep `Sim.home: Point` and `Sim.workplace: Option<Point>`; do not add building relationship IDs.
- The sole workplace membership rule is placed `job_capacity > 0`; commute code must not use catalog `effect == "destination"`.
- Remove `moveInRate`, `citizenCount`, and obsolete home-fallback behavior directly; no migration, dual reader, aliases, or compatibility fixtures.
- No generic population/job framework, scheduler service, event bus, ECS, citywide occupancy control, visitor demand, cars, or campaign redesign.

---

## File map

**Create**

- `crates/caelum-core/src/population.rs` — fixed move-in cadence, resident occupancy/boundaries, resident cleanup.
- `crates/caelum-core/tests/population.rs` — vertical population/job/demolition determinism tests.

**Modify**

- `crates/caelum-core/src/model.rs`
- `crates/caelum-core/src/building_catalog.rs`
- `crates/caelum-core/src/buildings.rs`
- `crates/caelum-core/src/growth.rs`
- `crates/caelum-core/src/trips.rs`
- `crates/caelum-core/src/transit.rs`
- `crates/caelum-core/src/sandbox.rs`
- `crates/caelum-core/src/lib.rs`
- `crates/caelum-core/tests/areas_buildings.rs`
- `crates/caelum-core/tests/golden_sequences.rs`
- `crates/caelum-core/tests/model_wire_format.rs`
- `crates/caelum-core/tests/sandbox_factory.rs`
- `crates/caelum-core/tests/sandbox_coverage.rs`
- `crates/caelum-core/tests/trip_lifecycle.rs`
- `crates/caelum-core/tests/transit_build.rs`
- `src/domain/types.ts`
- `src/domain/catalog/buildings.ts`
- `src/runtime/backend/types.ts`
- `src/runtime/workingSaveRuntime.ts`
- `src/runtime/backend/sandboxErrors.ts`
- `src/runtime/types.ts`
- `src/runtime/runtimeSelectors.ts`
- `src/components/hud/panels/InspectPanel.svelte`
- `tests/helpers/gameState.ts`
- `tests/fixtures/rustSnapshot.ts`
- `tests/runtime/wasmBackend.test.ts`
- `tests/runtime/tauriBackend.test.ts`
- `tests/runtime/workingSaveRuntime.test.ts`
- `tests/runtime/runtimeSelectors.test.ts`
- `tests/e2e/smoke.spec.ts`
- `docs/architecture.md`

---

### Task 1: Land a compile-ready schema/placement/workplace authority break

**Files:**
- Modify: `crates/caelum-core/src/model.rs`
- Modify: `crates/caelum-core/src/building_catalog.rs`
- Modify: `crates/caelum-core/src/buildings.rs`
- Modify: `crates/caelum-core/src/growth.rs`
- Modify: `crates/caelum-core/src/trips.rs`
- Modify: `crates/caelum-core/src/transit.rs`
- Modify: `crates/caelum-core/src/sandbox.rs`
- Test/fixture: `crates/caelum-core/tests/areas_buildings.rs`
- Test/fixture: `crates/caelum-core/tests/model_wire_format.rs`
- Test/fixture: `crates/caelum-core/tests/sandbox_factory.rs`
- Test/fixture: `crates/caelum-core/tests/sandbox_coverage.rs`
- Test/fixture: `crates/caelum-core/tests/trip_lifecycle.rs`
- Test/fixture: `crates/caelum-core/tests/transit_build.rs`
- Modify: `src/domain/types.ts`
- Modify: `src/domain/catalog/buildings.ts`
- Modify: `src/runtime/backend/types.ts`
- Modify: `src/runtime/workingSaveRuntime.ts`
- Modify: `src/runtime/backend/sandboxErrors.ts`
- Test/fixture: `tests/helpers/gameState.ts`
- Test/fixture: `tests/fixtures/rustSnapshot.ts`
- Test: `tests/runtime/wasmBackend.test.ts`
- Test: `tests/runtime/tauriBackend.test.ts`
- Test: `tests/runtime/workingSaveRuntime.test.ts`

**Interfaces:**
- Produces schema `5` with required `PlacedBuilding.placed_at/placedAt`, `resident_capacity/residentCapacity`, and `job_capacity/jobCapacity`.
- Replaces `BuildingDefinition.citizen_count` with `resident_capacity` and `job_capacity`.
- Changes `place_building_core` to receive explicit resident/job capacities; player placement passes catalog values and growth passes `0, 0`.
- Replaces effect-based `destination_points` with placed-capacity workplace membership.
- Removes `move_in_rate/moveInRate` and `citizenCount`.
- Keeps player Small House spawning immediately only for this intermediate task so all existing player-commute tests stay runnable until Task 2 replaces that loop.

- [ ] **Step 1: Write the failing schema/wire assertions.**

Update the existing wire test to expect the new required fields and removed sandbox field:

```rust
assert_eq!(SNAPSHOT_SCHEMA_VERSION, 5);
let json = serde_json::to_value(snapshot).unwrap();
assert!(json["rules"]["sandbox"].get("moveInRate").is_none());
assert_eq!(json["buildings"][0]["placedAt"], 0.0);
assert_eq!(json["buildings"][0]["residentCapacity"], 4);
assert_eq!(json["buildings"][0]["jobCapacity"], 0);
```

Update `tests/fixtures/rustSnapshot.ts` expectations to schema 5 and remove `moveInRate`.

- [ ] **Step 2: Run the focused tests and confirm the old schema fails.**

```bash
cargo test -p caelum-core --test model_wire_format --test sandbox_factory --test sandbox_coverage
bun run test:unit -- tests/runtime/wasmBackend.test.ts tests/runtime/tauriBackend.test.ts tests/runtime/workingSaveRuntime.test.ts
```

- [ ] **Step 3: Change the model/catalog and make the only construction site compile in the same step.**

Use this shape:

```rust
pub const SNAPSHOT_SCHEMA_VERSION: u16 = 5;

pub struct PlacedBuilding {
    // existing fields
    pub placed_at: f64,
    pub resident_capacity: u16,
    pub job_capacity: u16,
    // transit_node_id remains
}

pub struct BuildingDefinition {
    // existing fields
    pub resident_capacity: u16,
    pub job_capacity: u16,
}
```

Set Small House to `(4, 0)`, Supermarket to `(0, 4)`, and every other current catalog definition to `(0, 0)`.

Change the existing core placement function rather than adding a world-named API:

```rust
pub fn place_building_core(
    state: &GameSnapshot,
    building_type: &str,
    origin: &Point,
    rotation: u16,
    resident_capacity: u16,
    job_capacity: u16,
) -> GameplayResult<GameSnapshot> {
    // keep current validation/node setup
    next.buildings.push(PlacedBuilding {
        id: building_id,
        building_type: building_type.to_string(),
        origin: *origin,
        rotation,
        occupied_tiles: occupied_tiles.clone(),
        placed_at: state.time,
        resident_capacity,
        job_capacity,
        transit_node_id,
    });

    // Intermediate Task-1 behavior only. Task 2 deletes this loop.
    for index in 0..usize::from(resident_capacity) {
        // keep the current deterministic Sim construction body
    }

    // existing return path
}
```

`place_building_costed` passes `definition.resident_capacity, definition.job_capacity`. `growth.rs` passes `0, 0` at its one placement call. Do not introduce `enable_player_capacities: bool` or `place_world_building_core`.

- [ ] **Step 4: Replace workplace membership authority now, before finite capacity accounting.**

Rename the point helper and derive it from placed data only:

```rust
pub fn workplace_points(state: &GameSnapshot) -> Vec<Point> {
    state
        .buildings
        .iter()
        .filter(|building| building.job_capacity > 0)
        .flat_map(|building| building.occupied_tiles.iter().copied())
        .collect()
}
```

Use `workplace_points` in the current unlimited `assign_workplaces` implementation and `trips.rs::has_valid_workplace_destination`. In `transit.rs`, build removed-workplace tiles only when the removed building footprint is represented by this same helper. No commute/workplace path may consult `BuildingDefinition.effect` after this step.

This makes growth buildings with stored `job_capacity == 0` inert immediately; Task 4 later changes assignment from unlimited to finite.

- [ ] **Step 5: Remove `moveInRate` and update every required placed-building literal.**

Delete `MoveInRateSelection`, the sandbox setting/request/validated field, `UnknownMoveInRate`, its parser, and the hard-coded TypeScript values. Remove `citizenCount` from the TS catalog.

Run this inventory before editing fixtures:

```bash
rg -n 'PlacedBuilding \{' crates/caelum-core tests
```

At minimum update literals/builders in `areas_buildings.rs`, `trip_lifecycle.rs`, `transit_build.rs`, `model_wire_format.rs`, `tests/helpers/gameState.ts`, and `tests/fixtures/rustSnapshot.ts`. Rust fixtures that represent a valid commute destination must set `job_capacity > 0`; generic/non-workplace fixtures may use zero. Give every literal a finite `placed_at` (normally `0.0`).

- [ ] **Step 6: Update growth expectations and run a full compile/test gate.**

Growth-wave Small Houses should still place but store zero capacity and create zero sims because growth passes `0, 0`:

```rust
assert_eq!(next.buildings.len(), 5);
assert!(next.buildings.iter().all(|building| building.resident_capacity == 0));
assert!(next.sims.is_empty());
```

Run:

```bash
cargo test --workspace
bun run test:unit
bun run check
cargo clippy --workspace --all-targets -- -D warnings
```

This gate is intentionally broad: Task 1 adds required struct fields and must prove no construction site or fixture was missed.

- [ ] **Step 7: Commit.**

```bash
git add crates/caelum-core src tests
git commit -m "refactor(core): define phase 2 building capacity authority"
```

---

### Task 2: Replace immediate player population with deterministic move-in

**Files:**
- Create: `crates/caelum-core/src/population.rs`
- Create: `crates/caelum-core/tests/population.rs`
- Modify: `crates/caelum-core/src/lib.rs`
- Modify: `crates/caelum-core/src/buildings.rs`
- Modify: `crates/caelum-core/src/trips.rs`
- Modify: `crates/caelum-core/tests/areas_buildings.rs`
- Modify: `crates/caelum-core/tests/golden_sequences.rs`

**Interfaces:**
- Produces `population::MOVE_IN_INTERVAL_SECONDS`.
- Produces focused resident occupancy, next-boundary, remaining-slot, due-application, and later demolition-cleanup helpers.
- Deletes the intermediate immediate resident loop from `place_building_core`.

- [ ] **Step 1: Write the failing move-in tests and update the pinned no-tick golden.**

In `population.rs` integration coverage:

```rust
let placed = place_player_small_house(&mut engine);
assert!(placed.snapshot.sims.is_empty());

engine.dispatch(GameIntent::SetPaused { paused: false });
let first = engine.tick(0.001);
assert_eq!(first.snapshot.sims.len(), 1);
assert_eq!(first.snapshot.sims[0].id, "sim-001");
```

For granularity:

```rust
coarse.tick(150.0);
for _ in 0..3 {
    fine.tick(50.0);
}
assert_eq!(coarse.snapshot().sims, fine.snapshot().sims);
assert_eq!(coarse.snapshot().sims.len(), 4);
```

In `golden_sequences.rs::zone_build_and_route_sequence_has_stable_counts`, change the no-tick population expectation from `4` to `0`. Keep the 900-second commute goldens and use them as the regression that the four residents have arrived before standard departures.

- [ ] **Step 2: Run and confirm current Task-1 immediate spawning fails the new contract.**

```bash
cargo test -p caelum-core --test population --test areas_buildings --test golden_sequences
```

- [ ] **Step 3: Implement occupancy-derived due processing with `<=`.**

Use:

```rust
pub const MOVE_IN_INTERVAL_SECONDS: f64 = crate::clock::GAME_DAY_SECONDS / 24.0;

pub fn resident_occupancy(state: &GameSnapshot, building: &PlacedBuilding) -> usize {
    state
        .sims
        .iter()
        .filter(|sim| building.occupied_tiles.contains(&sim.home))
        .count()
}
```

Inside `apply_due_move_ins`, process resident-capacity buildings in stable ID order. For each building:

```rust
let mut occupancy = resident_occupancy(state, &building);
while occupancy < usize::from(building.resident_capacity) {
    let due = building.placed_at + occupancy as f64 * MOVE_IN_INTERVAL_SECONDS;
    if due > state.time {
        break;
    }
    // allocate next deterministic sim using next_entity_id,
    // worker_profile_for_id, shift_template_for_id, and
    // building.occupied_tiles[occupancy % building.occupied_tiles.len()]
    occupancy += 1;
}
```

The comparison is deliberately `due <= state.time` via the `if due > state.time { break; }` form. Call `assign_workplaces` once after all due residents are added.

- [ ] **Step 4: Replace all six growth-event calls in `tick_trips_substepped`.**

Add:

```rust
fn apply_due_world_events(state: &mut GameSnapshot) {
    crate::growth::apply_due_growth_waves(state);
    crate::population::apply_due_move_ins(state);
}
```

Replace every `crate::growth::apply_due_growth_waves(&mut next)` in `tick_trips_substepped`: initial prepass, normal-loop prepass, normal post-substep, fallback-loop prepass, fallback post-substep, and final pass.

Verify the replacement inventory:

```bash
rg -n 'apply_due_growth_waves\(&mut next\)' crates/caelum-core/src/trips.rs
```

Expected after the edit: no direct call remains inside `tick_trips_substepped`; the helper is the only path there.

Add `population::next_move_in_boundary_after(state)` to `next_boundary_after`. That helper should return only future candidates; already-due slots are handled by the six current-time passes. Add:

```rust
.saturating_add(crate::population::remaining_move_in_slots(state))
```

to `max_tick_substeps`, and keep the existing post-event sim-count cap widening.

- [ ] **Step 5: Update immediate-spawn tests without weakening the existing long goldens.**

Change `areas_buildings.rs` housing coverage to assert zero while paused, then Resume/tick to prove deterministic filling. Keep `full_day_commute_trace_has_stable_golden_metrics` and `large_tick_matches_stepped_tick_for_full_commute`; do not replace their expected commute metrics merely because move-in became gradual. By 150 seconds the Small House must already contain four residents, well before `sim-001`'s standard outbound departure.

- [ ] **Step 6: Run deterministic + integrated commute gates.**

```bash
cargo test -p caelum-core --test population --test areas_buildings --test golden_sequences --test trip_lifecycle
cargo test -p caelum-core growth::tests
cargo clippy -p caelum-core --all-targets -- -D warnings
```

- [ ] **Step 7: Commit.**

```bash
git add crates/caelum-core/src/population.rs crates/caelum-core/src/lib.rs crates/caelum-core/src/buildings.rs crates/caelum-core/src/trips.rs crates/caelum-core/tests/population.rs crates/caelum-core/tests/areas_buildings.rs crates/caelum-core/tests/golden_sequences.rs
git commit -m "feat(core): add deterministic player housing move-in"
```

---

### Task 3: Remove occupied-house residents and retire home-fallback

**Files:**
- Modify: `crates/caelum-core/src/population.rs`
- Modify: `crates/caelum-core/src/transit.rs`
- Modify: `crates/caelum-core/src/buildings.rs`
- Modify: `crates/caelum-core/src/trips.rs`
- Modify: `crates/caelum-core/tests/population.rs`
- Modify: `crates/caelum-core/tests/areas_buildings.rs`
- Modify: `crates/caelum-core/tests/trip_lifecycle.rs`

**Interfaces:**
- Produces `population::remove_residents_for_building(&mut GameSnapshot, &PlacedBuilding)` for the authoritative building-removal path.
- Deletes the supported `workplace == home` fallback contract because the lifecycle that created it no longer exists.

- [ ] **Step 1: Add the failing occupied-house demolition regression.**

Create/fill a Small House, attach an active trip plus a vehicle passenger reference for `sim-001`, demolish any tile in the house footprint, then assert:

```rust
assert!(!snapshot.sims.iter().any(|sim| sim.id == "sim-001"));
assert!(!snapshot.active_trips.iter().any(|trip| trip.sim_id == "sim-001"));
assert!(snapshot.transit.vehicles.iter().all(|vehicle|
    !vehicle.passenger_ids.iter().any(|id| id == "trip-001")
));
```

Also assert all residents whose homes lie in that same footprint are removed, not only the clicked tile's resident.

- [ ] **Step 2: Run and confirm current demolition leaves residents behind.**

```bash
cargo test -p caelum-core --test population --test areas_buildings --test trip_lifecycle
```

- [ ] **Step 3: Implement resident/trip/passenger cleanup.**

Use footprint membership to collect removed sim IDs and their active trip IDs:

```rust
let removed_sim_ids: HashSet<String> = state
    .sims
    .iter()
    .filter(|sim| building.occupied_tiles.contains(&sim.home))
    .map(|sim| sim.id.clone())
    .collect();
let removed_trip_ids: HashSet<String> = state
    .active_trips
    .iter()
    .filter(|trip| removed_sim_ids.contains(&trip.sim_id))
    .map(|trip| trip.id.clone())
    .collect();

state.sims.retain(|sim| !removed_sim_ids.contains(&sim.id));
state.active_trips.retain(|trip| !removed_trip_ids.contains(&trip.id));
for vehicle in &mut state.transit.vehicles {
    vehicle
        .passenger_ids
        .retain(|trip_id| !removed_trip_ids.contains(trip_id));
}
```

Call this from `transit::remove_at_tile` when the removed placed building has `resident_capacity > 0`.

- [ ] **Step 4: Delete home-fallback production behavior and its obsolete regression tests.**

After occupied-housing demolition removes the sims, a supported snapshot cannot free a resident's home tile and leave that resident alive. Remove:

- `buildings.rs` logic that treats `workplace == home` as an assignment state to revisit;
- the placement-time `retarget_home_fallback_trips` call;
- `trips.rs::is_home_fallback_trip` and `retarget_home_fallback_trips`;
- the call/comment in `transit.rs::cleanup_removed_destination_references`;
- tests in `areas_buildings.rs` / `trip_lifecycle.rs` that exist only to preserve orphaned-resident home-fallback behavior.

Inventory the removal:

```bash
rg -n 'home.?fallback|retarget_home_fallback|is_home_fallback' crates/caelum-core/src crates/caelum-core/tests
```

Expected: no live source/test contract remains for home fallback after this task.

- [ ] **Step 5: Run demolition + commute regressions.**

```bash
cargo test -p caelum-core --test population --test areas_buildings --test trip_lifecycle --test golden_sequences
cargo test --workspace
```

- [ ] **Step 6: Commit.**

```bash
git add crates/caelum-core/src/population.rs crates/caelum-core/src/transit.rs crates/caelum-core/src/buildings.rs crates/caelum-core/src/trips.rs crates/caelum-core/tests/population.rs crates/caelum-core/tests/areas_buildings.rs crates/caelum-core/tests/trip_lifecycle.rs
git commit -m "refactor(core): remove orphaned housing fallback"
```

---

### Task 4: Enforce finite Supermarket jobs and keep one workplace cleanup path

**Files:**
- Modify: `crates/caelum-core/src/buildings.rs`
- Modify: `crates/caelum-core/src/transit.rs`
- Modify: `crates/caelum-core/tests/population.rs`
- Modify: `crates/caelum-core/tests/trip_lifecycle.rs` only if the existing workplace fixtures need capacity-specific expectations.

**Interfaces:**
- `assign_workplaces(&mut GameSnapshot)` remains the only assignment function.
- The Task-1 placed-capacity workplace helper remains the only membership authority.
- `cleanup_removed_destination_references` may be renamed to `cleanup_removed_workplace_references`, but it keeps its existing single `assign_workplaces(state)` call; do not wrap it with another assignment pass.

- [ ] **Step 1: Add failing finite-capacity and commute tests.**

Fill two player Small Houses (eight worker sims in this range), place one player Supermarket, then assert exactly four workers hold a workplace:

```rust
let assigned = snapshot
    .sims
    .iter()
    .filter(|sim| sim.worker_profile == WorkerProfile::Worker && sim.workplace.is_some())
    .count();
assert_eq!(assigned, 4);
```

Prove the existing commute handoff for the first worker:

```rust
let minute = departure_minute_for_sim("sim-001", "standard", "outbound");
let departure = f64::from(minute) / f64::from(MINUTES_PER_DAY) * GAME_DAY_SECONDS;
engine.tick(departure);
assert!(engine.snapshot().active_trips.iter().any(|trip|
    trip.sim_id == "sim-001" && trip.purpose == TripPurpose::CommuteOutbound
));
```

Build the Supermarket before Resume so each due resident can be assigned as they arrive.

- [ ] **Step 2: Add the failing workplace-demolition test.**

Create workers plus two player Supermarkets, confirm both carry assignments, demolish one, and assert:

- no sim retains a workplace point in the removed footprint;
- survivors are reassigned through the existing cleanup to the other Supermarket only up to its capacity;
- no second assignment pass is needed by the caller.

- [ ] **Step 3: Rewrite `assign_workplaces` around stable finite placed-building slots.**

Clone the placed buildings with `job_capacity > 0`, sort by building ID, and maintain one used-count per building. Walk workers in stable existing sim order twice:

1. preserve an existing assignment only if it still belongs to a current workplace with an unused slot; otherwise set it to `None`;
2. assign each remaining worker to the first workplace with capacity.

For slot `used`:

```rust
sim.workplace = Some(
    workplace.occupied_tiles[used % workplace.occupied_tiles.len()]
);
used += 1;
```

Workers beyond current capacity remain unassigned. There is no same-home exception after Task 3.

- [ ] **Step 4: Keep commute validity and demolition on the same Task-1 workplace authority.**

Do not reintroduce `effect == "destination"`. `has_valid_workplace_destination` continues to validate against the placed-capacity workplace helper. The demolition cleanup's removed tile set continues to use that same helper/placed `job_capacity > 0` authority.

Inside the existing cleanup function, keep this sequence:

```text
clear affected sim.workplace
assign_workplaces(state)   // exactly once
retarget/drop affected outbound trips using the resulting workplace map
remove invalidated passenger trip IDs from vehicles
```

The home-fallback retarget call is already gone from Task 3. Do not add `assign_workplaces` before or after this cleanup in `remove_at_tile`.

- [ ] **Step 5: Run assignment, demolition, and commute regressions.**

```bash
cargo test -p caelum-core --test population --test trip_lifecycle --test golden_sequences --test router_planning
cargo test --workspace
```

- [ ] **Step 6: Commit.**

```bash
git add crates/caelum-core/src/buildings.rs crates/caelum-core/src/transit.rs crates/caelum-core/tests/population.rs crates/caelum-core/tests/trip_lifecycle.rs
git commit -m "feat(core): cap player Supermarket jobs"
```

---

### Task 5: Show capacity in Select and splice it into the existing smoke

**Files:**
- Modify: `src/runtime/types.ts`
- Modify: `src/runtime/runtimeSelectors.ts`
- Modify: `src/components/hud/panels/InspectPanel.svelte`
- Modify: `tests/runtime/runtimeSelectors.test.ts`
- Modify: `tests/e2e/smoke.spec.ts`
- Modify: `docs/architecture.md`

**Interfaces:** `ShellInspectorState` becomes a discriminated `transit | building` union. No backend API and no persisted occupancy counters are added.

- [ ] **Step 1: Add failing selector tests.**

Use a fixture with one resident-capacity Small House and one job-capacity Supermarket. Select each footprint and assert:

```ts
expect(shell.inspector).toEqual({
  kind: "building",
  buildingId: "building-001",
  buildingLabel: "Small House",
  metricLabel: "Residents",
  occupancy: 1,
  capacity: 4,
});
```

Add the corresponding `Jobs` assertion. Update an existing transit-node assertion to include `kind: "transit"`.

- [ ] **Step 2: Run and confirm the current selector returns no building inspector.**

```bash
bun run test:unit -- tests/runtime/runtimeSelectors.test.ts
```

- [ ] **Step 3: Implement the inspector union and rendering.**

Add the building branch:

```ts
{
  kind: "building";
  buildingId: string;
  buildingLabel: string;
  metricLabel: "Residents" | "Jobs";
  occupancy: number;
  capacity: number;
}
```

In `runtimeSelectors.ts`, keep transit-node resolution first. Otherwise find the selected placed building by `occupiedTiles`, choose its nonzero capacity, and derive occupancy from matching `sim.home` / `sim.workplace` points. Return `null` for zero-capacity buildings.

In `InspectPanel.svelte`, preserve current platform markup under `inspector.kind === "transit"`; render the building branch as:

```svelte
<span class="building-occupancy">
  {inspector.metricLabel} {inspector.occupancy} / {inspector.capacity}
</span>
```

- [ ] **Step 4: Splice occupancy assertions into the current `smoke.spec.ts`; keep its tail.**

Immediately after the existing Supermarket + Small House placements, replace the current population-`4` contract with paused state:

```ts
await expect(populationReadout.getByText("0")).toBeVisible();
await page.getByTestId("command-tool-select").click();
await clickMapTile(canvas, { x: 1, y: 1 });
await expect(page.getByTestId("panel-inspect")).toContainText("Residents 0 / 4");
await clickMapTile(canvas, { x: 5, y: 1 });
await expect(page.getByTestId("panel-inspect")).toContainText("Jobs 0 / 4");
```

Then continue the **existing** road placement and bus-terminal rotation portion unchanged. At the existing Resume point, poll the first move-in:

```ts
await page.getByRole("button", { name: "Resume" }).click();
await expect.poll(async () =>
  (await populationReadout.locator(".readout-value").textContent())?.trim()
).toBe("1");
```

Inspect the house and supermarket again for `Residents 1 / 4` / `Jobs 1 / 4`, then keep the existing visible-clock assertion. Do not replace the road, bus-terminal, or clock tail with occupancy-only coverage.

- [ ] **Step 5: Update architecture docs and run the user-facing/full gates.**

Document schema v5, Rust-owned placed capacity, fixed move-in, finite jobs, one workplace definition, occupied-house deletion, and derived UI occupancy. Remove stale schema-4 / `moveInRate` / immediate-citizen statements.

```bash
bun run test:unit
bun run check
bun run test:e2e -- tests/e2e/smoke.spec.ts
bun run format:check
bun run lint
cargo test --workspace
```

- [ ] **Step 6: Commit.**

```bash
git add src/runtime src/components/hud/panels/InspectPanel.svelte tests/runtime/runtimeSelectors.test.ts tests/e2e/smoke.spec.ts docs/architecture.md
git commit -m "feat(ui): show player building occupancy in Select"
```

---

## Final self-review / release gate

- [ ] Task 1 compiles with every required `PlacedBuilding` field/literal updated.
- [ ] player Small House is the only resident-capacity building and never exceeds four sims.
- [ ] player Supermarket is the only job-capacity building and never exceeds four assigned workers.
- [ ] growth placements pass `0, 0` through the existing placement function; no world-specific API/source field exists.
- [ ] no commute/workplace path uses catalog `effect == "destination"`.
- [ ] all six tick growth-event sites also apply due move-ins, and due comparison is `<= state.time`.
- [ ] no immediate placement-time resident loop remains after Task 2.
- [ ] occupied-house demolition removes resident/trip/passenger references.
- [ ] home-fallback production code/tests are removed after occupied-house cleanup makes them unreachable.
- [ ] workplace demolition performs exactly one reassignment through the existing cleanup.
- [ ] the no-tick golden expects zero residents while the 900-second golden still proves the same commute behavior.
- [ ] the existing E2E keeps its road/bus-terminal/clock coverage and adds paused/first-move-in occupancy assertions.
- [ ] `moveInRate` and `citizenCount` are deleted rather than deprecated.
- [ ] no home/workplace building IDs, household/job entities, scheduler service, ECS, event bus, migration, or compatibility path was introduced.
