# Workplace Commute Patterns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Office Tower workers use standard shifts and Factory workers use deterministic early/late shifts, then expose staffing/current demand clearly in the existing UI and Small Town sandbox.

**Architecture:** Keep `Routine::Worker.shift_template` as the only authoritative worker schedule state. Derive that value when a Worker receives a workplace, reuse existing aggregate `buildingOccupancy`/`demandFlow` rows for presentation, and extend the existing WebGPU overlay and sandbox template in place. No new schema, query, renderer, scheduling registry, or per-citizen UI payload.

**Tech Stack:** Rust (`caelum-core`, Bevy ECS), TypeScript, Svelte 5, WebGPU, Vitest, Playwright, Bun.

**Spec:** `docs/superpowers/specs/2026-09-17-workplace-commute-patterns-design.md`

## Global Constraints

- One Linear ticket = one GitHub PR. Continue implementation on this HPA-463 PR; do not open implementation/QA follow-up PRs.
- Office Tower workers use canonical `standard` windows.
- Factory workers use canonical `early` or `late` windows selected deterministically from citizen identity and stable across days/reloads.
- Other workplaces retain the current `shift_template_for_id` behavior.
- Students, days off, optional outings, trip mode choice, finite job capacity, and one-active-trip lifecycle stay unchanged.
- Assignment/reassignment updates the existing `Routine::Worker.shift_template`; never add a second schedule authority.
- Never rewrite/restart an already-active trip solely because a worker's workplace changed.
- No persistence/schema change unless implementation discovers an unavoidable contract break. Do not add backward compatibility or migration code.
- Rust remains simulation authority. TypeScript receives only existing aggregates and local display metadata.
- No new image art.
- HPA-464 owns stop queues, line warnings, and stop/line navigation.

---

## File map

- `crates/caelum-core/src/commute.rs` — canonical workplace-to-shift rule.
- `crates/caelum-core/src/population/schedule.rs` — apply the rule on initial assignment/vacancy refill, replace an idle worker's stale pending `DailyRoutine` wake, and preserve existing active-trip retarget/drop behavior.
- `crates/caelum-core/tests/population.rs` — end-to-end Rust assignment/reassignment/save-restore behavior.
- `crates/caelum-core/src/sandbox.rs` — Small Town Office Tower + Factory authored example.
- `crates/caelum-core/tests/sandbox_factory.rs` — template contract.
- `src/domain/catalog/buildings.ts` — player-facing work-pattern copy only.
- `src/runtime/types.ts` — two small derived inspector fields.
- `src/runtime/runtimeSelectors.ts` — selected workplace demand aggregation and shared selected-point parser.
- `src/components/hud/panels/BuildPanel.svelte` — pre-build workplace facts.
- `src/components/hud/panels/InspectPanel.svelte` — staffing/pattern/current-demand states.
- `src/render/webgpu/overlayBatch.ts` — selected workplace outline/current-demand emphasis.
- `tests/runtime/buildingCatalog.test.ts` — copy/catalog contract.
- `tests/runtime/runtimeSelectors.test.ts` — inspector aggregation contract.
- `tests/render/webgpuOverlayBatch.test.ts` — selected-workplace render geometry.
- `tests/ui/buildPanel.test.ts` — Build facts for Office/Factory.
- Create: `tests/ui/inspectPanel.test.ts` — isolated InspectPanel copy/state coverage using the existing Testing Library pattern; this is a test file, not a new harness.
- `tests/e2e/newCity.spec.ts` — one real-WASM Small Town proof.

---

### Task 1: Add the canonical workplace-to-shift rule

**Files:**
- Modify: `crates/caelum-core/src/commute.rs`

**Interfaces:**
- Consumes: existing `numeric_id_suffix(id)` and `shift_template_for_id(id)`.
- Produces: `pub fn shift_template_for_workplace(citizen_id: &str, building_type: &str) -> Option<&'static str>`.

- [ ] **Step 1: Write focused failing unit tests**

Add tests in `commute.rs` that pin all three rule branches:

```rust
#[test]
fn office_workers_always_use_standard_shift() {
    for id in ["sim-001", "sim-008", "sim-009"] {
        assert_eq!(
            shift_template_for_workplace(id, "officeTower"),
            Some("standard")
        );
    }
}

#[test]
fn factory_workers_use_stable_early_or_late_identity_buckets() {
    assert_eq!(shift_template_for_workplace("sim-001", "factory"), Some("early"));
    assert_eq!(shift_template_for_workplace("sim-002", "factory"), Some("late"));
    assert_eq!(shift_template_for_workplace("sim-001", "factory"), Some("early"));
}

#[test]
fn other_workplaces_keep_identity_derived_shift() {
    for id in ["sim-001", "sim-008", "sim-009", "sim-010"] {
        assert_eq!(
            shift_template_for_workplace(id, "warehouse"),
            shift_template_for_id(id)
        );
    }
}
```

The exact Factory mapping is odd numeric suffix → `early`, even → `late`; student IDs are never turned into Workers because callers still classify Worker/Student first.

- [ ] **Step 2: Run the tests and verify they fail**

Run:

```bash
cargo test -p caelum-core commute::
```

Expected: compile failure because `shift_template_for_workplace` does not exist.

- [ ] **Step 3: Implement the minimal helper**

Add next to `shift_template_for_id`:

```rust
pub fn shift_template_for_workplace(
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
        _ => shift_template_for_id(citizen_id),
    }
}
```

Do not change `departure_minute_for_sim`, canonical template validation, Student classification, or the four existing window definitions.

- [ ] **Step 4: Run the focused tests**

```bash
cargo test -p caelum-core commute::
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/caelum-core/src/commute.rs
git commit -m "feat(population): derive shifts from workplace type"
```

---

### Task 2: Apply the rule at both worker-assignment seams

**Files:**
- Modify: \`crates/caelum-core/src/population/schedule.rs\`
- Modify: \`crates/caelum-core/tests/population.rs\`

**Interfaces:**
- Consumes: \`shift_template_for_workplace(citizen_id, building_type)\`, existing \`find_available_workplace\`, \`routine_from_now\`, \`NextActivity\`, and \`PopulationScheduler\`.
- Produces: assignment updates \`Routine::Worker.shift_template\` + \`workplace\` together.
- Produces: one private helper in \`schedule.rs\` that replaces an **idle** worker's pending \`DailyRoutine\` wake without leaving the old scheduler event behind.
- Preserves: existing demolition outbound-trip retarget/drop semantics and the same active trip ID.

- [ ] **Step 1: Add a failing initial-assignment timing test**

In \`crates/caelum-core/tests/population.rs\`, add \`office_and_factory_move_ins_use_workplace_shifts_and_first_wakes\`.

Use the existing placement helpers to create a house plus an Office Tower in one engine and a house plus a Factory in another before the first move-in. Run the due-at-zero move-in with \`tick(0.0)\`, then inspect the durable snapshots.

Pin both the stored template and the actual pending departure clock:

\`\`\`rust
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
\`\`\`

The test proves the player-visible clock, not only the stored string.

- [ ] **Step 2: Run the focused test and verify it fails**

\`\`\`bash
cargo test -p caelum-core --test population office_and_factory_move_ins_use_workplace_shifts_and_first_wakes
\`\`\`

Expected: FAIL because move-in currently keeps \`shift_template_for_id\` even after a workplace is chosen.

- [ ] **Step 3: Apply the workplace rule during move-in without widening the workplace tuple**

Keep \`find_available_workplace\` returning its current \`(building_id, point)\`.

After it returns an assignment, read the building type from the existing index and derive the template:

\`\`\`rust
let index = world.resource::<PopulationIndex>();
let workplace = find_available_workplace(index);
let assigned_shift = workplace
    .as_ref()
    .and_then(|(building_id, _)| index.buildings.get(building_id))
    .and_then(|building| shift_template_for_workplace(&sim_id, building.building_type))
    .unwrap_or(shift_template);
\`\`\`

Construct \`Routine::Worker\` with \`assigned_shift.to_string()\` and the existing \`BuildingAssignment\`. Worker/Student classification still comes only from \`shift_template_for_id\`.

- [ ] **Step 4: Run the initial-assignment test**

\`\`\`bash
cargo test -p caelum-core --test population office_and_factory_move_ins_use_workplace_shifts_and_first_wakes
\`\`\`

Expected: PASS.

- [ ] **Step 5: Add a failing idle-refill wake replacement test**

Add \`idle_factory_assignment_replaces_old_daily_routine_wake\`.

Build housing with no workplace, run until at least \`sim-002\` has moved in, and capture \`sim-002\`'s existing identity-derived \`DailyRoutine\` due time. Then place a Factory while \`sim-002\` is idle/unemployed. The Factory deterministically maps even \`sim-002\` to \`late\`, which is later than its existing \`standard\` departure.

Pin all of the following:

\`\`\`rust
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
\`\`\`

Then advance only to the **old** standard due time and assert no \`CommuteOutbound\` exists for \`sim-002\`. Advance to \`expected_late_due\` and assert exactly one outbound exists for that citizen.

This test specifically catches leaving the old scheduler bucket behind.

- [ ] **Step 6: Run the idle-refill test and verify it fails**

\`\`\`bash
cargo test -p caelum-core --test population idle_factory_assignment_replaces_old_daily_routine_wake
\`\`\`

Expected: FAIL because refill currently changes only \`workplace\`; after adding the shift update, it would still leave the old scheduled wake unless that wake is replaced safely.

- [ ] **Step 7: Add one narrow private wake-replacement helper**

In \`population/schedule.rs\`, add a private helper beside \`schedule_activity\`:

\`\`\`rust
fn replace_pending_daily_routine(
    world: &mut World,
    entity: Entity,
    citizen_id: &str,
    now: f64,
) {
    let Some(existing) = world.get::<NextActivity>(entity).map(|next| next.0.clone()) else {
        return;
    };
    if existing.kind != ScheduledActivityKind::DailyRoutine {
        return;
    }

    let old_key = ScheduledTime::new(existing.due_time);
    {
        let mut scheduler = world.resource_mut::<PopulationScheduler>();
        let mut remove_bucket = false;
        if let Some(events) = scheduler.buckets.get_mut(&old_key) {
            events.retain(|event| {
                !matches!(event, PopulationEvent::Activity { entity: scheduled } if *scheduled == entity)
            });
            remove_bucket = events.is_empty();
        }
        if remove_bucket {
            scheduler.buckets.remove(&old_key);
        }
    }

    let routine = world
        .get::<Routine>(entity)
        .cloned()
        .expect("assigned worker must retain a routine");
    schedule_activity(world, entity, routine_from_now(&routine, citizen_id, now));
}
\`\`\`

Do not make this public or generic. \`boundary_generation\` stays monotonic; removing an obsolete key does not decrement it.

- [ ] **Step 8: Update the global refill mutation**

Move/reuse \`let now = after.time;\` so it is available during refill.

When a free slot is assigned:

1. look up \`building.building_type\` already present on \`PopulationBuilding\`;
2. set \`shift_template\` and \`workplace\` together;
3. determine whether that citizen already has a non-terminal active trip in \`after.active_trips\`;
4. if there is **no** active trip, call \`replace_pending_daily_routine\`. The helper itself no-ops for \`PrimaryReturn\` / \`OptionalReturn\`.

Core mutation:

\`\`\`rust
if let Some(mut routine) = world.get_mut::<Routine>(entity) {
    if let Routine::Worker {
        shift_template,
        workplace,
    } = &mut *routine
    {
        *shift_template = shift_template_for_workplace(&citizen_id, building.building_type)
            .expect("indexed unassigned worker must remain a worker")
            .to_string();
        *workplace = Some(BuildingAssignment {
            building_id: Some(building_id.clone()),
            point,
        });
    }
}

let has_active_trip = after.active_trips.iter().any(|trip| {
    trip.sim_id == citizen_id && !is_terminal_status(trip.status)
});
if !has_active_trip {
    replace_pending_daily_routine(world, entity, &citizen_id, now);
}
\`\`\`

Do not mutate any active trip in this block.

- [ ] **Step 9: Re-pin representative active-trip reassignment to the existing contract**

Add/adjust \`workplace_reassignment_updates_shift_without_duplicating_active_trip\`.

The current demolition path may reset an outbound trip in place to the replacement destination, so **do not** assert byte-for-byte trip equality.

Capture the worker's active trip ID before demolition, then assert afterward:

\`\`\`rust
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
\`\`\`

It is valid for existing reconciliation to change that same trip's destination/status/route-plan/deadline.

- [ ] **Step 10: Add save/restore timing coverage**

After staffing Office/Factory workers, snapshot and restore through the public engine constructor:

\`\`\`rust
let saved = engine.snapshot();
let restored = GameEngine::from_snapshot(saved.clone()).expect("restore staffed town");
let restored_snapshot = restored.snapshot();

assert_eq!(
    worker_assignments_shifts_and_next_activity(&restored_snapshot),
    worker_assignments_shifts_and_next_activity(&saved),
);
\`\`\`

Advance the restored engine to a representative stored work wake and assert the emitted commute still targets the persisted workplace. Do not bump the schema.

- [ ] **Step 11: Run population coverage**

\`\`\`bash
cargo test -p caelum-core --test population
cargo test -p caelum-core population::
\`\`\`

Expected: PASS, including existing Student/day-off/optional/capacity/recovery tests.

- [ ] **Step 12: Commit**

\`\`\`bash
git add crates/caelum-core/src/population/schedule.rs crates/caelum-core/tests/population.rs
git commit -m "feat(population): apply workplace shifts on assignment"
\`\`\`

---

### Task 3: Make Small Town demonstrate both workplace patterns

**Files:**
- Modify: `crates/caelum-core/src/sandbox.rs`
- Modify: `crates/caelum-core/tests/sandbox_factory.rs`

**Interfaces:**
- Consumes: existing `create_small_town_candidate`, area painting, building placement, road topology.
- Produces: Small Town contains two Small Houses, one Office Tower, and one Factory on the existing road layout.

- [ ] **Step 1: Update/add the failing Small Town contract test first**

Pin the authored destination types and areas, while leaving the other templates' expectations unchanged:

```rust
let snapshot = create_sandbox_snapshot(small_town_request()).expect("small town");
let building_types = snapshot
    .buildings
    .iter()
    .map(|building| building.building_type.as_str())
    .collect::<Vec<_>>();

assert_eq!(
    building_types,
    vec!["smallHouse", "smallHouse", "officeTower", "factory"]
);
assert_eq!(snapshot.map.tile(Point { x: 18, y: 6 }).unwrap().area.as_deref(), Some("office"));
```

- [ ] **Step 2: Run the focused test and verify it fails**

```bash
cargo test -p caelum-core --test sandbox_factory small_town
```

Expected: FAIL because the 2x2 destination is currently Commercial + Supermarket.

- [ ] **Step 3: Swap only the existing 2x2 authored destination**

In `create_small_town_candidate`:

```rust
("office", Point { x: 18, y: 6 }, Point { x: 19, y: 7 }),
```

and:

```rust
("officeTower", Point { x: 18, y: 6 }),
```

Keep the two Small Houses, Industrial Factory, roads, map dimensions, capital, and catalog capacities unchanged.

- [ ] **Step 4: Prove the existing eight residents can staff both destinations**

Add/extend one integration assertion (in `population.rs` or `sandbox_factory.rs`, whichever already runs an engine from Small Town) that after normal move-in both Office Tower and Factory have `buildingOccupancy > 0`. Do not seed `sims` manually.

- [ ] **Step 5: Run sandbox + population focused coverage**

```bash
cargo test -p caelum-core --test sandbox_factory
cargo test -p caelum-core --test population office_and_factory_assign_workplace_derived_worker_shifts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/caelum-core/src/sandbox.rs crates/caelum-core/tests/sandbox_factory.rs crates/caelum-core/tests/population.rs
git commit -m "feat(sandbox): showcase office and factory shifts"
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

### Task 5: Show the workplace rule before and after placement

**Files:**
- Modify: `src/components/hud/panels/BuildPanel.svelte`
- Modify: `src/components/hud/panels/InspectPanel.svelte`
- Modify: `tests/ui/buildPanel.test.ts`
- Create: `tests/ui/inspectPanel.test.ts`

**Interfaces:**
- Consumes: `BUILDING_CATALOG[*].workPattern` and the extended `ShellBuildingInspectorState`.
- Produces: no new runtime state.

- [ ] **Step 1: Add failing Build panel assertions**

Render/open the existing Buildings group and assert Office Tower and Factory expose their facts before placement. Give the facts stable test IDs in the implementation, for example:

```ts
expect(screen.getByTestId("workplace-facts-officeTower")).toHaveTextContent(
  "2 × 2 · $18,000 · 4 jobs",
);
expect(screen.getByTestId("workplace-facts-officeTower")).toHaveTextContent(
  "Standard · 07:00–09:00 starts, 17:00–19:00 returns",
);
expect(screen.getByTestId("workplace-facts-factory")).toHaveTextContent(
  "3 × 2 · $16,000 · 6 jobs",
);
```

Use `getRotatedFootprintSize` so the displayed footprint follows the current building rotation if the facts are rendered for the armed item; do not create another rotation state.

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

- [ ] **Step 4: Add narrow workplace facts to `BuildPanel.svelte`**

Import `BUILDING_CATALOG` and `getRotatedFootprintSize`. Render extra metadata only when `item.action.kind === "building"` and that definition has `workPattern`:

```svelte
{#if item.action.kind === "building" && BUILDING_CATALOG[item.action.building].workPattern}
  {@const definition = BUILDING_CATALOG[item.action.building]}
  {@const footprint = getRotatedFootprintSize(item.action.building, buildingRotation)}
  <span data-testid={`workplace-facts-${item.action.building}`} class="workplace-facts">
    <span>{footprint.width} × {footprint.height} · ${definition.cost.toLocaleString("en-US")} · {definition.jobCapacity} jobs</span>
    <span>{definition.workPattern}</span>
  </span>
{/if}
```

Keep this inside the existing building item; do not add a modal/detail route.

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
bun run test:unit
bun run check
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/hud/panels/BuildPanel.svelte src/components/hud/panels/InspectPanel.svelte tests/ui/buildPanel.test.ts tests/ui/inspectPanel.test.ts
git commit -m "feat(ui): explain workplace staffing and shifts"
```

---

### Task 6: Emphasize selected workplace demand in WebGPU

**Files:**
- Modify: `src/render/webgpu/overlayBatch.ts`
- Modify: `tests/render/webgpuOverlayBatch.test.ts`

**Interfaces:**
- Consumes: exported `parseSelectedPoint`, existing `UiState.selectedId`, `selectedNodeKind`, `GameState.buildings`, `demandFlow`, `DEMAND`, `demandAlpha`, `strokeTile`, `fillTile`.
- Produces: geometry only; no new renderer state.

- [ ] **Step 1: Add failing geometry tests**

Create a state with one Office Tower selected by a tile in its footprint.

Pin three cases:

1. selected + zero demand still adds outline geometry;
2. selected + demand adds more geometry than the quiet case when global Demand overlay is off;
3. selected + demand with `activeOverlay = "demand"` does not add a second selected demand fill (only the outline is extra).

Use vertex-buffer lengths or the existing primitive spy/assertion style already used in this test file; do not add pixel screenshots for this unit.

- [ ] **Step 2: Run the render test and verify failure**

```bash
bunx vitest run tests/render/webgpuOverlayBatch.test.ts
```

Expected: FAIL because selected buildings currently have no overlay pass.

- [ ] **Step 3: Add a private selected-workplace resolver**

Use the existing selection rather than new UI state:

```ts
function selectedWorkplace(state: GameState, ui: UiState) {
  if (ui.selectedNodeKind !== null) return null;
  const point = parseSelectedPoint(ui.selectedId);
  if (point === null) return null;
  return (
    state.buildings.find(
      (building) =>
        (building.type === "officeTower" || building.type === "factory") &&
        building.occupiedTiles.some(
          (tile) => tile.x === point.x && tile.y === point.y,
        ),
    ) ?? null
  );
}
```

- [ ] **Step 4: Draw outline + selected demand with existing primitives**

Add a `drawSelectedWorkplaceDemand` pass after global data overlays and before previews:

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
git commit -m "feat(render): highlight selected workplace demand"
```

---

### Task 7: Add one real-WASM paused-state proof and run the repository gate

**Files:**
- Modify: \`tests/e2e/newCity.spec.ts\`
- Reuse: \`tests/e2e/helpers.ts\` (\`clickMapTile\`, \`selectTool\`, \`runtimeSnapshot\`)
- Update: HPA-463 PR body/checklist as implementation lands

**Interfaces:**
- Consumes: ordinary New City UI, real WASM runtime, existing Select tool/inspector.
- Produces: one browser acceptance path for authored workplace identity/copy at paused t=0; Rust tests own normal-move-in staffing and timing.

- [ ] **Step 1: Extend the existing Small Town Chromium flow without waiting for move-in**

Keep the existing \`creates Small Town through the real WASM New City flow\` test paused at \`t=0\`.

After its current template assertions:

1. locate the gameplay canvas;
2. arm the existing Select tool;
3. click the authored Office Tower at \`{ x: 18, y: 6 }\`;
4. assert Office Tower, \`Jobs 0 / 4\`, \`Unstaffed\`, and \`Standard · 07:00–09:00 starts, 17:00–19:00 returns\`;
5. click the authored Factory at \`{ x: 15, y: 11 }\`;
6. assert Factory, \`Jobs 0 / 6\`, \`Unstaffed\`, and the Early / late pattern copy.

Use the same ordinary map-selection pattern already exercised by \`tests/e2e/smoke.spec.ts\`:

\`\`\`ts
const canvas = page.locator("canvas[data-runtime-canvas='true']");
await selectTool(page, "select");

await clickMapTile(canvas, { x: 18, y: 6 });
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
\`\`\`

Do **not** unpause and wait for all residents to move in. Playwright's repository timeout is 30 seconds, while normal simulation pacing is intentionally wall-clock driven; deterministic Rust population tests already prove staffing and commute windows.

- [ ] **Step 2: Rebuild WASM and run the browser proof**

\`\`\`bash
bun run wasm:build
bunx playwright test tests/e2e/newCity.spec.ts --project=chromium
\`\`\`

Expected: PASS.

- [ ] **Step 3: Run focused feature suites together**

\`\`\`bash
cargo test -p caelum-core --test population
cargo test -p caelum-core --test sandbox_factory
bunx vitest run --project runtime tests/runtime/buildingCatalog.test.ts tests/runtime/runtimeSelectors.test.ts
bunx vitest run --project ui tests/ui/buildPanel.test.ts tests/ui/inspectPanel.test.ts
bunx vitest run tests/render/webgpuOverlayBatch.test.ts
\`\`\`

Expected: PASS.

- [ ] **Step 4: Run the full repository gate**

\`\`\`bash
cargo test --workspace
bun run test
bun run check
bun run lint
bun run format:check
bun run build
bun run test:e2e
\`\`\`

Expected: all commands PASS.

- [ ] **Step 5: Review the diff against the design before marking the PR ready**

Confirm there is no:

- new snapshot field/version;
- workplace schedule registry/class hierarchy;
- second active trip introduced by workplace reassignment;
- per-citizen frontend payload;
- new renderer/camera path (the existing WebGPU overlay task is allowed and required);
- new art asset;
- HPA-464 stop/line navigation work;
- second PR/task for QA/closeout.

- [ ] **Step 6: Commit the browser proof / final integration adjustments**

\`\`\`bash
git add tests/e2e/newCity.spec.ts
git commit -m "test(e2e): prove workplace commute presentation"
\`\`\`

Do not create a second PR. Push these commits to the existing HPA-463 draft PR and mark that PR ready only after the full gate passes.

---

## Self-review

- **Spec coverage:** Office/Factory timing, assignment + idle-wake replacement + active-trip reassignment, persistence, build explanation, staffing/current demand inspector, required WebGPU emphasis, Small Town example, Rust/browser verification, and non-goals all map to tasks above.
- **Scope:** one simulation rule, one aggregate read model extension, one renderer pass, one existing template edit. No independent subsystem warrants another PR.
- **Type consistency:** `workPattern` is optional in the building catalog and becomes `string | null` in shell inspector state; `currentDestinationDemand` is `number | null`; no backend wire type changes.
- **Persistence:** existing `CitizenRoutine::Worker.shift_template` remains durable; no schema change or migration.
- **No placeholders:** all behavioral branches, target files, commands, public/private seams, and copy strings are specified.
