# Phase 2 Occupancy and Job Demand Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make player-built Small Houses fill deterministically into four resident slots, cap Supermarket employment at four jobs, feed those workers into the existing commute engine, and expose both occupancy values through the current Select inspector.

**Architecture:** Keep `Sim.home`/`workplace` point-based and add only `placedAt`, `residentCapacity`, and `jobCapacity` to placed buildings. A focused Rust population module joins the existing trip substep scheduler; workplace assignment stays in `buildings.rs`, demolition stays in `transit.rs`, and the Svelte shell derives display occupancy from the authoritative snapshot.

**Tech Stack:** Rust `caelum-core`, Serde, TypeScript, Svelte 5, Vitest, Playwright, Bun.

## Global Constraints

- Small House resident capacity is exactly `4` in this slice.
- Supermarket job capacity is exactly `4` in this slice.
- Move-in cadence is exactly one resident slot per in-game hour: `GAME_DAY_SECONDS / 24.0`.
- Other current buildings have zero resident/job capacity for now.
- Keep `Sim.home: Point` and `Sim.workplace: Option<Point>`; do not add building relationship IDs.
- Remove the dormant one-value `moveInRate` contract instead of replacing it with another configuration value.
- Bump the current development snapshot schema once; no migration, dual reader, or compatibility alias.
- No generic population/job framework, event bus, scheduler service, ECS, citywide occupancy control, visitor demand, cars, or campaign work.

---

## File map

**Create**

- `crates/caelum-core/src/population.rs` — fixed move-in cadence, resident occupancy/boundaries, resident cleanup.
- `crates/caelum-core/tests/population.rs` — vertical Rust behavior and determinism regressions.

**Modify**

- `crates/caelum-core/src/model.rs` — schema v5, placed-building capacity/time, remove `MoveInRateSelection`.
- `crates/caelum-core/src/building_catalog.rs` — resident/job authored capacities.
- `crates/caelum-core/src/buildings.rs` — record placement data, stop immediate spawning, capacity-aware jobs.
- `crates/caelum-core/src/trips.rs` — apply/track move-in boundaries and substep budget.
- `crates/caelum-core/src/transit.rs` — occupied-housing cleanup and workplace reassignment.
- `crates/caelum-core/src/sandbox.rs` — remove `move_in_rate` request/settings validation.
- `crates/caelum-core/src/lib.rs` — register population module.
- `crates/caelum-core/tests/areas_buildings.rs` — replace immediate-spawn expectations.
- `crates/caelum-core/tests/model_wire_format.rs` — schema-v5 wire shape.
- `crates/caelum-core/tests/sandbox_factory.rs` and `sandbox_coverage.rs` — current request/settings shape.
- `src/domain/types.ts` — schema v5, placed-building fields, remove move-in setting.
- `src/domain/catalog/buildings.ts` — remove `citizenCount` mirror.
- `src/runtime/backend/types.ts`, `src/runtime/workingSaveRuntime.ts`, `src/runtime/backend/sandboxErrors.ts` — current sandbox request/error shape.
- `src/runtime/types.ts`, `src/runtime/runtimeSelectors.ts` — building inspector union/selector.
- `src/components/hud/panels/InspectPanel.svelte` — building occupancy rendering.
- `tests/fixtures/rustSnapshot.ts` — schema-v5 fixture.
- current WASM/Tauri/working-save tests that assert `moveInRate` — remove the obsolete field from expectations.
- `tests/runtime/runtimeSelectors.test.ts` — building inspector coverage.
- `tests/e2e/smoke.spec.ts` — real paused→first-move-in UI proof.
- `docs/architecture.md` — current population ownership and schema contract.

---

### Task 1: Make the schema describe capacity instead of immediate population

**Files:** `model.rs`, `building_catalog.rs`, `sandbox.rs`, `domain/types.ts`, `domain/catalog/buildings.ts`, backend/request types, current snapshot/sandbox fixtures.

**Interfaces:**

- Produces `PlacedBuilding.placed_at/placedAt`, `resident_capacity/residentCapacity`, and `job_capacity/jobCapacity`.
- Produces Rust `BuildingDefinition.resident_capacity` and `job_capacity`.
- Removes the old `citizen_count/citizenCount` and `move_in_rate/moveInRate` contracts.

- [ ] **Step 1: Write failing wire/catalog tests.**

In `crates/caelum-core/tests/model_wire_format.rs`, assert schema 5 and the placed-building fields:

```rust
assert_eq!(SNAPSHOT_SCHEMA_VERSION, 5);
let json = serde_json::to_value(snapshot).unwrap();
assert!(json["rules"]["sandbox"].get("moveInRate").is_none());
assert_eq!(json["buildings"][0]["placedAt"], 0.0);
assert_eq!(json["buildings"][0]["residentCapacity"], 4);
assert_eq!(json["buildings"][0]["jobCapacity"], 0);
```

In `tests/fixtures/rustSnapshot.ts`, make the canonical fixture use `schemaVersion: 5`, remove `moveInRate`, and give every placed-building fixture all three new fields.

- [ ] **Step 2: Run the focused tests and confirm they fail on schema 4 / missing fields.**

```bash
cargo test -p caelum-core --test model_wire_format
bun run test:unit -- tests/runtime/wasmBackend.test.ts tests/runtime/tauriBackend.test.ts tests/runtime/workingSaveRuntime.test.ts
```

- [ ] **Step 3: Implement the direct schema break.**

Use this model/catalog shape:

```rust
pub const SNAPSHOT_SCHEMA_VERSION: u16 = 5;

pub struct PlacedBuilding {
    // existing identity/geometry fields
    pub placed_at: f64,
    pub resident_capacity: u16,
    pub job_capacity: u16,
    // existing transit_node_id
}

pub struct BuildingDefinition {
    // existing catalog fields
    pub resident_capacity: u16,
    pub job_capacity: u16,
}
```

Set `smallHouse = (4 residents, 0 jobs)`, `supermarket = (0, 4)`, and all other current definitions to zero/zero. Remove `MoveInRateSelection`, the sandbox field/request field, `UnknownMoveInRate`, parsing, and the hard-coded TypeScript `moveInRate: "paused"` call sites. Remove `citizenCount` from the TS catalog rather than adding new TS capacity constants.

- [ ] **Step 4: Update current fixtures/host assertions only and run the schema surface.**

```bash
cargo test -p caelum-core --test model_wire_format --test sandbox_factory --test sandbox_coverage
bun run test:unit -- tests/runtime/wasmBackend.test.ts tests/runtime/tauriBackend.test.ts tests/runtime/workingSaveRuntime.test.ts
bun run check
```

Do not add schema-v4 readers or migration tests.

- [ ] **Step 5: Commit.**

```bash
git add crates/caelum-core src tests/fixtures tests/runtime
 git commit -m "refactor(core): define phase 2 building capacity snapshot"
```

---

### Task 2: Add deterministic Small House move-in to the existing tick scheduler

**Files:** create `population.rs`, modify `lib.rs`, `buildings.rs`, `trips.rs`, create `tests/population.rs`, update `areas_buildings.rs`.

**Interfaces:**

- Produces `population::MOVE_IN_INTERVAL_SECONDS`.
- Produces `resident_occupancy`, `next_move_in_boundary_after`, `remaining_move_in_slots`, `apply_due_move_ins`, and `remove_residents_for_building`.
- `PlaceBuilding` records `placed_at = state.time` plus capacities and no longer creates residents synchronously.

- [ ] **Step 1: Write the failing Small House lifecycle tests.**

Add `crates/caelum-core/tests/population.rs` with an engine helper that zones and places `smallHouse`, then assert:

```rust
assert!(placed.snapshot.sims.is_empty());
engine.dispatch(GameIntent::SetPaused { paused: false });
let first = engine.tick(0.001);
assert_eq!(first.snapshot.sims.len(), 1);
assert_eq!(first.snapshot.sims[0].id, "sim-001");
```

For granularity, build the same house in two engines and compare one `150.0` second tick with three `50.0` second ticks:

```rust
coarse.tick(150.0);
for _ in 0..3 { fine.tick(50.0); }
assert_eq!(coarse.snapshot().sims, fine.snapshot().sims);
assert_eq!(coarse.snapshot().sims.len(), 4);
```

Also assert another hour does not exceed four residents.

- [ ] **Step 2: Run the tests and confirm current immediate four-sim placement fails the new contract.**

```bash
cargo test -p caelum-core --test population --test areas_buildings
```

- [ ] **Step 3: Implement `population.rs` with occupancy-derived progress.**

Use the fixed interval and due-time formula:

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

`apply_due_move_ins` clones/sorts the resident-capacity building list by `id`; while the next slot is due at `state.time`, allocate a sim with existing `next_entity_id`, `worker_profile_for_id`, and `shift_template_for_id`, choosing `home = occupied_tiles[occupancy % occupied_tiles.len()]`. After adding due residents, call the existing `assign_workplaces` once.

In `place_building_core`, record the three new placed-building fields and delete the old `definition.citizen_count` loop.

- [ ] **Step 4: Join population to the existing substep scheduler.**

In `trips.rs`, centralize growth + population due-events without introducing a framework:

```rust
fn apply_due_world_events(state: &mut GameSnapshot) {
    crate::growth::apply_due_growth_waves(state);
    crate::population::apply_due_move_ins(state);
}
```

Use it everywhere the tick pipeline currently applies due growth, then add:

```rust
if let Some(boundary) = crate::population::next_move_in_boundary_after(state) {
    track_next_boundary(&mut next, boundary, state.time);
}
```

and in `max_tick_substeps`:

```rust
.saturating_add(crate::population::remaining_move_in_slots(state))
```

Keep the current post-growth sim-count cap widening intact.

- [ ] **Step 5: Run the deterministic core tests.**

```bash
cargo test -p caelum-core --test population --test areas_buildings --test trip_lifecycle --test golden_sequences
cargo clippy -p caelum-core --all-targets -- -D warnings
```

- [ ] **Step 6: Commit.**

```bash
git add crates/caelum-core/src crates/caelum-core/tests
 git commit -m "feat(core): add deterministic Small House move-in"
```

---

### Task 3: Cap Supermarket jobs and prove the existing commute handoff

**Files:** `buildings.rs`, `tests/population.rs`; only touch `trips.rs` if a focused regression exposes a real handoff bug.

**Interfaces:** `assign_workplaces(&mut GameSnapshot)` remains the one assignment function; downstream commute code continues reading `Sim.workplace: Option<Point>`.

- [ ] **Step 1: Add failing job-capacity tests.**

Fill two Small Houses (eight sims), place one Supermarket, then assert exactly four workers are assigned:

```rust
let assigned = snapshot.sims.iter()
    .filter(|sim| sim.worker_profile == WorkerProfile::Worker && sim.workplace.is_some())
    .count();
assert_eq!(assigned, 4);
```

Add a coarse-tick commute proof using the existing deterministic departure function:

```rust
let minute = departure_minute_for_sim("sim-001", "standard", "outbound");
let departure = f64::from(minute) / f64::from(MINUTES_PER_DAY) * GAME_DAY_SECONDS;
engine.tick(departure);
assert!(engine.snapshot().active_trips.iter().any(|trip|
    trip.sim_id == "sim-001" && trip.purpose == TripPurpose::CommuteOutbound
));
```

Build the Supermarket before ticking so the first resident receives a job as it moves in.

- [ ] **Step 2: Run and observe the current unlimited-destination failure.**

```bash
cargo test -p caelum-core --test population
```

- [ ] **Step 3: Rewrite `assign_workplaces` around finite placed-building slots.**

Clone/sort workplace descriptors by building ID. Count preserved valid worker assignments into each footprint first. For each unassigned worker in stable sim order, choose the first workplace with `used < job_capacity`, assign:

```rust
let slot = used_count;
sim.workplace = Some(workplace.occupied_tiles[slot % workplace.occupied_tiles.len()]);
used_count += 1;
```

Workers beyond all current capacity remain `None`. Do not create job records or per-tile capacity state.

- [ ] **Step 4: Run assignment + commute regressions.**

```bash
cargo test -p caelum-core --test population --test trip_lifecycle --test router_planning
```

- [ ] **Step 5: Commit.**

```bash
git add crates/caelum-core/src/buildings.rs crates/caelum-core/tests/population.rs
 git commit -m "feat(core): cap Supermarket jobs"
```

---

### Task 4: Make occupied-building demolition leave no dangling current state

**Files:** `population.rs`, `transit.rs`, `tests/population.rs`, and existing area/building demolition tests as needed.

**Interfaces:** `population::remove_residents_for_building(&mut GameSnapshot, &PlacedBuilding)` is called only by the authoritative building-removal path.

- [ ] **Step 1: Add failing demolition regressions.**

For workplace removal: create workers plus two Supermarkets, verify assignments, demolish one, and assert every remaining non-null workplace belongs to the surviving Supermarket and its occupancy is at most four.

For housing removal: create a populated Small House, attach a focused active trip and vehicle passenger reference for `sim-001`, call the housing cleanup/removal path, then assert:

```rust
assert!(!snapshot.sims.iter().any(|sim| sim.id == "sim-001"));
assert!(!snapshot.active_trips.iter().any(|trip| trip.sim_id == "sim-001"));
assert!(snapshot.transit.vehicles.iter().all(|vehicle|
    !vehicle.passenger_ids.iter().any(|id| id == "trip-001")
));
```

A minimal vehicle fixture uses the current `Vehicle` fields with `mode: TransitMode::Bus`, `capacity: 18`, zeroed itinerary/path progress, and `passenger_ids: vec!["trip-001".into()]`.

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

In `transit::remove_at_tile`, call that helper when the removed building has resident capacity. Keep the existing destination cleanup for a removed workplace; after it clears affected references, call `assign_workplaces` once when job capacity was removed.

- [ ] **Step 4: Run core + persistence validation regressions.**

```bash
cargo test -p caelum-core --test population --test areas_buildings --test persistence_validation
cargo test --workspace
```

If the repository has no `persistence_validation` integration target, use the existing persistence test target reported by `cargo test -p caelum-core -- --list`; do not add a new validation framework solely for this step.

- [ ] **Step 5: Commit.**

```bash
git add crates/caelum-core/src/population.rs crates/caelum-core/src/transit.rs crates/caelum-core/tests
 git commit -m "fix(core): clean occupancy on building demolition"
```

---

### Task 5: Show the two capacity values in the existing Select inspector and real smoke flow

**Files:** `runtime/types.ts`, `runtime/runtimeSelectors.ts`, `InspectPanel.svelte`, `runtimeSelectors.test.ts`, `e2e/smoke.spec.ts`, `docs/architecture.md`.

**Interfaces:** `ShellInspectorState` becomes a discriminated `transit | building` union. No backend API changes.

- [ ] **Step 1: Add failing selector tests for both building metrics.**

Use the canonical Rust snapshot fixture with one placed Small House / one sim and one Supermarket / one assigned worker. Select a footprint point and assert:

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

Add the corresponding `Jobs` assertion and keep an existing transit-node inspector assertion with `kind: "transit"`.

- [ ] **Step 2: Run and confirm the current selector returns `null` for non-transit buildings.**

```bash
bun run test:unit -- tests/runtime/runtimeSelectors.test.ts
```

- [ ] **Step 3: Implement the union and renderer.**

In `runtimeSelectors.ts`, keep current transit resolution first. Otherwise find the selected building by `occupiedTiles`, choose `residentCapacity` or `jobCapacity`, and count matching `sim.home` / `sim.workplace` points. Return `null` for zero-capacity buildings.

In `InspectPanel.svelte`, preserve the platform markup under `inspector.kind === "transit"`; for `building`, render the existing inspection-card shell with the building label plus:

```svelte
<span class="building-occupancy">
  {inspector.metricLabel} {inspector.occupancy} / {inspector.capacity}
</span>
```

No new panel component is required for one row.

- [ ] **Step 4: Update the existing Playwright smoke flow.**

After placing Supermarket then Small House while still paused:

```ts
await expect(populationReadout.getByText("0")).toBeVisible();
await page.getByTestId("command-tool-select").click();
await clickMapTile(canvas, { x: 1, y: 1 });
await expect(page.getByTestId("panel-inspect")).toContainText("Residents 0 / 4");
await clickMapTile(canvas, { x: 5, y: 1 });
await expect(page.getByTestId("panel-inspect")).toContainText("Jobs 0 / 4");
```

Resume and poll only for the first move-in, which is due immediately at the placement timestamp:

```ts
await page.getByRole("button", { name: "Resume" }).click();
await expect.poll(async () => (await populationReadout.locator(".readout-value").textContent())?.trim())
  .toBe("1");
```

Then inspect both buildings again and assert `Residents 1 / 4` and `Jobs 1 / 4`. Do not wait until the 07:01 commute departure in Playwright; Task 3 proves that in Rust.

- [ ] **Step 5: Update current architecture documentation and run user-facing gates.**

Document that Rust owns placed-building capacity, deterministic move-in, and workplace assignment; the shell only derives display occupancy. Remove stale schema-4 / `moveInRate` statements.

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
git add src tests docs/architecture.md
 git commit -m "feat(ui): show building occupancy in Select"
```

---

## Final self-review / release gate

- [ ] `smallHouse` is the only resident-capacity building and never exceeds four sims.
- [ ] `supermarket` is the only job-capacity building and never exceeds four assigned workers.
- [ ] no immediate placement-time population loop remains in `buildings.rs`.
- [ ] `moveInRate` and `citizenCount` are removed rather than deprecated.
- [ ] no home/workplace building IDs, household/job entities, scheduler service, ECS, or event bus were introduced.
- [ ] coarse/fine population + assignment tests pass.
- [ ] commute handoff test proves the current trip engine consumes the new worker state.
- [ ] occupied housing/workplace demolition leaves no current dangling references.
- [ ] shared UI shows the two capacity values and existing transit inspection still works.
- [ ] all current schema fixtures are v5; no compatibility paths were added.
