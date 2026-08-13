# Phase 2 Occupancy and Job Demand Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make player-built Small Houses fill deterministically into four resident slots, cap player-built Supermarket employment at four jobs, feed those workers into the existing commute engine, and expose both occupancy values through the current Select inspector.

**Architecture:** Keep `Sim.home`/`workplace` point-based and add only `placedAt`, `residentCapacity`, and `jobCapacity` to placed buildings. A focused Rust population module joins the existing trip substep scheduler; workplace assignment stays in `buildings.rs`, world growth uses the same placement validation with zero capacities, demolition stays in `transit.rs`, and the Svelte shell derives display occupancy from the authoritative snapshot.

**Tech Stack:** Rust `caelum-core`, Serde, TypeScript, Svelte 5, Vitest, Playwright, Bun.

## Global Constraints

- Small House player-placement resident capacity is exactly `4`.
- Supermarket player-placement job capacity is exactly `4`.
- Move-in cadence is exactly one resident slot per in-game hour: `GAME_DAY_SECONDS / 24.0`.
- Other current building types have zero authored resident/job capacity for now.
- Campaign/world placement records zero resident/job capacity even for Small House/Supermarket; only player-built buildings enter this slice.
- Keep `Sim.home: Point` and `Sim.workplace: Option<Point>`; do not add building relationship/source IDs.
- Remove the dormant one-value `moveInRate` contract instead of replacing it with another configuration value.
- Bump the current development snapshot schema once; no migration, dual reader, or compatibility alias.
- No generic population/job framework, event bus, scheduler service, ECS, citywide occupancy control, visitor demand, cars, or campaign redesign.

---

## File map

**Create**

- `crates/caelum-core/src/population.rs` — fixed move-in cadence, resident occupancy/boundaries, resident cleanup.
- `crates/caelum-core/tests/population.rs` — vertical Rust behavior and determinism regressions.

**Modify**

- `crates/caelum-core/src/model.rs` — schema v5, placed-building capacity/time, remove `MoveInRateSelection`.
- `crates/caelum-core/src/building_catalog.rs` — resident/job authored capacities.
- `crates/caelum-core/src/buildings.rs` — player/world capacity recording, stop immediate spawning, capacity-aware jobs.
- `crates/caelum-core/src/growth.rs` — use capacity-zero world placement and update dormant campaign assertions.
- `crates/caelum-core/src/trips.rs` — apply/track move-in boundaries and substep budget.
- `crates/caelum-core/src/transit.rs` — occupied-housing cleanup and workplace reassignment.
- `crates/caelum-core/src/sandbox.rs` — remove `move_in_rate` request/settings validation.
- `crates/caelum-core/src/lib.rs` — register population module.
- `crates/caelum-core/tests/areas_buildings.rs` — replace immediate-spawn expectations.
- `crates/caelum-core/tests/model_wire_format.rs` — schema-v5 wire shape.
- `crates/caelum-core/tests/sandbox_factory.rs` and `crates/caelum-core/tests/sandbox_coverage.rs` — current request/settings shape.
- `src/domain/types.ts` — schema v5, placed-building fields, remove move-in setting.
- `src/domain/catalog/buildings.ts` — remove `citizenCount` mirror.
- `src/runtime/backend/types.ts`, `src/runtime/workingSaveRuntime.ts`, `src/runtime/backend/sandboxErrors.ts` — current sandbox request/error shape.
- `src/runtime/types.ts`, `src/runtime/runtimeSelectors.ts` — building inspector union/selector.
- `src/components/hud/panels/InspectPanel.svelte` — building occupancy rendering.
- `tests/fixtures/rustSnapshot.ts` — schema-v5 fixture.
- `tests/runtime/wasmBackend.test.ts`, `tests/runtime/tauriBackend.test.ts`, `tests/runtime/workingSaveRuntime.test.ts` — remove obsolete `moveInRate` expectations.
- `tests/runtime/runtimeSelectors.test.ts` — building inspector coverage.
- `tests/e2e/smoke.spec.ts` — real paused→first-move-in UI proof.
- `docs/architecture.md` — current population ownership and schema contract.

---

### Task 1: Make the schema describe capacity instead of immediate population

**Files:**
- Modify: `crates/caelum-core/src/model.rs`
- Modify: `crates/caelum-core/src/building_catalog.rs`
- Modify: `crates/caelum-core/src/sandbox.rs`
- Modify: `src/domain/types.ts`
- Modify: `src/domain/catalog/buildings.ts`
- Modify: `src/runtime/backend/types.ts`
- Modify: `src/runtime/workingSaveRuntime.ts`
- Modify: `src/runtime/backend/sandboxErrors.ts`
- Test: `crates/caelum-core/tests/model_wire_format.rs`
- Test: `crates/caelum-core/tests/sandbox_factory.rs`
- Test: `crates/caelum-core/tests/sandbox_coverage.rs`
- Test: `tests/fixtures/rustSnapshot.ts`
- Test: `tests/runtime/wasmBackend.test.ts`
- Test: `tests/runtime/tauriBackend.test.ts`
- Test: `tests/runtime/workingSaveRuntime.test.ts`

**Interfaces:**
- Produces `PlacedBuilding.placed_at/placedAt`, `resident_capacity/residentCapacity`, and `job_capacity/jobCapacity`.
- Produces Rust `BuildingDefinition.resident_capacity` and `job_capacity`.
- Removes `citizen_count/citizenCount` and `move_in_rate/moveInRate`.

- [ ] **Step 1: Write failing schema/wire tests.**

In `model_wire_format.rs`, change the expected schema and assert the new placed-building wire fields plus removal of `moveInRate`:

```rust
assert_eq!(SNAPSHOT_SCHEMA_VERSION, 5);
let json = serde_json::to_value(snapshot).unwrap();
assert!(json["rules"]["sandbox"].get("moveInRate").is_none());
assert_eq!(json["buildings"][0]["placedAt"], 0.0);
assert_eq!(json["buildings"][0]["residentCapacity"], 4);
assert_eq!(json["buildings"][0]["jobCapacity"], 0);
```

In `tests/fixtures/rustSnapshot.ts`, use `schemaVersion: 5`, remove `moveInRate`, and give each placed-building fixture `placedAt`, `residentCapacity`, and `jobCapacity`.

- [ ] **Step 2: Run the focused tests and confirm they fail on schema 4 / missing fields.**

```bash
cargo test -p caelum-core --test model_wire_format
bun run test:unit -- tests/runtime/wasmBackend.test.ts tests/runtime/tauriBackend.test.ts tests/runtime/workingSaveRuntime.test.ts
```

- [ ] **Step 3: Implement the direct schema break.**

Add these fields to the existing Rust structs:

```rust
// PlacedBuilding additions
pub placed_at: f64,
pub resident_capacity: u16,
pub job_capacity: u16,

// BuildingDefinition replacements for citizen_count
pub resident_capacity: u16,
pub job_capacity: u16,
```

Set `SNAPSHOT_SCHEMA_VERSION` to `5`. Author Small House as `(resident_capacity: 4, job_capacity: 0)`, Supermarket as `(0, 4)`, and every other current catalog entry as `(0, 0)`.

Delete `MoveInRateSelection`, `SandboxSettings.move_in_rate`, sandbox request/validated fields, `UnknownMoveInRate`, its parser, and hard-coded TypeScript `moveInRate: "paused"` values. Remove `citizenCount` from the TS catalog rather than adding TS gameplay capacity constants.

- [ ] **Step 4: Update current fixtures/host assertions only and run the schema surface.**

```bash
cargo test -p caelum-core --test model_wire_format --test sandbox_factory --test sandbox_coverage
bun run test:unit -- tests/runtime/wasmBackend.test.ts tests/runtime/tauriBackend.test.ts tests/runtime/workingSaveRuntime.test.ts
bun run check
```

Do not add schema-v4 readers or migration tests.

- [ ] **Step 5: Commit.**

```bash
git add crates/caelum-core/src/model.rs crates/caelum-core/src/building_catalog.rs crates/caelum-core/src/sandbox.rs crates/caelum-core/tests/model_wire_format.rs crates/caelum-core/tests/sandbox_factory.rs crates/caelum-core/tests/sandbox_coverage.rs src/domain src/runtime tests/fixtures/rustSnapshot.ts tests/runtime
git commit -m "refactor(core): define phase 2 building capacity snapshot"
```

---

### Task 2: Add player-only deterministic Small House move-in to the existing tick scheduler

**Files:**
- Create: `crates/caelum-core/src/population.rs`
- Create: `crates/caelum-core/tests/population.rs`
- Modify: `crates/caelum-core/src/lib.rs`
- Modify: `crates/caelum-core/src/buildings.rs`
- Modify: `crates/caelum-core/src/growth.rs`
- Modify: `crates/caelum-core/src/trips.rs`
- Modify: `crates/caelum-core/tests/areas_buildings.rs`

**Interfaces:**
- Produces `population::MOVE_IN_INTERVAL_SECONDS`.
- Produces `resident_occupancy`, `next_move_in_boundary_after`, `remaining_move_in_slots`, `apply_due_move_ins`, and `remove_residents_for_building`.
- Produces internal `buildings::place_world_building_core` for capacity-zero growth-wave placement.
- Player `PlaceBuilding` records `placed_at = state.time`, copies catalog capacities, and no longer creates residents synchronously.

- [ ] **Step 1: Write failing player move-in and world-growth tests.**

Add `population.rs` integration coverage that zones/places a player `smallHouse` and asserts:

```rust
assert!(placed.snapshot.sims.is_empty());
engine.dispatch(GameIntent::SetPaused { paused: false });
let first = engine.tick(0.001);
assert_eq!(first.snapshot.sims.len(), 1);
assert_eq!(first.snapshot.sims[0].id, "sim-001");
```

Compare one `150.0` second tick with three `50.0` second ticks:

```rust
coarse.tick(150.0);
for _ in 0..3 {
    fine.tick(50.0);
}
assert_eq!(coarse.snapshot().sims, fine.snapshot().sims);
assert_eq!(coarse.snapshot().sims.len(), 4);
```

Update the existing campaign growth test in `growth.rs` so five growth-wave Small Houses still place but stay inert:

```rust
assert_eq!(next.buildings.len(), 5);
assert!(next.buildings.iter().all(|building| building.resident_capacity == 0));
assert!(next.sims.is_empty());
```

- [ ] **Step 2: Run and confirm the current immediate-spawn behavior fails the new contract.**

```bash
cargo test -p caelum-core --test population --test areas_buildings
cargo test -p caelum-core growth::tests
```

- [ ] **Step 3: Split player/world placement without adding snapshot source state.**

Keep the existing player-facing `place_building_core` and route both placement variants through one private helper:

```rust
fn place_building_core_with_capacities(
    state: &GameSnapshot,
    building_type: &str,
    origin: &Point,
    rotation: u16,
    enable_player_capacities: bool,
) -> GameplayResult<GameSnapshot> {
    let definition = building_definition(building_type)
        .ok_or_else(|| GameplayRejection::at(RejectionCode::InvalidBuildingPlacement, *origin))?;
    let resident_capacity = if enable_player_capacities { definition.resident_capacity } else { 0 };
    let job_capacity = if enable_player_capacities { definition.job_capacity } else { 0 };
    // Keep the existing validation/footprint/transit-node body and store
    // state.time, resident_capacity, and job_capacity on the placed building.
}

pub(crate) fn place_world_building_core(
    state: &GameSnapshot,
    building_type: &str,
    origin: &Point,
    rotation: u16,
) -> GameplayResult<GameSnapshot> {
    place_building_core_with_capacities(state, building_type, origin, rotation, false)
}
```

`place_building_core` calls the same helper with `true`; `growth.rs` calls `place_world_building_core`. Delete the old synchronous `definition.citizen_count` sim loop.

- [ ] **Step 4: Implement occupancy-derived move-in.**

Use:

```rust
pub const MOVE_IN_INTERVAL_SECONDS: f64 = crate::clock::GAME_DAY_SECONDS / 24.0;

pub fn resident_occupancy(state: &GameSnapshot, building: &PlacedBuilding) -> usize {
    state.sims.iter().filter(|sim| building.occupied_tiles.contains(&sim.home)).count()
}

fn next_due_time(state: &GameSnapshot, building: &PlacedBuilding) -> Option<f64> {
    let occupancy = resident_occupancy(state, building);
    (occupancy < usize::from(building.resident_capacity))
        .then(|| building.placed_at + occupancy as f64 * MOVE_IN_INTERVAL_SECONDS)
}
```

`apply_due_move_ins` clones player-capacity buildings (`resident_capacity > 0`), sorts by `id`, and for every due slot allocates the next deterministic sim using existing `next_entity_id`, `worker_profile_for_id`, and `shift_template_for_id`; set `home = occupied_tiles[occupancy % occupied_tiles.len()]`. Call `assign_workplaces` once after adding all due residents.

- [ ] **Step 5: Join population to the existing substep scheduler.**

In `trips.rs`, replace direct due-growth calls with:

```rust
fn apply_due_world_events(state: &mut GameSnapshot) {
    crate::growth::apply_due_growth_waves(state);
    crate::population::apply_due_move_ins(state);
}
```

Feed `population::next_move_in_boundary_after(state)` through the current `track_next_boundary`, and add this term to `max_tick_substeps`:

```rust
.saturating_add(crate::population::remaining_move_in_slots(state))
```

Keep existing sim-count cap widening after due world events.

- [ ] **Step 6: Run deterministic + dormant-growth regressions.**

```bash
cargo test -p caelum-core --test population --test areas_buildings --test trip_lifecycle --test golden_sequences
cargo test -p caelum-core growth::tests
cargo clippy -p caelum-core --all-targets -- -D warnings
```

- [ ] **Step 7: Commit.**

```bash
git add crates/caelum-core/src/population.rs crates/caelum-core/src/lib.rs crates/caelum-core/src/buildings.rs crates/caelum-core/src/growth.rs crates/caelum-core/src/trips.rs crates/caelum-core/tests/population.rs crates/caelum-core/tests/areas_buildings.rs
git commit -m "feat(core): add deterministic player housing move-in"
```

---

### Task 3: Cap Supermarket jobs and prove the existing commute handoff

**Files:**
- Modify: `crates/caelum-core/src/buildings.rs`
- Modify: `crates/caelum-core/tests/population.rs`

**Interfaces:** `assign_workplaces(&mut GameSnapshot)` remains the one assignment function; downstream commute code continues reading `Sim.workplace: Option<Point>`.

- [ ] **Step 1: Add failing job-capacity and commute tests.**

Fill two player Small Houses (eight sims), place one player Supermarket, then assert exactly four workers are assigned:

```rust
let assigned = snapshot.sims.iter()
    .filter(|sim| sim.worker_profile == WorkerProfile::Worker && sim.workplace.is_some())
    .count();
assert_eq!(assigned, 4);
```

For the commute handoff, build Supermarket before ticking and advance exactly to `sim-001`'s current deterministic outbound departure:

```rust
let minute = departure_minute_for_sim("sim-001", "standard", "outbound");
let departure = f64::from(minute) / f64::from(MINUTES_PER_DAY) * GAME_DAY_SECONDS;
engine.tick(departure);
assert!(engine.snapshot().active_trips.iter().any(|trip|
    trip.sim_id == "sim-001" && trip.purpose == TripPurpose::CommuteOutbound
));
```

- [ ] **Step 2: Run and observe the current unlimited-destination failure.**

```bash
cargo test -p caelum-core --test population
```

- [ ] **Step 3: Rewrite `assign_workplaces` around finite placed-building slots.**

Clone capacity-bearing workplace descriptors and sort them by building ID. First preserve valid existing worker assignments and increment that building's used count. Then walk unassigned workers in existing sim order and allocate the first free workplace slot:

```rust
if used < usize::from(workplace.job_capacity) {
    sim.workplace = Some(workplace.occupied_tiles[used % workplace.occupied_tiles.len()]);
    used += 1;
}
```

Workers beyond all current capacity remain `None`. World-growth buildings have `job_capacity == 0`, so they never enter the workplace list. Do not create job records or per-tile capacity state.

- [ ] **Step 4: Run assignment + commute regressions.**

```bash
cargo test -p caelum-core --test population --test trip_lifecycle --test router_planning
```

- [ ] **Step 5: Commit.**

```bash
git add crates/caelum-core/src/buildings.rs crates/caelum-core/tests/population.rs
git commit -m "feat(core): cap player Supermarket jobs"
```

---

### Task 4: Make occupied-building demolition leave no dangling current state

**Files:**
- Modify: `crates/caelum-core/src/population.rs`
- Modify: `crates/caelum-core/src/transit.rs`
- Modify: `crates/caelum-core/tests/population.rs`
- Modify: `crates/caelum-core/tests/areas_buildings.rs`

**Interfaces:** `population::remove_residents_for_building(&mut GameSnapshot, &PlacedBuilding)` is called only by the authoritative building-removal path.

- [ ] **Step 1: Add failing workplace and housing demolition regressions.**

For workplace removal, create workers plus two player Supermarkets, demolish one, and assert every remaining non-null workplace belongs to the surviving Supermarket and no surviving workplace exceeds four assignments.

For housing removal, create a populated Small House plus an active trip/vehicle passenger reference for `sim-001`, then assert after removal:

```rust
assert!(!snapshot.sims.iter().any(|sim| sim.id == "sim-001"));
assert!(!snapshot.active_trips.iter().any(|trip| trip.sim_id == "sim-001"));
assert!(snapshot.transit.vehicles.iter().all(|vehicle|
    !vehicle.passenger_ids.iter().any(|id| id == "trip-001")
));
```

- [ ] **Step 2: Run and confirm housing currently leaves sims behind.**

```bash
cargo test -p caelum-core --test population --test areas_buildings
```

- [ ] **Step 3: Implement resident cleanup and workplace reassignment.**

In `remove_residents_for_building`:

```rust
let removed_sim_ids: HashSet<String> = state.sims.iter()
    .filter(|sim| building.occupied_tiles.contains(&sim.home))
    .map(|sim| sim.id.clone())
    .collect();
let removed_trip_ids: HashSet<String> = state.active_trips.iter()
    .filter(|trip| removed_sim_ids.contains(&trip.sim_id))
    .map(|trip| trip.id.clone())
    .collect();
state.sims.retain(|sim| !removed_sim_ids.contains(&sim.id));
state.active_trips.retain(|trip| !removed_trip_ids.contains(&trip.id));
for vehicle in &mut state.transit.vehicles {
    vehicle.passenger_ids.retain(|id| !removed_trip_ids.contains(id));
}
```

In `transit::remove_at_tile`, invoke that helper when the removed building has resident capacity. Keep `cleanup_removed_destination_references` for a removed job-capacity building, then call `assign_workplaces` once so displaced workers can use remaining capacity.

- [ ] **Step 4: Run core + snapshot regressions.**

```bash
cargo test -p caelum-core --test population --test areas_buildings --test model_wire_format
cargo test --workspace
```

- [ ] **Step 5: Commit.**

```bash
git add crates/caelum-core/src/population.rs crates/caelum-core/src/transit.rs crates/caelum-core/tests/population.rs crates/caelum-core/tests/areas_buildings.rs
git commit -m "fix(core): clean occupancy on building demolition"
```

---

### Task 5: Show capacity in the existing Select inspector and real smoke flow

**Files:**
- Modify: `src/runtime/types.ts`
- Modify: `src/runtime/runtimeSelectors.ts`
- Modify: `src/components/hud/panels/InspectPanel.svelte`
- Modify: `tests/runtime/runtimeSelectors.test.ts`
- Modify: `tests/e2e/smoke.spec.ts`
- Modify: `docs/architecture.md`

**Interfaces:** `ShellInspectorState` becomes a discriminated `transit | building` union. No backend API changes.

- [ ] **Step 1: Add failing selector tests for Residents and Jobs.**

Use the canonical fixture with a Small House / one resident and Supermarket / one assigned worker. Select each footprint and assert the building branch:

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

Add the corresponding `Jobs` assertion and update an existing transit-node assertion to include `kind: "transit"`.

- [ ] **Step 2: Run and confirm the current selector returns `null` for non-transit buildings.**

```bash
bun run test:unit -- tests/runtime/runtimeSelectors.test.ts
```

- [ ] **Step 3: Implement the inspector union and renderer.**

Keep the current transit fields in the transit branch; add this building branch in `runtime/types.ts`:

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

In `runtimeSelectors.ts`, keep transit resolution first. Otherwise find the selected building by `occupiedTiles`, choose its nonzero capacity, and count matching `sim.home` / `sim.workplace` points. Return `null` for zero-capacity buildings.

In `InspectPanel.svelte`, preserve the platform markup for `inspector.kind === "transit"`; for `building`, render:

```svelte
<span class="building-occupancy">
  {inspector.metricLabel} {inspector.occupancy} / {inspector.capacity}
</span>
```

- [ ] **Step 4: Update the existing Playwright smoke instead of adding a second E2E.**

After placing Supermarket then Small House while paused:

```ts
await expect(populationReadout.getByText("0")).toBeVisible();
await page.getByTestId("command-tool-select").click();
await clickMapTile(canvas, { x: 1, y: 1 });
await expect(page.getByTestId("panel-inspect")).toContainText("Residents 0 / 4");
await clickMapTile(canvas, { x: 5, y: 1 });
await expect(page.getByTestId("panel-inspect")).toContainText("Jobs 0 / 4");
```

Resume and poll only for the first move-in, due at placement time:

```ts
await page.getByRole("button", { name: "Resume" }).click();
await expect.poll(async () =>
  (await populationReadout.locator(".readout-value").textContent())?.trim()
).toBe("1");
```

Inspect both buildings again for `Residents 1 / 4` and `Jobs 1 / 4`. Do not wait until the 07:01 commute departure in Playwright; Task 3 proves it in Rust.

- [ ] **Step 5: Update architecture docs and run user-facing gates.**

Document that Rust owns player-building capacity, deterministic move-in, and finite workplace assignment; world growth remains capacity-zero; the shell only derives display occupancy. Remove stale schema-4 / `moveInRate` statements.

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

- [ ] player Small House is the only resident-capacity building and never exceeds four sims.
- [ ] player Supermarket is the only job-capacity building and never exceeds four assigned workers.
- [ ] world/campaign placements keep zero capacities and do not enter player move-in/job assignment.
- [ ] no immediate placement-time population loop remains in `buildings.rs`.
- [ ] `moveInRate` and `citizenCount` are removed rather than deprecated.
- [ ] no home/workplace building IDs, placement-source field, household/job entities, scheduler service, ECS, or event bus were introduced.
- [ ] coarse/fine population + assignment tests pass.
- [ ] commute handoff test proves the current trip engine consumes the new worker state.
- [ ] occupied housing/workplace demolition leaves no current dangling references.
- [ ] shared UI shows the two capacity values and existing transit inspection still works.
- [ ] all current schema fixtures are v5; no compatibility paths were added.
