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
- `crates/caelum-core/src/population/schedule.rs` — apply the rule on initial assignment and vacancy refill; keep active-trip/scheduler behavior unchanged.
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
- UI component tests under `tests/ui/` — Build/Inspect rendered copy; extend the closest existing panel/shell test rather than create a new harness.
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
- Modify: `crates/caelum-core/src/population/schedule.rs`
- Modify: `crates/caelum-core/tests/population.rs`

**Interfaces:**
- Consumes: `shift_template_for_workplace` from Task 1; existing `PopulationBuilding.building_type`; existing stable vacancy order.
- Produces: every assigned Worker carries a `shift_template` consistent with its current workplace; unassigned Workers keep their current identity-derived template.

- [ ] **Step 1: Add a failing initial-assignment integration test**

Build two Small Houses plus Office Tower and Factory through normal intents, unpause, and tick through all eight move-ins. Assert every assigned office worker is `standard`, every assigned factory worker is `early | late`, and both workplaces receive at least one worker:

```rust
fn shift_of(sim: &Sim) -> Option<&str> {
    match &sim.routine {
        CitizenRoutine::Worker { shift_template, .. } => Some(shift_template.as_str()),
        CitizenRoutine::Student => None,
    }
}

#[test]
fn office_and_factory_assign_workplace_derived_worker_shifts() {
    let mut engine = office_factory_town_engine();
    engine.tick(600.0);
    let snapshot = engine.snapshot();

    let office = building_tiles(&snapshot, "officeTower");
    let factory = building_tiles(&snapshot, "factory");
    let office_workers = workers_at(&snapshot, &office);
    let factory_workers = workers_at(&snapshot, &factory);

    assert!(!office_workers.is_empty());
    assert!(!factory_workers.is_empty());
    assert!(office_workers.iter().all(|sim| shift_of(sim) == Some("standard")));
    assert!(factory_workers.iter().all(|sim| matches!(shift_of(sim), Some("early" | "late"))));
}
```

Use small local fixture helpers in `population.rs`; do not create a new scenario framework.

- [ ] **Step 2: Run the test and verify the current ID-only behavior fails it**

```bash
cargo test -p caelum-core --test population office_and_factory_assign_workplace_derived_worker_shifts
```

Expected: FAIL because Office/Factory assignments currently preserve `shift_template_for_id`.

- [ ] **Step 3: Wire initial move-in to the shared rule**

In `schedule.rs`:

1. import `shift_template_for_workplace`;
2. widen the private `find_available_workplace` result so the caller gets `building_type` with `building_id` and `point`;
3. in `apply_move_in`, classify Worker/Student exactly as today with `shift_template_for_id`;
4. if the Worker receives a workplace, replace the baseline template with `shift_template_for_workplace(&sim_id, building_type).expect(...)`;
5. if no workplace exists, retain the baseline template.

The private lookup can remain a tuple:

```rust
fn find_available_workplace(
    index: &PopulationIndex,
) -> Option<(String, &'static str, Point)> {
    // existing stable building-id scan
}
```

Do not change job capacity or ordering.

- [ ] **Step 4: Add a failing reassignment test**

Extend the existing building reconciliation coverage with a representative worker whose current workplace is demolished while a replacement Office Tower or Factory has a vacancy. Pin both facts:

```rust
assert_eq!(active_trip_identity(&before), active_trip_identity(&after));
assert_eq!(shift_of(reassigned_worker), Some("standard")); // Office replacement
```

Use the existing active-trip fixture/reconciliation path. The assertion should prove no second active journey is created; do not assert internal scheduler buckets.

- [ ] **Step 5: Run the reassignment test and verify it fails**

```bash
cargo test -p caelum-core --test population workplace_reassignment_updates_shift_without_restarting_active_trip
```

Expected: FAIL because refill currently updates only `workplace`.

- [ ] **Step 6: Update the global refill mutation**

In the existing refill loop, update both worker fields atomically:

```rust
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
```

Do not touch active trips in this block. Existing retarget/drop logic remains responsible for those.

- [ ] **Step 7: Add save/restore coverage**

After staffing the deterministic town, snapshot and restore through the public engine constructor:

```rust
let saved = engine.snapshot();
let restored = GameEngine::from_snapshot(saved.clone()).expect("restore staffed town");
let restored_snapshot = restored.snapshot();

assert_eq!(worker_assignments_and_shifts(&restored_snapshot), worker_assignments_and_shifts(&saved));
```

Advance the restored engine to a representative next scheduled work window and assert its work-trip purpose/destination still matches the stored workplace pattern. Do not bump the schema.

- [ ] **Step 8: Run population coverage**

```bash
cargo test -p caelum-core --test population
cargo test -p caelum-core population::
```

Expected: PASS, including existing Student/day-off/optional/capacity/recovery tests.

- [ ] **Step 9: Commit**

```bash
git add crates/caelum-core/src/population/schedule.rs crates/caelum-core/tests/population.rs
git commit -m "feat(population): apply workplace shifts on assignment"
```

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
- Modify: closest existing `tests/ui/*` panel/shell test that renders these components

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

- [ ] **Step 3: Run the focused UI test and verify failure**

```bash
bunx vitest run --project ui <the-existing-test-file-you-extended>
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
git add src/components/hud/panels/BuildPanel.svelte src/components/hud/panels/InspectPanel.svelte tests/ui
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

### Task 7: Add one real-WASM playable proof and run the repository gate

**Files:**
- Modify: `tests/e2e/newCity.spec.ts`
- Modify only if existing helpers require it: `tests/e2e/helpers/*`
- Update: HPA-463 PR body/checklist as implementation lands

**Interfaces:**
- Consumes: ordinary New City UI, real WASM runtime, existing Select tool/inspector.
- Produces: one browser acceptance path; no test-only simulation API.

- [ ] **Step 1: Extend the existing Small Town Chromium flow**

Use the current New City helpers to create Small Town, unpause/run long enough for normal move-in, then select the authored Office Tower and Factory through map clicks/ordinary UI.

Assert the visible shell shows:

```ts
await expect(page.getByTestId("building-panel")).toContainText("Office Tower");
await expect(page.getByTestId("building-panel")).toContainText("Standard ·");
await expect(page.getByTestId("building-panel")).toContainText(/Jobs [1-9]\d* \/ 4/);
```

and for Factory:

```ts
await expect(page.getByTestId("building-panel")).toContainText("Factory");
await expect(page.getByTestId("building-panel")).toContainText("Early / late ·");
await expect(page.getByTestId("building-panel")).toContainText(/Jobs [1-9]\d* \/ 6/);
```

Also assert `workplace-status` exists. Do not require current demand to be positive at an arbitrary sampled instant; Rust deterministic schedule tests own exact timing.

- [ ] **Step 2: Run the browser proof**

```bash
bunx playwright test tests/e2e/newCity.spec.ts --project=chromium
```

Expected: PASS.

- [ ] **Step 3: Run focused feature suites together**

```bash
cargo test -p caelum-core --test population
cargo test -p caelum-core --test sandbox_factory
bunx vitest run --project runtime tests/runtime/buildingCatalog.test.ts tests/runtime/runtimeSelectors.test.ts
bunx vitest run tests/render/webgpuOverlayBatch.test.ts
bun run test:unit
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
- direct active-trip restart from reassignment;
- per-citizen frontend payload;
- new renderer/camera path;
- new art asset;
- HPA-464 stop/line navigation work;
- second PR/task for QA/closeout.

- [ ] **Step 6: Commit the browser proof / final integration adjustments**

```bash
git add tests/e2e/newCity.spec.ts tests/e2e/helpers
git commit -m "test(e2e): prove workplace commute patterns"
```

Do not create a second PR. Push these commits to the existing HPA-463 draft PR and mark that PR ready only after the full gate passes.

---

## Self-review

- **Spec coverage:** Office/Factory timing, assignment + reassignment, no active-trip restart, persistence, build explanation, staffing/current demand inspector, WebGPU emphasis, Small Town example, Rust/browser verification, and non-goals all map to tasks above.
- **Scope:** one simulation rule, one aggregate read model extension, one renderer pass, one existing template edit. No independent subsystem warrants another PR.
- **Type consistency:** `workPattern` is optional in the building catalog and becomes `string | null` in shell inspector state; `currentDestinationDemand` is `number | null`; no backend wire type changes.
- **Persistence:** existing `CitizenRoutine::Worker.shift_template` remains durable; no schema change or migration.
- **No placeholders:** all behavioral branches, target files, commands, public/private seams, and copy strings are specified.
