# Phase 2 Occupancy and Job Demand Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace immediate housing population and unlimited destination jobs with deterministic move-in and finite per-type capacity while preserving all current building demand behavior and showing occupancy through Select.

**Architecture:** Keep `Sim.home` / `Sim.workplace` as points. Schema v5 persists only `PlacedBuilding.placedAt`; capacities stay in the existing Rust building catalog with the existing TypeScript catalog as a presentation mirror. A focused `population.rs` joins the six current trip-substep event passes; assignment stays in `buildings.rs`, demolition in `transit.rs`, and the UI derives occupancy from snapshot sims.

**Tech Stack:** Rust `caelum-core`, Serde, TypeScript, Svelte 5, Vitest, Playwright, Bun.

## Global constraints

- Schema v5 adds only `placed_at/placedAt` to `PlacedBuilding`.
- Replace `citizen_count/citizenCount` with per-type resident/job capacity in the existing catalogs; do not persist capacity.
- Small House = 4 residents; Large House = 10 residents.
- Preserve every current destination as a workplace with footprint-area job capacity: Supermarket 4, Cinema 6, Factory 6, Warehouse 6, Office Tower 4, Business Park 6, Clinic 4, School 6, Park Plaza 4.
- Transit buildings = 0 residents / 0 jobs.
- Workplace membership is `building_definition(type).job_capacity > 0`; commute code must stop using `effect == "destination"`.
- Move-in interval is `GAME_DAY_SECONDS / 24.0`; due means `due_time <= state.time`.
- Population move-in applies only in the shipped Sandbox workflow. Do not modify `growth.rs` or add source/player-built state for dormant Campaign growth.
- A worker moving in after today's outbound departure does not receive a retroactive commute; normal commuting starts after the next day reset.
- Remove `moveInRate`, home-fallback, and schema-v4 compatibility directly.
- No relationship IDs, job entities, scheduler service, ECS, event bus, migration, or compatibility layer.

## File map

**Create:**
- `crates/caelum-core/src/population.rs`
- `crates/caelum-core/tests/population.rs`

**Modify:**
- Core: `model.rs`, `building_catalog.rs`, `buildings.rs`, `trips.rs`, `transit.rs`, `sandbox.rs`, `lib.rs`
- Rust tests: `areas_buildings.rs`, `golden_sequences.rs`, `model_wire_format.rs`, `sandbox_factory.rs`, `sandbox_coverage.rs`, `trip_lifecycle.rs`, `transit_build.rs`
- TS: `src/domain/types.ts`, `src/domain/catalog/buildings.ts`, `src/runtime/backend/types.ts`, `src/runtime/workingSaveRuntime.ts`, `src/runtime/backend/sandboxErrors.ts`, `src/runtime/types.ts`, `src/runtime/runtimeSelectors.ts`, `src/components/hud/panels/InspectPanel.svelte`
- TS fixtures/tests: `tests/helpers/gameState.ts`, `tests/fixtures/rustSnapshot.ts`, `tests/runtime/wasmBackend.test.ts`, `tests/runtime/tauriBackend.test.ts`, `tests/runtime/workingSaveRuntime.test.ts`, `tests/runtime/gameRuntime.test.ts`, `tests/runtime/runtimeSelectors.test.ts`, `tests/render/overlayRenderer.test.ts`, `tests/e2e/smoke.spec.ts`
- Docs: `docs/architecture.md`

---

### Task 1: Schema v5 + complete capacity catalog + one workplace definition

**Produces:** `PlacedBuilding.placed_at`, Rust/TS resident/job catalog metadata, and one workplace-membership helper.

- [ ] **1. Add failing schema/catalog assertions.**

```rust
assert_eq!(SNAPSHOT_SCHEMA_VERSION, 5);
let json = serde_json::to_value(snapshot).unwrap();
assert_eq!(json["buildings"][0]["placedAt"], 0.0);
assert!(json["buildings"][0].get("residentCapacity").is_none());
assert!(json["buildings"][0].get("jobCapacity").is_none());
assert!(json["rules"]["sandbox"].get("moveInRate").is_none());
```

Pin representative catalog values in Rust and TS: Small House `4/0`, Large House `10/0`, Supermarket `0/4`, Factory `0/6`.

- [ ] **2. Implement the direct schema break.**

```rust
pub const SNAPSHOT_SCHEMA_VERSION: u16 = 5;

pub struct PlacedBuilding {
    // existing fields
    pub placed_at: f64,
    // transit_node_id remains
}

pub struct BuildingDefinition {
    // existing static fields
    pub resident_capacity: u16,
    pub job_capacity: u16,
}
```

At the existing `place_building_core` construction site write `placed_at: state.time`. Keep the function's current four arguments. For this Task-1 intermediate gate, keep immediate spawning but replace the loop bound with `definition.resident_capacity`; Task 2 deletes that loop.

Fill the exact capacity table from Global constraints in Rust and mirror it in `src/domain/catalog/buildings.ts` as `residentCapacity` / `jobCapacity` for UI presentation.

- [ ] **3. Replace effect-based workplace authority.**

```rust
pub fn workplace_points(state: &GameSnapshot) -> Vec<Point> {
    state.buildings.iter()
        .filter(|building| building_definition(&building.building_type)
            .is_some_and(|definition| definition.job_capacity > 0))
        .flat_map(|building| building.occupied_tiles.iter().copied())
        .collect()
}
```

Use it in current `assign_workplaces`, `trips.rs::has_valid_workplace_destination`, and removed-workplace tile collection in `transit.rs`. Do not use `effect == "destination"` for commute/workplace behavior afterward.

- [ ] **4. Remove `moveInRate` and update every required literal.**

Run both inventories:

```bash
rg -n 'PlacedBuilding \{' crates/caelum-core
rg -n 'occupiedTiles' src tests
```

Add `placed_at: 0.0` / `placedAt: 0` to every actual `PlacedBuilding` literal/builder. This explicitly includes direct literals in `tests/runtime/gameRuntime.test.ts`, `tests/render/overlayRenderer.test.ts`, shared fixture builders, and all Rust commute/transit fixtures. Do not add capacity fields to placed-building literals.

- [ ] **5. Verify the compile-ready gate and commit.**

```bash
cargo test --workspace
bun run test:unit
bun run check
cargo clippy --workspace --all-targets -- -D warnings

git add crates/caelum-core src tests
git commit -m "refactor(core): define phase 2 building capacity catalog"
```

---

### Task 2: Deterministic Sandbox move-in, including missed departures

**Produces:** `population.rs` due processing; removes immediate resident spawning.

- [ ] **1. Write failing move-in tests.**

Small House while paused has zero sims. First running tick creates `sim-001`. Compare one `150.0` tick with three `50.0` ticks and require identical sims with four Small House residents. Add Large House coverage proving it fills to 10 and stops.

Change the no-tick golden in `golden_sequences.rs` from 4 sims to 0.

- [ ] **2. Add a missed-departure regression.**

Build a Sandbox state after `sim-001`'s deterministic outbound departure, place housing + a valid workplace, run the due first move-in, and assert no current-day outbound trip is spawned. Advance through next day reset to that worker's next outbound time and assert a normal commute can spawn.

Calculate the departure with existing `departure_minute_for_sim`; do not hard-code a clock time.

- [ ] **3. Implement occupancy-derived due processing.**

```rust
pub const MOVE_IN_INTERVAL_SECONDS: f64 = crate::clock::GAME_DAY_SECONDS / 24.0;

pub fn resident_occupancy(state: &GameSnapshot, building: &PlacedBuilding) -> usize {
    state.sims.iter()
        .filter(|sim| building.occupied_tiles.contains(&sim.home))
        .count()
}
```

Population helpers no-op outside `GameMode::Sandbox`. For each housing building in stable ID order, resolve `resident_capacity` from `building_definition` and process slots while:

```rust
let due = building.placed_at + occupancy as f64 * MOVE_IN_INTERVAL_SECONDS;
if due > state.time { break; } // therefore due <= state.time is applied
```

Reuse `next_entity_id`, `worker_profile_for_id`, `shift_template_for_id`, and footprint rotation. Delete the placement-time resident loop.

- [ ] **4. Initialize new workers against today's departure.**

Set `commute_day = state.day`. Compute today's outbound timestamp from the existing deterministic departure minute. If `state.time` is strictly after it, initialize `outbound_resolved_today = true`, `outbound_arrived_today = false`; otherwise leave outbound unresolved. Leave return flags false. At exact departure, the current-time spawn remains allowed.

After adding due residents, call `assign_workplaces` once.

- [ ] **5. Reuse all six trip current-time passes.**

```rust
fn apply_due_world_events(state: &mut GameSnapshot) {
    crate::growth::apply_due_growth_waves(state);
    crate::population::apply_due_move_ins(state);
}
```

Replace all six direct growth calls inside `tick_trips_substepped`. Verify:

```bash
rg -n 'apply_due_growth_waves\(&mut next\)' crates/caelum-core/src/trips.rs
```

Expected inside that function: zero direct calls. Add only future Sandbox move-in timestamps to `next_boundary_after`, add remaining resident slots to `max_tick_substeps`, and retain sim-count cap widening.

- [ ] **6. Keep golden semantics, not incidental float bits.**

Require coarse/fine equivalence and the same spawned/served commute set. If added 50/100/150-second boundaries change only exact float metrics in the last digits, refresh those float goldens with a one-line note rather than forcing the previous partition.

- [ ] **7. Verify and commit.**

```bash
cargo test -p caelum-core --test population --test areas_buildings --test golden_sequences --test trip_lifecycle
cargo test -p caelum-core growth::tests
cargo clippy -p caelum-core --all-targets -- -D warnings

git add crates/caelum-core/src/population.rs crates/caelum-core/src/lib.rs crates/caelum-core/src/buildings.rs crates/caelum-core/src/trips.rs crates/caelum-core/tests/population.rs crates/caelum-core/tests/areas_buildings.rs crates/caelum-core/tests/golden_sequences.rs
git commit -m "feat(core): add deterministic Sandbox housing move-in"
```

---

### Task 3: Occupied-house cleanup, freed-job refill, home-fallback deletion

- [ ] **1. Add demolition regressions.**

A demolished occupied house removes every resident whose `home` is in its footprint, their active trips, and those trip IDs from vehicle passengers.

Add the load-bearing case: two filled Small Houses + one Supermarket. Four workers are employed and four surplus. Demolish the house containing the employed workers; assert the four surviving workers immediately refill the Supermarket to four jobs.

- [ ] **2. Implement resident cleanup and exactly one refill pass.**

Collect resident IDs by home-footprint membership, collect their trip IDs, retain sims/trips/passengers, then call:

```rust
crate::buildings::assign_workplaces(state);
```

exactly once at the end of resident removal. Invoke this path when the removed building's Rust definition has `resident_capacity > 0`.

- [ ] **3. Delete home-fallback.**

Remove `workplace == home` assignment special handling, `is_home_fallback_trip`, `retarget_home_fallback_trips`, their placement/workplace-cleanup calls/comments, and regressions that exist only because demolished housing previously left residents alive.

```bash
rg -n 'home.?fallback|retarget_home_fallback|is_home_fallback' crates/caelum-core/src crates/caelum-core/tests
```

Expected after Task 3: no supported home-fallback contract remains.

- [ ] **4. Verify and commit.**

```bash
cargo test -p caelum-core --test population --test areas_buildings --test trip_lifecycle --test golden_sequences
cargo test --workspace

git add crates/caelum-core/src/population.rs crates/caelum-core/src/transit.rs crates/caelum-core/src/buildings.rs crates/caelum-core/src/trips.rs crates/caelum-core/tests/population.rs crates/caelum-core/tests/areas_buildings.rs crates/caelum-core/tests/trip_lifecycle.rs
git commit -m "refactor(core): remove orphaned housing fallback"
```

---

### Task 4: Finite stable-order job assignment for all current workplaces

- [ ] **1. Add finite-capacity tests.**

Two Small Houses + one Supermarket must assign at most four workers. Add Factory coverage proving it remains a functioning workplace with capacity six. Keep workplace-demolition coverage proving cleared workers are reassigned only up to surviving capacity.

- [ ] **2. Rewrite `assign_workplaces`.**

Sort current `job_capacity > 0` placed buildings by ID. Preserve existing assignments only while the matching building still has an unused slot; clear stale/over-capacity assignments. Then fill open slots in stable sim order. Map slot `used` to:

```rust
workplace.occupied_tiles[used % workplace.occupied_tiles.len()]
```

Excess workers remain unassigned. There is no same-home exception after Task 3.

- [ ] **3. Keep one workplace-demolition reassignment.**

The existing cleanup remains:

```text
clear affected workplace
assign_workplaces(state)   // once
retarget/drop affected outbound trips
strip invalidated passenger trip IDs
```

Do not add another assignment before or after it.

- [ ] **4. Verify and commit.**

```bash
cargo test -p caelum-core --test population --test trip_lifecycle --test golden_sequences --test router_planning
cargo test --workspace

git add crates/caelum-core/src/buildings.rs crates/caelum-core/src/transit.rs crates/caelum-core/tests/population.rs crates/caelum-core/tests/trip_lifecycle.rs
git commit -m "feat(core): add finite building job capacity"
```

---

### Task 5: Building inspector + race-free existing E2E smoke

- [ ] **1. Add selector tests and discriminated inspector.**

`ShellInspectorState` becomes `kind: "transit" | "building"`. Building inspector includes `buildingId`, label, `Residents | Jobs`, derived occupancy, and capacity from the existing TS building catalog. Transit resolution keeps priority. No backend query or persisted occupancy/capacity field.

- [ ] **2. Render the building branch.**

```svelte
<span class="building-occupancy">
  {inspector.metricLabel} {inspector.occupancy} / {inspector.capacity}
</span>
```

- [ ] **3. Splice into `tests/e2e/smoke.spec.ts`; do not replace its tail.**

While paused after current Supermarket + Small House placement, assert population `0`, `Residents 0 / 4`, and `Jobs 0 / 4`. Keep the existing road and bus-terminal steps.

At the existing Resume point, poll population to `1`, then immediately Pause and wait until the control reads Resume again. Only then inspect `Residents 1 / 4` / `Jobs 1 / 4`. Resume again if needed for the existing visible-clock assertion. Keep the road, bus-terminal, and clock coverage intact.

- [ ] **4. Update architecture docs, run full gates, commit.**

```bash
bun run test:unit
bun run check
bun run test:e2e -- tests/e2e/smoke.spec.ts
bun run format:check
bun run lint
cargo test --workspace

git add src/domain/catalog/buildings.ts src/runtime src/components/hud/panels/InspectPanel.svelte tests/runtime/runtimeSelectors.test.ts tests/e2e/smoke.spec.ts docs/architecture.md
git commit -m "feat(ui): show building occupancy in Select"
```

---

## Final verification checklist

- [ ] schema v5 persists `placedAt` only; no capacity/source fields are persisted.
- [ ] Small House 4 and Large House 10 remain functional housing.
- [ ] all nine current destinations remain functional workplaces with footprint-area finite capacity.
- [ ] no commute/workplace path uses `effect == "destination"`.
- [ ] all six current-time growth sites also apply due Sandbox move-ins using `<= state.time`.
- [ ] mid-day move-in does not backfill a missed outbound commute and normal next-day commuting is proven.
- [ ] occupied-house demolition removes resident/trip/passenger references and performs one freed-job refill.
- [ ] home-fallback source/tests are gone.
- [ ] workplace demolition still performs one reassignment only.
- [ ] both Rust and TS placed-building inventories were run; direct `gameRuntime.test.ts` and `overlayRenderer.test.ts` literals compile with `placedAt`.
- [ ] long commute tests protect coarse/fine + trip semantics, allowing justified float-golden refresh.
- [ ] E2E pauses after the first move-in before reading `1 / 4` and retains road/bus-terminal/clock coverage.
- [ ] `moveInRate` and `citizenCount` are removed, not deprecated.
- [ ] no relationship IDs, job entities, scheduler service, ECS, event bus, migration, or compatibility path was added.
