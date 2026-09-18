# Workplace Commute Patterns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Office Tower workers use standard shifts and Factory workers use deterministic early/late shifts, then expose staffing/current demand clearly in the existing UI and Small Town sandbox.

**Architecture:** Keep `Routine::Worker.shift_template` as the only authoritative worker schedule state. Office/Factory provide assignment-time overrides; unfeatured workplaces preserve the current Worker template. Make the existing `schedule_activity` seam safely supersede prior wakes, reuse aggregate `buildingOccupancy`/`demandFlow`, keep Small Town optional outings live, and make selected-building WebGPU emphasis generic. No new schema, query, renderer, scheduling registry, or per-citizen UI payload.

**Tech Stack:** Rust (`caelum-core`, Bevy ECS), TypeScript, Svelte 5, WebGPU, Vitest, Playwright, Bun.

**Spec:** `docs/superpowers/specs/2026-09-17-workplace-commute-patterns-design.md`

## Global Constraints

- One Linear ticket = one GitHub PR. Continue implementation on this HPA-463 PR; do not open implementation/QA follow-up PRs.
- Office Tower workers use canonical `standard` windows.
- Factory workers use canonical `early` or `late` windows selected deterministically from citizen identity and stable across days/reloads.
- Other workplaces provide no workplace-specific override and preserve the Worker's current stored template.
- Students, days off, optional outings, trip mode choice, finite job capacity, and one-active-trip lifecycle stay unchanged.
- Office/Factory assignment/reassignment may update the existing `Routine::Worker.shift_template`; unfeatured workplaces leave it unchanged. Never add a second schedule authority.
- Never rewrite/restart an already-active trip solely because a worker's workplace changed.
- No persistence/schema change unless implementation discovers an unavoidable contract break. Do not add backward compatibility or migration code.
- Rust remains simulation authority. TypeScript receives only existing aggregates and local display metadata.
- No new image art.
- HPA-464 owns stop queues, line warnings, and stop/line navigation.

---

## File map

- `crates/caelum-core/src/commute.rs` — Office/Factory workplace-shift override plus a Rust drift guard for the UI window copy.
- `crates/caelum-core/src/population/schedule.rs` — apply assignment overrides and centralize activity supersession in `schedule_activity` while preserving active-trip retarget/drop behavior.
- `crates/caelum-core/tests/population.rs` — end-to-end Rust assignment/reassignment/save-restore behavior.
- `crates/caelum-core/src/sandbox.rs` — add one Small House + Office Tower while retaining Small Town's Supermarket and Factory.
- `crates/caelum-core/tests/sandbox_factory.rs` — template contract.
- `src/domain/catalog/buildings.ts` — player-facing work-pattern copy only.
- `src/runtime/types.ts` — two small derived inspector fields.
- `src/runtime/runtimeSelectors.ts` — selected workplace demand aggregation and shared selected-point parser.
- `src/components/hud/panels/BuildPanel.svelte` — one generic armed-building facts summary near the existing Rotate control.
- `src/components/hud/panels/InspectPanel.svelte` — staffing/pattern/current-demand states.
- `src/render/webgpu/overlayBatch.ts` — generic selected-building outline/current-demand emphasis; no Office/Factory type checks.
- `tests/runtime/buildingCatalog.test.ts` — copy/catalog contract.
- `tests/runtime/runtimeSelectors.test.ts` — inspector aggregation contract.
- `tests/render/webgpuOverlayBatch.test.ts` — exact selected-building render geometry/color/alpha.
- `tests/ui/buildPanel.test.ts` — Build facts for Office/Factory.
- Create: `tests/ui/inspectPanel.test.ts` — isolated InspectPanel copy/state coverage using the existing Testing Library pattern; this is a test file, not a new harness.
- `tests/e2e/newCity.spec.ts` — one real-WASM Small Town proof.

---

### Task 1: Add the workplace-shift override and guard the UI schedule copy

**Files:**
- Modify: `crates/caelum-core/src/commute.rs`

**Interfaces:**
- Consumes: existing `numeric_id_suffix(id)`, `shift_template_for_id(id)`, and `departure_minute_for_sim(...)`.
- Produces: `pub fn workplace_shift_template(citizen_id: &str, building_type: &str) -> Option<&'static str>` where `Some` is an Office/Factory override and `None` means keep the current Worker template.

- [ ] **Step 1: Write focused failing unit tests**

Add tests in `commute.rs` that pin all three rule branches:

```rust
#[test]
fn office_workers_always_use_standard_shift() {
    for id in ["sim-001", "sim-008", "sim-009"] {
        assert_eq!(
            workplace_shift_template(id, "officeTower"),
            Some("standard")
        );
    }
}

#[test]
fn factory_workers_use_stable_early_or_late_identity_buckets() {
    assert_eq!(workplace_shift_template("sim-001", "factory"), Some("early"));
    assert_eq!(workplace_shift_template("sim-002", "factory"), Some("late"));
    assert_eq!(workplace_shift_template("sim-001", "factory"), Some("early"));
}

#[test]
fn unfeatured_workplaces_do_not_override_current_worker_shift() {
    for building_type in ["warehouse", "supermarket", "businessPark", "clinic"] {
        assert_eq!(workplace_shift_template("sim-008", building_type), None);
    }
}
```

The exact Factory mapping is odd numeric suffix → `early`, even → `late`. The helper never decides Worker vs Student; callers classify first, and `None` means only “no workplace override.”

- [ ] **Step 2: Add a Rust drift guard for the TypeScript pattern copy**

Add a unit test beside the simulation authority that pins all standard/early/late window endpoints consumed by `src/domain/catalog/buildings.ts`:

```rust
// Consumer: src/domain/catalog/buildings.ts workPattern for Office Tower / Factory.
assert_eq!(departure_minute_for_sim("sim-121", "standard", "outbound"), 420);
assert_eq!(departure_minute_for_sim("sim-120", "standard", "outbound"), 540);
assert_eq!(departure_minute_for_sim("sim-121", "standard", "return"), 1_020);
assert_eq!(departure_minute_for_sim("sim-120", "standard", "return"), 1_140);
assert_eq!(departure_minute_for_sim("sim-091", "early", "outbound"), 330);
assert_eq!(departure_minute_for_sim("sim-090", "early", "outbound"), 420);
assert_eq!(departure_minute_for_sim("sim-091", "early", "return"), 900);
assert_eq!(departure_minute_for_sim("sim-090", "early", "return"), 990);
assert_eq!(departure_minute_for_sim("sim-091", "late", "outbound"), 600);
assert_eq!(departure_minute_for_sim("sim-090", "late", "outbound"), 690);
assert_eq!(departure_minute_for_sim("sim-091", "late", "return"), 1_170);
assert_eq!(departure_minute_for_sim("sim-090", "late", "return"), 1_260);
```

This keeps prose out of the wire contract while making Rust window changes fail near the owning constants.

- [ ] **Step 3: Run the tests and verify they fail**

Run:

```bash
cargo test -p caelum-core commute::
```

Expected: compile failure because `workplace_shift_template` does not exist.

- [ ] **Step 4: Implement the minimal helper**

Add next to `shift_template_for_id`:

```rust
pub fn workplace_shift_template(
    citizen_id: &str,
    building_type: &str,
) -> Option<&'static str> {
    match building_type {
        "officeTower" => Some("standard"),
        "factory" => Some(if numeric_id_suffix(citizen_id).is_multiple_of(2) {
            "late"
        } else {
            "early"
        }),
        _ => None,
    }
}
```

Do not change `departure_minute_for_sim`, canonical template validation, Student classification, or the four existing window definitions.

- [ ] **Step 5: Run the focused tests**

```bash
cargo test -p caelum-core commute::
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/caelum-core/src/commute.rs
git commit -m "feat(commute): add workplace shift overrides"
```

---

### Task 2: Apply overrides at assignment and make activity scheduling safely supersede

**Files:**
- Modify: `crates/caelum-core/src/population/schedule.rs`
- Modify: `crates/caelum-core/tests/population.rs`

**Interfaces:**
- Consumes: `workplace_shift_template(citizen_id, building_type)`, existing `find_available_workplace`, `routine_from_now`, `NextActivity`, and `PopulationScheduler`.
- Produces: Office/Factory assignment may update `Routine::Worker.shift_template`; unfeatured assignment preserves it while still updating `workplace`.
- Produces: central `schedule_activity` removes the same entity's previous scheduled Activity before inserting a replacement.
- Preserves: the existing dropped-trip recovery guard, demolition retarget/drop semantics, and the same active trip ID.

- [ ] **Step 1: Add a failing initial-assignment timing test**

In `crates/caelum-core/tests/population.rs`, add `office_and_factory_move_ins_use_workplace_shifts_and_first_wakes`.

Use the existing placement helpers to create a house plus an Office Tower in one engine and a house plus a Factory in another before the first move-in. Run the due-at-zero move-in with `tick(0.0)`, then inspect the durable snapshots.

Pin both the stored template and the actual pending departure clock:

```rust
let office_worker = office
    .snapshot()
    .sims
    .into_iter()
    .find(|sim| sim.id == "sim-001")
    .expect("office worker");
assert_eq!(shift_of(&office_worker), Some("standard"));
assert_eq!(
    office_worker.next_activity.as_ref().map(|activity| activity.due_time),
    Some(scheduled_time_seconds(
        0,
        departure_minute_for_sim("sim-001", "standard", "outbound"),
    )),
);

let factory_worker = factory
    .snapshot()
    .sims
    .into_iter()
    .find(|sim| sim.id == "sim-001")
    .expect("factory worker");
assert_eq!(shift_of(&factory_worker), Some("early"));
assert_eq!(
    factory_worker.next_activity.as_ref().map(|activity| activity.due_time),
    Some(scheduled_time_seconds(
        0,
        departure_minute_for_sim("sim-001", "early", "outbound"),
    )),
);
```

The test proves the player-visible clock, not only the stored string.

- [ ] **Step 2: Run the focused test and verify it fails**

```bash
cargo test -p caelum-core --test population office_and_factory_move_ins_use_workplace_shifts_and_first_wakes
```

Expected: FAIL because move-in currently keeps `shift_template_for_id` even after a workplace is chosen.

- [ ] **Step 3: Apply the workplace rule during move-in without widening the workplace tuple**

Keep `find_available_workplace` returning its current `(building_id, point)`.

After it returns an assignment, read the building type from the existing index and derive the template:

```rust
let index = world.resource::<PopulationIndex>();
let workplace = find_available_workplace(index);
let assigned_shift = workplace
    .as_ref()
    .and_then(|(building_id, _)| index.buildings.get(building_id))
    .and_then(|building| workplace_shift_template(&sim_id, building.building_type))
    .unwrap_or(shift_template);
```

Construct `Routine::Worker` with `assigned_shift.to_string()` and the existing `BuildingAssignment`. Worker/Student classification still comes only from `shift_template_for_id`.

- [ ] **Step 4: Run the initial-assignment test**

```bash
cargo test -p caelum-core --test population office_and_factory_move_ins_use_workplace_shifts_and_first_wakes
```

Expected: PASS.

- [ ] **Step 5: Add a failing idle-refill wake replacement test**

Add `idle_factory_assignment_replaces_old_daily_routine_wake`.

Build housing with no workplace, run until at least `sim-002` has moved in, and capture `sim-002`'s existing identity-derived `DailyRoutine` due time. Then place a Factory while `sim-002` is idle/unemployed. The Factory deterministically maps even `sim-002` to `late`, which is later than its existing `standard` departure.

Pin all of the following:

```rust
let after_assignment = engine.snapshot();
let worker = after_assignment
    .sims
    .iter()
    .find(|sim| sim.id == "sim-002")
    .expect("assigned sim-002");

assert_eq!(shift_of(worker), Some("late"));
let expected_late_due = scheduled_time_seconds(
    after_assignment.day,
    departure_minute_for_sim("sim-002", "late", "outbound"),
);
assert_eq!(
    worker.next_activity.as_ref().map(|activity| activity.due_time),
    Some(expected_late_due),
);
```

Then advance only to the **old** standard due time and assert no `CommuteOutbound` exists for `sim-002`. Advance to `expected_late_due` and assert exactly one outbound exists for that citizen.

This test specifically catches leaving the old scheduler bucket behind.

- [ ] **Step 6: Run the idle-refill test and verify it fails**

```bash
cargo test -p caelum-core --test population idle_factory_assignment_replaces_old_daily_routine_wake
```

Expected: FAIL because refill currently changes only `workplace`; after adding the shift update, it would still leave the old scheduled wake unless that wake is replaced safely.

- [ ] **Step 7: Make `schedule_activity` safely supersede an old wake**

Extend the existing private scheduler insertion seam. Before inserting a new Activity event, read the entity's current `NextActivity`; if present, remove matching `PopulationEvent::Activity { entity }` rows from that previous exact due-time bucket and delete the bucket if it becomes empty. Then insert the new wake and replace the component as today.

Keep `boundary_generation` monotonic; removing an obsolete key does not decrement it. Keep the existing dropped-trip recovery guard that skips scheduling when a legitimate `NextActivity` already exists; that guard encodes semantic precedence, not merely duplicate-bucket avoidance.

- [ ] **Step 8: Apply workplace overrides in the global refill loop**

Always update the new `workplace`. Change `shift_template` only when `workplace_shift_template(&citizen_id, building.building_type)` returns `Some`; assigning to Warehouse, Supermarket, Business Park, or another unfeatured workplace leaves the current Worker template unchanged.

If the citizen has no non-terminal active trip and its current `NextActivity` is `DailyRoutine`, call the existing `schedule_activity(world, entity, routine_from_now(...))`. Central supersession removes the old bucket entry. Do not mutate active trips in this block.

- [ ] **Step 9: Pin unfeatured reassignment preservation**

Add one case where a Worker carrying an Office-derived `standard` template is later assigned to an unfeatured Warehouse/Supermarket vacancy. Assert the stored template remains `standard` rather than being re-derived from citizen identity.

- [ ] **Step 10: Re-pin representative active-trip reassignment to the existing contract**

Add/adjust `workplace_reassignment_updates_shift_without_duplicating_active_trip`.

The current demolition path may reset an outbound trip in place to the replacement destination, so **do not** assert byte-for-byte trip equality.

Capture the worker's active trip ID before demolition, then assert afterward:

```rust
let before_trip_id = before
    .active_trips
    .iter()
    .find(|trip| trip.sim_id == worker_id)
    .expect("active outbound")
    .id
    .clone();

// ... demolish old workplace / refill replacement ...

let after_trips = after
    .active_trips
    .iter()
    .filter(|trip| trip.sim_id == worker_id)
    .collect::<Vec<_>>();
assert_eq!(after_trips.len(), 1);
assert_eq!(after_trips[0].id, before_trip_id);
assert_eq!(shift_of(reassigned_worker), Some("standard")); // Office replacement
```

It is valid for existing reconciliation to change that same trip's destination/status/route-plan/deadline.

- [ ] **Step 11: Add save/restore timing coverage**

After staffing Office/Factory workers, snapshot and restore through the public engine constructor:

```rust
let saved = engine.snapshot();
let restored = GameEngine::from_snapshot(saved.clone()).expect("restore staffed town");
let restored_snapshot = restored.snapshot();

assert_eq!(
    worker_assignments_shifts_and_next_activity(&restored_snapshot),
    worker_assignments_shifts_and_next_activity(&saved),
);
```

Advance the restored engine to a representative stored work wake and assert the emitted commute still targets the persisted workplace. Do not bump the schema.

- [ ] **Step 12: Run population coverage**

```bash
cargo test -p caelum-core --test population
cargo test -p caelum-core population::
```

Expected: PASS, including existing Student/day-off/optional/capacity/recovery tests.

- [ ] **Step 13: Commit**

```bash
git add crates/caelum-core/src/population/schedule.rs crates/caelum-core/tests/population.rs
git commit -m "feat(population): apply workplace shift overrides"
```

---

### Task 3: Add Office Tower without killing Small Town optional outings

**Files:**
- Modify: `crates/caelum-core/src/sandbox.rs`
- Modify: `crates/caelum-core/tests/sandbox_factory.rs`
- Modify: `crates/caelum-core/tests/population.rs`

**Interfaces:**
- Consumes: existing `create_small_town_candidate`, area painting, building placement, road topology.
- Produces: Small Town contains three Small Houses, one Office Tower, the existing Supermarket, and the existing Factory.

- [ ] **Step 1: Update the failing Small Town authored-content contract**

In `crates/caelum-core/tests/sandbox_factory.rs`, pin the exact building order:

```rust
assert_eq!(
    building_types,
    vec![
        "smallHouse",
        "smallHouse",
        "smallHouse",
        "officeTower",
        "supermarket",
        "factory",
    ]
);
```

Also assert `(21, 6)` is Office, `(18, 6)` remains Commercial, Supermarket still occupies `(18, 6)`, and Factory remains `(15, 11)`.

- [ ] **Step 2: Run the focused test and verify it fails**

```bash
cargo test -p caelum-core --test sandbox_factory small_town
```

Expected: FAIL because Small Town currently has four buildings and no Office area/Tower.

- [ ] **Step 3: Make the additive authored change**

Keep the existing Residential/Commercial/Industrial rectangles and add:

```rust
("office", Point { x: 21, y: 6 }, Point { x: 22, y: 7 }),
```

Place buildings in this exact order:

```rust
("smallHouse", Point { x: 4, y: 7 }),
("smallHouse", Point { x: 8, y: 7 }),
("smallHouse", Point { x: 6, y: 7 }),
("officeTower", Point { x: 21, y: 6 }),
("supermarket", Point { x: 21, y: 6 }),
("factory", Point { x: 15, y: 11 }),
```

The third House fits the existing Residential zone and touches the y=8 road; Office Tower touches the same road from y=7. Keep roads, starting capital, capacities, map size, Supermarket, and optional-outing behavior unchanged.

- [ ] **Step 4: Prove deterministic normal staffing in `population.rs`**

Add `small_town_normal_move_in_staffs_office_supermarket_and_factory` in **`crates/caelum-core/tests/population.rs`**.

Create Small Town through `create_sandbox_snapshot`, build `GameEngine::from_snapshot`, unpause, and advance until all twelve housing slots have moved in.

Assert population 12, `sim-010` is the Student, Office Tower has exactly 4 assigned Workers, Supermarket exactly 4, Factory exactly 3, and the Factory set includes at least one `early` and one `late` Worker. Do not seed `sims` manually.

- [ ] **Step 5: Run sandbox + population focused coverage**

```bash
cargo test -p caelum-core --test sandbox_factory
cargo test -p caelum-core --test population small_town_normal_move_in_staffs_office_supermarket_and_factory
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/caelum-core/src/sandbox.rs crates/caelum-core/tests/sandbox_factory.rs crates/caelum-core/tests/population.rs
git commit -m "feat(sandbox): add office to small town"
```

---

### Task 4: Expose workplace facts and aggregate demand in the shell

**Files:**
- Modify: `src/domain/catalog/buildings.ts`
- Modify: `src/runtime/types.ts`
- Modify: `src/runtime/runtimeSelectors.ts`
- Modify: `tests/runtime/buildingCatalog.test.ts`
- Modify: `tests/runtime/runtimeSelectors.test.ts`

**Interfaces:**
- Produces: `BuildingDefinition.workPattern?: string`.
- Produces: `ShellBuildingInspectorState.workPattern: string | null` and `currentDestinationDemand: number | null`.
- Produces: exported `parseSelectedPoint(selectedId)` for reuse by WebGPU.
- Consumes: existing `buildingOccupancy` and `demandFlow` only.

- [ ] **Step 1: Pin exact player-facing pattern copy**

Extend `tests/runtime/buildingCatalog.test.ts`:

```ts
expect(BUILDING_CATALOG.officeTower.workPattern).toBe(
  "Standard · 07:00–09:00 starts, 17:00–19:00 returns",
);
expect(BUILDING_CATALOG.factory.workPattern).toBe(
  "Early / late · 05:30–07:00 or 10:00–11:30 starts; 15:00–16:30 or 19:30–21:00 returns",
);
expect(BUILDING_CATALOG.warehouse.workPattern).toBeUndefined();
```

- [ ] **Step 2: Add the optional catalog field and values**

```ts
export interface BuildingDefinition {
  // existing fields...
  workPattern?: string;
}
```

Populate only `officeTower` and `factory` with the exact tested strings. Do not add a separate schedule registry.

- [ ] **Step 3: Add failing selector tests for the three workplace states**

In `runtimeSelectors.test.ts`, create a selected Office/Factory footprint with presentation rows and assert:

```ts
expect(shell.inspector).toMatchObject({
  kind: "building",
  metricLabel: "Jobs",
  occupancy: 0,
  capacity: 4,
  workPattern: BUILDING_CATALOG.officeTower.workPattern,
  currentDestinationDemand: 0,
});
```

Then set `buildingOccupancy` to a positive count with no demand row (staffed/quiet), and finally add multiple `demandFlow` rows on different occupied tiles and assert their counts are summed exactly. Include one demand row outside the footprint and assert it is ignored.

- [ ] **Step 4: Run the selector tests and verify failure**

```bash
bunx vitest run --project runtime tests/runtime/buildingCatalog.test.ts tests/runtime/runtimeSelectors.test.ts
```

Expected: FAIL on missing fields/aggregation.

- [ ] **Step 5: Extend shell types without changing backend wire types**

```ts
export interface ShellBuildingInspectorState {
  kind: "building";
  buildingId: string;
  buildingLabel: string;
  metricLabel: "Residents" | "Jobs";
  occupancy: number;
  capacity: number;
  workPattern: string | null;
  currentDestinationDemand: number | null;
}
```

- [ ] **Step 6: Export the existing selected-point parser**

Change only its visibility:

```ts
export function parseSelectedPoint(selectedId: string | null): Point | null {
  // existing regex body unchanged
}
```

Do not create new selection state.

- [ ] **Step 7: Derive workplace demand inside `buildInspector`**

After resolving `definition`, `occupancy`, and `capacity`:

```ts
const workPattern = definition.workPattern ?? null;
const currentDestinationDemand =
  workPattern === null
    ? null
    : state.demandFlow
        .filter((row) => includesPoint(building.occupiedTiles, row.point))
        .reduce((sum, row) => sum + row.count, 0);
```

Return both fields. For housing/other job buildings, return `null` values so their inspector behavior stays unchanged.

- [ ] **Step 8: Run runtime tests**

```bash
bunx vitest run --project runtime tests/runtime/buildingCatalog.test.ts tests/runtime/runtimeSelectors.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/domain/catalog/buildings.ts src/runtime/types.ts src/runtime/runtimeSelectors.ts tests/runtime/buildingCatalog.test.ts tests/runtime/runtimeSelectors.test.ts
git commit -m "feat(ui): derive workplace staffing and demand facts"
```

---

### Task 5: Show building facts without breaking the command grid

**Files:**
- Modify: `src/components/hud/panels/BuildPanel.svelte`
- Modify: `src/components/hud/panels/InspectPanel.svelte`
- Modify: `tests/ui/buildPanel.test.ts`
- Create: `tests/ui/inspectPanel.test.ts`

**Interfaces:**
- Consumes: `BUILDING_CATALOG`, `getRotatedFootprintSize`, `selectedBuilding`, `buildingRotation`, and the extended `ShellBuildingInspectorState`.
- Produces: one generic armed-building facts block; no new runtime state.

- [ ] **Step 1: Add failing generic armed-building summary tests**

In `tests/ui/buildPanel.test.ts`, render `activeBuildGroup: "buildings"` with an armed ordinary building and assert a facts block outside the leaf button:

```ts
renderPanel({
  activeBuildGroup: "buildings",
  selectedBuilding: "smallHouse",
});
expect(screen.getByTestId("armed-building-facts")).toHaveTextContent(
  "2 × 1 · $4,000 · 4 residents",
);
```

Then render Office Tower and Factory and assert their footprint/price/job capacity plus pattern copy. Also assert the existing leaf buttons do not contain the long schedule prose, so the uniform 13-button grid stays compact.

- [ ] **Step 2: Add failing Inspector assertions**

Pin all three copy states:

```ts
expect(screen.getByTestId("workplace-status")).toHaveTextContent("Unstaffed");
```

```ts
expect(screen.getByTestId("workplace-status")).toHaveTextContent("Staffed · quiet now");
```

```ts
expect(screen.getByTestId("workplace-status")).toHaveTextContent(
  "Staffed · current destination demand 3",
);
```

In every case also assert `Jobs X / Y` and the pattern text remain separate elements.

- [ ] **Step 3: Run the focused UI tests and verify failure**

```bash
bunx vitest run --project ui tests/ui/buildPanel.test.ts tests/ui/inspectPanel.test.ts
```

Expected: FAIL because the facts/status copy is not rendered yet.

- [ ] **Step 4: Add one generic facts summary near Rotate**

Import `BUILDING_CATALOG` and `getRotatedFootprintSize`. Before the existing Rotate control, render a single `data-testid="armed-building-facts"` block only when `selectedBuilding !== null`.

The block shows current rotated footprint, price, and either resident capacity or job capacity for **every** armed building. Render `definition.workPattern` on a second line only when present.

Keep the facts outside the uniform item buttons so long prose cannot distort the grid and remains available to assistive technology. Existing behavior where arming closes the command panel stays unchanged; reopening Build while the building remains armed shows the summary before placement. Do not add another panel state or modal.

- [ ] **Step 5: Extend `InspectPanel.svelte` only for non-null workplace metadata**

Keep the existing occupancy line, then add:

```svelte
{#if inspector.workPattern !== null && inspector.currentDestinationDemand !== null}
  <p data-testid="workplace-status">
    {#if inspector.occupancy === 0}
      Unstaffed
    {:else if inspector.currentDestinationDemand === 0}
      Staffed · quiet now
    {:else}
      Staffed · current destination demand {inspector.currentDestinationDemand}
    {/if}
  </p>
  <p class="workplace-pattern">{inspector.workPattern}</p>
{/if}
```

Do not label zero demand as well-served/no-future-demand.

- [ ] **Step 6: Run UI + type checks**

```bash
bunx vitest run --project ui tests/ui/buildPanel.test.ts tests/ui/inspectPanel.test.ts
bun run check
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/hud/panels/BuildPanel.svelte src/components/hud/panels/InspectPanel.svelte tests/ui/buildPanel.test.ts tests/ui/inspectPanel.test.ts
git commit -m "feat(ui): explain workplace staffing and shifts"
```

---

### Task 6: Add generic selected-building demand emphasis in WebGPU

**Files:**
- Modify: `src/render/webgpu/overlayBatch.ts`
- Modify: `tests/render/webgpuOverlayBatch.test.ts`

**Interfaces:**
- Consumes: exported `parseSelectedPoint`, existing `UiState.selectedId`, `selectedNodeKind`, `GameState.buildings`, `demandFlow`, `DEMAND`, `demandAlpha`, `strokeTile`, `fillTile`.
- Produces: geometry only; no building-type taxonomy and no new renderer state.

- [ ] **Step 1: Add failing exact-geometry tests using existing helpers**

Use an arbitrary selected building; the test does not need to be Office/Factory. Give it a footprint containing `{ x: 5, y: 5 }` and `{ x: 6, y: 5 }`.

Use the existing `hasVertexNear` and `alphaAt` helpers to pin:

1. selected + zero demand produces demand-color outline vertices at expected world coordinates;
2. a demand row at `{ x: 5, y: 5 }` produces demand-color fill at `160,160` with alpha `0.24` when the global Demand overlay is off;
3. a demand row outside the selected footprint is not added by this selected-building pass;
4. with `activeOverlay = "demand"`, the selected row keeps the normal global-overlay alpha rather than being double-darkened;
5. `selectedNodeKind !== null` suppresses the building pass so transit selection keeps priority.

Do not use only vertex-buffer length comparisons.

- [ ] **Step 2: Run the render test and verify failure**

```bash
bunx vitest run tests/render/webgpuOverlayBatch.test.ts
```

Expected: FAIL because selected buildings currently have no overlay pass.

- [ ] **Step 3: Add a generic selected-building resolver**

Resolve the selected point with exported `parseSelectedPoint`. Return `null` when `ui.selectedNodeKind !== null`, then find **any** building whose `occupiedTiles` contain that point.

Do not check `building.type` and do not import the building catalog into the renderer.

- [ ] **Step 4: Draw outline + selected demand with existing primitives**

Add a selected-building pass after global data overlays and before previews:

```ts
for (const tile of building.occupiedTiles) {
  strokeTile(g, tile, DEMAND);
}

if (ui.activeOverlay !== "demand") {
  for (const row of state.demandFlow) {
    if (!building.occupiedTiles.some((tile) => tile.x === row.point.x && tile.y === row.point.y)) {
      continue;
    }
    fillTile(g, row.point, withAlpha(DEMAND, demandAlpha(row.count)));
  }
}
```

Reuse `DEMAND`; do not add a color or a renderer layer.

- [ ] **Step 5: Run render tests**

```bash
bunx vitest run tests/render/webgpuOverlayBatch.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/render/webgpu/overlayBatch.ts tests/render/webgpuOverlayBatch.test.ts
git commit -m "feat(render): emphasize selected building demand"
```

---

### Task 7: Add one real-WASM paused-state proof and run the repository gate

**Files:**
- Modify: `tests/e2e/newCity.spec.ts`
- Reuse: `tests/e2e/helpers.ts` (`clickMapTile`, `selectTool`, `runtimeSnapshot`)
- Update: HPA-463 PR body/checklist as implementation lands

**Interfaces:**
- Consumes: ordinary New City UI, real WASM runtime, existing Select tool/inspector.
- Produces: one browser acceptance path for authored workplace identity/copy at paused t=0; Rust tests own normal-move-in staffing and timing.

- [ ] **Step 1: Update the existing Small Town paused-state flow**

Keep the existing `creates Small Town through the real WASM New City flow` test paused at `t=0`. Change its building-count assertion from 4 to 6.

Immediately before map selection, re-read `runtimeSnapshot(page)` and assert:

```ts
const beforeSelection = await runtimeSnapshot(page);
// Authored slot-0 move-ins are due at t=0, but the paused host must not tick
// implicitly during mount/selection; keep this premise explicit.
expect(beforeSelection.state.paused).toBe(true);
expect(beforeSelection.state.populationCount).toBe(0);
```

If selection advances population from zero, treat that as a real host-behavior regression rather than relaxing the assertion.

After its current template assertions:

1. locate the gameplay canvas;
2. arm the existing Select tool;
3. click the authored Office Tower at `{ x: 21, y: 6 }`;
4. assert Office Tower, `Jobs 0 / 4`, `Unstaffed`, and `Standard · 07:00–09:00 starts, 17:00–19:00 returns`;
5. click the authored Factory at `{ x: 15, y: 11 }`;
6. assert Factory, `Jobs 0 / 6`, `Unstaffed`, and the Early / late pattern copy.

Use the same ordinary map-selection pattern already exercised by `tests/e2e/smoke.spec.ts`:

```ts
const canvas = page.locator("canvas[data-runtime-canvas='true']");
await selectTool(page, "select");

await clickMapTile(canvas, { x: 21, y: 6 });
const inspector = page.getByTestId("panel-inspect");
await expect(inspector.getByText("Office Tower")).toBeVisible();
await expect(inspector.getByText("Jobs 0 / 4")).toBeVisible();
await expect(inspector.getByTestId("workplace-status")).toHaveText("Unstaffed");
await expect(inspector).toContainText("Standard · 07:00–09:00 starts, 17:00–19:00 returns");

await clickMapTile(canvas, { x: 15, y: 11 });
await expect(inspector.getByText("Factory")).toBeVisible();
await expect(inspector.getByText("Jobs 0 / 6")).toBeVisible();
await expect(inspector.getByTestId("workplace-status")).toHaveText("Unstaffed");
await expect(inspector).toContainText("Early / late ·");
```

Do **not** unpause and wait for all residents to move in. Playwright's repository timeout is 30 seconds, while normal simulation pacing is intentionally wall-clock driven; deterministic Rust population tests already prove staffing and commute windows.

- [ ] **Step 2: Rebuild WASM and run the browser proof**

```bash
bun run wasm:build
bunx playwright test tests/e2e/newCity.spec.ts --project=chromium
```

Expected: PASS.

- [ ] **Step 3: Run focused feature suites together**

```bash
cargo test -p caelum-core commute::
cargo test -p caelum-core --test population
cargo test -p caelum-core --test sandbox_factory
bunx vitest run --project runtime tests/runtime/buildingCatalog.test.ts tests/runtime/runtimeSelectors.test.ts
bunx vitest run --project ui tests/ui/buildPanel.test.ts tests/ui/inspectPanel.test.ts
bunx vitest run tests/render/webgpuOverlayBatch.test.ts
```

Expected: PASS.

- [ ] **Step 4: Run the full repository gate**

```bash
cargo test --workspace
bun run test
bun run check
bun run lint
bun run format:check
bun run build
bun run test:e2e
```

Expected: all commands PASS.

- [ ] **Step 5: Review the diff against the design before marking the PR ready**

Confirm there is no:

- new snapshot field/version;
- workplace schedule registry/class hierarchy;
- second active trip introduced by workplace reassignment;
- per-citizen frontend payload;
- Office/Factory taxonomy inside renderer code;
- new renderer/camera path (the generic WebGPU selection pass is allowed and required);
- new art asset;
- HPA-464 stop/line navigation work;
- second PR/task for QA/closeout.

Also confirm Small Town still contains its Supermarket so optional-outing gameplay remains reachable.

- [ ] **Step 6: Commit the browser proof / final integration adjustments**

```bash
git add tests/e2e/newCity.spec.ts
git commit -m "test(e2e): prove workplace commute presentation"
```

Do not create a second PR. Push these commits to the existing HPA-463 draft PR and mark that PR ready only after the full gate passes.

---

## Self-review

- **Spec coverage:** Office/Factory override timing, centralized wake supersession, active-trip reassignment, persistence, build explanation, staffing/current-demand inspector, generic selected-building WebGPU emphasis, additive Small Town content with optional outings preserved, Rust/browser verification, and non-goals all map to tasks above.
- **Scope:** one Worker-template override rule, one correction at the existing private scheduler insertion seam, one aggregate read-model extension, one generic renderer pass, and one additive template edit. No new subsystem or second PR.
- **Type consistency:** `workPattern` is optional in the building catalog and becomes `string | null` in shell inspector state; `currentDestinationDemand` is `number | null`; no backend wire type changes.
- **Persistence:** existing `CitizenRoutine::Worker.shift_template` remains durable; no schema change or migration.
- **Risk review:** Supermarket optional outings are preserved; Rust pins UI window-copy drift; scheduler supersession is centralized; renderer selection is taxonomy-free; paused E2E explicitly asserts no implicit tick.
- **No placeholders:** all behavioral branches, target files, commands, public/private seams, and copy strings are specified.
